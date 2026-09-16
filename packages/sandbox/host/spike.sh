#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_DIR="${VM_DIR:-/var/lib/fc/vm0}"

echo "== booting microVM =="
start=$(date +%s%N)
bash "$SCRIPT_DIR/run-vm.sh" "$VM_DIR"

echo "== waiting for guest agent =="
ready=0
for _ in $(seq 1 200); do
  if python3 "$SCRIPT_DIR/vsock-exec.py" "$VM_DIR/vsock.sock" "true" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
end=$(date +%s%N)
boot_ms=$(( (end - start) / 1000000 ))

if [ "$ready" != "1" ]; then
  echo "guest agent did not come up; serial log:"
  tail -30 "$VM_DIR/serial.log"
  exit 1
fi
echo "guest agent ready in ${boot_ms} ms (firecracker launch to first exec)"

echo "== guest exec checks =="
echo "--- uname"
python3 "$SCRIPT_DIR/vsock-exec.py" "$VM_DIR/vsock.sock" "uname -a"
echo "--- os release"
python3 "$SCRIPT_DIR/vsock-exec.py" "$VM_DIR/vsock.sock" "head -2 /etc/os-release"
echo "--- resources"
python3 "$SCRIPT_DIR/vsock-exec.py" "$VM_DIR/vsock.sock" "nproc && free -m | head -2 && ls /"
echo "--- state persists inside the VM"
python3 "$SCRIPT_DIR/vsock-exec.py" "$VM_DIR/vsock.sock" "echo hello > /root/probe.txt && cat /root/probe.txt"

echo "== shutting down =="
kill "$(cat "$VM_DIR/firecracker.pid")" 2>/dev/null || true
sleep 1
echo "done"
