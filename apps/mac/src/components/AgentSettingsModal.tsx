import { useEffect, useState } from "react";
import type {
  AccessMode,
  Bot,
  ComputerKind,
  ModelRef,
  ReasoningEffort,
  RolePolicy,
  Workspace,
} from "@openbot/protocol";
import { ConfirmDialog } from "./ConfirmDialog";
import { ComputerChoices } from "./ComputerChoices";
import {
  AVATAR_COLORS,
  COMPUTER_LABEL,
  EFFORT_OPTIONS,
  hasVm,
} from "../lib/agentOptions";
import type { SandboxState } from "../lib/useDaemon";

export interface AgentSettingsPatch {
  name: string;
  role: string | null;
  color: string;
  computers: ComputerKind[];
  workspaceId: string | null;
  access: AccessMode;
  policy: RolePolicy;
  model: ModelRef;
}

export function AgentSettingsModal({
  bot,
  sandboxState,
  streaming,
  workspaces,
  onClose,
  onSave,
  onPower,
  onReset,
  onDelete,
}: {
  bot: Bot | null;
  sandboxState: SandboxState;
  streaming: boolean;
  workspaces: Workspace[];
  onClose: () => void;
  onSave: (patch: AgentSettingsPatch) => void;
  onPower: (on: boolean) => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [color, setColor] = useState(AVATAR_COLORS[0]!);
  const [computers, setComputers] = useState<ComputerKind[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [access, setAccess] = useState<AccessMode>("project");
  const [policy, setPolicy] = useState<RolePolicy>("inherit");
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null);

  useEffect(() => {
    if (!bot) {
      return;
    }
    setName(bot.name);
    setRole(bot.role ?? "");
    setColor(bot.color ?? AVATAR_COLORS[0]!);
    setComputers(bot.computers ?? ["firecracker"]);
    setWorkspaceId(bot.workspaceId ?? "");
    setAccess(bot.access ?? "project");
    setPolicy(bot.policy);
    setEffort(bot.model.effort ?? "");
    setConfirm(null);
  }, [bot]);

  useEffect(() => {
    if (!bot) {
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
  }, [bot, onClose]);

  if (!bot) {
    return null;
  }

  const powerOn = sandboxState === "running" || sandboxState === "booting";
  const savedComputers: ComputerKind[] = bot.computers ?? ["firecracker"];
  const changed =
    name.trim() !== bot.name ||
    (role.trim() || null) !== (bot.role ?? null) ||
    color !== (bot.color ?? AVATAR_COLORS[0]!) ||
    computers.length !== savedComputers.length ||
    computers.some((item) => !savedComputers.includes(item)) ||
    (workspaceId || null) !== (bot.workspaceId ?? null) ||
    access !== (bot.access ?? "project") ||
    policy !== bot.policy ||
    (effort || null) !== (bot.model.effort ?? null);

  return (
    <>
      <div
        className="modal-overlay"
        role="dialog"
        aria-label="Agent settings"
        onClick={onClose}
      >
        <div
          className="modal agent-modal"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="modal-head">
            <div className="modal-head-title">
              <span className="avatar avatar-lg" style={{ background: color }} />
              <h2>Agent settings</h2>
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

          <div className="modal-body">
            <label className="field">
              <span>Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Research Scout"
                aria-label="Agent name"
              />
            </label>

            <label className="field">
              <span>Role</span>
              <input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="Marketing Lead"
                aria-label="Agent role"
              />
            </label>

            <div className="field">
              <span>Color</span>
              <div className="swatch-row">
                {AVATAR_COLORS.map((choice) => (
                  <button
                    key={choice}
                    className={`swatch ${
                      color === choice ? "swatch-active" : ""
                    }`}
                    style={{ background: choice }}
                    onClick={() => setColor(choice)}
                    aria-label={`Color ${choice}`}
                    aria-pressed={color === choice}
                  />
                ))}
              </div>
            </div>

            <div className="field">
              <span>Computer</span>
              <ComputerChoices value={computers} onChange={setComputers} />
              {computers.includes("firecracker") ? (
                <div className="agent-power-row">
                  <span>{COMPUTER_LABEL[sandboxState]}</span>
                  <button
                    role="switch"
                    aria-checked={powerOn}
                    aria-label="Computer power"
                    className={`switch ${powerOn ? "switch-on" : ""}`}
                    disabled={streaming}
                    title={
                      streaming
                        ? "The agent is working — wait for the run to finish"
                        : powerOn
                          ? "Turn the computer off"
                          : "Boot the computer"
                    }
                    onClick={() => onPower(!powerOn)}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
              ) : (
                <p className="computer-warning">
                  Runs commands directly on this Mac. Local tools always require
                  your approval.
                </p>
              )}
            </div>

            <label className="field">
              <span>Project folder</span>
              <select
                value={workspaceId}
                aria-label="Agent project folder"
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                <option value="">Scratch folder (no project)</option>
                {workspaces
                  .filter(
                    (workspace) => !workspace.ignored && !workspace.missing,
                  )
                  .map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
              </select>
              <p className="computer-warning">
                {workspaceId
                  ? (workspaces.find(
                      (workspace) => workspace.id === workspaceId,
                    )?.root ?? "")
                  : "File tools and shell run in a managed scratch folder. Add project folders in Settings → Workspaces."}
              </p>
            </label>

            {computers.includes("mac") && (
              <label className="field">
                <span>This Mac access</span>
                <select
                  value={access}
                  aria-label="Agent This Mac access"
                  onChange={(event) =>
                    setAccess(event.target.value as AccessMode)
                  }
                >
                  <option value="project">Project folder only</option>
                  <option value="home">Home folder</option>
                  <option value="full">Full access</option>
                </select>
                <p className="computer-warning">
                  {access === "project"
                    ? "File tools and shell stay inside the project folder."
                    : access === "home"
                      ? "File tools and shell reach anywhere under your home folder."
                      : "File tools and shell reach the whole filesystem as you. Every local action still asks unless the project trusts it."}
                </p>
              </label>
            )}

            <label className="field">
              <span>Approvals policy</span>
              <select
                value={policy}
                aria-label="Agent approvals policy"
                onChange={(event) =>
                  setPolicy(event.target.value as RolePolicy)
                }
              >
                <option value="inherit">Inherit the global policy</option>
                <option value="balanced">Balanced</option>
                <option value="read-only">Read-only</option>
                <option value="trusted">Trusted (auto)</option>
                <option value="locked">Locked down</option>
              </select>
              <p className="computer-warning">
                An agent's policy can only be stricter than the global one.
              </p>
            </label>

            <label className="field">
              <span>Reasoning effort</span>
              <select
                value={effort}
                aria-label="Agent reasoning effort"
                onChange={(event) =>
                  setEffort(event.target.value as ReasoningEffort | "")
                }
              >
                <option value="">Model default</option>
                {EFFORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="computer-warning">
                Sent to the provider as reasoning_effort. DeepSeek accepts
                none/low/high/max; OpenAI accepts minimal/low/medium/high.
              </p>
            </label>

            <div className="agent-modal-danger">
              <div className="agent-modal-danger-copy">
                <p className="agent-modal-danger-title">Danger zone</p>
                <p className="agent-modal-danger-sub">
                  Start fresh clears this agent's history and reinstalls its
                  computer. Delete removes the agent entirely.
                </p>
              </div>
              <div className="agent-modal-danger-actions">
                <button
                  className="ghost-button"
                  onClick={() => setConfirm("reset")}
                >
                  Start fresh
                </button>
                <button
                  className="danger-button"
                  onClick={() => setConfirm("delete")}
                >
                  Delete agent
                </button>
              </div>
            </div>
          </div>

          <footer className="modal-foot">
            <button className="ghost-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="save-button"
              disabled={!name.trim() || !changed}
              onClick={() =>
                onSave({
                  name: name.trim(),
                  role: role.trim() || null,
                  color,
                  computers,
                  workspaceId: workspaceId || null,
                  access,
                  policy,
                  model: {
                    provider: bot.model.provider,
                    model: bot.model.model,
                    ...(effort ? { effort } : {}),
                  },
                })
              }
            >
              Save
            </button>
          </footer>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === "reset"}
        title="Start fresh?"
        description={
          bot.workspaceId
            ? `This clears ${bot.name}'s chat history and rebuilds its computer. The project folder is not touched.`
            : !hasVm(bot)
              ? `This permanently deletes ${bot.name}'s chat history and its workspace files on this Mac.`
              : `This permanently deletes ${bot.name}'s chat history and everything on its computer — files, browser sign-ins, and installed software — then installs a clean system and boots it again.`
        }
        confirmLabel="Start fresh"
        onConfirm={() => {
          setConfirm(null);
          onReset();
        }}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === "delete"}
        title={`Delete ${bot.name}?`}
        description={`This permanently removes ${bot.name}, its history, and everything on its computer.`}
        confirmLabel="Delete agent"
        onConfirm={() => {
          setConfirm(null);
          onDelete();
        }}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
