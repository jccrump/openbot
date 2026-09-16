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

    const connect = () => {
      if (disposed) {
        return;
      }
      stateRef.current("connecting");
      const rfb = new RFB(target, url, { shared: true });
      rfb.viewOnly = false;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = "#141417";
      client = rfb;
      rfb.addEventListener("connect", () => {
        if (!disposed) {
          stateRef.current("live");
        }
      });
      rfb.addEventListener("disconnect", () => {
        if (disposed) {
          return;
        }
        client = null;
        stateRef.current("down");
        retryTimer = window.setTimeout(connect, 2500);
      });
      rfb.addEventListener("securityfailure", () => {
        if (!disposed) {
          stateRef.current("down");
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
