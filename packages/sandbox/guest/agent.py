#!/usr/bin/env python3
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time

VSOCK_PORT = 5000
VNC_PORT = 5900
MAX_OUTPUT = 8_000_000
DEFAULT_TIMEOUT = 120
MAX_EXEC_THREADS = 8
EXEC_IDLE_TIMEOUT = 300
DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
DEFAULT_RESOLV_CONF = "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"


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


def execute(raw):
    try:
        request = json.loads(raw)
    except Exception as error:
        return {"exit": -1, "stdout": "", "stderr": f"bad request: {error}"}

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
            text=True,
            cwd=request.get("cwd", "/"),
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                process.kill()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            return {"exit": -1, "stdout": "", "stderr": f"timeout after {timeout}s"}
        return {
            "exit": process.returncode,
            "stdout": stdout[-MAX_OUTPUT:],
            "stderr": stderr[-MAX_OUTPUT:],
        }
    except Exception as error:
        return {"exit": -1, "stdout": "", "stderr": str(error)}


def handle(conn):
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
            response = execute(line)
            conn.sendall(json.dumps(response).encode() + b"\n")


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
