import { useEffect, useState } from "react";

const SCREEN_WIDTH_KEY = "openbot.screenWidth";
const MIN_WIDTH = 300;
const MIN_CHAT_WIDTH = 480;
const MAX_WIDTH = 960;

export function PanelResizer({ active }: { active: boolean }) {
  const [dragging, setDragging] = useState(false);

  // Apply the stored width, clamped to what this window can actually fit so a
  // panel sized on a large window cannot swallow the chat on a small one.
  const applyStoredWidth = () => {
    try {
      const stored = Number(localStorage.getItem(SCREEN_WIDTH_KEY));
      if (!(stored >= MIN_WIDTH)) {
        return;
      }
      const max = Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, window.innerWidth - MIN_CHAT_WIDTH),
      );
      document.documentElement.style.setProperty(
        "--screen-width",
        `${Math.min(stored, max)}px`,
      );
    } catch {}
  };

  useEffect(() => {
    applyStoredWidth();
    window.addEventListener("resize", applyStoredWidth);
    return () => window.removeEventListener("resize", applyStoredWidth);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => {
      const max = Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, window.innerWidth - MIN_CHAT_WIDTH),
      );
      const next = Math.min(
        Math.max(window.innerWidth - event.clientX, MIN_WIDTH),
        max,
      );
      document.documentElement.style.setProperty(
        "--screen-width",
        `${next}px`,
      );
      try {
        localStorage.setItem(SCREEN_WIDTH_KEY, String(Math.round(next)));
      } catch {}
    };
    const stop = () => setDragging(false);
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
    return () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };
  }, [dragging]);

  return (
    <div
      className={`panel-resizer ${active ? "" : "panel-resizer-hidden"}`}
      title="Drag to resize"
      onMouseDown={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDoubleClick={() => {
        document.documentElement.style.removeProperty("--screen-width");
        try {
          localStorage.removeItem(SCREEN_WIDTH_KEY);
        } catch {}
      }}
    />
  );
}
