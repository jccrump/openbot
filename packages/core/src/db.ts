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

  return db;
}
