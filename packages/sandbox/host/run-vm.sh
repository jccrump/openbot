#!/usr/bin/env bash
set -euo pipefail

FC_DIR="${FC_DIR:-/var/lib/fc}"
VM_DIR="${1:-/var/lib/fc/vm0}"
CID="${CID:-3}"

mkdir -p "$VM_DIR"
if [ ! -f "$VM_DIR/rootfs.ext4" ]; then
  cp --reflink=auto "$FC_DIR/rootfs.ext4" "$VM_DIR/rootfs.ext4"
fi
rm -f "$VM_DIR/vsock.sock"

cat > "$VM_DIR/vmconfig.json" <<EOF
{
  "boot-source": {
    "kernel_image_path": "$FC_DIR/vmlinux",
    "boot_args": "console=ttyS0 reboot=k panic=1 init=/usr/local/bin/openbot-agent.py"
  },
  "drives": [
    {
      "drive_id": "rootfs",
      "path_on_host": "$VM_DIR/rootfs.ext4",
      "is_root_device": true,
      "is_read_only": false
    }
  ],
  "machine-config": {
    "vcpu_count": 2,
    "mem_size_mib": 512
  },
  "vsock": {
    "guest_cid": $CID,
    "uds_path": "$VM_DIR/vsock.sock"
  }
}
EOF

nohup firecracker --no-api --config-file "$VM_DIR/vmconfig.json" > "$VM_DIR/serial.log" 2>&1 &
echo $! > "$VM_DIR/firecracker.pid"

for _ in $(seq 1 200); do
  if [ -S "$VM_DIR/vsock.sock" ]; then
    break
  fi
  sleep 0.05
done

echo "firecracker pid $(cat "$VM_DIR/firecracker.pid"), vsock $VM_DIR/vsock.sock"
