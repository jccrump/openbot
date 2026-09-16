import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { fetchModels, type ProviderPreset } from "@openbot/gateway";
import {
  ClientMessageSchema,
  type CompactionSettings,
  type HarnessSettings,
  type ModelRef,
  type ServerMessage,
} from "@openbot/protocol";
import type { SandboxBackend } from "@openbot/sandbox";
import { runAgent, type AgentDeps } from "./agent";
import type { ApprovalBroker } from "./approvals";
import { CodexDetector, runCodexTurn } from "./codex";
import {
  COMPACTION_SETTING_KEY,
  parseCompactionSettings,
} from "./compaction";
import type { OpenBotConfig } from "./config";
import {
  HARNESS_SETTING_KEY,
  parseHarnessId,
  parseHarnessSettings,
} from "./harness";
import type { ProviderRegistry } from "./provider-registry";
import { systemPromptForBot, type Store } from "./store";

export interface DaemonOptions {
  config: OpenBotConfig;
  store: Store;
  registry: ProviderRegistry;
  sandbox: SandboxBackend | null;
  approvals: ApprovalBroker;
  presets: ProviderPreset[];
}

export interface Daemon {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

const DEFAULT_MODEL_KEY = "defaultModel";
const REQUIRE_APPROVAL_KEY = "requireApproval";

export function createDaemon(options: DaemonOptions): Daemon {
  const runs = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();

  const artifactsDir = join(options.config.dataDir, "artifacts");

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

  const codex = new CodexDetector();

  const deps: AgentDeps = {
    store: options.store,
    providers: options.registry.map,
    sandbox: options.sandbox,
    approvals: options.approvals,
    requireApproval: options.config.requireApproval,
    artifactsDir,
    compaction: () => readCompactionSettings(),
    sandboxUrl: options.config.sandboxUrl,
    dataDir: options.config.dataDir,
    providerRecord: (id) => options.store.getProvider(id),
    resolveProviderKey: (record) => options.registry.resolveKey(record),
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
      compaction: readCompactionSettings(),
      harness: readHarnessSettings(),
      codex: codex.info(),
    });
  };

  deps.requireApproval = readRequireApproval();

  const codexTimer = setInterval(() => {
    void codex.refresh();
  }, 30_000);
  codexTimer.unref();

  let sandboxAvailable = false;
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
  };
  void checkSandbox();
  const sandboxTimer = setInterval(checkSandbox, 30_000);
  sandboxTimer.unref();

  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, name: "openbotd" }));
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

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

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
      compaction: readCompactionSettings(),
      harness: readHarnessSettings(),
      codex: codex.info(),
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
          });
          broadcast({ type: "bot.created", requestId: message.requestId, bot });
          return;
        }
        case "bots.update": {
          const bot = options.store.updateBot(
            message.botId,
            message.computer === undefined
              ? {}
              : { computer: message.computer },
          );
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
          runs.get(message.runId)?.abort();
          return;
        case "approval.respond":
          options.approvals.resolve(message.requestId, message.decision);
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
          providersUpdated();
          return;
        }
        case "chat.send": {
          const runId = randomUUID();
          const controller = new AbortController();
          runs.set(runId, controller);

          const harness = readHarnessSettings();
          const run = harness.default === "codex" ? runCodexTurn : runAgent;
          const task = run(
            deps,
            {
              runId,
              botId: message.botId,
              threadId: message.threadId,
              text: message.text,
              model: message.model,
            },
            send,
            controller.signal,
          )
            .catch((error) => {
              send({
                type: "chat.error",
                runId,
                message: (error as Error).message,
              });
            })
            .finally(() => {
              runs.delete(runId);
              pending.delete(task);
            });

          pending.add(task);
          return;
        }
      }
    });
  });

  return {
    async start() {
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
      for (const controller of runs.values()) {
        controller.abort();
      }
      for (const socket of wss.clients) {
        socket.close();
      }
      await Promise.allSettled([...pending]);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
