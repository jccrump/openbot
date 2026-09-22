import type { ReactNode } from "react";

export async function openExternalUrl(url: string): Promise<void> {
  try {
    if ("__TAURI_INTERNALS__" in window) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    }
  } catch {
    // Fall through to the browser behavior below.
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function ChipLinkIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.4 3.4H3.6A1.6 1.6 0 0 0 2 5v7.4A1.6 1.6 0 0 0 3.6 14H11a1.6 1.6 0 0 0 1.6-1.6V9.6" />
      <path d="M9.4 2h4.6v4.6" />
      <path d="M13.6 2.4 7.4 8.6" />
    </svg>
  );
}

export function ChipFileIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.2 1.8H4.4A1.4 1.4 0 0 0 3 3.2v9.6a1.4 1.4 0 0 0 1.4 1.4h7.2a1.4 1.4 0 0 0 1.4-1.4V5.6l-3.8-3.8Z" />
      <path d="M9.2 1.8v3.8h3.8" />
    </svg>
  );
}

export function LinkChip({
  url,
  label,
}: {
  url: string;
  label: ReactNode;
}) {
  return (
    <a
      className="md-chip md-chip-link"
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(url);
      }}
    >
      <ChipLinkIcon />
      <span className="md-chip-label">{label}</span>
    </a>
  );
}

export function FileChip({
  label,
  title,
  className,
  onClick,
}: {
  label: string;
  title?: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`md-chip md-chip-file${className ? ` ${className}` : ""}`}
      title={title ?? label}
      onClick={onClick}
    >
      <ChipFileIcon />
      <span className="md-chip-label">{label}</span>
    </button>
  );
}

/** The chip label for a bare URL: drop the scheme so long links stay readable. */
export function urlChipLabel(url: string): string {
  const trimmed = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return trimmed || url;
}
