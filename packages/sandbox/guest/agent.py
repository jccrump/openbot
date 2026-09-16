#!/usr/bin/env python3
import json
import os
import socket
import subprocess
import sys
import threading
import time

VSOCK_PORT = 5000
VNC_PORT = 5900
MAX_OUTPUT = 8_000_000
DEFAULT_TIMEOUT = 120
DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


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


def execute(raw):
    try:
        request = json.loads(raw)
    except Exception as error:
        return {"exit": -1, "stdout": "", "stderr": f"bad request: {error}"}

    command = request.get("cmd")
    if not command:
        return {"exit": -1, "stdout": "", "stderr": "missing cmd"}

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=request.get("cwd", "/"),
            timeout=request.get("timeout", DEFAULT_TIMEOUT),
        )
        return {
            "exit": result.returncode,
            "stdout": result.stdout[-MAX_OUTPUT:],
            "stderr": result.stderr[-MAX_OUTPUT:],
        }
    except subprocess.TimeoutExpired:
        return {"exit": -1, "stdout": "", "stderr": f"timeout after {request.get('timeout', DEFAULT_TIMEOUT)}s"}
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


def warm_browser():
    try:
        log_file = open("/tmp/openbot-browser.log", "ab")
        subprocess.Popen(
            [
                "/usr/local/bin/node",
                "/usr/local/bin/openbot-browser.js",
                "serve",
            ],
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,
        )
        log("browser daemon started")
    except Exception as error:
        log(f"browser warm-up failed: {error}")


def start_desktop():
    try:
        subprocess.Popen(
            ["/bin/bash", "/usr/local/bin/openbot-desktop.sh"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        log("desktop starting")
    except Exception as error:
        log(f"desktop start failed: {error}")


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


def handle_vnc(conn):
    try:
        upstream = socket.create_connection(("127.0.0.1", VNC_PORT), timeout=10)
    except OSError as error:
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
    os.environ.setdefault("PATH", DEFAULT_PATH)
    ensure_mounts()
    ensure_network()
    threading.Thread(target=reaper, daemon=True).start()
    threading.Thread(target=start_desktop, daemon=True).start()
    threading.Thread(target=warm_browser, daemon=True).start()
    threading.Thread(target=vnc_server, daemon=True).start()

    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, VSOCK_PORT))
    server.listen(4)
    log(f"listening on vsock port {VSOCK_PORT}")

    while True:
        try:
            conn, _ = server.accept()
        except Exception as error:
            log(f"accept failed: {error}")
            continue
        try:
            handle(conn)
        except Exception as error:
            log(f"connection error: {error}")
        finally:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
