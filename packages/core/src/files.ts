import { join } from "node:path";
import { homedir } from "node:os";
import type { Bot, ComputerKind, Workspace } from "@openbot/protocol";
import { botHasComputer, primaryComputer } from "@openbot/protocol";
import type { SandboxBackend } from "@openbot/sandbox";
import { ensureWorkspace, resolveWorkspacePath } from "./local-computer";
import {
  runCodeToolHelper,
  type RawExecResult,
  type ToolContext,
} from "./tools";
import { workspaceGuestRoot } from "./workspaces";

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
  /** The workspace registry, when the caller has one (older callers may not). */
  getWorkspace?(workspaceId: string): Workspace | null;
}

const DEFAULT_CAP = 500;

/**
 * Which computer a file request browses. When the caller names one of the
 * agent's computers it is honored; otherwise the agent's primary computer is
 * used.
 */
function computerFor(bot: Bot, requested?: ComputerKind | null): ComputerKind {
  if (requested && botHasComputer(bot, requested)) {
    return requested;
  }
  return primaryComputer(bot);
}

function scratchDir(options: FileServiceOptions, bot: Bot): string {
  return join(options.dataDir, "workspaces", bot.id);
}

function workspaceFor(options: FileServiceOptions, bot: Bot): Workspace | null {
  if (!bot.workspaceId || !options.getWorkspace) {
    return null;
  }
  return options.getWorkspace(bot.workspaceId);
}

/** The Mac folder file tools are confined to: the project, the home folder, or all. */
export function macRoot(options: FileServiceOptions, bot: Bot): string {
  const access = bot.access ?? "project";
  if (access === "full") {
    return "/";
  }
  if (access === "home") {
    return homedir();
  }
  const workspace = workspaceFor(options, bot);
  return workspace ? workspace.root : ensureWorkspace(scratchDir(options, bot));
}

/** The microVM folder relative paths start from for this agent. */
function guestRoot(options: FileServiceOptions, bot: Bot): string {
  const workspace = workspaceFor(options, bot);
  return workspace ? workspaceGuestRoot(workspace) : "/root";
}

function helperContext(
  options: FileServiceOptions,
  bot: Bot,
  computer: ComputerKind,
): ToolContext {
  return {
    botId: bot.id,
    computer,
    sandbox: options.sandbox,
    workspaceDir: macRoot(options, bot),
    ...(computer === "mac" ? {} : { guestCwd: guestRoot(options, bot) }),
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
  computer: ComputerKind,
): Promise<{ path: string; error: string | null }> {
  const fallback = computer === "mac" ? macRoot(options, bot) : guestRoot(options, bot);
  const target = rawPath.trim() || fallback;
  if (computer === "mac") {
    const resolved = resolveWorkspacePath(macRoot(options, bot), target);
    if (resolved.error || !resolved.path) {
      return { path: target, error: resolved.error ?? "invalid path" };
    }
    return { path: resolved.path, error: null };
  }
  const path = target.startsWith("/") ? target : join(guestRoot(options, bot), target);
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
  computer: ComputerKind,
): Promise<RawExecResult> {
  return runCodeToolHelper(helperContext(options, bot, computer), payload, 30);
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
  requested?: ComputerKind | null,
): Promise<FileListResult> {
  const bot = options.getBot(botId);
  if (!bot) {
    return { path: rawPath, entries: [], error: "agent not found" };
  }
  const computer = computerFor(bot, requested);
  const target = await resolveTarget(options, bot, rawPath, computer);
  if (target.error) {
    return { path: target.path, entries: [], error: target.error };
  }
  if (computer !== "mac") {
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
  const result = await runHelper(
    options,
    bot,
    {
      mode: "entries",
      root: target.path,
      cap: DEFAULT_CAP,
    },
    computer,
  );
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
  requested?: ComputerKind | null,
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
  const computer = computerFor(bot, requested);
  const target = await resolveTarget(options, bot, rawPath, computer);
  if (target.error) {
    return { ...empty, path: target.path, error: target.error };
  }
  if (computer !== "mac") {
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
  const result = await runHelper(
    options,
    bot,
    {
      mode: "read",
      path: target.path,
    },
    computer,
  );
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
