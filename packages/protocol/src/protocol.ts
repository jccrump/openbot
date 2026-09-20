import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalRecordSchema,
  ApprovalTierSchema,
  BotSchema,
  ChatBusyBehaviorSchema,
  CodexInfoSchema,
  CompactionSettingsSchema,
  CompactionTriggerSchema,
  ComputerKindSchema,
  DecisionInfoSchema,
  DecisionSettingsPatchSchema,
  HarnessIdSchema,
  HarnessSettingsSchema,
  MemorySchema,
  MemoryStatusSchema,
  MessageSchema,
  ModelRefSchema,
  PolicyPresetIdSchema,
  PolicySettingsSchema,
  ProviderInfoSchema,
  RolePolicySchema,
  ProviderPresetSchema,
  SoulVersionSchema,
  TaskSchema,
  ThreadSchema,
  ToolArtifactSchema,
} from "./domain";

export const FileEntrySchema = z.object({
  name: z.string(),
  dir: z.boolean(),
  size: z.number().nullable(),
  mtime: z.number().nullable(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    client: z.string().optional(),
  }),
  z.object({
    type: z.literal("bots.create"),
    requestId: z.string(),
    name: z.string().min(1),
    role: z.string().optional(),
    avatar: z.string().optional(),
    color: z.string().optional(),
    model: ModelRefSchema.optional(),
    /** @deprecated use computers. */
    computer: ComputerKindSchema.optional(),
    computers: z.array(ComputerKindSchema).optional(),
    delegates: z.boolean().optional(),
    policy: RolePolicySchema.optional(),
  }),
  z.object({
    type: z.literal("bots.update"),
    requestId: z.string(),
    botId: z.string(),
    name: z.string().min(1).optional(),
    role: z.string().nullable().optional(),
    avatar: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    /** @deprecated use computers. */
    computer: ComputerKindSchema.optional(),
    computers: z.array(ComputerKindSchema).optional(),
    delegates: z.boolean().optional(),
    policy: RolePolicySchema.optional(),
    model: ModelRefSchema.optional(),
  }),
  z.object({
    type: z.literal("bots.power"),
    requestId: z.string(),
    botId: z.string(),
    on: z.boolean(),
  }),
  z.object({
    type: z.literal("sandbox.status"),
    botId: z.string(),
  }),
  z.object({
    type: z.literal("files.list"),
    requestId: z.string(),
    botId: z.string(),
    path: z.string().optional(),
    /** Which computer to browse; defaults to the agent's primary. */
    computer: ComputerKindSchema.optional(),
  }),
  z.object({
    type: z.literal("files.read"),
    requestId: z.string(),
    botId: z.string(),
    path: z.string().min(1),
    /** Which computer to browse; defaults to the agent's primary. */
    computer: ComputerKindSchema.optional(),
  }),
  z.object({
    type: z.literal("bots.delete"),
    requestId: z.string(),
    botId: z.string(),
  }),
  z.object({
    type: z.literal("bots.reset"),
    requestId: z.string(),
    botId: z.string(),
  }),
  z.object({
    type: z.literal("chat.send"),
    botId: z.string(),
    threadId: z.string().optional(),
    text: z.string().min(1),
    model: ModelRefSchema.optional(),
    /** Client-generated id for the user message, echoed back so optimistic
     * bubbles reconcile with the persisted transcript. */
    messageId: z.string().optional(),
    /** What to do when the agent is already working in this thread. */
    delivery: ChatBusyBehaviorSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.cancel"),
    runId: z.string(),
  }),
  z.object({
    type: z.literal("task.cancel"),
    taskId: z.string(),
  }),
  z.object({
    type: z.literal("thread.list"),
  }),
  z.object({
    type: z.literal("thread.messages"),
    threadId: z.string(),
    /** Include messages folded away by compaction or a clear. */
    includeFolded: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("thread.clear"),
    threadId: z.string(),
  }),
  z.object({
    type: z.literal("approval.respond"),
    requestId: z.string(),
    decision: z.enum(["approve", "deny"]),
  }),
  z.object({
    type: z.literal("challenge.respond"),
    requestId: z.string(),
    action: z.enum(["retry", "skip"]),
  }),
  z.object({
    type: z.literal("provider.upsert"),
    provider: z.object({
      id: z.string().optional(),
      label: z.string().min(1),
      baseUrl: z.string().min(1),
      apiKey: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      models: z.array(z.string().min(1)),
      enabled: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("provider.remove"),
    id: z.string(),
  }),
  z.object({
    type: z.literal("provider.fetchModels"),
    requestId: z.string(),
    providerId: z.string().optional(),
    baseUrl: z.string().min(1),
    apiKey: z.string().optional(),
  }),
  z.object({
    type: z.literal("settings.update"),
    settings: z.object({
      defaultModel: ModelRefSchema.optional(),
      requireApproval: z.boolean().optional(),
      policy: PolicySettingsSchema.optional(),
      policyPreset: PolicyPresetIdSchema.optional(),
      compaction: z
        .object({
          enabled: z.boolean().optional(),
          thresholdTokens: z
            .number()
            .int()
            .min(32000)
            .max(1000000)
            .nullable()
            .optional(),
        })
        .optional(),
      harness: z
        .object({
          default: HarnessIdSchema.optional(),
        })
        .optional(),
      decision: DecisionSettingsPatchSchema.optional(),
      chatBusyBehavior: ChatBusyBehaviorSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal("decision.test"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("approvals.list"),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal("memory.list"),
    scope: z.string().optional(),
    status: MemoryStatusSchema.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  z.object({
    type: z.literal("memory.remove"),
    id: z.string(),
  }),
  z.object({
    type: z.literal("memory.consolidate"),
  }),
  z.object({
    type: z.literal("soul.get"),
    botId: z.string().optional(),
  }),
  z.object({
    type: z.literal("soul.revert"),
    botId: z.string().optional(),
    versionId: z.string(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    bots: z.array(BotSchema),
    threads: z.array(ThreadSchema),
    tasks: z.array(TaskSchema).optional(),
    providers: z.array(ProviderInfoSchema),
    presets: z.array(ProviderPresetSchema),
    defaultModel: ModelRefSchema,
    requireApproval: z.boolean(),
    policy: PolicySettingsSchema.optional(),
    compaction: CompactionSettingsSchema.optional(),
    harness: HarnessSettingsSchema.optional(),
    decision: DecisionInfoSchema.optional(),
    codex: CodexInfoSchema.optional(),
    chatBusyBehavior: ChatBusyBehaviorSchema.optional(),
  }),
  z.object({
    type: z.literal("bot.created"),
    requestId: z.string(),
    bot: BotSchema,
  }),
  z.object({
    type: z.literal("bot.updated"),
    requestId: z.string(),
    bot: BotSchema,
  }),
  z.object({
    type: z.literal("bot.deleted"),
    requestId: z.string(),
    botId: z.string(),
  }),
  z.object({
    type: z.literal("bot.reset"),
    requestId: z.string(),
    botId: z.string(),
    thread: ThreadSchema,
  }),
  z.object({
    type: z.literal("providers.updated"),
    providers: z.array(ProviderInfoSchema),
    defaultModel: ModelRefSchema,
    requireApproval: z.boolean(),
    policy: PolicySettingsSchema.optional(),
    compaction: CompactionSettingsSchema.optional(),
    harness: HarnessSettingsSchema.optional(),
    decision: DecisionInfoSchema.optional(),
    codex: CodexInfoSchema.optional(),
    chatBusyBehavior: ChatBusyBehaviorSchema.optional(),
  }),
  z.object({
    type: z.literal("provider.models"),
    requestId: z.string(),
    ok: z.boolean(),
    models: z.array(z.string()),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("decision.test"),
    requestId: z.string(),
    ok: z.boolean(),
    model: z.string().nullable(),
    latencyMs: z.number().nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("threads"),
    threads: z.array(ThreadSchema),
  }),
  z.object({
    type: z.literal("thread.messages"),
    threadId: z.string(),
    messages: z.array(MessageSchema),
  }),
  z.object({
    type: z.literal("thread.upserted"),
    thread: ThreadSchema,
  }),
  z.object({
    type: z.literal("thread.cleared"),
    threadId: z.string(),
    thread: ThreadSchema,
  }),
  z.object({
    type: z.literal("chat.start"),
    runId: z.string(),
    threadId: z.string(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("chat.delta"),
    runId: z.string(),
    threadId: z.string(),
    messageId: z.string(),
    text: z.string(),
    reset: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("chat.reasoning"),
    runId: z.string(),
    threadId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("chat.decision"),
    runId: z.string(),
    threadId: z.string(),
    messageId: z.string(),
    kind: z.enum(["audit", "browse", "route", "guardrail"]),
    summary: z.string(),
    flagged: z.boolean(),
    latencyMs: z.number().nullable(),
    model: z.string().nullable(),
    // Set for route decisions so the app can tell conversation from work
    // without parsing the summary.
    route: z.enum(["chat", "direct", "project", "new_project"]).optional(),
  }),
  z.object({
    type: z.literal("chat.compaction"),
    runId: z.string().optional(),
    threadId: z.string(),
    status: z.enum(["start", "done"]),
    trigger: CompactionTriggerSchema,
    isFirstCompaction: z.boolean().optional(),
    messagesToCompact: z.number().optional(),
    tokensBefore: z.number().optional(),
    tokensAfter: z.number().optional(),
    thresholdTokens: z.number().optional(),
    summaryMessageId: z.string().optional(),
  }),
  z.object({
    type: z.literal("chat.done"),
    runId: z.string(),
    threadId: z.string(),
    message: MessageSchema,
  }),
  z.object({
    type: z.literal("chat.message"),
    runId: z.string(),
    threadId: z.string(),
    message: MessageSchema,
  }),
  z.object({
    type: z.literal("chat.queued"),
    threadId: z.string(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("chat.dequeued"),
    threadId: z.string(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("chat.error"),
    runId: z.string().optional(),
    threadId: z.string().optional(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("tool.start"),
    runId: z.string(),
    threadId: z.string(),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal("tool.result"),
    runId: z.string(),
    threadId: z.string(),
    callId: z.string(),
    ok: z.boolean(),
    output: z.string(),
    durationMs: z.number(),
    artifacts: z.array(ToolArtifactSchema).nullable(),
  }),
  z.object({
    type: z.literal("tool.output"),
    runId: z.string(),
    threadId: z.string(),
    callId: z.string(),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("approval.request"),
    requestId: z.string(),
    runId: z.string(),
    threadId: z.string(),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
    tier: ApprovalTierSchema,
    reason: z.string(),
  }),
  z.object({
    type: z.literal("challenge.request"),
    requestId: z.string(),
    runId: z.string(),
    threadId: z.string(),
    callId: z.string(),
    url: z.string().nullable(),
  }),
  z.object({
    type: z.literal("sandbox.state"),
    botId: z.string(),
    taskId: z.string().optional(),
    state: z.enum(["stopped", "booting", "running", "error"]),
  }),
  z.object({
    type: z.literal("files.list"),
    requestId: z.string(),
    botId: z.string(),
    path: z.string(),
    entries: z.array(FileEntrySchema),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("files.read"),
    requestId: z.string(),
    botId: z.string(),
    path: z.string(),
    kind: z.enum(["text", "image", "binary", "dir", "missing"]),
    content: z.string().nullable(),
    mime: z.string().nullable(),
    size: z.number(),
    truncated: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("task.upserted"),
    task: TaskSchema,
  }),
  z.object({
    type: z.literal("approvals.list"),
    approvals: z.array(ApprovalRecordSchema),
  }),
  z.object({
    type: z.literal("approval.resolved"),
    requestId: z.string(),
    decision: ApprovalDecisionSchema,
    reason: z.string(),
  }),
  z.object({
    type: z.literal("memory.list"),
    memories: z.array(MemorySchema),
  }),
  z.object({
    type: z.literal("memory.removed"),
    id: z.string(),
  }),
  z.object({
    type: z.literal("memory.consolidated"),
    archived: z.number(),
    merged: z.number(),
  }),
  z.object({
    type: z.literal("soul"),
    botId: z.string(),
    soul: SoulVersionSchema.nullable(),
    versions: z.array(SoulVersionSchema),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
