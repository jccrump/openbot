#!/usr/bin/env python3
import json
import socket
import sys
import time

VSOCK_PORT = 5000
CONNECT_TIMEOUT = 10
EXEC_TIMEOUT = 180


def connect(uds_path):
    deadline = time.time() + CONNECT_TIMEOUT
    while True:
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(CONNECT_TIMEOUT)
            sock.connect(uds_path)
            return sock
        except (FileNotFoundError, ConnectionRefusedError, OSError):
            if time.time() > deadline:
                raise
            time.sleep(0.1)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: vsock-exec.py <uds-path> <command>")

    uds_path, command = sys.argv[1], sys.argv[2]
    sock = connect(uds_path)
    sock.settimeout(EXEC_TIMEOUT)

    sock.sendall(f"CONNECT {VSOCK_PORT}\n".encode())
    response = b""
    while b"\n" not in response:
        chunk = sock.recv(64)
        if not chunk:
            raise SystemExit("vsock handshake failed: connection closed")
        response += chunk
    if not response.startswith(b"OK"):
        raise SystemExit(f"vsock handshake failed: {response!r}")

    sock.sendall(json.dumps({"cmd": command}).encode() + b"\n")

    buffer = b""
    while b"\n" not in buffer:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buffer += chunk

    if b"\n" not in buffer:
        raise SystemExit("no response from guest agent")

    result = json.loads(buffer.decode().split("\n", 1)[0])
    sys.stdout.write(result.get("stdout", ""))
    sys.stderr.write(result.get("stderr", ""))
    sys.exit(result.get("exit", -1))


if __name__ == "__main__":
    main()
