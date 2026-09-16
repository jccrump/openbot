#!/usr/bin/env python3
import json
import os
import socket
import subprocess
import sys
import threading

VSOCK_PORT = 5000
MAX_OUTPUT = 8_000_000
DEFAULT_TIMEOUT = 120
DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def log(message):
    print(f"[openbot-agent] {message}", flush=True)


def ensure_mounts():
    for fstype, target in (("proc", "/proc"), ("sysfs", "/sys"), ("devtmpfs", "/dev")):
        if os.path.ismount(target):
            continue
        subprocess.run(["mount", "-t", fstype, fstype, target], check=False)


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
        subprocess.Popen(
            [
                "/usr/local/bin/node",
                "/usr/local/bin/openbot-browser.js",
                "serve",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        log("browser daemon started")
    except Exception as error:
        log(f"browser warm-up failed: {error}")


def main():
    ensure_mounts()
    os.environ.setdefault("PATH", DEFAULT_PATH)
    threading.Thread(target=warm_browser, daemon=True).start()

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
