import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ChatMessage,
  ChatProvider,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "@openbot/gateway";
import type {
  CompactionSettings,
  CompactionTrigger,
  ComputerKind,
  Message,
  ModelRef,
  ServerMessage,
  ToolArtifact,
  ToolCallRecord,
} from "@openbot/protocol";
import type { SandboxBackend } from "@openbot/sandbox";
import type { ApprovalBroker } from "./approvals";
import {
  compactThread,
  estimateChatTokens,
  isContextOverflowError,
  planCompaction,
  resolveCompactionThreshold,
} from "./compaction";
import type { ProviderRecord, Store } from "./store";
import { DEFAULT_THREAD_TITLE } from "./store";
import {
  findTool,
  toolDefinitions,
  type Tool,
  type ToolContext,
} from "./tools";
import {
  annotateBrowserObservation,
  buildCompletionAuditRequest,
  buildVerificationFeedback,
  COMPLETION_VERIFIER_SYSTEM_PROMPT,
  parseCompletionAudit,
  shouldAuditCompletion,
  type CompletionAudit,
} from "./task-harness";

export interface AgentDeps {
  store: Store;
  providers: Map<string, ChatProvider>;
  sandbox: SandboxBackend | null;
  approvals: ApprovalBroker;
  requireApproval: boolean;
  artifactsDir: string;
  compaction: () => CompactionSettings;
  sandboxUrl: string;
  dataDir: string;
  providerRecord: (id: string) => ProviderRecord | null;
  resolveProviderKey: (record: ProviderRecord) => string | undefined;
}

export interface AgentInput {
  runId: string;
  botId: string;
  threadId?: string;
  text: string;
  model?: ModelRef;
}

const PROVIDER_STEP_TIMEOUT_MS = 60_000;

function addUsage(
  total: TokenUsage | null,
  usage: TokenUsage,
): TokenUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
  };
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

function buildHistory(
  systemPrompt: string,
  messages: Message[],
): ChatMessage[] {
  const history: ChatMessage[] = [{ role: "system", content: systemPrompt }];
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
    } else {
      history.push({ role: message.role, content: message.content });
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
  requireApproval: boolean,
  browserObservationIndex: number | null,
): Promise<ToolCallRecord> {
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

  const tool = findTool(call.name);
  if (!tool) {
    output = `unknown tool: ${call.name}`;
  } else if (requireApproval) {
    const requestId = randomUUID();
    emit({
      type: "approval.request",
      requestId,
      runId: ids.runId,
      threadId: ids.threadId,
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
    });
    const decision = await Promise.race([
      deps.approvals.request(requestId),
      new Promise<"deny">((resolve) => {
        if (signal.aborted) {
          resolve("deny");
          return;
        }
        signal.addEventListener("abort", () => resolve("deny"), { once: true });
      }),
    ]);
    if (decision === "approve") {
      const result = await runTool(tool, context, call);
      ok = result.ok;
      output = result.output;
      executionMs = result.durationMs;
      artifacts = result.artifacts ?? null;
    } else {
      output = "The user denied this action. Do not retry it.";
    }
  } else {
    const result = await runTool(tool, context, call);
    ok = result.ok;
    output = result.output;
    executionMs = result.durationMs;
    artifacts = result.artifacts ?? null;
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
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    output,
    ok,
    durationMs: executionMs,
    artifacts,
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
  const toolContext: ToolContext | null =
    local || deps.sandbox
      ? {
          botId: bot.id,
          computer,
          sandbox: deps.sandbox,
          workspaceDir: join(deps.dataDir, "workspaces", bot.id),
          artifactsDir: deps.artifactsDir,
          onSandboxState: (state) =>
            emit({ type: "sandbox.state", botId: bot.id, state }),
        }
      : null;
  const definitions: ToolDefinition[] = toolContext
    ? toolDefinitions(computer)
    : [];
  const requireApproval = deps.requireApproval || local;

  const history = buildHistory(
    bot.systemPrompt,
    deps.store.listMessages(thread.id),
  );
  const working: ChatMessage[] = [...history];
  const records: ToolCallRecord[] = [];
  let content = "";
  let finalText = "";
  let turnUsage: TokenUsage | null = null;
  let overflowRetried = false;
  let browserObservationCount = 0;
  let unverifiedDraftHeld = false;

  const persistAssistant = (messageContent: string): Message => {
    const message = deps.store.addMessage({
      id: assistantMessageId,
      threadId: thread.id,
      role: "assistant",
      content: messageContent,
      model,
      toolCalls: records.length ? records : null,
      usage: turnUsage,
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
      const contentBeforeStep = content;
      let stepText = "";
      let pendingCalls: ToolCall[] = [];
      const holdStepText = shouldAuditCompletion(records);

      try {
        const providerSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(PROVIDER_STEP_TIMEOUT_MS),
        ]);
        for await (const event of provider.chat({
          model: model.model,
          messages: working,
          ...(definitions.length ? { tools: definitions } : {}),
          signal: providerSignal,
        })) {
          if (event.type === "text_delta") {
            stepText += event.text;
            content += event.text;
            if (!holdStepText) {
              emit({
                type: "chat.delta",
                runId,
                threadId: thread.id,
                messageId: assistantMessageId,
                text: event.text,
              });
            }
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
        working.splice(
          0,
          working.length,
          ...buildHistory(bot.systemPrompt, deps.store.listMessages(thread.id)),
        );
        step -= 1;
        continue;
      }

      finalText = stepText;

      if (pendingCalls.length === 0) {
        if (shouldAuditCompletion(records) && finalText.trim()) {
          unverifiedDraftHeld = true;
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
            if (holdStepText) {
              emit({
                type: "chat.delta",
                runId,
                threadId: thread.id,
                messageId: assistantMessageId,
                text: finalText,
              });
            }
            unverifiedDraftHeld = false;
            break;
          }
          console.info("completion.audit", {
            runId,
            threadId: thread.id,
            botId: bot.id,
            verdict: audited.audit.verdict,
            issues: audited.audit.issues,
          });
          if (audited.audit.verdict === "continue") {
            working.push({ role: "assistant", content: finalText });
            working.push({
              role: "user",
              content: buildVerificationFeedback(audited.audit),
            });
            finalText = "";
            continue;
          }
          unverifiedDraftHeld = false;
          if (holdStepText) {
            emit({
              type: "chat.delta",
              runId,
              threadId: thread.id,
              messageId: assistantMessageId,
              text: finalText,
            });
          }
        }
        break;
      }

      working.push({
        role: "assistant",
        content: stepText || null,
        toolCalls: pendingCalls,
      });

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
          working.push({
            role: "tool",
            content: record.output,
            toolCallId: call.id,
          });
          continue;
        }
        const record = await executeToolCall(
          deps,
          toolContext,
          call,
          { runId, threadId: thread.id },
          emit,
          signal,
          requireApproval,
          call.name === "browser" ? browserObservationCount++ : null,
        );
        records.push(record);
        working.push({
          role: "tool",
          content: record.output,
          toolCallId: call.id,
        });
      }
    }
  } catch (error) {
    if (signal.aborted) {
      if (content.length > 0 || records.length > 0) {
        persistAssistant(
          unverifiedDraftHeld
            ? "The action was cancelled before I could produce a verified final answer. The completed tool results are preserved in this chat."
            : content || "The action was cancelled.",
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
      const message = persistAssistant(toolRecoveryText(error));
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
    finalText ||
      content ||
      (records.length > 0
        ? toolRecoveryText(new Error("the model returned no final response"))
        : "I couldn't produce a response."),
  );
  emit({ type: "chat.done", runId, threadId: thread.id, message });
}
