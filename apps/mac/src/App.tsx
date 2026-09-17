import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Bot,
  ComputerKind,
  Message,
  ModelRef,
  Task,
  Thread,
  ToolArtifact,
  ToolCallRecord,
} from "@openbot/protocol";
import { Settings } from "./Settings";
import { AgentSettingsModal } from "./components/AgentSettingsModal";
import { ApprovalsModal } from "./components/ApprovalsModal";
import { Markdown } from "./components/Markdown";
import { MemoryModal } from "./components/MemoryModal";
import { PanelResizer } from "./components/PanelResizer";
import { VncView, type VncState } from "./components/VncView";
import {
  AVATAR_COLORS,
  COMPUTER_LABEL,
  EMOJI_CHOICES,
  avatarColor,
  initialOf,
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

function computerLabel(bot: Bot | null, state: SandboxState): string {
  return isLocalBot(bot) ? "This Mac" : COMPUTER_LABEL[state];
}

const SCREEN_PANEL_KEY = "openbot.screenPanel";
const SCREEN_POLL_MS = 1500;
const SCREEN_OFF_POLL_MS = 8_000;

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

const TOOL_LABEL: Record<string, string> = {
  shell: "Ran",
  read_file: "Read",
  write_file: "Wrote",
  browser: "Browsed",
  browse: "Researched",
  desktop: "Computer",
  list_roles: "Checked the team",
  spawn_worker: "Delegated",
  worker_status: "Checked work",
  cancel_worker: "Cancelled work",
};

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
    return JSON.parse(raw) as ToolArguments;
  } catch {
    return {};
  }
}

function toolDetail(raw: string): string {
  const parsed = parseToolArguments(raw);
  if (parsed.brief) {
    const grant = formatGrantDetail(parsed.grant);
    return grant
      ? `Brief: ${parsed.brief}\nGrant — ${grant}`
      : `Brief: ${parsed.brief}`;
  }
  if (parsed.taskId) return parsed.taskId;
  if (parsed.command) return parsed.command;
  if (parsed.path) return parsed.path;
  if (parsed.goal) return parsed.goal;
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
  return raw;
}

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
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
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="3.2"
        y="3.2"
        width="9.6"
        height="9.6"
        rx="2.4"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M6.4 1.6v1.6M9.6 1.6v1.6M6.4 12.8v1.6M9.6 12.8v1.6M1.6 6.4h1.6M1.6 9.6h1.6M12.8 6.4h1.6M12.8 9.6h1.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.6" width="12" height="10.8" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.4 2.6v10.8" stroke="currentColor" strokeWidth="1.4" />
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

function AgentAvatar({ bot, size = 30 }: { bot: Bot | null; size?: number }) {
  const color = bot?.color ?? avatarColor(bot?.id ?? "assistant");
  return (
    <span
      className="avatar"
      style={{ background: color, width: size, height: size, fontSize: size * 0.46 }}
    >
      {bot?.avatar ?? initialOf(bot?.name ?? "Assistant")}
    </span>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsBotId, setSettingsBotId] = useState<string | null>(null);
  const [watchTaskId, setWatchTaskId] = useState<string | null>(null);
  const [screenOpen, setScreenOpen] = useState(storedScreenPanelOpen);
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
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const bot =
    daemon.bots.find((item) => item.id === daemon.selectedBotId) ?? null;
  const botName = bot?.name ?? "Assistant";
  const hasUsableProvider = daemon.providers.some(isProviderUsable);
  const hasProviderNeedingKey = daemon.providers.some(
    (provider) =>
      provider.enabled &&
      provider.models.length > 0 &&
      !provider.hasApiKey &&
      provider.apiKeyEnv !== null,
  );
  const screenMessage = (() => {
    if (!bot) {
      return "No agent selected";
    }
    if (isLocalBot(bot)) {
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
  const vncUrl = bot
    ? `${DAEMON_HTTP_URL.replace(/^http/, "ws")}/bots/${encodeURIComponent(bot.id)}/vnc`
    : "";
  const canStream = Boolean(bot) && !isLocalBot(bot);
  const vncLive = vncState === "live";
  const vncActive =
    canStream && screenPlaying && screenOpen && screenStatus !== "vm-off";
  const screenCaption = (() => {
    if (!bot) {
      return "No agent selected";
    }
    if (isLocalBot(bot)) {
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

  const query = search.trim().toLowerCase();
  const leadBot = daemon.bots.find((item) => item.kind === "lead") ?? null;
  const roles = daemon.bots.filter((item) => item.kind === "role");
  const projects = daemon.bots.filter((item) => item.kind === "project");
  const roleName = (roleId: string): string =>
    daemon.bots.find((item) => item.id === roleId)?.name ?? "Unknown role";
  const visibleRoles = query
    ? roles.filter((item) =>
        `${item.name} ${item.role ?? ""}`.toLowerCase().includes(query),
      )
    : roles;
  const visibleProjects = query
    ? projects.filter((item) =>
        `${item.name} ${item.role ?? ""}`.toLowerCase().includes(query),
      )
    : projects;
  const visibleTasks = query
    ? daemon.tasks.filter((task) =>
        `${task.title} ${task.brief} ${roleName(task.roleId)}`
          .toLowerCase()
          .includes(query),
      )
    : daemon.tasks;
  const activeTasks = visibleTasks.filter(
    (task) => task.status === "queued" || task.status === "running",
  );
  const finishedTasks = visibleTasks.filter(
    (task) => task.status !== "queued" && task.status !== "running",
  );
  const selectedTask =
    daemon.tasks.find((task) => task.id === daemon.selectedTaskId) ?? null;
  const taskThreadIds = useMemo(
    () =>
      new Set(
        daemon.tasks
          .map((task) => task.threadId)
          .filter((id): id is string => Boolean(id)),
      ),
    [daemon.tasks],
  );
  const workApprovals = useMemo(
    () => daemon.approvals.filter((item) => taskThreadIds.has(item.threadId)),
    [daemon.approvals, taskThreadIds],
  );
  const pendingApprovalCount = daemon.approvals.filter(
    (approval) => !approval.decision,
  ).length;

  useEffect(() => {
    setScreenImageUrl(null);
    setScreenUpdatedAt(null);
    setScreenVmState(null);
    setScreenError(null);
    setScreenStatus("loading");
    setVncState("idle");
  }, [bot?.id]);

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
      !screenPlaying ||
      !windowActive ||
      !bot ||
      bot.computer === "mac" ||
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
          `${DAEMON_HTTP_URL}/bots/${encodeURIComponent(bot.id)}/screen?t=${Date.now()}`,
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
  }, [screenOpen, screenPlaying, windowActive, bot, vncLive]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [
    daemon.messages,
    activity,
    approvals,
    streaming?.text,
  ]);

  const submit = () => {
    const text = draft.trim();
    if (!text || daemon.streaming) {
      return;
    }
    daemon.sendMessage(text);
    setDraft("");
  };

  const modelValue = daemon.selectedModel
    ? `${daemon.selectedModel.provider}::${daemon.selectedModel.model}`
    : "";

  return (
    <div className={`shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-header" data-tauri-drag-region>
          <button
            className="icon-button"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label="Toggle sidebar"
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            <SidebarIcon />
          </button>
          {!sidebarCollapsed && (
            <>
              <label className="sidebar-search">
                <SearchIcon />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search"
                  aria-label="Search agents"
                  spellCheck={false}
                />
              </label>
              <button
                className="icon-button"
                title="Hire a role"
                aria-label="Hire a role"
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon />
              </button>
            </>
          )}
        </div>

        <div className="agent-list">
          {leadBot && (
            <div
              role="button"
              tabIndex={0}
              className={`agent-row lead-row ${
                leadBot.id === daemon.selectedBotId && !selectedTask
                  ? "agent-row-selected"
                  : ""
              }`}
              title={sidebarCollapsed ? leadBot.name : undefined}
              onClick={() => daemon.selectBot(leadBot.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return;
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  daemon.selectBot(leadBot.id);
                }
              }}
            >
              <AgentAvatar bot={leadBot} />
              {!sidebarCollapsed && (
                <span className="agent-row-body">
                  <span className="agent-row-name">{leadBot.name}</span>
                  <span className="agent-row-sub">
                    {threadByBot.get(leadBot.id)?.lastMessage?.trim() ||
                      "Lead · your primary assistant"}
                  </span>
                </span>
              )}
              {!sidebarCollapsed && <span className="lead-badge">Lead</span>}
            </div>
          )}

          {!sidebarCollapsed && visibleProjects.length > 0 && (
            <div className="sidebar-section">
              <span className="sidebar-section-title">Projects</span>
            </div>
          )}
          {visibleProjects.map((item) => {
            const activeRequest = daemon.tasks.find(
              (task) =>
                task.projectId === item.id &&
                task.roleId === item.id &&
                (task.status === "queued" || task.status === "running"),
            );
            const state = daemon.sandboxStates[item.id] ?? "stopped";
            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                className={`agent-row project-row ${
                  item.id === daemon.selectedBotId && !selectedTask
                    ? "agent-row-selected"
                    : ""
                }`}
                title={sidebarCollapsed ? item.name : (item.role ?? undefined)}
                onClick={() => daemon.selectBot(item.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    daemon.selectBot(item.id);
                  }
                }}
              >
                <AgentAvatar bot={item} />
                {!sidebarCollapsed && (
                  <span className="agent-row-body">
                    <span className="agent-row-name">{item.name}</span>
                    <span className="agent-row-sub">
                      {activeRequest
                        ? activeRequest.title
                        : item.role?.trim() || "Project"}
                    </span>
                  </span>
                )}
                {!sidebarCollapsed && activeRequest && (
                  <span className="task-count" title="Active request">
                    1
                  </span>
                )}
                {!sidebarCollapsed && (
                  <span
                    className={`status-dot ${
                      isLocalBot(item) ? "status-local" : `status-${state}`
                    }`}
                    title={computerLabel(item, state)}
                  />
                )}
              </div>
            );
          })}

          {!sidebarCollapsed && visibleRoles.length > 0 && (
            <div className="sidebar-section">
              <span className="sidebar-section-title">Team</span>
            </div>
          )}
          {visibleRoles.map((item) => {
            const activeCount = daemon.tasks.filter(
              (task) =>
                task.roleId === item.id &&
                (task.status === "queued" || task.status === "running"),
            ).length;
            const state = daemon.sandboxStates[item.id] ?? "stopped";
            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                className={`agent-row role-row ${
                  item.id === daemon.selectedBotId && !selectedTask
                    ? "agent-row-selected"
                    : ""
                }`}
                title={sidebarCollapsed ? item.name : undefined}
                onClick={() => daemon.selectBot(item.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    daemon.selectBot(item.id);
                  }
                }}
              >
                <AgentAvatar bot={item} />
                {!sidebarCollapsed && (
                  <span className="agent-row-body">
                    <span className="agent-row-name">{item.name}</span>
                    <span className="agent-row-sub">
                      {item.role?.trim() || "Team role"}
                    </span>
                  </span>
                )}
                {!sidebarCollapsed && activeCount > 0 && (
                  <span
                    className="task-count"
                    title={`${activeCount} active task${activeCount === 1 ? "" : "s"}`}
                  >
                    {activeCount}
                  </span>
                )}
                {!sidebarCollapsed && (
                  <button
                    className="agent-settings-button"
                    title="Role settings"
                    aria-label={`Role settings for ${item.name}`}
                    aria-haspopup="dialog"
                    aria-expanded={settingsBotId === item.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (item.id !== daemon.selectedBotId) {
                        daemon.selectBot(item.id);
                      }
                      if (item.computer !== "mac") {
                        daemon.refreshSandboxState(item.id);
                      }
                      setSettingsBotId(item.id);
                    }}
                  >
                    <GearIcon />
                  </button>
                )}
                {!sidebarCollapsed && (
                  <span
                    className={`status-dot ${
                      isLocalBot(item) ? "status-local" : `status-${state}`
                    }`}
                    title={computerLabel(item, state)}
                  />
                )}
              </div>
            );
          })}

          {!sidebarCollapsed && visibleTasks.length > 0 && (
            <div className="sidebar-section">
              <span className="sidebar-section-title">Work</span>
            </div>
          )}
          {[...activeTasks, ...finishedTasks.slice(0, 8)].map((task) => (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              className={`task-row ${
                task.id === daemon.selectedTaskId ? "task-row-selected" : ""
              }`}
              title={sidebarCollapsed ? task.title : task.brief}
              onClick={() => daemon.selectTask(task.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return;
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  daemon.selectTask(task.id);
                }
              }}
            >
              <span className={`task-dot task-dot-${task.status}`} />
              {!sidebarCollapsed && (
                <span className="agent-row-body">
                  <span className="agent-row-name">{task.title}</span>
                  <span className="agent-row-sub">
                    {roleName(task.roleId)} · {TASK_STATUS_LABEL[task.status]}
                  </span>
                </span>
              )}
            </div>
          ))}

          {!sidebarCollapsed &&
            visibleRoles.length === 0 &&
            visibleTasks.length === 0 && (
              <p className="sidebar-empty">
                {query
                  ? "No roles or tasks match your search."
                  : "Hire a role to delegate work."}
              </p>
            )}
        </div>

        <div className="sidebar-footer">
          {!sidebarCollapsed && (
            <label className="model-pill model-pill-sidebar" title="Model">
              <select
                value={modelValue}
                aria-label="Model"
                onChange={(event) => {
                  const [provider, model] = event.target.value.split("::");
                  if (provider && model) {
                    daemon.setSelectedModel({ provider, model });
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
          )}
          <div className="user-row">
            <span className="avatar user-avatar">JC</span>
            {!sidebarCollapsed && <span className="footer-name">Justin</span>}
            {!sidebarCollapsed && (
              <button
                className="icon-button"
                title="Approvals"
                aria-label="Approvals"
                onClick={() => setApprovalsOpen(true)}
              >
                <ShieldIcon />
                {pendingApprovalCount > 0 && (
                  <span className="icon-badge">{pendingApprovalCount}</span>
                )}
              </button>
            )}
            {!sidebarCollapsed && (
              <button
                className="icon-button"
                title="Memory and soul"
                aria-label="Memory and soul"
                onClick={() => setMemoryOpen(true)}
              >
                <MemoryIcon />
              </button>
            )}
            {!sidebarCollapsed && (
              <button
                className="icon-button"
                title="Settings"
                aria-label="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <GearIcon />
              </button>
            )}
            {!sidebarCollapsed && (
              <span
                className={`status-dot status-${daemon.status}`}
                title={STATUS_LABEL[daemon.status]}
              />
            )}
          </div>
        </div>
      </aside>

      <main className="chat">
        {selectedTask ? (
          <TaskView
            task={selectedTask}
            roleNameFor={roleName}
            childTasks={daemon.tasks.filter(
              (task) => task.parentId === selectedTask.id,
            )}
            messages={daemon.messages}
            decisions={decisions}
            approvals={approvals}
            activity={activity}
            streaming={streaming}
            computerState={daemon.sandboxStates[selectedTask.id] ?? null}
            onCancel={daemon.cancelTask}
            onBack={() => {
              if (leadBot) {
                daemon.selectBot(leadBot.id);
              }
            }}
            onWatch={setWatchTaskId}
            onSelectTask={daemon.selectTask}
            onRespondApproval={daemon.respondToApproval}
          />
        ) : (
          <>
        <header className="chat-header" data-tauri-drag-region>
          <div className="chat-title">
            <AgentAvatar bot={bot} size={26} />
            <span className="chat-title-name">{botName}</span>
            {bot?.role && <span className="chat-title-role">{bot.role}</span>}
          </div>
          <div className="chat-actions">
            <button
              className="icon-button"
              title={screenOpen ? "Hide screen panel" : "Show screen panel"}
              aria-label="Toggle screen panel"
              aria-pressed={screenOpen}
              onClick={() => {
                setScreenOpen((value) => {
                  const next = !value;
                  try {
                    localStorage.setItem(
                      SCREEN_PANEL_KEY,
                      next ? "open" : "closed",
                    );
                  } catch {}
                  return next;
                });
              }}
            >
              <MonitorIcon />
            </button>
            {daemon.harness.default === "codex" && (
              <span className="harness-pill" title="Codex harness">
                Codex
              </span>
            )}
          </div>
        </header>

        {daemon.tasks.length > 0 && (
          <div className="workboard">
            <div className="workboard-row">
              {[...activeTasks, ...finishedTasks.slice(0, 4)].map((task) => (
                <button
                  key={task.id}
                  className={`task-chip task-chip-${task.status}`}
                  title={task.brief}
                  onClick={() => daemon.selectTask(task.id)}
                >
                  <span className={`task-dot task-dot-${task.status}`} />
                  <span className="task-chip-title">{task.title}</span>
                  <span className="task-chip-meta">
                    {roleName(task.roleId)} · {TASK_STATUS_LABEL[task.status]}
                  </span>
                </button>
              ))}
            </div>
            {workApprovals.length > 0 && (
              <div className="workboard-approvals">
                {workApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.requestId}
                    approval={approval}
                    onRespond={daemon.respondToApproval}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="transcript" ref={scrollRef}>
          <div className="transcript-inner">
            {daemon.messages.length === 0 && !streaming && (
              <div className="empty-state">
                <span className="empty-mark" style={{ background: bot?.color ?? avatarColor(bot?.id ?? "assistant") }}>
                  {bot?.avatar ?? initialOf(botName)}
                </span>
                <h1>
                  {bot?.kind === "project"
                    ? "No requests yet."
                    : "Hand off the work."}
                </h1>
                {bot?.kind === "project" ? (
                  <p>
                    When the lead routes work to this project, the request and
                    the manager's report appear here.
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
                      onClick={() => setSettingsOpen(true)}
                    >
                      {hasProviderNeedingKey ? "Open settings" : "Set up a provider"}
                    </button>
                  </>
                )}
              </div>
            )}

            {groupTranscript(daemon.messages, streaming !== null).map((entry) =>
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

            {streaming && (() => {
              const liveDecisions = decisions.filter(
                (decision) => decision.messageId === streaming.messageId,
              );
              const hasWork =
                activity.length > 0 ||
                liveDecisions.length > 0 ||
                approvals.length > 0;
              return (
                <div className="entry entry-assistant">
                  {challenges.map((challenge) => (
                    <ChallengeCard
                      key={challenge.requestId}
                      challenge={challenge}
                      onRespond={daemon.respondToChallenge}
                      onOpenScreen={() => setScreenOpen(true)}
                    />
                  ))}
                  {hasWork && (
                    <WorkGroup
                      items={activity}
                      decisions={liveDecisions}
                      reasoning={streaming.reasoning}
                      startedAt={streaming.startedAt}
                      running
                      approvals={approvals}
                      onRespondApproval={daemon.respondToApproval}
                    />
                  )}
                  <StreamingRow streaming={streaming} showTyping={!hasWork} />
                </div>
              );
            })()}
          </div>
        </div>

        {bot?.kind === "project" ? (
          <div className="composer-note">
            {bot.name} is a project manager. The lead routes requests to it —
            ask the lead for changes.
          </div>
        ) : (
        <footer className="composer-wrap">
          <div className="composer">
            <span
              className="icon-button icon-muted composer-plus"
              title="Attachments — coming soon"
              aria-hidden="true"
            >
              <PlusIcon />
            </span>
            <textarea
              value={draft}
              placeholder={`Message ${botName}`}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <button
              className="icon-button icon-muted composer-mic"
              title="Voice input — coming soon"
              aria-label="Voice input (coming soon)"
              disabled
            >
              <MicIcon />
            </button>
            {daemon.streaming ? (
              <button className="send-circle stop" onClick={daemon.cancel} title="Stop">
                <StopIcon />
              </button>
            ) : (
              <button
                className="send-circle"
                onClick={submit}
                disabled={draft.trim().length === 0}
                title="Send"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </footer>
        )}
          </>
        )}
      </main>

      <PanelResizer active={screenOpen && !selectedTask} />
      {screenOpen && !selectedTask && (
        <aside className="screen-panel">
          <div className="screen-panel-bar">
            <span className="screen-panel-title">Computer</span>
            <button
              className="icon-button"
              title="Collapse computer view"
              aria-label="Collapse computer view"
              onClick={() => {
                setScreenOpen(false);
                try {
                  localStorage.setItem(SCREEN_PANEL_KEY, "closed");
                } catch {}
              }}
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
                  {!isLocalBot(bot) &&
                  screenStatus !== "vm-off" &&
                  screenImageUrl ? (
                    <img
                      className="screen-image"
                      src={screenImageUrl}
                      alt={`${botName}'s screen`}
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
              <span className="screen-caption-title">
                {botName}&rsquo;s screen
              </span>
              <span className="screen-caption-status">{screenCaption}</span>
              {!isLocalBot(bot) && (
                <button
                  className="icon-button"
                  title={screenPlaying ? "Pause live view" : "Resume live view"}
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
        theme={theme}
        onThemeChange={setTheme}
        onSaveProvider={daemon.saveProvider}
        onRemoveProvider={daemon.removeProvider}
        onUpdateSettings={daemon.updateSettings}
        onFetchModels={daemon.fetchModels}
        onTestDecision={daemon.testDecision}
      />
    </div>
  );
}

function MessageBubble({
  message,
  decisions,
}: {
  message: Message;
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
}: {
  items: WorkItem[];
  decisions?: DecisionActivity[];
  narration?: NarrationItem[];
  reasoning?: string;
  startedAt?: number;
  running: boolean;
  approvals?: PendingApproval[];
  onRespondApproval?: (requestId: string, decision: "approve" | "deny") => void;
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
      </button>
      {open && (
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
          {timeline.map((entry) => {
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
      )}
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

  return (
    <div className="tool-row">
      <div className="tool-row-head">
        <span className="tool-row-label">{label}</span>
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
      </div>
      {artifacts?.map((artifact) => (
        <img
          key={artifact.url}
          className="tool-row-image"
          src={`${DAEMON_HTTP_URL}${artifact.url}`}
          alt="Screenshot from the bot's computer"
        />
      ))}
      {output && (
        <details className="tool-row-output">
          <summary>Output</summary>
          <pre ref={outputRef}>{output}</pre>
        </details>
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

function StreamingRow({
  streaming,
  showTyping,
}: {
  streaming: StreamingState;
  showTyping: boolean;
}) {
  if (!streaming.text) {
    if (!showTyping) {
      return null;
    }
    return (
      <div
        className="entry-body typing-bubble"
        role="status"
        aria-label="Assistant is typing"
      >
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    );
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
              const hasWork =
                activity.length > 0 || liveDecisions.length > 0;
              return (
                <div className="entry entry-assistant">
                  {hasWork && (
                    <WorkGroup
                      items={activity}
                      decisions={liveDecisions}
                      reasoning={streaming.reasoning}
                      startedAt={streaming.startedAt}
                      running
                      approvals={approvals}
                      onRespondApproval={onRespondApproval}
                    />
                  )}
                  <StreamingRow streaming={streaming} showTyping={!hasWork} />
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
  const [avatar, setAvatar] = useState(EMOJI_CHOICES[0]!);
  const [color, setColor] = useState(AVATAR_COLORS[0]!);
  const [modelValue, setModelValue] = useState("");
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
    setAvatar(EMOJI_CHOICES[0]!);
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
        avatar,
        color,
        ...(provider && model ? { model: { provider, model } } : {}),
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
            <span className="avatar avatar-lg" style={{ background: color }}>
              {avatar}
            </span>
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
            <span>Avatar</span>
            <div className="emoji-row">
              {EMOJI_CHOICES.map((choice) => (
                <button
                  key={choice}
                  className={`emoji-choice ${
                    avatar === choice ? "emoji-choice-active" : ""
                  }`}
                  onClick={() => setAvatar(choice)}
                  aria-label={`Avatar ${choice}`}
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
