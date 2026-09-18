import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Bot,
  ChatBusyBehavior,
  ComputerKind,
  Message,
  ModelRef,
  ReasoningEffort,
  Task,
  Thread,
  ToolArtifact,
  ToolCallRecord,
} from "@openbot/protocol";
import { Settings } from "./Settings";
import { AgentSettingsModal } from "./components/AgentSettingsModal";
import { ApprovalsModal } from "./components/ApprovalsModal";
import { FilesPanel } from "./components/FilesPanel";
import { Markdown } from "./components/Markdown";
import { MemoryModal } from "./components/MemoryModal";
import { PanelResizer } from "./components/PanelResizer";
import { TerminalPanel } from "./components/TerminalPanel";
import { VncView, type VncState } from "./components/VncView";
import {
  AVATAR_COLORS,
  avatarColor,
  EFFORT_OPTIONS,
} from "./lib/agentOptions";
import { DAEMON_HTTP_URL } from "./lib/daemon";
import { useTheme } from "./lib/useTheme";
import {
  isProviderUsable,
  useDaemon,
  type CreateBotInput,
  type DecisionActivity,
  type ModelOption,
  type PendingApproval,
  type PendingChallenge,
  type SandboxState,
  type StreamingState,
  type ToolActivity,
} from "./lib/useDaemon";
import "./App.css";

const STATUS_LABEL: Record<string, string> = {
  connected: "Daemon connected",
  connecting: "Connecting to daemon…",
  disconnected: "Daemon offline — run pnpm dev:daemon",
};

function isLocalBot(bot: Bot | null | undefined): boolean {
  return bot?.computer === "mac";
}

const SCREEN_PANEL_KEY = "openbot.screenPanel";
const PANEL_TAB_KEY = "openbot.panelTab";
const SCREEN_POLL_MS = 1500;
const SCREEN_OFF_POLL_MS = 8_000;

type PanelTab = "screen" | "files" | "terminal";

const PANEL_TABS: Array<{ id: PanelTab; label: string }> = [
  { id: "screen", label: "Screen" },
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
];

const TASK_STATUS_LABEL: Record<Task["status"], string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

type ScreenStatus = "loading" | "live" | "vm-off" | "error";

function storedScreenPanelOpen(): boolean {
  try {
    return localStorage.getItem(SCREEN_PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

function storedPanelTab(): PanelTab {
  try {
    const value = localStorage.getItem(PANEL_TAB_KEY);
    if (value === "screen" || value === "files" || value === "terminal") {
      return value;
    }
  } catch {}
  return "files";
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
  brief?: string;
  roleId?: string;
  grant?: {
    tools?: string[];
    budget?: {
      wallClockMs?: number | null;
      tokens?: number | null;
      toolCalls?: number | null;
    };
  };
  taskId?: string;
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
  if (name === "read_file") {
    return { text: "Read" };
  }
  if (name === "web_search") {
    return { text: "Searched" };
  }
  return { text: "Called", code: name };
}

function formatGrantDetail(grant: ToolArguments["grant"]): string | null {
  if (!grant) {
    return null;
  }
  const parts: string[] = [];
  if (grant.tools && grant.tools.length > 0) {
    parts.push(`tools: ${grant.tools.join(", ")}`);
  }
  const budget = grant.budget;
  if (budget) {
    const limits: string[] = [];
    if (budget.wallClockMs != null) {
      limits.push(`${Math.round(budget.wallClockMs / 1000)}s`);
    }
    if (budget.toolCalls != null) {
      limits.push(`${budget.toolCalls} calls`);
    }
    if (budget.tokens != null) {
      limits.push(`${budget.tokens} tokens`);
    }
    if (limits.length > 0) {
      parts.push(`budget: ${limits.join(", ")}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
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
  if (parsed.brief) {
    const grant = formatGrantDetail(parsed.grant);
    return grant ? `brief=${parsed.brief} · ${grant}` : `brief=${parsed.brief}`;
  }
  if (parsed.taskId) return parsed.taskId;
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

function FolderTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4.2c0-.7.6-1.2 1.2-1.2h2.6l1.4 1.6h5.6c.7 0 1.2.6 1.2 1.2v6.5c0 .7-.6 1.2-1.2 1.2H3.2c-.7 0-1.2-.6-1.2-1.2V4.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TerminalTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="m5 6.4 2 1.8-2 1.8M8.8 10h2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PanelTabIcon({ tab }: { tab: PanelTab }) {
  if (tab === "screen") {
    return <MonitorIcon />;
  }
  if (tab === "files") {
    return <FolderTabIcon />;
  }
  return <TerminalTabIcon />;
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

function ExpandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 2.8h3.7v3.7M13.2 2.8 9.1 6.9M6.5 13.2H2.8V9.5M2.8 13.2l4.1-4.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 5.2h7M13.4 5.2H14M2 10.8h1M6 10.8h8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="11.2" cy="5.2" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.6" cy="10.8" r="1.7" stroke="currentColor" strokeWidth="1.4" />
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

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m4 4 8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
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
  kind: "bot" | "task";
  name: string;
  selected: boolean;
  working: boolean;
  title: string;
  // Nesting level: 0 is the lead, 1 a manager, 2 a worker. The list indents by
  // this so the hierarchy reads without drawing connector lines.
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
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

function taskThreadName(task: Task): string {
  const title = task.title?.trim() ?? "";
  const brief = (task.brief ?? "").replace(/\s+/g, " ").trim();
  if (title && title.toLowerCase() !== "delegated task") {
    return title;
  }
  if (brief) {
    return `${brief.slice(0, 44)}${brief.length > 44 ? "…" : ""}`;
  }
  return "Task";
}

function threadRowForTask(task: Task, depth: number): ThreadRow {
  return {
    id: task.id,
    kind: "task",
    name: taskThreadName(task),
    selected: false,
    working: task.status === "queued" || task.status === "running",
    title: task.brief || taskThreadName(task),
    depth,
    hasChildren: false,
    expanded: false,
  };
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
  onToggle,
}: {
  rows: ThreadRow[];
  query: string;
  searchOpen: boolean;
  onSearchChange: (value: string) => void;
  onToggleSearch: () => void;
  onSelect: (row: ThreadRow) => void;
  onToggle: (row: ThreadRow) => void;
}) {
  return (
    <section className="panel-threads">
      <div className="panel-threads-head">
        <span className="panel-section-title">Threads</span>
        <button
          className="icon-button icon-mini"
          title="Search threads"
          aria-label="Search threads"
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
            placeholder="Search threads"
            aria-label="Search threads"
            spellCheck={false}
          />
        </label>
      )}
      <div className="agent-list panel-thread-list">
        {rows.map((row) => (
          <div
            key={`${row.kind}-${row.id}`}
            role="button"
            tabIndex={0}
            className={`thread-row ${row.selected ? "thread-row-selected" : ""}`}
            style={{ paddingLeft: 8 + row.depth * 18 }}
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
            {row.hasChildren ? (
              <button
                type="button"
                className={`thread-disclosure${
                  row.expanded ? " thread-disclosure-open" : ""
                }`}
                aria-expanded={row.expanded}
                aria-label={
                  row.expanded ? `Collapse ${row.name}` : `Expand ${row.name}`
                }
                title={row.expanded ? "Hide workers" : "Show workers"}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(row);
                }}
              >
                <ChevronIcon />
              </button>
            ) : (
              <span className="thread-disclosure-spacer" aria-hidden="true" />
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <p className="sidebar-empty">
            {query
              ? "No threads match your search."
              : "No threads yet — ask the lead to start one."}
          </p>
        )}
      </div>
    </section>
  );
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
  screenOpen,
  messages,
  streaming,
  activity,
  approvals,
  challenges,
  decisions,
  onCancel,
  busyBehavior,
  onBusyBehaviorChange,
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
  screenOpen: boolean;
  messages: Message[];
  streaming: StreamingState | null;
  activity: ToolActivity[];
  approvals: PendingApproval[];
  challenges: PendingChallenge[];
  decisions: DecisionActivity[];
  onCancel: () => void;
  busyBehavior: ChatBusyBehavior;
  onBusyBehaviorChange: (value: ChatBusyBehavior) => void;
  queuedMessageIds: string[];
}) {
  const modelValue = daemon.selectedModel
    ? `${daemon.selectedModel.provider}::${daemon.selectedModel.model}`
    : "";
  const pendingApprovalCount = daemon.approvals.filter(
    (approval) => !approval.decision,
  ).length;

  return (
    <>
        <div className="chat-float-actions" data-tauri-drag-region>
          {daemon.harness.default === "codex" && (
            <span className="harness-pill" title="Codex harness">
              Codex
            </span>
          )}
          {/* The panel carries its own collapse control, so the toggle only
              appears while the computer view is closed. */}
          {!screenOpen && (
            <button
              className="icon-button"
              title="Show computer view"
              aria-label="Show computer view"
              onClick={() => {
                onOpenScreen();
                try {
                  localStorage.setItem(SCREEN_PANEL_KEY, "open");
                } catch {}
              }}
            >
              <MonitorIcon />
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
                {bot?.kind === "project" ? (
                  <p>
                    {bot.role?.trim() || "Thread"} · when the lead routes work
                    here, the request and the manager's report appear in this
                    thread.
                  </p>
                ) : hasUsableProvider ? (
                  <p>
                    {isLocalBot(bot)
                      ? "Ask for what you need. The lead can run commands directly on this Mac or delegate to a team role."
                      : "Ask for what you need. The lead can work on its own computer or delegate to a team role — workers run on their own computers and report back here."}
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
              </div>
            )}

            {groupTranscript(messages, streaming !== null).map((entry) =>
              entry.kind === "turn" ? (
                <TurnBubble
                  key={entry.final.id}
                  entry={entry}
                  decisions={decisions.filter(
                    (decision) => decision.messageId === entry.final.id,
                  )}
                />
              ) : (
                <MessageBubble
                  key={entry.message.id}
                  message={entry.message}
                  queued={queuedMessageIds.includes(entry.message.id)}
                  decisions={decisions.filter(
                    (decision) => decision.messageId === entry.message.id,
                  )}
                />
              ),
            )}

            {streaming && (() => {
              const liveDecisions = decisions.filter(
                (decision) => decision.messageId === streaming.messageId,
              );
              return (
                <div className="entry entry-assistant">
                  {challenges.map((challenge) => (
                    <ChallengeCard
                      key={challenge.requestId}
                      challenge={challenge}
                      onRespond={daemon.respondToChallenge}
                      onOpenScreen={() => onOpenScreen()}
                    />
                  ))}
                  <WorkGroup
                    items={activity}
                    decisions={liveDecisions}
                    reasoning={streaming.reasoning}
                    startedAt={streaming.startedAt}
                    running
                    approvals={approvals}
                    onRespondApproval={daemon.respondToApproval}
                    statusAtBottom
                    footer={<StreamingRow streaming={streaming} />}
                  />
                </div>
              );
            })()}
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
              {streaming && (
                <div
                  className="segmented segmented-compact composer-busy-group"
                  role="radiogroup"
                  aria-label="What to do while the agent is working"
                >
                  <button
                    role="radio"
                    aria-checked={busyBehavior === "steer"}
                    className={`segmented-option ${
                      busyBehavior === "steer" ? "segmented-option-active" : ""
                    }`}
                    title="Join the running turn at its next step"
                    onClick={() => onBusyBehaviorChange("steer")}
                  >
                    Steer
                  </button>
                  <button
                    role="radio"
                    aria-checked={busyBehavior === "queue"}
                    className={`segmented-option ${
                      busyBehavior === "queue" ? "segmented-option-active" : ""
                    }`}
                    title="Send automatically when the agent stops"
                    onClick={() => onBusyBehaviorChange("queue")}
                  >
                    Queue
                  </button>
                </div>
              )}
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
                  <button
                    className="icon-button"
                    title="Settings"
                    aria-label="Settings"
                    onClick={() => onOpenSettings()}
                  >
                    <GearIcon />
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
                      title={
                        busyBehavior === "steer"
                          ? "Steer the running turn"
                          : "Queue for when the agent stops"
                      }
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
    </>
  );
}


export default function App() {
  const daemon = useDaemon();
  const { theme, setTheme } = useTheme();
  const [draft, setDraft] = useState("");
  const [busyBehavior, setBusyBehavior] = useState<ChatBusyBehavior | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(
    () => new Set(),
  );
  const [drawerThread, setDrawerThread] = useState<{
    threadId: string;
    row: ThreadRow;
  } | null>(null);
  const [drawerClosing, setDrawerClosing] = useState(false);
  const [settingsBotId, setSettingsBotId] = useState<string | null>(null);
  const [watchTaskId, setWatchTaskId] = useState<string | null>(null);
  const [screenOpen, setScreenOpen] = useState(storedScreenPanelOpen);
  const [panelTab, setPanelTab] = useState<PanelTab>(storedPanelTab);
  const [screenPlaying, setScreenPlaying] = useState(true);
  const [screenExpanded, setScreenExpanded] = useState(false);
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
  // The computer panel follows the thread you have open: a manager's drawer
  // shows the manager's machine rather than the main agent's.
  const drawerBot =
    drawerThread?.row.kind === "bot"
      ? (daemon.bots.find((item) => item.id === drawerThread.row.id) ?? null)
      : null;
  const screenBot = drawerBot ?? bot;
  const screenBotName = screenBot?.name ?? "Assistant";
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
    if (isLocalBot(screenBot)) {
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
  const terminalUrl = screenBot
    ? `${DAEMON_HTTP_URL.replace(/^http/, "ws")}/bots/${encodeURIComponent(screenBot.id)}/terminal`
    : "";
  const canStream = Boolean(screenBot) && !isLocalBot(screenBot);
  const vncLive = vncState === "live";
  const vncActive =
    canStream &&
    screenPlaying &&
    screenOpen &&
    panelTab === "screen" &&
    screenStatus !== "vm-off";

  const choosePanelTab = (tab: PanelTab) => {
    setPanelTab(tab);
    try {
      localStorage.setItem(PANEL_TAB_KEY, tab);
    } catch {}
  };

  const openScreenTab = () => {
    setScreenOpen(true);
    choosePanelTab("screen");
    try {
      localStorage.setItem(SCREEN_PANEL_KEY, "open");
    } catch {}
  };

  const closePanel = () => {
    setScreenOpen(false);
    try {
      localStorage.setItem(SCREEN_PANEL_KEY, "closed");
    } catch {}
  };
  const screenCaption = (() => {
    if (!screenBot) {
      return "No agent selected";
    }
    if (isLocalBot(screenBot)) {
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

  useEffect(() => {
    if (!screenExpanded) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setScreenExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [screenExpanded]);

  useEffect(() => {
    if (!screenOpen && screenExpanded) {
      setScreenExpanded(false);
    }
  }, [screenOpen, screenExpanded]);

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
  const decisions = useMemo(
    () => daemon.decisions.filter((item) => item.threadId === activeThreadId),
    [daemon.decisions, activeThreadId],
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
    daemon.streaming?.threadId === settingsThread.id;

  const leadBot = daemon.bots.find((item) => item.kind === "lead") ?? null;
  const roles = daemon.bots.filter((item) => item.kind === "role");
  const projects = daemon.bots.filter((item) => item.kind === "project");
  const roleName = (roleId: string): string =>
    daemon.bots.find((item) => item.id === roleId)?.name ?? "Unknown role";
  const pendingApprovalCount = daemon.approvals.filter(
    (approval) => !approval.decision,
  ).length;

  // The thread list is a tree: the lead branches to project managers, and each
  // manager branches to the workers it is running. Standalone tasks hang
  // directly off the lead.
  const drawerRowId = drawerThread?.row.id ?? null;
  const threadRows: ThreadRow[] = (() => {
    const rows: ThreadRow[] = [];
    const q = search.trim().toLowerCase();
    const matches = (...parts: Array<string | null | undefined>) =>
      !q || parts.some((part) => (part ?? "").toLowerCase().includes(q));
    const isActive = (task: Task) =>
      task.status === "queued" || task.status === "running";
    const byActivity = (a: Task, b: Task) => {
      const byActive = Number(isActive(b)) - Number(isActive(a));
      if (byActive !== 0) {
        return byActive;
      }
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    };
    const botRow = (
      bot: Bot,
      depth: number,
      working: boolean,
      hasChildren: boolean,
      expanded: boolean,
    ): ThreadRow => ({
      id: bot.id,
      kind: "bot",
      name: bot.name,
      selected: drawerRowId
        ? bot.id === drawerRowId
        : bot.id === daemon.selectedBotId,
      working,
      title: bot.role ?? bot.name,
      depth,
      hasChildren,
      expanded,
    });
    const taskRow = (task: Task, depth: number): ThreadRow => ({
      ...threadRowForTask(task, depth),
      selected: task.id === drawerRowId,
    });

    // The main agent is not a thread: it lives in the chat itself, so the
    // list starts at the managers it has spun up.
    const managers = projects
      .map((manager) => {
        const projectTasks = daemon.tasks.filter(
          (task) => task.projectId === manager.id,
        );
        const workers = projectTasks.sort(byActivity).slice(0, 6);
        const selfMatch = matches(manager.name, manager.role);
        const visibleWorkers =
          q && !selfMatch
            ? workers.filter((task) =>
                matches(taskThreadName(task), task.title, task.brief),
              )
            : workers;
        return {
          manager,
          workers: visibleWorkers,
          visible: selfMatch || visibleWorkers.length > 0,
          working: projectTasks.some(isActive),
          expanded: q.length > 0 || expandedThreads.has(manager.id),
        };
      })
      .filter((group) => group.visible);

    const looseTasks = daemon.tasks
      .filter((task) => !task.projectId)
      .sort(byActivity)
      .filter((task) =>
        matches(taskThreadName(task), task.title, task.brief),
      )
      .slice(0, 8);

    managers.forEach((group) => {
      rows.push(
        botRow(
          group.manager,
          0,
          group.working,
          group.workers.length > 0,
          group.expanded,
        ),
      );
      if (group.expanded) {
        group.workers.forEach((task) => {
          rows.push(taskRow(task, 1));
        });
      }
    });

    looseTasks.forEach((task) => {
      rows.push(taskRow(task, 0));
    });

    return rows;
  })();

  const toggleThread = (row: ThreadRow) => {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(row.id)) {
        next.delete(row.id);
      } else {
        next.add(row.id);
      }
      return next;
    });
  };

  // Threads open in a drawer over the chat instead of taking it over, so the
  // conversation behind it is never swapped out.
  const openThread = (row: ThreadRow) => {
    const threadId =
      row.kind === "task"
        ? (daemon.tasks.find((task) => task.id === row.id)?.threadId ?? null)
        : (daemon.threads.find((item) => item.botId === row.id)?.id ?? null);
    if (!threadId) {
      return;
    }
    setDrawerClosing(false);
    setDrawerThread({ threadId, row });
    daemon.openThreadPreview(threadId);
  };

  // Closing plays the slide-out first; the drawer unmounts when it finishes.
  const closeThread = () => {
    setDrawerClosing(true);
  };

  const finishCloseThread = () => {
    setDrawerThread(null);
    setDrawerClosing(false);
    daemon.closeThreadPreview();
  };

  useEffect(() => {
    if (!drawerThread) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerClosing(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerThread]);

  // Everything the drawer shows comes from the previewed thread, except when
  // the drawer is showing the thread the chat is already on.
  const drawerThreadId = drawerThread?.threadId ?? null;
  const drawerRow = drawerThread?.row ?? null;
  const drawerIsActive =
    drawerThreadId !== null && drawerThreadId === daemon.activeThreadId;
  const drawerMessages = drawerIsActive
    ? daemon.messages
    : daemon.previewMessages;
  const drawerStreaming = drawerIsActive ? streaming : daemon.previewStreaming;
  // The per-send override resets as soon as the turn that prompted it ends, so
  // the next busy send follows the setting again.
  useEffect(() => {
    if (!streaming && !drawerStreaming) {
      setBusyBehavior(null);
    }
  }, [streaming, drawerStreaming]);
  const effectiveBusyBehavior = busyBehavior ?? daemon.chatBusyBehavior;
  const drawerActivity = drawerThreadId
    ? daemon.toolActivity.filter((item) => item.threadId === drawerThreadId)
    : [];
  const drawerApprovals = drawerThreadId
    ? daemon.approvals.filter((item) => item.threadId === drawerThreadId)
    : [];
  const drawerChallenges = drawerThreadId
    ? daemon.challenges.filter((item) => item.threadId === drawerThreadId)
    : [];
  const drawerDecisions = drawerThreadId
    ? daemon.decisions.filter((item) => item.threadId === drawerThreadId)
    : [];
  const drawerTask =
    drawerRow?.kind === "task"
      ? (daemon.tasks.find((task) => task.id === drawerRow.id) ?? null)
      : null;

  useEffect(() => {
    if (!drawerThread) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerThread(null);
        daemon.closeThreadPreview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerThread, daemon]);

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
      !screenOpen ||
      panelTab !== "screen" ||
      !screenPlaying ||
      !windowActive ||
      !screenBot ||
      screenBot.computer === "mac" ||
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
  }, [screenOpen, panelTab, screenPlaying, windowActive, screenBot, vncLive]);

  const scrollSignal = [
    daemon.messages.length,
    activity.length,
    approvals.length,
    streaming?.text.length ?? 0,
  ].join(":");
  const drawerScrollSignal = [
    drawerMessages.length,
    drawerActivity.length,
    drawerApprovals.length,
    drawerStreaming?.text.length ?? 0,
  ].join(":");
  const submit = () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    daemon.sendMessage(text, streaming ? effectiveBusyBehavior : undefined);
    setDraft("");
  };
  const submitToDrawer = () => {
    const text = draft.trim();
    if (!text || !drawerThreadId || drawerRow?.kind !== "bot") {
      return;
    }
    daemon.sendMessageToThread(
      drawerThreadId,
      drawerRow.id,
      text,
      drawerStreaming ? effectiveBusyBehavior : undefined,
    );
    setDraft("");
  };

  return (
    <div className="shell">
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
          onToggle={toggleThread}
        />
      </aside>

      <main className="chat">
        <header className="agent-badge">
          <span
            className="agent-badge-avatar"
            style={{
              background:
                leadBot?.color ?? avatarColor(leadBot?.id ?? "assistant"),
            }}
          />
          <span className="agent-badge-name">
            {leadBot?.name ?? "Assistant"}
          </span>
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
          screenOpen={screenOpen}
          messages={daemon.messages}
          streaming={streaming}
          activity={activity}
          approvals={approvals}
          challenges={challenges}
          decisions={decisions}
          onCancel={daemon.cancel}
          busyBehavior={effectiveBusyBehavior}
          onBusyBehaviorChange={setBusyBehavior}
          queuedMessageIds={daemon.queuedMessageIds}
        />

        {drawerRow && (
          <div className="drawer-layer">
            <section
              className={`thread-drawer${
                drawerClosing ? " thread-drawer-closing" : ""
              }`}
              role="dialog"
              aria-label={`${drawerRow.name} thread`}
              onAnimationEnd={(event) => {
                if (drawerClosing && event.target === event.currentTarget) {
                  finishCloseThread();
                }
              }}
            >
              {drawerTask ? (
                <TaskView
                  task={drawerTask}
                  roleNameFor={roleName}
                  childTasks={daemon.tasks.filter(
                    (task) => task.parentId === drawerTask.id,
                  )}
                  messages={drawerMessages}
                  decisions={drawerDecisions}
                  approvals={drawerApprovals}
                  activity={drawerActivity}
                  streaming={drawerStreaming}
                  computerState={daemon.sandboxStates[drawerTask.id] ?? null}
                  onCancel={daemon.cancelTask}
                  onBack={closeThread}
                  onWatch={setWatchTaskId}
                  onSelectTask={(taskId) => {
                    const task = daemon.tasks.find((item) => item.id === taskId);
                    if (task) {
                      openThread(threadRowForTask(task, 2));
                    }
                  }}
                  onRespondApproval={daemon.respondToApproval}
                />
              ) : (
                <>
                  <div className="drawer-bar">
                    <span className="drawer-grip" aria-hidden="true" />
                    <span className="drawer-title">{drawerRow.name}</span>
                    <button
                      className="icon-button"
                      title="Close thread"
                      aria-label="Close thread"
                      onClick={closeThread}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                  <ThreadChat
                    daemon={daemon}
                    bot={drawerBot}
                    botName={drawerRow.name}
                    draft={draft}
                    onDraftChange={setDraft}
                    onSubmit={submitToDrawer}
                    scrollSignal={drawerScrollSignal}
                    hasUsableProvider={hasUsableProvider}
                    hasProviderNeedingKey={hasProviderNeedingKey}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onOpenScreen={openScreenTab}
                    onOpenApprovals={() => setApprovalsOpen(true)}
                    onOpenMemory={() => setMemoryOpen(true)}
                    screenOpen={screenOpen}
                    messages={drawerMessages}
                    streaming={drawerStreaming}
                    activity={drawerActivity}
                    approvals={drawerApprovals}
                    challenges={drawerChallenges}
                    decisions={drawerDecisions}
                    onCancel={() => {
                      if (drawerThreadId) {
                        daemon.cancelThread(drawerThreadId);
                      }
                    }}
                    busyBehavior={effectiveBusyBehavior}
                    onBusyBehaviorChange={setBusyBehavior}
                    queuedMessageIds={daemon.queuedMessageIds}
                  />
                </>
              )}
            </section>
          </div>
        )}
      </main>

      <PanelResizer active={screenOpen} />
      {screenOpen && (
        <aside
          className={`screen-panel ${
            screenExpanded ? "screen-panel-expanded" : ""
          }`}
        >
          {!screenExpanded && (
            <div className="panel-tabs" role="tablist" aria-label="Agent panel">
              {PANEL_TABS.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={panelTab === tab.id}
                  className={`panel-tab${
                    panelTab === tab.id ? " panel-tab-active" : ""
                  }`}
                  onClick={() => choosePanelTab(tab.id)}
                >
                  <PanelTabIcon tab={tab.id} />
                  <span>{tab.label}</span>
                </button>
              ))}
              <button
                className="icon-button panel-collapse"
                title="Collapse panel"
                aria-label="Collapse panel"
                onClick={closePanel}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 17 5-5-5-5" />
                  <path d="m13 17 5-5-5-5" />
                </svg>
              </button>
            </div>
          )}

          {panelTab === "screen" && (
            <section className="panel-tab-pane panel-pane-screen">
              <div className="screen-panel-bar">
                <span className="screen-panel-identity">
                  <span
                    className="screen-panel-dot"
                    style={{
                      background:
                        screenBot?.color ??
                        avatarColor(screenBot?.id ?? "assistant"),
                    }}
                  />
                  {screenBot && (
                    <span className="screen-panel-name">
                      {screenBotName}&rsquo;s
                    </span>
                  )}
                  <span className="screen-panel-title">Computer</span>
                </span>
              </div>
              <section className="screen-view">
                <div
                  className={`screen-frame ${
                    screenExpanded ? "screen-frame-expanded" : ""
                  }`}
                  onClick={
                    canStream && !screenExpanded
                      ? () => setScreenExpanded(true)
                      : undefined
                  }
                >
                  {canStream && (
                    <VncView
                      url={vncUrl}
                      active={vncActive}
                      interactive={screenExpanded}
                      onState={setVncState}
                    />
                  )}
                  {!vncLive && (
                    <div className="screen-fallback">
                      {!isLocalBot(screenBot) &&
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
                  {canStream && !screenExpanded && (
                    <button
                      className="screen-open"
                      onClick={() => setScreenExpanded(true)}
                    >
                      <ExpandIcon />
                      <span>Open</span>
                    </button>
                  )}
                  {canStream && screenExpanded && (
                    <div className="screen-frame-actions">
                      <button
                        className="screen-action"
                        title="Collapse (Esc)"
                        aria-label="Collapse desktop view"
                        onClick={() => setScreenExpanded(false)}
                      >
                        <CollapseIcon />
                      </button>
                    </div>
                  )}
                </div>
                <div className="screen-caption">
                  <span className="screen-caption-status">{screenCaption}</span>
                  {!isLocalBot(screenBot) && (
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
                  )}
                </div>
              </section>
            </section>
          )}

          {!screenExpanded && (
            <>
              <section
                className="panel-tab-pane"
                hidden={panelTab !== "files"}
              >
                {screenBot && (
                  <FilesPanel
                    botId={screenBot.id}
                    isMac={isLocalBot(screenBot)}
                    active={panelTab === "files"}
                    listFiles={daemon.listFiles}
                    readFile={daemon.readFile}
                  />
                )}
              </section>

              <section
                className="panel-tab-pane"
                hidden={panelTab !== "terminal"}
              >
                {screenBot && (
                  <TerminalPanel
                    botId={screenBot.id}
                    botName={screenBotName}
                    canConnect={canStream}
                    url={terminalUrl}
                    active={panelTab === "terminal"}
                  />
                )}
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

      {watchTaskId &&
        (() => {
          const watchTask =
            daemon.tasks.find((task) => task.id === watchTaskId) ?? null;
          return watchTask ? (
            <TaskWatchOverlay
              task={watchTask}
              onClose={() => setWatchTaskId(null)}
            />
          ) : null;
        })()}

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
        onClose={() => setSettingsBotId(null)}
        onSave={(patch) => {
          if (settingsBotId) {
            daemon.updateBot(settingsBotId, patch);
            if (patch.computer === "firecracker") {
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
        roles={roles}
        sandboxStates={daemon.sandboxStates}
        onHireRole={() => setCreateOpen(true)}
        onEditRole={(botId) => setSettingsBotId(botId)}
      />
    </div>
  );
}

function MessageBubble({
  message,
  queued,
  decisions,
}: {
  message: Message;
  queued?: boolean;
  decisions?: DecisionActivity[];
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
      {(calls.length > 0 || (decisions?.length ?? 0) > 0) && (
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
          decisions={decisions}
          running={false}
        />
      )}
      {message.content && (
        <div className="entry-body">
          <Markdown text={message.content} />
        </div>
      )}
    </div>
  );
}

type TranscriptEntry =
  | { kind: "single"; message: Message }
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
        entries.push({ kind: "single", message });
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
  decisions,
}: {
  entry: { work: Message[]; final: Message };
  decisions?: DecisionActivity[];
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
        decisions={decisions}
        narration={narration}
        running={false}
      />
      {entry.final.content && (
        <div className="entry-body">
          <Markdown text={entry.final.content} />
        </div>
      )}
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
  | { type: "decision"; at: number; decision: DecisionActivity }
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
  decisions,
  narration,
  reasoning,
  startedAt,
  running,
  approvals,
  onRespondApproval,
  statusAtBottom,
  footer,
}: {
  items: WorkItem[];
  decisions?: DecisionActivity[];
  narration?: NarrationItem[];
  reasoning?: string;
  startedAt?: number;
  running: boolean;
  approvals?: PendingApproval[];
  onRespondApproval?: (requestId: string, decision: "approve" | "deny") => void;
  // While a turn is live the status line trails the work — tools and streamed
  // text stack above it, the way the agent harness prints "Thinking". Finished
  // turns keep the summary header on top so the answer reads below it.
  statusAtBottom?: boolean;
  footer?: ReactNode;
}) {
  const pending = (approvals ?? []).filter((approval) => !approval.decision);
  const [open, setOpen] = useState(pending.length > 0 || running);
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
    ...(decisions ?? []).map((decision) => ({
      type: "decision" as const,
      at: decision.at,
      decision,
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
        {(decisions?.length ?? 0) > 0 &&
          `${items.length > 0 ? " · " : ""}${decisions?.length} Jev decision${
            decisions?.length === 1 ? "" : "s"
          }`}
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
            <span className="work-thinking-preview">
              {reasoning.trim().split("\n")[0]}
            </span>
          </summary>
          <pre>{reasoning.trim()}</pre>
        </details>
      )}
      {rows.map((entry) => {
        if (entry.type === "decision") {
          const decision = entry.decision;
          return (
            <div
              key={decision.id}
              className={`work-decision ${
                decision.flagged ? "work-decision-flagged" : ""
              }`}
            >
              <span className="work-decision-engine">Jev</span>
              <span className="work-decision-kind">{decision.kind}</span>
              <span className="work-decision-summary">
                {decision.summary}
              </span>
              <span className="work-decision-meta">
                {decision.model}
                {decision.latencyMs !== null
                  ? ` · ${decision.latencyMs} ms`
                  : ""}
              </span>
            </div>
          );
        }
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

  // A live turn keeps its tool rows and streamed text visible as transcript
  // rows, so the status line only trails them — there is nothing to collapse.
  if (statusAtBottom) {
    return (
      <div className="work-group work-group-live">
        {body}
        {footer}
        <div className="work-group-status" role="status">
          {statusContent}
        </div>
      </div>
    );
  }

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
  onRespond: (requestId: string, decision: "approve" | "deny") => void;
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

function budgetLabel(budget: Task["budget"]): string {
  if (!budget) {
    return "unlimited";
  }
  const parts: string[] = [];
  if (budget.wallClockMs != null) {
    parts.push(`${Math.round(budget.wallClockMs / 1000)}s`);
  }
  if (budget.toolCalls != null) {
    parts.push(`${budget.toolCalls} calls`);
  }
  if (budget.tokens != null) {
    parts.push(`${budget.tokens} tokens`);
  }
  return parts.join(", ") || "unlimited";
}

function usageLabel(usage: Task["usage"]): string {
  if (!usage) {
    return "—";
  }
  const seconds = Math.round(usage.wallClockMs / 1000);
  const tokens = usage.inputTokens + usage.outputTokens;
  return `${usage.toolCalls} calls, ${tokens} tokens, ${seconds}s`;
}

function TaskWatchOverlay({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const [vncState, setVncState] = useState<VncState>("idle");
  const vncUrl = `${DAEMON_HTTP_URL.replace(/^http/, "ws")}/tasks/${encodeURIComponent(task.id)}/vnc`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="watch-overlay" role="dialog" aria-label="Watch task">
      <div className="watch-frame">
        <div className="watch-bar">
          <span className="task-dot task-dot-running" />
          <span className="watch-title">{task.title}</span>
          <span className="watch-status">
            {vncState === "live"
              ? "Live desktop"
              : vncState === "connecting"
                ? "Connecting…"
                : vncState === "down"
                  ? "Desktop stream unavailable"
                  : "Starting…"}
          </span>
          <button className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="watch-view">
          <VncView
            url={vncUrl}
            active
            interactive
            onState={setVncState}
          />
        </div>
      </div>
    </div>
  );
}

function TaskView({
  task,
  roleNameFor,
  childTasks,
  messages,
  decisions,
  approvals,
  activity,
  streaming,
  computerState,
  onCancel,
  onBack,
  onWatch,
  onSelectTask,
  onRespondApproval,
}: {
  task: Task;
  roleNameFor: (roleId: string) => string;
  childTasks: Task[];
  messages: Message[];
  decisions: DecisionActivity[];
  approvals: PendingApproval[];
  activity: ToolActivity[];
  streaming: StreamingState | null;
  computerState: SandboxState | null;
  onCancel: (taskId: string) => void;
  onBack: () => void;
  onWatch: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  onRespondApproval: (requestId: string, decision: "approve" | "deny") => void;
}) {
  const roleName = roleNameFor(task.roleId);
  const running = task.status === "queued" || task.status === "running";
  const canWatch =
    running && (computerState === "running" || computerState === "booting");
  const startedAt = task.startedAt
    ? Date.parse(task.startedAt)
    : Date.parse(task.createdAt);
  const endedAt = task.endedAt ? Date.parse(task.endedAt) : Date.now();
  const elapsed = formatElapsed(endedAt - startedAt);

  return (
    <>
      <header className="chat-header" data-tauri-drag-region>
        <div className="chat-title">
          <span className={`task-dot task-dot-${task.status}`} />
          <span className="chat-title-name">{task.title}</span>
          <span className="chat-title-role">
            {roleName} · {TASK_STATUS_LABEL[task.status]} · {elapsed}
          </span>
        </div>
        <div className="chat-actions">
          {canWatch && (
            <button
              className="ghost-button"
              onClick={() => onWatch(task.id)}
              title="Watch this task's computer"
            >
              Watch
            </button>
          )}
          <button className="ghost-button" onClick={onBack}>
            Back to lead
          </button>
          {running && (
            <button
              className="deny-button"
              onClick={() => onCancel(task.id)}
              title="Stop this worker"
            >
              Cancel task
            </button>
          )}
        </div>
      </header>

      <div className="transcript">
        <div className="transcript-inner">
          <section className="task-summary">
            <h2>Brief</h2>
            <p className="task-brief">{task.brief}</p>
            {task.result && (
              <>
                <h2>Result</h2>
                <Markdown text={task.result} />
              </>
            )}
            {task.error && (
              <div className="entry-body entry-error">{task.error}</div>
            )}
            {task.evidence && (
              <details className="task-evidence">
                <summary>Evidence ledger</summary>
                <pre>{task.evidence}</pre>
              </details>
            )}
          </section>

          <section className="task-meta">
            <div className="task-meta-item">
              <span className="task-meta-label">Computer</span>
              <span>{computerState ?? "—"}</span>
            </div>
            <div className="task-meta-item">
              <span className="task-meta-label">Tools</span>
              <span>{task.grant?.tools.join(", ") || "none"}</span>
            </div>
            <div className="task-meta-item">
              <span className="task-meta-label">Display</span>
              <span>{task.grant?.display ?? "none"}</span>
            </div>
            <div className="task-meta-item">
              <span className="task-meta-label">Budget</span>
              <span>{budgetLabel(task.budget)}</span>
            </div>
            <div className="task-meta-item">
              <span className="task-meta-label">Used</span>
              <span>{usageLabel(task.usage)}</span>
            </div>
          </section>

          {childTasks.length > 0 && (
            <section className="task-children">
              <h2>Workers</h2>
              {childTasks.map((child) => (
                <button
                  key={child.id}
                  className="task-child-row"
                  onClick={() => onSelectTask(child.id)}
                >
                  <span className={`task-dot task-dot-${child.status}`} />
                  <span className="task-child-title">{child.title}</span>
                  <span className="task-child-meta">
                    {roleNameFor(child.roleId)} ·{" "}
                    {TASK_STATUS_LABEL[child.status]}
                  </span>
                </button>
              ))}
            </section>
          )}

          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.requestId}
              approval={approval}
              onRespond={onRespondApproval}
            />
          ))}

          {messages.length === 0 && !streaming && running && (
            <p className="sidebar-empty">Waiting for the worker to start…</p>
          )}

          {groupTranscript(messages, streaming !== null).map((entry) =>
            entry.kind === "turn" ? (
              <TurnBubble
                key={entry.final.id}
                entry={entry}
                decisions={decisions.filter(
                  (decision) => decision.messageId === entry.final.id,
                )}
              />
            ) : (
              <MessageBubble
                key={entry.message.id}
                message={entry.message}
                decisions={decisions.filter(
                  (decision) => decision.messageId === entry.message.id,
                )}
              />
            ),
          )}

          {streaming &&
            (() => {
              const liveDecisions = decisions.filter(
                (decision) => decision.messageId === streaming.messageId,
              );
              return (
                <div className="entry entry-assistant">
                  <WorkGroup
                    items={activity}
                    decisions={liveDecisions}
                    reasoning={streaming.reasoning}
                    startedAt={streaming.startedAt}
                    running
                    approvals={approvals}
                    onRespondApproval={onRespondApproval}
                    statusAtBottom
                    footer={<StreamingRow streaming={streaming} />}
                  />
                </div>
              );
            })()}
        </div>
      </div>
    </>
  );
}

function CreateAgentModal({
  open,
  onClose,
  modelOptions,
  selectedModel,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  modelOptions: ModelOption[];
  selectedModel: ModelRef | null;
  onCreate: (input: CreateBotInput) => Promise<Bot>;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [color, setColor] = useState(AVATAR_COLORS[0]!);
  const [modelValue, setModelValue] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [computer, setComputer] = useState<ComputerKind>("firecracker");
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
    setComputer("firecracker");
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
        computer,
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
      aria-label="New role"
      onClick={onClose}
    >
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-head-title">
            <span className="avatar avatar-lg" style={{ background: color }} />
            <h2>Hire a role</h2>
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
            {computer === "mac" && (
              <p className="computer-warning">
                Runs commands directly on this Mac. Local tools always require
                your approval.
              </p>
            )}
          </div>

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
