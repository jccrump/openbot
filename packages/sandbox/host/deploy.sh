#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INSTANCE="${OPENBOT_LIMA_INSTANCE:-openbot-fc}"

echo "== bundling host service =="
pnpm --dir "$REPO_DIR" --filter @openbot/sandbox build:host

echo "== installing into $INSTANCE =="
limactl shell "$INSTANCE" -- sudo install -m 0644 "$REPO_DIR/packages/sandbox/host/dist/service.mjs" /var/lib/fc/openbot/service.mjs
limactl shell "$INSTANCE" -- sudo systemctl restart openbot-host
sleep 1
echo "service state: $(limactl shell "$INSTANCE" -- systemctl is-active openbot-host)"

echo "== health check from the Mac =="
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4171/health >/dev/null 2>&1; then
    curl -s http://127.0.0.1:4171/health
    echo
    exit 0
  fi
  sleep 0.5
done

echo "sandbox host not reachable on 127.0.0.1:4171; last logs:"
limactl shell "$INSTANCE" -- sudo journalctl -u openbot-host -n 20 --no-pager
exit 1
