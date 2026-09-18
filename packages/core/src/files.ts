import { join } from "node:path";
import type { Bot } from "@openbot/protocol";
import type { SandboxBackend } from "@openbot/sandbox";
import { ensureWorkspace, resolveWorkspacePath } from "./local-computer";
import {
  runCodeToolHelper,
  type RawExecResult,
  type ToolContext,
} from "./tools";

export interface FileEntryInfo {
  name: string;
  dir: boolean;
  size: number | null;
  mtime: number | null;
}

export interface FileListResult {
  path: string;
  entries: FileEntryInfo[];
  error: string | null;
}

export type FileReadKind = "text" | "image" | "binary" | "dir" | "missing";

export interface FileReadResult {
  path: string;
  kind: FileReadKind;
  content: string | null;
  mime: string | null;
  size: number;
  truncated: boolean;
  error: string | null;
}

export interface FileServiceOptions {
  dataDir: string;
  artifactsDir: string;
  sandbox: SandboxBackend | null;
  getBot(botId: string): Bot | null;
}

const DEFAULT_CAP = 500;

function isMacBot(bot: Bot): boolean {
  return bot.computer === "mac";
}

function workspaceFor(options: FileServiceOptions, bot: Bot): string {
  return ensureWorkspace(join(options.dataDir, "workspaces", bot.id));
}

function helperContext(
  options: FileServiceOptions,
  bot: Bot,
): ToolContext {
  return {
    botId: bot.id,
    computer: isMacBot(bot) ? "mac" : "firecracker",
    sandbox: options.sandbox,
    workspaceDir: join(options.dataDir, "workspaces", bot.id),
    artifactsDir: options.artifactsDir,
    decision: null,
    vision: false,
    onSandboxState: () => {},
  };
}

/**
 * Resolve a user-supplied path for the agent's computer and make sure the
 * computer is reachable. Returns either a resolved absolute path or an error.
 */
async function resolveTarget(
  options: FileServiceOptions,
  bot: Bot,
  rawPath: string,
  fallback: string,
): Promise<{ path: string; error: string | null }> {
  const target = rawPath.trim() || fallback;
  if (isMacBot(bot)) {
    const root = workspaceFor(options, bot);
    const resolved = resolveWorkspacePath(root, target);
    if (resolved.error || !resolved.path) {
      return { path: target, error: resolved.error ?? "invalid path" };
    }
    return { path: resolved.path, error: null };
  }
  const path = target.startsWith("/") ? target : join("/root", target);
  if (!options.sandbox) {
    return { path, error: "sandbox is not available" };
  }
  const status = await options.sandbox.status(bot.id);
  if (status.state !== "running") {
    return { path, error: "The agent's computer is not running." };
  }
  return { path, error: null };
}

async function runHelper(
  options: FileServiceOptions,
  bot: Bot,
  payload: Record<string, unknown>,
): Promise<RawExecResult> {
  return runCodeToolHelper(helperContext(options, bot), payload, 30);
}

function parseHelper<T>(result: RawExecResult): T | null {
  try {
    return JSON.parse(result.stdout.trim()) as T;
  } catch {
    return null;
  }
}

export async function listComputerFiles(
  options: FileServiceOptions,
  botId: string,
  rawPath = "",
): Promise<FileListResult> {
  const bot = options.getBot(botId);
  if (!bot) {
    return { path: rawPath, entries: [], error: "agent not found" };
  }
  const fallback = isMacBot(bot)
    ? join(options.dataDir, "workspaces", bot.id)
    : "/root";
  const target = await resolveTarget(options, bot, rawPath, fallback);
  if (target.error) {
    return { path: target.path, entries: [], error: target.error };
  }
  if (!isMacBot(bot)) {
    const sandbox = options.sandbox;
    if (!sandbox) {
      return { path: target.path, entries: [], error: "sandbox is not available" };
    }
    try {
      const result = await sandbox.filesList(bot.id, {
        path: target.path,
        cap: DEFAULT_CAP,
      });
      if (result.error) {
        return { path: target.path, entries: [], error: result.error };
      }
      return { path: target.path, entries: result.entries, error: null };
    } catch (error) {
      return {
        path: target.path,
        entries: [],
        error: (error as Error).message,
      };
    }
  }
  const result = await runHelper(options, bot, {
    mode: "entries",
    root: target.path,
    cap: DEFAULT_CAP,
  });
  if (result.exit !== 0) {
    return {
      path: target.path,
      entries: [],
      error: result.stderr.trim() || "could not list the directory",
    };
  }
  const payload = parseHelper<{ entries?: FileEntryInfo[]; error?: string }>(
    result,
  );
  if (!payload) {
    return {
      path: target.path,
      entries: [],
      error: "the computer returned an unexpected listing",
    };
  }
  if (payload.error) {
    return { path: target.path, entries: [], error: payload.error };
  }
  return { path: target.path, entries: payload.entries ?? [], error: null };
}

export async function readComputerFile(
  options: FileServiceOptions,
  botId: string,
  rawPath: string,
): Promise<FileReadResult> {
  const empty: FileReadResult = {
    path: rawPath,
    kind: "missing",
    content: null,
    mime: null,
    size: 0,
    truncated: false,
    error: "path is required",
  };
  if (!rawPath.trim()) {
    return empty;
  }
  const bot = options.getBot(botId);
  if (!bot) {
    return { ...empty, error: "agent not found" };
  }
  const fallback = isMacBot(bot)
    ? join(options.dataDir, "workspaces", bot.id)
    : "/root";
  const target = await resolveTarget(options, bot, rawPath, fallback);
  if (target.error) {
    return { ...empty, path: target.path, error: target.error };
  }
  if (!isMacBot(bot)) {
    const sandbox = options.sandbox;
    if (!sandbox) {
      return { ...empty, path: target.path, error: "sandbox is not available" };
    }
    try {
      const result = await sandbox.filesRead(bot.id, { path: target.path });
      return {
        path: target.path,
        kind: result.kind,
        content: result.content,
        mime: result.mime,
        size: result.size,
        truncated: result.truncated,
        error: result.error,
      };
    } catch (error) {
      return {
        ...empty,
        path: target.path,
        error: (error as Error).message,
      };
    }
  }
  const result = await runHelper(options, bot, {
    mode: "read",
    path: target.path,
  });
  if (result.exit !== 0) {
    return {
      ...empty,
      path: target.path,
      error: result.stderr.trim() || "could not read the file",
    };
  }
  const payload = parseHelper<{
    kind?: FileReadKind;
    content?: string | null;
    mime?: string | null;
    size?: number;
    truncated?: boolean;
    error?: string | null;
  }>(result);
  if (!payload) {
    return {
      ...empty,
      path: target.path,
      error: "the computer returned an unexpected file",
    };
  }
  return {
    path: target.path,
    kind: payload.kind ?? "missing",
    content: payload.content ?? null,
    mime: payload.mime ?? null,
    size: typeof payload.size === "number" ? payload.size : 0,
    truncated: Boolean(payload.truncated),
    error: payload.error ?? null,
  };
}
