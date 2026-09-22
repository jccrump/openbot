import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  modelSupportsImages,
  type ChatMessage,
  type ChatProvider,
  type ContentPart,
  type ReasoningEffort,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
} from "@openbot/gateway";
import type {
  ApprovalTier,
  CompactionSettings,
  CompactionTrigger,
  ComputerKind,
  FileChange,
  Message,
  ModelRef,
  PlanStep,
  PolicySettings,
  RoutineRef,
  ServerMessage,
  ToolArtifact,
  ToolCallRecord,
} from "@openbot/protocol";
import { botComputers, botHasComputer, primaryComputer } from "@openbot/protocol";
import type { SandboxBackend } from "@openbot/sandbox";
import type { ApprovalBroker } from "./approvals";
import type { ChallengeBroker } from "./challenges";
import {
  compactThread,
  estimateChatTokens,
  isContextOverflowError,
  planCompaction,
  resolveCompactionThreshold,
} from "./compaction";
import type { DecisionNotice, DecisionRuntime } from "./decision";
import type { ProviderRecord, Store } from "./store";
import { DEFAULT_THREAD_TITLE } from "./store";
import type { MemoryService } from "./memory";
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  mergePolicies,
  rolePolicySettings,
} from "./policy";
import {
  GUARDRAIL_BLOCKED,
  GUARDRAIL_WARNING,
  guardrailSummary,
  looksLikeInjection,
  screenUntrustedText,
} from "./guardrail";
import type { SoulService } from "./soul";
import { renderTodoNote, type TodoService } from "./todos";
import {
  findTool,
  isApprovalExemptTool,
  resolveToolComputer,
  toolDefinitions,
  type Tool,
  type ToolContext,
  type ToolImage,
} from "./tools";
import { workspaceGuestRoot } from "./workspaces";
import { renderSelfNote, type SelfInfo } from "./self";
import {
  annotateBrowserObservation,
  annotateWebSearchObservation,
  buildCompletionAuditRequest,
  buildJevVerificationFeedback,
  buildVerificationFeedback,
  COMPLETION_VERIFIER_SYSTEM_PROMPT,
  evaluateJevAudit,
  parseCompletionAudit,
  shouldAuditCompletion,
  type CompletionAudit,
} from "./task-harness";

export interface AgentDeps {
  store: Store;
  providers: Map<string, ChatProvider>;
  sandbox: SandboxBackend | null;
  approvals: ApprovalBroker;
  challenges: ChallengeBroker;
  requireApproval: boolean;
  artifactsDir: string;
  compaction: () => CompactionSettings;
  decision: () => DecisionRuntime;
  sandboxUrl: string;
  dataDir: string;
  providerRecord: (id: string) => ProviderRecord | null;
  resolveProviderKey: (record: ProviderRecord) => string | undefined;
  memory?: MemoryService | null;
  soul?: SoulService | null;
  /** The agent's durable todo list; the user edits the same list in the app. */
  todos?: TodoService | null;
  policy?: () => PolicySettings;
  /** What the daemon knows about itself (system_info and the [self] note). */
  self?: SelfInfo;
  /** Schedule a daemon restart after the current work settles. */
  requestRestart?: () => { ok: boolean; message: string };
}

/** Messages typed while a turn is running; the loop drains them at step
 * boundaries so the model can change course without restarting the turn. */
export interface SteeringChannel {
  hasPending(): boolean;
  drain(): string[];
}

export interface AgentInput {
  runId: string;
  botId: string;
  threadId?: string;
  text: string;
  model?: ModelRef;
  /** Client-generated id for the persisted user message. */
  messageId?: string;
  /** The user message is already in the store (queued or steered delivery). */
  skipUserMessage?: boolean;
  /** Mid-turn user messages to fold into the running conversation. */
  steering?: SteeringChannel;
  /** Extra system context injected for this turn only; never persisted. */
  contextNote?: string;
  /**
   * Run this turn on one of the agent's computers instead of its primary.
   * A routine pins its computer; an ungranted value falls back to the primary.
   */
  computer?: ComputerKind;
  /** Set when a routine's brief started this turn. */
  routine?: RoutineRef | null;
}

const PROVIDER_STEP_TIMEOUT_MS = 120_000;
const MAX_AUDIT_REVISIONS = 2;
// A turn may chain many tool steps: a coding task can legitimately run long.
// The cap is a runaway guard, not a policy. The turn ends with a note and the
// user can ask the agent to continue.
const MAX_TOOL_STEPS = 60;
// The same failing call repeated this many times means the model is stuck on an
// approach; stop the turn instead of burning it on identical retries.
const MAX_REPEATED_TOOL_FAILURES = 3;
// A sandbox request that never reached the VM (host down, VM still booting,
// socket refused) is safe to retry once: no command ran, so nothing is
// duplicated. Failures after the request was delivered are not retried.
const SANDBOX_RETRY_DELAY_MS = 1_500;
const TRANSIENT_TOOL_ERROR =
  /(sandbox host unreachable|sandbox host returned 5\d\d|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|did not become ready|api socket did not appear|EAI_AGAIN|ETIMEDOUT|timed out waiting for)/i;
// Some providers occasionally emit their raw tool-call markup as assistant
// text (DeepSeek's DSML) instead of a structured tool call. Detect it so the
// turn can nudge once and retry instead of finalizing broken markup.
const RAW_TOOL_MARKUP = /<[｜|]{1,2}\s*(DSML|tool_calls?|function_calls?)/i;
const MAX_MARKUP_REVISIONS = 2;
// Provider failures worth retrying before the turn gives up. "terminated",
// "other side closed", and "premature close" are undici's stream-cut errors.
const TRANSIENT_PROVIDER_ERROR =
  /(\b429\b|rate.?limit|overloaded|\b5\d\d\b|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|EAI_AGAIN|ETIMEDOUT|terminated|other side closed|premature close|UND_ERR)/i;
const MAX_PROVIDER_RETRIES = 2;
const PROVIDER_RETRY_BASE_MS = 1_000;
const PROVIDER_RETRY_MAX_MS = 30_000;

/**
 * Exponential backoff with jitter. A provider's Retry-After header wins when
 * the gateway passed it through, since the server knows better than we do.
 */
function providerRetryDelay(error: unknown, attempt: number): number {
  const message = (error as Error)?.message ?? String(error);
  const header = /retry-after:\s*(\d+)/i.exec(message);
  if (header) {
    return Math.min(Number(header[1]) * 1_000, PROVIDER_RETRY_MAX_MS);
  }
  const exponential = PROVIDER_RETRY_BASE_MS * 2 ** attempt;
  return (
    Math.min(exponential, PROVIDER_RETRY_MAX_MS) +
    Math.floor(Math.random() * 500)
  );
}

const UNKNOWN_TOOL_HINTS: Record<string, string> = {
  click:
    'browser and desktop are action-based: use browser {"action":"click","selector":"..."} for page elements, or desktop {"action":"click","x":0,"y":0} for the screen.',
  goto: 'use browser {"action":"goto","url":"..."}.',
  type:
    'use browser {"action":"type","selector":"...","text":"..."} or desktop {"action":"type","text":"..."}.',
  scroll:
    'use browser {"action":"scroll","pixels":600} or desktop {"action":"scroll","x":0,"y":0,"direction":"down"}.',
  screenshot:
    'use browser {"action":"screenshot"} or desktop {"action":"screenshot"}.',
  links: 'use browser {"action":"links"}.',
  fields: 'use browser {"action":"fields"}.',
  clickLink: 'use browser {"action":"clickLink","href":"..."}.',
  key: 'use desktop {"action":"key","keys":"Return"}.',
  drag: 'use desktop {"action":"drag","fromX":0,"fromY":0,"toX":0,"toY":0}.',
  windows: 'use desktop {"action":"windows"}.',
  activate: 'use desktop {"action":"activate","title":"..."}.',
};

function unknownToolMessage(name: string, available: string[]): string {
  const hint = UNKNOWN_TOOL_HINTS[name];
  const tools = available.length ? available.join(", ") : "none";
  return hint
    ? `unknown tool: ${name}. ${hint}`
    : `unknown tool: ${name}. Available tools: ${tools}.`;
}

/**
 * Tool failures are written for the model, not the user: name the tool, keep
 * the message, and say what to do next so the model can recover in the same
 * turn instead of crashing it.
 */
function toolErrorText(name: string, message: string): string {
  return (
    `[tool error] ${name}: ${message}\n` +
    "The tool did not run successfully. Check the arguments and try again, " +
    "or use a different approach."
  );
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function addUsage(
  total: TokenUsage | null,
  usage: TokenUsage,
): TokenUsage {
  const cacheRead =
    (total?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  return {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
  };
}

function abortFallback<T>(signal: AbortSignal, value: T): Promise<T> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(value);
      return;
    }
    signal.addEventListener("abort", () => resolve(value), { once: true });
  });
}

async function auditCompletion(input: {
  provider: ChatProvider;
  model: string;
  reasoningEffort?: ReasoningEffort;
  userRequest: string;
  candidate: string;
  records: ToolCallRecord[];
  signal: AbortSignal;
}): Promise<{
  audit: CompletionAudit | null;
  raw: string;
  usage: TokenUsage | null;
}> {
  let raw = "";
  let usage: TokenUsage | null = null;
  const providerSignal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(PROVIDER_STEP_TIMEOUT_MS),
  ]);
  for await (const event of input.provider.chat({
    model: input.model,
    messages: [
      { role: "system", content: COMPLETION_VERIFIER_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildCompletionAuditRequest(
          input.userRequest,
          input.candidate,
          input.records,
        ),
      },
    ],
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    signal: providerSignal,
  })) {
    if (event.type === "text_delta") {
      raw += event.text;
    } else if (event.type === "usage") {
      usage = addUsage(usage, event.usage);
    }
  }
  return { audit: parseCompletionAudit(raw), raw, usage };
}

function artifactImage(artifactsDir: string, url: string): ToolImage | null {
  const name = basename(url);
  if (!name) {
    return null;
  }
  try {
    const data = readFileSync(join(artifactsDir, name));
    return { data: data.toString("base64"), mimeType: "image/png" };
  } catch {
    return null;
  }
}

function imagePart(image: ToolImage): ContentPart {
  return {
    type: "image_url",
    image_url: { url: `data:${image.mimeType};base64,${image.data}` },
  };
}

// Screenshots are the most expensive tokens in the loop. Keep the newest one
// and strip images from older messages so a long run does not accumulate them.
function pruneHistoricalImages(messages: ChatMessage[]): void {
  let latestImage = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url")
    ) {
      latestImage = index;
      break;
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    if (index === latestImage) continue;
    const message = messages[index];
    if (message && Array.isArray(message.content)) {
      message.content = message.content
        .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    }
  }
}

function screenshotMessage(images: ToolImage[]): ChatMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          images.length === 1
            ? "[screenshot from the tool result above]"
            : "[screenshots from the tool results above]",
      },
      ...images.map((image) => imagePart(image)),
    ],
  };
}

function buildHistory(
  systemPrompt: string,
  messages: Message[],
  options: { artifactsDir?: string; vision?: boolean } = {},
): ChatMessage[] {
  const history: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  const imageCandidates: Array<{ afterIndex: number; url: string }> = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      history.push({
        role: "assistant",
        content: message.content || null,
        toolCalls: message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      });
      for (const call of message.toolCalls) {
        history.push({
          role: "tool",
          content: call.output,
          toolCallId: call.id,
        });
      }
      const image = message.toolCalls
        .map((call) =>
          call.artifacts?.find((artifact) => artifact.type === "image"),
        )
        .filter((artifact) => Boolean(artifact))
        .at(-1);
      if (image) {
        imageCandidates.push({ afterIndex: history.length, url: image.url });
      }
    } else {
      history.push({ role: message.role, content: message.content });
    }
  }
  if (options.vision && options.artifactsDir && imageCandidates.length > 0) {
    const latest = imageCandidates[imageCandidates.length - 1]!;
    const image = artifactImage(options.artifactsDir, latest.url);
    if (image) {
      history.splice(latest.afterIndex, 0, screenshotMessage([image]));
    }
  }
  return history;
}

// File and command output can carry text that pretends to be an instruction.
// Browser tools screen their own page text; these are the tools whose output
// arrives from the computer, so the loop screens them here.
const SCREENED_TOOL_NAMES = new Set([
  "read_file",
  "shell",
  "grep",
  "glob",
  "list_dir",
  "browser_execute",
  "web_search",
]);

async function screenToolOutput(
  context: ToolContext,
  toolName: string,
  output: string,
): Promise<string> {
  const guardrail = context.decision?.settings.guardrail ?? "off";
  const client = context.decision?.client ?? null;
  if (guardrail === "off" || !client || !looksLikeInjection(output)) {
    return output;
  }
  const startedAt = Date.now();
  const verdict = await screenUntrustedText({
    client,
    text: output,
    ...(context.signal ? { signal: context.signal } : {}),
  }).catch((error) => {
    console.warn(`guardrail check failed: ${(error as Error).message}`);
    return null;
  });
  if (!verdict?.flagged) {
    return output;
  }
  console.info("guardrail.flagged", {
    botId: context.botId,
    tool: toolName,
    instructionOverride: verdict.instructionOverride,
    exfiltrationRequest: verdict.exfiltrationRequest,
  });
  context.onDecision?.({
    kind: "guardrail",
    summary: guardrailSummary(verdict),
    flagged: true,
    latencyMs: Date.now() - startedAt,
    model: context.decision?.settings.model ?? null,
  });
  return guardrail === "block"
    ? `${GUARDRAIL_BLOCKED}\n[tool output withheld: ${toolName}]`
    : `${GUARDRAIL_WARNING}\n${output}`;
}

async function executeToolCall(
  deps: AgentDeps,
  context: ToolContext,
  call: ToolCall,
  ids: { runId: string; threadId: string },
  emit: (message: ServerMessage) => void,
  signal: AbortSignal,
  approval: { tier: ApprovalTier; reason: string },
  observation: { prefix: "browser" | "websearch"; index: number } | null,
  availableTools: string[],
): Promise<{ record: ToolCallRecord; images: ToolImage[] | null }> {
  console.info("tool.start", {
    runId: ids.runId,
    threadId: ids.threadId,
    botId: context.botId,
    callId: call.id,
    name: call.name,
  });
  emit({
    type: "tool.start",
    runId: ids.runId,
    threadId: ids.threadId,
    callId: call.id,
    name: call.name,
    arguments: call.arguments,
  });

  let ok = false;
  let output = "";
  let executionMs = 0;
  let artifacts: ToolArtifact[] | null = null;
  let images: ToolImage[] | null = null;
  let changes: FileChange[] | null = null;

  // Long commands stream their output while they run; each chunk is tagged
  // with this call so the app can render it live in the tool card.
  const callContext: ToolContext = {
    ...context,
    onOutput: (chunk) =>
      emit({
        type: "tool.output",
        runId: ids.runId,
        threadId: ids.threadId,
        callId: call.id,
        stream: chunk.stream,
        text: chunk.text,
      }),
  };

  const tool = findTool(call.name);
  if (!tool) {
    output = unknownToolMessage(call.name, availableTools);
  } else if (!availableTools.includes(call.name)) {
    // The model sometimes calls a tool it was not offered (for example a
    // computer tool on a project-routed turn). The offered set is the
    // contract, so refuse instead of running it.
    output =
      `The ${call.name} tool is not available for this turn. Use only the ` +
      `tools you were offered: ${availableTools.join(", ") || "none"}.`;
    console.info("tool.unavailable", {
      runId: ids.runId,
      botId: context.botId,
      callId: call.id,
      name: call.name,
    });
  } else if (approval.tier === "deny") {
    output = `Blocked by the approvals policy: ${approval.reason}. Do not retry it.`;
    console.info("tool.blocked", {
      runId: ids.runId,
      botId: context.botId,
      callId: call.id,
      name: call.name,
      reason: approval.reason,
    });
  } else {
    let result: Awaited<ReturnType<typeof runTool>> | null = null;
    if (approval.tier === "ask") {
      const requestId = randomUUID();
      emit({
        type: "approval.request",
        requestId,
        runId: ids.runId,
        threadId: ids.threadId,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
        tier: approval.tier,
        reason: approval.reason,
      });
      const timeoutMs = deps.policy?.().timeoutMs;
      const decision = await Promise.race([
        deps.approvals.request(
          {
            requestId,
            runId: ids.runId,
            threadId: ids.threadId,
            botId: context.botId,
            tool: call.name,
            arguments: call.arguments,
            tier: approval.tier,
            reason: approval.reason,
          },
          timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
        ),
        abortFallback(signal, "deny" as const),
      ]);
      if (decision === "approve") {
        result = await runTool(tool, callContext, call);
      } else {
        output = "The user denied this action. Do not retry it.";
      }
    } else {
      result = await runTool(tool, callContext, call);
    }

    if (result?.challenge) {
      const requestId = randomUUID();
      emit({
        type: "challenge.request",
        requestId,
        runId: ids.runId,
        threadId: ids.threadId,
        callId: call.id,
        url: result.challengeUrl ?? null,
      });
      const decision = await Promise.race([
        deps.challenges.request(requestId),
        abortFallback(signal, "skip" as const),
      ]);
      if (signal.aborted) {
        deps.challenges.resolve(requestId, "skip");
      }
      if (decision === "retry") {
        const retried = await runTool(tool, callContext, call);
        if (!retried.challenge) {
          result = retried;
        }
      }
    }

    if (result) {
      ok = result.ok;
      output = result.output;
      executionMs = result.durationMs;
      artifacts = result.artifacts ?? null;
      images = result.images ?? null;
      changes = result.changes ?? null;
    }
  }

  if (ok && output && SCREENED_TOOL_NAMES.has(call.name)) {
    output = await screenToolOutput(context, call.name, output);
  }

  if (observation) {
    output =
      observation.prefix === "websearch"
        ? annotateWebSearchObservation(output, ok, observation.index)
        : annotateBrowserObservation(output, ok, observation.index);
  }

  emit({
    type: "tool.result",
    runId: ids.runId,
    threadId: ids.threadId,
    callId: call.id,
    ok,
    output,
    durationMs: executionMs,
    artifacts,
  });
  console.info("tool.result", {
    runId: ids.runId,
    threadId: ids.threadId,
    botId: context.botId,
    callId: call.id,
    name: call.name,
    ok,
    durationMs: executionMs,
    ...(ok ? {} : { error: output.slice(0, 300) }),
  });

  return {
    record: {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      output,
      ok,
      durationMs: executionMs,
      artifacts,
      changes,
    },
    images,
  };
}

async function runTool(
  tool: Tool,
  context: ToolContext,
  call: ToolCall,
): Promise<{
  ok: boolean;
  output: string;
  durationMs: number;
  artifacts?: ToolArtifact[];
  images?: ToolImage[];
  challenge?: boolean;
  challengeUrl?: string | null;
  changes?: FileChange[];
}> {
  let args: Record<string, unknown> = {};
  if (call.arguments.trim()) {
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        output: toolErrorText(
          tool.definition.name,
          `arguments are not valid JSON: ${call.arguments.slice(0, 200)}`,
        ),
        durationMs: 0,
      };
    }
  }
  // The model may aim a computer tool at either of the agent's computers; the
  // context carries the resolved target so every backend call follows it.
  const target = resolveToolComputer(context, args);
  if (target.error) {
    return {
      ok: false,
      output: toolErrorText(tool.definition.name, target.error),
      durationMs: 0,
    };
  }
  const callContext: ToolContext =
    target.computer === context.computer
      ? context
      : { ...context, computer: target.computer };
  try {
    return await tool.execute(callContext, args);
  } catch (error) {
    const message = (error as Error).message || String(error);
    // A sandbox that is unreachable or still booting fails before the command
    // runs, so one retry cannot duplicate a side effect.
    if (TRANSIENT_TOOL_ERROR.test(message) && !context.signal?.aborted) {
      await abortableDelay(SANDBOX_RETRY_DELAY_MS, context.signal);
      if (!context.signal?.aborted) {
        try {
          return await tool.execute(callContext, args);
        } catch (retryError) {
          return {
            ok: false,
            output: toolErrorText(
              tool.definition.name,
              (retryError as Error).message || String(retryError),
            ),
            durationMs: 0,
          };
        }
      }
    }
    return {
      ok: false,
      output: toolErrorText(tool.definition.name, message),
      durationMs: 0,
    };
  }
}

export async function runAgent(
  deps: AgentDeps,
  input: AgentInput,
  emit: (message: ServerMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const { runId } = input;
  const bot = deps.store.getBot(input.botId);
  if (!bot) {
    emit({ type: "chat.error", runId, message: `unknown bot: ${input.botId}` });
    return;
  }

  const model = input.model ?? bot.model;
  const requested = input.threadId
    ? deps.store.getThread(input.threadId)
    : null;
  let thread =
    requested && requested.botId === bot.id
      ? requested
      : deps.store.getOrCreateThread(bot.id);

  if (!input.skipUserMessage) {
    const userMessage = deps.store.addMessage({
      id: input.messageId,
      threadId: thread.id,
      role: "user",
      content: input.text,
      model: null,
      routine: input.routine ?? null,
    });
    // A routine run starts outside the client, so the marked brief is pushed
    // to open windows instead of relying on the sender's optimistic bubble.
    if (input.routine) {
      emit({
        type: "chat.message",
        runId,
        threadId: thread.id,
        message: userMessage,
      });
    }

    if (thread.title === DEFAULT_THREAD_TITLE) {
      const updated = deps.store.touchThread(thread.id, {
        title: input.text.slice(0, 60),
      });
      if (updated) {
        thread = updated;
        emit({ type: "thread.upserted", thread });
      }
    }
  }

  const provider = deps.providers.get(model.provider);
  if (!provider) {
    emit({
      type: "chat.error",
      runId,
      threadId: thread.id,
      message: `unknown provider: ${model.provider}`,
    });
    return;
  }

  const assistantMessageId = randomUUID();
  emit({
    type: "chat.start",
    runId,
    threadId: thread.id,
    messageId: assistantMessageId,
  });

  const compactionSettings = deps.compaction();
  const thresholdTokens = resolveCompactionThreshold(
    compactionSettings,
    model.model,
  );

  const compact = async (trigger: CompactionTrigger): Promise<boolean> => {
    emit({
      type: "chat.compaction",
      runId,
      threadId: thread.id,
      status: "start",
      trigger,
      thresholdTokens,
    });
    const outcome = await compactThread({
      store: deps.store,
      provider,
      model,
      threadId: thread.id,
      trigger,
      thresholdTokens,
      systemPrompt: bot.systemPrompt,
      signal,
    });
    if (!outcome) {
      return false;
    }
    emit({
      type: "chat.compaction",
      runId,
      threadId: thread.id,
      status: "done",
      thresholdTokens,
      ...outcome.meta,
      summaryMessageId: outcome.summaryMessage.id,
    });
    emit({ type: "thread.upserted", thread: outcome.thread });
    return true;
  };

  const initialMessages = deps.store.listMessages(thread.id);
  if (
    compactionSettings.enabled &&
    planCompaction(initialMessages, thresholdTokens, "auto") &&
    estimateChatTokens(buildHistory(bot.systemPrompt, initialMessages)) >=
      thresholdTokens
  ) {
    try {
      await compact("auto");
    } catch (error) {
      console.warn(`compaction failed: ${(error as Error).message}`);
    }
  }

  const computers = botComputers(bot);
  // A run normally acts on the agent's primary computer. A routine can pin a
  // different one, but only while the agent still has it (ADR-027); the pin
  // also fixes the run's target, so a routine never reaches across computers.
  const computer: ComputerKind =
    input.computer && botHasComputer(bot, input.computer)
      ? input.computer
      : primaryComputer(bot);
  const runComputers: ComputerKind[] = input.routine ? [computer] : computers;
  const local = computer === "mac";
  const hasVm = runComputers.includes("firecracker");
  const hasMac = runComputers.includes("mac");
  const dual = hasVm && hasMac;
  const decisionRuntime = deps.decision();
  const emitDecision = (notice: DecisionNotice): void => {
    emit({
      type: "chat.decision",
      runId,
      threadId: thread.id,
      messageId: assistantMessageId,
      kind: notice.kind,
      summary: notice.summary,
      flagged: notice.flagged,
      latencyMs: notice.latencyMs,
      model: notice.model,
    });
  };
  const vision = modelSupportsImages(model.model);

  // Turn-scoped caches: a file re-read unchanged, or a tool returning a
  // byte-identical result, only burns context. Both are cleared when
  // compaction rebuilds the transcript, since the earlier content may then be
  // gone.
  const readCache = new Map<string, string>();
  const toolResultCache = new Map<string, string>();
  // A registered workspace roots the agent's file tools and shell at the
  // project folder; without one it gets a managed scratch folder (ADR-022).
  const workspace = bot.workspaceId
    ? deps.store.getWorkspace(bot.workspaceId)
    : null;
  const workspaceDir = workspace
    ? workspace.root
    : join(deps.dataDir, "workspaces", bot.id);
  const guestCwd = workspace && !local ? workspaceGuestRoot(workspace) : undefined;
  const toolContext: ToolContext | null =
    hasMac || deps.sandbox
      ? {
          botId: bot.id,
          guestCwd,
          computer,
          computers: runComputers,
          access: bot.access,
          self: deps.self,
          requestRestart: deps.requestRestart,
          sandbox: deps.sandbox,
          workspaceDir,
          artifactsDir: deps.artifactsDir,
          decision: decisionRuntime,
          vision,
          signal,
          readCache,
          onDecision: emitDecision,
          onSandboxState: (state) =>
            emit({
              type: "sandbox.state",
              botId: bot.id,
              state,
            }),
          memory: deps.memory ?? null,
          soul: deps.soul ?? null,
          memoryScope: bot.id,
          todos: deps.todos ?? null,
          updatePlan: (plan: PlanStep[]) => {
            const updated = deps.store.setThreadPlan(thread.id, plan);
            if (updated) {
              emit({ type: "thread.upserted", thread: updated });
            }
          },
        }
      : null;

  // Soul and memories are injected as a bounded system note: the agent gets
  // the agent's own memories; every agent owns its own scope.
  const contextParts: string[] = [];
  if (input.contextNote) {
    contextParts.push(input.contextNote);
  }
  if (workspace) {
    contextParts.push(
      `[workspace] Your project folder is "${workspace.name}" at ${workspace.root}. ` +
        "File tools and shell are rooted there; keep the project's files in " +
        "place instead of copying them into a scratch folder." +
        (workspace.missing
          ? " The folder is currently missing on disk — tell the user."
          : ""),
    );
  }
  if (hasMac && bot.access !== "project") {
    contextParts.push(
      bot.access === "home"
        ? "[access] This Mac access is Home: file tools and shell reach " +
            "anywhere under the home folder, not just the project. Every " +
            "local action still asks unless the project's trust patterns " +
            "allow it."
        : "[access] This Mac access is Full: file tools and shell reach the " +
            "whole filesystem. Every local action still asks unless the " +
            "project's trust patterns allow it.",
    );
  }
  if (dual) {
    contextParts.push(
      "[computers] This agent has two computers: the sandboxed Linux microVM " +
        "and the user's Mac. The shell and file tools take an optional " +
        '`computer` argument: leave it unset for the microVM, or set ' +
        'computer="mac" to work on the user\'s Mac. Mac commands run as the ' +
        "user, file paths are limited by the agent's access mode, and the " +
        "approvals policy still applies.",
    );
  }
  if (deps.self) {
    contextParts.push(renderSelfNote(deps.self));
  }
  if (deps.soul) {
    try {
      const soul = deps.soul.current(bot.id);
      contextParts.push(`[soul]\n${soul.summary}`);
    } catch (error) {
      console.warn(`soul injection failed: ${(error as Error).message}`);
    }
  }
  if (deps.memory) {
    try {
      const hits = await deps.memory.recall(input.text, {
        scopes: [bot.id],
        limit: 6,
      });
      if (hits.length > 0) {
        const lines = hits.map(
          (hit) =>
            `- (${hit.memory.type}, ${hit.memory.confidence.toFixed(2)}) ` +
            `[m:${hit.memory.id.slice(0, 8)}] ${hit.memory.content}`,
        );
        contextParts.push(
          `[memory] Relevant memories from earlier work:\n${lines.join("\n")}`,
        );
      }
    } catch (error) {
      console.warn(`memory injection failed: ${(error as Error).message}`);
    }
  }
  if (thread.plan?.length) {
    const lines = thread.plan.map((step) =>
      step.status === "done"
        ? `- [x] ${step.step}`
        : step.status === "in_progress"
          ? `- [>] ${step.step}`
          : `- [ ] ${step.step}`,
    );
    contextParts.push(
      `[plan] Current plan for this task (update it with update_plan):\n${lines.join("\n")}`,
    );
  }
  if (deps.todos) {
    try {
      const note = renderTodoNote(deps.todos.list(bot.id));
      if (note) {
        contextParts.push(note);
      }
    } catch (error) {
      console.warn(`todo injection failed: ${(error as Error).message}`);
    }
  }
  const turnContext = contextParts.filter(Boolean).join("\n\n");
  const definitions: ToolDefinition[] = toolContext
    ? toolDefinitions(computer, {
        computers: runComputers,
        browse: Boolean(
          decisionRuntime.client && decisionRuntime.settings.browse,
        ),
      })
    : [];
  // Local tool calls are handled per call in the policy (they ask while
  // approvals are on unless a mac-scoped rule allows them), so having a Mac
  // computer is not itself a reason to ask.
  const basePolicy = deps.policy?.() ?? DEFAULT_POLICY;
  // A workspace's trusted command patterns auto-approve shell calls for
  // agents working in that project; a global deny or ask rule still wins
  // because the strictest matched rule decides (ADR-022).
  const workspaceOverlay =
    workspace && workspace.autoApprove.length > 0
      ? {
          timeoutMs: basePolicy.timeoutMs,
          defaultTier: "inherit" as const,
          tools: {},
          rules: workspace.autoApprove.map((pattern, index) => ({
            id: `workspace-${workspace.id}-${index}`,
            tool: "shell",
            scope: "*" as const,
            match: "command" as const,
            pattern,
            tier: "auto" as const,
            note: `trusted command in ${workspace.name}`,
          })),
        }
      : null;
  const withWorkspace = workspaceOverlay
    ? mergePolicies(basePolicy, workspaceOverlay)
    : basePolicy;
  const roleOverlay = rolePolicySettings(bot.policy);
  const policySettings = roleOverlay
    ? mergePolicies(withWorkspace, roleOverlay)
    : withWorkspace;
  if (toolContext) {
    toolContext.policy = policySettings;
  }
  // A hard shell egress policy is enforced on the VM's network interface for
  // the whole turn, so commands cannot reach hosts the browser would refuse.
  if (toolContext && hasVm && deps.sandbox) {
    const egress = policySettings.egress;
    try {
      await deps.sandbox.setNetworkPolicy(
        bot.id,
        egress && egress.mode === "deny"
          ? { mode: "deny", allow: egress.allow }
          : null,
      );
    } catch (error) {
      console.warn(`network policy failed: ${(error as Error).message}`);
    }
  }
  // The approvals policy decides auto/ask/deny per call. Rules can scope
  // themselves to microVM or This Mac; local-Mac tools ask unless a mac-scoped
  // rule allows them (ADR-010, ADR-018). The target computer is the call's own
  // (the model may name either of the agent's computers), not the run's.
  const evaluateToolApproval = (
    call: ToolCall,
  ): { tier: ApprovalTier; reason: string } => {
    // A tool the turn did not offer never runs, so it never needs a card.
    if (findTool(call.name) && !availableToolNames.includes(call.name)) {
      return { tier: "auto", reason: "the tool is not available for this turn" };
    }
    if (isApprovalExemptTool(call.name)) {
      return { tier: "auto", reason: "no approval needed" };
    }
    let args: Record<string, unknown> = {};
    if (call.arguments.trim()) {
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    if (!toolContext) {
      return { tier: "auto", reason: "no computer is available for this run" };
    }
    // A call naming a computer the agent does not have fails in the tool; it
    // never reaches the user as an approval card.
    const target = resolveToolComputer(toolContext, args);
    if (target.error) {
      return { tier: "auto", reason: target.error };
    }
    return evaluatePolicy({
      policy: policySettings,
      requireApproval: deps.requireApproval,
      tool: call.name,
      args,
      computer: target.computer,
      local: target.computer === "mac",
    });
  };

  const buildTurnHistory = (): ChatMessage[] => {
    const turnHistory = buildHistory(
      bot.systemPrompt,
      deps.store.listMessages(thread.id),
      { artifactsDir: deps.artifactsDir, vision },
    );
    if (turnContext) {
      turnHistory.unshift({ role: "system", content: turnContext });
    }
    return turnHistory;
  };
  const history = buildTurnHistory();
  const working: ChatMessage[] = [...history];
  const records: ToolCallRecord[] = [];
  // Identical failing calls are tracked so a model stuck on one approach is
  // stopped instead of looping until the step cap.
  const failureCounts = new Map<string, number>();
  const availableToolNames = definitions.map(
    (definition) => definition.name,
  );
  let content = "";
  let stepText = "";
  let stepRecords: ToolCallRecord[] = [];
  let finalText = "";
  let turnUsage: TokenUsage | null = null;
  let overflowRetried = false;
  let browserObservationCount = 0;
  let webSearchObservationCount = 0;
  let unverifiedDraftHeld = false;
  let auditRevisions = 0;
  let markupRevisions = 0;

  const persistAssistant = (
    id: string,
    messageContent: string,
    toolCalls: ToolCallRecord[] | null,
    usage: TokenUsage | null,
  ): Message => {
    const message = deps.store.addMessage({
      id,
      threadId: thread.id,
      role: "assistant",
      content: messageContent,
      model,
      toolCalls,
      usage,
    });
    const refreshed = deps.store.touchThread(thread.id);
    if (refreshed) {
      emit({ type: "thread.upserted", thread: refreshed });
    }
    return message;
  };

  const toolRecoveryText = (error: unknown): string => {
    const last = records.at(-1);
    const reason = (error as Error).message || String(error);
    if (!last) {
      return content;
    }
    if (!last.ok) {
      return `I couldn't complete the task because the ${last.name} tool failed: ${last.output}`;
    }
    return `The ${last.name} action completed, but I couldn't finish the task because the model connection failed: ${reason}. The completed tool results are preserved in this chat.`;
  };

  const overflowError = (detail: string) => {
    emit({
      type: "chat.error",
      runId,
      threadId: thread.id,
      message:
        `context window overflow: ${detail} ` +
        "Start a new thread or switch to a model with a larger context window.",
    });
  };

  try {
    for (let step = 0; ; step += 1) {
      if (step >= MAX_TOOL_STEPS) {
        const message = persistAssistant(
          assistantMessageId,
          `I stopped after ${MAX_TOOL_STEPS} tool steps to keep this turn ` +
            "bounded. Everything so far is preserved above; say \"continue\" " +
            "and I will pick up from here.",
          null,
          turnUsage,
        );
        emit({ type: "chat.done", runId, threadId: thread.id, message });
        return;
      }
      const contentBeforeStep = content;
      stepText = "";
      stepRecords = [];
      let pendingCalls: ToolCall[] = [];
      const stepImages: ToolImage[] = [];

      // Steered messages wait for a clean step boundary; fold them in now so
      // the next provider call sees them.
      if (input.steering?.hasPending()) {
        for (const steered of input.steering.drain()) {
          working.push({ role: "user", content: steered });
        }
      }

      let providerAttempt = 0;
      try {
        // One retry for a transient provider failure, but only when nothing
        // was streamed yet: retrying after deltas would duplicate the reply.
        for (;;) {
          try {
            const providerSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(PROVIDER_STEP_TIMEOUT_MS),
            ]);
            if (vision) {
              pruneHistoricalImages(working);
            }
            for await (const event of provider.chat({
              model: model.model,
              messages: working,
              ...(definitions.length ? { tools: definitions } : {}),
              ...(model.effort ? { reasoningEffort: model.effort } : {}),
              signal: providerSignal,
            })) {
              if (event.type === "text_delta") {
                stepText += event.text;
                content += event.text;
                emit({
                  type: "chat.delta",
                  runId,
                  threadId: thread.id,
                  messageId: assistantMessageId,
                  text: event.text,
                });
              } else if (event.type === "reasoning_delta") {
                emit({
                  type: "chat.reasoning",
                  runId,
                  threadId: thread.id,
                  messageId: assistantMessageId,
                  text: event.text,
                });
              } else if (event.type === "tool_calls") {
                pendingCalls = event.calls;
              } else if (event.type === "usage") {
                turnUsage = addUsage(turnUsage, event.usage);
              }
            }
            break;
          } catch (error) {
            const retryable =
              !signal.aborted &&
              providerAttempt < MAX_PROVIDER_RETRIES &&
              stepText === "" &&
              pendingCalls.length === 0 &&
              TRANSIENT_PROVIDER_ERROR.test(
                (error as Error).message ?? String(error),
              );
            if (!retryable) {
              throw error;
            }
            const delay = providerRetryDelay(error, providerAttempt);
            providerAttempt += 1;
            content = contentBeforeStep;
            console.warn(
              `provider step failed, retrying in ${delay}ms ` +
                `(attempt ${providerAttempt}/${MAX_PROVIDER_RETRIES}): ` +
                `${(error as Error).message}`,
            );
            await abortableDelay(delay, signal);
          }
        }
      } catch (error) {
        if (signal.aborted || !isContextOverflowError(error)) {
          throw error;
        }
        if (overflowRetried) {
          overflowError(
            "the conversation still exceeds the model's context window after compaction.",
          );
          return;
        }
        if (!compactionSettings.enabled) {
          overflowError("compaction is disabled in settings.");
          return;
        }
        overflowRetried = true;
        content = contentBeforeStep;
        let compacted = false;
        try {
          compacted = await compact("overflow");
        } catch (compactionError) {
          if (signal.aborted) {
            throw compactionError;
          }
          overflowError(
            `compaction failed (${(compactionError as Error).message}).`,
          );
          return;
        }
        if (!compacted) {
          overflowError(
            "there was not enough history left to compact and the provider rejected the request.",
          );
          return;
        }
        working.splice(0, working.length, ...buildTurnHistory());
        readCache.clear();
        toolResultCache.clear();
        step -= 1;
        continue;
      }

      finalText = stepText;

      if (pendingCalls.length === 0) {
        // Raw markup as text means the provider failed to turn the tool call
        // into a structured call; discard it and nudge. A provider that keeps
        // doing it gets a clean apology instead of leaking the markup to the
        // user as the answer.
        if (RAW_TOOL_MARKUP.test(finalText)) {
          if (markupRevisions < MAX_MARKUP_REVISIONS) {
            markupRevisions += 1;
            console.warn("assistant emitted raw tool-call markup; retrying");
            emit({
              type: "chat.delta",
              runId,
              threadId: thread.id,
              messageId: assistantMessageId,
              text: "",
              reset: true,
            });
            working.push({ role: "assistant", content: finalText });
            working.push({
              role: "user",
              content:
                "[system] Your last reply contained raw tool-call markup as " +
                "text, so nothing ran. Do not write tool syntax as text. Call " +
                "the tool through the tool interface with valid JSON " +
                "arguments and continue the task.",
            });
            content = contentBeforeStep;
            finalText = "";
            continue;
          }
          console.warn(
            "assistant kept emitting raw tool-call markup; replacing it",
          );
          finalText =
            "I hit a provider glitch: the model sent a tool call as plain " +
            "text, so nothing ran. Ask me to try that again.";
          emit({
            type: "chat.delta",
            runId,
            threadId: thread.id,
            messageId: assistantMessageId,
            text: "",
            reset: true,
          });
          emit({
            type: "chat.delta",
            runId,
            threadId: thread.id,
            messageId: assistantMessageId,
            text: finalText,
          });
        }
        if (input.steering?.hasPending()) {
          // The draft is no longer the final answer: flush it as a step
          // message, then let the steered input redirect the turn.
          if (stepText.trim()) {
            const flushed = persistAssistant(randomUUID(), stepText, null, null);
            emit({
              type: "chat.message",
              runId,
              threadId: thread.id,
              message: flushed,
            });
            working.push({ role: "assistant", content: stepText });
          }
          for (const steered of input.steering.drain()) {
            working.push({ role: "user", content: steered });
          }
          emit({
            type: "chat.delta",
            runId,
            threadId: thread.id,
            messageId: assistantMessageId,
            text: "",
            reset: true,
          });
          content = "";
          stepText = "";
          stepRecords = [];
          finalText = "";
          unverifiedDraftHeld = false;
          continue;
        }
        if (
          decisionRuntime.settings.audit &&
          shouldAuditCompletion(records) &&
          finalText.trim()
        ) {
          unverifiedDraftHeld = true;
          let released = false;
          let feedback: string | null = null;

          if (decisionRuntime.client) {
            const auditStartedAt = Date.now();
            try {
              const outcome = await evaluateJevAudit({
                client: decisionRuntime.client,
                userRequest: input.text,
                candidate: finalText,
                records,
                signal,
              });
              turnUsage = addUsage(turnUsage, {
                inputTokens: outcome.usage.inputTokens,
                outputTokens: outcome.usage.outputTokens,
              });
              console.info("completion.audit", {
                runId,
                threadId: thread.id,
                botId: bot.id,
                engine: "jev",
                model: outcome.model,
                verdict: outcome.verdict,
                failed: outcome.failed,
                borderline: outcome.borderline,
                scores: outcome.scores,
                confidence: outcome.confidence,
                latencyMs: Date.now() - auditStartedAt,
              });
              emitDecision({
                kind: "audit",
                summary:
                  outcome.verdict === "pass"
                    ? `pass · confidence ${outcome.confidence.toFixed(2)}`
                    : `continue${
                        outcome.failed.length
                          ? ` · ${outcome.failed.join(", ")}`
                          : ""
                      }`,
                flagged: outcome.verdict === "continue",
                latencyMs: Date.now() - auditStartedAt,
                model: outcome.model,
              });
              if (outcome.verdict === "pass" && outcome.borderline.length === 0) {
                released = true;
              } else if (outcome.verdict === "continue") {
                feedback = buildJevVerificationFeedback(outcome);
              } else {
                console.info("completion.audit.fallback", {
                  runId,
                  threadId: thread.id,
                  reason: "borderline-nouls",
                  checks: outcome.borderline,
                  confidence: outcome.confidence,
                });
                emitDecision({
                  kind: "audit",
                  summary: `borderline checks (${outcome.borderline.join(", ")}) — used the model verifier`,
                  flagged: false,
                  latencyMs: Date.now() - auditStartedAt,
                  model: outcome.model,
                });
              }
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
              console.warn(
                `decision audit failed: ${(error as Error).message}`,
              );
              emitDecision({
                kind: "audit",
                summary: "unavailable — used the model verifier",
                flagged: false,
                latencyMs: Date.now() - auditStartedAt,
                model: null,
              });
            }
          }

          if (!released && feedback === null) {
            let audited: Awaited<ReturnType<typeof auditCompletion>> | null = null;
            try {
              audited = await auditCompletion({
                provider,
                model: model.model,
                ...(model.effort ? { reasoningEffort: model.effort } : {}),
                userRequest: input.text,
                candidate: finalText,
                records,
                signal,
              });
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
              console.warn(
                `completion audit failed: ${(error as Error).message}`,
              );
            }
            if (audited?.usage) {
              turnUsage = addUsage(turnUsage, audited.usage);
            }
            if (!audited?.audit) {
              if (audited) {
                console.warn(
                  `completion audit returned invalid output: ${audited.raw.slice(0, 300)}`,
                );
              }
              released = true;
            } else {
              console.info("completion.audit", {
                runId,
                threadId: thread.id,
                botId: bot.id,
                engine: "llm",
                verdict: audited.audit.verdict,
                issues: audited.audit.issues,
              });
              if (audited.audit.verdict === "continue") {
                feedback = buildVerificationFeedback(audited.audit);
              } else {
                released = true;
              }
            }
          }

          if (!released && feedback !== null) {
            if (auditRevisions >= MAX_AUDIT_REVISIONS) {
              console.info("completion.audit.capped", {
                runId,
                threadId: thread.id,
                botId: bot.id,
                revisions: auditRevisions,
              });
              emitDecision({
                kind: "audit",
                summary: `revision cap reached after ${auditRevisions} attempts — showing the current draft`,
                flagged: true,
                latencyMs: null,
                model: null,
              });
              unverifiedDraftHeld = false;
              break;
            }
            auditRevisions += 1;
            emit({
              type: "chat.delta",
              runId,
              threadId: thread.id,
              messageId: assistantMessageId,
              text: "",
              reset: true,
            });
            working.push({ role: "assistant", content: finalText });
            working.push({ role: "user", content: feedback });
            finalText = "";
            continue;
          }

          unverifiedDraftHeld = false;
        }
        break;
      }

      working.push({
        role: "assistant",
        content: stepText || null,
        toolCalls: pendingCalls,
      });

      let repeatedFailure: string | null = null;
      for (const call of pendingCalls) {
        if (!toolContext) {
          const record: ToolCallRecord = {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            output: "sandbox is not available",
            ok: false,
            durationMs: 0,
            artifacts: null,
          };
          records.push(record);
          stepRecords.push(record);
          working.push({
            role: "tool",
            content: record.output,
            toolCallId: call.id,
          });
          continue;
        }
        const { record, images } = await executeToolCall(
          deps,
          toolContext,
          call,
          { runId, threadId: thread.id },
          emit,
          signal,
          evaluateToolApproval(call),
          call.name === "browser" ||
          call.name === "browser_execute" ||
          call.name === "browser_step"
            ? { prefix: "browser" as const, index: browserObservationCount++ }
            : call.name === "web_search"
              ? {
                  prefix: "websearch" as const,
                  index: webSearchObservationCount++,
                }
              : null,
          availableToolNames,
        );
        records.push(record);
        stepRecords.push(record);
        const signature = `${call.name}\u0000${call.arguments}`;
        // A byte-identical result from the same call is already in the
        // transcript; repeat a marker instead of the whole output.
        const previousOutput = toolResultCache.get(signature);
        if (
          previousOutput !== undefined &&
          previousOutput === record.output &&
          record.output.length > 200
        ) {
          working.push({
            role: "tool",
            toolCallId: call.id,
            content:
              `[identical to the earlier ${call.name} call with the same ` +
              `arguments; ${record.output.length} characters omitted]`,
          });
        } else {
          toolResultCache.set(signature, record.output);
          working.push({
            role: "tool",
            toolCallId: call.id,
            content: record.output,
          });
        }
        if (vision && images) {
          stepImages.push(...images);
        }
        if (record.ok) {
          failureCounts.delete(signature);
        } else {
          const count = (failureCounts.get(signature) ?? 0) + 1;
          failureCounts.set(signature, count);
          if (count >= MAX_REPEATED_TOOL_FAILURES) {
            repeatedFailure = call.name;
            break;
          }
        }
      }
      // DeepSeek and other OpenAI-compatible providers accept images in user
      // messages only, so screenshots travel as a follow-up user message.
      if (vision && stepImages.length > 0) {
        working.push(screenshotMessage(stepImages));
      }

      // A step's narration and its tool calls belong together: persist them as
      // one message and clear the live bubble so the transcript reads as
      // message → capsule → message → capsule instead of one merged answer.
      const stepMessage = persistAssistant(
        randomUUID(),
        stepText,
        stepRecords.length ? stepRecords : null,
        null,
      );
      emit({
        type: "chat.message",
        runId,
        threadId: thread.id,
        message: stepMessage,
      });
      emit({
        type: "chat.delta",
        runId,
        threadId: thread.id,
        messageId: assistantMessageId,
        text: "",
        reset: true,
      });

      if (repeatedFailure) {
        const message = persistAssistant(
          assistantMessageId,
          `I stopped because the ${repeatedFailure} tool failed ` +
            `${MAX_REPEATED_TOOL_FAILURES} times with the same arguments. ` +
            "That usually means the approach or the arguments need to change " +
            "rather than another retry. Tell me how you would like to proceed.",
          null,
          turnUsage,
        );
        emit({ type: "chat.done", runId, threadId: thread.id, message });
        return;
      }
    }
  } catch (error) {
    if (signal.aborted) {
      if (stepText.trim() || stepRecords.length > 0) {
        persistAssistant(
          assistantMessageId,
          unverifiedDraftHeld
            ? "The action was cancelled before I could produce a verified final answer. The completed tool results are preserved in this chat."
            : stepText || "The action was cancelled.",
          stepRecords.length ? stepRecords : null,
          turnUsage,
        );
      }
      emit({
        type: "chat.error",
        runId,
        threadId: thread.id,
        message: "cancelled",
      });
      return;
    }
    if (records.length > 0) {
      const message = persistAssistant(
        assistantMessageId,
        toolRecoveryText(error),
        stepRecords.length ? stepRecords : null,
        turnUsage,
      );
      emit({ type: "chat.done", runId, threadId: thread.id, message });
      return;
    }
    emit({
      type: "chat.error",
      runId,
      threadId: thread.id,
      message: (error as Error).message,
    });
    return;
  }

  const message = persistAssistant(
    assistantMessageId,
    finalText ||
      (records.length > 0
        ? toolRecoveryText(new Error("the model returned no final response"))
        : "I couldn't produce a response."),
    stepRecords.length ? stepRecords : null,
    turnUsage,
  );
  emit({ type: "chat.done", runId, threadId: thread.id, message });
}
