import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  createReadStream,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  createHashEmbeddingClient,
  createOpenAIEmbeddingClient,
  fetchModels,
  noul,
  type EmbeddingClient,
  type ProviderPreset,
} from "@openbot/gateway";
import {
  ClientMessageSchema,
  botHasComputer,
  primaryComputer,
  type Bot,
  type ChatBusyBehavior,
  type CompactionSettings,
  type ComputerKind,
  type HarnessSettings,
  type Memory,
  type Message,
  type ModelRef,
  type PolicyRule,
  type PolicySettings,
  type RoutineRef,
  type ServerMessage,
  type Thread,
} from "@openbot/protocol";
import type { SandboxBackend } from "@openbot/sandbox";
import { runAgent, type AgentDeps } from "./agent";
import type { ApprovalBroker } from "./approvals";
import type { ChallengeBroker } from "./challenges";
import { CodexDetector, runCodexTurn } from "./codex";
import {
  COMPACTION_SETTING_KEY,
  parseCompactionSettings,
} from "./compaction";
import type { OpenBotConfig } from "./config";
import {
  DECISION_SETTING_KEY,
  decisionInfo,
  decisionRuntime,
  normalizeDecisionSettings,
  parseDecisionSettings,
  type DecisionSettings,
} from "./decision";
import {
  HARNESS_SETTING_KEY,
  parseHarnessId,
  parseHarnessSettings,
} from "./harness";
import {
  listComputerFiles,
  macRoot,
  readComputerFile,
  type FileServiceOptions,
} from "./files";
import { MemoryService } from "./memory";
import {
  normalizePolicy,
  parsePolicy,
  POLICY_SETTING_KEY,
  policyPreset,
  serializePolicy,
} from "./policy";
import { Reflector } from "./reflection";
import {
  computerLabel,
  RoutineService,
  type RoutineStartInput,
  type RoutineStartResult,
} from "./routines";
import { SoulService } from "./soul";
import type { ProviderRegistry } from "./provider-registry";
import {
  systemPromptForBot,
  type MemoryRecord,
  type Store,
} from "./store";
import { captureScreen } from "./tools";
import { WorkspaceService } from "./workspaces";
import type { SelfInfo } from "./self";
import { collectAccessReport, openPrivacyPane } from "./access";

const SCREEN_CACHE_MS = 1000;

const SCREEN_ALLOWED_ORIGINS = new Set([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

class ScreenError extends Error {
  status: number;
  state: string | null;

  constructor(message: string, status: number, state: string | null = null) {
    super(message);
    this.status = status;
    this.state = state;
  }
}

function screenCorsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !SCREEN_ALLOWED_ORIGINS.has(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "x-screen-captured-at",
    vary: "origin",
  };
}

export interface DaemonOptions {
  config: OpenBotConfig;
  store: Store;
  registry: ProviderRegistry;
  sandbox: SandboxBackend | null;
  approvals: ApprovalBroker;
  challenges: ChallengeBroker;
  presets: ProviderPreset[];
  workspaces: WorkspaceService;
  /** Collected once at startup; system_info and the agent's [self] note use it. */
  self: SelfInfo;
}

export interface Daemon {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

const DEFAULT_MODEL_KEY = "defaultModel";
const REQUIRE_APPROVAL_KEY = "requireApproval";
const CHAT_BUSY_BEHAVIOR_KEY = "chatBusyBehavior";
const VNC_BUFFER_HIGH_WATER_BYTES = 256 * 1024;

/** Live run bookkeeping: a run can accept steering when it is a chat turn on
 * the built-in harness. */
interface RunHandle {
  runId: string;
  controller: AbortController;
  botId: string;
  threadId: string | null;
  steerable: boolean;
  steering: string[];
}

interface QueuedChat {
  id: string;
  botId: string;
  text: string;
  model?: ModelRef;
}

export function createDaemon(options: DaemonOptions): Daemon {
  const runs = new Map<string, RunHandle>();
  const threadQueues = new Map<string, QueuedChat[]>();
  // Threads whose clear must wait for the active run to unwind, so the
  // cancelled turn's own messages are folded with the rest.
  const pendingClears = new Set<string>();
  const pending = new Set<Promise<void>>();

  const artifactsDir = join(options.config.dataDir, "artifacts");

  // macOS attributes TCC grants to the app that launched the daemon, not the
  // daemon itself; say which one that is so the user checks the right row.
  const accessOwner = (): string =>
    options.self.runMode === "dev"
      ? "the app that launched the daemon (Terminal in development)"
      : "OpenBot";

  const toMemoryInfo = (record: MemoryRecord): Memory => {
    const {
      embedding: _embedding,
      embeddingModel: _embeddingModel,
      ...memory
    } = record;
    return memory;
  };

  interface ScreenFrame {
    png: Buffer;
    capturedAt: string;
  }

  const screenCache = new Map<string, ScreenFrame>();
  const screenInFlight = new Map<string, Promise<ScreenFrame>>();

  const screenFrame = async (botId: string): Promise<ScreenFrame> => {
    const cached = screenCache.get(botId);
    if (cached && Date.now() - Date.parse(cached.capturedAt) < SCREEN_CACHE_MS) {
      return cached;
    }
    const inFlight = screenInFlight.get(botId);
    if (inFlight) {
      return inFlight;
    }
    const sandbox = options.sandbox;
    if (!sandbox) {
      throw new ScreenError("sandbox is not available", 503);
    }
    const status = await sandbox.status(botId);
    if (status.state !== "running") {
      throw new ScreenError("agent's VM is not running", 409, status.state);
    }
    const task = captureScreen(sandbox, botId)
      .then((png) => {
        const frame = { png, capturedAt: new Date().toISOString() };
        screenCache.set(botId, frame);
        return frame;
      })
      .finally(() => {
        screenInFlight.delete(botId);
      });
    screenInFlight.set(botId, task);
    return task;
  };

  const readPolicySettings = (): PolicySettings =>
    parsePolicy(options.store.getSetting(POLICY_SETTING_KEY));

  /**
   * Remember an approved tool as an auto rule so it stops asking. Deny rules
   * and more specific rules still win, since the strictest matched rule
   * decides (ADR-018).
   */
  const rememberApprovedTool = (requestId: string): boolean => {
    const record = options.store
      .listPendingApprovals()
      .find((approval) => approval.requestId === requestId);
    if (!record) {
      return false;
    }
    const policy = readPolicySettings();
    const existing = policy.rules.some(
      (rule) =>
        rule.tool === record.tool &&
        rule.match === "any" &&
        rule.tier === "auto",
    );
    if (existing) {
      return true;
    }
    const rule: PolicyRule = {
      id: `remember-${record.tool}-${Math.random().toString(36).slice(2, 8)}`,
      tool: record.tool,
      scope: "*",
      match: "any",
      pattern: "",
      tier: "auto",
      note: "remembered after you approved it",
    };
    options.store.setSetting(
      POLICY_SETTING_KEY,
      serializePolicy({ ...policy, rules: [...policy.rules, rule] }),
    );
    return true;
  };

  const readCompactionSettings = (): CompactionSettings => {
    const stored = options.store.getSetting(COMPACTION_SETTING_KEY);
    if (stored !== null) {
      return parseCompactionSettings(stored);
    }
    return options.config.compaction;
  };

  const readHarnessSettings = (): HarnessSettings => {
    const stored = options.store.getSetting(HARNESS_SETTING_KEY);
    if (stored !== null) {
      return parseHarnessSettings(stored);
    }
    return options.config.harness;
  };

  const readDecisionSettings = (): DecisionSettings => {
    const stored = options.store.getSetting(DECISION_SETTING_KEY);
    if (stored !== null) {
      return parseDecisionSettings(stored);
    }
    return options.config.decision;
  };

  const codex = new CodexDetector();

  const fileOptions: FileServiceOptions = {
    dataDir: options.config.dataDir,
    artifactsDir,
    sandbox: options.sandbox,
    getBot: (botId) => options.store.getBot(botId),
    getWorkspace: (workspaceId) => options.workspaces.get(workspaceId),
  };

  const deps: AgentDeps = {
    store: options.store,
    providers: options.registry.map,
    sandbox: options.sandbox,
    approvals: options.approvals,
    challenges: options.challenges,
    requireApproval: options.config.requireApproval,
    artifactsDir,
    compaction: () => readCompactionSettings(),
    decision: () => decisionRuntime(readDecisionSettings(), process.env),
    sandboxUrl: options.config.sandboxUrl,
    dataDir: options.config.dataDir,
    providerRecord: (id) => options.store.getProvider(id),
    resolveProviderKey: (record) => options.registry.resolveKey(record),
    policy: () => readPolicySettings(),
    self: options.self,
  };

  const readDefaultModel = (): ModelRef => {
    const stored = options.store.getSetting(DEFAULT_MODEL_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as ModelRef;
        if (options.registry.map.has(parsed.provider)) {
          return parsed;
        }
      } catch {
        // fall through to fallback
      }
    }
    const first = options.registry
      .list()
      .find((provider) => provider.enabled && provider.models.length > 0);
    if (first) {
      return { provider: first.id, model: first.models[0]! };
    }
    return options.config.defaultModel;
  };

  const readRequireApproval = (): boolean => {
    const stored = options.store.getSetting(REQUIRE_APPROVAL_KEY);
    if (stored === null) {
      return options.config.requireApproval;
    }
    return stored !== "false";
  };

  const writeRequireApproval = (value: boolean): void => {
    options.store.setSetting(REQUIRE_APPROVAL_KEY, value ? "true" : "false");
    deps.requireApproval = value;
  };

  const readChatBusyBehavior = (): ChatBusyBehavior => {
    const stored = options.store.getSetting(CHAT_BUSY_BEHAVIOR_KEY);
    if (stored === "steer" || stored === "queue") {
      return stored;
    }
    return options.config.chatBusyBehavior;
  };

  const broadcast = (message: ServerMessage) => {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  };

  const providersUpdated = () => {
    broadcast({
      type: "providers.updated",
      providers: options.registry.infos(),
      defaultModel: readDefaultModel(),
      requireApproval: readRequireApproval(),
      policy: readPolicySettings(),
      compaction: readCompactionSettings(),
      harness: readHarnessSettings(),
      decision: decisionInfo(readDecisionSettings(), process.env),
      codex: codex.info(),
      chatBusyBehavior: readChatBusyBehavior(),
    });
  };

  deps.requireApproval = readRequireApproval();

  const activeRunForThread = (threadId: string): RunHandle | null => {
    for (const run of runs.values()) {
      if (run.threadId === threadId) {
        return run;
      }
    }
    return null;
  };

  const resolveChatThread = (botId: string, threadId?: string): Thread => {
    const requested = threadId ? options.store.getThread(threadId) : null;
    if (requested && requested.botId === botId) {
      return requested;
    }
    if (!threadId) {
      for (const run of runs.values()) {
        if (run.botId !== botId || run.threadId === null) {
          continue;
        }
        const active = options.store.getThread(run.threadId);
        if (active) {
          return active;
        }
      }
    }
    return options.store.getOrCreateThread(botId);
  };

  // A queued message is held in memory until the thread's active run stops:
  // it must not land in the transcript early, or the running turn would read
  // it as already delivered.
  const drainThreadQueue = (threadId: string): void => {
    if (activeRunForThread(threadId)) {
      return;
    }
    const queue = threadQueues.get(threadId);
    if (!queue || queue.length === 0) {
      return;
    }
    const next = queue.shift();
    if (!next) {
      return;
    }
    if (queue.length === 0) {
      threadQueues.delete(threadId);
    }
    broadcast({ type: "chat.dequeued", threadId, messageId: next.id });
    startRun({
      botId: next.botId,
      threadId,
      text: next.text,
      ...(next.model ? { model: next.model } : {}),
      messageId: next.id,
    });
  };

  // Fold the thread's transcript away so the next turn starts from the system
  // prompt, soul, and memory only. Folded messages stay in the database, feed
  // memory extraction, and remain readable through thread.messages with
  // includeFolded.
  const clearThreadNow = (threadId: string): void => {
    const queue = threadQueues.get(threadId);
    if (queue) {
      threadQueues.delete(threadId);
      for (const item of queue) {
        broadcast({ type: "chat.dequeued", threadId, messageId: item.id });
      }
    }
    const cleared = options.store.clearThread(threadId);
    if (!cleared) {
      return;
    }
    broadcast({ type: "thread.cleared", threadId, thread: cleared });
    reflector.schedule();
  };

  const dropQueuedChats = (botId: string): void => {
    for (const [threadId, queue] of threadQueues) {
      const remaining = queue.filter((item) => item.botId !== botId);
      if (remaining.length === 0) {
        threadQueues.delete(threadId);
      } else {
        threadQueues.set(threadId, remaining);
      }
    }
  };

  const startRun = (input: {
    botId: string;
    threadId: string;
    text: string;
    model?: ModelRef;
    messageId?: string;
    skipUserMessage?: boolean;
    contextNote?: string;
    /** Run on one of the agent's computers instead of its primary. */
    computer?: ComputerKind;
    /** Set when a routine's brief started this turn. */
    routine?: RoutineRef | null;
    onSettled?: (outcome: { ok: boolean; error: string | null }) => void;
  }): void => {
    const runId = randomUUID();
    const controller = new AbortController();
    const handle: RunHandle = {
      runId,
      controller,
      botId: input.botId,
      threadId: input.threadId,
      steerable: false,
      steering: [],
    };
    runs.set(runId, handle);

    const harness = readHarnessSettings();
    const useCodex = harness.default === "codex";
    const run = useCodex ? runCodexTurn : runAgent;
    handle.steerable = !useCodex;
    let runError: string | null = null;
    const task = run(
      deps,
      {
        runId,
        botId: input.botId,
        threadId: input.threadId,
        text: input.text,
        model: input.model,
        messageId: input.messageId,
        skipUserMessage: input.skipUserMessage,
        contextNote: input.contextNote,
        computer: input.computer,
        routine: input.routine ?? null,
        steering: {
          hasPending: () => handle.steering.length > 0,
          drain: () => handle.steering.splice(0),
        },
      },
      broadcast,
      controller.signal,
    )
      .catch((error) => {
        runError = (error as Error).message;
        broadcast({
          type: "chat.error",
          runId,
          message: runError,
        });
      })
      .finally(() => {
        runs.delete(runId);
        pending.delete(task);
        input.onSettled?.({
          ok: runError === null && !controller.signal.aborted,
          error: runError,
        });
        reflector.schedule();
        // A steer that arrived after the last step never made it into the
        // turn; answer it with a fresh run so it is not left hanging.
        if (!controller.signal.aborted && handle.steering.length > 0) {
          const leftover = handle.steering.splice(0);
          startRun({
            botId: input.botId,
            threadId: input.threadId,
            text: leftover.join("\n\n"),
            skipUserMessage: true,
          });
          return;
        }
        // A clear requested mid-run folds the transcript only now, so the
        // cancelled turn's own messages go with it.
        if (pendingClears.delete(input.threadId)) {
          clearThreadNow(input.threadId);
        }
        drainThreadQueue(input.threadId);
        maybeRestart();
      });
    pending.add(task);
  };

  // --- Self-restart (ADR-024) ---------------------------------------------
  // The agent can ask the daemon to restart so its own code changes take
  // effect. The restart waits for the current turn and running work, then
  // exits; a watcher, the app, or a detached re-exec brings it back. A guard
  // file refuses a restart loop.
  const RESTART_GUARD_FILE = join(options.config.dataDir, "restart-guard.json");
  const RESTART_WINDOW_MS = 10 * 60_000;
  const RESTART_LIMIT = 3;
  let restartPending: "watch" | "reexec" | "exit" | null = null;
  let restartTimer: ReturnType<typeof setInterval> | null = null;

  const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`;

  const recentRestarts = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(RESTART_GUARD_FILE, "utf8"),
      );
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      // no guard file yet
    }
    return [];
  };

  const performRestart = (mode: "watch" | "reexec" | "exit"): void => {
    console.info("daemon.restart", { mode, pid: process.pid });
    if (mode === "watch") {
      // tsx watch only reruns on a file change; touch the entry to trigger it.
      spawn(
        "/bin/sh",
        ["-c", `sleep 1; touch ${shellQuote(options.self.daemonEntry)}`],
        { detached: true, stdio: "ignore" },
      ).unref();
    } else if (mode === "reexec") {
      const command = [
        process.execPath,
        ...process.execArgv,
        ...process.argv.slice(1),
      ]
        .map(shellQuote)
        .join(" ");
      spawn("/bin/sh", ["-c", `sleep 1; exec ${command}`], {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: "ignore",
      }).unref();
    }
    setTimeout(() => process.exit(0), 300);
  };

  const maybeRestart = (): void => {
    if (!restartPending) {
      return;
    }
    if (runs.size > 0 || pending.size > 0) {
      return;
    }
    const mode = restartPending;
    restartPending = null;
    if (restartTimer) {
      clearInterval(restartTimer);
      restartTimer = null;
    }
    performRestart(mode);
  };

  const scheduleRestart = (): { ok: boolean; message: string } => {
    if (restartPending) {
      return {
        ok: true,
        message:
          "A restart is already scheduled; it runs when the current work settles.",
      };
    }
    const now = Date.now();
    const recent = recentRestarts().filter(
      (stamp) => now - Date.parse(stamp) < RESTART_WINDOW_MS,
    );
    if (recent.length >= RESTART_LIMIT) {
      return {
        ok: false,
        message:
          `Refusing to restart: the daemon restarted ${recent.length} times ` +
          "in the last 10 minutes. Check the daemon log, fix the cause, and " +
          "restart it manually.",
      };
    }
    try {
      writeFileSync(
        RESTART_GUARD_FILE,
        JSON.stringify([...recent, new Date(now).toISOString()]),
      );
    } catch {
      // best effort; the guard is advisory
    }
    const mode =
      options.self.supervised === "app"
        ? "exit"
        : options.self.supervised === "watch"
          ? "watch"
          : "reexec";
    restartPending = mode;
    restartTimer = setInterval(maybeRestart, 2_000);
    restartTimer.unref();
    return {
      ok: true,
      message:
        "Restart scheduled. This turn finishes first and running work " +
        "settles, then " +
        (mode === "watch"
          ? "the dev watcher restarts the daemon."
          : mode === "exit"
            ? "the app restarts the daemon."
            : "the daemon restarts itself.") +
        " The conversation is preserved.",
    };
  };
  deps.requestRestart = scheduleRestart;

  options.approvals.setOnSettled((record) => {
    broadcast({
      type: "approval.resolved",
      requestId: record.requestId,
      decision: record.decision ?? "deny",
      reason: record.reason,
    });
  });

  // Memory, soul, and the background reflection pass.
  const embeddingClient = (): EmbeddingClient => {
    const stored = options.store.getSetting("embedding");
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as {
          provider?: string;
          model?: string;
        };
        if (parsed.provider && parsed.model) {
          const record = options.store.getProvider(parsed.provider);
          if (record) {
            return createOpenAIEmbeddingClient({
              baseUrl: record.baseUrl,
              apiKey: options.registry.resolveKey(record),
              model: parsed.model,
            });
          }
        }
      } catch {
        // fall through to the offline embeddings
      }
    }
    return createHashEmbeddingClient();
  };
  const memory = new MemoryService(options.store, embeddingClient);
  const soul = new SoulService(options.store);
  const reflector = new Reflector({
    store: options.store,
    memory,
    soul,
    providers: options.registry.map,
  });
  deps.memory = memory;
  deps.soul = soul;

  // Routines (ADR-027): agent-owned scheduled spawns. A routine fires its
  // brief as a turn in the agent's thread on the routine's computer — the
  // microVM or This Mac — but only while the agent still has that computer.
  const broadcastRoutines = (): void => {
    broadcast({ type: "routines", routines: options.store.listRoutines() });
  };

  const startRoutineRun = (input: RoutineStartInput): RoutineStartResult => {
    const bot = options.store.getBot(input.routine.botId);
    if (!bot) {
      return { ok: false, message: "the agent no longer exists" };
    }
    if (!botHasComputer(bot, input.routine.computer)) {
      return {
        ok: false,
        message:
          `the agent no longer has access to ` +
          computerLabel(input.routine.computer),
      };
    }
    if (activeRunForThread(input.threadId)) {
      return { ok: false, retry: true, message: "the agent is busy" };
    }
    const routine: RoutineRef = {
      id: input.routine.id,
      name: input.routine.name,
      runId: input.runId,
    };
    startRun({
      botId: bot.id,
      threadId: input.threadId,
      text: input.routine.brief,
      computer: input.routine.computer,
      routine,
      contextNote:
        `[routine] This turn was started by your scheduled routine ` +
        `"${input.routine.name}". The user did not type this brief; it is a ` +
        "standing instruction. Work autonomously, do not ask the user unless " +
        "you are genuinely blocked, and finish with a short report of what " +
        "you did or found.",
      onSettled: (outcome) => {
        options.store.finishRoutineRun(
          input.runId,
          outcome.ok ? "ok" : "error",
          outcome.ok
            ? null
            : (outcome.error ?? "the run was stopped before it finished"),
        );
        broadcastRoutines();
      },
    });
    return { ok: true };
  };

  const routines = new RoutineService({
    store: options.store,
    start: startRoutineRun,
    changed: broadcastRoutines,
    ...(options.config.routineTickMs
      ? { tickMs: options.config.routineTickMs }
      : {}),
  });

  const codexTimer = setInterval(() => {
    void codex.refresh();
  }, 30_000);
  codexTimer.unref();

  let sandboxAvailable = false;
  let sandboxPruned = false;
  // A delete that races a daemon or host restart can leave a multi-GB rootfs
  // behind. Once the host answers, remove every computer this daemon owns that
  // is no longer a bot.
  const pruneSandboxOrphans = async () => {
    const sandbox = options.sandbox;
    if (!sandbox) {
      return;
    }
    try {
      const keep = options.store.listBots().map((bot) => bot.id);
      const { removed } = await sandbox.prune(keep);
      if (removed.length) {
        console.log(
          `sandbox: pruned ${removed.length} orphaned computer(s): ${removed.join(", ")}`,
        );
      }
    } catch (error) {
      console.warn(`sandbox prune failed: ${(error as Error).message}`);
    }
  };
  const checkSandbox = async () => {
    let available = false;
    if (options.sandbox) {
      try {
        const response = await fetch(
          `${options.config.sandboxUrl.replace(/\/+$/, "")}/health`,
          { signal: AbortSignal.timeout(1500) },
        );
        available = response.ok;
      } catch {
        available = false;
      }
    }
    deps.sandbox = available ? options.sandbox : null;
    if (available !== sandboxAvailable) {
      sandboxAvailable = available;
      console.log(
        `sandbox: ${available ? "available" : "unavailable"} (${options.config.sandboxUrl})`,
      );
    }
    if (available && !sandboxPruned) {
      sandboxPruned = true;
      await pruneSandboxOrphans();
    }
  };
  void checkSandbox();
  const sandboxTimer = setInterval(checkSandbox, 30_000);
  sandboxTimer.unref();

  const httpServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, name: "openbotd" }));
      return;
    }
    const botScreenMatch = /^\/bots\/([^/]+)\/screen$/.exec(url.pathname);
    if (request.method === "GET" && botScreenMatch !== null) {
      const cors = screenCorsHeaders(request.headers.origin);
      const id = decodeURIComponent(botScreenMatch[1] ?? "");
      const sendError = (status: number, payload: Record<string, unknown>) => {
        const body = JSON.stringify(payload);
        response.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...cors,
        });
        response.end(body);
      };
      const bot = options.store.getBot(id);
      if (!bot) {
        sendError(404, { error: `unknown bot: ${id}` });
        return;
      }
      if (!botHasComputer(bot, "firecracker")) {
        sendError(409, {
          error: "screen capture is only available for microVM computers",
          code: "mac",
        });
        return;
      }
      try {
        const frame = await screenFrame(id);
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": frame.png.length,
          "cache-control": "no-store",
          "x-screen-captured-at": frame.capturedAt,
          ...cors,
        });
        response.end(frame.png);
      } catch (error) {
        const screenError = error instanceof ScreenError ? error : null;
        sendError(screenError?.status ?? 502, {
          error: (error as Error).message,
          ...(screenError?.state ? { state: screenError.state } : {}),
        });
      }
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/artifacts/")
    ) {
      const name = url.pathname.slice("/artifacts/".length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        response.writeHead(400);
        response.end();
        return;
      }
      const file = join(artifactsDir, name);
      if (!existsSync(file)) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
      });
      createReadStream(file).pipe(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  const vncWss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });

  const proxySandboxStream = (
    botId: string,
    channel: "vnc" | "terminal",
    client: WebSocket,
  ) => {
    const base = options.config.sandboxUrl
      .replace(/\/+$/, "")
      .replace(/^http/, "ws");
    const upstream = new WebSocket(
      `${base}/vms/${encodeURIComponent(botId)}/${channel}`,
    );
    let closed = false;
    let drainTimer: ReturnType<typeof setInterval> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const shutdown = (code?: number, reason?: string) => {
      if (closed) return;
      closed = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
      else if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
      try {
        client.close(code, reason);
      } catch {
        // already closed
      }
    };

    connectTimer = setTimeout(() => {
      shutdown(1013, `sandbox ${channel} connection timed out`);
    }, 15_000);

    const relay = (from: WebSocket, to: WebSocket) => {
      from.on("message", (data, isBinary) => {
        if (to.readyState !== to.OPEN) return;
        to.send(data, { binary: isBinary }, (error) => {
          if (error) shutdown(1011, `${channel} relay failed`);
        });
        if (to.bufferedAmount > VNC_BUFFER_HIGH_WATER_BYTES) from.pause();
      });
    };

    const pendingToUpstream: Array<{
      data: WebSocket.RawData;
      isBinary: boolean;
    }> = [];
    client.on("message", (data, isBinary) => {
      if (upstream.readyState !== WebSocket.OPEN) {
        pendingToUpstream.push({ data, isBinary });
        return;
      }
      upstream.send(data, { binary: isBinary }, (error) => {
        if (error) shutdown(1011, `${channel} relay failed`);
      });
      if (upstream.bufferedAmount > VNC_BUFFER_HIGH_WATER_BYTES) client.pause();
    });

    upstream.on("open", () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      for (const message of pendingToUpstream.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary });
      }
      relay(upstream, client);
      drainTimer = setInterval(() => {
        if (closed) return;
        if (
          client.isPaused &&
          upstream.readyState === upstream.OPEN &&
          upstream.bufferedAmount < VNC_BUFFER_HIGH_WATER_BYTES
        ) {
          client.resume();
        }
        if (
          upstream.isPaused &&
          client.readyState === client.OPEN &&
          client.bufferedAmount < VNC_BUFFER_HIGH_WATER_BYTES
        ) {
          upstream.resume();
        }
      }, 5);
    });
    upstream.on("unexpected-response", (_request, response) => {
      shutdown(
        1013,
        `sandbox host rejected ${channel} (${response.statusCode})`,
      );
    });
    upstream.on("error", () => shutdown(1013, "sandbox host unreachable"));
    upstream.on("close", () => shutdown(1011, "sandbox stream closed"));
    client.on("close", () => shutdown());
    client.on("error", () => shutdown());
  };

  const proxyVnc = (botId: string, client: WebSocket) =>
    proxySandboxStream(botId, "vnc", client);
  const proxyTerminal = (botId: string, client: WebSocket) =>
    proxySandboxStream(botId, "terminal", client);

  /**
   * A local terminal for a This Mac agent: an interactive shell in the agent's
   * project folder (its Mac root), streamed over the same newline-delimited
   * JSON frame protocol the sandbox terminal uses. `expect` gives the shell a
   * real PTY (so the user's prompt, colors, and job control behave like
   * Terminal); it is part of the macOS base install.
   */
  const proxyLocalTerminal = (botId: string, client: WebSocket) => {
    const bot = options.store.getBot(botId);
    if (!bot) {
      client.close(1011, "unknown bot");
      return;
    }
    const root = macRoot(fileOptions, bot);
    const cwd = existsSync(root) ? root : homedir();
    const shell = process.env.SHELL || "/bin/zsh";
    let child: ReturnType<typeof spawn> | null = null;
    let closed = false;
    let started = false;
    const pendingInput: Buffer[] = [];

    const sendFrame = (frame: Record<string, unknown>) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(`${JSON.stringify(frame)}\n`);
      }
    };

    const shutdown = (code?: number, reason?: string) => {
      if (closed) {
        return;
      }
      closed = true;
      if (child && child.exitCode === null) {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // no process group
          }
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      try {
        client.close(code, reason);
      } catch {
        // already closed
      }
    };

    const start = (cols: number, rows: number) => {
      if (started) {
        return;
      }
      started = true;
      const safeCols =
        Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 80;
      const safeRows =
        Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
      const expectScript =
        `set stty_init "rows ${safeRows} cols ${safeCols}"; ` +
        `spawn -noecho {${shell}} -l; interact`;
      child = spawn("/usr/bin/expect", ["-c", expectScript], {
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      const relay = (chunk: Buffer) => {
        sendFrame({ type: "data", data: chunk.toString("base64") });
      };
      child.stdout?.on("data", relay);
      child.stderr?.on("data", relay);
      child.once("error", (error) => {
        relay(
          Buffer.from(
            `\r\n[terminal error: ${(error as Error).message}]\r\n`,
            "utf8",
          ),
        );
        sendFrame({ type: "exit" });
        shutdown(1011, "terminal failed");
      });
      child.once("close", () => {
        sendFrame({ type: "exit" });
        shutdown(1000);
      });

      for (const chunk of pendingInput.splice(0)) {
        child.stdin?.write(chunk);
      }
    };

    client.on("message", (raw) => {
      for (const line of raw.toString().split("\n")) {
        if (!line.trim()) {
          continue;
        }
        let frame: {
          type?: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          continue;
        }
        if (frame.type === "open") {
          start(frame.cols ?? 80, frame.rows ?? 24);
        } else if (frame.type === "input" && typeof frame.data === "string") {
          const chunk = Buffer.from(frame.data, "base64");
          if (started) {
            child?.stdin?.write(chunk);
          } else {
            pendingInput.push(chunk);
          }
        }
        // `resize` is a no-op: the PTY size is fixed when the shell spawns.
      }
    });
    client.on("close", () => shutdown());
    client.on("error", () => shutdown());
  };

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });
      return;
    }
    const reject = (status: number, message: string) => {
      socket.write(
        `HTTP/1.1 ${status} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
      );
      socket.destroy();
    };
    const originAllowed =
      !request.headers.origin ||
      SCREEN_ALLOWED_ORIGINS.has(request.headers.origin);

    const botTerminalMatch = /^\/bots\/([^/]+)\/terminal$/.exec(url.pathname);
    if (botTerminalMatch) {
      if (!originAllowed) {
        reject(403, "Forbidden");
        return;
      }
      const botId = decodeURIComponent(botTerminalMatch[1] ?? "");
      const bot = options.store.getBot(botId);
      if (!bot) {
        reject(404, "Not Found");
        return;
      }
      const requested = url.searchParams.get("computer");
      const computer: ComputerKind =
        requested === "mac" || requested === "firecracker"
          ? requested
          : primaryComputer(bot);
      if (!botHasComputer(bot, computer)) {
        reject(409, "Conflict");
        return;
      }
      if (computer === "mac") {
        terminalWss.handleUpgrade(request, socket, head, (client) => {
          proxyLocalTerminal(botId, client);
        });
        return;
      }
      if (!sandboxAvailable || !options.sandbox) {
        reject(503, "Service Unavailable");
        return;
      }
      terminalWss.handleUpgrade(request, socket, head, (client) => {
        proxyTerminal(botId, client);
      });
      return;
    }

    const botVncMatch = /^\/bots\/([^/]+)\/vnc$/.exec(url.pathname);
    if (!botVncMatch) {
      socket.destroy();
      return;
    }
    const vncId = decodeURIComponent(botVncMatch[1] ?? "");
    if (!originAllowed) {
      reject(403, "Forbidden");
      return;
    }
    const bot = options.store.getBot(vncId);
    if (!bot) {
      reject(404, "Not Found");
      return;
    }
    if (!botHasComputer(bot, "firecracker")) {
      reject(409, "Conflict");
      return;
    }
    if (!sandboxAvailable || !options.sandbox) {
      reject(503, "Service Unavailable");
      return;
    }
    vncWss.handleUpgrade(request, socket, head, (client) => {
      proxyVnc(vncId, client);
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    send({
      type: "hello",
      bots: options.store.listBots(),
      threads: options.store.listThreads(),
      providers: options.registry.infos(),
      presets: options.presets,
      defaultModel: readDefaultModel(),
      requireApproval: readRequireApproval(),
      policy: readPolicySettings(),
      compaction: readCompactionSettings(),
      harness: readHarnessSettings(),
      decision: decisionInfo(readDecisionSettings(), process.env),
      codex: codex.info(),
      chatBusyBehavior: readChatBusyBehavior(),
      workspaces: options.workspaces.list(),
      workspaceRoots: options.workspaces.roots(),
      routines: options.store.listRoutines(),
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = ClientMessageSchema.parse(JSON.parse(String(raw)));
      } catch {
        send({ type: "chat.error", message: "invalid client message" });
        return;
      }

      switch (message.type) {
        case "hello":
          return;
        case "bots.create": {
          const bot = options.store.createBot({
            name: message.name.trim(),
            systemPrompt: systemPromptForBot(
              message.name.trim(),
              message.role ?? null,
            ),
            model: message.model ?? readDefaultModel(),
            role: message.role ?? null,
            avatar: message.avatar ?? null,
            color: message.color ?? null,
            computers: message.computers,
            workspaceId: message.workspaceId ?? null,
            access: message.access,
            policy: message.policy ?? "inherit",
          });
          broadcast({ type: "bot.created", requestId: message.requestId, bot });
          return;
        }
        case "bots.update": {
          const patch: Parameters<typeof options.store.updateBot>[1] = {};
          if (message.name !== undefined) patch.name = message.name;
          if (message.role !== undefined) patch.role = message.role || null;
          if (message.avatar !== undefined) {
            patch.avatar = message.avatar || null;
          }
          if (message.color !== undefined) patch.color = message.color || null;
          if (message.computers !== undefined) {
            patch.computers = message.computers;
          }
          if (message.workspaceId !== undefined) {
            patch.workspaceId = message.workspaceId || null;
          }
          if (message.access !== undefined) {
            patch.access = message.access;
          }
          if (message.policy !== undefined) {
            patch.policy = message.policy;
          }
          if (message.model !== undefined) {
            patch.model = message.model;
          }
          const bot = options.store.updateBot(message.botId, patch);
          if (!bot) {
            send({ type: "chat.error", message: `unknown bot: ${message.botId}` });
            return;
          }
          broadcast({
            type: "bot.updated",
            requestId: message.requestId,
            bot,
          });
          // Changing the computer set can revoke (or restore) a routine's
          // computer, so refresh the routine list's availability.
          broadcastRoutines();
          return;
        }
        case "bots.power": {
          const bot = options.store.getBot(message.botId);
          if (!bot) {
            send({ type: "chat.error", message: `unknown bot: ${message.botId}` });
            return;
          }
          if (!botHasComputer(bot, "firecracker")) {
            send({
              type: "chat.error",
              message: "this agent runs on This Mac and has no VM to power on or off",
            });
            return;
          }
          const sandbox = options.sandbox;
          if (!sandbox) {
            send({ type: "chat.error", message: "sandbox is not available" });
            return;
          }
          broadcast({
            type: "sandbox.state",
            botId: message.botId,
            state: message.on ? "booting" : "stopped",
          });
          void (async () => {
            try {
              if (message.on) {
                const status = await sandbox.ensure(message.botId);
                broadcast({
                  type: "sandbox.state",
                  botId: message.botId,
                  state: status.state,
                });
              } else {
                await sandbox.stop(message.botId);
                screenCache.delete(message.botId);
                screenInFlight.delete(message.botId);
                broadcast({
                  type: "sandbox.state",
                  botId: message.botId,
                  state: "stopped",
                });
              }
            } catch (error) {
              console.error(
                `failed to power ${message.on ? "on" : "off"} VM for bot ${message.botId}: ${(error as Error).message}`,
              );
              broadcast({
                type: "sandbox.state",
                botId: message.botId,
                state: "error",
              });
            }
          })();
          return;
        }
        case "bots.delete": {
          const bot = options.store.getBot(message.botId);
          if (!bot) {
            send({ type: "chat.error", message: `unknown bot: ${message.botId}` });
            return;
          }
          for (const run of runs.values()) {
            if (run.botId === message.botId) {
              run.controller.abort();
            }
          }
          dropQueuedChats(message.botId);
          screenCache.delete(message.botId);
          screenInFlight.delete(message.botId);
          options.store.deleteBot(message.botId);
          rmSync(join(options.config.dataDir, "workspaces", message.botId), {
            recursive: true,
            force: true,
          });
          broadcast({
            type: "bot.deleted",
            requestId: message.requestId,
            botId: message.botId,
          });
          broadcastRoutines();
          const sandbox = options.sandbox;
          if (sandbox) {
            void sandbox.destroy(message.botId).catch((error) => {
              console.error(
                `failed to destroy VM for deleted bot ${message.botId}: ${(error as Error).message}`,
              );
            });
          }
          return;
        }
        case "bots.reset": {
          const bot = options.store.getBot(message.botId);
          if (!bot) {
            send({ type: "chat.error", message: `unknown bot: ${message.botId}` });
            return;
          }
          for (const run of runs.values()) {
            if (run.botId === message.botId) {
              run.controller.abort();
            }
          }
          dropQueuedChats(message.botId);
          screenCache.delete(message.botId);
          screenInFlight.delete(message.botId);
          options.store.resetBot(message.botId);
          rmSync(join(options.config.dataDir, "workspaces", message.botId), {
            recursive: true,
            force: true,
          });
          const thread = options.store.getOrCreateThread(message.botId);
          broadcast({
            type: "bot.reset",
            requestId: message.requestId,
            botId: message.botId,
            thread,
          });
          const sandbox = options.sandbox;
          if (sandbox && botHasComputer(bot, "firecracker")) {
            void (async () => {
              try {
                broadcast({
                  type: "sandbox.state",
                  botId: message.botId,
                  state: "stopped",
                });
                await sandbox.destroy(message.botId);
                broadcast({
                  type: "sandbox.state",
                  botId: message.botId,
                  state: "booting",
                });
                const status = await sandbox.ensure(message.botId);
                broadcast({
                  type: "sandbox.state",
                  botId: message.botId,
                  state: status.state,
                });
              } catch (error) {
                console.error(
                  `failed to rebuild VM for reset bot ${message.botId}: ${(error as Error).message}`,
                );
                broadcast({
                  type: "sandbox.state",
                  botId: message.botId,
                  state: "error",
                });
              }
            })();
          }
          return;
        }
        case "workspaces.list": {
          send({
            type: "workspaces",
            workspaces: options.workspaces.list(),
            roots: options.workspaces.roots(),
          });
          return;
        }
        case "workspaces.scan": {
          try {
            const result = options.workspaces.scan();
            console.info("workspaces.scan", { discovered: result.discovered });
            broadcast({
              type: "workspaces",
              workspaces: result.workspaces,
              roots: options.workspaces.roots(),
            });
          } catch (error) {
            send({ type: "chat.error", message: (error as Error).message });
          }
          return;
        }
        case "workspaces.add": {
          try {
            options.workspaces.add(message.root);
            broadcast({
              type: "workspaces",
              workspaces: options.workspaces.list(),
              roots: options.workspaces.roots(),
            });
          } catch (error) {
            send({ type: "chat.error", message: (error as Error).message });
          }
          return;
        }
        case "workspaces.update": {
          const updated = options.workspaces.update(message.workspaceId, {
            ...(message.name !== undefined ? { name: message.name } : {}),
            ...(message.ignored !== undefined
              ? { ignored: message.ignored }
              : {}),
            ...(message.autoApprove !== undefined
              ? { autoApprove: message.autoApprove }
              : {}),
          });
          if (!updated) {
            send({
              type: "chat.error",
              message: `unknown workspace: ${message.workspaceId}`,
            });
            return;
          }
          broadcast({
            type: "workspaces",
            workspaces: options.workspaces.list(),
            roots: options.workspaces.roots(),
          });
          return;
        }
        case "workspaces.remove": {
          if (!options.workspaces.remove(message.workspaceId)) {
            send({
              type: "chat.error",
              message: `unknown workspace: ${message.workspaceId}`,
            });
            return;
          }
          broadcast({
            type: "workspaces",
            workspaces: options.workspaces.list(),
            roots: options.workspaces.roots(),
          });
          return;
        }
        case "workspaces.roots": {
          options.workspaces.setRoots(message.roots);
          broadcast({
            type: "workspaces",
            workspaces: options.workspaces.list(),
            roots: options.workspaces.roots(),
          });
          return;
        }
        case "access.check": {
          send({
            type: "access.report",
            report: collectAccessReport(accessOwner()),
          });
          return;
        }
        case "access.open": {
          if (!openPrivacyPane(message.pane)) {
            send({
              type: "chat.error",
              message: "System Settings panes are only available on macOS",
            });
            return;
          }
          send({
            type: "access.report",
            report: collectAccessReport(accessOwner()),
          });
          return;
        }
        case "sandbox.status": {
          const sandbox = options.sandbox;
          const bot = options.store.getBot(message.botId);
          if (!sandbox || !bot || !botHasComputer(bot, "firecracker")) {
            send({
              type: "sandbox.state",
              botId: message.botId,
              state: "stopped",
            });
            return;
          }
          void sandbox
            .status(message.botId)
            .then((status) =>
              send({
                type: "sandbox.state",
                botId: message.botId,
                state: status.state,
              }),
            )
            .catch(() =>
              send({
                type: "sandbox.state",
                botId: message.botId,
                state: "error",
              }),
            );
          return;
        }
        case "files.list": {
          void listComputerFiles(
            fileOptions,
            message.botId,
            message.path ?? "",
            message.computer,
          )
            .then((result) =>
              send({
                type: "files.list",
                requestId: message.requestId,
                botId: message.botId,
                path: result.path,
                entries: result.entries,
                error: result.error,
              }),
            )
            .catch((error: unknown) =>
              send({
                type: "files.list",
                requestId: message.requestId,
                botId: message.botId,
                path: message.path ?? "",
                entries: [],
                error: (error as Error).message,
              }),
            );
          return;
        }
        case "files.read": {
          void readComputerFile(
            fileOptions,
            message.botId,
            message.path,
            message.computer,
          )
            .then((result) =>
              send({
                type: "files.read",
                requestId: message.requestId,
                botId: message.botId,
                path: result.path,
                kind: result.kind,
                content: result.content,
                mime: result.mime,
                size: result.size,
                truncated: result.truncated,
                error: result.error,
              }),
            )
            .catch((error: unknown) =>
              send({
                type: "files.read",
                requestId: message.requestId,
                botId: message.botId,
                path: message.path,
                kind: "missing",
                content: null,
                mime: null,
                size: 0,
                truncated: false,
                error: (error as Error).message,
              }),
            );
          return;
        }
        case "thread.list":
          send({ type: "threads", threads: options.store.listThreads() });
          return;
        case "thread.messages":
          send({
            type: "thread.messages",
            threadId: message.threadId,
            messages: options.store.listMessages(message.threadId, {
              includeFolded: message.includeFolded === true,
            }),
          });
          return;
        case "thread.clear": {
          const thread = options.store.getThread(message.threadId);
          if (!thread) {
            send({
              type: "chat.error",
              message: `unknown thread: ${message.threadId}`,
            });
            return;
          }
          const active = activeRunForThread(thread.id);
          if (active) {
            pendingClears.add(thread.id);
            active.controller.abort();
            return;
          }
          clearThreadNow(thread.id);
          return;
        }
        case "chat.cancel":
          runs.get(message.runId)?.controller.abort();
          return;
        case "approvals.list": {
          send({
            type: "approvals.list",
            approvals: options.store.listApprovals(message.limit ?? 100),
          });
          return;
        }
        case "memory.list": {
          send({
            type: "memory.list",
            memories: options.store
              .listMemories({
                ...(message.scope ? { scope: message.scope } : {}),
                ...(message.status ? { status: message.status } : {}),
                ...(message.limit ? { limit: message.limit } : {}),
              })
              .map(toMemoryInfo),
          });
          return;
        }
        case "memory.remove": {
          options.store.deleteMemory(message.id);
          broadcast({ type: "memory.removed", id: message.id });
          return;
        }
        case "memory.consolidate": {
          void memory
            .decayAndPrune()
            .then(({ archived, merged }) =>
              send({ type: "memory.consolidated", archived, merged }),
            )
            .catch((error) => {
              console.warn(
                `memory consolidation failed: ${(error as Error).message}`,
              );
              send({ type: "memory.consolidated", archived: 0, merged: 0 });
            });
          return;
        }
        case "soul.get": {
          const botId = message.botId ?? options.store.listBots()[0]?.id;
          if (!botId) {
            send({ type: "chat.error", message: "no agent for the soul" });
            return;
          }
          send({
            type: "soul",
            botId,
            soul: soul.current(botId),
            versions: soul.list(botId),
          });
          return;
        }
        case "soul.revert": {
          const botId = message.botId ?? options.store.listBots()[0]?.id;
          if (!botId) {
            send({ type: "chat.error", message: "no agent for the soul" });
            return;
          }
          const reverted = soul.revert(botId, message.versionId);
          if (!reverted) {
            send({ type: "chat.error", message: "unknown soul version" });
            return;
          }
          broadcast({
            type: "soul",
            botId,
            soul: soul.current(botId),
            versions: soul.list(botId),
          });
          return;
        }
        case "routines.list": {
          send({ type: "routines", routines: options.store.listRoutines() });
          return;
        }
        case "routines.create": {
          const bot = options.store.getBot(message.botId);
          if (!bot) {
            send({
              type: "routine.error",
              requestId: message.requestId,
              message: `unknown bot: ${message.botId}`,
            });
            return;
          }
          if (!botHasComputer(bot, message.computer)) {
            send({
              type: "routine.error",
              requestId: message.requestId,
              message:
                `${bot.name} has no access to ` +
                `${computerLabel(message.computer)}, so a routine cannot run there`,
            });
            return;
          }
          const routine = routines.create({
            botId: message.botId,
            name: message.name.trim(),
            brief: message.brief.trim(),
            computer: message.computer,
            schedule: message.schedule,
            ...(message.enabled !== undefined
              ? { enabled: message.enabled }
              : {}),
          });
          send({ type: "routine.created", requestId: message.requestId, routine });
          return;
        }
        case "routines.update": {
          const existing = options.store.getRoutine(message.routineId);
          if (!existing) {
            send({
              type: "routine.error",
              requestId: message.requestId,
              message: `unknown routine: ${message.routineId}`,
            });
            return;
          }
          // A blocked routine can still be renamed or disabled; only changing
          // its computer to one the agent does not have is refused.
          if (message.computer !== undefined) {
            const bot = options.store.getBot(existing.botId);
            if (!bot || !botHasComputer(bot, message.computer)) {
              send({
                type: "routine.error",
                requestId: message.requestId,
                message:
                  `${bot?.name ?? "the agent"} has no access to ` +
                  `${computerLabel(message.computer)}, so the routine cannot run there`,
              });
              return;
            }
          }
          const routine = routines.update(message.routineId, {
            ...(message.name !== undefined
              ? { name: message.name.trim() }
              : {}),
            ...(message.brief !== undefined
              ? { brief: message.brief.trim() }
              : {}),
            ...(message.computer !== undefined
              ? { computer: message.computer }
              : {}),
            ...(message.schedule !== undefined
              ? { schedule: message.schedule }
              : {}),
            ...(message.enabled !== undefined
              ? { enabled: message.enabled }
              : {}),
          });
          if (!routine) {
            send({
              type: "routine.error",
              requestId: message.requestId,
              message: `unknown routine: ${message.routineId}`,
            });
            return;
          }
          send({ type: "routine.updated", requestId: message.requestId, routine });
          return;
        }
        case "routines.remove": {
          if (!routines.remove(message.routineId)) {
            send({
              type: "routine.error",
              requestId: message.requestId,
              message: `unknown routine: ${message.routineId}`,
            });
            return;
          }
          send({
            type: "routine.removed",
            requestId: message.requestId,
            routineId: message.routineId,
          });
          return;
        }
        case "routines.run": {
          const result = routines.runNow(message.routineId);
          send({
            type: "routine.started",
            requestId: message.requestId,
            routineId: message.routineId,
            ok: result.ok,
            message: result.message,
          });
          return;
        }
        case "routine.runs": {
          send({
            type: "routine.runs",
            requestId: message.requestId,
            routineId: message.routineId,
            runs: routines.runs(message.routineId, message.limit ?? 20),
          });
          return;
        }
        case "approval.respond":
          if (message.remember && message.decision === "approve") {
            if (rememberApprovedTool(message.requestId)) {
              providersUpdated();
            }
          }
          options.approvals.resolve(message.requestId, message.decision);
          return;        case "challenge.respond":
          options.challenges.resolve(message.requestId, message.action);
          return;
        case "provider.upsert": {
          options.store.upsertProvider(message.provider);
          options.registry.reload(options.store.listProviders());
          providersUpdated();
          return;
        }
        case "provider.remove": {
          options.store.removeProvider(message.id);
          options.registry.reload(options.store.listProviders());
          const fallback = readDefaultModel();
          options.store.setSetting(
            DEFAULT_MODEL_KEY,
            JSON.stringify(fallback),
          );
          providersUpdated();
          return;
        }
        case "provider.fetchModels": {
          const record = message.providerId
            ? options.store.getProvider(message.providerId)
            : null;
          const apiKey =
            message.apiKey && message.apiKey.length > 0
              ? message.apiKey
              : record
                ? options.registry.resolveKey(record)
                : undefined;
          fetchModels({ baseUrl: message.baseUrl, apiKey })
            .then((models) => {
              send({
                type: "provider.models",
                requestId: message.requestId,
                ok: true,
                models,
                error: null,
              });
            })
            .catch((error) => {
              send({
                type: "provider.models",
                requestId: message.requestId,
                ok: false,
                models: [],
                error: (error as Error).message,
              });
            });
          return;
        }
        case "decision.test": {
          const runtime = decisionRuntime(
            readDecisionSettings(),
            process.env,
          );
          if (!runtime.client) {
            send({
              type: "decision.test",
              requestId: message.requestId,
              ok: false,
              model: null,
              latencyMs: null,
              error: "decision model is not enabled or has no API key",
            });
            return;
          }
          const startedAt = Date.now();
          runtime.client
            .evaluate({
              state: { check: "OpenBot decision-model connectivity test" },
              questions: {
                reachable: noul("Is this a connectivity test?"),
              },
            })
            .then((result) => {
              send({
                type: "decision.test",
                requestId: message.requestId,
                ok: true,
                model: result.model,
                latencyMs: Date.now() - startedAt,
                error: null,
              });
            })
            .catch((error) => {
              send({
                type: "decision.test",
                requestId: message.requestId,
                ok: false,
                model: null,
                latencyMs: Date.now() - startedAt,
                error: (error as Error).message,
              });
            });
          return;
        }
        case "settings.update": {
          if (message.settings.defaultModel) {
            options.store.setSetting(
              DEFAULT_MODEL_KEY,
              JSON.stringify(message.settings.defaultModel),
            );
          }
          if (message.settings.requireApproval !== undefined) {
            writeRequireApproval(message.settings.requireApproval);
          }
          if (message.settings.policy) {
            options.store.setSetting(
              POLICY_SETTING_KEY,
              serializePolicy(normalizePolicy(message.settings.policy)),
            );
          }
          if (message.settings.policyPreset) {
            options.store.setSetting(
              POLICY_SETTING_KEY,
              serializePolicy(policyPreset(message.settings.policyPreset)),
            );
          }
          if (message.settings.compaction) {
            const current = readCompactionSettings();
            const patch = message.settings.compaction;
            options.store.setSetting(
              COMPACTION_SETTING_KEY,
              JSON.stringify({
                enabled: patch.enabled ?? current.enabled,
                thresholdTokens:
                  patch.thresholdTokens === undefined
                    ? current.thresholdTokens
                    : patch.thresholdTokens,
              }),
            );
          }
          if (message.settings.harness) {
            const current = readHarnessSettings();
            const next = parseHarnessId(
              message.settings.harness.default ?? current.default,
            );
            options.store.setSetting(
              HARNESS_SETTING_KEY,
              JSON.stringify({ default: next }),
            );
            if (next === "codex") {
              void codex.refresh();
            }
          }
          if (message.settings.decision) {
            const current = readDecisionSettings();
            const patch = message.settings.decision;
            const next = normalizeDecisionSettings(
              {
                ...current,
                ...patch,
                ...(patch.apiKey !== undefined
                  ? { apiKey: patch.apiKey || null }
                  : {}),
                ...(patch.apiKeyEnv !== undefined
                  ? { apiKeyEnv: patch.apiKeyEnv || null }
                  : {}),
              },
              current,
            );
            options.store.setSetting(
              DECISION_SETTING_KEY,
              JSON.stringify(next),
            );
          }
          if (message.settings.chatBusyBehavior) {
            options.store.setSetting(
              CHAT_BUSY_BEHAVIOR_KEY,
              message.settings.chatBusyBehavior,
            );
          }
          providersUpdated();
          return;
        }
        case "chat.send": {
          const bot = options.store.getBot(message.botId);
          if (!bot) {
            send({
              type: "chat.error",
              message: `unknown bot: ${message.botId}`,
            });
            return;
          }
          const thread = resolveChatThread(message.botId, message.threadId);
          const messageId = message.messageId ?? randomUUID();
          const active = activeRunForThread(thread.id);
          if (active) {
            const delivery = message.delivery ?? readChatBusyBehavior();
            if (delivery === "steer" && active.steerable) {
              // Steering joins the live turn: persist now so the transcript
              // keeps the right order, and let the agent pick it up at its
              // next step boundary.
              let userMessage: Message;
              try {
                userMessage = options.store.addMessage({
                  id: messageId,
                  threadId: thread.id,
                  role: "user",
                  content: message.text,
                  model: null,
                });
              } catch {
                send({
                  type: "chat.error",
                  threadId: thread.id,
                  message: "message id already exists",
                });
                return;
              }
              active.steering.push(message.text);
              broadcast({
                type: "chat.message",
                runId: active.runId,
                threadId: thread.id,
                message: userMessage,
              });
              return;
            }
            const queue = threadQueues.get(thread.id) ?? [];
            queue.push({
              id: messageId,
              botId: message.botId,
              text: message.text,
              ...(message.model ? { model: message.model } : {}),
            });
            threadQueues.set(thread.id, queue);
            broadcast({
              type: "chat.queued",
              threadId: thread.id,
              messageId,
            });
            return;
          }
          startRun({
            botId: message.botId,
            threadId: thread.id,
            text: message.text,
            model: message.model,
            messageId,
          });
          return;
        }
      }
    });
  });

  return {
    async start() {
      reflector.start();
      routines.start();
      await codex.refresh();
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(options.config.port, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      const port =
        typeof address === "object" && address !== null
          ? address.port
          : options.config.port;
      return { port };
    },

    async stop() {
      clearInterval(sandboxTimer);
      clearInterval(codexTimer);
      reflector.stop();
      routines.stop();
      for (const run of runs.values()) {
        run.controller.abort();
      }
      for (const socket of wss.clients) {
        socket.close();
      }
      for (const socket of vncWss.clients) {
        socket.close(1001, "daemon stopping");
      }
      await Promise.allSettled([...pending]);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => vncWss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
