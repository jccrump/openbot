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

function GridIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2.4" width="4.6" height="4.6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.4" y="9" width="4.6" height="4.6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="4.6" height="4.6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 10.5V2.8M8 2.8 5.2 5.6M8 2.8l2.8 2.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 8.6v3.2c0 .9.7 1.6 1.6 1.6h6.8c.9 0 1.6-.7 1.6-1.6V8.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
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
  const [computerMenuOpen, setComputerMenuOpen] = useState(false);
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
  const sandboxState: SandboxState = bot
    ? (daemon.sandboxStates[bot.id] ?? "stopped")
    : "stopped";

  useEffect(() => {
    setComputerMenuOpen(false);
  }, [daemon.selectedBotId]);

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

  const screenArtifact = useMemo(() => {
    let found: ToolArtifact | null = null;
    for (const message of daemon.messages) {
      for (const call of message.toolCalls ?? []) {
        for (const artifact of call.artifacts ?? []) {
          found = artifact;
        }
      }
    }
    for (const item of activity) {
      for (const artifact of item.artifacts ?? []) {
        found = artifact;
      }
    }
    return found;
  }, [daemon.messages, activity]);

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
    streaming?.reasoning,
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
              <button
                key={item.id}
                className={`agent-row ${
                  item.id === daemon.selectedBotId ? "agent-row-selected" : ""
                }`}
                title={sidebarCollapsed ? item.name : undefined}
                onClick={() => daemon.selectBot(item.id)}
              >
                <AgentAvatar bot={item} />
                {!sidebarCollapsed && (
                  <span className="agent-row-body">
                    <span className="agent-row-name">{item.name}</span>
                    <span className="agent-row-sub">{subtitle}</span>
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
              </button>
            );
          })}
          {!sidebarCollapsed && visibleBots.length === 0 && (
            <p className="sidebar-empty">No agents match your search.</p>
          )}
        </div>

        <div className="sidebar-footer">
          <button
            className="sidebar-row sidebar-row-muted"
            disabled
            title="Marketplace — coming soon"
          >
            <GridIcon />
            {!sidebarCollapsed && (
              <>
                <span className="sidebar-row-label">Marketplace</span>
                <span className="badge">Soon</span>
              </>
            )}
          </button>
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
              className="icon-button icon-muted"
              title="Share — coming soon"
              aria-label="Share agent (coming soon)"
              disabled
            >
              <ShareIcon />
            </button>
            <label className="model-pill" title="Model">
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
            {daemon.harness.default === "codex" && (
              <span className="harness-pill" title="Codex harness">
                Codex
              </span>
            )}
            <div className="computer-control">
              <button
                className={`computer-pill computer-${
                  isLocalBot(bot) ? "local" : sandboxState
                }`}
                onClick={() => setComputerMenuOpen((value) => !value)}
                disabled={!bot}
                title="Change this agent's computer"
                aria-label="Change this agent's computer"
                aria-haspopup="menu"
                aria-expanded={computerMenuOpen}
              >
                <MonitorIcon />
                {computerLabel(bot, sandboxState)}
                <ChevronIcon />
              </button>
              {computerMenuOpen && bot && (
                <>
                  <div
                    className="computer-menu-backdrop"
                    onClick={() => setComputerMenuOpen(false)}
                  />
                  <div className="computer-menu" role="menu">
                    <button
                      role="menuitemradio"
                      aria-checked={!isLocalBot(bot)}
                      className={`computer-menu-item ${
                        !isLocalBot(bot) ? "computer-menu-item-active" : ""
                      }`}
                      onClick={() => {
                        daemon.updateBotComputer(bot.id, "firecracker");
                        setComputerMenuOpen(false);
                      }}
                    >
                      <span>Firecracker microVM</span>
                      <span className="computer-menu-sub">
                        Isolated Linux computer
                      </span>
                    </button>
                    <button
                      role="menuitemradio"
                      aria-checked={isLocalBot(bot)}
                      className={`computer-menu-item ${
                        isLocalBot(bot) ? "computer-menu-item-active" : ""
                      }`}
                      onClick={() => {
                        daemon.updateBotComputer(bot.id, "mac");
                        setComputerMenuOpen(false);
                      }}
                    >
                      <span>This Mac</span>
                      <span className="computer-menu-sub">
                        Runs commands directly on this Mac
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
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

            {streaming && (
              <StreamingRow
                streaming={streaming}
                color={bot?.color ?? avatarColor(bot?.id ?? "assistant")}
                botName={botName}
                avatar={bot?.avatar ?? null}
              />
            )}
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

      <aside className="screen-panel">
        <section className="screen-view">
          <div className="screen-frame">
            {screenArtifact ? (
              <img
                className="screen-image"
                src={`${DAEMON_HTTP_URL}${screenArtifact.url}`}
                alt={`${botName}'s screen`}
              />
            ) : (
              <div className="screen-empty">
                <MonitorIcon />
                <span>No screen activity yet</span>
              </div>
            )}
          </div>
          <div className="screen-caption">{botName}&rsquo;s screen</div>
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

function StreamingRow({
  streaming,
  color,
  botName,
  avatar,
}: {
  streaming: StreamingState;
  color: string;
  botName: string;
  avatar: string | null;
}) {
  if (!streaming.text && !streaming.reasoning) {
    return (
      <div className="pending">
        <span className="avatar avatar-lg" style={{ background: color }}>
          {avatar ?? initialOf(botName)}
        </span>
        <span className="pending-label">Thinking</span>
      </div>
    );
  }

  return (
    <div className="entry entry-assistant">
      {streaming.reasoning && (
        <details className="reasoning">
          <summary>Reasoning</summary>
          <div>{streaming.reasoning}</div>
        </details>
      )}
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
