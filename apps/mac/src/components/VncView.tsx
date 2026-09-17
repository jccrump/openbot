import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";

export type VncState = "idle" | "connecting" | "live" | "down";

type RfbSocket = object;
type FramebufferUpdateRequest = (
  socket: RfbSocket,
  incremental: boolean,
  x?: number,
  y?: number,
  width?: number,
  height?: number,
) => void;
type RfbWithSocket = RFB & { _sock?: RfbSocket };
type RfbConstructorWithMessages = typeof RFB & {
  messages?: { fbUpdateRequest?: FramebufferUpdateRequest };
};

const heldSockets = new WeakSet<RfbSocket>();
const pendingUpdates = new WeakMap<
  RfbSocket,
  { receiver: unknown; args: Parameters<FramebufferUpdateRequest> }
>();
let frameHoldInstalled = false;

function installFrameHold() {
  if (frameHoldInstalled) return true;
  const messages = (RFB as RfbConstructorWithMessages).messages;
  const original = messages?.fbUpdateRequest;
  if (!messages || !original) return false;

  messages.fbUpdateRequest = function (
    this: unknown,
    ...args: Parameters<FramebufferUpdateRequest>
  ) {
    const socket = args[0];
    if (heldSockets.has(socket)) {
      pendingUpdates.set(socket, { receiver: this, args });
      return;
    }
    original.apply(this, args);
  };
  frameHoldInstalled = true;
  return true;
}

function setFrameHeld(client: RFB, held: boolean) {
  if (!installFrameHold()) return;
  const socket = (client as RfbWithSocket)._sock;
  if (!socket) return;

  if (held) {
    heldSockets.add(socket);
    return;
  }

  heldSockets.delete(socket);
  const pending = pendingUpdates.get(socket);
  if (!pending) return;
  pendingUpdates.delete(socket);
  const send = (RFB as RfbConstructorWithMessages).messages?.fbUpdateRequest;
  send?.apply(pending.receiver, pending.args);
}

function clearFrameHold(client: RFB) {
  const socket = (client as RfbWithSocket)._sock;
  if (!socket) return;
  heldSockets.delete(socket);
  pendingUpdates.delete(socket);
}

export function VncView({
  url,
  active,
  interactive,
  onState,
}: {
  url: string;
  active: boolean;
  interactive: boolean;
  onState: (state: VncState) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<RFB | null>(null);
  const stateRef = useRef(onState);
  const [pageInteractive, setPageInteractive] = useState(
    () => !document.hidden && document.hasFocus(),
  );
  const interactiveRef = useRef(pageInteractive);
  interactiveRef.current = pageInteractive;
  const viewInteractiveRef = useRef(interactive);
  viewInteractiveRef.current = interactive;
  stateRef.current = onState;

  useEffect(() => {
    const syncActivity = () => {
      setPageInteractive(!document.hidden && document.hasFocus());
    };
    document.addEventListener("visibilitychange", syncActivity);
    window.addEventListener("focus", syncActivity);
    window.addEventListener("blur", syncActivity);
    return () => {
      document.removeEventListener("visibilitychange", syncActivity);
      window.removeEventListener("focus", syncActivity);
      window.removeEventListener("blur", syncActivity);
    };
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.viewOnly = !(pageInteractive && interactive);
    setFrameHeld(client, !pageInteractive);
  }, [pageInteractive, interactive]);

  useEffect(() => {
    const target = containerRef.current;
    if (!active || !target) {
      stateRef.current("idle");
      return;
    }
    let disposed = false;
    let client: RFB | null = null;
    let retryTimer: number | null = null;
    let retryAttempt = 0;

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== null) {
        return;
      }
      const baseDelay = Math.min(1000 * 2 ** retryAttempt, 5_000);
      const jitter = Math.floor(Math.random() * 500);
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connect();
      }, baseDelay + jitter);
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      stateRef.current("connecting");
      target.replaceChildren();
      let rfb: RFB;
      try {
        rfb = new RFB(target, url, { shared: true });
      } catch {
        stateRef.current("down");
        scheduleReconnect();
        return;
      }
      rfb.viewOnly = !(interactiveRef.current && viewInteractiveRef.current);
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      // A little compression keeps full-screen updates out of the relay
      // buffers without making the small guest spend heavily on encoding.
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 1;
      rfb.background = "#141417";
      client = rfb;
      clientRef.current = rfb;
      setFrameHeld(rfb, !interactiveRef.current);
      rfb.addEventListener("connect", () => {
        if (!disposed) {
          retryAttempt = 0;
          setFrameHeld(rfb, !interactiveRef.current);
          stateRef.current("live");
        }
      });
      rfb.addEventListener("disconnect", () => {
        clearFrameHold(rfb);
        if (clientRef.current === rfb) clientRef.current = null;
        if (disposed) {
          return;
        }
        client = null;
        stateRef.current("down");
        scheduleReconnect();
      });
      rfb.addEventListener("securityfailure", () => {
        if (!disposed) {
          stateRef.current("down");
          scheduleReconnect();
          rfb.disconnect();
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (client) clearFrameHold(client);
      client?.disconnect();
      if (clientRef.current === client) clientRef.current = null;
      client = null;
      target.replaceChildren();
      stateRef.current("idle");
    };
  }, [active, url]);

  return <div className="vnc-target" ref={containerRef} />;
}
