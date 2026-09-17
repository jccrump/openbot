#!/usr/bin/env bash
set -uo pipefail

export DISPLAY=:99
LOG=/tmp/openbot-desktop.log
exec >>"$LOG" 2>&1

echo "starting desktop $(date -Is)"

PIDS=()
cleanup() {
  if [ "${#PIDS[@]}" -gt 0 ]; then
    kill "${PIDS[@]}" >/dev/null 2>&1 || true
    wait "${PIDS[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# The guest rootfs is writable and Firecracker is normally stopped from the
# host, so X lock/socket files can survive a cold boot even though no process
# does. A supervisor restart can also inherit a child that did not exit in time.
pkill -f "^Xvfb :99" >/dev/null 2>&1 || true
pkill -x openbox >/dev/null 2>&1 || true
pkill -x tint2 >/dev/null 2>&1 || true
pkill -x x11vnc >/dev/null 2>&1 || true
pkill -x xterm >/dev/null 2>&1 || true
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac -noreset &
PIDS+=("$!")

for _ in $(seq 1 100); do
  if [ -S /tmp/.X11-unix/X99 ] && DISPLAY=:99 xset q >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if [ ! -S /tmp/.X11-unix/X99 ] || ! DISPLAY=:99 xset q >/dev/null 2>&1; then
  echo "Xvfb did not become responsive"
  exit 1
fi

openbox &
PIDS+=("$!")

tint2 -c /root/.config/tint2/tint2rc &
PIDS+=("$!")

if python3 /usr/local/bin/openbot-wallpaper.py /tmp/openbot-wallpaper.ppm; then
  feh --bg-fill /tmp/openbot-wallpaper.ppm &
else
  xsetroot -solid "#1a1c22" &
fi

xterm -title "Terminal" -geometry 100x24+24+64 -fa "DejaVu Sans Mono" -fs 10 &

x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 \
  -nothreads -nocursorshape -wait 16 -defer 10 -speeds lan \
  -o /tmp/openbot-x11vnc.log &
PIDS+=("$!")

RFB_READY=0
for _ in $(seq 1 100); do
  if python3 - <<'PY'
import socket

try:
    with socket.create_connection(("127.0.0.1", 5900), timeout=0.25) as connection:
        raise SystemExit(0 if connection.recv(12).startswith(b"RFB ") else 1)
except OSError:
    raise SystemExit(1)
PY
  then
    RFB_READY=1
    break
  fi
  sleep 0.1
done

if [ "$RFB_READY" -ne 1 ] || ! kill -0 "${PIDS[-1]}" >/dev/null 2>&1; then
  echo "x11vnc did not become ready"
  exit 1
fi

echo "desktop ready $(date -Is)"
wait -n "${PIDS[@]}"
echo "desktop process exited; supervisor will restart the stack"
exit 1
