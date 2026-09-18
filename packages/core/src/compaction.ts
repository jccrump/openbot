import {
  modelContextWindow,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type TokenUsage,
} from "@openbot/gateway";
import type {
  CompactionMeta,
  CompactionSettings,
  CompactionTrigger,
  Message,
  ModelRef,
  Thread,
} from "@openbot/protocol";
import type { Store } from "./store";

export const COMPACTION_SETTING_KEY = "compaction";
export const DEFAULT_COMPACTION_THRESHOLD = 100_000;
export const MIN_COMPACTION_THRESHOLD = 32_000;
export const MAX_COMPACTION_THRESHOLD = 1_000_000;
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  thresholdTokens: null,
};

const MIN_KEEP_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TOOL_ARGUMENT_CHARS = 300;
const MAX_TOOL_OUTPUT_CHARS = 1_000;
const MAX_TRANSCRIPT_CHARS = 60_000;

export const SUMMARY_PREFIX =
  "[conversation summary] Earlier messages were compacted. Key context:\n\n";

const SUMMARIZER_SYSTEM_PROMPT =
  "You compact an ongoing conversation so it can continue inside a limited " +
  "context window. Summarize the transcript below concisely, preserving the " +
  "user's goals and intent, decisions already made, constraints and " +
  "preferences, important file paths, commands, identifiers, and tool results " +
  "that matter, plus any unresolved tasks or open questions. Drop " +
  "pleasantries, repetition, and details that no longer matter. Write short " +
  "paragraphs or bullets, keep the conversation's language, and never invent " +
  "details that are not in the transcript.";

const OVERFLOW_PATTERNS: RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /too many tokens/i,
  /token limit/i,
  /input is too long/i,
  /prompt is too long/i,
  /reduce the length/i,
  /request too large/i,
];

export function clampCompactionThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_COMPACTION_THRESHOLD;
  }
  return Math.min(
    MAX_COMPACTION_THRESHOLD,
    Math.max(MIN_COMPACTION_THRESHOLD, Math.floor(value)),
  );
}

export function contextWindowFor(model: string): number | null {
  return modelContextWindow(model);
}

export function resolveCompactionThreshold(
  settings: CompactionSettings,
  model: string,
): number {
  if (settings.thresholdTokens !== null) {
    return clampCompactionThreshold(settings.thresholdTokens);
  }
  const window = contextWindowFor(model);
  if (window !== null) {
    return clampCompactionThreshold(Math.floor(window * 0.75));
  }
  return DEFAULT_COMPACTION_THRESHOLD;
}

export function parseCompactionSettings(
  raw: string | null,
): CompactionSettings {
  if (raw === null) {
    return DEFAULT_COMPACTION_SETTINGS;
  }
  try {
    const parsed = JSON.parse(raw) as {
      enabled?: unknown;
      thresholdTokens?: unknown;
    };
    return {
      enabled: parsed.enabled !== false,
      thresholdTokens:
        typeof parsed.thresholdTokens === "number"
          ? clampCompactionThreshold(parsed.thresholdTokens)
          : null,
    };
  } catch {
    return DEFAULT_COMPACTION_SETTINGS;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateChatTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += (message.content?.length ?? 0) + 4;
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        chars += call.name.length + call.arguments.length + 12;
      }
    }
  }
  return Math.ceil(chars / 4);
}

function messageTokens(message: Message): number {
  let chars = message.content.length + 4;
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      chars +=
        call.name.length + call.arguments.length + call.output.length + 12;
    }
  }
  return Math.ceil(chars / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += messageTokens(message);
  }
  return total;
}

export interface CompactionSpan {
  toCompact: Message[];
  kept: Message[];
}

export function planCompaction(
  messages: Message[],
  thresholdTokens: number,
  trigger: CompactionTrigger,
): CompactionSpan | null {
  const maxFoldable = messages.length - MIN_KEEP_MESSAGES;
  if (maxFoldable < 1) {
    return null;
  }

  const total = estimateMessagesTokens(messages);
  const target =
    trigger === "auto" ? Math.floor(thresholdTokens / 2) : Math.floor(total / 2);

  let remaining = total;
  let count = 0;
  while (count < maxFoldable && remaining > target) {
    remaining -= messageTokens(messages[count]!);
    count += 1;
  }
  if (count === 0 && trigger !== "auto") {
    count = 1;
  }
  if (count === 0) {
    return null;
  }
  return {
    toCompact: messages.slice(0, count),
    kept: messages.slice(count),
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated]`;
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const half = Math.floor(max / 2);
  return `${value.slice(0, half)}\n...[transcript truncated]...\n${value.slice(value.length - half)}`;
}

function renderTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const label = message.role === "user" ? "User" : "Assistant";
    let text = `${label}: ${truncate(message.content.trim(), MAX_MESSAGE_CHARS)}`;
    if (message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        text += `\n  [${call.name}] ${truncate(call.arguments, MAX_TOOL_ARGUMENT_CHARS)} -> ${truncate(call.output, MAX_TOOL_OUTPUT_CHARS)}`;
      }
    }
    parts.push(text);
  }
  return truncateMiddle(parts.join("\n\n"), MAX_TRANSCRIPT_CHARS);
}

async function summarize(
  provider: ChatProvider,
  model: ModelRef,
  transcript: string,
  userMessage: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ text: string; usage: TokenUsage | null }> {
  const content = userMessage
    ? `${transcript}\n\nAdditional context from the user for this summary:\n${userMessage}`
    : transcript;
  const request: ChatRequest = {
    model: model.model,
    messages: [
      { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
      { role: "user", content },
    ],
    ...(model.effort ? { reasoningEffort: model.effort } : {}),
    ...(signal ? { signal } : {}),
  };

  let text = "";
  let usage: TokenUsage | null = null;
  for await (const event of provider.chat(request)) {
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "usage") {
      usage = event.usage;
    }
  }
  return { text: text.trim(), usage };
}

export interface CompactionInput {
  store: Store;
  provider: ChatProvider;
  model: ModelRef;
  threadId: string;
  trigger: CompactionTrigger;
  thresholdTokens: number;
  systemPrompt?: string;
  userMessage?: string;
  signal?: AbortSignal;
}

export interface CompactionOutcome {
  summaryMessage: Message;
  thread: Thread;
  meta: CompactionMeta;
}

export async function compactThread(
  input: CompactionInput,
): Promise<CompactionOutcome | null> {
  const messages = input.store.listMessages(input.threadId);
  const span = planCompaction(messages, input.thresholdTokens, input.trigger);
  if (!span) {
    return null;
  }

  const systemTokens = input.systemPrompt
    ? estimateTokens(input.systemPrompt)
    : 0;
  const tokensBefore = estimateMessagesTokens(messages) + systemTokens;
  const { text, usage } = await summarize(
    input.provider,
    input.model,
    renderTranscript(span.toCompact),
    input.userMessage,
    input.signal,
  );
  if (!text) {
    throw new Error("summarizer returned an empty summary");
  }

  const tokensAfter =
    estimateMessagesTokens(span.kept) +
    systemTokens +
    estimateTokens(text) +
    estimateTokens(SUMMARY_PREFIX);
  const isFirstCompaction =
    (input.store.getThread(input.threadId)?.compactionCount ?? 0) === 0;
  const meta: CompactionMeta = {
    trigger: input.trigger,
    messagesToCompact: span.toCompact.length,
    tokensBefore,
    tokensAfter,
    isFirstCompaction,
  };

  const lastFolded = span.toCompact[span.toCompact.length - 1]!;
  const summaryMessage = input.store.addMessage({
    threadId: input.threadId,
    role: "assistant",
    content: `${SUMMARY_PREFIX}${text}`,
    model: input.model,
    createdAt: lastFolded.createdAt,
    usage,
    compaction: meta,
  });
  input.store.foldMessages(
    input.threadId,
    span.toCompact.map((message) => message.id),
  );
  const thread =
    input.store.markCompacted(input.threadId) ??
    input.store.getThread(input.threadId)!;

  return { summaryMessage, thread, meta };
}

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bHTTP 413\b/.test(message)) {
    return true;
  }
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}
