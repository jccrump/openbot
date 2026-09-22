import { z } from "zod";

// Reasoning effort sent to OpenAI-compatible providers as `reasoning_effort`.
// DeepSeek accepts none/low/high/max (minimal maps to low, medium to high);
// OpenAI accepts minimal/low/medium/high (none on the newest models).
export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  /** Unset means the provider's own default. */
  effort: ReasoningEffortSchema.optional(),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const POLICY_PRESET_IDS = [
  "balanced",
  "read-only",
  "trusted",
  "locked",
] as const;
export const PolicyPresetIdSchema = z.enum(POLICY_PRESET_IDS);
export type PolicyPresetId = z.infer<typeof PolicyPresetIdSchema>;

export const RolePolicySchema = z.enum([
  "inherit",
  "balanced",
  "read-only",
  "trusted",
  "locked",
]);
export type RolePolicy = z.infer<typeof RolePolicySchema>;

export const ComputerKindSchema = z.enum(["firecracker", "mac"]);
export type ComputerKind = z.infer<typeof ComputerKindSchema>;

/**
 * The computers an agent can act on. An agent may have just the microVM, just
 * This Mac, or both (ADR-021). The list is the source of truth for which
 * computer panels the UI shows and which computers a tool call may name; the
 * primary computer (the microVM when present, otherwise This Mac) is the
 * default target when a call does not name one.
 */
export function botComputers(
  bot: { computers?: ComputerKind[] | null },
): ComputerKind[] {
  const list = bot.computers ?? [];
  return list.length > 0 ? list : ["firecracker"];
}

export function botHasComputer(
  bot: { computers?: ComputerKind[] | null },
  computer: ComputerKind,
): boolean {
  return botComputers(bot).includes(computer);
}

export function primaryComputer(
  bot: { computers?: ComputerKind[] | null },
): ComputerKind {
  return botHasComputer(bot, "firecracker") ? "firecracker" : "mac";
}

/**
 * How far a This Mac agent's file tools and shell may reach: its assigned
 * project folder, the whole home folder, or the whole filesystem (ADR-023).
 */
export const AccessModeSchema = z.enum(["project", "home", "full"]);
export type AccessMode = z.infer<typeof AccessModeSchema>;

export const AccessStateSchema = z.enum(["granted", "denied", "missing"]);
export type AccessState = z.infer<typeof AccessStateSchema>;

export const AccessPaneSchema = z.enum([
  "full-disk",
  "files",
  "documents",
  "desktop",
  "downloads",
]);
export type AccessPane = z.infer<typeof AccessPaneSchema>;

export const AccessEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string().nullable(),
  state: AccessStateSchema,
  /** The System Settings privacy pane that governs this entry. */
  pane: AccessPaneSchema.nullable(),
});
export type AccessEntry = z.infer<typeof AccessEntrySchema>;

export const AccessReportSchema = z.object({
  /** Which app macOS attributes the permission to. */
  owner: z.string(),
  platform: z.string(),
  entries: z.array(AccessEntrySchema),
});
export type AccessReport = z.infer<typeof AccessReportSchema>;

/**
 * A local project folder the daemon knows about. Agents reference a workspace
 * by id instead of a path, so moving a repo updates one row and every agent
 * follows. The registry is the allowlist: an agent's file tools are confined
 * to its workspace root.
 */
export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  root: z.string(),
  markers: z.array(z.string()).default([]),
  ignored: z.boolean().default(false),
  /** The root no longer exists on disk; kept so the user can fix or remove it. */
  missing: z.boolean().default(false),
  /**
   * Shell command patterns auto-approved for agents working in this project.
   * Trust is per repo: a deny rule or an ask rule still wins.
   */
  autoApprove: z.array(z.string()).default([]),
  createdAt: z.string(),
  lastSeenAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const BotSchema = z.object({
  id: z.string(),
  name: z.string(),
  systemPrompt: z.string(),
  model: ModelRefSchema,
  createdAt: z.string(),
  role: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  /** Which computers this agent can act on: the microVM, This Mac, or both. */
  computers: z.array(ComputerKindSchema).optional(),
  /** The project folder this agent works in; unset means a managed scratch folder. */
  workspaceId: z.string().nullable().optional(),
  /** File and shell reach on This Mac; defaults to the project folder. */
  access: AccessModeSchema.default("project"),
  policy: RolePolicySchema.default("inherit"),
});
export type Bot = z.infer<typeof BotSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ToolArtifactSchema = z.object({
  type: z.literal("image"),
  url: z.string(),
});
export type ToolArtifact = z.infer<typeof ToolArtifactSchema>;

export const FileChangeSchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  diff: z.string().nullable(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const ToolCallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
  output: z.string(),
  ok: z.boolean(),
  durationMs: z.number(),
  artifacts: z.array(ToolArtifactSchema).nullable(),
  changes: z.array(FileChangeSchema).nullable().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
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

export const ChatBusyBehaviorSchema = z.enum(["steer", "queue"]);
export type ChatBusyBehavior = z.infer<typeof ChatBusyBehaviorSchema>;

export const HarnessSettingsSchema = z.object({
  default: HarnessIdSchema,
});
export type HarnessSettings = z.infer<typeof HarnessSettingsSchema>;

export const DecisionGuardrailModeSchema = z.enum(["off", "annotate", "block"]);
export type DecisionGuardrailMode = z.infer<
  typeof DecisionGuardrailModeSchema
>;

export const DecisionInfoSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string(),
  model: z.string(),
  hasApiKey: z.boolean(),
  apiKeyEnv: z.string().nullable(),
  audit: z.boolean(),
  browse: z.boolean(),
  guardrail: DecisionGuardrailModeSchema,
  timeoutMs: z.number(),
});
export type DecisionInfo = z.infer<typeof DecisionInfoSchema>;

export const DecisionSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  audit: z.boolean().optional(),
  browse: z.boolean().optional(),
  guardrail: DecisionGuardrailModeSchema.optional(),
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
});
export type DecisionSettingsPatch = z.infer<
  typeof DecisionSettingsPatchSchema
>;

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

export const PlanStepSchema = z.object({
  step: z.string(),
  status: z.enum(["pending", "in_progress", "done"]),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  botId: z.string(),
  title: z.string(),
  lastMessage: z.string().nullable(),
  lastCompactedAt: z.string().nullable().optional(),
  compactionCount: z.number().optional(),
  clearedAt: z.string().nullable().optional(),
  plan: z.array(PlanStepSchema).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const ApprovalTierSchema = z.enum(["auto", "ask", "deny"]);
export type ApprovalTier = z.infer<typeof ApprovalTierSchema>;

export const PolicyRuleSchema = z.object({
  id: z.string(),
  tool: z.string(),
  scope: z.enum(["*", "firecracker", "mac"]).default("*"),
  /** "any" matches every call of the tool, with no pattern. */
  match: z.enum(["command", "path", "domain", "text", "any"]),
  pattern: z.string(),
  tier: ApprovalTierSchema,
  note: z.string().nullable().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const EgressModeSchema = z.enum(["off", "ask", "deny"]);
export type EgressMode = z.infer<typeof EgressModeSchema>;

export const EgressSettingsSchema = z.object({
  mode: EgressModeSchema,
  allow: z.array(z.string()),
});
export type EgressSettings = z.infer<typeof EgressSettingsSchema>;

export const PolicySettingsSchema = z.object({
  timeoutMs: z.number().int().min(0).max(86_400_000),
  defaultTier: z.enum(["auto", "ask", "deny", "inherit"]),
  tools: z.record(z.string(), ApprovalTierSchema),
  rules: z.array(PolicyRuleSchema),
  egress: EgressSettingsSchema.optional(),
});
export type PolicySettings = z.infer<typeof PolicySettingsSchema>;



export const ApprovalDecisionSchema = z.enum([
  "approve",
  "deny",
  "timeout",
  "abort",
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalRecordSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  runId: z.string().nullable(),
  threadId: z.string().nullable(),
  botId: z.string().nullable(),
  tool: z.string(),
  arguments: z.string(),
  tier: ApprovalTierSchema,
  reason: z.string(),
  decision: ApprovalDecisionSchema.nullable(),
  decidedBy: z.enum(["user", "timeout", "abort"]).nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const MemoryTypeSchema = z.enum([
  "semantic",
  "relational",
  "procedural",
  "episodic",
]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryStatusSchema = z.enum(["active", "suspect", "archived"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemorySchema = z.object({
  id: z.string(),
  scope: z.string(),
  type: MemoryTypeSchema,
  content: z.string(),
  evidence: z.array(z.string()).nullable().optional(),
  confidence: z.number(),
  importance: z.number(),
  status: MemoryStatusSchema,
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable().optional(),
  useCount: z.number(),
});
export type Memory = z.infer<typeof MemorySchema>;

export const SoulContentSchema = z.object({
  voice: z.string(),
  commitments: z.array(z.string()),
  relationship: z.string(),
});
export type SoulContent = z.infer<typeof SoulContentSchema>;

export const SoulVersionSchema = z.object({
  id: z.string(),
  botId: z.string(),
  version: z.number(),
  content: SoulContentSchema,
  summary: z.string(),
  reason: z.string(),
  source: z.string(),
  createdAt: z.string(),
});
export type SoulVersion = z.infer<typeof SoulVersionSchema>;

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
