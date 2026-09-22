import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TerminalStatus = "idle" | "connecting" | "open" | "closed" | "error";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const STATUS_LABEL: Record<TerminalStatus, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  open: "Connected",
  closed: "Session ended",
  error: "Disconnected",
};

export function TerminalPanel({
  botId,
  canConnect,
  url,
  active,
}: {
  botId: string;
  canConnect: boolean;
  url: string;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  // The pty session lives only while the panel is mounted, so start it the
  // first time the section is expanded and keep it running across collapses.
  useEffect(() => {
    if (active && canConnect) {
      setStarted(true);
    }
  }, [active, canConnect]);

  useEffect(() => {
    if (!started || !canConnect) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: "#0d0d0f",
        foreground: "#e8e8ea",
        cursor: "#e8e8ea",
        selectionBackground: "rgba(255,255,255,0.22)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const safeFit = () => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0) {
        return;
      }
      try {
        fit.fit();
      } catch {
        // the container can vanish mid-resize
      }
    };
    safeFit();

    let closedByUs = false;
    let sawExit = false;
    let buffer = "";
    const socket = new WebSocket(url);
    setStatus("connecting");
    setMessage(null);

    const send = (payload: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    socket.onopen = () => {
      setStatus("open");
      send({ type: "open", cols: term.cols, rows: term.rows });
      term.focus();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      buffer += event.data;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        try {
          const frame = JSON.parse(line) as {
            type?: string;
            data?: string;
          };
          if (frame.type === "data" && typeof frame.data === "string") {
            term.write(base64ToBytes(frame.data));
          } else if (frame.type === "exit") {
            sawExit = true;
            term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
            setStatus("closed");
          }
        } catch {
          // ignore malformed frames
        }
      }
    };

    socket.onerror = () => {
      setStatus("error");
      setMessage("Could not open a terminal on this computer.");
    };

    socket.onclose = (event) => {
      if (closedByUs) {
        return;
      }
      if (event.code === 1000 || sawExit) {
        setStatus("closed");
      } else {
        setStatus("error");
        setMessage(
          event.reason ||
            "The terminal disconnected. The computer may have stopped.",
        );
      }
    };

    const dataSub = term.onData((data) =>
      send({ type: "input", data: bytesToBase64(new TextEncoder().encode(data)) }),
    );
    const resizeSub = term.onResize(({ cols, rows }) =>
      send({ type: "resize", cols, rows }),
    );
    const observer = new ResizeObserver(() => safeFit());
    observer.observe(host);
    const focus = () => term.focus();
    host.addEventListener("mousedown", focus);

    return () => {
      closedByUs = true;
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      host.removeEventListener("mousedown", focus);
      try {
        socket.close(1000, "panel closed");
      } catch {
        // already closed
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [started, canConnect, botId, url, generation]);

  // Refit and focus whenever the section becomes visible again.
  useEffect(() => {
    if (!active || !started) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const host = hostRef.current;
      if (host && host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fitRef.current?.fit();
        } catch {
          // ignore
        }
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, started]);

  if (!canConnect) {
    return (
      <div className="terminal-panel">
        <div className="terminal-empty">
          <p>Select an agent to open a terminal.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <span className={`terminal-status terminal-status-${status}`}>
          {STATUS_LABEL[status]}
        </span>
        <span className="terminal-toolbar-spacer" />
        <button
          className="terminal-button"
          onClick={() => termRef.current?.clear()}
        >
          Clear
        </button>
        <button
          className="terminal-button"
          onClick={() => setGeneration((value) => value + 1)}
        >
          Reconnect
        </button>
      </div>
      {message && <p className="terminal-message">{message}</p>}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
