import { z } from "zod";

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const BotSchema = z.object({
  id: z.string(),
  name: z.string(),
  systemPrompt: z.string(),
  model: ModelRefSchema,
  createdAt: z.string(),
  role: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  computer: z.string().nullable().optional(),
});
export type Bot = z.infer<typeof BotSchema>;

export const ComputerKindSchema = z.enum(["firecracker", "mac"]);
export type ComputerKind = z.infer<typeof ComputerKindSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ToolArtifactSchema = z.object({
  type: z.literal("image"),
  url: z.string(),
});
export type ToolArtifact = z.infer<typeof ToolArtifactSchema>;

export const ToolCallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
  output: z.string(),
  ok: z.boolean(),
  durationMs: z.number(),
  artifacts: z.array(ToolArtifactSchema).nullable(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const CompactionTriggerSchema = z.enum(["auto", "overflow", "manual"]);
export type CompactionTrigger = z.infer<typeof CompactionTriggerSchema>;

export const CompactionMetaSchema = z.object({
  trigger: CompactionTriggerSchema,
  messagesToCompact: z.number(),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  isFirstCompaction: z.boolean(),
});
export type CompactionMeta = z.infer<typeof CompactionMetaSchema>;

export const CompactionSettingsSchema = z.object({
  enabled: z.boolean(),
  thresholdTokens: z.number().nullable(),
});
export type CompactionSettings = z.infer<typeof CompactionSettingsSchema>;

export const HarnessIdSchema = z.enum(["openbot", "codex"]);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

export const HarnessSettingsSchema = z.object({
  default: HarnessIdSchema,
});
export type HarnessSettings = z.infer<typeof HarnessSettingsSchema>;

export const CodexInfoSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
});
export type CodexInfo = z.infer<typeof CodexInfoSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  model: ModelRefSchema.nullable(),
  toolCalls: z.array(ToolCallRecordSchema).nullable(),
  usage: TokenUsageSchema.nullable().optional(),
  compaction: CompactionMetaSchema.nullable().optional(),
  foldedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  botId: z.string(),
  title: z.string(),
  lastMessage: z.string().nullable(),
  lastCompactedAt: z.string().nullable().optional(),
  compactionCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const ProviderInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  models: z.array(z.string()),
  hasApiKey: z.boolean(),
  apiKeyEnv: z.string().nullable(),
  enabled: z.boolean(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const ProviderPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  apiKeyEnv: z.string().nullable(),
  models: z.array(z.string()),
});
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;
