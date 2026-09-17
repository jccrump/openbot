import { useEffect, useState } from "react";
import type {
  ApprovalRecord,
  ApprovalTier,
  PolicyPresetId,
  PolicyRule,
  PolicySettings,
} from "@openbot/protocol";

const PRESET_LABEL: Record<PolicyPresetId, string> = {
  balanced: "Balanced",
  "read-only": "Read-only",
  trusted: "Trusted",
  locked: "Locked down",
};

const TOOLS = [
  "shell",
  "read_file",
  "write_file",
  "browser",
  "browse",
  "desktop",
];

function newRule(): PolicyRule {
  return {
    id: `rule-${Math.random().toString(36).slice(2, 8)}`,
    tool: "shell",
    scope: "*",
    match: "command",
    pattern: "",
    tier: "ask",
    note: null,
  };
}

export function ApprovalsModal({
  open,
  onClose,
  records,
  pendingCount,
  policy,
  requireApproval,
  onLoad,
  onRespond,
  onSavePolicy,
  onApplyPreset,
}: {
  open: boolean;
  onClose: () => void;
  records: ApprovalRecord[];
  pendingCount: number;
  policy: PolicySettings;
  requireApproval: boolean;
  onLoad: () => void;
  onRespond: (requestId: string, decision: "approve" | "deny") => void;
  onSavePolicy: (input: {
    requireApproval: boolean;
    policy: PolicySettings;
  }) => void;
  onApplyPreset: (preset: PolicyPresetId) => void;
}) {
  const [tab, setTab] = useState<"inbox" | "policy">("inbox");
  const [draft, setDraft] = useState<PolicySettings>(policy);
  const [approvalOn, setApprovalOn] = useState(requireApproval);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(policy);
    setApprovalOn(requireApproval);
  }, [open, policy, requireApproval]);

  useEffect(() => {
    if (!open) {
      return;
    }
    onLoad();
  }, [open, onLoad, pendingCount]);

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

  const updateRule = (id: string, patch: Partial<PolicyRule>) => {
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule,
      ),
    }));
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-label="Approvals"
      onClick={onClose}
    >
      <div
        className="modal memory-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-head-title">
            <h2>Approvals</h2>
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
            className={`memory-tab ${tab === "inbox" ? "memory-tab-active" : ""}`}
            onClick={() => setTab("inbox")}
          >
            Inbox ({pendingCount})
          </button>
          <button
            className={`memory-tab ${tab === "policy" ? "memory-tab-active" : ""}`}
            onClick={() => setTab("policy")}
          >
            Policy
          </button>
        </div>

        {tab === "inbox" ? (
          <div className="memory-body">
            {records.length === 0 && (
              <p className="sidebar-empty">No approvals yet.</p>
            )}
            {records.map((record) => (
              <div key={record.id} className="memory-row">
                <div className="memory-row-head">
                  <span className="memory-badge">{record.tool}</span>
                  <span className="memory-scope">
                    {record.tier === "deny" ? "blocked" : record.tier}
                  </span>
                  <span className="memory-meta">
                    {record.decision === null
                      ? "pending"
                      : `${record.decision}${record.decidedBy ? ` · ${record.decidedBy}` : ""}`}
                    {" · "}
                    {new Date(record.requestedAt).toLocaleTimeString()}
                  </span>
                </div>
                <p className="memory-content">
                  {record.reason || "no policy note"}
                </p>
                {record.arguments && (
                  <pre className="tool-command">
                    {record.arguments.slice(0, 240)}
                  </pre>
                )}
                {record.decision === null && (
                  <div className="approval-actions">
                    <button
                      className="approve-button"
                      onClick={() => onRespond(record.requestId, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      className="deny-button"
                      onClick={() => onRespond(record.requestId, "deny")}
                    >
                      Deny
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="memory-body">
            <div className="agent-power-row">
              <span>Ask before running tools</span>
              <button
                role="switch"
                aria-checked={approvalOn}
                aria-label="Ask before running tools"
                className={`switch ${approvalOn ? "switch-on" : ""}`}
                onClick={() => setApprovalOn((value) => !value)}
              >
                <span className="switch-knob" />
              </button>
            </div>

            <div className="policy-presets">
              {(
                ["balanced", "read-only", "trusted", "locked"] as const
              ).map((preset) => (
                <button
                  key={preset}
                  className="ghost-button"
                  onClick={() => onApplyPreset(preset)}
                >
                  {PRESET_LABEL[preset]}
                </button>
              ))}
            </div>

            <div className="policy-grid">
              <label className="policy-field">
                <span>Default tier</span>
                <select
                  value={draft.defaultTier}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      defaultTier: event.target
                        .value as PolicySettings["defaultTier"],
                    }))
                  }
                >
                  <option value="inherit">Follow the switch</option>
                  <option value="auto">Auto</option>
                  <option value="ask">Ask</option>
                  <option value="deny">Deny</option>
                </select>
              </label>
              <label className="policy-field">
                <span>Approval timeout (minutes)</span>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={Math.round(draft.timeoutMs / 60_000)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      timeoutMs:
                        Math.max(0, Number(event.target.value) || 0) * 60_000,
                    }))
                  }
                />
              </label>
            </div>

            <h3>Tools</h3>
            <div className="policy-grid">
              {TOOLS.map((tool) => (
                <label key={tool} className="policy-field">
                  <span>{tool}</span>
                  <select
                    value={draft.tools[tool] ?? ""}
                    onChange={(event) =>
                      setDraft((current) => {
                        const tools = { ...current.tools };
                        if (!event.target.value) {
                          delete tools[tool];
                        } else {
                          tools[tool] = event.target.value as ApprovalTier;
                        }
                        return { ...current, tools };
                      })
                    }
                  >
                    <option value="">Default</option>
                    <option value="auto">Auto</option>
                    <option value="ask">Ask</option>
                    <option value="deny">Deny</option>
                  </select>
                </label>
              ))}
            </div>

            <h3>Egress</h3>
            <div className="policy-grid">
              <label className="policy-field">
                <span>Unlisted domains</span>
                <select
                  value={draft.egress?.mode ?? "off"}
                  onChange={(event) => {
                    const mode = event.target.value as "off" | "ask" | "deny";
                    setDraft((current) => ({
                      ...current,
                      egress:
                        mode === "off"
                          ? undefined
                          : { mode, allow: current.egress?.allow ?? [] },
                    }));
                  }}
                >
                  <option value="off">Allow</option>
                  <option value="ask">Ask</option>
                  <option value="deny">Deny</option>
                </select>
              </label>
            </div>
            <textarea
              className="policy-egress"
              value={(draft.egress?.allow ?? []).join("\n")}
              placeholder={"Allowed domains, one per line\nexample.com"}
              onChange={(event) => {
                const allow = event.target.value
                  .split("\n")
                  .map((entry) => entry.trim().toLowerCase())
                  .filter(Boolean);
                setDraft((current) => ({
                  ...current,
                  egress: {
                    mode: current.egress?.mode ?? "ask",
                    allow,
                  },
                }));
              }}
            />
            <p className="memory-note">
              Applies to browser navigation. Shell egress is not covered yet.
            </p>

            <h3>Rules</h3>
            {draft.rules.map((rule) => (
              <div key={rule.id} className="policy-rule">
                <select
                  value={rule.tool}
                  onChange={(event) =>
                    updateRule(rule.id, { tool: event.target.value })
                  }
                >
                  <option value="*">any tool</option>
                  {TOOLS.map((tool) => (
                    <option key={tool} value={tool}>
                      {tool}
                    </option>
                  ))}
                </select>
                <select
                  value={rule.scope}
                  onChange={(event) =>
                    updateRule(rule.id, {
                      scope: event.target.value as PolicyRule["scope"],
                    })
                  }
                >
                  <option value="*">any computer</option>
                  <option value="firecracker">microVM</option>
                  <option value="mac">This Mac</option>
                </select>
                <select
                  value={rule.match}
                  onChange={(event) =>
                    updateRule(rule.id, {
                      match: event.target.value as PolicyRule["match"],
                    })
                  }
                >
                  <option value="command">command</option>
                  <option value="path">path</option>
                  <option value="domain">domain</option>
                  <option value="text">text</option>
                </select>
                <input
                  value={rule.pattern}
                  placeholder="regex"
                  onChange={(event) =>
                    updateRule(rule.id, { pattern: event.target.value })
                  }
                />
                <select
                  value={rule.tier}
                  onChange={(event) =>
                    updateRule(rule.id, {
                      tier: event.target.value as ApprovalTier,
                    })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="ask">Ask</option>
                  <option value="deny">Deny</option>
                </select>
                <button
                  className="icon-button"
                  aria-label="Remove rule"
                  title="Remove rule"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      rules: current.rules.filter(
                        (entry) => entry.id !== rule.id,
                      ),
                    }))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <div>
              <button
                className="ghost-button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    rules: [...current.rules, newRule()],
                  }))
                }
              >
                Add rule
              </button>
            </div>

            <div className="modal-foot policy-foot">
              <button
                className="save-button"
                onClick={() =>
                  onSavePolicy({ requireApproval: approvalOn, policy: draft })
                }
              >
                Save policy
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
