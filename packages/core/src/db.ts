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

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      markers TEXT NOT NULL DEFAULT '[]',
      ignored INTEGER NOT NULL DEFAULT 0,
      settings TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_root
      ON workspaces(root);

    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brief TEXT NOT NULL,
      computer TEXT NOT NULL,
      schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'hold',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_routines_bot
      ON routines(bot_id);
    CREATE INDEX IF NOT EXISTS idx_routines_due
      ON routines(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
      ON routine_runs(routine_id, started_at);

    CREATE INDEX IF NOT EXISTS idx_todos_bot
      ON todos(bot_id, position);
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
  if (!messageColumns.has("routine")) {
    db.exec("ALTER TABLE messages ADD COLUMN routine TEXT");
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
  if (!botColumnNames.has("workspace_id")) {
    db.exec("ALTER TABLE bots ADD COLUMN workspace_id TEXT");
  }
  if (!botColumnNames.has("access")) {
    db.exec("ALTER TABLE bots ADD COLUMN access TEXT NOT NULL DEFAULT 'project'");
  }

  const workspaceColumns = db
    .prepare("PRAGMA table_info(workspaces)")
    .all() as unknown as Array<{ name: string }>;
  if (!workspaceColumns.some((column) => column.name === "settings")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN settings TEXT");
  }
  if (!botColumnNames.has("policy")) {
    db.exec("ALTER TABLE bots ADD COLUMN policy TEXT NOT NULL DEFAULT 'inherit'");
  }
  if (!botColumnNames.has("effort")) {
    db.exec("ALTER TABLE bots ADD COLUMN effort TEXT");
  }

  return db;
}
