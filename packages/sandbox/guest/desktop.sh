#!/usr/bin/env bash
set -u

export DISPLAY=:99
LOG=/tmp/openbot-desktop.log
exec >>"$LOG" 2>&1

echo "starting desktop $(date -Is)"

mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac -noreset &
fi

for _ in $(seq 1 100); do
  if [ -S /tmp/.X11-unix/X99 ]; then
    break
  fi
  sleep 0.1
done

if ! pgrep -x openbox >/dev/null 2>&1; then
  openbox &
fi

if ! pgrep -x tint2 >/dev/null 2>&1; then
  tint2 -c /root/.config/tint2/tint2rc &
fi

if ! pgrep -x feh >/dev/null 2>&1; then
  if python3 /usr/local/bin/openbot-wallpaper.py /tmp/openbot-wallpaper.ppm; then
    feh --bg-fill /tmp/openbot-wallpaper.ppm &
  else
    xsetroot -solid "#1a1c22" &
  fi
fi

if ! pgrep -x xterm >/dev/null 2>&1; then
  xterm -title "Terminal" -geometry 100x24+24+64 -fa "DejaVu Sans Mono" -fs 10 &
fi

if ! pgrep -x x11vnc >/dev/null 2>&1; then
  x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 \
    -wait 20 -defer 20 -speeds lan \
    -o /tmp/openbot-x11vnc.log &
fi

echo "desktop ready $(date -Is)"
