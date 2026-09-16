import { useEffect, useRef } from "react";
import RFB from "@novnc/novnc";

export type VncState = "idle" | "connecting" | "live" | "down";

export function VncView({
  url,
  active,
  onState,
}: {
  url: string;
  active: boolean;
  onState: (state: VncState) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(onState);
  stateRef.current = onState;

  useEffect(() => {
    const target = containerRef.current;
    if (!active || !target) {
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
      const baseDelay = Math.min(1000 * 2 ** retryAttempt, 15_000);
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
      rfb.viewOnly = false;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = "#141417";
      client = rfb;
      rfb.addEventListener("connect", () => {
        if (!disposed) {
          retryAttempt = 0;
          stateRef.current("live");
        }
      });
      rfb.addEventListener("disconnect", () => {
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
      client?.disconnect();
      client = null;
      target.replaceChildren();
      stateRef.current("idle");
    };
  }, [active, url]);

  return <div className="vnc-target" ref={containerRef} />;
}
