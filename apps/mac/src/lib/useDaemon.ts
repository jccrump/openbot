import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Bot,
  CodexInfo,
  ComputerKind,
  HarnessId,
  HarnessSettings,
  Message,
  ModelRef,
  ProviderInfo,
  ProviderPreset,
  ServerMessage,
  Thread,
  ToolArtifact,
} from "@openbot/protocol";
import { DaemonClient, type DaemonStatus } from "./daemon";

export type SandboxState = "stopped" | "booting" | "running" | "error";

export interface StreamingState {
  runId: string;
  threadId: string;
  messageId: string;
  text: string;
}

export interface ToolActivity {
  threadId: string;
  callId: string;
  name: string;
  arguments: string;
  status: "running" | "done";
  ok: boolean | null;
  output: string | null;
  durationMs: number | null;
  artifacts: ToolArtifact[] | null;
}

export interface PendingApproval {
  threadId: string;
  requestId: string;
  callId: string;
  name: string;
  arguments: string;
  decision: "approve" | "deny" | null;
}

export interface ModelOption {
  provider: string;
  providerLabel: string;
  model: string;
}

export interface ProviderInput {
  id?: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models: string[];
  enabled?: boolean;
}

export interface CreateBotInput {
  name: string;
  role?: string;
  avatar?: string;
  color?: string;
  model?: ModelRef;
  computer?: ComputerKind;
}

export interface FetchModelsResult {
  ok: boolean;
  models: string[];
  error: string | null;
}

const SELECTED_BOT_KEY = "openbot.bot";
const STREAM_WATCHDOG_MS = 90_000;
const DISCONNECTED_ERROR = "Daemon disconnected — reconnect";

function progressThreadFor(message: ServerMessage): string | null {
  switch (message.type) {
    case "chat.start":
    case "chat.delta":
    case "chat.reasoning":
    case "chat.compaction":
    case "tool.start":
    case "tool.result":
    case "approval.request":
      return message.threadId;
    default:
      return null;
  }
}

function storedBotId(): string | null {
  try {
    return localStorage.getItem(SELECTED_BOT_KEY);
  } catch {
    return null;
  }
}

function localMessageId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessageId(): string {
  return `error-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isProviderUsable(provider: ProviderInfo): boolean {
  return (
    provider.enabled &&
    provider.models.length > 0 &&
    (provider.hasApiKey || provider.apiKeyEnv === null)
  );
}

function isModelUsable(providers: ProviderInfo[], model: ModelRef): boolean {
  return providers.some(
    (provider) =>
      provider.id === model.provider &&
      isProviderUsable(provider) &&
      provider.models.includes(model.model),
  );
}

export function useDaemon() {
  const clientRef = useRef<DaemonClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new DaemonClient();
  }
  const client = clientRef.current;

  const [status, setStatus] = useState<DaemonStatus>(client.status);
  const [bots, setBots] = useState<Bot[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelRef | null>(null);
  const [requireApproval, setRequireApproval] = useState(true);
  const [harness, setHarness] = useState<HarnessSettings>({
    default: "openbot",
  });
  const [codex, setCodex] = useState<CodexInfo | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingByThread, setStreamingByThread] = useState<
    Record<string, StreamingState>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [sandboxStates, setSandboxStates] = useState<
    Record<string, SandboxState>
  >({});

  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const streamingRef = useRef<Record<string, StreamingState>>({});
  streamingRef.current = streamingByThread;
  const watchdogTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const outageRef = useRef(false);
  const botsRef = useRef<Bot[]>(bots);
  botsRef.current = bots;
  const threadsRef = useRef<Thread[]>(threads);
  threadsRef.current = threads;
  const providersRef = useRef<ProviderInfo[]>(providers);
  providersRef.current = providers;
  const selectedBotIdRef = useRef<string | null>(selectedBotId);
  selectedBotIdRef.current = selectedBotId;
  const modelRequests = useRef(
    new Map<string, (result: FetchModelsResult) => void>(),
  );
  const createRequests = useRef(
    new Map<
      string,
      { resolve: (bot: Bot) => void; reject: (error: Error) => void }
    >(),
  );

  const activateBot = useCallback(
    (
      botId: string,
      threadList: Thread[],
      botOverride?: Bot,
      providerList?: ProviderInfo[],
    ) => {
      setSelectedBotId(botId);
      try {
        localStorage.setItem(SELECTED_BOT_KEY, botId);
      } catch {}
      const thread = threadList.find((item) => item.botId === botId) ?? null;
      setActiveThreadId(thread?.id ?? null);
      setMessages([]);
      const bot =
        botOverride ??
        botsRef.current.find((item) => item.id === botId) ??
        null;
      setSelectedModel(
        bot && isModelUsable(providerList ?? providersRef.current, bot.model)
          ? bot.model
          : null,
      );
      if (thread) {
        client.send({ type: "thread.messages", threadId: thread.id });
      }
    },
    [client],
  );

  const disarmWatchdog = useCallback((threadId?: string) => {
    if (threadId === undefined) {
      for (const timer of watchdogTimers.current.values()) {
        clearTimeout(timer);
      }
      watchdogTimers.current.clear();
      return;
    }
    const timer = watchdogTimers.current.get(threadId);
    if (timer !== undefined) {
      clearTimeout(timer);
      watchdogTimers.current.delete(threadId);
    }
  }, []);

  const armWatchdog = useCallback((threadId: string) => {
    const existing = watchdogTimers.current.get(threadId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    watchdogTimers.current.set(
      threadId,
      setTimeout(() => {
        watchdogTimers.current.delete(threadId);
        if (!streamingRef.current[threadId]) {
          return;
        }
        setStreamingByThread((current) => {
          if (!current[threadId]) {
            return current;
          }
          const next = { ...current };
          delete next[threadId];
          return next;
        });
        setToolActivity((current) =>
          current.filter((item) => item.threadId !== threadId),
        );
        setError(
          "No response from the daemon — the turn timed out. Try again.",
        );
      }, STREAM_WATCHDOG_MS),
    );
  }, []);

  const clearInFlight = useCallback(() => {
    disarmWatchdog();
    setStreamingByThread({});
    setToolActivity([]);
    setApprovals([]);
  }, [disarmWatchdog]);

  useEffect(() => {
    const handleMessage = (message: ServerMessage) => {
      const progressThread = progressThreadFor(message);
      if (progressThread !== null) {
        armWatchdog(progressThread);
      }
      switch (message.type) {
        case "hello": {
          outageRef.current = false;
          clearInFlight();
          setError(null);
          setBots(message.bots);
          setThreads(message.threads);
          setProviders(message.providers);
          setPresets(message.presets);
          setDefaultModel(message.defaultModel);
          setRequireApproval(message.requireApproval);
          setHarness(message.harness ?? { default: "openbot" });
          setCodex(message.codex ?? null);
          const stored = storedBotId();
          const current = selectedBotIdRef.current;
          const preferred =
            (current && message.bots.some((bot) => bot.id === current)
              ? current
              : null) ??
            (stored && message.bots.some((bot) => bot.id === stored)
              ? stored
              : null);
          const bot =
            (preferred
              ? message.bots.find((item) => item.id === preferred)
              : null) ??
            message.bots[0] ??
            null;
          if (bot) {
            activateBot(bot.id, message.threads, bot, message.providers);
          } else {
            setSelectedBotId(null);
            setActiveThreadId(null);
            setMessages([]);
          }
          break;
        }
        case "bot.created": {
          const pending = createRequests.current.get(message.requestId);
          if (pending) {
            createRequests.current.delete(message.requestId);
            pending.resolve(message.bot);
          }
          setBots((current) =>
            current.some((bot) => bot.id === message.bot.id)
              ? current
              : [...current, message.bot],
          );
          activateBot(message.bot.id, threadsRef.current, message.bot);
          break;
        }
        case "bot.updated": {
          setBots((current) =>
            current.map((bot) =>
              bot.id === message.bot.id ? message.bot : bot,
            ),
          );
          break;
        }
        case "bot.deleted": {
          const removedThreadIds = new Set(
            threadsRef.current
              .filter((thread) => thread.botId === message.botId)
              .map((thread) => thread.id),
          );
          const remainingBots = botsRef.current.filter(
            (bot) => bot.id !== message.botId,
          );
          const remainingThreads = threadsRef.current.filter(
            (thread) => thread.botId !== message.botId,
          );
          setBots(remainingBots);
          setThreads(remainingThreads);
          setSandboxStates((current) => {
            if (!(message.botId in current)) {
              return current;
            }
            const next = { ...current };
            delete next[message.botId];
            return next;
          });
          if (removedThreadIds.size > 0) {
            for (const threadId of removedThreadIds) {
              disarmWatchdog(threadId);
            }
            setStreamingByThread((current) => {
              const next = { ...current };
              for (const threadId of removedThreadIds) {
                delete next[threadId];
              }
              return next;
            });
            setToolActivity((current) =>
              current.filter((item) => !removedThreadIds.has(item.threadId)),
            );
            setApprovals((current) =>
              current.filter((item) => !removedThreadIds.has(item.threadId)),
            );
          }
          if (selectedBotIdRef.current === message.botId) {
            const next = remainingBots[0] ?? null;
            if (next) {
              activateBot(next.id, remainingThreads, next);
            } else {
              setSelectedBotId(null);
              setActiveThreadId(null);
              setMessages([]);
              setSelectedModel(null);
              try {
                localStorage.removeItem(SELECTED_BOT_KEY);
              } catch {}
            }
          }
          break;
        }
        case "providers.updated": {
          setProviders(message.providers);
          setDefaultModel(message.defaultModel);
          setRequireApproval(message.requireApproval);
          setHarness(message.harness ?? { default: "openbot" });
          setCodex(message.codex ?? null);
          setSelectedModel((current) => {
            if (
              current &&
              message.providers.some(
                (provider) =>
                  provider.id === current.provider &&
                  provider.enabled &&
                  provider.models.includes(current.model),
              )
            ) {
              return current;
            }
            return message.defaultModel;
          });
          break;
        }
        case "provider.models": {
          const resolve = modelRequests.current.get(message.requestId);
          if (resolve) {
            modelRequests.current.delete(message.requestId);
            resolve({
              ok: message.ok,
              models: message.models,
              error: message.error,
            });
          }
          break;
        }
        case "threads": {
          setThreads(message.threads);
          break;
        }
        case "thread.upserted": {
          setThreads((current) => {
            const index = current.findIndex(
              (thread) => thread.id === message.thread.id,
            );
            if (index === -1) {
              return [message.thread, ...current];
            }
            const next = [...current];
            next[index] = message.thread;
            return next;
          });
          break;
        }
        case "thread.messages": {
          if (message.threadId === activeThreadIdRef.current) {
            setMessages(message.messages);
          }
          break;
        }
        case "chat.start": {
          if (activeThreadIdRef.current === null) {
            setActiveThreadId(message.threadId);
            client.send({
              type: "thread.messages",
              threadId: message.threadId,
            });
          }
          setToolActivity((current) =>
            current.filter((item) => item.threadId !== message.threadId),
          );
          setApprovals((current) =>
            current.filter((item) => item.threadId !== message.threadId),
          );
          setStreamingByThread((current) => ({
            ...current,
            [message.threadId]: {
              runId: message.runId,
              threadId: message.threadId,
              messageId: message.messageId,
              text: "",
            },
          }));
          break;
        }
        case "chat.delta": {
          setStreamingByThread((current) => {
            const entry = current[message.threadId];
            if (!entry || entry.messageId !== message.messageId) {
              return current;
            }
            return {
              ...current,
              [message.threadId]: {
                ...entry,
                text: entry.text + message.text,
              },
            };
          });
          break;
        }
        case "tool.start": {
          setToolActivity((current) => [
            ...current,
            {
              threadId: message.threadId,
              callId: message.callId,
              name: message.name,
              arguments: message.arguments,
              status: "running",
              ok: null,
              output: null,
              durationMs: null,
              artifacts: null,
            },
          ]);
          break;
        }
        case "tool.result": {
          setToolActivity((current) =>
            current.map((activity) =>
              activity.callId === message.callId
                ? {
                    ...activity,
                    status: "done",
                    ok: message.ok,
                    output: message.output,
                    durationMs: message.durationMs,
                    artifacts: message.artifacts,
                  }
                : activity,
            ),
          );
          break;
        }
        case "approval.request": {
          setApprovals((current) => [
            ...current,
            {
              threadId: message.threadId,
              requestId: message.requestId,
              callId: message.callId,
              name: message.name,
              arguments: message.arguments,
              decision: null,
            },
          ]);
          break;
        }
        case "sandbox.state": {
          setSandboxStates((current) => ({
            ...current,
            [message.botId]: message.state,
          }));
          break;
        }
        case "chat.done": {
          disarmWatchdog(message.threadId);
          setStreamingByThread((current) => {
            if (!current[message.threadId]) {
              return current;
            }
            const next = { ...current };
            delete next[message.threadId];
            return next;
          });
          setToolActivity((current) =>
            current.filter((item) => item.threadId !== message.threadId),
          );
          setApprovals((current) =>
            current.filter((item) => item.threadId !== message.threadId),
          );
          if (message.threadId === activeThreadIdRef.current) {
            setMessages((current) =>
              current.some((item) => item.id === message.message.id)
                ? current
                : [...current, message.message],
            );
          }
          break;
        }
        case "chat.error": {
          disarmWatchdog();
          setStreamingByThread({});
          if (message.threadId) {
            setToolActivity((current) =>
              current.filter((item) => item.threadId !== message.threadId),
            );
            setApprovals((current) =>
              current.filter((item) => item.threadId !== message.threadId),
            );
          } else {
            setToolActivity([]);
            setApprovals([]);
          }
          const threadId = message.threadId ?? activeThreadIdRef.current;
          if (threadId !== null && threadId === activeThreadIdRef.current) {
            setMessages((current) => [
              ...current,
              {
                id: errorMessageId(),
                threadId,
                role: "assistant",
                content: message.message,
                model: null,
                toolCalls: null,
                createdAt: new Date().toISOString(),
              },
            ]);
          } else {
            setError(message.message);
          }
          break;
        }
      }
    };

    const offStatus = client.onStatus((next) => {
      setStatus(next);
      if (next === "connected") {
        outageRef.current = false;
        return;
      }
      if (next === "disconnected") {
        clearInFlight();
        if (!outageRef.current) {
          outageRef.current = true;
          setError(DISCONNECTED_ERROR);
        }
      }
    });
    const offMessage = client.onMessage(handleMessage);
    client.connect();
    return () => {
      offStatus();
      offMessage();
      client.disconnect();
    };
  }, [client, activateBot, armWatchdog, disarmWatchdog, clearInFlight]);

  const sendMessage = useCallback(
    (text: string) => {
      const botId = selectedBotIdRef.current;
      if (!botId) {
        setError("no bot available on the daemon");
        return;
      }
      if (client.status !== "connected") {
        setError(DISCONNECTED_ERROR);
        return;
      }
      const threadId = activeThreadIdRef.current;
      setError(null);
      setMessages((current) => [
        ...current,
        {
          id: localMessageId(),
          threadId: threadId ?? "pending",
          role: "user",
          content: text,
          model: null,
          toolCalls: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      client.send({
        type: "chat.send",
        botId,
        ...(threadId ? { threadId } : {}),
        text,
        ...(selectedModel ? { model: selectedModel } : {}),
      });
    },
    [client, selectedModel],
  );

  const cancel = useCallback(() => {
    const threadId = activeThreadIdRef.current;
    const current = threadId ? streamingRef.current[threadId] : null;
    if (current) {
      client.send({ type: "chat.cancel", runId: current.runId });
    }
  }, [client]);

  const respondToApproval = useCallback(
    (requestId: string, decision: "approve" | "deny") => {
      client.send({ type: "approval.respond", requestId, decision });
      setApprovals((current) =>
        current.map((approval) =>
          approval.requestId === requestId
            ? { ...approval, decision }
            : approval,
        ),
      );
    },
    [client],
  );

  const selectBot = useCallback(
    (botId: string) => {
      activateBot(botId, threadsRef.current);
    },
    [activateBot],
  );

  const createBot = useCallback(
    (input: CreateBotInput): Promise<Bot> => {
      const requestId = `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        createRequests.current.set(requestId, { resolve, reject });
        client.send({ type: "bots.create", requestId, ...input });
        setTimeout(() => {
          const pending = createRequests.current.get(requestId);
          if (pending) {
            createRequests.current.delete(requestId);
            pending.reject(new Error("timed out waiting for the daemon"));
          }
        }, 15_000);
      });
    },
    [client],
  );

  const updateBotComputer = useCallback(
    (botId: string, computer: ComputerKind) => {
      const requestId = `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      client.send({ type: "bots.update", requestId, botId, computer });
    },
    [client],
  );

  const deleteBot = useCallback(
    (botId: string) => {
      const requestId = `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      client.send({ type: "bots.delete", requestId, botId });
    },
    [client],
  );

  const saveProvider = useCallback(
    (provider: ProviderInput) => {
      client.send({ type: "provider.upsert", provider });
    },
    [client],
  );

  const removeProvider = useCallback(
    (id: string) => {
      client.send({ type: "provider.remove", id });
    },
    [client],
  );

  const updateSettings = useCallback(
    (settings: {
      defaultModel?: ModelRef;
      requireApproval?: boolean;
      harness?: { default: HarnessId };
    }) => {
      client.send({ type: "settings.update", settings });
    },
    [client],
  );

  const fetchModels = useCallback(
    (input: {
      providerId?: string;
      baseUrl: string;
      apiKey?: string;
    }): Promise<FetchModelsResult> => {
      const requestId = `fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve) => {
        modelRequests.current.set(requestId, resolve);
        client.send({
          type: "provider.fetchModels",
          requestId,
          ...(input.providerId ? { providerId: input.providerId } : {}),
          baseUrl: input.baseUrl,
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        });
        setTimeout(() => {
          if (modelRequests.current.has(requestId)) {
            modelRequests.current.delete(requestId);
            resolve({
              ok: false,
              models: [],
              error: "timed out waiting for the daemon",
            });
          }
        }, 20_000);
      });
    },
    [client],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const streaming =
    activeThreadId !== null
      ? (streamingByThread[activeThreadId] ?? null)
      : null;

  const modelOptions: ModelOption[] = providers
    .filter(isProviderUsable)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        provider: provider.id,
        providerLabel: provider.label,
        model,
      })),
    );

  return {
    status,
    bots,
    threads,
    selectedBotId,
    providers,
    presets,
    modelOptions,
    defaultModel,
    requireApproval,
    harness,
    codex,
    selectedModel,
    setSelectedModel,
    activeThreadId,
    messages,
    streaming,
    error,
    toolActivity,
    approvals,
    sandboxStates,
    sendMessage,
    cancel,
    respondToApproval,
    selectBot,
    createBot,
    updateBotComputer,
    deleteBot,
    saveProvider,
    removeProvider,
    updateSettings,
    fetchModels,
    clearError,
  };
}
