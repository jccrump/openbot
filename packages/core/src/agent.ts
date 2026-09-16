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

const MAX_STEPS = 8;

function addUsage(
  total: TokenUsage | null,
  usage: TokenUsage,
): TokenUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
  };
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
): Promise<ToolCallRecord> {
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
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const contentBeforeStep = content;
      let stepText = "";
      let pendingCalls: ToolCall[] = [];

      try {
        for await (const event of provider.chat({
          model: model.model,
          messages: working,
          ...(definitions.length ? { tools: definitions } : {}),
          signal,
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
      if (content.length > 0) {
        deps.store.addMessage({
          id: assistantMessageId,
          threadId: thread.id,
          role: "assistant",
          content,
          model,
          toolCalls: records.length ? records : null,
          usage: turnUsage,
        });
        deps.store.touchThread(thread.id);
      }
      emit({
        type: "chat.error",
        runId,
        threadId: thread.id,
        message: "cancelled",
      });
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

  const message = deps.store.addMessage({
    id: assistantMessageId,
    threadId: thread.id,
    role: "assistant",
    content: finalText || content,
    model,
    toolCalls: records.length ? records : null,
    usage: turnUsage,
  });
  const refreshed = deps.store.touchThread(thread.id);
  if (refreshed) {
    emit({ type: "thread.upserted", thread: refreshed });
  }
  emit({ type: "chat.done", runId, threadId: thread.id, message });
}
