import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalRecord,
  ApprovalTier,
  Bot,
  CodexInfo,
  ComputerKind,
  DecisionInfo,
  DecisionSettingsPatch,
  HarnessId,
  HarnessSettings,
  Memory,
  Message,
  ModelRef,
  PolicyPresetId,
  PolicySettings,
  ProviderInfo,
  ProviderPreset,
  RolePolicy,
  ServerMessage,
  SoulVersion,
  Task,
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
  reasoning: string;
  startedAt: number;
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
  at: number;
}

export interface DecisionActivity {
  threadId: string;
  messageId: string;
  id: string;
  kind: "audit" | "browse" | "route" | "guardrail";
  summary: string;
  flagged: boolean;
  latencyMs: number | null;
  model: string | null;
  at: number;
}

export interface PendingApproval {
  threadId: string;
  requestId: string;
  callId: string;
  name: string;
  tier?: ApprovalTier;
  reason?: string;
  arguments: string;
  decision: "approve" | "deny" | null;
}

export interface PendingChallenge {
  threadId: string;
  requestId: string;
  callId: string;
  url: string | null;
  action: "retry" | "skip" | null;
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

export interface DecisionTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number | null;
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
    case "chat.decision":
    case "chat.compaction":
    case "chat.message":
    case "tool.start":
    case "tool.output":
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelRef | null>(null);
  const [requireApproval, setRequireApproval] = useState(true);
  const [policy, setPolicy] = useState<PolicySettings>({
    timeoutMs: 10 * 60_000,
    defaultTier: "inherit",
    tools: {},
    rules: [],
  });
  const [harness, setHarness] = useState<HarnessSettings>({
    default: "openbot",
  });
  const [decision, setDecision] = useState<DecisionInfo | null>(null);
  const [codex, setCodex] = useState<CodexInfo | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // A thread opened in the drawer is fetched on the side so it can be shown
  // without switching the chat behind it.
  const [previewThreadId, setPreviewThreadId] = useState<string | null>(null);
  const [previewMessages, setPreviewMessages] = useState<Message[]>([]);
  const [streamingByThread, setStreamingByThread] = useState<
    Record<string, StreamingState>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [decisions, setDecisions] = useState<DecisionActivity[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [challenges, setChallenges] = useState<PendingChallenge[]>([]);
  const [sandboxStates, setSandboxStates] = useState<
    Record<string, SandboxState>
  >({});
  const [memories, setMemories] = useState<Memory[]>([]);
  const [soul, setSoul] = useState<SoulVersion | null>(null);
  const [soulVersions, setSoulVersions] = useState<SoulVersion[]>([]);
  const [lastConsolidation, setLastConsolidation] = useState<{
    archived: number;
    merged: number;
  } | null>(null);
  const [approvalRecords, setApprovalRecords] = useState<ApprovalRecord[]>([]);

  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const previewThreadIdRef = useRef<string | null>(null);
  previewThreadIdRef.current = previewThreadId;
  const streamingRef = useRef<Record<string, StreamingState>>({});
  streamingRef.current = streamingByThread;
  const toolActivityRef = useRef<ToolActivity[]>([]);
  toolActivityRef.current = toolActivity;
  const watchdogTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const outageRef = useRef(false);
  const botsRef = useRef<Bot[]>(bots);
  botsRef.current = bots;
  const tasksRef = useRef<Task[]>(tasks);
  tasksRef.current = tasks;
  const threadsRef = useRef<Thread[]>(threads);
  threadsRef.current = threads;
  const providersRef = useRef<ProviderInfo[]>(providers);
  providersRef.current = providers;
  const selectedBotIdRef = useRef<string | null>(selectedBotId);
  selectedBotIdRef.current = selectedBotId;
  const selectedTaskIdRef = useRef<string | null>(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const modelRequests = useRef(
    new Map<string, (result: FetchModelsResult) => void>(),
  );
  const decisionTestRequests = useRef(
    new Map<string, (result: DecisionTestResult) => void>(),
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
      setSelectedTaskId(null);
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
    // A tool can legitimately run for longer than the watchdog window (shell
    // commands cap at 300s), so an active tool re-arms instead of firing.
    const schedule = () => {
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
          if (
            toolActivityRef.current.some(
              (item) =>
                item.threadId === threadId && item.status === "running",
            )
          ) {
            schedule();
            return;
          }
          if (tasksRef.current.some((task) => task.threadId === threadId)) {
            // Worker streams belong to the workboard; the task row is the
            // source of truth, so a quiet worker never raises a global error.
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
    };
    schedule();
  }, []);

  const clearInFlight = useCallback(() => {
    disarmWatchdog();
    setStreamingByThread({});
    setToolActivity([]);
    setApprovals([]);
    setChallenges([]);
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
          setTasks(message.tasks ?? []);
          setThreads(message.threads);
          setProviders(message.providers);
          setPresets(message.presets);
          setDefaultModel(message.defaultModel);
          setRequireApproval(message.requireApproval);
          if (message.policy) {
            setPolicy(message.policy);
          }
          setHarness(message.harness ?? { default: "openbot" });
          setDecision(message.decision ?? null);
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
          // The chat always belongs to the main agent; every other thread is
          // opened in the drawer instead.
          const lead =
            message.bots.find((item) => item.kind === "lead") ?? null;
          const bot =
            lead ??
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
          if (
            message.bot.id === selectedBotIdRef.current &&
            isModelUsable(providersRef.current, message.bot.model)
          ) {
            // The agent's model is the source of truth for the composer, so a
            // persisted change (composer or settings) is reflected right away.
            setSelectedModel(message.bot.model);
          }
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
          setTasks((current) =>
            current.filter((task) => task.roleId !== message.botId),
          );
          const selectedTask = tasksRef.current.find(
            (task) => task.id === selectedTaskIdRef.current,
          );
          if (selectedTask && selectedTask.roleId === message.botId) {
            setSelectedTaskId(null);
            setActiveThreadId(null);
            setMessages([]);
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
        case "bot.reset": {
          const replacedThreadIds = new Set(
            threadsRef.current
              .filter((thread) => thread.botId === message.botId)
              .map((thread) => thread.id),
          );
          setThreads((current) => [
            ...current.filter((thread) => thread.botId !== message.botId),
            message.thread,
          ]);
          for (const threadId of replacedThreadIds) {
            disarmWatchdog(threadId);
          }
          setStreamingByThread((current) => {
            const next = { ...current };
            for (const threadId of replacedThreadIds) {
              delete next[threadId];
            }
            return next;
          });
          setToolActivity((current) =>
            current.filter((item) => !replacedThreadIds.has(item.threadId)),
          );
          setApprovals((current) =>
            current.filter((item) => !replacedThreadIds.has(item.threadId)),
          );
          setDecisions((current) =>
            current.filter((item) => !replacedThreadIds.has(item.threadId)),
          );
          setTasks((current) =>
            current.filter((task) => task.roleId !== message.botId),
          );
          const selectedResetTask = tasksRef.current.find(
            (task) => task.id === selectedTaskIdRef.current,
          );
          if (selectedResetTask && selectedResetTask.roleId === message.botId) {
            setSelectedTaskId(null);
          }
          if (selectedBotIdRef.current === message.botId) {
            setActiveThreadId(message.thread.id);
            setMessages([]);
          }
          break;
        }
        case "providers.updated": {
          setProviders(message.providers);
          setDefaultModel(message.defaultModel);
          setRequireApproval(message.requireApproval);
          if (message.policy) {
            setPolicy(message.policy);
          }
          setHarness(message.harness ?? { default: "openbot" });
          setDecision(message.decision ?? null);
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
        case "decision.test": {
          const resolve = decisionTestRequests.current.get(message.requestId);
          if (resolve) {
            decisionTestRequests.current.delete(message.requestId);
            resolve({
              ok: message.ok,
              model: message.model,
              latencyMs: message.latencyMs,
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
          if (message.threadId === previewThreadIdRef.current) {
            setPreviewMessages(message.messages);
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
          setChallenges((current) =>
            current.filter((item) => item.threadId !== message.threadId),
          );
          setStreamingByThread((current) => ({
            ...current,
            [message.threadId]: {
              runId: message.runId,
              threadId: message.threadId,
              messageId: message.messageId,
              text: "",
              reasoning: "",
              startedAt: Date.now(),
            },
          }));
          break;
        }
        case "chat.reasoning": {
          setStreamingByThread((current) => {
            const entry = current[message.threadId];
            if (!entry || entry.messageId !== message.messageId) {
              return current;
            }
            return {
              ...current,
              [message.threadId]: {
                ...entry,
                reasoning: entry.reasoning + message.text,
              },
            };
          });
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
                text: message.reset ? message.text : entry.text + message.text,
              },
            };
          });
          break;
        }
        case "chat.decision": {
          setDecisions((current) => [
            ...current,
            {
              threadId: message.threadId,
              messageId: message.messageId,
              id: `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              kind: message.kind,
              summary: message.summary,
              flagged: message.flagged,
              latencyMs: message.latencyMs,
              model: message.model,
              at: Date.now(),
            },
          ]);
          break;
        }
        case "tool.start": {
          setToolActivity((current) => {
            if (current.some((item) => item.callId === message.callId)) {
              return current;
            }
            return [
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
                at: Date.now(),
              },
            ];
          });
          break;
        }
        case "tool.output": {
          setToolActivity((current) =>
            current.map((activity) =>
              activity.callId === message.callId
                ? {
                    ...activity,
                    output: `${activity.output ?? ""}${message.text}`.slice(
                      -40_000,
                    ),
                  }
                : activity,
            ),
          );
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
              tier: message.tier,
              reason: message.reason,
              decision: null,
            },
          ]);
          break;
        }
        case "approval.resolved": {
          setApprovals((current) =>
            current.map((approval) =>
              approval.requestId === message.requestId &&
              approval.decision === null
                ? {
                    ...approval,
                    decision:
                      message.decision === "approve" ? "approve" : "deny",
                  }
                : approval,
            ),
          );
          break;
        }
        case "approvals.list": {
          setApprovalRecords(message.approvals);
          break;
        }
        case "challenge.request": {
          disarmWatchdog(message.threadId);
          setChallenges((current) => [
            ...current,
            {
              threadId: message.threadId,
              requestId: message.requestId,
              callId: message.callId,
              url: message.url,
              action: null,
            },
          ]);
          break;
        }
        case "task.upserted": {
          setTasks((current) => {
            const index = current.findIndex(
              (task) => task.id === message.task.id,
            );
            if (index === -1) {
              return [message.task, ...current];
            }
            const next = [...current];
            next[index] = message.task;
            return next;
          });
          break;
        }
        case "sandbox.state": {
          setSandboxStates((current) => ({
            ...current,
            [message.taskId ?? message.botId]: message.state,
          }));
          break;
        }
        case "memory.list": {
          setMemories(message.memories);
          break;
        }
        case "memory.removed": {
          setMemories((current) =>
            current.filter((memory) => memory.id !== message.id),
          );
          break;
        }
        case "memory.consolidated": {
          setLastConsolidation({
            archived: message.archived,
            merged: message.merged,
          });
          break;
        }
        case "soul": {
          setSoul(message.soul);
          setSoulVersions(message.versions);
          break;
        }
        case "chat.message": {
          setToolActivity((current) =>
            current.filter((item) => item.threadId !== message.threadId),
          );
          const appendMessage = (current: Message[]) =>
            current.some((item) => item.id === message.message.id)
              ? current
              : [...current, message.message];
          if (message.threadId === activeThreadIdRef.current) {
            setMessages(appendMessage);
          }
          if (message.threadId === previewThreadIdRef.current) {
            setPreviewMessages(appendMessage);
          }
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
          setChallenges((current) =>
            current.filter((item) => item.threadId !== message.threadId),
          );
          const appendDone = (current: Message[]) =>
            current.some((item) => item.id === message.message.id)
              ? current
              : [...current, message.message];
          if (message.threadId === activeThreadIdRef.current) {
            setMessages(appendDone);
          }
          if (message.threadId === previewThreadIdRef.current) {
            setPreviewMessages(appendDone);
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
            setChallenges((current) =>
              current.filter((item) => item.threadId !== message.threadId),
            );
          } else {
            setToolActivity([]);
            setApprovals([]);
            setChallenges([]);
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

  const cancelThread = useCallback(
    (threadId: string) => {
      const current = streamingRef.current[threadId];
      if (current) {
        client.send({ type: "chat.cancel", runId: current.runId });
      }
    },
    [client],
  );

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

  const respondToChallenge = useCallback(
    (requestId: string, action: "retry" | "skip") => {
      client.send({ type: "challenge.respond", requestId, action });
      setChallenges((current) =>
        current.map((challenge) =>
          challenge.requestId === requestId
            ? { ...challenge, action }
            : challenge,
        ),
      );
      const threadId = activeThreadIdRef.current;
      if (threadId !== null) {
        armWatchdog(threadId);
      }
    },
    [client, armWatchdog],
  );

  const selectBot = useCallback(
    (botId: string) => {
      activateBot(botId, threadsRef.current);
    },
    [activateBot],
  );

  const selectTask = useCallback(
    (taskId: string) => {
      const task = tasksRef.current.find((item) => item.id === taskId) ?? null;
      if (!task) {
        return;
      }
      setSelectedTaskId(taskId);
      setActiveThreadId(task.threadId ?? null);
      setMessages([]);
      if (task.threadId) {
        client.send({ type: "thread.messages", threadId: task.threadId });
      }
    },
    [client],
  );

  const cancelTask = useCallback(
    (taskId: string) => {
      client.send({ type: "task.cancel", taskId });
    },
    [client],
  );

  const loadApprovals = useCallback(
    (limit?: number) => {
      client.send({ type: "approvals.list", ...(limit ? { limit } : {}) });
    },
    [client],
  );

  const loadMemories = useCallback(
    (scope?: string) => {
      client.send({ type: "memory.list", ...(scope ? { scope } : {}) });
    },
    [client],
  );

  const removeMemory = useCallback(
    (id: string) => {
      client.send({ type: "memory.remove", id });
    },
    [client],
  );

  const consolidateMemories = useCallback(() => {
    client.send({ type: "memory.consolidate" });
  }, [client]);

  const loadSoul = useCallback(
    (botId?: string) => {
      client.send({ type: "soul.get", ...(botId ? { botId } : {}) });
    },
    [client],
  );

  const revertSoul = useCallback(
    (versionId: string, botId?: string) => {
      client.send({
        type: "soul.revert",
        versionId,
        ...(botId ? { botId } : {}),
      });
    },
    [client],
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

  const updateBot = useCallback(
    (
      botId: string,
      patch: {
        name?: string;
        role?: string | null;
        avatar?: string | null;
        color?: string | null;
        computer?: ComputerKind;
        delegates?: boolean;
        policy?: RolePolicy;
        model?: ModelRef;
      },
    ) => {
      const requestId = `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      client.send({ type: "bots.update", requestId, botId, ...patch });
    },
    [client],
  );

  /**
   * Change the selected agent's model (and its reasoning effort) from the
   * composer. The choice is persisted on the agent, so a refresh or relaunch
   * restores it, and delegated work uses the same model.
   */
  const chooseModel = useCallback(
    (model: ModelRef) => {
      setSelectedModel(model);
      const botId = selectedBotIdRef.current;
      if (botId) {
        updateBot(botId, { model });
      }
    },
    [updateBot],
  );

  const powerBot = useCallback(
    (botId: string, on: boolean) => {
      const requestId = `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      client.send({ type: "bots.power", requestId, botId, on });
    },
    [client],
  );

  const refreshSandboxState = useCallback(
    (botId: string) => {
      client.send({ type: "sandbox.status", botId });
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

  const resetBot = useCallback(
    (botId: string) => {
      const requestId = `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      client.send({ type: "bots.reset", requestId, botId });
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
      policy?: PolicySettings;
      policyPreset?: PolicyPresetId;
      harness?: { default: HarnessId };
      decision?: DecisionSettingsPatch;
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

  const testDecision = useCallback((): Promise<DecisionTestResult> => {
    const requestId = `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      decisionTestRequests.current.set(requestId, resolve);
      client.send({ type: "decision.test", requestId });
      setTimeout(() => {
        if (decisionTestRequests.current.has(requestId)) {
          decisionTestRequests.current.delete(requestId);
          resolve({
            ok: false,
            model: null,
            latencyMs: null,
            error: "timed out waiting for the daemon",
          });
        }
      }, 15_000);
    });
  }, [client]);

  const streaming =
    activeThreadId !== null
      ? (streamingByThread[activeThreadId] ?? null)
      : null;

  const previewStreaming =
    previewThreadId !== null
      ? (streamingByThread[previewThreadId] ?? null)
      : null;

  // The drawer reads a thread without making it the active one: fetch its
  // messages on the side, and reply into it with chat.send's explicit thread.
  const openThreadPreview = useCallback(
    (threadId: string) => {
      setPreviewThreadId(threadId);
      setPreviewMessages([]);
      client.send({ type: "thread.messages", threadId });
    },
    [client],
  );

  const closeThreadPreview = useCallback(() => {
    setPreviewThreadId(null);
    setPreviewMessages([]);
  }, []);

  const sendMessageToThread = useCallback(
    (threadId: string, botId: string, text: string) => {
      if (client.status !== "connected") {
        setError(DISCONNECTED_ERROR);
        return;
      }
      const optimistic: Message = {
        id: localMessageId(),
        threadId,
        role: "user",
        content: text,
        model: null,
        toolCalls: null,
        createdAt: new Date().toISOString(),
      };
      if (threadId === activeThreadIdRef.current) {
        setMessages((current) => [...current, optimistic]);
      } else {
        setPreviewMessages((current) => [...current, optimistic]);
      }
      setError(null);
      client.send({ type: "chat.send", botId, threadId, text });
    },
    [client],
  );

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
    tasks,
    threads,
    selectedBotId,
    selectedTaskId,
    selectTask,
    cancelTask,
    memories,
    soul,
    soulVersions,
    lastConsolidation,
    approvalRecords,
    loadApprovals,
    loadMemories,
    removeMemory,
    consolidateMemories,
    loadSoul,
    revertSoul,
    providers,
    presets,
    modelOptions,
    defaultModel,
    requireApproval,
    policy,
    harness,
    decision,
    codex,
    selectedModel,
    chooseModel,
    activeThreadId,
    messages,
    streaming,
    previewThreadId,
    previewMessages,
    previewStreaming,
    openThreadPreview,
    closeThreadPreview,
    sendMessageToThread,
    error,
    toolActivity,
    decisions,
    approvals,
    challenges,
    sandboxStates,
    sendMessage,
    cancel,
    cancelThread,
    respondToApproval,
    respondToChallenge,
    selectBot,
    createBot,
    updateBot,
    powerBot,
    refreshSandboxState,
    deleteBot,
    resetBot,
    saveProvider,
    removeProvider,
    updateSettings,
    fetchModels,
    testDecision,
    clearError,
  };
}
