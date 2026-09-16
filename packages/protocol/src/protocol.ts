import { z } from "zod";
import {
  BotSchema,
  CodexInfoSchema,
  CompactionSettingsSchema,
  CompactionTriggerSchema,
  ComputerKindSchema,
  HarnessIdSchema,
  HarnessSettingsSchema,
  MessageSchema,
  ModelRefSchema,
  ProviderInfoSchema,
  ProviderPresetSchema,
  ThreadSchema,
  ToolArtifactSchema,
} from "./domain";

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
    computer: ComputerKindSchema.optional(),
  }),
  z.object({
    type: z.literal("bots.update"),
    requestId: z.string(),
    botId: z.string(),
    computer: ComputerKindSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.send"),
    botId: z.string(),
    threadId: z.string().optional(),
    text: z.string().min(1),
    model: ModelRefSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.cancel"),
    runId: z.string(),
  }),
  z.object({
    type: z.literal("thread.list"),
  }),
  z.object({
    type: z.literal("thread.messages"),
    threadId: z.string(),
  }),
  z.object({
    type: z.literal("approval.respond"),
    requestId: z.string(),
    decision: z.enum(["approve", "deny"]),
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
    }),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    bots: z.array(BotSchema),
    threads: z.array(ThreadSchema),
    providers: z.array(ProviderInfoSchema),
    presets: z.array(ProviderPresetSchema),
    defaultModel: ModelRefSchema,
    requireApproval: z.boolean(),
    compaction: CompactionSettingsSchema.optional(),
    harness: HarnessSettingsSchema.optional(),
    codex: CodexInfoSchema.optional(),
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
    type: z.literal("providers.updated"),
    providers: z.array(ProviderInfoSchema),
    defaultModel: ModelRefSchema,
    requireApproval: z.boolean(),
    compaction: CompactionSettingsSchema.optional(),
    harness: HarnessSettingsSchema.optional(),
    codex: CodexInfoSchema.optional(),
  }),
  z.object({
    type: z.literal("provider.models"),
    requestId: z.string(),
    ok: z.boolean(),
    models: z.array(z.string()),
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
  }),
  z.object({
    type: z.literal("chat.reasoning"),
    runId: z.string(),
    threadId: z.string(),
    messageId: z.string(),
    text: z.string(),
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
    type: z.literal("approval.request"),
    requestId: z.string(),
    runId: z.string(),
    threadId: z.string(),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal("sandbox.state"),
    botId: z.string(),
    state: z.enum(["stopped", "booting", "running", "error"]),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
