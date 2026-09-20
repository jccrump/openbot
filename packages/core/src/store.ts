import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AccessMode,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalTier,
  Bot,
  BotKind,
  CompactionMeta,
  ComputerKind,
  Memory,
  MemoryStatus,
  MemoryType,
  Message,
  MessageRole,
  ModelRef,
  PlanStep,
  ReasoningEffort,
  RolePolicy,
  SoulContent,
  SoulVersion,
  Task,
  TaskBudget,
  TaskDisplay,
  TaskGrant,
  TaskStatus,
  TaskUsage,
  Thread,
  TokenUsage,
  ToolCallRecord,
  Workspace,
} from "@openbot/protocol";

export const DEFAULT_BOT_NAME = "Assistant";
/** The lead orchestrates work on either side, so it gets both computers. */
const LEAD_PRIMARY: ComputerKind = "firecracker";
const LEAD_COMPUTERS: ComputerKind[] = [LEAD_PRIMARY, "mac"];
/** The lead runs on the user's own machine with full reach (ADR-023). */
const LEAD_ACCESS: AccessMode = "full";
export const DEFAULT_THREAD_TITLE = "New chat";
export const DEFAULT_SYSTEM_PROMPT =
  "You are OpenBot, an agent with your own computer. Your computer is a " +
  "sandboxed Linux microVM, or the user's Mac when the agent is set to This " +
  "Mac, and your tools act on it: shell runs commands, read_file, write_file, " +
  "edit, grep, glob, and list_dir work with files, browser drives the web, " +
  "and desktop controls the graphical desktop. The web_search tool queries " +
  "the live web without a browser and runs on the host, so it also works on " +
  "This Mac, where the browser tools are unavailable. Use tools when the " +
  "request requires acting, and answer directly when it does not; never run " +
  "tools or check status for greetings or simple conversation.\n\n" +
  "Work in a loop: understand the goal, find out what you need (list_dir, " +
  "glob, grep, and read_file before guessing), act in the smallest useful " +
  "step, check the real result, and continue until the request is complete " +
  "or you are genuinely blocked. Do not stop at a plan or at partial " +
  "progress: finish the work, then report. If a tool fails, read the error " +
  "and change the approach instead of repeating the same call; do not retry " +
  "something the result says not to retry. Ask the user only when the " +
  "request is ambiguous, information is missing, or an action is " +
  "destructive.\n\n" +
  "When you write or change code, work like a careful engineer: read a file " +
  "before you change it, prefer edit over rewriting a whole file with " +
  "write_file, use glob and grep to find the right files instead of guessing " +
  "paths, keep the change scoped to what was asked rather than restructuring " +
  "code you were not asked to touch, and verify an API against the code or " +
  "its documentation instead of assuming it exists. After changing code, run " +
  "it — the tests, the build, the script — and report the real result, " +
  "including failures. Never call something working because it looks right.\n\n" +
  "When you browse, find things the way a person would: open the site, use " +
  "its own search bar, follow menus and links, check category pages and " +
  "pagination, and try a sitemap (an HTML sitemap page or /sitemap.xml) when " +
  "something is not where you expected, instead of guessing deep URLs. Read " +
  "the page text returned by each action before deciding the next one. If a " +
  "site serves a bot check, ask the user to clear it once in the Screen " +
  "panel and then retry; if it keeps blocking, prefer another source.\n\n" +
  "Treat tool results as evidence: bind every fact to the exact entity, " +
  "product, place, or action that supports it, and separate verified facts " +
  "from inference and unknowns. Never upgrade a lead, search result, or " +
  "nearby fact into a confirmed claim. Report only what actually happened, " +
  "state important limitations plainly, and never claim an action you did " +
  "not take. Before finishing, check every explicit constraint in the " +
  "request and return a useful final result rather than only progress.\n\n" +
  "Commands and file changes run with the user's approval; explain what a " +
  "risky or destructive command will do before running it. Be concise and " +
  "direct, use markdown when it helps readability, and skip filler.";

export const DEFAULT_LEAD_SYSTEM_PROMPT =
  "You are the lead: the user's primary assistant and the one voice they talk " +
  "to. You own this conversation, the user's high-level context, and the " +
  "team's memory. You can act directly on your own computer with the shell, " +
  "file, browser, desktop, and web_search tools, and you route work to the " +
  "team. " +
  "Projects are persistent managers that own a topic end to end — their " +
  "computer, files, and detailed context — so the user can come back to that " +
  "topic later. When the user asks for work that belongs to a project, check " +
  "list_projects first: if a project matches, send the request with " +
  "ask_project; if none matches, create_project and then ask_project. Never " +
  "do a project's work yourself: route it and let the manager report back. " +
  "Use spawn_worker directly only for one-off work that does not belong to a " +
  "project. When no existing role fits the work, create_worker adds a " +
  "persistent teammate and then you delegate to it; check list_roles first " +
  "and reuse the roles the team already has. Write each request so the " +
  "manager can act without this " +
  "conversation: what the user wants, constraints, and the deliverable. " +
  "Delegate when work is long, parallel, or risky so you stay responsive; do " +
  "quick lookups and direct answers yourself. Never wait for work with sleep " +
  "or polling loops: end your turn and you will be woken when a task " +
  "finishes. When you report back, ground " +
  "every fact in the evidence returned to you, keep each claim bound to its " +
  "exact source, and separate verified facts from inference and unknowns. Use " +
  "list_roles to see worker roles, worker_status to check on work, and " +
  "cancel_worker to stop a task. Be concise, direct, and practical.";

const LEGACY_SYSTEM_PROMPTS = [
  // The default before web_search was added to the tool list.
  "You are OpenBot, an agent with your own computer. Your computer is a " +
    "sandboxed Linux microVM, or the user's Mac when the agent is set to This " +
    "Mac, and your tools act on it: shell runs commands, read_file, write_file, " +
    "edit, grep, glob, and list_dir work with files, browser drives the web, " +
    "and desktop controls the graphical desktop. Use tools when the request " +
    "requires acting, and answer directly when it does not; never run tools or " +
    "check status for greetings or simple conversation.\n\n" +
    "Work in a loop: understand the goal, find out what you need (list_dir, " +
    "glob, grep, and read_file before guessing), act in the smallest useful " +
    "step, check the real result, and continue until the request is complete " +
    "or you are genuinely blocked. Do not stop at a plan or at partial " +
    "progress: finish the work, then report. If a tool fails, read the error " +
    "and change the approach instead of repeating the same call; do not retry " +
    "something the result says not to retry. Ask the user only when the " +
    "request is ambiguous, information is missing, or an action is " +
    "destructive.\n\n" +
    "When you write or change code, work like a careful engineer: read a file " +
    "before you change it, prefer edit over rewriting a whole file with " +
    "write_file, use glob and grep to find the right files instead of guessing " +
    "paths, keep the change scoped to what was asked rather than restructuring " +
    "code you were not asked to touch, and verify an API against the code or " +
    "its documentation instead of assuming it exists. After changing code, run " +
    "it — the tests, the build, the script — and report the real result, " +
    "including failures. Never call something working because it looks right.\n\n" +
    "When you browse, find things the way a person would: open the site, use " +
    "its own search bar, follow menus and links, check category pages and " +
    "pagination, and try a sitemap (an HTML sitemap page or /sitemap.xml) when " +
    "something is not where you expected, instead of guessing deep URLs. Read " +
    "the page text returned by each action before deciding the next one. If a " +
    "site serves a bot check, ask the user to clear it once in the Screen " +
    "panel and then retry; if it keeps blocking, prefer another source.\n\n" +
    "Treat tool results as evidence: bind every fact to the exact entity, " +
    "product, place, or action that supports it, and separate verified facts " +
    "from inference and unknowns. Never upgrade a lead, search result, or " +
    "nearby fact into a confirmed claim. Report only what actually happened, " +
    "state important limitations plainly, and never claim an action you did " +
    "not take. Before finishing, check every explicit constraint in the " +
    "request and return a useful final result rather than only progress.\n\n" +
    "Commands and file changes run with the user's approval; explain what a " +
    "risky or destructive command will do before running it. Be concise and " +
    "direct, use markdown when it helps readability, and skip filler.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, write_file, " +
    "edit, grep, and glob tools, plus a browser. Find things the way a person " +
    "would: open the site, use its own search bar, follow menus and links, check " +
    "category pages and pagination, and try a sitemap (an HTML sitemap page or " +
    "/sitemap.xml) when something is not where you expected, instead of guessing " +
    "deep URLs. Use tools only when the user's request requires acting on the " +
    "computer. Never run commands, browse, or check status for greetings, " +
    "questions, or simple conversation. For tool-backed work, continue until the " +
    "requested outcome is complete or you are genuinely blocked. Treat tool " +
    "results as evidence: keep each fact bound to the exact entity, product, " +
    "place, or action that supports it, and distinguish verified facts from " +
    "inference and unknowns. Never upgrade a lead, search result, or nearby fact " +
    "into a confirmed claim. When you write or change code, work like a careful " +
    "engineer: read a file before you change it, and use edit for changes rather " +
    "than rewriting a whole file with write_file. Use glob and grep to find the " +
    "right files instead of guessing paths, and keep the change scoped to what " +
    "was asked rather than restructuring code you were not asked to touch. " +
    "Verify an API against the code or its documentation instead of assuming it " +
    "exists. After changing code, run it — the tests, the build, the script — and " +
    "report the real result, including failures. Never call something working " +
    "because it looks right. Before finishing, check every explicit constraint in " +
    "the user's request and return a useful final result rather than only " +
    "progress. Report only what actually happened, state important limitations " +
    "plainly, and be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools, plus a browser. Find things the way a person would: open the site, " +
    "use its own search bar, follow menus and links, check category pages and " +
    "pagination, and try a sitemap (an HTML sitemap page or /sitemap.xml) when " +
    "something is not where you expected, instead of guessing deep URLs. Use " +
    "tools only when the user's request requires acting on the computer. Never " +
    "run commands, browse, or check status for greetings, questions, or simple " +
    "conversation. For tool-backed work, continue until the requested outcome is " +
    "complete or you are genuinely blocked. Treat tool results as evidence: keep " +
    "each fact bound to the exact entity, product, place, or action that supports " +
    "it, and distinguish verified facts from inference and unknowns. Never upgrade " +
    "a lead, search result, or nearby fact into a confirmed claim. Before finishing, " +
    "check every explicit constraint in the user's request and return a useful final " +
    "result rather than only progress. Report only what actually happened, state " +
    "important limitations plainly, and be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools, plus a browser. Browse the way a person would: open the site, read " +
    "the page, use its own search box and links, and scroll when content loads " +
    "as you move down the page, instead of guessing deep URLs. Use tools only " +
    "when the user's request requires acting on the computer. Never run " +
    "commands, browse, or check status for greetings, questions, or simple " +
    "conversation. For tool-backed work, continue until the requested outcome is " +
    "complete or you are genuinely blocked. Treat tool results as evidence: keep " +
    "each fact bound to the exact entity, product, place, or action that supports " +
    "it, and distinguish verified facts from inference and unknowns. Never upgrade " +
    "a lead, search result, or nearby fact into a confirmed claim. Before finishing, " +
    "check every explicit constraint in the user's request and return a useful final " +
    "result rather than only progress. Report only what actually happened, state " +
    "important limitations plainly, and be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools, plus a browser that returns page content after navigation. Use tools " +
    "only when the user's request requires acting on the computer. Never run " +
    "commands, browse, or check status for greetings, questions, or simple " +
    "conversation. For tool-backed work, continue until the requested outcome is " +
    "complete or you are genuinely blocked. Treat tool results as evidence: keep " +
    "each fact bound to the exact entity, product, place, or action that supports " +
    "it, and distinguish verified facts from inference and unknowns. Never upgrade " +
    "a lead, search result, or nearby fact into a confirmed claim. Before finishing, " +
    "check every explicit constraint in the user's request and return a useful final " +
    "result rather than only progress. Report only what actually happened, state " +
    "important limitations plainly, and be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools, plus a browser that returns page content after navigation. Use tools " +
    "only when the user's request requires acting on the computer. Never run " +
    "commands, browse, or check status for greetings, questions, or simple " +
    "conversation. For tool-backed work, continue until the requested outcome is " +
    "complete or you are genuinely blocked. Treat tool results as evidence: keep " +
    "each fact bound to the exact entity, product, place, or action that supports " +
    "it, and distinguish verified facts from inference and unknowns. Never upgrade " +
    "a lead, search result, or nearby fact into a confirmed claim. Before finishing, " +
    "check every explicit constraint in the user's request and return a useful final " +
    "result rather than only progress. Report only what actually happened, state " +
    "important limitations plainly, and be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools, plus a browser that returns page content after navigation. Use tools " +
    "only when the user's request requires acting on the computer. Never run " +
    "commands, browse, or check status for greetings, questions, or simple " +
    "conversation. When a task does require tools, continue until the requested " +
    "outcome is complete or you are genuinely blocked. Treat tool output as " +
    "evidence: inspect the returned content, collect the requested facts, replace " +
    "blocked, irrelevant, or broken sources, and verify explicit constraints such " +
    "as source counts. For multi-source research, do not count search pages, price " +
    "guides, or blocked pages as sellers, and avoid revisiting the same URL unless " +
    "it is necessary. Opening pages is not completion. Before finishing, return " +
    "to the chat and synthesize the useful result, including source names and URLs " +
    "when researching, comparable details, and any important caveats. Never leave " +
    "the user with only progress narration. Report only what actually happened. " +
    "Be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools, plus a browser that returns page content after navigation. Use tools " +
    "only when the user's request requires acting on the computer. Never run " +
    "commands, browse, or check status for greetings, questions, or simple " +
    "conversation. When a task does require tools, continue until the requested " +
    "outcome is complete or you are genuinely blocked. Treat tool output as " +
    "evidence: inspect the returned content, collect the requested facts, replace " +
    "blocked, irrelevant, or broken sources, and verify explicit constraints such " +
    "as source counts. Opening pages is not completion. Before finishing, return " +
    "to the chat and synthesize the useful result, including source names and URLs " +
    "when researching, comparable details, and any important caveats. Never leave " +
    "the user with only progress narration. Report only what actually happened. " +
    "Be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools. Use those tools only when the user's request actually requires " +
    "acting on the computer. Never run commands, browse, or check status for " +
    "greetings, questions, or simple conversational messages, and never preface " +
    "a reply with a tool call. When you do use a tool, report what actually " +
    "happened. Be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant running locally on the user's Mac. Be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools. Prefer running a command over guessing when it would give a real " +
    "answer, and report what actually happened. The computer has no internet " +
    "access yet. Be concise, direct, and practical.",
  "You are OpenBot, a helpful assistant with your own Linux computer: a " +
    "sandboxed microVM you control through the shell, read_file, and write_file " +
    "tools. Use those tools only when the user's request actually requires " +
    "acting on the computer. Never run commands, browse, or check status for " +
    "greetings, questions, or simple conversational messages, and never preface " +
    "a reply with a tool call. When you do use a tool, report what actually " +
    "happened. The computer has no internet access yet. Be concise, direct, and " +
    "practical.",
];

interface BotRow {
  id: string;
  name: string;
  system_prompt: string;
  provider: string;
  model: string;
  effort?: string | null;
  created_at: string;
  kind?: string | null;
  role?: string | null;
  avatar?: string | null;
  color?: string | null;
  computer?: string | null;
  computers?: string | null;
  workspace_id?: string | null;
  access?: string | null;
  delegates?: number | null;
  policy?: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  root: string;
  markers: string | null;
  ignored: number | null;
  settings: string | null;
  created_at: string;
  last_seen_at: string;
}

interface TaskRow {
  id: string;
  lead_id: string;
  role_id: string;
  project_id?: string | null;
  thread_id: string | null;
  parent_id: string | null;
  depth: number;
  title: string;
  brief: string;
  status: string;
  display: string;
  grant: string | null;
  budget: string | null;
  usage: string | null;
  result: string | null;
  evidence: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

interface ThreadRow {
  id: string;
  bot_id: string;
  title: string;
  last_message?: string | null;
  last_compacted_at?: string | null;
  compaction_count?: number;
  cleared_at?: string | null;
  plan?: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  provider: string | null;
  model: string | null;
  tool_calls: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  compaction: string | null;
  folded_at: string | null;
  created_at: string;
}

interface MemoryRow {
  id: string;
  scope: string;
  type: string;
  content: string;
  evidence: string | null;
  confidence: number;
  importance: number;
  status: string;
  source: string;
  embedding: Uint8Array | null;
  embedding_model: string | null;
  embedding_dims: number | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
}

interface ApprovalRow {
  id: string;
  request_id: string;
  run_id: string | null;
  thread_id: string | null;
  bot_id: string | null;
  task_id: string | null;
  project_id: string | null;
  tool: string;
  arguments: string;
  tier: string;
  reason: string;
  decision: string | null;
  decided_by: string | null;
  requested_at: string;
  decided_at: string | null;
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    runId: row.run_id ?? null,
    threadId: row.thread_id ?? null,
    botId: row.bot_id ?? null,
    taskId: row.task_id ?? null,
    projectId: row.project_id ?? null,
    tool: row.tool,
    arguments: row.arguments,
    tier: row.tier as ApprovalTier,
    reason: row.reason,
    decision: row.decision as ApprovalDecision | null,
    decidedBy:
      row.decided_by === "user" ||
      row.decided_by === "timeout" ||
      row.decided_by === "abort"
        ? row.decided_by
        : null,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? null,
  };
}

interface SoulVersionRow {
  id: string;
  bot_id: string;
  version: number;
  content: string;
  summary: string;
  reason: string;
  source: string;
  created_at: string;
}

export interface MemoryRecord extends Memory {
  embedding: Float32Array | null;
  embeddingModel: string | null;
}

function embeddingToBlob(embedding: Float32Array): Buffer {
  return Buffer.from(
    embedding.buffer.slice(
      embedding.byteOffset,
      embedding.byteOffset + embedding.byteLength,
    ),
  );
}

function toMemory(row: MemoryRow): MemoryRecord {
  let evidence: string[] | null = null;
  if (row.evidence) {
    try {
      evidence = JSON.parse(row.evidence) as string[];
    } catch {
      evidence = null;
    }
  }
  let embedding: Float32Array | null = null;
  if (row.embedding && row.embedding_dims) {
    const buffer = Buffer.from(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength,
    );
    embedding = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      row.embedding.byteLength / 4,
    );
  }
  return {
    id: row.id,
    scope: row.scope,
    type: row.type as MemoryType,
    content: row.content,
    evidence,
    confidence: row.confidence,
    importance: row.importance,
    status: row.status as MemoryStatus,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? null,
    useCount: row.use_count,
    embedding,
    embeddingModel: row.embedding_model ?? null,
  };
}

function toSoulVersion(row: SoulVersionRow): SoulVersion {
  let content: SoulContent = {
    voice: "",
    commitments: [],
    relationship: "",
  };
  try {
    content = JSON.parse(row.content) as SoulContent;
  } catch {
    // keep the empty default
  }
  return {
    id: row.id,
    botId: row.bot_id,
    version: row.version,
    content,
    summary: row.summary,
    reason: row.reason,
    source: row.source,
    createdAt: row.created_at,
  };
}

export interface ProviderRecord {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string | null;
  apiKeyEnv: string | null;
  models: string[];
  enabled: boolean;
}

interface ProviderRow {
  id: string;
  label: string;
  base_url: string;
  api_key: string | null;
  api_key_env: string | null;
  models: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toProvider(row: ProviderRow): ProviderRecord {
  let models: string[] = [];
  try {
    models = JSON.parse(row.models) as string[];
  } catch {
    models = [];
  }
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    apiKeyEnv: row.api_key_env,
    models,
    enabled: row.enabled !== 0,
  };
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider"
  );
}

const REASONING_EFFORTS = new Set<string>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
]);

function toEffort(value: string | null | undefined): ReasoningEffort | undefined {
  return value && REASONING_EFFORTS.has(value)
    ? (value as ReasoningEffort)
    : undefined;
}

/**
 * Normalize a computer capability set: valid kinds only, order preserved,
 * duplicates dropped. A missing value takes the fallback; an explicit empty
 * array means a chat-only agent and stays empty (ADR-021).
 */
export function normalizeComputers(
  value: unknown,
  fallback: ComputerKind[] = ["firecracker"],
): ComputerKind[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const seen = new Set<ComputerKind>();
  for (const item of value) {
    if (item === "firecracker" || item === "mac") {
      seen.add(item);
    }
  }
  return [...seen];
}

function computersFor(row: BotRow): ComputerKind[] {
  if (row.computers) {
    try {
      const parsed: unknown = JSON.parse(row.computers);
      if (Array.isArray(parsed)) {
        return normalizeComputers(parsed, []);
      }
    } catch {
      // fall through to the legacy single-computer column
    }
  }
  return normalizeComputers(row.computer ? [row.computer] : null);
}

function toAccess(value: string | null | undefined): AccessMode {
  return value === "home" || value === "full" ? value : "project";
}

function toBot(row: BotRow): Bot {
  const effort = toEffort(row.effort);
  const computers = computersFor(row);
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    model: {
      provider: row.provider,
      model: row.model,
      ...(effort ? { effort } : {}),
    },
    createdAt: row.created_at,
    kind:
      row.kind === "lead"
        ? "lead"
        : row.kind === "project"
          ? "project"
          : "role",
    role: row.role ?? null,
    avatar: row.avatar ?? null,
    color: row.color ?? null,
    computer: computers[0] ?? null,
    computers,
    workspaceId: row.workspace_id ?? null,
    access: toAccess(row.access),
    delegates: (row.delegates ?? 0) !== 0,
    policy: (row.policy as RolePolicy) ?? "inherit",
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  let markers: string[] = [];
  if (row.markers) {
    try {
      const parsed: unknown = JSON.parse(row.markers);
      if (Array.isArray(parsed)) {
        markers = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      markers = [];
    }
  }
  let autoApprove: string[] = [];
  if (row.settings) {
    try {
      const parsed = JSON.parse(row.settings) as { autoApprove?: unknown };
      if (Array.isArray(parsed.autoApprove)) {
        autoApprove = parsed.autoApprove.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      autoApprove = [];
    }
  }
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    markers,
    ignored: (row.ignored ?? 0) !== 0,
    missing: false,
    autoApprove,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toTask(row: TaskRow): Task {
  const parseJson = <T>(value: string | null): T | null => {
    if (!value) {
      return null;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    leadId: row.lead_id,
    roleId: row.role_id,
    projectId: row.project_id ?? null,
    threadId: row.thread_id ?? null,
    parentId: row.parent_id ?? null,
    depth: row.depth ?? 0,
    title: row.title,
    brief: row.brief,
    status: row.status as TaskStatus,
    display: row.display as TaskDisplay,
    grant: parseJson<TaskGrant>(row.grant),
    budget: parseJson<TaskBudget>(row.budget),
    usage: parseJson<TaskUsage>(row.usage),
    result: row.result ?? null,
    evidence: row.evidence ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
  };
}

function isDefaultSystemPrompt(bot: Bot): boolean {
  const identity = bot.role?.trim()
    ? `You are ${bot.name}, the user's ${bot.role.trim()}`
    : `You are ${bot.name}`;
  return [DEFAULT_SYSTEM_PROMPT, ...LEGACY_SYSTEM_PROMPTS].some(
    (variant) =>
      bot.systemPrompt === variant ||
      bot.systemPrompt === variant.replace(/^You are OpenBot/, identity),
  );
}

export function systemPromptForBot(name: string, role: string | null): string {
  const identity = role?.trim()
    ? `You are ${name}, the user's ${role.trim()}`
    : `You are ${name}`;
  return DEFAULT_SYSTEM_PROMPT.replace(/^You are OpenBot/, identity);
}

function toThread(row: ThreadRow): Thread {
  let plan: Thread["plan"] = null;
  if (row.plan) {
    try {
      plan = JSON.parse(row.plan) as Thread["plan"];
    } catch {
      plan = null;
    }
  }
  return {
    id: row.id,
    botId: row.bot_id,
    title: row.title,
    lastMessage: row.last_message ?? null,
    lastCompactedAt: row.last_compacted_at ?? null,
    compactionCount: row.compaction_count ?? 0,
    clearedAt: row.cleared_at ?? null,
    plan,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  let toolCalls: Message["toolCalls"] = null;
  if (row.tool_calls) {
    try {
      const parsed = JSON.parse(row.tool_calls) as Message["toolCalls"];
      toolCalls =
        parsed?.map((call) => ({
          ...call,
          artifacts: call.artifacts ?? null,
          changes: call.changes ?? null,
        })) ?? null;
    } catch {
      toolCalls = null;
    }
  }
  let usage: TokenUsage | null = null;
  if (row.input_tokens !== null || row.output_tokens !== null) {
    usage = {
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      ...(row.cache_read_tokens
        ? { cacheReadTokens: row.cache_read_tokens }
        : {}),
    };
  }
  let compaction: CompactionMeta | null = null;
  if (row.compaction) {
    try {
      compaction = JSON.parse(row.compaction) as CompactionMeta;
    } catch {
      compaction = null;
    }
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as MessageRole,
    content: row.content,
    model:
      row.provider && row.model
        ? { provider: row.provider, model: row.model }
        : null,
    toolCalls,
    usage,
    compaction,
    foldedAt: row.folded_at ?? null,
    createdAt: row.created_at,
  };
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  ensureLeadBot(defaultModel: ModelRef): Bot {
    const bots = this.listBots();
    const existing = bots.find((bot) => bot.kind === "lead");
    if (existing) {
      // Keep the lead's routing contract current across releases without
      // touching a prompt the user genuinely customized.
      if (
        existing.systemPrompt.startsWith("You are the lead:") ||
        isDefaultSystemPrompt(existing)
      ) {
        this.db
          .prepare("UPDATE bots SET system_prompt = ? WHERE id = ?")
          .run(DEFAULT_LEAD_SYSTEM_PROMPT, existing.id);
      }
      // The lead orchestrates work on either side of the fence, so its
      // capability set stays open (ADR-021), and it runs on the user's own
      // machine with full reach (ADR-023).
      if (!LEAD_COMPUTERS.every((kind) => existing.computers.includes(kind))) {
        this.db
          .prepare("UPDATE bots SET computers = ?, computer = ? WHERE id = ?")
          .run(JSON.stringify(LEAD_COMPUTERS), LEAD_PRIMARY, existing.id);
      }
      if (existing.access !== LEAD_ACCESS) {
        this.db
          .prepare("UPDATE bots SET access = ? WHERE id = ?")
          .run(LEAD_ACCESS, existing.id);
      }
      return this.getBot(existing.id)!;
    }
    const candidate = bots[0];
    if (candidate) {
      const systemPrompt = isDefaultSystemPrompt(candidate)
        ? DEFAULT_LEAD_SYSTEM_PROMPT
        : candidate.systemPrompt;
      this.db
        .prepare(
          "UPDATE bots SET kind = 'lead', system_prompt = ?, computers = ?, computer = ?, access = ? WHERE id = ?",
        )
        .run(
          systemPrompt,
          JSON.stringify(LEAD_COMPUTERS),
          LEAD_PRIMARY,
          LEAD_ACCESS,
          candidate.id,
        );
      return this.getBot(candidate.id)!;
    }
    return this.createBot({
      name: DEFAULT_BOT_NAME,
      systemPrompt: DEFAULT_LEAD_SYSTEM_PROMPT,
      model: defaultModel,
      kind: "lead",
      computers: LEAD_COMPUTERS,
      access: LEAD_ACCESS,
    });
  }

  migrateLegacyPrompts(): void {
    for (const bot of this.listBots()) {
      const identity = bot.role?.trim()
        ? `You are ${bot.name}, the user's ${bot.role.trim()}`
        : `You are ${bot.name}`;
      const isLegacy = LEGACY_SYSTEM_PROMPTS.some(
        (legacy) =>
          bot.systemPrompt === legacy ||
          bot.systemPrompt === legacy.replace(/^You are OpenBot/, identity),
      );
      if (isLegacy) {
        this.db
          .prepare("UPDATE bots SET system_prompt = ? WHERE id = ?")
          .run(systemPromptForBot(bot.name, bot.role ?? null), bot.id);
      }
    }
  }

  createBot(input: {
    name: string;
    systemPrompt: string;
    model: ModelRef;
    kind?: BotKind;
    role?: string | null;
    avatar?: string | null;
    color?: string | null;
    computer?: string | null;
    computers?: ComputerKind[];
    workspaceId?: string | null;
    access?: AccessMode;
    delegates?: boolean;
    policy?: RolePolicy;
  }): Bot {
    const computers: ComputerKind[] =
      input.computers !== undefined
        ? normalizeComputers(input.computers, [])
        : input.computer
          ? normalizeComputers([input.computer], ["firecracker"])
          : ["firecracker"];
    const bot: Bot = {
      id: randomUUID(),
      name: input.name,
      systemPrompt: input.systemPrompt,
      model: input.model,
      createdAt: new Date().toISOString(),
      kind: input.kind ?? "role",
      role: input.role ?? null,
      avatar: input.avatar ?? null,
      color: input.color ?? null,
      computer: computers[0] ?? null,
      computers,
      workspaceId: input.workspaceId ?? null,
      access: input.access ?? "project",
      delegates: input.delegates ?? false,
      policy: input.policy ?? "inherit",
    };
    this.db
      .prepare(
        "INSERT INTO bots (id, name, system_prompt, provider, model, effort, created_at, kind, role, avatar, color, computer, computers, workspace_id, access, delegates, policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        bot.id,
        bot.name,
        bot.systemPrompt,
        bot.model.provider,
        bot.model.model,
        bot.model.effort ?? null,
        bot.createdAt,
        bot.kind,
        bot.role ?? null,
        bot.avatar ?? null,
        bot.color ?? null,
        bot.computer ?? null,
        JSON.stringify(bot.computers),
        bot.workspaceId ?? null,
        bot.access,
        bot.delegates ? 1 : 0,
        bot.policy,
      );
    return bot;
  }

  updateBot(
    id: string,
    patch: {
      name?: string;
      role?: string | null;
      avatar?: string | null;
      color?: string | null;
      computer?: string | null;
      computers?: ComputerKind[];
      workspaceId?: string | null;
      access?: AccessMode;
      delegates?: boolean;
      policy?: RolePolicy;
      model?: ModelRef;
    },
  ): Bot | null {
    const existing = this.getBot(id);
    if (!existing) {
      return null;
    }
    const fields: Array<[string, string | number | null]> = [];
    if (patch.name !== undefined) fields.push(["name", patch.name]);
    if (patch.role !== undefined) fields.push(["role", patch.role]);
    if (patch.avatar !== undefined) fields.push(["avatar", patch.avatar]);
    if (patch.color !== undefined) fields.push(["color", patch.color]);
    if (patch.computers !== undefined || patch.computer !== undefined) {
      const computers =
        patch.computers !== undefined
          ? normalizeComputers(patch.computers, [])
          : patch.computer
            ? normalizeComputers([patch.computer], ["firecracker"])
            : ["firecracker"];
      fields.push(["computers", JSON.stringify(computers)]);
      fields.push(["computer", computers[0] ?? null]);
    }
    if (patch.workspaceId !== undefined) {
      fields.push(["workspace_id", patch.workspaceId]);
    }
    if (patch.access !== undefined) {
      fields.push(["access", patch.access]);
    }
    if (patch.delegates !== undefined) {
      fields.push(["delegates", patch.delegates ? 1 : 0]);
    }
    if (patch.policy !== undefined) {
      fields.push(["policy", patch.policy]);
    }
    if (patch.model !== undefined) {
      fields.push(["provider", patch.model.provider]);
      fields.push(["model", patch.model.model]);
      fields.push(["effort", patch.model.effort ?? null]);
    }
    for (const [column, value] of fields) {
      this.db
        .prepare(`UPDATE bots SET ${column} = ? WHERE id = ?`)
        .run(value, id);
    }
    return this.getBot(id);
  }

  deleteBot(id: string): boolean {
    if (!this.getBot(id)) {
      return false;
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(id);
      this.deleteThreadsForBot(id);
      this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces ORDER BY name COLLATE NOCASE ASC")
      .all() as unknown as WorkspaceRow[];
    return rows.map(toWorkspace);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id) as unknown as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  getWorkspaceByRoot(root: string): Workspace | null {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE root = ?")
      .get(root) as unknown as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  createWorkspace(input: {
    name: string;
    root: string;
    markers?: string[];
    ignored?: boolean;
    autoApprove?: string[];
  }): Workspace {
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID(),
      name: input.name,
      root: input.root,
      markers: input.markers ?? [],
      ignored: input.ignored ?? false,
      missing: false,
      autoApprove: input.autoApprove ?? [],
      createdAt: now,
      lastSeenAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO workspaces (id, name, root, markers, ignored, settings, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        workspace.id,
        workspace.name,
        workspace.root,
        JSON.stringify(workspace.markers),
        workspace.ignored ? 1 : 0,
        JSON.stringify({ autoApprove: workspace.autoApprove }),
        workspace.createdAt,
        workspace.lastSeenAt,
      );
    return workspace;
  }

  updateWorkspace(
    id: string,
    patch: {
      name?: string;
      markers?: string[];
      ignored?: boolean;
      autoApprove?: string[];
      lastSeenAt?: string;
    },
  ): Workspace | null {
    const existing = this.getWorkspace(id);
    if (!existing) {
      return null;
    }
    const fields: Array<[string, string | number]> = [];
    if (patch.name !== undefined) fields.push(["name", patch.name]);
    if (patch.markers !== undefined) {
      fields.push(["markers", JSON.stringify(patch.markers)]);
    }
    if (patch.ignored !== undefined) {
      fields.push(["ignored", patch.ignored ? 1 : 0]);
    }
    if (patch.autoApprove !== undefined) {
      fields.push([
        "settings",
        JSON.stringify({ autoApprove: patch.autoApprove }),
      ]);
    }
    if (patch.lastSeenAt !== undefined) {
      fields.push(["last_seen_at", patch.lastSeenAt]);
    }
    for (const [column, value] of fields) {
      this.db
        .prepare(`UPDATE workspaces SET ${column} = ? WHERE id = ?`)
        .run(value, id);
    }
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): boolean {
    if (!this.getWorkspace(id)) {
      return false;
    }
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE bots SET workspace_id = NULL WHERE workspace_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  listBotsForWorkspace(workspaceId: string): Bot[] {
    return this.listBots().filter((bot) => bot.workspaceId === workspaceId);
  }

  resetBot(id: string): boolean {
    if (!this.getBot(id)) {
      return false;
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM tasks WHERE role_id = ?").run(id);
      this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(id);
      this.deleteThreadsForBot(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  private deleteThreadsForBot(id: string): void {
    this.db
      .prepare(
        "DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)",
      )
      .run(id);
    this.db.prepare("DELETE FROM threads WHERE bot_id = ?").run(id);
  }

  listBots(): Bot[] {
    const rows = this.db
      .prepare("SELECT * FROM bots ORDER BY created_at ASC")
      .all() as unknown as BotRow[];
    return rows.map(toBot);
  }

  getBot(id: string): Bot | null {
    const row = this.db
      .prepare("SELECT * FROM bots WHERE id = ?")
      .get(id) as unknown as BotRow | undefined;
    return row ? toBot(row) : null;
  }

  createThread(botId: string, title = DEFAULT_THREAD_TITLE): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: randomUUID(),
      botId,
      title,
      lastMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO threads (id, bot_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        thread.id,
        thread.botId,
        thread.title,
        thread.createdAt,
        thread.updatedAt,
      );
    return thread;
  }

  listThreads(): Thread[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, (
           SELECT m.content FROM messages m
           WHERE m.thread_id = t.id AND m.folded_at IS NULL
           ORDER BY m.created_at DESC,
             CASE WHEN m.compaction IS NULL THEN 0 ELSE 1 END ASC,
             m.rowid DESC
           LIMIT 1
         ) AS last_message
         FROM threads t
         ORDER BY t.updated_at DESC`,
      )
      .all() as unknown as ThreadRow[];
    return rows.map(toThread);
  }

  getThread(id: string): Thread | null {
    const row = this.db
      .prepare(
        `SELECT t.*, (
           SELECT m.content FROM messages m
           WHERE m.thread_id = t.id AND m.folded_at IS NULL
           ORDER BY m.created_at DESC,
             CASE WHEN m.compaction IS NULL THEN 0 ELSE 1 END ASC,
             m.rowid DESC
           LIMIT 1
         ) AS last_message
         FROM threads t
         WHERE t.id = ?`,
      )
      .get(id) as unknown as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  getOrCreateThread(botId: string): Thread {
    const row = this.db
      .prepare(
        "SELECT * FROM threads WHERE bot_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(botId) as unknown as ThreadRow | undefined;
    return row ? toThread(row) : this.createThread(botId);
  }

  touchThread(id: string, patch: { title?: string } = {}): Thread | null {
    const now = new Date().toISOString();
    if (patch.title !== undefined) {
      this.db
        .prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?")
        .run(patch.title, now, id);
    } else {
      this.db
        .prepare("UPDATE threads SET updated_at = ? WHERE id = ?")
        .run(now, id);
    }
    return this.getThread(id);
  }

  /** Replace the thread's working plan (null clears it). */
  setThreadPlan(id: string, plan: PlanStep[] | null): Thread | null {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE threads SET plan = ?, updated_at = ? WHERE id = ?")
      .run(plan && plan.length ? JSON.stringify(plan) : null, now, id);
    return this.getThread(id);
  }

  markCompacted(id: string): Thread | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE threads SET last_compacted_at = ?, compaction_count = compaction_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
    return this.getThread(id);
  }

  /**
   * Start the thread over without losing anything: every current message is
   * folded away (the model context and the transcript view are built from
   * unfolded messages only), the working plan is dropped, and the title resets
   * so the next user message names the new stretch of conversation. Returns
   * null when there is nothing to clear.
   */
  clearThread(id: string): Thread | null {
    const thread = this.getThread(id);
    if (!thread) {
      return null;
    }
    const unfolded = this.listMessages(id);
    if (unfolded.length === 0) {
      return null;
    }
    this.foldMessages(
      id,
      unfolded.map((message) => message.id),
    );
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE threads SET title = ?, plan = NULL, cleared_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(DEFAULT_THREAD_TITLE, now, now, id);
    return this.getThread(id);
  }

  addMessage(input: {
    id?: string;
    threadId: string;
    role: MessageRole;
    content: string;
    model: ModelRef | null;
    toolCalls?: ToolCallRecord[] | null;
    usage?: TokenUsage | null;
    compaction?: CompactionMeta | null;
    foldedAt?: string | null;
    createdAt?: string;
  }): Message {
    const message: Message = {
      id: input.id ?? randomUUID(),
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      model: input.model,
      toolCalls: input.toolCalls ?? null,
      usage: input.usage ?? null,
      compaction: input.compaction ?? null,
      foldedAt: input.foldedAt ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, provider, model, tool_calls, input_tokens, output_tokens, cache_read_tokens, compaction, folded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        message.id,
        message.threadId,
        message.role,
        message.content,
        message.model?.provider ?? null,
        message.model?.model ?? null,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.usage?.inputTokens ?? null,
        message.usage?.outputTokens ?? null,
        message.usage?.cacheReadTokens ?? null,
        message.compaction ? JSON.stringify(message.compaction) : null,
        message.foldedAt ?? null,
        message.createdAt,
      );
    return message;
  }

  listMessages(
    threadId: string,
    options: { includeFolded?: boolean } = {},
  ): Message[] {
    const foldedClause = options.includeFolded ? "" : " AND folded_at IS NULL";
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE thread_id = ?${foldedClause}
         ORDER BY created_at ASC,
           CASE WHEN compaction IS NULL THEN 1 ELSE 0 END ASC,
           rowid ASC`,
      )
      .all(threadId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  foldMessages(threadId: string, ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const foldedAt = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE messages SET folded_at = ? WHERE thread_id = ? AND id IN (${placeholders})`,
      )
      .run(foldedAt, threadId, ...ids);
  }

  createTask(input: {
    leadId: string;
    roleId: string;
    title: string;
    brief: string;
    projectId?: string | null;
    threadId?: string | null;
    parentId?: string | null;
    depth?: number;
    display?: TaskDisplay;
    grant?: TaskGrant | null;
    budget?: TaskBudget | null;
  }): Task {
    const thread = input.threadId
      ? (this.getThread(input.threadId) ??
        this.createThread(input.roleId, input.title))
      : this.createThread(input.roleId, input.title);
    const task: Task = {
      id: randomUUID(),
      leadId: input.leadId,
      roleId: input.roleId,
      projectId: input.projectId ?? null,
      threadId: thread.id,
      parentId: input.parentId ?? null,
      depth: input.depth ?? 0,
      title: input.title,
      brief: input.brief,
      status: "queued",
      display: input.display ?? "none",
      grant: input.grant ?? null,
      budget: input.budget ?? null,
      usage: null,
      result: null,
      evidence: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO tasks (id, lead_id, role_id, project_id, thread_id, parent_id, depth, title, brief, status, display, grant, budget, usage, result, evidence, error, created_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        task.id,
        task.leadId,
        task.roleId,
        task.projectId ?? null,
        task.threadId,
        task.parentId,
        task.depth,
        task.title,
        task.brief,
        task.status,
        task.display,
        task.grant ? JSON.stringify(task.grant) : null,
        task.budget ? JSON.stringify(task.budget) : null,
        task.usage ? JSON.stringify(task.usage) : null,
        task.result,
        task.evidence,
        task.error,
        task.createdAt,
        task.startedAt,
        task.endedAt,
      );
    return task;
  }

  updateTask(
    id: string,
    patch: {
      status?: TaskStatus;
      result?: string | null;
      evidence?: string | null;
      error?: string | null;
      usage?: TaskUsage | null;
      startedAt?: string | null;
      endedAt?: string | null;
    },
  ): Task | null {
    if (!this.getTask(id)) {
      return null;
    }
    const fields: Array<[string, string | null]> = [];
    if (patch.status !== undefined) fields.push(["status", patch.status]);
    if (patch.result !== undefined) fields.push(["result", patch.result]);
    if (patch.evidence !== undefined) fields.push(["evidence", patch.evidence]);
    if (patch.error !== undefined) fields.push(["error", patch.error]);
    if (patch.usage !== undefined)
      fields.push(["usage", patch.usage ? JSON.stringify(patch.usage) : null]);
    if (patch.startedAt !== undefined)
      fields.push(["started_at", patch.startedAt]);
    if (patch.endedAt !== undefined) fields.push(["ended_at", patch.endedAt]);
    for (const [column, value] of fields) {
      this.db
        .prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`)
        .run(value, id);
    }
    return this.getTask(id);
  }

  getTask(id: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as unknown as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listTasks(limit = 100): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  listTasksForRole(roleId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE role_id = ? ORDER BY created_at DESC")
      .all(roleId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  activeTaskForRole(roleId: string): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE role_id = ? AND status IN ('queued', 'running') ORDER BY created_at ASC LIMIT 1",
      )
      .get(roleId) as unknown as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listChildTasks(parentId: string): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC",
      )
      .all(parentId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  countActiveChildren(parentId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM tasks WHERE parent_id = ? AND status IN ('queued', 'running')",
      )
      .get(parentId) as unknown as { count: number } | undefined;
    return row?.count ?? 0;
  }

  nextQueuedTaskForRole(roleId: string): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE role_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1",
      )
      .get(roleId) as unknown as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  nextQueuedTask(): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
      )
      .get() as unknown as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listQueuedTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC",
      )
      .all() as unknown as TaskRow[];
    return rows.map(toTask);
  }

  listTasksForProject(projectId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  activeRequestForProject(projectId: string): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND role_id = project_id AND status IN ('queued', 'running') ORDER BY created_at ASC LIMIT 1",
      )
      .get(projectId) as unknown as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listProviders(): ProviderRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM providers ORDER BY created_at ASC")
      .all() as unknown as ProviderRow[];
    return rows.map(toProvider);
  }

  getProvider(id: string): ProviderRecord | null {
    const row = this.db
      .prepare("SELECT * FROM providers WHERE id = ?")
      .get(id) as unknown as ProviderRow | undefined;
    return row ? toProvider(row) : null;
  }

  upsertProvider(input: {
    id?: string;
    label: string;
    baseUrl: string;
    apiKey?: string | null;
    apiKeyEnv?: string | null;
    models: string[];
    enabled?: boolean;
  }): ProviderRecord {
    const existing = input.id ? this.getProvider(input.id) : null;
    const now = new Date().toISOString();
    const id = existing?.id ?? input.id ?? this.uniqueProviderId(slugify(input.label));

    let apiKey: string | null;
    if (input.apiKey === undefined) {
      apiKey = existing?.apiKey ?? null;
    } else if (!input.apiKey) {
      apiKey = null;
    } else {
      apiKey = input.apiKey;
    }

    const apiKeyEnv =
      input.apiKeyEnv === undefined
        ? (existing?.apiKeyEnv ?? null)
        : input.apiKeyEnv || null;

    const models = input.models;
    const enabled = input.enabled ?? existing?.enabled ?? true;

    if (existing) {
      this.db
        .prepare(
          "UPDATE providers SET label = ?, base_url = ?, api_key = ?, api_key_env = ?, models = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          input.label,
          input.baseUrl,
          apiKey,
          apiKeyEnv,
          JSON.stringify(models),
          enabled ? 1 : 0,
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          "INSERT INTO providers (id, label, base_url, api_key, api_key_env, models, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.label,
          input.baseUrl,
          apiKey,
          apiKeyEnv,
          JSON.stringify(models),
          enabled ? 1 : 0,
          now,
          now,
        );
    }

    return this.getProvider(id)!;
  }

  removeProvider(id: string): void {
    this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  }

  seedProviders(
    definitions: Array<{
      id: string;
      label: string;
      baseUrl: string;
      apiKey?: string | null;
      apiKeyEnv?: string | null;
      models: string[];
    }>,
  ): void {
    if (this.listProviders().length > 0) {
      return;
    }
    for (const definition of definitions) {
      this.upsertProvider(definition);
    }
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  createMemory(input: {
    id?: string;
    scope: string;
    type: MemoryType;
    content: string;
    evidence?: string[] | null;
    confidence?: number;
    importance?: number;
    status?: MemoryStatus;
    source: string;
    embedding?: Float32Array | null;
    embeddingModel?: string | null;
    createdAt?: string;
    updatedAt?: string;
    lastUsedAt?: string | null;
    useCount?: number;
  }): MemoryRecord {
    const now = new Date().toISOString();
    const memory: MemoryRecord = {
      id: input.id ?? randomUUID(),
      scope: input.scope,
      type: input.type,
      content: input.content,
      evidence: input.evidence ?? null,
      confidence: input.confidence ?? 0.8,
      importance: input.importance ?? 0.5,
      status: input.status ?? "active",
      source: input.source,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      lastUsedAt: input.lastUsedAt ?? null,
      useCount: input.useCount ?? 0,
      embedding: input.embedding ?? null,
      embeddingModel: input.embeddingModel ?? null,
    };
    this.db
      .prepare(
        "INSERT INTO memories (id, scope, type, content, evidence, confidence, importance, status, source, embedding, embedding_model, embedding_dims, created_at, updated_at, last_used_at, use_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        memory.id,
        memory.scope,
        memory.type,
        memory.content,
        memory.evidence ? JSON.stringify(memory.evidence) : null,
        memory.confidence,
        memory.importance,
        memory.status,
        memory.source,
        memory.embedding ? embeddingToBlob(memory.embedding) : null,
        memory.embeddingModel,
        memory.embedding?.length ?? null,
        memory.createdAt,
        memory.updatedAt,
        memory.lastUsedAt ?? null,
        memory.useCount,
      );
    this.db
      .prepare("INSERT INTO memories_fts (memory_id, content) VALUES (?, ?)")
      .run(memory.id, memory.content);
    return memory;
  }

  updateMemory(
    id: string,
    patch: {
      content?: string;
      evidence?: string[] | null;
      confidence?: number;
      importance?: number;
      status?: MemoryStatus;
      embedding?: Float32Array | null;
      embeddingModel?: string | null;
      updatedAt?: string;
      lastUsedAt?: string | null;
      useCount?: number;
    },
  ): MemoryRecord | null {
    const existing = this.getMemory(id);
    if (!existing) {
      return null;
    }
    const fields: Array<[string, string | number | Buffer | null]> = [];
    if (patch.content !== undefined) fields.push(["content", patch.content]);
    if (patch.evidence !== undefined) {
      fields.push([
        "evidence",
        patch.evidence ? JSON.stringify(patch.evidence) : null,
      ]);
    }
    if (patch.confidence !== undefined)
      fields.push(["confidence", patch.confidence]);
    if (patch.importance !== undefined)
      fields.push(["importance", patch.importance]);
    if (patch.status !== undefined) fields.push(["status", patch.status]);
    if (patch.updatedAt !== undefined)
      fields.push(["updated_at", patch.updatedAt]);
    if (patch.lastUsedAt !== undefined)
      fields.push(["last_used_at", patch.lastUsedAt]);
    if (patch.useCount !== undefined) fields.push(["use_count", patch.useCount]);
    if (patch.embedding !== undefined) {
      fields.push([
        "embedding",
        patch.embedding ? embeddingToBlob(patch.embedding) : null,
      ]);
      fields.push(["embedding_dims", patch.embedding?.length ?? null]);
      fields.push(["embedding_model", patch.embeddingModel ?? null]);
    } else if (patch.embeddingModel !== undefined) {
      fields.push(["embedding_model", patch.embeddingModel]);
    }
    for (const [column, value] of fields) {
      this.db
        .prepare(`UPDATE memories SET ${column} = ? WHERE id = ?`)
        .run(value, id);
    }
    if (patch.content !== undefined) {
      this.db
        .prepare("DELETE FROM memories_fts WHERE memory_id = ?")
        .run(id);
      this.db
        .prepare("INSERT INTO memories_fts (memory_id, content) VALUES (?, ?)")
        .run(id, patch.content);
    }
    return this.getMemory(id);
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as unknown as MemoryRow | undefined;
    return row ? toMemory(row) : null;
  }

  listMemories(
    options: { scope?: string; status?: MemoryStatus; limit?: number } = {},
  ): MemoryRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.scope) {
      clauses.push("scope = ?");
      params.push(options.scope);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, options.limit ?? 500) as unknown as MemoryRow[];
    return rows.map(toMemory);
  }

  searchMemoriesFts(
    query: string,
    options: { scope?: string; status?: MemoryStatus; limit?: number } = {},
  ): Array<{ id: string; score: number }> {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1)
      .slice(0, 12);
    if (tokens.length === 0) {
      return [];
    }
    const match = tokens.map((token) => `"${token}"`).join(" OR ");
    const clauses = ["memories_fts MATCH ?"];
    const params: Array<string | number> = [match];
    if (options.scope) {
      clauses.push("m.scope = ?");
      params.push(options.scope);
    }
    if (options.status) {
      clauses.push("m.status = ?");
      params.push(options.status);
    }
    const rows = this.db
      .prepare(
        `SELECT memories_fts.memory_id AS id, bm25(memories_fts) AS rank
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.memory_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(...params, options.limit ?? 50) as unknown as Array<{
      id: string;
      rank: number;
    }>;
    return rows.map((row) => ({ id: row.id, score: -row.rank }));
  }

  deleteMemory(id: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
    return Number(result.changes) > 0;
  }

  touchMemories(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    for (const id of ids) {
      this.db
        .prepare(
          "UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
        )
        .run(now, id);
    }
  }

  addSoulVersion(input: {
    botId: string;
    content: SoulContent;
    summary: string;
    reason: string;
    source: string;
  }): SoulVersion {
    const current = this.currentSoulVersion(input.botId);
    const version = (current?.version ?? 0) + 1;
    const record: SoulVersion = {
      id: randomUUID(),
      botId: input.botId,
      version,
      content: input.content,
      summary: input.summary,
      reason: input.reason,
      source: input.source,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO soul_versions (id, bot_id, version, content, summary, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.botId,
        record.version,
        JSON.stringify(record.content),
        record.summary,
        record.reason,
        record.source,
        record.createdAt,
      );
    return record;
  }

  listSoulVersions(botId: string): SoulVersion[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM soul_versions WHERE bot_id = ? ORDER BY version DESC",
      )
      .all(botId) as unknown as SoulVersionRow[];
    return rows.map(toSoulVersion);
  }

  currentSoulVersion(botId: string): SoulVersion | null {
    const row = this.db
      .prepare(
        "SELECT * FROM soul_versions WHERE bot_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(botId) as unknown as SoulVersionRow | undefined;
    return row ? toSoulVersion(row) : null;
  }

  getSoulVersion(id: string): SoulVersion | null {
    const row = this.db
      .prepare("SELECT * FROM soul_versions WHERE id = ?")
      .get(id) as unknown as SoulVersionRow | undefined;
    return row ? toSoulVersion(row) : null;
  }

  createApproval(input: {
    requestId: string;
    runId?: string | null;
    threadId?: string | null;
    botId?: string | null;
    taskId?: string | null;
    projectId?: string | null;
    tool: string;
    arguments: string;
    tier: string;
    reason: string;
  }): ApprovalRecord {
    const record: ApprovalRecord = {
      id: randomUUID(),
      requestId: input.requestId,
      runId: input.runId ?? null,
      threadId: input.threadId ?? null,
      botId: input.botId ?? null,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      tool: input.tool,
      arguments: input.arguments,
      tier: input.tier as ApprovalTier,
      reason: input.reason,
      decision: null,
      decidedBy: null,
      requestedAt: new Date().toISOString(),
      decidedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO approvals (id, request_id, run_id, thread_id, bot_id, task_id, project_id, tool, arguments, tier, reason, decision, decided_by, requested_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.requestId,
        record.runId,
        record.threadId,
        record.botId,
        record.taskId,
        record.projectId,
        record.tool,
        record.arguments,
        record.tier,
        record.reason,
        null,
        null,
        record.requestedAt,
        null,
      );
    return record;
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    decidedBy: string,
  ): ApprovalRecord | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ? WHERE request_id = ? AND decision IS NULL",
      )
      .run(decision, decidedBy, now, requestId);
    const row = this.db
      .prepare(
        "SELECT * FROM approvals WHERE request_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get(requestId) as unknown as ApprovalRow | undefined;
    return row ? toApproval(row) : null;
  }

  listApprovals(limit = 100): ApprovalRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals ORDER BY requested_at DESC LIMIT ?",
      )
      .all(limit) as unknown as ApprovalRow[];
    return rows.map(toApproval);
  }

  listPendingApprovals(): ApprovalRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals WHERE decision IS NULL ORDER BY requested_at ASC",
      )
      .all() as unknown as ApprovalRow[];
    return rows.map(toApproval);
  }

  private uniqueProviderId(base: string): string {
    let candidate = base;
    let suffix = 2;
    while (this.getProvider(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}
