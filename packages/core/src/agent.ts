import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  modelSupportsImages,
  type ChatMessage,
  type ChatProvider,
  type ContentPart,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
} from "@openbot/gateway";
import type {
  ApprovalTier,
  CompactionSettings,
  CompactionTrigger,
  ComputerKind,
  Message,
  ModelRef,
  PolicySettings,
  ServerMessage,
  TaskBudget,
  TaskGrant,
  ToolArtifact,
  ToolCallRecord,
} from "@openbot/protocol";
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
import { decideRoute } from "./routing";
import type { SoulService } from "./soul";
import {
  findTool,
  isApprovalExemptTool,
  isOrchestrationTool,
  toolDefinitions,
  type OrchestratorHandle,
  type Tool,
  type ToolContext,
  type ToolImage,
} from "./tools";
import {
  annotateBrowserObservation,
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
  orchestrator?: OrchestratorHandle | null;
  memory?: MemoryService | null;
  soul?: SoulService | null;
  policy?: () => PolicySettings;
}

export interface AgentInput {
  runId: string;
  botId: string;
  threadId?: string;
  text: string;
  model?: ModelRef;
  /** Internal trigger (task event): do not persist the user message or retitle the thread. */
  internal?: boolean;
  /** Extra system context injected for this turn only; never persisted. */
  contextNote?: string;
  /** Memory scopes retrieved for this turn (defaults by bot kind). */
  memoryScopes?: string[];
  /** The project this task belongs to, when it does. */
  projectId?: string | null;
  /** Set when this run is a worker or manager task. */
  taskId?: string;
  /** Sandbox key for this run: a task computer when set, otherwise the bot's. */
  computerId?: string;
  /** Sandbox key for browser actions when it differs from the computer. */
  browserId?: string;
  /** Guest workspace directory for sessions inside a shared computer. */
  guestCwd?: string;
  /** Approved capabilities: tools in the grant skip per-action approval. */
  grant?: TaskGrant | null;
  /** Harness-enforced limits for the run. */
  budget?: TaskBudget | null;
}

const PROVIDER_STEP_TIMEOUT_MS = 60_000;
const MAX_AUDIT_REVISIONS = 2;

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

function unknownToolMessage(name: string): string {
  const hint = UNKNOWN_TOOL_HINTS[name];
  const tools = "shell, read_file, write_file, browser, browse, desktop";
  return hint
    ? `unknown tool: ${name}. ${hint}`
    : `unknown tool: ${name}. Available tools: ${tools}.`;
}

function addUsage(
  total: TokenUsage | null,
  usage: TokenUsage,
): TokenUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
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

async function executeToolCall(
  deps: AgentDeps,
  context: ToolContext,
  call: ToolCall,
  ids: { runId: string; threadId: string },
  emit: (message: ServerMessage) => void,
  signal: AbortSignal,
  approval: { tier: ApprovalTier; reason: string },
  browserObservationIndex: number | null,
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
    output = unknownToolMessage(call.name);
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
            taskId: context.taskId ?? null,
            projectId: context.projectId ?? null,
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
    }
  }

  if (browserObservationIndex !== null) {
    output = annotateBrowserObservation(
      output,
      ok,
      browserObservationIndex,
    );
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
}> {
  let args: Record<string, unknown> = {};
  if (call.arguments.trim()) {
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        output: `invalid tool arguments: ${call.arguments.slice(0, 200)}`,
        durationMs: 0,
      };
    }
  }
  try {
    return await tool.execute(context, args);
  } catch (error) {
    return { ok: false, output: (error as Error).message, durationMs: 0 };
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

  if (!input.internal) {
    deps.store.addMessage({
      threadId: thread.id,
      role: "user",
      content: input.text,
      model: null,
    });

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

  const computer: ComputerKind = bot.computer === "mac" ? "mac" : "firecracker";
  const local = computer === "mac";
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

  // Jev pre-routing for lead user turns: conversation, direct work, an
  // existing project, or a new project. The decision is a hint, and for
  // confident conversation it drops tools for the turn; when Jev is off,
  // unavailable, or unsure, the model decides as before.
  let routeHint: string | null = null;
  let routeChat = false;
  if (
    deps.decision &&
    deps.orchestrator &&
    bot.kind === "lead" &&
    !input.internal &&
    !input.taskId
  ) {
    const runtime = deps.decision();
    if (runtime.client && runtime.settings.route) {
      try {
        const projects = deps.orchestrator.listProjects();
        const decision = await decideRoute({
          client: runtime.client,
          message: input.text,
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            scope: project.scope,
          })),
          signal,
        });
        if (decision) {
          emitDecision({
            kind: "route",
            summary: decision.summary,
            flagged: false,
            latencyMs: decision.latencyMs,
            model: decision.model,
          });
          if (decision.target === "chat") {
            routeChat = true;
            routeHint =
              "[routing] Jev routed this message as conversation: answer " +
              "directly without tools.";
          } else if (decision.target === "project" && decision.projectId) {
            const project = projects.find(
              (candidate) => candidate.id === decision.projectId,
            );
            routeHint =
              `[routing] Jev routed this message to the project ` +
              `"${project?.name ?? decision.projectId}" ` +
              `(id: ${decision.projectId}). Send it with ask_project; do not ` +
              "do the work yourself.";
          } else if (decision.target === "new_project") {
            routeHint =
              "[routing] Jev found no existing project that covers this. " +
              "Create one with create_project and route the request there.";
          } else {
            routeHint =
              "[routing] Jev routed this message as direct work: handle it " +
              "yourself with tools.";
          }
        }
      } catch (error) {
        console.warn(`routing decision failed: ${(error as Error).message}`);
      }
    }
  }

  const toolContext: ToolContext | null =
    local || deps.sandbox
      ? {
          botId: bot.id,
          computerId: input.computerId,
          browserId: input.browserId,
          guestCwd: input.guestCwd,
          computer,
          sandbox: deps.sandbox,
          workspaceDir: join(deps.dataDir, "workspaces", bot.id),
          artifactsDir: deps.artifactsDir,
          decision: decisionRuntime,
          vision,
          signal,
          onDecision: emitDecision,
          onSandboxState: (state) =>
            emit({
              type: "sandbox.state",
              botId: bot.id,
              taskId: input.taskId,
              state,
            }),
          orchestrator: deps.orchestrator ?? null,
          taskId: input.taskId,
          projectId: input.projectId ?? null,
          memory: deps.memory ?? null,
          soul: deps.soul ?? null,
          memoryScope: bot.kind === "lead" ? "user" : bot.id,
        }
      : null;

  // Soul and memories are injected as a bounded system note: the lead gets
  // the user-scope soul and memories, projects get their own scope plus the
  // user's, and workers get the project slice their brief matches.
  const contextParts: string[] = [];
  if (routeHint) {
    contextParts.push(routeHint);
  }
  if (input.contextNote) {
    contextParts.push(input.contextNote);
  }
  if (deps.soul && bot.kind === "lead") {
    try {
      const soul = deps.soul.current(bot.id);
      contextParts.push(`[soul]\n${soul.summary}`);
    } catch (error) {
      console.warn(`soul injection failed: ${(error as Error).message}`);
    }
  }
  if (deps.memory) {
    const scopes =
      input.memoryScopes ?? (bot.kind === "lead" ? ["user"] : [bot.id]);
    try {
      const hits = await deps.memory.recall(input.text, {
        scopes,
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
  const turnContext = contextParts.filter(Boolean).join("\n\n");
  const definitions: ToolDefinition[] = toolContext && !routeChat
    ? toolDefinitions(computer, {
        browse: Boolean(
          decisionRuntime.client && decisionRuntime.settings.browse,
        ),
        delegate: bot.kind === "lead" || bot.kind === "project" || bot.delegates,
      })
    : [];
  const globalApproval = deps.requireApproval || local;
  const grantedTools = new Set(input.grant?.tools ?? []);
  const isManagerRun = Boolean(input.taskId);
  const roleOverlay = rolePolicySettings(bot.policy);
  const policySettings = roleOverlay
    ? mergePolicies(deps.policy?.() ?? DEFAULT_POLICY, roleOverlay)
    : (deps.policy?.() ?? DEFAULT_POLICY);
  if (toolContext) {
    toolContext.policy = policySettings;
  }
  // The approvals policy decides auto/ask/deny per call. Rules can scope
  // themselves to microVM or This Mac; grants pre-approve ask-tier tools but
  // never widen a deny; local-Mac tools ask unless a mac-scoped rule allows
  // them (ADR-010, ADR-016).
  const evaluateToolApproval = (
    call: ToolCall,
  ): { tier: ApprovalTier; reason: string } => {
    if (isApprovalExemptTool(call.name)) {
      return { tier: "auto", reason: "no approval needed" };
    }
    if (isOrchestrationTool(call.name)) {
      // A manager's grant already authorized its children; the lead's spawn
      // is how the user authorizes a project, so it follows the default tier.
      if (isManagerRun) {
        return { tier: "auto", reason: "covered by the task grant" };
      }
      const tier =
        policySettings.defaultTier === "inherit"
          ? globalApproval
            ? "ask"
            : "auto"
          : policySettings.defaultTier;
      return {
        tier,
        reason:
          tier === "auto"
            ? "approvals are off by default"
            : tier === "deny"
              ? "the default tier denies new work"
              : "approvals are on by default",
      };
    }
    let args: Record<string, unknown> = {};
    if (call.arguments.trim()) {
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    return evaluatePolicy({
      policy: policySettings,
      requireApproval: deps.requireApproval,
      tool: call.name,
      args,
      computer,
      granted: Boolean(input.grant && grantedTools.has(call.name)),
      local,
    });
  };

  const budget = input.budget ?? null;
  const budgetStartedAt = Date.now();
  const budgetIssue = (): string | null => {
    if (!budget) {
      return null;
    }
    if (
      budget.toolCalls !== null &&
      budget.toolCalls !== undefined &&
      records.length >= budget.toolCalls
    ) {
      return `tool-call budget exhausted (${budget.toolCalls})`;
    }
    if (
      budget.wallClockMs !== null &&
      budget.wallClockMs !== undefined &&
      Date.now() - budgetStartedAt >= budget.wallClockMs
    ) {
      return `time budget exhausted (${Math.round(budget.wallClockMs / 1000)}s)`;
    }
    if (
      budget.tokens !== null &&
      budget.tokens !== undefined &&
      turnUsage &&
      turnUsage.inputTokens + turnUsage.outputTokens >= budget.tokens
    ) {
      return `token budget exhausted (${budget.tokens})`;
    }
    return null;
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
    if (input.internal) {
      // Internal turns are not persisted as user messages, but the model still
      // needs the trigger instruction as the final user turn.
      turnHistory.push({ role: "user", content: input.text });
    }
    return turnHistory;
  };
  const history = buildTurnHistory();
  const working: ChatMessage[] = [...history];
  const records: ToolCallRecord[] = [];
  let content = "";
  let stepText = "";
  let stepRecords: ToolCallRecord[] = [];
  let finalText = "";
  let turnUsage: TokenUsage | null = null;
  let overflowRetried = false;
  let browserObservationCount = 0;
  let unverifiedDraftHeld = false;
  let auditRevisions = 0;

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
      const stepBudgetIssue = budgetIssue();
      if (stepBudgetIssue) {
        emit({
          type: "chat.error",
          runId,
          threadId: thread.id,
          message: `Task stopped: ${stepBudgetIssue}. Partial results are preserved in this task.`,
        });
        return;
      }
      const contentBeforeStep = content;
      stepText = "";
      stepRecords = [];
      let pendingCalls: ToolCall[] = [];
      const stepImages: ToolImage[] = [];

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
        step -= 1;
        continue;
      }

      finalText = stepText;

      if (pendingCalls.length === 0) {
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

      for (const call of pendingCalls) {
        const callBudgetIssue = budgetIssue();
        if (callBudgetIssue) {
          emit({
            type: "chat.error",
            runId,
            threadId: thread.id,
            message: `Task stopped: ${callBudgetIssue}. Partial results are preserved in this task.`,
          });
          return;
        }
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
            ? browserObservationCount++
            : null,
        );
        records.push(record);
        stepRecords.push(record);
        working.push({
          role: "tool",
          toolCallId: call.id,
          content: record.output,
        });
        if (vision && images) {
          stepImages.push(...images);
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
