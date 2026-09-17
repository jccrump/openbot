#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
AGENT_SRC="$REPO_DIR/packages/sandbox/guest/agent.py"
BROWSER_SRC="$REPO_DIR/packages/sandbox/guest/browser.js"
DESKTOP_SRC="$REPO_DIR/packages/sandbox/guest/desktop.sh"
WALLPAPER_SRC="$REPO_DIR/packages/sandbox/guest/wallpaper.py"
TINT2_SRC="$REPO_DIR/packages/sandbox/guest/tint2rc"
IMAGE_SCHEMA_VERSION="2"

FC_VERSION="${FC_VERSION:-v1.16.0}"
KERNEL_VERSION="${KERNEL_VERSION:-6.1.155}"
NODE_VERSION="${NODE_VERSION:-v22.23.2}"
# Keep the browser runtime on the version validated against the nested ARM64 VM.
# Playwright 1.63's Chrome-for-Testing 153 build can spin during headed startup
# without ever exposing its automation transport in this environment.
PLAYWRIGHT_CORE_VERSION="${PLAYWRIGHT_CORE_VERSION:-1.62.1}"
ARCH="${ARCH:-aarch64}"
FC_DIR="${FC_DIR:-/var/lib/fc}"
ROOTFS_SIZE="${ROOTFS_SIZE:-4G}"

echo "== verifying nested KVM =="
test -e /dev/kvm
test -r /dev/kvm
test -w /dev/kvm
echo "KVM OK"

echo "== installing packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl squashfs-tools e2fsprogs >/dev/null

# The per-agent desktop shown in the app runs in this outer VM: Xvfb + openbox
# with a tint2 panel, a terminal, a file manager, and a generated wallpaper.
# xdotool drives that desktop for the model (clicks, drags, scrolls, keys) and
# scrot captures it for screenshots.
echo "== installing desktop packages =="
apt-get install -y -qq \
  xvfb openbox x11vnc xterm tint2 feh thunar \
  x11-xserver-utils fonts-dejavu-core adwaita-icon-theme \
  xdotool scrot >/dev/null

# The agent browser disables the AutomationControlled blink feature so pages do
# not see navigator.webdriver; Chromium shows a security warning bar for that
# flag. This policy turns the warning off so the shared desktop stays clean.
mkdir -p /etc/chromium/policies/managed
printf '%s\n' '{"CommandLineFlagSecurityWarningsEnabled": false}' \
  > /etc/chromium/policies/managed/openbot.json

# Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor by
# default. Chromium needs them for its Linux sandbox when the per-agent browser
# runs as an unprivileged service account.
printf 'kernel.apparmor_restrict_unprivileged_userns=0\n' \
  > /etc/sysctl.d/99-openbot-browser-sandbox.conf
sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null

mkdir -p "$FC_DIR"
cd "$FC_DIR"

echo "== firecracker $FC_VERSION =="
if [ ! -x /usr/local/bin/firecracker ]; then
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz" -o fc.tgz
  tar -xzf fc.tgz
  install -m 0755 "release-${FC_VERSION}-${ARCH}/firecracker-${FC_VERSION}-${ARCH}" /usr/local/bin/firecracker
  rm -rf fc.tgz "release-${FC_VERSION}-${ARCH}"
fi
firecracker --version

echo "== kernel =="
if [ ! -f vmlinux ] || [ "$(cat vmlinux.version 2>/dev/null || true)" != "$KERNEL_VERSION" ]; then
  KKEY=$(curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min?prefix=firecracker-ci/v1.15/${ARCH}/vmlinux-${KERNEL_VERSION}&list-type=2" \
    | grep -oP "(?<=<Key>)(firecracker-ci/v1.15/${ARCH}/vmlinux-${KERNEL_VERSION})(?=</Key>)" | tail -1)
  test -n "$KKEY"
  echo "downloading $KKEY"
  curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/${KKEY}" -o vmlinux.next
  if [ -f vmlinux ]; then
    cp --reflink=auto --sparse=always vmlinux vmlinux.backup
  fi
  mv vmlinux.next vmlinux
  printf '%s\n' "$KERNEL_VERSION" > vmlinux.version
fi
ls -lh vmlinux

echo "== rootfs =="
if [ ! -f rootfs.ext4 ]; then
  RKEY=$(curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min?prefix=firecracker-ci/v1.13/${ARCH}/ubuntu-&list-type=2" \
    | grep -oP "(?<=<Key>)(firecracker-ci/v1.13/${ARCH}/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" | sort -V | tail -1)
  echo "downloading $RKEY"
  curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/${RKEY}" -o ubuntu.squashfs
  rm -rf squashfs-root
  unsquashfs -d squashfs-root ubuntu.squashfs >/dev/null
  truncate -s "$ROOTFS_SIZE" rootfs.ext4
  mkfs.ext4 -d squashfs-root -F rootfs.ext4 >/dev/null
  rm -rf squashfs-root ubuntu.squashfs
fi
ls -lh rootfs.ext4

echo "== node runtime =="
if [ ! -x /usr/local/bin/node ]; then
  if [ ! -f /tmp/node.tar.gz ]; then
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.gz" -o /tmp/node.tar.gz
  fi
  tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1
fi
node --version

echo "== guest rootfs provisioning =="
mkdir -p /mnt/openbot-rootfs
if mountpoint -q /mnt/openbot-rootfs; then
  umount /mnt/openbot-rootfs
fi
mount -o loop rootfs.ext4 /mnt/openbot-rootfs
install -m 0755 "$AGENT_SRC" /mnt/openbot-rootfs/usr/local/bin/openbot-agent.py
install -m 0755 "$DESKTOP_SRC" /mnt/openbot-rootfs/usr/local/bin/openbot-desktop.sh
install -m 0755 "$WALLPAPER_SRC" /mnt/openbot-rootfs/usr/local/bin/openbot-wallpaper.py
install -d /mnt/openbot-rootfs/root/.config/tint2
install -m 0644 "$TINT2_SRC" /mnt/openbot-rootfs/root/.config/tint2/tint2rc
rm -f /mnt/openbot-rootfs/etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /mnt/openbot-rootfs/etc/resolv.conf

if [ ! -x /mnt/openbot-rootfs/usr/local/bin/node ]; then
  if [ ! -f /tmp/node.tar.gz ]; then
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.gz" -o /tmp/node.tar.gz
  fi
  tar -xzf /tmp/node.tar.gz -C /mnt/openbot-rootfs/usr/local --strip-components=1
fi
/mnt/openbot-rootfs/usr/local/bin/node --version
rm -rf /mnt/openbot-rootfs/opt/openbot-browser
rm -f /mnt/openbot-rootfs/usr/local/bin/openbot-browser.js

if [ ! -x /mnt/openbot-rootfs/usr/bin/python3 ]; then
  echo "== installing python3 into rootfs via chroot =="
  mkdir -p /mnt/openbot-rootfs/tmp \
    /mnt/openbot-rootfs/var/cache/apt/archives/partial \
    /mnt/openbot-rootfs/var/lib/apt/lists/partial \
    /mnt/openbot-rootfs/var/log/apt
  chmod 1777 /mnt/openbot-rootfs/tmp
  mount --bind /dev /mnt/openbot-rootfs/dev
  mount -t proc proc /mnt/openbot-rootfs/proc
  mount -t sysfs sys /mnt/openbot-rootfs/sys
  cp /etc/resolv.conf /mnt/openbot-rootfs/etc/resolv.conf
  chroot /mnt/openbot-rootfs /bin/bash -c "apt-get update -qq && apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install -y -qq python3-minimal >/dev/null"
  umount /mnt/openbot-rootfs/sys /mnt/openbot-rootfs/proc /mnt/openbot-rootfs/dev
fi

/mnt/openbot-rootfs/usr/bin/python3 --version

if [ ! -x /mnt/openbot-rootfs/usr/bin/scrot ]; then
  echo "== installing desktop packages into rootfs =="
  mkdir -p /mnt/openbot-rootfs/tmp \
    /mnt/openbot-rootfs/var/cache/apt/archives/partial \
    /mnt/openbot-rootfs/var/lib/apt/lists/partial \
    /mnt/openbot-rootfs/var/log/apt
  chmod 1777 /mnt/openbot-rootfs/tmp
  mount --bind /dev /mnt/openbot-rootfs/dev
  mount -t proc proc /mnt/openbot-rootfs/proc
  mount -t sysfs sys /mnt/openbot-rootfs/sys
  cp /etc/resolv.conf /mnt/openbot-rootfs/etc/resolv.conf
  chroot /mnt/openbot-rootfs /bin/bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install -y -qq xvfb openbox tint2 xterm x11vnc feh scrot x11-xserver-utils fonts-dejavu-core xfonts-base >/dev/null"
  umount /mnt/openbot-rootfs/sys /mnt/openbot-rootfs/proc /mnt/openbot-rootfs/dev
fi

# chroot package installation temporarily borrows the Lima host resolver. The
# microVM has no systemd-resolved service, so always restore a standalone DNS
# configuration before sealing the image.
rm -f /mnt/openbot-rootfs/etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /mnt/openbot-rootfs/etc/resolv.conf

(/mnt/openbot-rootfs/usr/bin/x11vnc -version 2>&1 | head -1) || true

IMAGE_CONTENT_HASH="$({
  printf '%s\n' "$IMAGE_SCHEMA_VERSION" "$NODE_VERSION" "$PLAYWRIGHT_CORE_VERSION"
  sha256sum "$AGENT_SRC" "$DESKTOP_SRC" "$WALLPAPER_SRC" "$TINT2_SRC"
} | sha256sum | awk '{print $1}')"
IMAGE_VERSION="v${IMAGE_SCHEMA_VERSION}-${IMAGE_CONTENT_HASH}"
printf '%s\n' "$IMAGE_VERSION" > /mnt/openbot-rootfs/etc/openbot-image-version
printf '%s\n' "$IMAGE_VERSION" > "$FC_DIR/rootfs.version"
echo "guest image version: $IMAGE_VERSION"
umount /mnt/openbot-rootfs

echo "== outer browser runtime =="
# playwright-core is only the Chromium *binary* downloader now; the daemon
# drives the browser over CDP through the vendored browser-harness session.
HOST_BROWSER_DIR="$FC_DIR/openbot-browser-host"
mkdir -p "$HOST_BROWSER_DIR" "$FC_DIR/openbot"
if ! grep -qs "\"version\": \"$PLAYWRIGHT_CORE_VERSION\"" \
  "$HOST_BROWSER_DIR/node_modules/playwright-core/package.json"; then
  rm -rf "$HOST_BROWSER_DIR/node_modules" "$HOST_BROWSER_DIR/browsers" \
    "$HOST_BROWSER_DIR"/.deps-installed-*
  npm install --prefix "$HOST_BROWSER_DIR" "playwright-core@$PLAYWRIGHT_CORE_VERSION" >/dev/null 2>&1
fi
if ! compgen -G "$HOST_BROWSER_DIR/browsers/chromium-*" >/dev/null; then
  PLAYWRIGHT_BROWSERS_PATH="$HOST_BROWSER_DIR/browsers" \
    node "$HOST_BROWSER_DIR/node_modules/playwright-core/cli.js" install chromium
fi
HOST_DEPS_MARKER="$HOST_BROWSER_DIR/.deps-installed-$PLAYWRIGHT_CORE_VERSION-chromium"
if [ ! -f "$HOST_DEPS_MARKER" ]; then
  PLAYWRIGHT_BROWSERS_PATH="$HOST_BROWSER_DIR/browsers" \
    node "$HOST_BROWSER_DIR/node_modules/playwright-core/cli.js" install-deps chromium
  touch "$HOST_DEPS_MARKER"
fi
install -m 0755 "$BROWSER_SRC" "$FC_DIR/openbot/browser.js"
HARNESS_BUNDLE="$REPO_DIR/packages/sandbox/host/dist/browser-harness.mjs"
if [ ! -f "$HARNESS_BUNDLE" ]; then
  echo "missing $HARNESS_BUNDLE — run: pnpm --filter @openbot/sandbox build:browser" >&2
  exit 1
fi
install -m 0644 "$HARNESS_BUNDLE" "$FC_DIR/openbot/browser-harness.mjs"

echo "== sandbox host service =="
mkdir -p /var/lib/fc/openbot /var/lib/fc/vms
cat > /etc/systemd/system/openbot-host.service <<'UNIT'
[Unit]
Description=OpenBot sandbox host
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/node /var/lib/fc/openbot/service.mjs
Restart=always
RestartSec=2
Environment=OPENBOT_HOST_PORT=4171
Environment=OPENBOT_SANDBOX_NETWORK=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable openbot-host >/dev/null

echo "setup complete"
