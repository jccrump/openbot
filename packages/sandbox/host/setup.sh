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
NODE_VERSION="${NODE_VERSION:-v22.23.2}"
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
if [ ! -f vmlinux ]; then
  KKEY=$(curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min?prefix=firecracker-ci/v1.13/${ARCH}/vmlinux-5.10&list-type=2" \
    | grep -oP "(?<=<Key>)(firecracker-ci/v1.13/${ARCH}/vmlinux-5\.10\.[0-9]+)(?=</Key>)" | sort -V | tail -1)
  echo "downloading $KKEY"
  curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/${KKEY}" -o vmlinux
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
install -m 0755 "$BROWSER_SRC" /mnt/openbot-rootfs/usr/local/bin/openbot-browser.js
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

BROWSER_DIR=/mnt/openbot-rootfs/opt/openbot-browser
mkdir -p "$BROWSER_DIR"
if [ ! -d "$BROWSER_DIR/node_modules/playwright-core" ]; then
  echo "== installing playwright-core into rootfs =="
  npm install --prefix "$BROWSER_DIR" playwright-core >/dev/null 2>&1
fi
if [ ! -d "$BROWSER_DIR/browsers" ]; then
  echo "== downloading chromium for linux-arm64 =="
  PLAYWRIGHT_BROWSERS_PATH="$BROWSER_DIR/browsers" node "$BROWSER_DIR/node_modules/playwright-core/cli.js" install chromium
fi

if [ ! -f "$BROWSER_DIR/.deps-installed-v2" ]; then
  echo "== installing chromium system deps into rootfs =="
  mkdir -p /mnt/openbot-rootfs/tmp \
    /mnt/openbot-rootfs/var/cache/apt/archives/partial \
    /mnt/openbot-rootfs/var/lib/apt/lists/partial \
    /mnt/openbot-rootfs/var/log/apt \
    /mnt/openbot-rootfs/etc/apt/apt.conf.d
  chmod 1777 /mnt/openbot-rootfs/tmp
  printf 'Dpkg::Options::="--force-confdef";\nDpkg::Options::="--force-confold";\n' > /mnt/openbot-rootfs/etc/apt/apt.conf.d/99openbot
  mount --bind /dev /mnt/openbot-rootfs/dev
  mount -t proc proc /mnt/openbot-rootfs/proc
  mount -t sysfs sys /mnt/openbot-rootfs/sys
  cp /etc/resolv.conf /mnt/openbot-rootfs/etc/resolv.conf
  chroot /mnt/openbot-rootfs /bin/bash -c "export DEBIAN_FRONTEND=noninteractive; cd /opt/openbot-browser && PLAYWRIGHT_BROWSERS_PATH=/opt/openbot-browser/browsers node node_modules/playwright-core/cli.js install-deps chromium"
  touch "$BROWSER_DIR/.deps-installed-v2"
  umount /mnt/openbot-rootfs/sys /mnt/openbot-rootfs/proc /mnt/openbot-rootfs/dev
fi

rm -rf "$BROWSER_DIR"/browsers/chromium_headless_shell-*

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

(/mnt/openbot-rootfs/usr/bin/x11vnc -version 2>&1 | head -1) || true

IMAGE_CONTENT_HASH="$({
  printf '%s\n' "$IMAGE_SCHEMA_VERSION"
  sha256sum "$AGENT_SRC" "$BROWSER_SRC" "$DESKTOP_SRC" "$WALLPAPER_SRC" "$TINT2_SRC"
} | sha256sum | awk '{print $1}')"
IMAGE_VERSION="v${IMAGE_SCHEMA_VERSION}-${IMAGE_CONTENT_HASH}"
printf '%s\n' "$IMAGE_VERSION" > /mnt/openbot-rootfs/etc/openbot-image-version
printf '%s\n' "$IMAGE_VERSION" > "$FC_DIR/rootfs.version"
echo "guest image version: $IMAGE_VERSION"
umount /mnt/openbot-rootfs

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
