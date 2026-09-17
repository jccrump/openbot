import { useEffect, useState } from "react";
import type { Memory, SoulVersion } from "@openbot/protocol";

export function MemoryModal({
  open,
  onClose,
  memories,
  soul,
  soulVersions,
  lastConsolidation,
  onLoad,
  onRemove,
  onConsolidate,
  onLoadSoul,
  onRevertSoul,
}: {
  open: boolean;
  onClose: () => void;
  memories: Memory[];
  soul: SoulVersion | null;
  soulVersions: SoulVersion[];
  lastConsolidation: { archived: number; merged: number } | null;
  onLoad: () => void;
  onRemove: (id: string) => void;
  onConsolidate: () => void;
  onLoadSoul: () => void;
  onRevertSoul: (versionId: string) => void;
}) {
  const [tab, setTab] = useState<"memory" | "soul">("memory");

  useEffect(() => {
    if (!open) {
      return;
    }
    onLoad();
    onLoadSoul();
  }, [open, onLoad, onLoadSoul]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-label="Memory"
      onClick={onClose}
    >
      <div
        className="modal memory-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-head-title">
            <h2>Memory</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </header>

        <div className="memory-tabs">
          <button
            className={`memory-tab ${tab === "memory" ? "memory-tab-active" : ""}`}
            onClick={() => setTab("memory")}
          >
            Memories ({memories.length})
          </button>
          <button
            className={`memory-tab ${tab === "soul" ? "memory-tab-active" : ""}`}
            onClick={() => setTab("soul")}
          >
            Soul (v{soul?.version ?? 1})
          </button>
          {tab === "memory" && (
            <button
              className="ghost-button memory-prune"
              onClick={onConsolidate}
              title="Decay and merge memories now"
            >
              Prune now
            </button>
          )}
        </div>

        {tab === "memory" ? (
          <div className="memory-body">
            {lastConsolidation && (
              <p className="memory-note">
                Last prune: {lastConsolidation.archived} archived,{" "}
                {lastConsolidation.merged} merged.
              </p>
            )}
            {memories.length === 0 && (
              <p className="sidebar-empty">
                No memories yet. They accumulate automatically as you work.
              </p>
            )}
            {memories.map((memory) => (
              <div
                key={memory.id}
                className={`memory-row memory-${memory.status}`}
              >
                <div className="memory-row-head">
                  <span className={`memory-badge memory-badge-${memory.type}`}>
                    {memory.type}
                  </span>
                  <span className="memory-scope">
                    {memory.scope === "user"
                      ? "you"
                      : memory.scope.slice(0, 8)}
                  </span>
                  <span className="memory-meta">
                    {memory.confidence.toFixed(2)} conf ·{" "}
                    {memory.importance.toFixed(2)} imp · used {memory.useCount}×
                  </span>
                  <button
                    className="icon-button"
                    title="Delete memory"
                    aria-label="Delete memory"
                    onClick={() => onRemove(memory.id)}
                  >
                    ×
                  </button>
                </div>
                <p className="memory-content">{memory.content}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="memory-body">
            {soul && (
              <div className="soul-current">
                <h3>Current soul</h3>
                <p>
                  <strong>Voice:</strong> {soul.content.voice}
                </p>
                <p>
                  <strong>Commitments:</strong>
                </p>
                <ul>
                  {soul.content.commitments.map((commitment, index) => (
                    <li key={index}>{commitment}</li>
                  ))}
                </ul>
                <p>
                  <strong>Relationship:</strong> {soul.content.relationship}
                </p>
              </div>
            )}
            <h3>History</h3>
            {soulVersions.map((version) => (
              <div key={version.id} className="soul-version">
                <div className="soul-version-head">
                  <span className="memory-badge">v{version.version}</span>
                  <span className="memory-meta">
                    {version.source} ·{" "}
                    {new Date(version.createdAt).toLocaleString()}
                  </span>
                  {version.version !== soul?.version && (
                    <button
                      className="ghost-button"
                      onClick={() => onRevertSoul(version.id)}
                    >
                      Revert
                    </button>
                  )}
                </div>
                <p className="memory-content">{version.reason}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
