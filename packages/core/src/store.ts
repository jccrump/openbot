import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Bot,
  CompactionMeta,
  Message,
  MessageRole,
  ModelRef,
  Thread,
  TokenUsage,
  ToolCallRecord,
} from "@openbot/protocol";

export const DEFAULT_BOT_NAME = "Assistant";
export const DEFAULT_THREAD_TITLE = "New chat";
export const DEFAULT_SYSTEM_PROMPT =
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
  "important limitations plainly, and be concise, direct, and practical.";

const LEGACY_SYSTEM_PROMPTS = [
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
  created_at: string;
  role?: string | null;
  avatar?: string | null;
  color?: string | null;
  computer?: string | null;
}

interface ThreadRow {
  id: string;
  bot_id: string;
  title: string;
  last_message?: string | null;
  last_compacted_at?: string | null;
  compaction_count?: number;
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
  compaction: string | null;
  folded_at: string | null;
  created_at: string;
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

function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    model: { provider: row.provider, model: row.model },
    createdAt: row.created_at,
    role: row.role ?? null,
    avatar: row.avatar ?? null,
    color: row.color ?? null,
    computer: row.computer ?? null,
  };
}

export function systemPromptForBot(name: string, role: string | null): string {
  const identity = role?.trim()
    ? `You are ${name}, the user's ${role.trim()}`
    : `You are ${name}`;
  return DEFAULT_SYSTEM_PROMPT.replace(/^You are OpenBot/, identity);
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    botId: row.bot_id,
    title: row.title,
    lastMessage: row.last_message ?? null,
    lastCompactedAt: row.last_compacted_at ?? null,
    compactionCount: row.compaction_count ?? 0,
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

  ensureDefaultBot(defaultModel: ModelRef): Bot {
    const existing = this.listBots();
    if (existing.length > 0) {
      return existing[0]!;
    }
    return this.createBot({
      name: DEFAULT_BOT_NAME,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      model: defaultModel,
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
    role?: string | null;
    avatar?: string | null;
    color?: string | null;
    computer?: string | null;
  }): Bot {
    const bot: Bot = {
      id: randomUUID(),
      name: input.name,
      systemPrompt: input.systemPrompt,
      model: input.model,
      createdAt: new Date().toISOString(),
      role: input.role ?? null,
      avatar: input.avatar ?? null,
      color: input.color ?? null,
      computer: input.computer ?? null,
    };
    this.db
      .prepare(
        "INSERT INTO bots (id, name, system_prompt, provider, model, created_at, role, avatar, color, computer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        bot.id,
        bot.name,
        bot.systemPrompt,
        bot.model.provider,
        bot.model.model,
        bot.createdAt,
        bot.role ?? null,
        bot.avatar ?? null,
        bot.color ?? null,
        bot.computer ?? null,
      );
    return bot;
  }

  updateBot(id: string, patch: { computer?: string | null }): Bot | null {
    const existing = this.getBot(id);
    if (!existing) {
      return null;
    }
    if (patch.computer !== undefined) {
      this.db
        .prepare("UPDATE bots SET computer = ? WHERE id = ?")
        .run(patch.computer, id);
    }
    return this.getBot(id);
  }

  deleteBot(id: string): boolean {
    if (!this.getBot(id)) {
      return false;
    }
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM threads WHERE bot_id = ?").run(id);
      this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
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

  markCompacted(id: string): Thread | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE threads SET last_compacted_at = ?, compaction_count = compaction_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
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
        "INSERT INTO messages (id, thread_id, role, content, provider, model, tool_calls, input_tokens, output_tokens, compaction, folded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
