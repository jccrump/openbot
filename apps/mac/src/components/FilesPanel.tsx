import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComputerKind, FileEntry } from "@openbot/protocol";
import type { FileListResult, FileReadResult } from "../lib/useDaemon";

function FolderIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-7.5l-2-2H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

function UpIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(mtime: number | null): string {
  if (!mtime) {
    return "";
  }
  return new Date(mtime).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function FilesPanel({
  botId,
  computer,
  rootLabel: rootLabelProp,
  active,
  openRequest,
  listFiles,
  readFile,
}: {
  botId: string;
  computer: ComputerKind;
  /** Shown for the root crumb; defaults to "Workspace" on This Mac. */
  rootLabel?: string;
  active: boolean;
  /** A file (or folder) the transcript asked to open; `nonce` re-fires it. */
  openRequest?: { path: string; nonce: number } | null;
  listFiles: (
    botId: string,
    path?: string,
    computer?: ComputerKind,
  ) => Promise<FileListResult>;
  readFile: (
    botId: string,
    path: string,
    computer?: ComputerKind,
  ) => Promise<FileReadResult>;
}) {
  const [started, setStarted] = useState(false);
  const [path, setPath] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileReadResult | null>(null);
  const [previewName, setPreviewName] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const requestSeq = useRef(0);
  const handledRequest = useRef<number | null>(null);

  const load = useCallback(
    async (target: string) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      const result = await listFiles(botId, target, computer);
      if (seq !== requestSeq.current) {
        return;
      }
      setLoading(false);
      if (result.error) {
        setError(result.error);
        setEntries([]);
        return;
      }
      setEntries(result.entries);
      setPath(result.path);
      if (!target) {
        setRootPath(result.path);
      }
    },
    [botId, computer, listFiles],
  );

  // Only talk to the computer once the section has been expanded at least
  // once, so a collapsed Files section never costs an exec.
  useEffect(() => {
    if (active) {
      setStarted(true);
    }
  }, [active]);

  useEffect(() => {
    if (!started) {
      return;
    }
    setPreview(null);
    setEntries([]);
    setPath("");
    setRootPath("");
    void load("");
  }, [botId, computer, load, started]);

  const fileName = (value: string) =>
    value.replace(/\/+$/, "").split("/").pop() || value;

  useEffect(() => {
    if (!started || !openRequest) {
      return;
    }
    if (handledRequest.current === openRequest.nonce) {
      return;
    }
    handledRequest.current = openRequest.nonce;
    let cancelled = false;
    const open = async () => {
      setPreviewName(fileName(openRequest.path));
      setPreviewLoading(true);
      setPreview(null);
      const result = await readFile(botId, openRequest.path, computer);
      if (cancelled) {
        return;
      }
      setPreviewLoading(false);
      if (!result.error && result.kind === "dir") {
        setPreview(null);
        if (!rootPath) {
          await load("");
        }
        void load(result.path);
        return;
      }
      setPreviewName(fileName(result.path || openRequest.path));
      setPreview(result);
      const parent = result.path
        .replace(/\/+$/, "")
        .split("/")
        .slice(0, -1)
        .join("/");
      if (parent) {
        if (!rootPath) {
          await load("");
        }
        if (!cancelled) {
          void load(parent);
        }
      }
    };
    void open();
    return () => {
      cancelled = true;
    };
  }, [botId, computer, load, openRequest, readFile, started]);

  const openEntry = (entry: FileEntry) => {
    const child = path ? `${path.replace(/\/+$/, "")}/${entry.name}` : entry.name;
    if (entry.dir) {
      setPreview(null);
      void load(child);
      return;
    }
    setPreviewName(entry.name);
    setPreviewLoading(true);
    setPreview(null);
    void readFile(botId, child, computer).then((result) => {
      setPreview(result);
      setPreviewLoading(false);
    });
  };

  const goUp = () => {
    const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    setPreview(null);
    void load(parent || rootPath);
  };

  const segments = useMemo(() => {
    if (!rootPath || !path.startsWith(rootPath)) {
      return [] as Array<{ name: string; path: string }>;
    }
    const relative = path.slice(rootPath.length).replace(/^\//, "");
    if (!relative) {
      return [] as Array<{ name: string; path: string }>;
    }
    let cumulative = rootPath;
    return relative.split("/").map((name) => {
      cumulative = `${cumulative.replace(/\/+$/, "")}/${name}`;
      return { name, path: cumulative };
    });
  }, [path, rootPath]);

  const rootLabel =
    rootLabelProp ??
    (computer === "mac" ? "Workspace" : "/root");
  const atRoot = path === rootPath;
  const previewSrc =
    preview?.kind === "image" && preview.content
      ? `data:${preview.mime ?? "image/png"};base64,${preview.content}`
      : null;

  if (!started) {
    return null;
  }

  if (preview || previewLoading) {
    return (
      <div className="files-panel">
        <div className="files-toolbar">
          <button
            className="icon-button"
            title="Back to files"
            aria-label="Back to files"
            onClick={() => {
              setPreview(null);
              setPreviewLoading(false);
            }}
          >
            <UpIcon />
          </button>
          <span className="files-preview-title" title={preview?.path}>
            {previewName}
          </span>
        </div>
        <div className="files-preview">
          {previewLoading && <p className="files-note">Reading…</p>}
          {!previewLoading && preview?.error && (
            <p className="files-error">{preview.error}</p>
          )}
          {!previewLoading && preview && !preview.error && preview.kind === "text" && (
            <>
              <pre className="files-preview-text">{preview.content}</pre>
              {preview.truncated && (
                <p className="files-note">
                  Showing the first {formatSize(preview.size)} of this file.
                </p>
              )}
            </>
          )}
          {!previewLoading && preview && !preview.error && preview.kind === "image" && (
            <img
              className="files-preview-image"
              src={previewSrc ?? undefined}
              alt={previewName}
            />
          )}
          {!previewLoading &&
            preview &&
            !preview.error &&
            preview.kind !== "text" &&
            preview.kind !== "image" && (
              <p className="files-note">
                This file is {formatSize(preview.size)} of binary data, so it
                cannot be shown here.
              </p>
            )}
        </div>
      </div>
    );
  }

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <button
          className="icon-button"
          title="Up one folder"
          aria-label="Up one folder"
          disabled={atRoot}
          onClick={goUp}
        >
          <UpIcon />
        </button>
        <nav className="files-breadcrumb" aria-label="Folder path">
          <button
            className="files-crumb"
            onClick={() => void load(rootPath)}
            disabled={atRoot}
          >
            {rootLabel}
          </button>
          {segments.map((segment) => (
            <span className="files-crumb-group" key={segment.path}>
              <span className="files-crumb-sep">/</span>
              <button
                className="files-crumb"
                onClick={() => void load(segment.path)}
                disabled={segment.path === path}
              >
                {segment.name}
              </button>
            </span>
          ))}
        </nav>
        <button
          className="icon-button"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => void load(path || rootPath)}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="files-list">
        {loading && <p className="files-note">Loading files…</p>}
        {!loading && error && (
          <div className="files-error-block">
            <p className="files-error">{error}</p>
            <button
              className="files-retry"
              onClick={() => void load(path || rootPath)}
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <p className="files-note">This folder is empty.</p>
        )}
        {!loading &&
          !error &&
          entries.map((entry) => (
            <button
              key={entry.name}
              className="files-row"
              title={entry.name}
              onClick={() => openEntry(entry)}
            >
              <span className={`files-row-icon${entry.dir ? " is-dir" : ""}`}>
                {entry.dir ? <FolderIcon /> : <FileIcon />}
              </span>
              <span className="files-row-name">{entry.name}</span>
              <span className="files-row-meta">
                {entry.dir ? "" : formatSize(entry.size)}
                {entry.dir ? "" : " · "}
                {formatDate(entry.mtime)}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
