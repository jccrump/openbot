#!/usr/bin/env python3
import base64
import fcntl
import json
import os
import pty
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time

VSOCK_PORT = 5000
PTY_PORT = 5001
VNC_PORT = 5900
MAX_OUTPUT = 8_000_000
DEFAULT_TIMEOUT = 120
MAX_EXEC_THREADS = 8
MAX_PTY_SESSIONS = 4
EXEC_IDLE_TIMEOUT = 300
PTY_DEFAULT_COLS = 80
PTY_DEFAULT_ROWS = 24
DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
DEFAULT_RESOLV_CONF = "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"
IGNORED_ENTRIES = {
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "out",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    "coverage",
}
IMAGE_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "ico": "image/x-icon",
    "svg": "image/svg+xml",
}
DEFAULT_READ_BYTES = 512 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def log(message):
    print(f"[openbot-agent] {message}", flush=True)


def ensure_mounts():
    os.makedirs("/dev/pts", exist_ok=True)
    os.makedirs("/dev/shm", exist_ok=True)
    for fstype, target in (
        ("proc", "/proc"),
        ("sysfs", "/sys"),
        ("devtmpfs", "/dev"),
        ("devpts", "/dev/pts"),
        ("tmpfs", "/dev/shm"),
    ):
        if os.path.ismount(target):
            continue
        subprocess.run(["mount", "-t", fstype, fstype, target], check=False)


def reap_children():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def reaper():
    while True:
        time.sleep(1)
        reap_children()


def ensure_network():
    subprocess.run(["ip", "link", "set", "lo", "up"], check=False)
    subprocess.run(
        ["ip", "addr", "add", "127.0.0.1/8", "dev", "lo"],
        check=False,
        capture_output=True,
    )
    try:
        with open("/etc/resolv.conf", "r", encoding="utf-8") as resolv:
            contents = resolv.read()
    except OSError:
        contents = ""
    if "nameserver 127.0.0.53" in contents or "nameserver" not in contents:
        try:
            if os.path.islink("/etc/resolv.conf"):
                os.unlink("/etc/resolv.conf")
            with open("/etc/resolv.conf", "w", encoding="utf-8") as resolv:
                resolv.write(DEFAULT_RESOLV_CONF)
            log("repaired guest DNS configuration")
        except OSError as error:
            log(f"failed to repair guest DNS configuration: {error}")


def list_files(request):
    root = request.get("root") or "/root"
    cap = request.get("cap")
    cap = int(cap) if isinstance(cap, (int, float)) and cap > 0 else 500
    entries = []
    skipped = 0
    try:
        with os.scandir(root) as items:
            for entry in items:
                if entry.name in IGNORED_ENTRIES:
                    skipped += 1
                    continue
                size = None
                mtime = None
                try:
                    info = entry.stat()
                    size = info.st_size
                    mtime = info.st_mtime * 1000
                except OSError:
                    pass
                try:
                    is_dir = entry.is_dir()
                except OSError:
                    is_dir = False
                entries.append(
                    {
                        "name": entry.name,
                        "dir": is_dir,
                        "size": size,
                        "mtime": mtime,
                    }
                )
    except OSError as error:
        return {"entries": [], "total": 0, "skipped": 0, "error": str(error)}
    entries.sort(key=lambda item: (not item["dir"], item["name"]))
    return {
        "entries": entries[:cap],
        "total": len(entries),
        "skipped": skipped,
        "error": None,
    }


def read_file(request):
    path = request.get("path") or ""
    if not path:
        return {
            "kind": "missing",
            "content": None,
            "mime": None,
            "size": 0,
            "truncated": False,
            "error": "path is required",
        }
    max_bytes = request.get("maxBytes")
    max_bytes = (
        int(max_bytes)
        if isinstance(max_bytes, (int, float)) and max_bytes > 0
        else DEFAULT_READ_BYTES
    )
    try:
        info = os.stat(path)
    except OSError as error:
        return {
            "kind": "missing",
            "content": None,
            "mime": None,
            "size": 0,
            "truncated": False,
            "error": str(error),
        }
    if os.path.isdir(path):
        return {
            "kind": "dir",
            "content": None,
            "mime": None,
            "size": 0,
            "truncated": False,
            "error": None,
        }
    name = os.path.basename(path)
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    mime = IMAGE_MIME.get(extension)
    if mime:
        limit = min(info.st_size, MAX_IMAGE_BYTES)
        try:
            with open(path, "rb") as handle:
                data = handle.read(limit)
        except OSError as error:
            return {
                "kind": "missing",
                "content": None,
                "mime": None,
                "size": info.st_size,
                "truncated": False,
                "error": str(error),
            }
        return {
            "kind": "image",
            "content": base64.b64encode(data).decode("ascii"),
            "mime": mime,
            "size": info.st_size,
            "truncated": info.st_size > limit,
            "error": None,
        }
    try:
        with open(path, "rb") as handle:
            data = handle.read(max_bytes + 1)
    except OSError as error:
        return {
            "kind": "missing",
            "content": None,
            "mime": None,
            "size": info.st_size,
            "truncated": False,
            "error": str(error),
        }
    truncated = len(data) > max_bytes
    data = data[:max_bytes]
    binary = b"\x00" in data[:8192]
    return {
        "kind": "binary" if binary else "text",
        "content": None if binary else data.decode("utf-8", "replace"),
        "mime": None,
        "size": info.st_size,
        "truncated": truncated,
        "error": None,
    }


def execute(raw, send):
    try:
        request = json.loads(raw)
    except Exception as error:
        return {"exit": -1, "stdout": "", "stderr": f"bad request: {error}"}

    op = request.get("op")
    if op == "list":
        return list_files(request)
    if op == "read":
        return read_file(request)

    command = request.get("cmd")
    if not command:
        return {"exit": -1, "stdout": "", "stderr": "missing cmd"}

    timeout = request.get("timeout", DEFAULT_TIMEOUT)
    try:
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=request.get("cwd", "/"),
            start_new_session=True,
        )
    except Exception as error:
        return {"exit": -1, "stdout": "", "stderr": str(error)}

    stdout_parts = []
    stderr_parts = []

    def pump(pipe, stream, sink):
        try:
            while True:
                data = os.read(pipe.fileno(), 65536)
                if not data:
                    break
                text = data.decode("utf-8", "replace")
                sink.append(text)
                send({"type": "chunk", "stream": stream, "data": text})
        except OSError:
            pass
        finally:
            try:
                pipe.close()
            except OSError:
                pass

    readers = [
        threading.Thread(
            target=pump, args=(process.stdout, "stdout", stdout_parts), daemon=True
        ),
        threading.Thread(
            target=pump, args=(process.stderr, "stderr", stderr_parts), daemon=True
        ),
    ]
    for reader in readers:
        reader.start()

    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    for reader in readers:
        reader.join(timeout=2)

    stdout = "".join(stdout_parts)
    stderr = "".join(stderr_parts)
    if timed_out:
        note = f"\ntimeout after {timeout}s"
        return {
            "exit": -1,
            "stdout": stdout[-MAX_OUTPUT:],
            "stderr": (stderr + note).strip()[-MAX_OUTPUT:],
        }
    return {
        "exit": process.returncode,
        "stdout": stdout[-MAX_OUTPUT:],
        "stderr": stderr[-MAX_OUTPUT:],
    }


def handle(conn):
    send_lock = threading.Lock()

    def send(payload):
        line = json.dumps(payload).encode() + b"\n"
        with send_lock:
            conn.sendall(line)

    buffer = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            return
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if not line.strip():
                continue
            response = execute(line, send)
            send(response)


def handle_connection(conn, slots):
    try:
        conn.settimeout(EXEC_IDLE_TIMEOUT)
        handle(conn)
    except Exception as error:
        log(f"connection error: {error}")
    finally:
        try:
            conn.close()
        except OSError:
            pass
        slots.release()


def set_winsize(fd, cols, rows):
    try:
        fcntl.ioctl(
            fd,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0),
        )
    except OSError:
        pass


def pty_child_setup():
    # Make the pty the session's controlling terminal so job control,
    # Ctrl+C, and full-screen programs behave like a real terminal.
    os.setsid()
    try:
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    except OSError:
        pass


def handle_pty(conn):
    try:
        master, slave = pty.openpty()
    except OSError as error:
        log(f"pty open failed: {error}")
        conn.close()
        return

    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["HOME"] = "/root"
    env["USER"] = "root"
    env["LOGNAME"] = "root"
    env["PATH"] = DEFAULT_PATH
    env["LANG"] = env.get("LANG", "C.UTF-8")

    try:
        process = subprocess.Popen(
            ["/bin/bash", "-l"],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd="/root",
            env=env,
            preexec_fn=pty_child_setup,
            close_fds=True,
        )
    except Exception as error:
        log(f"pty spawn failed: {error}")
        os.close(master)
        os.close(slave)
        conn.close()
        return
    os.close(slave)
    set_winsize(master, PTY_DEFAULT_COLS, PTY_DEFAULT_ROWS)

    send_lock = threading.Lock()
    closed = threading.Event()

    def send(payload):
        line = json.dumps(payload).encode() + b"\n"
        with send_lock:
            conn.sendall(line)

    def reader():
        while not closed.is_set():
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            try:
                send(
                    {
                        "type": "data",
                        "data": base64.b64encode(data).decode("ascii"),
                    }
                )
            except OSError:
                break
        closed.set()
        try:
            send({"type": "exit", "code": 0})
        except OSError:
            pass

    threading.Thread(target=reader, daemon=True).start()
    try:
        send({"type": "ready"})
    except OSError:
        closed.set()

    buffer = b""
    try:
        while not closed.is_set():
            chunk = conn.recv(65536)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except Exception:
                    continue
                kind = message.get("type")
                if kind == "input":
                    try:
                        os.write(master, base64.b64decode(message.get("data") or ""))
                    except (OSError, ValueError):
                        break
                elif kind in ("resize", "open"):
                    set_winsize(
                        master,
                        int(message.get("cols") or PTY_DEFAULT_COLS),
                        int(message.get("rows") or PTY_DEFAULT_ROWS),
                    )
    except Exception as error:
        log(f"pty session error: {error}")
    finally:
        closed.set()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            try:
                process.kill()
            except OSError:
                pass
        try:
            process.wait(timeout=5)
        except Exception:
            pass
        try:
            os.close(master)
        except OSError:
            pass
        try:
            conn.close()
        except OSError:
            pass


def pty_server():
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, PTY_PORT))
    server.listen(16)
    log(f"pty bridge listening on vsock port {PTY_PORT}")
    slots = threading.BoundedSemaphore(MAX_PTY_SESSIONS)
    while True:
        try:
            conn, _ = server.accept()
        except Exception as error:
            log(f"pty accept failed: {error}")
            continue
        if not slots.acquire(blocking=False):
            log("pty session limit reached; rejecting connection")
            try:
                conn.close()
            except OSError:
                pass
            continue

        def run(connection=conn):
            try:
                handle_pty(connection)
            finally:
                slots.release()

        threading.Thread(target=run, daemon=True).start()


def start_desktop():
    while True:
        try:
            process = subprocess.Popen(
                ["/bin/bash", "/usr/local/bin/openbot-desktop.sh"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            log("desktop supervisor started")
            status = process.wait()
            log(f"desktop supervisor exited ({status}); restarting")
        except Exception as error:
            log(f"desktop start failed: {error}; retrying")
        time.sleep(2)


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def connect_vnc_upstream(timeout=30):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            upstream = socket.create_connection(("127.0.0.1", VNC_PORT), timeout=5)
            upstream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            greeting = upstream.recv(12)
            if greeting.startswith(b"RFB "):
                upstream.settimeout(None)
                return upstream, greeting
            upstream.close()
            last_error = RuntimeError(f"invalid RFB greeting: {greeting[:40]!r}")
        except OSError as error:
            last_error = error
        time.sleep(0.25)
    raise TimeoutError(f"desktop was not RFB-ready after {timeout}s: {last_error}")


def handle_vnc(conn):
    try:
        upstream, greeting = connect_vnc_upstream()
        conn.sendall(greeting)
    except Exception as error:
        log(f"vnc upstream failed: {error}")
        conn.close()
        return
    threading.Thread(target=pipe, args=(conn, upstream), daemon=True).start()
    pipe(upstream, conn)
    upstream.close()
    conn.close()


def vnc_server():
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, VNC_PORT))
    server.listen(8)
    log(f"vnc bridge listening on vsock port {VNC_PORT}")
    while True:
        try:
            conn, _ = server.accept()
        except Exception as error:
            log(f"vnc accept failed: {error}")
            continue
        threading.Thread(target=handle_vnc, args=(conn,), daemon=True).start()


def main():
    os.environ["PATH"] = DEFAULT_PATH
    os.environ["HOME"] = "/root"
    os.environ["USER"] = "root"
    os.environ["LOGNAME"] = "root"
    os.environ["XDG_CONFIG_HOME"] = "/root/.config"
    os.environ["XDG_CACHE_HOME"] = "/root/.cache"
    os.makedirs("/root/.config", exist_ok=True)
    os.makedirs("/root/.cache", exist_ok=True)
    ensure_mounts()
    ensure_network()
    threading.Thread(target=reaper, daemon=True).start()
    threading.Thread(target=start_desktop, daemon=True).start()
    threading.Thread(target=vnc_server, daemon=True).start()
    threading.Thread(target=pty_server, daemon=True).start()

    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, VSOCK_PORT))
    server.listen(64)
    log(f"listening on vsock port {VSOCK_PORT}")

    slots = threading.BoundedSemaphore(MAX_EXEC_THREADS)
    while True:
        try:
            conn, _ = server.accept()
        except Exception as error:
            log(f"accept failed: {error}")
            continue
        slots.acquire()
        threading.Thread(
            target=handle_connection,
            args=(conn, slots),
            daemon=True,
        ).start()


if __name__ == "__main__":
    sys.exit(main())
