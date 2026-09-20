import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDir, "openbot.db");
  const db = new DatabaseSync(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // best effort on filesystems without POSIX permissions
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id),
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(thread_id, created_at);

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      api_key_env TEXT,
      models TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      project_id TEXT,
      thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      depth INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      status TEXT NOT NULL,
      display TEXT NOT NULL DEFAULT 'none',
      grant TEXT,
      budget TEXT,
      usage TEXT,
      result TEXT,
      evidence TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_role
      ON tasks(role_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_lead
      ON tasks(lead_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      evidence TEXT,
      confidence REAL NOT NULL DEFAULT 0.8,
      importance REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT,
      embedding_dims INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_memories_scope
      ON memories(scope, status, updated_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(memory_id UNINDEXED, content);

    CREATE TABLE IF NOT EXISTS soul_versions (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_soul_versions_bot
      ON soul_versions(bot_id, version);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      run_id TEXT,
      thread_id TEXT,
      bot_id TEXT,
      task_id TEXT,
      project_id TEXT,
      tool TEXT NOT NULL,
      arguments TEXT NOT NULL,
      tier TEXT NOT NULL,
      reason TEXT NOT NULL,
      decision TEXT,
      decided_by TEXT,
      requested_at TEXT NOT NULL,
      decided_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_request
      ON approvals(request_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_time
      ON approvals(requested_at);
  `);

  const columns = db
    .prepare("PRAGMA table_info(messages)")
    .all() as unknown as Array<{ name: string }>;
  const messageColumns = new Set(columns.map((column) => column.name));
  if (!messageColumns.has("tool_calls")) {
    db.exec("ALTER TABLE messages ADD COLUMN tool_calls TEXT");
  }
  if (!messageColumns.has("input_tokens")) {
    db.exec("ALTER TABLE messages ADD COLUMN input_tokens INTEGER");
  }
  if (!messageColumns.has("output_tokens")) {
    db.exec("ALTER TABLE messages ADD COLUMN output_tokens INTEGER");
  }
  if (!messageColumns.has("cache_read_tokens")) {
    db.exec("ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER");
  }
  if (!messageColumns.has("compaction")) {
    db.exec("ALTER TABLE messages ADD COLUMN compaction TEXT");
  }
  if (!messageColumns.has("folded_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN folded_at TEXT");
  }

  const threadColumns = db
    .prepare("PRAGMA table_info(threads)")
    .all() as unknown as Array<{ name: string }>;
  const threadColumnNames = new Set(threadColumns.map((column) => column.name));
  if (!threadColumnNames.has("last_compacted_at")) {
    db.exec("ALTER TABLE threads ADD COLUMN last_compacted_at TEXT");
  }
  if (!threadColumnNames.has("compaction_count")) {
    db.exec(
      "ALTER TABLE threads ADD COLUMN compaction_count INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!threadColumnNames.has("plan")) {
    db.exec("ALTER TABLE threads ADD COLUMN plan TEXT");
  }
  if (!threadColumnNames.has("cleared_at")) {
    db.exec("ALTER TABLE threads ADD COLUMN cleared_at TEXT");
  }

  const providerColumns = db
    .prepare("PRAGMA table_info(providers)")
    .all() as unknown as Array<{ name: string }>;
  if (!providerColumns.some((column) => column.name === "enabled")) {
    db.exec("ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  }

  const botColumns = db
    .prepare("PRAGMA table_info(bots)")
    .all() as unknown as Array<{ name: string }>;
  const botColumnNames = new Set(botColumns.map((column) => column.name));
  if (!botColumnNames.has("role")) {
    db.exec("ALTER TABLE bots ADD COLUMN role TEXT");
  }
  if (!botColumnNames.has("avatar")) {
    db.exec("ALTER TABLE bots ADD COLUMN avatar TEXT");
  }
  if (!botColumnNames.has("color")) {
    db.exec("ALTER TABLE bots ADD COLUMN color TEXT");
  }
  if (!botColumnNames.has("computer")) {
    db.exec("ALTER TABLE bots ADD COLUMN computer TEXT");
  }
  if (!botColumnNames.has("computers")) {
    db.exec("ALTER TABLE bots ADD COLUMN computers TEXT");
  }
  if (!botColumnNames.has("kind")) {
    db.exec("ALTER TABLE bots ADD COLUMN kind TEXT NOT NULL DEFAULT 'role'");
  }
  if (!botColumnNames.has("delegates")) {
    db.exec("ALTER TABLE bots ADD COLUMN delegates INTEGER NOT NULL DEFAULT 0");
  }
  if (!botColumnNames.has("policy")) {
    db.exec("ALTER TABLE bots ADD COLUMN policy TEXT NOT NULL DEFAULT 'inherit'");
  }
  if (!botColumnNames.has("effort")) {
    db.exec("ALTER TABLE bots ADD COLUMN effort TEXT");
  }

  const taskColumns = db
    .prepare("PRAGMA table_info(tasks)")
    .all() as unknown as Array<{ name: string }>;
  const taskColumnNames = new Set(taskColumns.map((column) => column.name));
  if (!taskColumnNames.has("parent_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN parent_id TEXT");
  }
  if (!taskColumnNames.has("depth")) {
    db.exec("ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
  }
  if (!taskColumnNames.has("usage")) {
    db.exec("ALTER TABLE tasks ADD COLUMN usage TEXT");
  }
  if (!taskColumnNames.has("project_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT");
  }

  return db;
}
