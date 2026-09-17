import { useEffect, useState } from "react";
import type { Bot, ComputerKind, RolePolicy } from "@openbot/protocol";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  AVATAR_COLORS,
  COMPUTER_LABEL,
  EMOJI_CHOICES,
} from "../lib/agentOptions";
import type { SandboxState } from "../lib/useDaemon";

export interface AgentSettingsPatch {
  name: string;
  role: string | null;
  avatar: string;
  color: string;
  computer: ComputerKind;
  delegates: boolean;
  policy: RolePolicy;
}

export function AgentSettingsModal({
  bot,
  sandboxState,
  streaming,
  onClose,
  onSave,
  onPower,
  onReset,
  onDelete,
}: {
  bot: Bot | null;
  sandboxState: SandboxState;
  streaming: boolean;
  onClose: () => void;
  onSave: (patch: AgentSettingsPatch) => void;
  onPower: (on: boolean) => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [avatar, setAvatar] = useState(EMOJI_CHOICES[0]!);
  const [color, setColor] = useState(AVATAR_COLORS[0]!);
  const [computer, setComputer] = useState<ComputerKind>("firecracker");
  const [delegates, setDelegates] = useState(false);
  const [policy, setPolicy] = useState<RolePolicy>("inherit");
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null);

  useEffect(() => {
    if (!bot) {
      return;
    }
    setName(bot.name);
    setRole(bot.role ?? "");
    setAvatar(bot.avatar ?? EMOJI_CHOICES[0]!);
    setColor(bot.color ?? AVATAR_COLORS[0]!);
    setComputer(bot.computer === "mac" ? "mac" : "firecracker");
    setDelegates(bot.delegates);
    setPolicy(bot.policy);
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
  const changed =
    name.trim() !== bot.name ||
    (role.trim() || null) !== (bot.role ?? null) ||
    avatar !== (bot.avatar ?? EMOJI_CHOICES[0]!) ||
    color !== (bot.color ?? AVATAR_COLORS[0]!) ||
    computer !== (bot.computer === "mac" ? "mac" : "firecracker") ||
    delegates !== bot.delegates ||
    policy !== bot.policy;

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
              <span className="avatar avatar-lg" style={{ background: color }}>
                {avatar}
              </span>
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
              <span>Icon</span>
              <div className="emoji-row">
                {EMOJI_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    className={`emoji-choice ${
                      avatar === choice ? "emoji-choice-active" : ""
                    }`}
                    onClick={() => setAvatar(choice)}
                    aria-label={`Icon ${choice}`}
                    aria-pressed={avatar === choice}
                  >
                    {choice}
                  </button>
                ))}
              </div>
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
              <div className="computer-choices">
                <button
                  className={`computer-choice ${
                    computer === "firecracker" ? "computer-choice-active" : ""
                  }`}
                  onClick={() => setComputer("firecracker")}
                >
                  <span className="computer-choice-title">
                    Firecracker microVM
                  </span>
                  <span className="computer-choice-sub">
                    Isolated Linux computer
                  </span>
                </button>
                <button
                  className={`computer-choice ${
                    computer === "mac" ? "computer-choice-active" : ""
                  }`}
                  onClick={() => setComputer("mac")}
                >
                  <span className="computer-choice-title">This Mac</span>
                  <span className="computer-choice-sub">
                    Runs commands directly on this Mac
                  </span>
                </button>
              </div>
              {computer === "firecracker" ? (
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

            <div className="field">
              <span>Delegation</span>
              <div className="agent-power-row">
                <span>
                  {delegates
                    ? "Manages projects and spawns workers of its own"
                    : "Works on tasks the lead assigns"}
                </span>
                <button
                  role="switch"
                  aria-checked={delegates}
                  aria-label="Can delegate"
                  className={`switch ${delegates ? "switch-on" : ""}`}
                  onClick={() => setDelegates((value) => !value)}
                >
                  <span className="switch-knob" />
                </button>
              </div>
              <p className="computer-warning">
                Managers can only allocate tools and budget that fit inside the
                grant the lead approved for their project.
              </p>
            </div>

            <label className="field">
              <span>Approvals policy</span>
              <select
                value={policy}
                aria-label="Role approvals policy"
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
                A role's policy can only be stricter than the global one.
              </p>
            </label>

            <div className="agent-modal-danger">
              <div className="agent-modal-danger-copy">
                <p className="agent-modal-danger-title">Danger zone</p>
                <p className="agent-modal-danger-sub">
                  Start fresh clears this role's tasks and reinstalls its
                  computer. Delete removes the role entirely.
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
                  Delete role
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
                  avatar,
                  color,
                  computer,
                  delegates,
                  policy,
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
          bot.computer === "mac"
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
        description={`This permanently removes ${bot.name}, its task history, and everything on its computer.`}
        confirmLabel="Delete role"
        onConfirm={() => {
          setConfirm(null);
          onDelete();
        }}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
