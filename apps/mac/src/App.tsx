import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  Bot,
  ComputerKind,
  Message,
  ModelRef,
  Thread,
  ToolArtifact,
  ToolCallRecord,
} from "@openbot/protocol";
import { Settings } from "./Settings";
import { PanelResizer } from "./components/PanelResizer";
import { VncView, type VncState } from "./components/VncView";
import { DAEMON_HTTP_URL } from "./lib/daemon";
import { useTheme } from "./lib/useTheme";
import {
  isProviderUsable,
  useDaemon,
  type CreateBotInput,
  type ModelOption,
  type PendingApproval,
  type SandboxState,
  type StreamingState,
} from "./lib/useDaemon";
import "./App.css";

const STATUS_LABEL: Record<string, string> = {
  connected: "Daemon connected",
  connecting: "Connecting to daemon…",
  disconnected: "Daemon offline — run pnpm dev:daemon",
};

const COMPUTER_LABEL: Record<SandboxState, string> = {
  stopped: "Computer off",
  booting: "Booting computer…",
  running: "Computer running",
  error: "Computer error",
};

function isLocalBot(bot: Bot | null | undefined): boolean {
  return bot?.computer === "mac";
}

function computerLabel(bot: Bot | null, state: SandboxState): string {
  return isLocalBot(bot) ? "This Mac" : COMPUTER_LABEL[state];
}

const SCREEN_PANEL_KEY = "openbot.screenPanel";
const SCREEN_POLL_MS = 1500;

type ScreenStatus = "loading" | "live" | "vm-off" | "error";

function storedScreenPanelOpen(): boolean {
  try {
    return localStorage.getItem(SCREEN_PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

const AVATAR_COLORS = [
  "#1f8a65",
  "#d97706",
  "#7c3aed",
  "#2563eb",
  "#dc2626",
  "#0891b2",
];

const EMOJI_CHOICES = [
  "🤖",
  "🧠",
  "📈",
  "🎨",
  "🛠️",
  "🔬",
  "✍️",
  "🚀",
  "📣",
  "🧭",
  "⚙️",
  "🦾",
];

function avatarColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 9973;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "#1f8a65";
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "A";
}

function parseToolArguments(raw: string): { command?: string; path?: string } {
  try {
    const parsed = JSON.parse(raw) as { command?: string; path?: string };
    return parsed;
  } catch {
    return {};
  }
}

function toolDetail(raw: string): string {
  const parsed = parseToolArguments(raw);
  if (parsed.command) return parsed.command;
  if (parsed.path) return parsed.path;
  return raw;
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

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let key = 0;

  const flush = () => {
    if (list.length === 0) {
      return;
    }
    const items = list;
    list = [];
    blocks.push(
      <ul key={`ul-${key++}`}>
        {items.map((item, index) => (
          <li key={`li-${index}`}>{inline(item, `li-${key}-${index}`)}</li>
        ))}
      </ul>,
    );
  };

  for (const line of text.split("\n")) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet && bullet[1]) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    if (!line.trim()) {
      continue;
    }
    blocks.push(<p key={`p-${key++}`}>{inline(line, `p-${key}`)}</p>);
  }
  flush();

  return <div className="markdown">{blocks}</div>;
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${index}`}>{token.slice(2, -2)}</strong>,
      );
    } else {
      nodes.push(
        <code key={`${keyPrefix}-c-${index}`}>{token.slice(1, -1)}</code>,
      );
    }
    last = match.index + token.length;
    index += 1;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

export default function App() {
  const daemon = useDaemon();
  const { theme, setTheme } = useTheme();
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [computerMenu, setComputerMenu] = useState<{
    botId: string;
    top: number;
    left: number;
    width: number;
    confirmDelete?: boolean;
  } | null>(null);
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
  const vncActive = canStream && screenPlaying && screenOpen;
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

  const query = search.trim().toLowerCase();
  const visibleBots = query
    ? daemon.bots.filter((item) =>
        `${item.name} ${item.role ?? ""}`.toLowerCase().includes(query),
      )
    : daemon.bots;

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
    const controller = new AbortController();

    const load = async () => {
      if (inFlight || document.hidden) {
        return;
      }
      inFlight = true;
      try {
        const response = await fetch(
          `${DAEMON_HTTP_URL}/bots/${encodeURIComponent(bot.id)}/screen?t=${Date.now()}`,
          { signal: controller.signal },
        );
        if (cancelled) {
          return;
        }
        if (response.ok) {
          const blob = await response.blob();
          const capturedAt = response.headers.get("x-screen-captured-at");
          if (cancelled) {
            return;
          }
          setScreenImageUrl(URL.createObjectURL(blob));
          setScreenUpdatedAt(capturedAt ? Date.parse(capturedAt) : Date.now());
          setScreenVmState("running");
          setScreenError(null);
          setScreenStatus("live");
        } else {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
            state?: string;
          } | null;
          if (cancelled) {
            return;
          }
          setScreenVmState(body?.state ?? null);
          setScreenError(body?.error ?? `screen request failed (${response.status})`);
          setScreenStatus(response.status === 409 ? "vm-off" : "error");
        }
      } catch (error) {
        if (!cancelled && (error as Error).name !== "AbortError") {
          setScreenError((error as Error).message);
          setScreenStatus("error");
        }
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = setInterval(() => void load(), SCREEN_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
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
                title="New agent"
                aria-label="New agent"
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon />
              </button>
            </>
          )}
        </div>

        <div className="agent-list">
          {visibleBots.map((item) => {
            const thread = threadByBot.get(item.id);
            const preview = thread?.lastMessage?.trim();
            const subtitle =
              [item.role, preview].filter(Boolean).join(" · ") ||
              "No messages yet";
            const state = daemon.sandboxStates[item.id] ?? "stopped";
            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                className={`agent-row ${
                  item.id === daemon.selectedBotId ? "agent-row-selected" : ""
                }`}
                title={sidebarCollapsed ? item.name : undefined}
                onClick={() => daemon.selectBot(item.id)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Escape" &&
                    computerMenu?.botId === item.id
                  ) {
                    event.preventDefault();
                    setComputerMenu(null);
                    return;
                  }
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
                    <span className="agent-row-sub">{subtitle}</span>
                  </span>
                )}
                {!sidebarCollapsed && (
                  <button
                    className="agent-settings-button"
                    title="Computer settings"
                    aria-label={`Computer settings for ${item.name}`}
                    aria-haspopup="menu"
                    aria-expanded={computerMenu?.botId === item.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (item.id !== daemon.selectedBotId) {
                        daemon.selectBot(item.id);
                      }
                      const row = event.currentTarget.closest(".agent-row");
                      if (!row) {
                        return;
                      }
                      const rect = row.getBoundingClientRect();
                      setComputerMenu((current) =>
                        current?.botId === item.id
                          ? null
                          : {
                              botId: item.id,
                              top: rect.bottom + 6,
                              left: rect.left,
                              width: rect.width,
                            },
                      );
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
                {!sidebarCollapsed && computerMenu?.botId === item.id && (
                  <>
                    <div
                      className="computer-menu-backdrop"
                      onClick={(event) => {
                        event.stopPropagation();
                        setComputerMenu(null);
                      }}
                    />
                    <div
                      className="computer-menu"
                      role="menu"
                      style={{
                        top: computerMenu.top,
                        left: computerMenu.left,
                        width: computerMenu.width,
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        role="menuitemradio"
                        aria-checked={!isLocalBot(item)}
                        className={`computer-menu-item ${
                          !isLocalBot(item) ? "computer-menu-item-active" : ""
                        }`}
                        onClick={() => {
                          daemon.updateBotComputer(item.id, "firecracker");
                          setComputerMenu(null);
                        }}
                      >
                        <span>Firecracker microVM</span>
                        <span className="computer-menu-sub">
                          Isolated Linux computer
                        </span>
                      </button>
                      <button
                        role="menuitemradio"
                        aria-checked={isLocalBot(item)}
                        className={`computer-menu-item ${
                          isLocalBot(item) ? "computer-menu-item-active" : ""
                        }`}
                        onClick={() => {
                          daemon.updateBotComputer(item.id, "mac");
                          setComputerMenu(null);
                        }}
                      >
                        <span>This Mac</span>
                        <span className="computer-menu-sub">
                          Runs commands directly on this Mac
                        </span>
                      </button>
                      <div className="computer-menu-separator" />
                      {computerMenu.confirmDelete ? (
                        <div className="computer-menu-confirm">
                          <p className="computer-menu-confirm-text">
                            Delete {item.name}? Its computer and chat history
                            are removed.
                          </p>
                          <div className="computer-menu-confirm-actions">
                            <button
                              className="ghost-button"
                              onClick={() =>
                                setComputerMenu((current) =>
                                  current
                                    ? { ...current, confirmDelete: false }
                                    : current,
                                )
                              }
                            >
                              Cancel
                            </button>
                            <button
                              className="danger-button"
                              onClick={() => {
                                daemon.deleteBot(item.id);
                                setComputerMenu(null);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          role="menuitem"
                          className="computer-menu-item computer-menu-item-danger"
                          onClick={() =>
                            setComputerMenu((current) =>
                              current
                                ? { ...current, confirmDelete: true }
                                : current,
                            )
                          }
                        >
                          <span>Delete agent</span>
                          <span className="computer-menu-sub">
                            Removes its computer and chats
                          </span>
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {!sidebarCollapsed && visibleBots.length === 0 && (
            <p className="sidebar-empty">
              {query ? "No agents match your search." : "No agents yet."}
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

        <div className="transcript" ref={scrollRef}>
          <div className="transcript-inner">
            {daemon.messages.length === 0 && !streaming && (
              <div className="empty-state">
                <span className="empty-mark" style={{ background: bot?.color ?? avatarColor(bot?.id ?? "assistant") }}>
                  {bot?.avatar ?? initialOf(botName)}
                </span>
                <h1>Hand off the work.</h1>
                {hasUsableProvider ? (
                  <p>
                    {isLocalBot(bot)
                      ? "Give the bot a task. It can run commands directly on this Mac and come back with the result."
                      : "Give the bot a task. It can run commands on its own Linux computer and come back with the result."}
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

            {daemon.messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

            {activity.map((item) => (
              <ToolCard
                key={item.callId}
                name={item.name}
                arguments={item.arguments}
                status={item.status}
                ok={item.ok}
                output={item.output}
                durationMs={item.durationMs}
                artifacts={item.artifacts}
              />
            ))}

            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.requestId}
                approval={approval}
                onRespond={daemon.respondToApproval}
              />
            ))}

            {streaming && <StreamingRow streaming={streaming} />}
          </div>
        </div>

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
      </main>

      <PanelResizer active={screenOpen} />
      {screenOpen && (
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
            >
              {canStream && (
                <VncView url={vncUrl} active={vncActive} onState={setVncState} />
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
              {canStream && (
                <div className="screen-frame-actions">
                  <button
                    className="screen-action"
                    title={screenExpanded ? "Collapse (Esc)" : "Expand"}
                    aria-label={
                      screenExpanded
                        ? "Collapse desktop view"
                        : "Expand desktop view"
                    }
                    onClick={() => setScreenExpanded((value) => !value)}
                  >
                    {screenExpanded ? <CollapseIcon /> : <ExpandIcon />}
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
        codex={daemon.codex}
        theme={theme}
        onThemeChange={setTheme}
        onSaveProvider={daemon.saveProvider}
        onRemoveProvider={daemon.removeProvider}
        onUpdateSettings={daemon.updateSettings}
        onFetchModels={daemon.fetchModels}
      />
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
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
      {calls.map((call: ToolCallRecord, index: number) => (
        <ToolCard
          key={`${call.id}-${index}`}
          name={call.name}
          arguments={call.arguments}
          status="done"
          ok={call.ok}
          output={call.output}
          durationMs={call.durationMs}
          artifacts={call.artifacts}
        />
      ))}
      {message.content && (
        <div className="entry-body">
          <Markdown text={message.content} />
        </div>
      )}
    </div>
  );
}

function ToolCard({
  name,
  arguments: rawArguments,
  status,
  ok,
  output,
  durationMs,
  artifacts,
}: {
  name: string;
  arguments: string;
  status: "running" | "done";
  ok: boolean | null;
  output: string | null;
  durationMs: number | null;
  artifacts: ToolArtifact[] | null;
}) {
  const label = name === "shell" ? "Computer" : name;
  const detail = toolDetail(rawArguments);
  const local = output?.startsWith("[local Mac]") ?? false;
  const stateLabel =
    status === "running" ? "Running" : ok === null ? "Done" : ok ? "Done" : "Failed";
  const badgeClass =
    status === "running" ? "tool-running" : ok ? "tool-ok" : "tool-failed";

  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <span className="tool-card-heading">
          {local && <span className="tool-card-local">This Mac</span>}
          <span className="tool-card-title">{label}</span>
        </span>
        <span className={`tool-card-badge ${badgeClass}`}>
          {status === "running" && <span className="tool-card-dot" />}
          {stateLabel}
          {durationMs !== null && ` · ${durationMs} ms`}
        </span>
      </div>
      {detail && <pre className="tool-card-command">{detail}</pre>}
      {artifacts?.map((artifact) => (
        <img
          key={artifact.url}
          className="tool-card-image"
          src={`${DAEMON_HTTP_URL}${artifact.url}`}
          alt="Screenshot from the bot's computer"
        />
      ))}
      {output && (
        <details className="tool-card-output" open={output.length < 400}>
          <summary>Output</summary>
          <pre>{output}</pre>
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
        <pre className="tool-card-command">{detail}</pre>
      </div>
    );
  }

  return (
    <div className="approval-card">
      <div className="approval-title">Approval needed</div>
      <div className="approval-sub">
        The bot wants to run this on its computer:
      </div>
      <pre className="tool-card-command">{detail}</pre>
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

function StreamingRow({ streaming }: { streaming: StreamingState }) {
  if (!streaming.text) {
    return (
      <div className="entry entry-assistant">
        <div
          className="entry-body typing-bubble"
          role="status"
          aria-label="Assistant is typing"
        >
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      </div>
    );
  }

  return (
    <div className="entry entry-assistant">
      <div className="entry-body">
        <Markdown text={streaming.text} />
        <span className="caret" />
      </div>
    </div>
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
      aria-label="New agent"
      onClick={onClose}
    >
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-head-title">
            <span className="avatar avatar-lg" style={{ background: color }}>
              {avatar}
            </span>
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
