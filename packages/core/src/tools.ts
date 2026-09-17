import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@openbot/gateway";
import type { ComputerKind, ToolArtifact } from "@openbot/protocol";
import type {
  ExecResult,
  SandboxBackend,
  SandboxState,
} from "@openbot/sandbox";
import {
  ensureWorkspace,
  execLocal,
  resolveLocalCwd,
  resolveWorkspacePath,
} from "./local-computer";

const MAX_OUTPUT = 30_000;
const MAX_TIMEOUT_SECONDS = 120;
const LOCAL_PREFIX = "[local Mac] ";

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  durationMs: number;
  artifacts?: ToolArtifact[];
}

export interface ToolContext {
  botId: string;
  computer: ComputerKind;
  sandbox: SandboxBackend | null;
  workspaceDir: string;
  artifactsDir: string;
  onSandboxState: (state: SandboxState) => void;
}

export interface Tool {
  definition: ToolDefinition;
  execute: (
    context: ToolContext,
    args: Record<string, unknown>,
  ) => Promise<ToolExecutionResult>;
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT)}\n[output truncated]`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatExecResult(result: {
  exit: number;
  stdout: string;
  stderr: string;
}): string {
  const parts = [`exit code: ${result.exit}`];
  if (result.stdout.trim()) {
    parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  }
  if (result.stderr.trim()) {
    parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  }
  return parts.join("\n");
}

function localResult(
  output: string,
  ok: boolean,
  durationMs: number,
): ToolExecutionResult {
  return { ok, output: `${LOCAL_PREFIX}${output}`, durationMs };
}

async function ensureSandbox(
  context: ToolContext,
  sandbox: SandboxBackend,
): Promise<void> {
  const status = await sandbox.ensure(context.botId);
  context.onSandboxState(status.state);
}

async function runCommand(
  context: ToolContext,
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<ToolExecutionResult> {
  if (context.computer === "mac") {
    const workspace = ensureWorkspace(context.workspaceDir);
    const resolvedCwd = resolveLocalCwd(workspace, cwd || workspace);
    if (resolvedCwd.error || !resolvedCwd.path) {
      return localResult(resolvedCwd.error ?? "invalid cwd", false, 0);
    }
    const startedAt = Date.now();
    const result = await execLocal(
      command,
      resolvedCwd.path,
      timeoutSeconds * 1000,
    );
    return localResult(
      truncate(formatExecResult(result)),
      result.exit === 0,
      Date.now() - startedAt,
    );
  }

  const sandbox = context.sandbox;
  if (!sandbox) {
    return { ok: false, output: "sandbox is not available", durationMs: 0 };
  }
  await ensureSandbox(context, sandbox);
  const startedAt = Date.now();
  const result = await sandbox.exec(context.botId, {
    command,
    cwd,
    timeoutMs: timeoutSeconds * 1000,
  });
  return {
    ok: result.exit === 0,
    output: truncate(formatExecResult(result)),
    durationMs: Date.now() - startedAt,
  };
}

function readTimeout(args: Record<string, unknown>): number {
  const value = Number(args.timeoutSeconds ?? 60);
  if (!Number.isFinite(value) || value <= 0) {
    return 60;
  }
  return Math.min(value, MAX_TIMEOUT_SECONDS);
}

function readCwd(args: Record<string, unknown>, fallback: string): string {
  return typeof args.cwd === "string" && args.cwd ? args.cwd : fallback;
}

const shellTool: Tool = {
  definition: {
    name: "shell",
    description:
      "Run a shell command inside your own Linux computer (a sandboxed microVM). " +
      "Use it only when the user's request requires running a command, creating " +
      "files, or executing scripts. Do not use it to check status or explore " +
      "the environment during ordinary conversation. The computer is a " +
      "sandboxed microVM and starts automatically on first use.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        cwd: {
          type: "string",
          description: "Working directory. Defaults to /root.",
        },
        timeoutSeconds: {
          type: "number",
          description: "Timeout in seconds (default 60, max 120).",
        },
      },
      required: ["command"],
    },
  },
  async execute(context, args) {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) {
      return { ok: false, output: "command is required", durationMs: 0 };
    }
    const fallback = context.computer === "mac" ? context.workspaceDir : "/root";
    return runCommand(
      context,
      command,
      readCwd(args, fallback),
      readTimeout(args),
    );
  },
};

const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description:
      "Read a file from your computer. Returns the file contents as text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file." },
        maxBytes: {
          type: "number",
          description: "Maximum bytes to read (default 100000).",
        },
      },
      required: ["path"],
    },
  },
  async execute(context, args) {
    const path = typeof args.path === "string" ? args.path : "";
    if (!path) {
      return { ok: false, output: "path is required", durationMs: 0 };
    }
    const maxBytes = Math.min(Number(args.maxBytes ?? 100_000) || 100_000, 200_000);
    if (context.computer === "mac") {
      ensureWorkspace(context.workspaceDir);
      const resolved = resolveWorkspacePath(context.workspaceDir, path);
      if (resolved.error || !resolved.path) {
        return localResult(resolved.error ?? "invalid path", false, 0);
      }
      return runCommand(
        context,
        `head -c ${Math.floor(maxBytes)} -- ${shellQuote(resolved.path)}`,
        context.workspaceDir,
        30,
      );
    }
    return runCommand(
      context,
      `head -c ${Math.floor(maxBytes)} -- ${shellQuote(path)}`,
      "/root",
      30,
    );
  },
};

const writeFileTool: Tool = {
  definition: {
    name: "write_file",
    description:
      "Write text to a file on your computer, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to write." },
        content: { type: "string", description: "File contents." },
      },
      required: ["path", "content"],
    },
  },
  async execute(context, args) {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    if (!path) {
      return { ok: false, output: "path is required", durationMs: 0 };
    }
    const encoded = Buffer.from(content, "utf8").toString("base64");
    if (context.computer === "mac") {
      ensureWorkspace(context.workspaceDir);
      const resolved = resolveWorkspacePath(context.workspaceDir, path);
      if (resolved.error || !resolved.path) {
        return localResult(resolved.error ?? "invalid path", false, 0);
      }
      const command = `mkdir -p -- $(dirname ${shellQuote(resolved.path)}) && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(resolved.path)} && wc -c < ${shellQuote(resolved.path)}`;
      return runCommand(context, command, context.workspaceDir, 30);
    }
    const command = `mkdir -p -- $(dirname ${shellQuote(path)}) && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)} && wc -c < ${shellQuote(path)}`;
    return runCommand(context, command, "/root", 30);
  },
};

interface BrowserResult {
  ok?: boolean;
  error?: string;
  url?: string;
  title?: string;
  text?: string;
  screenshot?: string;
}

interface BrowserActionOutcome {
  parsed: BrowserResult | null;
  result: ExecResult;
  durationMs: number;
}

const SCREEN_CAPTURE_TIMEOUT_MS = 15_000;
const SCREENSHOT_COMMAND =
  "rm -f /tmp/openbot-screen.png && DISPLAY=:99 scrot -o /tmp/openbot-screen.png && base64 -w0 /tmp/openbot-screen.png";

async function runBrowserAction(
  sandbox: SandboxBackend,
  botId: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<BrowserActionOutcome> {
  const startedAt = Date.now();
  const response = await sandbox.browser(botId, {
    action: String(payload.action ?? ""),
    ...(typeof payload.url === "string" ? { url: payload.url } : {}),
    ...(typeof payload.selector === "string"
      ? { selector: payload.selector }
      : {}),
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(typeof payload.submit === "boolean" ? { submit: payload.submit } : {}),
    ...(typeof payload.milliseconds === "number"
      ? { milliseconds: payload.milliseconds }
      : {}),
    timeoutMs,
  });
  const result: ExecResult = {
    exit: response.ok ? 0 : 1,
    stdout: JSON.stringify(response),
    stderr: response.ok ? "" : response.error ?? "browser action failed",
    durationMs: response.durationMs,
  };
  return {
    parsed: response as BrowserResult,
    result,
    durationMs: Date.now() - startedAt,
  };
}

export async function captureScreen(
  sandbox: SandboxBackend,
  botId: string,
): Promise<Buffer> {
  const result = await sandbox.exec(botId, {
    command: SCREENSHOT_COMMAND,
    cwd: "/root",
    timeoutMs: SCREEN_CAPTURE_TIMEOUT_MS,
  });
  const encoded = result.stdout.replace(/\s+/g, "");
  if (result.exit !== 0 || !encoded) {
    throw new Error(
      result.stderr.trim() || `desktop screen capture failed (${result.exit})`,
    );
  }
  return Buffer.from(encoded, "base64");
}

const browserTool: Tool = {
  definition: {
    name: "browser",
    description:
      "Control the web browser on your computer. The browser keeps cookies and " +
      "sign-ins between calls. Navigation and interaction actions return the " +
      "current page text automatically, so inspect that evidence before taking " +
      "the next step; do not immediately call text unless you need a focused " +
      "selector or content beyond the returned preview. Actions: goto (url), " +
      "click (selector), type (selector, " +
      "text, submit), text (optional selector), links (optional selector, returns " +
      "link labels and URLs), screenshot (returns a picture), back, wait " +
      "(selector or milliseconds). For research, collect facts from each page " +
      "and replace blocked, broken, or irrelevant sources before answering.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "goto",
            "click",
            "type",
            "text",
            "links",
            "screenshot",
            "back",
            "wait",
          ],
        },
        url: { type: "string", description: "URL for the goto action." },
        selector: {
          type: "string",
          description: "CSS selector for click, type, wait, or text.",
        },
        text: { type: "string", description: "Text to type." },
        submit: {
          type: "boolean",
          description: "Press Enter after typing.",
        },
        milliseconds: {
          type: "number",
          description: "Wait duration for the wait action.",
        },
      },
      required: ["action"],
    },
  },
  async execute(context, args) {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) {
      return { ok: false, output: "action is required", durationMs: 0 };
    }
    if (context.computer === "mac") {
      return localResult(
        "the browser tool needs the Firecracker microVM computer; " +
          "it is not available when this agent uses This Mac. " +
          "Switch this agent's computer to the microVM to browse.",
        false,
        0,
      );
    }
    const sandbox = context.sandbox;
    if (!sandbox) {
      return { ok: false, output: "sandbox is not available", durationMs: 0 };
    }
    await ensureSandbox(context, sandbox);

    const { parsed, result, durationMs } = await runBrowserAction(
      sandbox,
      context.botId,
      {
        action,
        url: args.url,
        selector: args.selector,
        text: args.text,
        submit: args.submit,
        milliseconds: args.milliseconds,
      },
      75_000,
    );

    if (!parsed) {
      return {
        ok: false,
        output: truncate(formatExecResult(result)),
        durationMs,
      };
    }
    if (parsed.ok === false) {
      return {
        ok: false,
        output: `browser error: ${parsed.error ?? "unknown error"}`,
        durationMs,
      };
    }

    const artifacts: ToolArtifact[] = [];
    let output = `url: ${parsed.url ?? ""}\ntitle: ${parsed.title ?? ""}`;
    if (parsed.text) {
      output += `\ntext:\n${parsed.text}`;
    }
    if (parsed.screenshot) {
      mkdirSync(context.artifactsDir, { recursive: true });
      const filename = `${randomUUID()}.png`;
      writeFileSync(
        join(context.artifactsDir, filename),
        Buffer.from(parsed.screenshot, "base64"),
      );
      artifacts.push({ type: "image", url: `/artifacts/${filename}` });
      output += `\nscreenshot saved (visible to the user in the chat)`;
    }

    return { ok: true, output: truncate(output), durationMs, artifacts };
  },
};

export const tools: Tool[] = [shellTool, readFileTool, writeFileTool, browserTool];

const LOCAL_DEFINITIONS: Record<string, ToolDefinition> = {
  shell: {
    name: "shell",
    description:
      "Run a shell command directly on the user's Mac (the This Mac computer), " +
      "not inside the sandboxed microVM. Use it only when the user's request " +
      "requires running a command, creating files, or executing scripts. Do not " +
      "use it to check status or explore the environment during ordinary " +
      "conversation. Commands run as the user and are always approved first.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        cwd: {
          type: "string",
          description:
            "Working directory. Defaults to this agent's workspace folder.",
        },
        timeoutSeconds: {
          type: "number",
          description: "Timeout in seconds (default 60, max 120).",
        },
      },
      required: ["command"],
    },
  },
  read_file: {
    name: "read_file",
    description:
      "Read a file from this agent's workspace folder on the user's Mac. " +
      "Returns the file contents as text. Paths outside the workspace are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file, relative to the workspace or absolute inside it.",
        },
        maxBytes: {
          type: "number",
          description: "Maximum bytes to read (default 100000).",
        },
      },
      required: ["path"],
    },
  },
  write_file: {
    name: "write_file",
    description:
      "Write text to a file in this agent's workspace folder on the user's Mac, " +
      "creating parent directories as needed. Paths outside the workspace are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to write, relative to the workspace or absolute inside it.",
        },
        content: { type: "string", description: "File contents." },
      },
      required: ["path", "content"],
    },
  },
};

export function toolDefinitions(
  computer: ComputerKind = "firecracker",
): ToolDefinition[] {
  return tools.map((tool) =>
    computer === "mac"
      ? (LOCAL_DEFINITIONS[tool.definition.name] ?? tool.definition)
      : tool.definition,
  );
}

export function findTool(name: string): Tool | undefined {
  return tools.find((tool) => tool.definition.name === name);
}
