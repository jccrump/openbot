import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, rmSync } from "node:fs";
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
  type Bot,
  type ChatBusyBehavior,
  type CompactionSettings,
  type HarnessSettings,
  type Memory,
  type Message,
  type ModelRef,
  type PolicySettings,
  type ServerMessage,
  type Task,
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
  readComputerFile,
  type FileServiceOptions,
} from "./files";
import { MemoryService } from "./memory";
import { Orchestrator } from "./orchestrator";
import {
  normalizePolicy,
  parsePolicy,
  POLICY_SETTING_KEY,
  policyPreset,
  serializePolicy,
} from "./policy";
import { Reflector } from "./reflection";
import { SoulService } from "./soul";
import type { ProviderRegistry } from "./provider-registry";
import {
  systemPromptForBot,
  type MemoryRecord,
  type Store,
} from "./store";
import { captureScreen } from "./tools";

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
  const pending = new Set<Promise<void>>();

  const artifactsDir = join(options.config.dataDir, "artifacts");

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

  const leadBot = (): Bot | null =>
    options.store.listBots().find((bot) => bot.kind === "lead") ?? null;

  let leadRunActive = false;
  const leadQueue: Array<{ text: string; contextNote: string }> = [];

  const truncateNote = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;

  const buildTaskNote = (task: Task): string => {
    const store = options.store;
    const roleName = store.getBot(task.roleId)?.name ?? "a teammate";
    const lines = [
      `[team task ${task.status}] "${task.title}" — ${roleName}`,
      `Task id: ${task.id}`,
    ];
    if (task.error) {
      lines.push(`Error: ${task.error}`);
    }
    if (task.result) {
      lines.push(`Result:\n${truncateNote(task.result, 4000)}`);
    }
    if (task.evidence) {
      lines.push(`Evidence ledger:\n${truncateNote(task.evidence, 4000)}`);
    }
    const active = store
      .listTasks(50)
      .filter(
        (candidate) =>
          candidate.id !== task.id &&
          (candidate.status === "queued" || candidate.status === "running"),
      );
    if (active.length > 0) {
      lines.push(
        `Still running:\n${active
          .map(
            (candidate) =>
              `- "${candidate.title}" (${store.getBot(candidate.roleId)?.name ?? "unknown role"})`,
          )
          .join("\n")}`,
      );
    }
    return lines.join("\n\n");
  };

  const scheduleLeadTurn = (task: Task): void => {
    reflector?.schedule();
    if (!leadBot()) {
      return;
    }
    leadQueue.push({
      text:
        "A team task just finished. Review the workboard context and report " +
        "the outcome to the user in one concise message. If nothing needs the " +
        "user's attention, say so briefly.",
      contextNote: buildTaskNote(task),
    });
    drainLeadQueue();
  };

  const drainLeadQueue = (): void => {
    if (leadRunActive) {
      return;
    }
    const lead = leadBot();
    if (!lead) {
      leadQueue.length = 0;
      return;
    }
    const next = leadQueue.shift();
    if (!next) {
      return;
    }
    startRun({
      botId: lead.id,
      threadId: options.store.getOrCreateThread(lead.id).id,
      text: next.text,
      contextNote: next.contextNote,
      internal: true,
    });
  };

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
    internal?: boolean;
    contextNote?: string;
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
    const isLead = input.botId === leadBot()?.id;
    if (isLead) {
      leadRunActive = true;
    }

    const harness = readHarnessSettings();
    const useCodex = !input.internal && harness.default === "codex";
    const run = useCodex ? runCodexTurn : runAgent;
    handle.steerable = !input.internal && !useCodex;
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
        internal: input.internal,
        contextNote: input.contextNote,
        steering: {
          hasPending: () => handle.steering.length > 0,
          drain: () => handle.steering.splice(0),
        },
      },
      broadcast,
      controller.signal,
    )
      .catch((error) => {
        broadcast({
          type: "chat.error",
          runId,
          message: (error as Error).message,
        });
      })
      .finally(() => {
        runs.delete(runId);
        pending.delete(task);
        if (isLead) {
          leadRunActive = false;
          reflector.schedule();
        }
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
        drainThreadQueue(input.threadId);
        if (isLead) {
          drainLeadQueue();
        }
      });
    pending.add(task);
  };

  const orchestrator = new Orchestrator({
    deps,
    emit: broadcast,
    onTaskSettled: (task) => scheduleLeadTurn(task),
  });
  deps.orchestrator = orchestrator;

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

  const codexTimer = setInterval(() => {
    void codex.refresh();
  }, 30_000);
  codexTimer.unref();

  let sandboxAvailable = false;
  let sandboxPruned = false;
  // A delete that races a daemon or host restart can leave a multi-GB rootfs
  // behind. Once the host answers, remove every computer this daemon owns that
  // is no longer a bot or an active task.
  const pruneSandboxOrphans = async () => {
    const sandbox = options.sandbox;
    if (!sandbox) {
      return;
    }
    try {
      const keep = [
        ...options.store.listBots().map((bot) => bot.id),
        ...options.store
          .listTasks()
          .filter(
            (task) => task.status === "queued" || task.status === "running",
          )
          .map((task) => task.id),
      ];
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
    const taskScreenMatch = /^\/tasks\/([^/]+)\/screen$/.exec(url.pathname);
    if (
      request.method === "GET" &&
      (botScreenMatch !== null || taskScreenMatch !== null)
    ) {
      const cors = screenCorsHeaders(request.headers.origin);
      const id = decodeURIComponent(
        (botScreenMatch ?? taskScreenMatch)?.[1] ?? "",
      );
      const sendError = (status: number, payload: Record<string, unknown>) => {
        const body = JSON.stringify(payload);
        response.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...cors,
        });
        response.end(body);
      };
      if (botScreenMatch) {
        const bot = options.store.getBot(id);
        if (!bot) {
          sendError(404, { error: `unknown bot: ${id}` });
          return;
        }
        if (bot.computer === "mac") {
          sendError(409, {
            error: "screen capture is only available for microVM computers",
            code: "mac",
          });
          return;
        }
      } else if (!options.store.getTask(id)) {
        sendError(404, { error: `unknown task: ${id}` });
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
      if (bot.computer === "mac") {
        reject(409, "Conflict");
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
    const taskVncMatch = /^\/tasks\/([^/]+)\/vnc$/.exec(url.pathname);
    const vncMatch = botVncMatch ?? taskVncMatch;
    if (!vncMatch) {
      socket.destroy();
      return;
    }
    const vncId = decodeURIComponent(vncMatch[1] ?? "");
    if (!originAllowed) {
      reject(403, "Forbidden");
      return;
    }
    if (botVncMatch) {
      const bot = options.store.getBot(vncId);
      if (!bot) {
        reject(404, "Not Found");
        return;
      }
      if (bot.computer === "mac") {
        reject(409, "Conflict");
        return;
      }
    } else if (!options.store.getTask(vncId)) {
      reject(404, "Not Found");
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
      tasks: options.store.listTasks(),
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
            computer: message.computer ?? null,
            delegates: message.delegates ?? false,
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
          if (message.computer !== undefined) {
            patch.computer = message.computer;
          }
          if (message.delegates !== undefined) {
            patch.delegates = message.delegates;
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
          return;
        }
        case "bots.power": {
          const bot = options.store.getBot(message.botId);
          if (!bot) {
            send({ type: "chat.error", message: `unknown bot: ${message.botId}` });
            return;
          }
          if (bot.computer === "mac") {
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
          orchestrator.cancelForRole(message.botId);
          orchestrator.cancelForProject(message.botId);
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
          orchestrator.cancelForRole(message.botId);
          orchestrator.cancelForProject(message.botId);
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
          if (sandbox && bot.computer !== "mac") {
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
        case "sandbox.status": {
          const sandbox = options.sandbox;
          const bot = options.store.getBot(message.botId);
          if (!sandbox || !bot || bot.computer === "mac") {
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
          void readComputerFile(fileOptions, message.botId, message.path)
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
            messages: options.store.listMessages(message.threadId),
          });
          return;
        case "chat.cancel":
          runs.get(message.runId)?.controller.abort();
          return;
        case "task.cancel":
          orchestrator.cancel(message.taskId);
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
          const botId = message.botId ?? leadBot()?.id;
          if (!botId) {
            send({ type: "chat.error", message: "no lead bot for the soul" });
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
          const botId = message.botId ?? leadBot()?.id;
          if (!botId) {
            send({ type: "chat.error", message: "no lead bot for the soul" });
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
        case "approval.respond":
          options.approvals.resolve(message.requestId, message.decision);
          return;
        case "challenge.respond":
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
      orchestrator.recover();
      reflector.start();
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
      await orchestrator.stop();
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
