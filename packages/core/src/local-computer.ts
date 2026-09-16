import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const MAX_OUTPUT = 8_000_000;

export interface LocalExecResult {
  exit: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function ensureWorkspace(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function realPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function deepestExisting(path: string): string | null {
  let current = path;
  while (true) {
    if (existsSync(current)) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveWorkspacePath(
  workspaceDir: string,
  rawPath: string,
): { path: string | null; error: string | null } {
  if (!rawPath) {
    return { path: null, error: "path is required" };
  }
  const root = resolve(workspaceDir);
  const candidate = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(root, rawPath);
  if (!isInside(root, candidate)) {
    return {
      path: null,
      error: `path escapes the bot workspace (${root}): ${rawPath}`,
    };
  }
  const existing = deepestExisting(candidate);
  if (existing && !isInside(realPath(root), realPath(existing))) {
    return {
      path: null,
      error: `path escapes the bot workspace (${root}): ${rawPath}`,
    };
  }
  return { path: candidate, error: null };
}

export function resolveLocalCwd(
  workspaceDir: string,
  rawCwd: string,
): { path: string | null; error: string | null } {
  const root = resolve(workspaceDir);
  const candidate = isAbsolute(rawCwd) ? resolve(rawCwd) : resolve(root, rawCwd);
  if (!existsSync(candidate)) {
    return {
      path: null,
      error: `working directory does not exist: ${candidate}`,
    };
  }
  return { path: candidate, error: null };
}

export function execLocal(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<LocalExecResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // fall through to the direct kill
        }
      }
      child.kill(signal);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGKILL");
    }, timeoutMs);

    const settle = (result: LocalExecResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-MAX_OUTPUT);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_OUTPUT);
    });

    child.once("error", (error) => {
      settle({
        exit: -1,
        stdout: "",
        stderr: (error as Error).message,
        durationMs: Date.now() - startedAt,
      });
    });

    child.once("close", (code) => {
      if (timedOut) {
        settle({
          exit: -1,
          stdout: "",
          stderr: `timeout after ${Math.round(timeoutMs / 1000)}s`,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      settle({
        exit: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
