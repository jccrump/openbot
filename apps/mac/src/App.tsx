import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AccessMode,
  Bot,
  ComputerKind,
  Message,
  ModelRef,
  ReasoningEffort,
  Thread,
  ToolArtifact,
  ToolCallRecord,
  Workspace,
} from "@openbot/protocol";
import { Settings } from "./Settings";
import { botComputers, primaryComputer } from "@openbot/protocol";
import { AgentSettingsModal } from "./components/AgentSettingsModal";
import { ApprovalsModal } from "./components/ApprovalsModal";
import { ComputerChoices } from "./components/ComputerChoices";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { FilesPanel } from "./components/FilesPanel";
import { Markdown } from "./components/Markdown";
import { MemoryModal } from "./components/MemoryModal";
import { TerminalPanel } from "./components/TerminalPanel";
import { VncView, type VncState } from "./components/VncView";
import {
  AVATAR_COLORS,
  avatarColor,
  EFFORT_OPTIONS,
  hasVm,
  isMacOnly,
} from "./lib/agentOptions";
import { DAEMON_HTTP_URL } from "./lib/daemon";
import { useTheme } from "./lib/useTheme";
import {
  isProviderUsable,
  useDaemon,
  type CreateBotInput,
  type ModelOption,
  type PendingApproval,
  type PendingChallenge,
  type StreamingState,
  type ToolActivity,
} from "./lib/useDaemon";
import "./App.css";

const STATUS_LABEL: Record<string, string> = {
  connected: "Daemon connected",
  connecting: "Connecting to daemon…",
  disconnected: "Daemon offline — run pnpm dev:daemon",
};

const PANEL_OPEN_KEY = "openbot.panelOpen.v3";
const SCREEN_POLL_MS = 1500;
const SCREEN_OFF_POLL_MS = 8_000;

type ScreenStatus = "loading" | "live" | "vm-off" | "error";

type PanelTab = "screen" | "terminal" | "files";

const PANEL_TABS: Array<{ id: PanelTab; label: string }> = [
  { id: "screen", label: "Screen" },
  { id: "terminal", label: "Terminal" },
  { id: "files", label: "Files" },
];

/** This Mac has no captured screen, so its panels are terminal and files only. */
const LOCAL_PANEL_TABS = PANEL_TABS.filter((tab) => tab.id !== "screen");

function storedPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

interface ToolArguments {
  command?: string;
  path?: string;
  action?: string;
  url?: string;
  href?: string;
  selector?: string;
  text?: string;
  keys?: string;
  title?: string;
  goal?: string;
  query?: string;
  startUrl?: string;
  milliseconds?: number;
  pixels?: number;
  x?: number;
  y?: number;
}

interface ToolLabel {
  text: string;
  code?: string;
}

// Tool rows read like a terminal: a short verb plus the raw argument in
// monospace. Tools the app does not have a native verb for fall back to
// `Called \`tool_name\``, matching the agent harness the app talks to.
function toolLabel(name: string): ToolLabel {
  if (name === "shell") {
    return { text: "Shell" };
  }
  if (name === "write_file") {
    return { text: "Wrote" };
  }
  if (name === "edit") {
    return { text: "Edited" };
  }
  if (name === "read_file") {
    return { text: "Read" };
  }
  if (name === "web_search") {
    return { text: "Searched" };
  }
  return { text: "Called", code: name };
}

function parseToolArguments(raw: string): ToolArguments {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ToolArguments;
    }
    return {};
  } catch {
    return {};
  }
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

// One line of monospace: the command for shell, the path for file tools, the
// action and target for computer tools, and `key=value` pairs for everything
// else. Kept verbatim rather than prettified so it matches what the bot ran.
function toolDetail(raw: string): string {
  const parsed = parseToolArguments(raw);
  if (parsed.command) return parsed.command;
  if (parsed.path) return parsed.path;
  if (parsed.goal) return parsed.goal;
  if (parsed.query) return parsed.query;
  if (parsed.action) {
    const target =
      parsed.url ??
      parsed.href ??
      parsed.selector ??
      parsed.keys ??
      parsed.title ??
      parsed.text ??
      parsed.startUrl ??
      (parsed.milliseconds !== undefined
        ? `${parsed.milliseconds} ms`
        : undefined) ??
      (parsed.pixels !== undefined ? `${parsed.pixels} px` : undefined) ??
      (parsed.x !== undefined && parsed.y !== undefined
        ? `${parsed.x}, ${parsed.y}`
        : undefined);
    return target ? `${parsed.action} ${target}` : parsed.action;
  }
  if (parsed.startUrl) return parsed.startUrl;
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (entries.length > 0) {
    return entries
      .map(([key, value]) => `${key}=${formatArgValue(value)}`)
      .join(" ");
  }
  const trimmed = raw.trim();
  return trimmed === "{}" ? "" : trimmed;
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.5 4 5 6.5 7.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 13V3.5M8 3.5 4 7.5M8 3.5l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" fill="currentColor" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="8.5" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 13.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4.2h10M6.4 4.2V2.8h3.2v1.4M4.8 4.2l.7 8.4c.05.6.55 1 1.1 1h2.8c.55 0 1.05-.4 1.1-1l.7-8.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.6" y="2" width="2.4" height="8" rx="1" fill="currentColor" />
      <rect x="7" y="2" width="2.4" height="8" rx="1" fill="currentColor" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3.4 2.4 9.6 6l-6.2 3.6V2.4Z" fill="currentColor" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.2 6.5H9.5V2.8M9.5 6.5l3.7-3.7M2.8 9.5h3.7v3.7M6.5 9.5 2.8 13.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.8 13 3.6v4.2c0 3.1-2.1 5.4-5 6.4-2.9-1-5-3.3-5-6.4V3.6L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="m5.9 7.9 1.5 1.5 2.8-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.4 10.4 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="2.4" width="4" height="7" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.8 8a4.2 4.2 0 0 0 8.4 0M8 12.2v1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10.4 5.6V4.2c0-.9-.7-1.6-1.6-1.6H4.2c-.9 0-1.6.7-1.6 1.6v4.6c0 .9.7 1.6 1.6 1.6h1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface ThreadRow {
  id: string;
  name: string;
  selected: boolean;
  working: boolean;
  title: string;
}

// The transcript keeps itself pinned to the newest entry; `signal` is any
// value that changes when the thread grows.
function Transcript({
  signal,
  children,
}: {
  signal: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [signal]);
  return (
    <div className="transcript" ref={ref}>
      {children}
    </div>
  );
}

function pulseSeed(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function ThreadList({
  rows,
  query,
  searchOpen,
  onSearchChange,
  onToggleSearch,
  onSelect,
}: {
  rows: ThreadRow[];
  query: string;
  searchOpen: boolean;
  onSearchChange: (value: string) => void;
  onToggleSearch: () => void;
  onSelect: (row: ThreadRow) => void;
}) {
  return (
    <section className="panel-threads">
      <div className="panel-threads-head">
        <span className="panel-section-title">Agents</span>
        <button
          className="icon-button icon-mini"
          title="Search agents"
          aria-label="Search agents"
          aria-pressed={searchOpen}
          onClick={onToggleSearch}
        >
          <SearchIcon />
        </button>
      </div>
      {searchOpen && (
        <label className="sidebar-search panel-search">
          <SearchIcon />
          <input
            autoFocus
            value={query}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search agents"
            aria-label="Search agents"
            spellCheck={false}
          />
        </label>
      )}
      <div className="agent-list panel-thread-list">
        {rows.map((row) => (
          <div
            key={row.id}
            role="button"
            tabIndex={0}
            className={`thread-row ${row.selected ? "thread-row-selected" : ""}`}
            title={row.title}
            aria-label={row.name}
            onClick={() => onSelect(row)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(row);
              }
            }}
          >
            <span
              className={`thread-dot${row.working ? " thread-dot-working" : ""}`}
              title={row.working ? "Working" : "Idle"}
              style={
                row.working
                  ? {
                      animationDelay: `-${pulseSeed(row.id) % 700}ms`,
                      animationDuration: `${1000 + (pulseSeed(row.id) % 900)}ms`,
                    }
                  : undefined
              }
            />
            <span className="agent-row-body">
              <span className="agent-row-name">{row.name}</span>
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="sidebar-empty">
            {query
              ? "No agents match your search."
              : "No agents yet — create one to start."}
          </p>
        )}
      </div>
    </section>
  );
}

function formatClearedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ThreadChat({
  daemon,
  bot,
  botName,
  draft,
  onDraftChange,
  onSubmit,
  scrollSignal,
  hasUsableProvider,
  hasProviderNeedingKey,
  onOpenSettings,
  onOpenScreen,
  onOpenApprovals,
  onOpenMemory,
  onOpenAgentSettings,
  messages,
  streaming,
  activity,
  approvals,
  challenges,
  onCancel,
  queuedMessageIds,
}: {
  daemon: ReturnType<typeof useDaemon>;
  bot: Bot | null;
  botName: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  scrollSignal: string;
  hasUsableProvider: boolean;
  hasProviderNeedingKey: boolean;
  onOpenSettings: () => void;
  onOpenScreen: () => void;
  onOpenApprovals: () => void;
  onOpenMemory: () => void;
  onOpenAgentSettings: () => void;
  messages: Message[];
  streaming: StreamingState | null;
  activity: ToolActivity[];
  approvals: PendingApproval[];
  challenges: PendingChallenge[];
  onCancel: () => void;
  queuedMessageIds: string[];
}) {
  const modelValue = daemon.selectedModel
    ? `${daemon.selectedModel.provider}::${daemon.selectedModel.model}`
    : "";
  const pendingApprovalCount = daemon.approvals.filter(
    (approval) => !approval.decision,
  ).length;
  const [clearOpen, setClearOpen] = useState(false);
  const activeThread =
    daemon.threads.find((thread) => thread.id === daemon.activeThreadId) ??
    null;
  // Folded messages only appear when the user asks to see the archive.
  const archivedMessages = messages.filter((message) => message.foldedAt);
  const liveMessages = messages.filter((message) => !message.foldedAt);
  const renderMessages = (list: Message[], live: boolean) =>
    groupTranscript(list, live).map((entry) =>
      entry.kind === "turn" ? (
        <TurnBubble key={entry.final.id} entry={entry} />
      ) : (
        <MessageBubble
          key={entry.message.id}
          message={entry.message}
          queued={queuedMessageIds.includes(entry.message.id)}
          live={entry.live}
        />
      ),
    );

  return (
    <>
        <div className="chat-float-actions" data-tauri-drag-region>
          {daemon.harness.default === "codex" && (
            <span className="harness-pill" title="Codex harness">
              Codex
            </span>
          )}
          {(messages.length > 0 || streaming !== null) && (
            <button
              className="icon-button"
              title="Clear chat"
              aria-label="Clear chat"
              onClick={() => setClearOpen(true)}
            >
              <ClearIcon />
            </button>
          )}
          {bot && (
            <button
              className="icon-button"
              title="Agent settings"
              aria-label="Agent settings"
              onClick={onOpenAgentSettings}
            >
              <GearIcon />
            </button>
          )}
        </div>

        <Transcript signal={scrollSignal}>
          <div className="transcript-inner">
            {messages.length === 0 && !streaming && (
              <div className="empty-state">
                <span
                  className="empty-mark"
                  style={{ background: bot?.color ?? avatarColor(bot?.id ?? "assistant") }}
                />
                <h1>{botName}</h1>
                {hasUsableProvider ? (
                  <p>
                    {isMacOnly(bot)
                      ? "Ask for what you need. This agent runs commands directly on this Mac."
                      : "Ask for what you need. This agent works on its own computer."}
                  </p>
                ) : (
                  <>
                    <p>
                      {hasProviderNeedingKey
                        ? "Add an API key in Settings to start chatting."
                        : "Add a model provider to get started — DeepSeek, OpenAI, OpenRouter, or a local model."}
                    </p>
                    <button
                      className="save-button empty-cta"
                      onClick={() => onOpenSettings()}
                    >
                      {hasProviderNeedingKey ? "Open settings" : "Set up a provider"}
                    </button>
                  </>
                )}
                {activeThread?.clearedAt && (
                  <button
                    className="ghost-button archived-link"
                    onClick={() =>
                      daemon.loadThreadMessages(activeThread.id, true)
                    }
                  >
                    Earlier messages archived · View
                  </button>
                )}
              </div>
            )}

            {renderMessages(archivedMessages, false)}

            {archivedMessages.length > 0 && (
              <div className="cleared-divider">
                <span>
                  Earlier messages archived
                  {activeThread?.clearedAt
                    ? ` · cleared ${formatClearedAt(activeThread.clearedAt)}`
                    : ""}
                </span>
                <button
                  className="ghost-button"
                  onClick={() =>
                    activeThread &&
                    daemon.loadThreadMessages(activeThread.id, false)
                  }
                >
                  Hide
                </button>
              </div>
            )}

            {renderMessages(liveMessages, streaming !== null)}

            {streaming && (
              <LiveAssistant
                streaming={streaming}
                activity={activity}
                approvals={approvals}
                onRespondApproval={daemon.respondToApproval}
              >
                {challenges.map((challenge) => (
                  <ChallengeCard
                    key={challenge.requestId}
                    challenge={challenge}
                    onRespond={daemon.respondToChallenge}
                    onOpenScreen={() => onOpenScreen()}
                  />
                ))}
              </LiveAssistant>
            )}
          </div>
        </Transcript>

        <footer className="composer-wrap">
          <div className="composer">
            <textarea
              value={draft}
              placeholder={`Message ${botName}`}
              rows={1}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
            <div className="composer-bar">
              <div className="composer-bar-start">
                <span
                  className="icon-button icon-muted composer-plus"
                  title="Attachments — coming soon"
                  aria-hidden="true"
                >
                  <PlusIcon />
                </span>
                <div className="composer-model-group">
                <label className="model-pill" title="Model">
                  <select
                    value={modelValue}
                    aria-label="Model"
                    onChange={(event) => {
                      const [provider, model] = event.target.value.split("::");
                      if (provider && model) {
                        daemon.chooseModel({
                          provider,
                          model,
                          ...(daemon.selectedModel?.effort
                            ? { effort: daemon.selectedModel.effort }
                            : {}),
                        });
                      }
                    }}
                  >
                    {daemon.modelOptions.length === 0 && (
                      <option value="">No models configured</option>
                    )}
                    {daemon.modelOptions.map((option) => (
                      <option
                        key={`${option.provider}::${option.model}`}
                        value={`${option.provider}::${option.model}`}
                      >
                        {option.providerLabel} · {option.model}
                      </option>
                    ))}
                  </select>
                  <ChevronIcon />
                </label>
                <label
                  className="model-pill model-pill-effort"
                  title="Reasoning effort — sent to the provider as reasoning_effort"
                >
                  <select
                    value={daemon.selectedModel?.effort ?? ""}
                    aria-label="Reasoning effort"
                    disabled={daemon.selectedModel === null}
                    onChange={(event) => {
                      const effort = event.target.value as ReasoningEffort | "";
                      const current = daemon.selectedModel;
                      if (!current) {
                        return;
                      }
                      daemon.chooseModel({
                        provider: current.provider,
                        model: current.model,
                        ...(effort ? { effort } : {}),
                      });
                    }}
                  >
                    <option value="">Effort: default</option>
                    {EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronIcon />
                </label>
                </div>
              </div>
              <div className="composer-bar-end">
                <div className="composer-tools-actions">
                  <button
                    className="icon-button"
                    title="Approvals"
                    aria-label="Approvals"
                    onClick={() => onOpenApprovals()}
                  >
                    <ShieldIcon />
                    {pendingApprovalCount > 0 && (
                      <span className="icon-badge">{pendingApprovalCount}</span>
                    )}
                  </button>
                  <button
                    className="icon-button"
                    title="Memory and soul"
                    aria-label="Memory and soul"
                    onClick={() => onOpenMemory()}
                  >
                    <MemoryIcon />
                  </button>
                  <span
                    className={`status-dot status-${daemon.status}`}
                    title={STATUS_LABEL[daemon.status]}
                  />
                </div>
                <button
                  className="icon-button icon-muted composer-mic"
                  title="Voice input — coming soon"
                  aria-label="Voice input (coming soon)"
                  disabled
                >
                  <MicIcon />
                </button>
                {streaming ? (
                  <div className="composer-send-group">
                    <button
                      className="send-circle stop"
                      onClick={onCancel}
                      title="Stop"
                    >
                      <StopIcon />
                    </button>
                    <button
                      className="send-circle"
                      onClick={onSubmit}
                      disabled={draft.trim().length === 0}
                      title="Send"
                    >
                      <ArrowUpIcon />
                    </button>
                  </div>
                ) : (
                  <button
                    className="send-circle"
                    onClick={onSubmit}
                    disabled={draft.trim().length === 0}
                    title="Send"
                  >
                    <ArrowUpIcon />
                  </button>
                )}
              </div>
            </div>
          </div>
        </footer>

        <ConfirmDialog
          open={clearOpen}
          title="Clear this chat?"
          description={
            streaming
              ? "The current turn stops. The transcript is archived and stays viewable, memories are kept, and the chat starts fresh."
              : "The transcript is archived and stays viewable, memories are kept, and the chat starts fresh."
          }
          confirmLabel="Clear chat"
          warning="Nothing is deleted — earlier messages stay archived."
          onConfirm={() => {
            setClearOpen(false);
            if (daemon.activeThreadId) {
              daemon.clearThread(daemon.activeThreadId);
            }
          }}
          onClose={() => setClearOpen(false)}
        />
    </>
  );
}


export default function App() {
  const daemon = useDaemon();
  const { theme, setTheme } = useTheme();
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsBotId, setSettingsBotId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState<boolean>(storedPanelOpen);
  const [panelTab, setPanelTab] = useState<PanelTab>("screen");
  const [panelComputer, setPanelComputer] = useState<ComputerKind | null>(null);
  const [screenPlaying, setScreenPlaying] = useState(true);
  const [screenImageUrl, setScreenImageUrl] = useState<string | null>(null);
  const [screenUpdatedAt, setScreenUpdatedAt] = useState<number | null>(null);
  const [screenStatus, setScreenStatus] = useState<ScreenStatus>("loading");
  const [screenVmState, setScreenVmState] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [vncState, setVncState] = useState<VncState>("idle");
  const [windowActive, setWindowActive] = useState(
    () => !document.hidden && document.hasFocus(),
  );

  const bot =
    daemon.bots.find((item) => item.id === daemon.selectedBotId) ?? null;
  const botName = bot?.name ?? "Assistant";
  const screenBot = bot;
  const screenBotName = screenBot?.name ?? "Assistant";
  // The right column is one container for the agent's computers. An agent with
  // both gets a VM/Local switch; This Mac has no captured screen, so its view
  // offers only the terminal and files. This Mac agents get no container at
  // all: their computer is this one, so the user already has their own screen,
  // terminal, and Finder.
  const agentHasVm = hasVm(screenBot);
  const availableComputers: ComputerKind[] = screenBot
    ? botComputers(screenBot)
    : ["firecracker"];
  const activeComputer: ComputerKind =
    panelComputer && availableComputers.includes(panelComputer)
      ? panelComputer
      : screenBot
        ? primaryComputer(screenBot)
        : "firecracker";
  const showScreen = activeComputer === "firecracker";
  const panelTabs = showScreen ? PANEL_TABS : LOCAL_PANEL_TABS;
  // Switching to a computer without a screen tab falls back to its first tab
  // without losing the other computer's last tab.
  const activeTab: PanelTab = panelTabs.some((tab) => tab.id === panelTab)
    ? panelTab
    : (panelTabs[0]?.id ?? "terminal");
  const panelComputerLabel = activeComputer === "firecracker" ? "VM" : "Local";
  // The Files tab on This Mac starts at the agent's access root, so the crumb
  // names the folder the user granted instead of a bare "Workspace".
  const filesWorkspace = screenBot?.workspaceId
    ? (daemon.workspaces.find(
        (workspace) => workspace.id === screenBot.workspaceId,
      ) ?? null)
    : null;
  const filesRootLabel =
    activeComputer !== "mac"
      ? undefined
      : (screenBot?.access ?? "project") === "home"
        ? "Home"
        : (screenBot?.access ?? "project") === "full"
          ? "Filesystem"
          : filesWorkspace?.name;
  const hasUsableProvider = daemon.providers.some(isProviderUsable);
  const hasProviderNeedingKey = daemon.providers.some(
    (provider) =>
      provider.enabled &&
      provider.models.length > 0 &&
      !provider.hasApiKey &&
      provider.apiKeyEnv !== null,
  );
  const screenMessage = (() => {
    if (!screenBot) {
      return "No agent selected";
    }
    if (!hasVm(screenBot)) {
      return "Screen view is available for Firecracker microVM computers.";
    }
    if (screenStatus === "vm-off") {
      if (screenVmState === "booting") {
        return "Agent's VM is starting…";
      }
      if (screenVmState === "error") {
        return "Agent's VM failed to start";
      }
      return "Agent's VM is not running";
    }
    if (screenStatus === "error" && screenError) {
      return screenError;
    }
    return "No screen yet";
  })();
  const vncUrl = screenBot
    ? `${DAEMON_HTTP_URL.replace(/^http/, "ws")}/bots/${encodeURIComponent(screenBot.id)}/vnc`
    : "";
  const terminalUrl = (computer: ComputerKind) =>
    screenBot
      ? `${DAEMON_HTTP_URL.replace(/^http/, "ws")}/bots/${encodeURIComponent(screenBot.id)}/terminal?computer=${computer}`
      : "";
  const canStream = Boolean(screenBot) && agentHasVm;
  const canConnectTerminal = Boolean(screenBot);
  const vncLive = vncState === "live";
  const vncActive =
    canStream &&
    showScreen &&
    screenPlaying &&
    panelOpen &&
    activeTab === "screen" &&
    screenStatus !== "vm-off";

  const togglePanel = () => {
    setPanelOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(PANEL_OPEN_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const openScreenTab = () => {
    setPanelOpen(true);
    setPanelComputer("firecracker");
    setPanelTab("screen");
    try {
      localStorage.setItem(PANEL_OPEN_KEY, "1");
    } catch {}
  };

  const screenCaption = (() => {
    if (!screenBot) {
      return "No agent selected";
    }
    if (!hasVm(screenBot)) {
      return "Screen view is available for Firecracker microVM computers.";
    }
    if (!screenPlaying) {
      return "Paused";
    }
    if (vncLive) {
      return "Live desktop";
    }
    if (vncState === "connecting") {
      return "Connecting to desktop…";
    }
    if (vncState === "down" && screenStatus !== "vm-off") {
      return "Desktop stream unavailable — retrying";
    }
    if (screenStatus === "live" && screenUpdatedAt) {
      return `Updated ${new Date(screenUpdatedAt).toLocaleTimeString()}`;
    }
    return screenMessage;
  })();

  useEffect(() => {
    const syncActivity = () => {
      setWindowActive(!document.hidden && document.hasFocus());
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

  const activeThreadId = daemon.activeThreadId;
  const activity = useMemo(
    () =>
      daemon.toolActivity.filter(
        (item) => item.threadId === activeThreadId,
      ),
    [daemon.toolActivity, activeThreadId],
  );
  const approvals = useMemo(
    () => daemon.approvals.filter((item) => item.threadId === activeThreadId),
    [daemon.approvals, activeThreadId],
  );
  const challenges = useMemo(
    () => daemon.challenges.filter((item) => item.threadId === activeThreadId),
    [daemon.challenges, activeThreadId],
  );
  const streaming =
    daemon.streaming && daemon.streaming.threadId === activeThreadId
      ? daemon.streaming
      : null;

  const threadByBot = useMemo(() => {
    const map = new Map<string, Thread>();
    for (const thread of daemon.threads) {
      if (!map.has(thread.botId)) {
        map.set(thread.botId, thread);
      }
    }
    return map;
  }, [daemon.threads]);

  const settingsThread = settingsBotId
    ? (threadByBot.get(settingsBotId) ?? null)
    : null;
  const settingsStreaming =
    settingsThread !== null &&
    daemon.streamingByThread[settingsThread.id] !== undefined;

  const pendingApprovalCount = daemon.approvals.filter(
    (approval) => !approval.decision,
  ).length;

  // The thread rail is a flat list of agents: each agent is its own thread.
  const threadRows: ThreadRow[] = (() => {
    const q = search.trim().toLowerCase();
    const matches = (...parts: Array<string | null | undefined>) =>
      !q || parts.some((part) => (part ?? "").toLowerCase().includes(q));
    return daemon.bots
      .filter((bot) => matches(bot.name, bot.role))
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        selected: bot.id === daemon.selectedBotId,
        working: daemon.streamingByThread[threadByBot.get(bot.id)?.id ?? ""] !== undefined,
        title: bot.role ?? bot.name,
      }));
  })();

  const openThread = (row: ThreadRow) => {
    daemon.selectBot(row.id);
  };

  useEffect(() => {
    setScreenImageUrl(null);
    setScreenUpdatedAt(null);
    setScreenVmState(null);
    setScreenError(null);
    setScreenStatus("loading");
    setVncState("idle");
  }, [screenBot?.id]);

  useEffect(() => {
    return () => {
      if (screenImageUrl) {
        URL.revokeObjectURL(screenImageUrl);
      }
    };
  }, [screenImageUrl]);

  useEffect(() => {
    if (
      !panelOpen ||
      activeTab !== "screen" ||
      !agentHasVm ||
      !screenPlaying ||
      !windowActive ||
      !screenBot ||
      vncLive
    ) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const load = async (): Promise<boolean> => {
      if (inFlight || document.hidden) {
        return false;
      }
      inFlight = true;
      try {
        const response = await fetch(
          `${DAEMON_HTTP_URL}/bots/${encodeURIComponent(screenBot.id)}/screen?t=${Date.now()}`,
          { signal: controller.signal },
        );
        if (cancelled) {
          return false;
        }
        if (response.ok) {
          const blob = await response.blob();
          const capturedAt = response.headers.get("x-screen-captured-at");
          if (cancelled) {
            return false;
          }
          setScreenImageUrl(URL.createObjectURL(blob));
          setScreenUpdatedAt(capturedAt ? Date.parse(capturedAt) : Date.now());
          setScreenVmState("running");
          setScreenError(null);
          setScreenStatus("live");
          return false;
        }
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          state?: string;
        } | null;
        if (cancelled) {
          return false;
        }
        setScreenVmState(body?.state ?? null);
        setScreenError(body?.error ?? `screen request failed (${response.status})`);
        setScreenStatus(response.status === 409 ? "vm-off" : "error");
        return response.status === 409;
      } catch (error) {
        if (!cancelled && (error as Error).name !== "AbortError") {
          setScreenError((error as Error).message);
          setScreenStatus("error");
        }
        return false;
      } finally {
        inFlight = false;
      }
    };

    // Poll fast while the VM is up, and back off while it is stopped so the
    // panel does not hammer the daemon with 409s.
    const loop = async () => {
      const vmOff = await load();
      if (cancelled) {
        return;
      }
      timer = setTimeout(loop, vmOff ? SCREEN_OFF_POLL_MS : SCREEN_POLL_MS);
    };
    void loop();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [
    panelOpen,
    activeTab,
    agentHasVm,
    screenPlaying,
    windowActive,
    screenBot,
    vncLive,
  ]);

  const scrollSignal = [
    daemon.messages.length,
    activity.length,
    approvals.length,
    streaming?.text.length ?? 0,
  ].join(":");
  const submit = () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    daemon.sendMessage(
      text,
      streaming ? daemon.chatBusyBehavior : undefined,
    );
    setDraft("");
  };

  const screenPane = (
    <section className="screen-view">
      <div className="screen-frame">
        {canStream && (
          <VncView
            url={vncUrl}
            active={vncActive}
            interactive={panelOpen && activeTab === "screen"}
            onState={setVncState}
          />
        )}
        {!vncLive && (
          <div className="screen-fallback">
            {hasVm(screenBot) &&
            screenStatus !== "vm-off" &&
            screenImageUrl ? (
              <img
                className="screen-image"
                src={screenImageUrl}
                alt={`${screenBotName}'s screen`}
              />
            ) : (
              <div className="screen-empty">
                <MonitorIcon />
                <span>
                  {vncState === "down" && screenStatus !== "vm-off"
                    ? "Desktop stream unavailable — retrying"
                    : screenMessage}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );

  return (
    <div className="shell">
      <div className="rail-column">
        <aside className="thread-rail">
          <ThreadList
            rows={threadRows}
            query={search}
            searchOpen={searchOpen}
            onSearchChange={setSearch}
            onToggleSearch={() =>
              setSearchOpen((value) => {
                if (value) {
                  setSearch("");
                }
                return !value;
              })
            }
            onSelect={openThread}
          />
        </aside>
        <button
          className="shell-settings"
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <GearIcon />
        </button>
      </div>

      <main className="chat">
        <header className="agent-badge">
          <span
            className="agent-badge-avatar"
            style={{
              background:
                bot?.color ?? avatarColor(bot?.id ?? "assistant"),
            }}
          />
          <span className="agent-badge-name">{botName}</span>
        </header>

        <ThreadChat
          daemon={daemon}
          bot={bot}
          botName={botName}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          scrollSignal={scrollSignal}
          hasUsableProvider={hasUsableProvider}
          hasProviderNeedingKey={hasProviderNeedingKey}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenScreen={openScreenTab}
          onOpenApprovals={() => setApprovalsOpen(true)}
          onOpenMemory={() => setMemoryOpen(true)}
          onOpenAgentSettings={() => {
            if (bot) {
              setSettingsBotId(bot.id);
            }
          }}
          messages={daemon.messages}
          streaming={streaming}
          activity={activity}
          approvals={approvals}
          challenges={challenges}
          onCancel={daemon.cancel}
          queuedMessageIds={daemon.queuedMessageIds}
        />
      </main>

      {agentHasVm && (
        <aside
          className={`panel-column${panelOpen ? "" : " panel-column-empty"}`}
        >
          <header className="panel-column-bar" data-tauri-drag-region>
            {panelOpen && availableComputers.length > 1 && (
              <div className="computer-tabs" role="tablist">
                {availableComputers.map((computer) => (
                  <button
                    key={computer}
                    role="tab"
                    aria-selected={computer === activeComputer}
                    className={`computer-tab${
                      computer === activeComputer ? " computer-tab-active" : ""
                    }`}
                    onClick={() => setPanelComputer(computer)}
                  >
                    {computer === "firecracker" ? "VM" : "Local"}
                  </button>
                ))}
              </div>
            )}
            <div className="panel-column-actions">
              {panelOpen ? (
                <button
                  className="icon-button"
                  title={`Collapse the ${panelComputerLabel} panels`}
                  aria-label={`Collapse the ${panelComputerLabel} panels`}
                  onClick={togglePanel}
                >
                  <CollapseIcon />
                </button>
              ) : (
                <button
                  className="panel-column-open"
                  title={`Show the ${panelComputerLabel} panels`}
                  aria-expanded={false}
                  onClick={togglePanel}
                >
                  {panelComputerLabel}
                </button>
              )}
            </div>
          </header>

          {panelOpen && (
            <>
              <section className="panel-window">
                <div className="panel-tabs" role="tablist">
                  {panelTabs.map((entry) => (
                    <button
                      key={entry.id}
                      role="tab"
                      aria-selected={activeTab === entry.id}
                      className={`panel-tab${
                        activeTab === entry.id ? " panel-tab-active" : ""
                      }`}
                      onClick={() => setPanelTab(entry.id)}
                    >
                      {entry.label}
                    </button>
                  ))}
                  {activeTab === "screen" && (
                    <span className="panel-tabs-actions">
                      <button
                        className="icon-button"
                        title={
                          screenPlaying ? "Pause live view" : "Resume live view"
                        }
                        aria-label={
                          screenPlaying ? "Pause live view" : "Resume live view"
                        }
                        onClick={() => setScreenPlaying((value) => !value)}
                      >
                        {screenPlaying ? <PauseIcon /> : <PlayIcon />}
                      </button>
                      <span className="screen-caption">
                        <span className="screen-caption-status">
                          {screenCaption}
                        </span>
                      </span>
                    </span>
                  )}
                </div>
                <div className="panel-section-body">
                  {showScreen && (
                    <div
                      className="panel-tab-pane"
                      hidden={activeTab !== "screen"}
                    >
                      {screenPane}
                    </div>
                  )}
                  {availableComputers.map((computer) => (
                    <div
                      key={computer}
                      className="panel-tab-pane"
                      hidden={
                        activeTab !== "terminal" || activeComputer !== computer
                      }
                    >
                      {screenBot && (
                        <TerminalPanel
                          botId={screenBot.id}
                          canConnect={canConnectTerminal}
                          url={terminalUrl(computer)}
                          active={
                            activeTab === "terminal" &&
                            activeComputer === computer
                          }
                        />
                      )}
                    </div>
                  ))}
                  <div className="panel-tab-pane" hidden={activeTab !== "files"}>
                    {screenBot && (
                      <FilesPanel
                        botId={screenBot.id}
                        computer={activeComputer}
                        {...(filesRootLabel
                          ? { rootLabel: filesRootLabel }
                          : {})}
                        active={activeTab === "files"}
                        listFiles={daemon.listFiles}
                        readFile={daemon.readFile}
                      />
                    )}
                  </div>
                </div>
              </section>

              <section className="routines">
                <h2>
                  Routines
                  <span className="badge">Soon</span>
                </h2>
                <div className="routines-empty">
                  <p className="routines-title">Not implemented yet</p>
                  <p className="routines-sub">
                    Scheduled and replayable routines are planned, not wired up.
                  </p>
                </div>
              </section>
            </>
          )}
        </aside>
      )}

      <ApprovalsModal
        open={approvalsOpen}
        onClose={() => setApprovalsOpen(false)}
        records={daemon.approvalRecords}
        pendingCount={pendingApprovalCount}
        policy={daemon.policy}
        requireApproval={daemon.requireApproval}
        onLoad={() => daemon.loadApprovals()}
        onRespond={daemon.respondToApproval}
        onSavePolicy={({ requireApproval, policy }) =>
          daemon.updateSettings({ requireApproval, policy })
        }
        onApplyPreset={(preset) => daemon.updateSettings({ policyPreset: preset })}
      />

      <MemoryModal
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        memories={daemon.memories}
        soul={daemon.soul}
        soulVersions={daemon.soulVersions}
        lastConsolidation={daemon.lastConsolidation}
        onLoad={() => daemon.loadMemories()}
        onRemove={daemon.removeMemory}
        onConsolidate={daemon.consolidateMemories}
        onLoadSoul={() => daemon.loadSoul()}
        onRevertSoul={daemon.revertSoul}
      />

      {daemon.error && (
        <div className="toast" role="alert">
          <span>{daemon.error}</span>
          <button onClick={daemon.clearError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <CreateAgentModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        modelOptions={daemon.modelOptions}
        selectedModel={daemon.selectedModel}
        workspaces={daemon.workspaces}
        onCreate={daemon.createBot}
      />

      <AgentSettingsModal
        bot={
          settingsBotId
            ? (daemon.bots.find((item) => item.id === settingsBotId) ?? null)
            : null
        }
        sandboxState={
          settingsBotId ? (daemon.sandboxStates[settingsBotId] ?? "stopped") : "stopped"
        }
        streaming={settingsStreaming}
        workspaces={daemon.workspaces}
        onClose={() => setSettingsBotId(null)}
        onSave={(patch) => {
          if (settingsBotId) {
            daemon.updateBot(settingsBotId, patch);
            if (patch.computers.includes("firecracker")) {
              daemon.refreshSandboxState(settingsBotId);
            }
          }
          setSettingsBotId(null);
        }}
        onPower={(on) => {
          if (settingsBotId) {
            daemon.powerBot(settingsBotId, on);
          }
        }}
        onReset={() => {
          if (settingsBotId) {
            daemon.resetBot(settingsBotId);
          }
          setSettingsBotId(null);
        }}
        onDelete={() => {
          if (settingsBotId) {
            daemon.deleteBot(settingsBotId);
          }
          setSettingsBotId(null);
        }}
      />

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        daemonStatus={daemon.status}
        providers={daemon.providers}
        presets={daemon.presets}
        modelOptions={daemon.modelOptions}
        defaultModel={daemon.defaultModel}
        requireApproval={daemon.requireApproval}
        harness={daemon.harness}
        decision={daemon.decision}
        codex={daemon.codex}
        chatBusyBehavior={daemon.chatBusyBehavior}
        theme={theme}
        onThemeChange={setTheme}
        onSaveProvider={daemon.saveProvider}
        onRemoveProvider={daemon.removeProvider}
        onUpdateSettings={daemon.updateSettings}
        onFetchModels={daemon.fetchModels}
        onTestDecision={daemon.testDecision}
        bots={daemon.bots}
        workspaces={daemon.workspaces}
        workspaceRoots={daemon.workspaceRoots}
        onScanWorkspaces={daemon.scanWorkspaces}
        onAddWorkspace={daemon.addWorkspace}
        onUpdateWorkspace={daemon.updateWorkspace}
        onRemoveWorkspace={daemon.removeWorkspace}
        onSaveWorkspaceRoots={daemon.saveWorkspaceRoots}
        accessReport={daemon.accessReport}
        onCheckAccess={daemon.checkAccess}
        onOpenAccessPane={daemon.openAccessPane}
      />
    </div>
  );
}

interface AggregatedFileChange {
  path: string;
  additions: number;
  deletions: number;
  diff: string | null;
}

// One card per turn: every file the turn's tool calls changed, in first-seen
// order, with the stats summed when a file was edited more than once.
function collectFileChanges(messages: Message[]): AggregatedFileChange[] {
  const byPath = new Map<string, AggregatedFileChange>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      for (const change of call.changes ?? []) {
        const existing = byPath.get(change.path);
        if (existing) {
          existing.additions += change.additions;
          existing.deletions += change.deletions;
          if (change.diff) {
            existing.diff = existing.diff
              ? `${existing.diff}\n\n${change.diff}`
              : change.diff;
          }
        } else {
          byPath.set(change.path, {
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
            diff: change.diff ?? null,
          });
        }
      }
    }
  }
  return [...byPath.values()];
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) {
    return "diff-line-hunk";
  }
  if (line.startsWith("+")) {
    return "diff-line-add";
  }
  if (line.startsWith("-")) {
    return "diff-line-del";
  }
  if (line.startsWith("[diff truncated")) {
    return "diff-line-note";
  }
  return "";
}

function ChangedFilesCard({ changes }: { changes: AggregatedFileChange[] }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  if (changes.length === 0) {
    return null;
  }
  const additions = changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);

  return (
    <div className="changed-files">
      <div className="changed-files-head">
        <span className="changed-files-title">
          {changes.length} Changed file{changes.length === 1 ? "" : "s"}
        </span>
        <span className="changed-files-stat changed-files-add">
          +{additions}
        </span>
        <span className="changed-files-stat changed-files-del">
          −{deletions}
        </span>
      </div>
      <div className="changed-files-list">
        {changes.map((change) => {
          const open = openPath === change.path;
          const hasDiff = Boolean(change.diff);
          const row = (
            <>
              <span className="changed-files-path" title={change.path}>
                {change.path}
              </span>
              <span className="changed-files-stat changed-files-add">
                +{change.additions}
              </span>
              <span className="changed-files-stat changed-files-del">
                −{change.deletions}
              </span>
              {hasDiff && (
                <span
                  className={`changed-files-chevron${open ? " open" : ""}`}
                >
                  <ChevronIcon />
                </span>
              )}
            </>
          );
          return (
            <div className="changed-files-item" key={change.path}>
              {hasDiff ? (
                <button
                  type="button"
                  className="changed-files-row"
                  aria-expanded={open}
                  aria-label={open ? "Hide diff" : "Show diff"}
                  onClick={() => setOpenPath(open ? null : change.path)}
                >
                  {row}
                </button>
              ) : (
                <div className="changed-files-row changed-files-static">
                  {row}
                </div>
              )}
              {open && change.diff && (
                <pre className="changed-files-diff">
                  {change.diff.split("\n").map((line, index) => (
                    <span key={index} className={diffLineClass(line)}>
                      {line}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  queued,
  live,
}: {
  message: Message;
  queued?: boolean;
  live?: boolean;
}) {
  const calls = message.toolCalls ?? [];

  if (message.id.startsWith("error-")) {
    return (
      <div className="entry entry-assistant">
        <div className="entry-body entry-error">{message.content}</div>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="entry entry-user">
        <div className="entry-user-row">
          <div className="entry-body">{message.content}</div>
          {queued && <span className="queued-badge">Queued</span>}
          <button
            className="bubble-action"
            title="Copy message"
            aria-label="Copy message"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(message.content)
                .catch(() => undefined);
            }}
          >
            <CopyIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="entry entry-assistant">
      {calls.length > 0 && (
        <WorkGroup
          items={calls.map((call: ToolCallRecord) => ({
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            status: "done" as const,
            ok: call.ok,
            output: call.output,
            durationMs: call.durationMs,
            artifacts: call.artifacts,
          }))}
          running={false}
        />
      )}
      {message.content && (
        <div className="entry-body">
          <Markdown text={message.content} />
        </div>
      )}
      {!live && !message.compaction && (
        <ChangedFilesCard changes={collectFileChanges([message])} />
      )}
    </div>
  );
}

type TranscriptEntry =
  | { kind: "single"; message: Message; live?: boolean }
  | { kind: "turn"; work: Message[]; final: Message };

function isWorkMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    !message.id.startsWith("error-") &&
    !message.compaction
  );
}

// A turn is one user request: its step messages and tool calls collapse under
// a single work group once the final answer arrives. While the turn is still
// streaming, its steps render individually so progress stays visible.
function groupTranscript(messages: Message[], live: boolean): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let work: Message[] = [];

  const flush = (trailing: boolean) => {
    if (work.length === 0) {
      return;
    }
    if (work.length === 1 || (trailing && live)) {
      for (const message of work) {
        // Only the in-flight turn's steps are live; completed singles above
        // keep their changed-files cards.
        entries.push({ kind: "single", message, live: trailing && live });
      }
    } else {
      entries.push({
        kind: "turn",
        work: work.slice(0, -1),
        final: work[work.length - 1]!,
      });
    }
    work = [];
  };

  for (const message of messages) {
    if (isWorkMessage(message)) {
      work.push(message);
      continue;
    }
    flush(false);
    entries.push({ kind: "single", message });
  }
  flush(true);
  return entries;
}

function TurnBubble({
  entry,
}: {
  entry: { work: Message[]; final: Message };
}) {
  const items: WorkItem[] = entry.work.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => ({
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
      status: "done" as const,
      ok: call.ok,
      output: call.output,
      durationMs: call.durationMs,
      artifacts: call.artifacts,
      at: Date.parse(message.createdAt),
    })),
  );
  const narration: NarrationItem[] = entry.work
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      id: message.id,
      text: message.content,
      at: Date.parse(message.createdAt),
    }));

  return (
    <div className="entry entry-assistant">
      <WorkGroup
        items={items}
        narration={narration}
        running={false}
      />
      {entry.final.content && (
        <div className="entry-body">
          <Markdown text={entry.final.content} />
        </div>
      )}
      <ChangedFilesCard
        changes={collectFileChanges([...entry.work, entry.final])}
      />
    </div>
  );
}

interface WorkItem {
  callId: string;
  name: string;
  arguments: string;
  status: "running" | "done";
  ok: boolean | null;
  output: string | null;
  durationMs: number | null;
  artifacts: ToolArtifact[] | null;
  at?: number;
}

interface NarrationItem {
  id: string;
  text: string;
  at: number;
}

type WorkRow =
  | { type: "tool"; at: number; item: WorkItem }
  | { type: "narration"; at: number; narration: NarrationItem }
  | { type: "reads"; at: number; items: WorkItem[] };

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function WorkGroup({
  items,
  narration,
  reasoning,
  startedAt,
  running,
  approvals,
  onRespondApproval,
}: {
  items: WorkItem[];
  narration?: NarrationItem[];
  reasoning?: string;
  startedAt?: number;
  running: boolean;
  approvals?: PendingApproval[];
  onRespondApproval?: (requestId: string, decision: "approve" | "deny", remember?: boolean) => void;
}) {
  const pending = (approvals ?? []).filter((approval) => !approval.decision);
  // Collapsed by default, live or finished; the user opens it, or an
  // approval forces it open.
  const [open, setOpen] = useState(pending.length > 0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (pending.length > 0) {
      setOpen(true);
    }
  }, [pending.length]);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed =
    running && startedAt !== undefined ? Math.max(0, now - startedAt) : 0;
  const failed = items.filter((item) => item.ok === false).length;
  const approvalByCall = new Map(
    (approvals ?? []).map((approval) => [approval.callId, approval]),
  );
  const trailingApprovals = (approvals ?? []).filter(
    (approval) => !items.some((item) => item.callId === approval.callId),
  );
  const seenCalls = new Set<string>();
  const uniqueItems = items.filter((item) => {
    if (seenCalls.has(item.callId)) {
      return false;
    }
    seenCalls.add(item.callId);
    return true;
  });
  const timeline = [
    ...uniqueItems.map((item) => ({
      type: "tool" as const,
      at: item.at ?? 0,
      item,
    })),
    ...(narration ?? []).map((entry) => ({
      type: "narration" as const,
      at: entry.at,
      narration: entry,
    })),
  ].sort((a, b) => a.at - b.at);

  // Consecutive reads collapse into one "Explored N reads" row, the way the
  // agent harness prints them; expanding reveals each file and its output.
  const rows: WorkRow[] = [];
  for (const entry of timeline) {
    const last = rows[rows.length - 1];
    if (
      entry.type === "tool" &&
      entry.item.name === "read_file" &&
      !approvalByCall.has(entry.item.callId)
    ) {
      if (last?.type === "reads") {
        last.items.push(entry.item);
        continue;
      }
      rows.push({ type: "reads", at: entry.at, items: [entry.item] });
      continue;
    }
    rows.push(entry);
  }

  const statusContent = (
    <>
      {running ? (
        <span className="work-group-label">
          Working
          <span className="work-group-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </span>
      ) : (
        <span className="work-group-label">Worked</span>
      )}
      <span className="work-group-meta">
        {items.length > 0 &&
          `${items.length} action${items.length === 1 ? "" : "s"}`}
        {items.length > 0 && failed > 0 && (
          <span className="work-group-failed"> · {failed} failed</span>
        )}
        {running && elapsed > 0 && ` · ${formatElapsed(elapsed)}`}
        {pending.length > 0 && (
          <span className="work-group-approval"> · Approval needed</span>
        )}
      </span>
    </>
  );

  const body = (
    <div className="work-group-body">
      {reasoning && reasoning.trim().length > 0 && (
        <details className="work-thinking">
          <summary>
            <span className="work-thinking-label">Thinking</span>
          </summary>
          <pre>{reasoning.trim()}</pre>
        </details>
      )}
      {rows.map((entry) => {
        if (entry.type === "narration") {
          return (
            <div key={entry.narration.id} className="work-narration">
              <Markdown text={entry.narration.text} />
            </div>
          );
        }
        if (entry.type === "reads") {
          return (
            <ReadsRow key={entry.items[0]!.callId} items={entry.items} />
          );
        }
        const item = entry.item;
        const approval = approvalByCall.get(item.callId);
        return (
          <div key={item.callId} className="work-step">
            {approval && onRespondApproval && (
              <ApprovalCard
                approval={approval}
                onRespond={onRespondApproval}
              />
            )}
            <ToolRow
              name={item.name}
              arguments={item.arguments}
              status={item.status}
              ok={item.ok}
              output={item.output}
              durationMs={item.durationMs}
              artifacts={item.artifacts}
              at={item.at}
            />
          </div>
        );
      })}
      {trailingApprovals.map((approval) =>
        onRespondApproval ? (
          <ApprovalCard
            key={approval.requestId}
            approval={approval}
            onRespond={onRespondApproval}
          />
        ) : null,
      )}
    </div>
  );

  return (
    <div className="work-group">
      <button
        type="button"
        className="work-group-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`work-group-chevron ${open ? "open" : ""}`}>
          <ChevronIcon />
        </span>
        {statusContent}
      </button>
      {open && body}
    </div>
  );
}

function ToolRow({
  name,
  arguments: rawArguments,
  status,
  ok,
  output,
  durationMs,
  artifacts,
  at,
}: {
  name: string;
  arguments: string;
  status: "running" | "done";
  ok: boolean | null;
  output: string | null;
  durationMs: number | null;
  artifacts: ToolArtifact[] | null;
  at?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const outputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (status !== "running") {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (status === "running" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, status]);

  const label = toolLabel(name);
  const detail = toolDetail(rawArguments);
  const local = output?.startsWith("[local Mac]") ?? false;
  const failed = status === "done" && ok === false;
  const runningFor =
    status === "running" && at !== undefined ? Math.max(0, now - at) : null;
  const hasBody = Boolean(output) || (artifacts?.length ?? 0) > 0;
  const imageCount = artifacts?.length ?? 0;

  return (
    <div className="tool-row">
      <div className="tool-row-head">
        <span className="tool-row-label">
          {label.text}
          {label.code && <code className="tool-row-name">{label.code}</code>}
        </span>
        {detail && (
          <span className="tool-row-detail" title={detail}>
            {detail}
          </span>
        )}
        {local && <span className="tool-row-local">this Mac</span>}
        {status === "running" ? (
          <span className="tool-row-meta tool-row-running">
            <span className="tool-row-dot" />
            {runningFor !== null ? formatElapsed(runningFor) : "Running"}
          </span>
        ) : failed ? (
          <span className="tool-row-meta tool-row-failed">
            Failed
            {durationMs !== null ? ` · ${durationMs} ms` : ""}
          </span>
        ) : null}
        {!open && imageCount > 0 && (
          <span className="tool-row-meta">
            {imageCount} image{imageCount === 1 ? "" : "s"}
          </span>
        )}
        {hasBody && (
          <button
            type="button"
            className={`tool-row-toggle${open ? " open" : ""}`}
            aria-expanded={open}
            aria-label={open ? "Hide output" : "Show output"}
            title={open ? "Hide output" : "Show output"}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronIcon />
          </button>
        )}
      </div>
      {open && (
        <div className="tool-row-body">
          {artifacts?.map((artifact) => (
            <img
              key={artifact.url}
              className="tool-row-image"
              src={`${DAEMON_HTTP_URL}${artifact.url}`}
              alt="Screenshot from the bot's computer"
            />
          ))}
          {output && <pre ref={outputRef}>{output}</pre>}
        </div>
      )}
    </div>
  );
}

function ReadsRow({ items }: { items: WorkItem[] }) {
  const [open, setOpen] = useState(false);
  const running = items.some((item) => item.status === "running");
  const failed = items.filter((item) => item.ok === false).length;

  return (
    <div className="tool-row">
      <div className="tool-row-head">
        <span className="tool-row-label">Explored</span>
        <span className="tool-row-meta">
          {items.length} read{items.length === 1 ? "" : "s"}
          {failed > 0 && (
            <span className="tool-row-failed"> · {failed} failed</span>
          )}
        </span>
        {running && (
          <span className="tool-row-meta tool-row-running">
            <span className="tool-row-dot" />
          </span>
        )}
        <button
          type="button"
          className={`tool-row-toggle${open ? " open" : ""}`}
          aria-expanded={open}
          aria-label={open ? "Hide reads" : "Show reads"}
          title={open ? "Hide reads" : "Show reads"}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronIcon />
        </button>
      </div>
      {open && (
        <div className="tool-row-body reads-body">
          {items.map((item) => (
            <ToolRow
              key={item.callId}
              name={item.name}
              arguments={item.arguments}
              status={item.status}
              ok={item.ok}
              output={item.output}
              durationMs={item.durationMs}
              artifacts={item.artifacts}
              at={item.at}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (requestId: string, decision: "approve" | "deny", remember?: boolean) => void;
}) {
  const detail = toolDetail(approval.arguments);

  if (approval.decision) {
    return (
      <div className="approval-card approval-resolved">
        <div className="approval-title">
          {approval.decision === "approve" ? "Approved" : "Denied"}
        </div>
        <pre className="tool-command">{detail}</pre>
      </div>
    );
  }

  return (
    <div className="approval-card">
      <div className="approval-title">Approval needed</div>
      <div className="approval-sub">
        {approval.reason
          ? approval.reason
          : "The bot wants to run this on its computer:"}
      </div>
      <pre className="tool-command">{detail}</pre>
      <div className="approval-actions">
        <button
          className="approve-button"
          onClick={() => onRespond(approval.requestId, "approve")}
        >
          Approve
        </button>
        <button
          className="remember-button"
          title={`Approve and stop asking for ${approval.name} (adds a policy rule; deny rules still win)`}
          onClick={() => onRespond(approval.requestId, "approve", true)}
        >
          Always allow
        </button>
        <button
          className="deny-button"
          onClick={() => onRespond(approval.requestId, "deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function challengeHost(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function ChallengeCard({
  challenge,
  onRespond,
  onOpenScreen,
}: {
  challenge: PendingChallenge;
  onRespond: (requestId: string, action: "retry" | "skip") => void;
  onOpenScreen?: () => void;
}) {
  const host = challengeHost(challenge.url);

  if (challenge.action) {
    return (
      <div className="challenge-card challenge-resolved">
        <div className="challenge-title">
          {challenge.action === "retry" ? "Retrying" : "Skipped"}
        </div>
        {host && <div className="challenge-sub">{host}</div>}
      </div>
    );
  }

  return (
    <div className="challenge-card">
      <div className="challenge-title">Bot check</div>
      <div className="challenge-sub">
        {host
          ? `${host} is showing a bot check.`
          : "The site is showing a bot check."}{" "}
        Open the Screen panel, solve it there, then retry — the browser keeps
        the clearance.
      </div>
      <div className="challenge-actions">
        {onOpenScreen && (
          <button className="challenge-screen-button" onClick={onOpenScreen}>
            Open Screen
          </button>
        )}
        <button
          className="approve-button"
          onClick={() => onRespond(challenge.requestId, "retry")}
        >
          Retry
        </button>
        <button
          className="deny-button"
          onClick={() => onRespond(challenge.requestId, "skip")}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function StreamingRow({ streaming }: { streaming: StreamingState }) {
  if (!streaming.text) {
    return null;
  }

  return (
    <div className="entry-body">
      <Markdown text={streaming.text} />
      <span className="caret" />
    </div>
  );
}

// A live turn. A turn with no work signal yet stays a plain loading bubble —
// three dots, then the streamed answer — so no work-shaped chrome flashes
// before a reply. Real work shows the collapsed working group with the
// streamed answer below it.
function LiveAssistant({
  streaming,
  activity,
  approvals,
  onRespondApproval,
  children,
}: {
  streaming: StreamingState;
  activity: ToolActivity[];
  approvals: PendingApproval[];
  onRespondApproval: (requestId: string, decision: "approve" | "deny", remember?: boolean) => void;
  children?: ReactNode;
}) {
  if (streaming.mode !== "work") {
    return (
      <div className="entry entry-assistant">
        {children}
        {streaming.text ? (
          <StreamingRow streaming={streaming} />
        ) : (
          <div
            className="typing-dots"
            role="status"
            aria-label="Composing a reply"
          >
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="entry entry-assistant">
      {children}
      <WorkGroup
        items={activity}
        reasoning={streaming.reasoning}
        startedAt={streaming.startedAt}
        running
        approvals={approvals}
        onRespondApproval={onRespondApproval}
      />
      <StreamingRow streaming={streaming} />
    </div>
  );
}

function CreateAgentModal({
  open,
  onClose,
  modelOptions,
  selectedModel,
  workspaces,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  modelOptions: ModelOption[];
  selectedModel: ModelRef | null;
  workspaces: Workspace[];
  onCreate: (input: CreateBotInput) => Promise<Bot>;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [color, setColor] = useState(AVATAR_COLORS[0]!);
  const [modelValue, setModelValue] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [computer, setComputer] = useState<ComputerKind[]>(["firecracker"]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [access, setAccess] = useState<AccessMode>("project");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName("");
    setRole("");
    setColor(AVATAR_COLORS[0]!);
    setComputer(["firecracker"]);
    setWorkspaceId("");
    setAccess("project");
    setCreating(false);
    setError(null);
    const preferred = selectedModel ?? null;
    const fallback = modelOptions[0] ?? null;
    const initial = preferred ?? fallback;
    setModelValue(
      initial ? `${initial.provider}::${initial.model}` : "",
    );
    setEffort(preferred?.effort ?? "");
    const timer = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) {
      return;
    }
    setCreating(true);
    setError(null);
    const [provider, model] = modelValue.split("::");
    try {
      await onCreate({
        name: trimmed,
        ...(role.trim() ? { role: role.trim() } : {}),
        avatar: "",
        color,
        ...(provider && model
          ? { model: { provider, model, ...(effort ? { effort } : {}) } }
          : {}),
        computers: computer,
        ...(workspaceId ? { workspaceId } : {}),
        access,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-label="New agent"
      onClick={onClose}
    >
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-head-title">
            <span className="avatar avatar-lg" style={{ background: color }} />
            <h2>New agent</h2>
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
              ref={nameRef}
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
                />
              ))}
            </div>
          </div>

          <label className="field">
            <span>Model</span>
            <select
              value={modelValue}
              onChange={(event) => setModelValue(event.target.value)}
              disabled={modelOptions.length === 0}
              aria-label="Agent model"
            >
              {modelOptions.length === 0 && (
                <option value="">No models configured</option>
              )}
              {modelOptions.map((option) => (
                <option
                  key={`${option.provider}::${option.model}`}
                  value={`${option.provider}::${option.model}`}
                >
                  {option.providerLabel} · {option.model}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Reasoning effort</span>
            <select
              value={effort}
              onChange={(event) =>
                setEffort(event.target.value as ReasoningEffort | "")
              }
              aria-label="Agent reasoning effort"
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

          <div className="field">
            <span>Computer</span>
            <ComputerChoices value={computer} onChange={setComputer} />
            {!computer.includes("firecracker") && (
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
              onChange={(event) => setWorkspaceId(event.target.value)}
              aria-label="Agent project folder"
            >
              <option value="">Scratch folder (no project)</option>
              {workspaces
                .filter((workspace) => !workspace.ignored && !workspace.missing)
                .map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
            </select>
            {workspaceId ? (
              <p className="computer-warning">
                {workspaces.find((workspace) => workspace.id === workspaceId)
                  ?.root ?? ""}
              </p>
            ) : (
              <p className="computer-warning">
                Manage project folders in Settings → Workspaces.
              </p>
            )}
          </label>

          {computer.includes("mac") && (
            <label className="field">
              <span>This Mac access</span>
              <select
                value={access}
                onChange={(event) =>
                  setAccess(event.target.value as AccessMode)
                }
                aria-label="Agent This Mac access"
              >
                <option value="project">Project folder only</option>
                <option value="home">Home folder</option>
                <option value="full">Full access</option>
              </select>
              {access === "project" ? (
                <p className="computer-warning">
                  File tools and shell stay inside the project folder.
                </p>
              ) : access === "home" ? (
                <p className="computer-warning">
                  File tools and shell reach anywhere under your home folder.
                </p>
              ) : (
                <p className="computer-warning">
                  File tools and shell reach the whole filesystem as you. Every
                  local action still asks unless the project trusts it.
                </p>
              )}
            </label>
          )}

          {error && <div className="form-error">{error}</div>}
        </div>

        <footer className="modal-foot">
          <button className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="save-button"
            onClick={submit}
            disabled={!name.trim() || creating}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}
