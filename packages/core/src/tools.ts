import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@openbot/gateway";
import { choice } from "@openbot/gateway";
import type {
  ComputerKind,
  ModelRef,
  PolicySettings,
  TaskDisplay,
  TaskGrant,
  TaskStatus,
  ToolArtifact,
} from "@openbot/protocol";
import type {
  DesktopActionRequest,
  ExecResult,
  SandboxBackend,
  SandboxState,
} from "@openbot/sandbox";
import {
  BROWSE_MAX_STEPS_CAP,
  BROWSE_MAX_STEPS_DEFAULT,
  renderBrowseEvidence,
  runBrowseLoop,
} from "./browse";
import type { DecisionNotice, DecisionRuntime } from "./decision";
import type { MemoryService } from "./memory";
import type { SoulService } from "./soul";
import {
  GUARDRAIL_BLOCKED,
  GUARDRAIL_WARNING,
  guardrailSummary,
  screenUntrustedText,
} from "./guardrail";
import {
  ensureWorkspace,
  execLocal,
  resolveLocalCwd,
  resolveWorkspacePath,
} from "./local-computer";
import { BROWSER_SKILLS_B64 } from "./skills.generated";

const MAX_OUTPUT = 30_000;
const MAX_TIMEOUT_SECONDS = 300;
const LOCAL_PREFIX = "[local Mac] ";

export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  durationMs: number;
  artifacts?: ToolArtifact[];
  images?: ToolImage[];
  challenge?: boolean;
  challengeUrl?: string | null;
}

export interface ToolContext {
  botId: string;
  /** Sandbox key: a task id for task computers, otherwise the bot id. */
  computerId?: string;
  /** Sandbox key for browser actions when it differs from the computer. */
  browserId?: string;
  /** Guest workspace directory for task sessions inside a shared computer. */
  guestCwd?: string;
  computer: ComputerKind;
  sandbox: SandboxBackend | null;
  workspaceDir: string;
  artifactsDir: string;
  decision: DecisionRuntime | null;
  /** Resolved approvals policy for this run (egress allowlist, tiers). */
  policy?: PolicySettings;
  vision: boolean;
  signal?: AbortSignal;
  onDecision?: (notice: DecisionNotice) => void;
  onSandboxState: (state: SandboxState) => void;
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
  orchestrator?: OrchestratorHandle | null;
  /** Set when this run is a worker or manager task. */
  taskId?: string;
  projectId?: string | null;
  memory?: MemoryService | null;
  soul?: SoulService | null;
  memoryScope?: string;
}

export interface RoleSummary {
  id: string;
  name: string;
  role: string | null;
  model: ModelRef;
  computer: string | null;
  delegates: boolean;
  busyTaskId: string | null;
  busyTaskTitle: string | null;
}

export interface TaskSummary {
  id: string;
  title: string;
  roleName: string;
  status: TaskStatus;
  display: TaskDisplay;
  parentId: string | null;
  depth: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  result: string | null;
  error: string | null;
}

export interface SpawnedTask {
  id: string;
  title: string;
  roleName: string;
  status: TaskStatus;
  parentId: string | null;
  depth: number;
  queued: boolean;
}

export interface TaskGrantRequest {
  tools?: string[];
  display?: TaskDisplay;
  budget?: {
    wallClockMs?: number | null;
    tokens?: number | null;
    toolCalls?: number | null;
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  scope: string | null;
  model: ModelRef;
  status: "idle" | "working";
  activeTaskId: string | null;
  activeTaskTitle: string | null;
  openTasks: number;
  updatedAt: string;
}

export interface OrchestratorHandle {
  listRoles(): RoleSummary[];
  listProjects(): ProjectSummary[];
  createProject(input: {
    callerBotId: string;
    name: string;
    scope: string;
    brief?: string;
    model?: ModelRef;
  }): ProjectSummary;
  askProject(input: {
    callerBotId: string;
    projectId: string;
    request: string;
    title?: string;
    grant?: TaskGrantRequest;
  }): SpawnedTask;
  spawn(input: {
    callerBotId: string;
    parentTaskId?: string;
    roleId: string;
    brief: string;
    title?: string;
    display?: TaskDisplay;
    grant?: TaskGrantRequest;
  }): SpawnedTask;
  status(taskId?: string): TaskSummary[];
  cancel(taskId: string): boolean;
}

export function isOrchestrationTool(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.has(name);
}

export function isReadOnlyOrchestrationTool(name: string): boolean {
  return READ_ONLY_ORCHESTRATION_TOOL_NAMES.has(name);
}

/** Memory reads and writes are low risk and never need an approval card. */
export function isApprovalExemptTool(name: string): boolean {
  return (
    READ_ONLY_ORCHESTRATION_TOOL_NAMES.has(name) || MEMORY_TOOL_NAMES.has(name)
  );
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

function sandboxId(context: ToolContext): string {
  return context.computerId ?? context.botId;
}

function browserSandboxId(context: ToolContext): string {
  return context.browserId ?? sandboxId(context);
}

async function ensureSandbox(
  context: ToolContext,
  sandbox: SandboxBackend,
): Promise<void> {
  const id = sandboxId(context);
  const current = await sandbox.status(id);
  if (current.state !== "running") {
    context.onSandboxState("booting");
  }
  const status = await sandbox.ensure(id);
  context.onSandboxState(status.state);
}

// Worker sessions share their project's computer, so each session gets its own
// directory. The directory is created once per computer + path.
const guestWorkspaces = new Map<string, Promise<void>>();

/**
 * Materialize the browser playbook (docs/skills/browser-execute, vendored from
 * browser-use, MIT) into the guest so a worker can read the recipes with
 * read_file. One copy per computer, best-effort: a failure here must never
 * block a browser call.
 */
export const GUEST_SKILLS_DIR = "/root/openbot-skills/browser-execute";
const guestSkills = new Map<string, Promise<void>>();

async function ensureGuestSkills(
  context: ToolContext,
  sandbox: SandboxBackend,
): Promise<void> {
  if (context.computer === "mac") {
    return;
  }
  const id = sandboxId(context);
  const existing = guestSkills.get(id);
  if (existing) {
    return existing;
  }
  const task = (async () => {
    await ensureSandbox(context, sandbox);
    await sandbox.exec(id, {
      command:
        `mkdir -p /root/openbot-skills && ` +
        `printf '%s' '${BROWSER_SKILLS_B64}' | base64 -d | tar xz -C /root/openbot-skills`,
      cwd: "/",
      timeoutMs: 30_000,
    });
  })().catch((error) => {
    guestSkills.delete(id);
    console.warn(`browser skills copy failed: ${(error as Error).message}`);
  });
  guestSkills.set(id, task);
  return task;
}

async function ensureGuestWorkspace(
  context: ToolContext,
  sandbox: SandboxBackend,
): Promise<void> {
  const cwd = context.guestCwd;
  if (!cwd || context.computer === "mac") {
    return;
  }
  const key = `${sandboxId(context)}:${cwd}`;
  const existing = guestWorkspaces.get(key);
  if (existing) {
    return existing;
  }
  const task = (async () => {
    await ensureSandbox(context, sandbox);
    await sandbox.exec(sandboxId(context), {
      command: `mkdir -p ${shellQuote(cwd)}`,
      cwd: "/",
      timeoutMs: 15_000,
    });
  })().catch((error) => {
    guestWorkspaces.delete(key);
    throw error;
  });
  guestWorkspaces.set(key, task);
  return task;
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
  await ensureGuestWorkspace(context, sandbox);
  const startedAt = Date.now();
  const result = await sandbox.exec(sandboxId(context), {
    command,
    cwd: cwd || context.guestCwd,

    timeoutMs: timeoutSeconds * 1000,
    ...(context.onOutput ? { onOutput: context.onOutput } : {}),
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
      "sandboxed microVM and starts automatically on first use. This shell is " +
      "the microVM filesystem, not the desktop: the terminal, file manager, and " +
      "browser windows on the screen belong to a separate display host, so " +
      "installing a GUI app here does not add it to the desktop. Long commands " +
      "are allowed (up to 300 seconds); use a generous timeout for package " +
      "installs or builds instead of backgrounding and polling.",
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
          description: "Timeout in seconds (default 60, max 300).",
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
  challenge?: boolean;
  output?: string;
  result?: string;
  screenshots?: string[];
  elements?: Array<{
    id: string;
    selector: string;
    role: string;
    tag: string;
    type: string;
    label: string;
  }>;
}

interface BrowserActionOutcome {
  parsed: BrowserResult | null;
  result: ExecResult;
  durationMs: number;
}

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
    ...(typeof payload.pixels === "number" ? { pixels: payload.pixels } : {}),
    ...(typeof payload.href === "string" ? { href: payload.href } : {}),
    ...(typeof payload.index === "number" ? { index: payload.index } : {}),
    ...(typeof payload.code === "string" ? { code: payload.code } : {}),
    ...(payload.egress && typeof payload.egress === "object"
      ? { egress: payload.egress as { mode: "ask" | "deny"; allow: string[] } }
      : {}),
    timeoutMs:
      typeof payload.timeoutMs === "number" ? payload.timeoutMs : timeoutMs,
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

const browserExecuteTool: Tool = {
  definition: {
    name: "browser_execute",
    description:
      "Drive the web browser by writing JavaScript against a persistent Chrome " +
      "DevTools Protocol (CDP) session. Prefer this over step-by-step browser " +
      "actions whenever the work is multi-step: one snippet can navigate, wait, " +
      "extract, click, and verify in a single call. In scope: `session` (the " +
      "CDP session, with every domain mounted — session.Page, session.Runtime, " +
      "session.DOM, session.Target, session.Network, ...), `console`, and " +
      "standard globals. Return a value to get it back as JSON; anything " +
      "console.log'd comes back as output. The session persists across calls, " +
      "so tabs, cookies, sign-ins, and globals survive. Screenshots taken with " +
      "`await session.Page.captureScreenshot({format:'png'})` attach to the " +
      "conversation automatically. Navigation is limited to the browser egress " +
      "allowlist. Examples:\n" +
      "navigate and read: await session.Page.navigate({url:'https://example.com'}); await session.waitFor('Page.loadEventFired', undefined, 15000).catch(()=>{}); return (await session.Runtime.evaluate({expression:'document.title',returnByValue:true})).result.value\n" +
      "list tabs: const {targetInfos} = await session.Target.getTargets({}); return targetInfos.filter(t=>t.type==='page').map(t=>({id:t.targetId,url:t.url,title:t.title}))\n" +
      "click by text: await session.Runtime.evaluate({expression:\"[...document.querySelectorAll('a')].find(a=>a.textContent.includes('Docs'))?.click()\"})\n" +
      "Use `session.waitFor(method, predicate, timeoutMs)` for navigation and " +
      "network waits instead of fixed sleeps where you can. The full playbook " +
      `(snippet model plus recipes for tabs, uploads, dialogs, iframes, ` +
      `shadow DOM, downloads, and network waits) is readable at ` +
      `${GUEST_SKILLS_DIR}/SKILL.md.`,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "The JavaScript snippet to execute. `session` (CDP) and `console` " +
            "are in scope; `return` a value to see it as JSON.",
        },
        description: {
          type: "string",
          description:
            "Clear, concise description of what this snippet does in 3-7 words.",
        },
        timeout: {
          type: "number",
          description:
            "Optional timeout in milliseconds (default 60000, max 300000).",
        },
      },
      required: ["code"],
    },
  },
  async execute(context, args) {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) {
      return { ok: false, output: "code is required", durationMs: 0 };
    }
    if (context.computer === "mac") {
      return localResult(
        "the browser_execute tool needs the Firecracker microVM computer; " +
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
    await ensureGuestSkills(context, sandbox);

    const requested =
      typeof args.timeout === "number" && Number.isFinite(args.timeout)
        ? args.timeout
        : 60_000;
    const timeoutMs = Math.min(Math.max(requested, 1_000), 300_000);
    const egressSetting = context.policy?.egress;
    const egress =
      egressSetting && egressSetting.mode !== "off"
        ? { mode: egressSetting.mode, allow: egressSetting.allow }
        : undefined;

    const { parsed, result, durationMs } = await runBrowserAction(
      sandbox,
      browserSandboxId(context),
      { action: "exec", code, timeoutMs, ...(egress ? { egress } : {}) },
      timeoutMs + 15_000,
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
        output: `browser_execute error: ${parsed.error ?? "unknown error"}`,
        durationMs,
      };
    }

    let output = `url: ${parsed.url ?? ""}\ntitle: ${parsed.title ?? ""}`;
    const consoleOutput = parsed.output ?? "";
    const resultText = parsed.result ?? "null";
    if (consoleOutput.trim()) {
      output += `\nconsole:\n${consoleOutput.trimEnd()}`;
    }
    if (resultText !== "null") {
      output += `\n=> ${resultText}`;
    }

    const guardrailText = [consoleOutput, resultText === "null" ? "" : resultText]
      .filter(Boolean)
      .join("\n");
    const guardrail = context.decision?.settings.guardrail ?? "off";
    const decisionClient = context.decision?.client ?? null;
    if (guardrailText && guardrail !== "off" && decisionClient) {
      const screenStartedAt = Date.now();
      const verdict = await screenUntrustedText({
        client: decisionClient,
        text: guardrailText,
        ...(context.signal ? { signal: context.signal } : {}),
      }).catch((error) => {
        console.warn(`guardrail check failed: ${(error as Error).message}`);
        return null;
      });
      if (verdict?.flagged) {
        console.info("guardrail.flagged", {
          botId: context.botId,
          tool: "browser_execute",
          url: parsed.url,
          instructionOverride: verdict.instructionOverride,
          exfiltrationRequest: verdict.exfiltrationRequest,
        });
        context.onDecision?.({
          kind: "guardrail",
          summary: guardrailSummary(verdict),
          flagged: true,
          latencyMs: Date.now() - screenStartedAt,
          model: context.decision?.settings.model ?? null,
        });
        output =
          guardrail === "block"
            ? `url: ${parsed.url ?? ""}\ntitle: ${parsed.title ?? ""}\ntext:\n${GUARDRAIL_BLOCKED}`
            : `${GUARDRAIL_WARNING}\n${output}`;
      }
    }

    const artifacts: ToolArtifact[] = [];
    const images: ToolImage[] = [];
    const screenshots = parsed.screenshots ?? [];
    if (screenshots.length > 0) {
      mkdirSync(context.artifactsDir, { recursive: true });
      for (const shot of screenshots) {
        const filename = `${randomUUID()}.png`;
        writeFileSync(
          join(context.artifactsDir, filename),
          Buffer.from(shot, "base64"),
        );
        artifacts.push({ type: "image", url: `/artifacts/${filename}` });
        if (context.vision) {
          images.push({ data: shot, mimeType: "image/png" });
        }
      }
      output += `\n${screenshots.length} screenshot${
        screenshots.length === 1 ? "" : "s"
      } ${
        context.vision
          ? "captured and attached to the conversation"
          : "saved (visible to the user in the chat)"
      }`;
    }

    return {
      ok: true,
      output: truncate(output),
      durationMs,
      artifacts,
      ...(images.length ? { images } : {}),
    };
  },
};

// Below this Jev confidence, browser_step refuses to act and hands the model
// the element list instead — a wrong click costs more than a model turn.
const BROWSER_STEP_MIN_CONFIDENCE = 0.7;

const browserStepTool: Tool = {
  definition: {
    name: "browser_step",
    description:
      "Take one browsing step chosen by Jev: describe the step in a few words " +
      "(\"open the pricing page\", \"search for mechanical keyboards\") and Jev " +
      "picks the element on the page while the browser acts — about 300 ms, no " +
      "model turn per element. Use it for ordinary interactive steps (following " +
      "a link, pressing a button, filling a field); use browser_execute when you " +
      "need precise multi-step scripting. Set text to type into the chosen field " +
      "(with enter to submit), or kind to force click/type. The result reports " +
      "what Jev chose, its confidence, and the page you land on.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The next step in a few words, e.g. \"open the pricing page\".",
        },
        text: {
          type: "string",
          description: "Text to type into the chosen field.",
        },
        enter: {
          type: "boolean",
          description: "Press Enter after typing.",
        },
        kind: {
          type: "string",
          enum: ["click", "type"],
          description: "Force the action; default is type when text is given, else click.",
        },
      },
      required: ["goal"],
    },
  },
  async execute(context, args) {
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (!goal) {
      return { ok: false, output: "goal is required", durationMs: 0 };
    }
    if (context.computer === "mac") {
      return localResult(
        "the browser_step tool needs the Firecracker microVM computer; " +
          "it is not available when this agent uses This Mac.",
        false,
        0,
      );
    }
    const sandbox = context.sandbox;
    if (!sandbox) {
      return { ok: false, output: "sandbox is not available", durationMs: 0 };
    }
    await ensureSandbox(context, sandbox);
    await ensureGuestSkills(context, sandbox);

    const botId = browserSandboxId(context);
    const snapshot = await runBrowserAction(
      sandbox,
      botId,
      { action: "snapshot" },
      60_000,
    );
    const page = snapshot.parsed;
    if (!page || page.ok === false) {
      return {
        ok: false,
        output: `browser_step error: ${page?.error ?? "page snapshot failed"}`,
        durationMs: snapshot.durationMs,
      };
    }
    const elements = page.elements ?? [];
    const listText = elements
      .map(
        (element) =>
          `${element.id} ${element.role} "${element.label}" (${element.selector})`,
      )
      .join("\n");

    const client = context.decision?.client ?? null;
    if (!client) {
      return {
        ok: false,
        output:
          "Jev is not configured, so browser_step cannot choose an element. " +
          `Page elements:\n${listText}`,
        durationMs: snapshot.durationMs,
      };
    }

    const criteria: Record<string, string> = {};
    for (const element of elements) {
      criteria[element.id] =
        `${element.role}: "${element.label}" — ${element.selector}`;
    }
    criteria.__none__ = "No visible element matches the step.";

    const decisionStartedAt = Date.now();
    let decision;
    try {
      decision = await client.evaluate({
        state: {
          goal,
          url: page.url ?? "",
          title: page.title ?? "",
          text: (page.text ?? "").slice(0, 1_500),
          elements: elements.map(({ id, role, label }) => ({ id, role, label })),
        },
        questions: {
          element: choice(
            "Which element should the browser act on to make progress on the step goal?",
            criteria,
          ),
        },
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      return {
        ok: false,
        output: `browser_step decision failed: ${(error as Error).message}`,
        durationMs: Date.now() - decisionStartedAt,
      };
    }
    const pickedId = decision.answers.element.choice;
    const picked = elements.find((element) => element.id === pickedId) ?? null;
    const confidence = decision.answers.element.confidence ?? 0;
    context.onDecision?.({
      kind: "browse",
      summary: `step "${goal}" → ${
        picked ? `${picked.role} "${picked.label}"` : "no matching element"
      }`,
      flagged: false,
      latencyMs: Date.now() - decisionStartedAt,
      model: context.decision?.settings.model ?? null,
    });
    if (!picked || confidence < BROWSER_STEP_MIN_CONFIDENCE) {
      return {
        ok: false,
        output: picked
          ? `Jev's best guess was ${picked.selector} (${picked.role} ` +
            `"${picked.label}") at confidence ${confidence.toFixed(2)}, below the ` +
            `${BROWSER_STEP_MIN_CONFIDENCE} floor, so nothing was clicked. Re-aim the ` +
            "goal, or use the browser tool's click action with one of these " +
            `selectors:\n${listText}`
          : `Jev found no element matching "${goal}" ` +
            `(confidence ${confidence.toFixed(2)}). Page elements:\n${listText}`,
        durationMs: Date.now() - decisionStartedAt,
      };
    }

    const text = typeof args.text === "string" ? args.text : "";
    const kind =
      args.kind === "click"
        ? "click"
        : args.kind === "type" || text
          ? "type"
          : "click";
    const acted = await runBrowserAction(
      sandbox,
      botId,
      kind === "type"
        ? {
            action: "type",
            selector: picked.selector,
            text,
            submit: Boolean(args.enter),
          }
        : { action: "click", selector: picked.selector },
      75_000,
    );
    const after = acted.parsed;
    if (!after || after.ok === false) {
      return {
        ok: false,
        output:
          `Jev chose ${picked.selector} (${picked.role} "${picked.label}", ` +
          `confidence ${confidence.toFixed(2)}) but the action failed: ` +
          `${after?.error ?? "unknown error"}`,
        durationMs: acted.durationMs,
      };
    }

    let output =
      `step: ${kind} ${picked.selector} (${picked.role} "${picked.label}", ` +
      `confidence ${confidence.toFixed(2)})\n` +
      `url: ${after.url ?? ""}\ntitle: ${after.title ?? ""}`;
    const pageText = after.text ?? "";
    if (pageText) {
      output += `\ntext:\n${pageText}`;
    }
    const guardrail = context.decision?.settings.guardrail ?? "off";
    if (pageText && guardrail !== "off" && client) {
      const screenStartedAt = Date.now();
      const verdict = await screenUntrustedText({
        client,
        text: pageText,
        ...(context.signal ? { signal: context.signal } : {}),
      }).catch((error) => {
        console.warn(`guardrail check failed: ${(error as Error).message}`);
        return null;
      });
      if (verdict?.flagged) {
        context.onDecision?.({
          kind: "guardrail",
          summary: guardrailSummary(verdict),
          flagged: true,
          latencyMs: Date.now() - screenStartedAt,
          model: context.decision?.settings.model ?? null,
        });
        output =
          guardrail === "block"
            ? `url: ${after.url ?? ""}\ntitle: ${after.title ?? ""}\ntext:\n${GUARDRAIL_BLOCKED}`
            : `${GUARDRAIL_WARNING}\n${output}`;
      }
    }

    return { ok: true, output: truncate(output), durationMs: acted.durationMs };
  },
};

export async function captureScreen(
  sandbox: SandboxBackend,
  botId: string,
): Promise<Buffer> {
  // Capture the display host's desktop, the same one the browser and desktop
  // tools act on. Capturing the microVM's own X display would show a different
  // desktop than the user sees in the panel.
  const result = await sandbox.desktop(botId, { action: "screenshot" });
  if (!result.ok || !result.screenshot) {
    throw new Error(result.error ?? "desktop screen capture failed");
  }
  return Buffer.from(result.screenshot, "base64");
}

const browserTool: Tool = {
  definition: {
    name: "browser",
    description:
      "Control the web browser on your computer. The browser keeps cookies and " +
      "sign-ins between calls. Find things the way a person would: open the " +
      "site, use its own search bar, follow menus and links, check category " +
      "pages and pagination, and try a sitemap (an HTML sitemap page or " +
      "/sitemap.xml) when something is not where you expected — instead of " +
      "guessing deep URLs. Use goto for a URL the user gave you or a site's " +
      "home page, not for invented deep links; when a page is wrong or empty, " +
      "go back and navigate from the page. Navigation and interaction actions " +
      "return the current page text automatically, so inspect that evidence " +
      "before taking the next step; do not immediately call text unless you " +
      "need a focused selector or content beyond the returned preview. " +
      "Actions: goto (url), clickLink (href from links, or index), click " +
      "(selector), type (selector, text, submit), fields (visible inputs and " +
      "buttons with ready selectors), links (optional selector, returns link " +
      "labels and URLs), scroll (pixels, or selector to bring an element into " +
      "view), text (optional selector), screenshot (returns a picture), back, " +
      "wait (selector or milliseconds). For research, collect facts from each " +
      "page and replace blocked, broken, or irrelevant sources before " +
      "answering. If a site serves a bot check, the run pauses and asks the " +
      "user to clear it in the Screen panel, then retries the same action; do " +
      "not retry it in a loop yourself. If the user skips it, prefer another " +
      "source.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "goto",
            "clickLink",
            "click",
            "type",
            "fields",
            "text",
            "links",
            "scroll",
            "screenshot",
            "back",
            "wait",
          ],
        },
        url: { type: "string", description: "URL for the goto action." },
        href: {
          type: "string",
          description: "Link URL from the links action, for clickLink.",
        },
        index: {
          type: "number",
          description: "Link index for clickLink when href is not known.",
        },
        selector: {
          type: "string",
          description: "CSS selector for click, type, wait, text, or scroll.",
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
        pixels: {
          type: "number",
          description:
            "Scroll distance in pixels for the scroll action; positive scrolls " +
            "down. Defaults to 600.",
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
    await ensureGuestSkills(context, sandbox);

    const { parsed, result, durationMs } = await runBrowserAction(
      sandbox,
      browserSandboxId(context),
      {
        action,
        url: args.url,
        selector: args.selector,
        text: args.text,
        submit: args.submit,
        milliseconds: args.milliseconds,
        pixels: args.pixels,
        href: args.href,
        index: args.index,
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
      if (parsed.challenge) {
        return {
          ok: false,
          output:
            `Blocked by a bot check (Cloudflare/Turnstile) at ${parsed.url ?? "the page"}. ` +
            "Do not retry this action in a loop. Ask the user to open the Screen " +
            "panel, complete the check once in the live desktop, and then retry; " +
            "the browser profile keeps the clearance for later actions. " +
            "Prefer another source if the site keeps blocking.",
          durationMs,
          challenge: true,
          challengeUrl: parsed.url ?? null,
        };
      }
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
    const guardrail = context.decision?.settings.guardrail ?? "off";
    const decisionClient = context.decision?.client ?? null;
    if (parsed.text && guardrail !== "off" && decisionClient) {
      const screenStartedAt = Date.now();
      const verdict = await screenUntrustedText({
        client: decisionClient,
        text: parsed.text,
        ...(context.signal ? { signal: context.signal } : {}),
      }).catch((error) => {
        console.warn(
          `guardrail check failed: ${(error as Error).message}`,
        );
        return null;
      });
      if (verdict?.flagged) {
        console.info("guardrail.flagged", {
          botId: context.botId,
          tool: "browser",
          url: parsed.url,
          instructionOverride: verdict.instructionOverride,
          exfiltrationRequest: verdict.exfiltrationRequest,
        });
        context.onDecision?.({
          kind: "guardrail",
          summary: guardrailSummary(verdict),
          flagged: true,
          latencyMs: Date.now() - screenStartedAt,
          model: context.decision?.settings.model ?? null,
        });
        output =
          guardrail === "block"
            ? `url: ${parsed.url ?? ""}\ntitle: ${parsed.title ?? ""}\ntext:\n${GUARDRAIL_BLOCKED}`
            : `${GUARDRAIL_WARNING}\n${output}`;
      }
    }
    const images: ToolImage[] = [];
    if (parsed.screenshot) {
      mkdirSync(context.artifactsDir, { recursive: true });
      const filename = `${randomUUID()}.png`;
      writeFileSync(
        join(context.artifactsDir, filename),
        Buffer.from(parsed.screenshot, "base64"),
      );
      artifacts.push({ type: "image", url: `/artifacts/${filename}` });
      if (context.vision) {
        images.push({ data: parsed.screenshot, mimeType: "image/png" });
        output += `\nscreenshot captured and attached to the conversation`;
      } else {
        output += `\nscreenshot saved (visible to the user in the chat)`;
      }
    }

    return {
      ok: true,
      output: truncate(output),
      durationMs,
      artifacts,
      ...(images.length ? { images } : {}),
    };
  },
};

interface DesktopResult {
  ok?: boolean;
  error?: string;
  detail?: string;
  width?: number;
  height?: number;
  cursor?: { x: number; y: number } | null;
  window?: string | null;
  screenshot?: string;
  durationMs?: number;
}

function optionalNumber(
  value: unknown,
): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const desktopTool: Tool = {
  definition: {
    name: "desktop",
    description:
      "Control the desktop GUI of your computer directly with the mouse and " +
      "keyboard, beyond the browser tool. The desktop is a separate display " +
      "host with its own apps and files: the terminal, file manager, and " +
      "browser windows on screen are not the microVM that shell, read_file, " +
      "and write_file operate on, and software installed there does not appear " +
      "here. To open an app, activate the terminal window on the desktop and " +
      "type its command followed by Return (for example `thunar` opens the " +
      "file manager, `xterm` opens another terminal). Use the desktop for " +
      "native dialogs, drag and drop, context menus, scrolling inside apps, " +
      "the terminal and file manager windows, and anything the browser tool " +
      "cannot reach. The screen is 1280x800; take a screenshot first, then act " +
      "on the coordinates you saw. Every action returns the pointer position, " +
      "the active window, and by default a fresh screenshot. Actions: " +
      "screenshot, move (x, y), click (x, y, button, count), drag (fromX, " +
      "fromY, toX, toY, button, durationMs), scroll (x, y, direction, amount), " +
      "type (text), key (keys, such as Return, ctrl+l, alt+F4, ctrl+shift+t), " +
      "wait (milliseconds), windows (list visible windows), activate (title).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screenshot",
            "move",
            "click",
            "drag",
            "scroll",
            "type",
            "key",
            "wait",
            "windows",
            "activate",
          ],
        },
        x: { type: "number", description: "Pointer x coordinate (0-1279)." },
        y: { type: "number", description: "Pointer y coordinate (0-799)." },
        fromX: { type: "number", description: "Drag start x coordinate." },
        fromY: { type: "number", description: "Drag start y coordinate." },
        toX: { type: "number", description: "Drag end x coordinate." },
        toY: { type: "number", description: "Drag end y coordinate." },
        button: {
          type: "string",
          enum: ["left", "middle", "right"],
          description: "Mouse button (default left).",
        },
        count: {
          type: "number",
          description: "Click count for click, 1-3 (2 is a double click).",
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction.",
        },
        amount: {
          type: "number",
          description: "Scroll steps, 1-50 (default 3).",
        },
        durationMs: {
          type: "number",
          description: "Drag duration in milliseconds (default 400).",
        },
        text: { type: "string", description: "Text to type." },
        keys: {
          type: "string",
          description: "Key combination, such as Return or ctrl+shift+t.",
        },
        milliseconds: {
          type: "number",
          description: "Wait duration for the wait action.",
        },
        title: {
          type: "string",
          description: "Window title substring for the activate action.",
        },
        observe: {
          type: "boolean",
          description:
            "Capture a screenshot after the action (default true). Set " +
            "false only when you do not need to see the result.",
        },
      },
      required: ["action"],
    },
  },
  async execute(context, args) {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (!action) {
      return { ok: false, output: "action is required", durationMs: 0 };
    }
    if (context.computer === "mac") {
      return localResult(
        "the desktop tool needs the Firecracker microVM computer; " +
          "it is not available when this agent uses This Mac. " +
          "Switch this agent's computer to the microVM to use the desktop.",
        false,
        0,
      );
    }
    const sandbox = context.sandbox;
    if (!sandbox) {
      return { ok: false, output: "sandbox is not available", durationMs: 0 };
    }
    await ensureSandbox(context, sandbox);

    const observe = args.observe !== false;
    const startedAt = Date.now();
    const request: DesktopActionRequest = { action, screenshot: observe };
    const numbers = [
      "x",
      "y",
      "fromX",
      "fromY",
      "toX",
      "toY",
      "count",
      "amount",
      "durationMs",
      "milliseconds",
    ] as const;
    for (const key of numbers) {
      const value = optionalNumber(args[key]);
      if (value !== undefined) {
        request[key] = value;
      }
    }
    for (const key of ["button", "direction", "text", "keys", "title"] as const) {
      const value = args[key];
      if (typeof value === "string") {
        request[key] = value;
      }
    }
    const response = (await sandbox.desktop(
      sandboxId(context),
      request,
    )) as DesktopResult;

    if (response.ok === false) {
      return {
        ok: false,
        output: `desktop error: ${response.error ?? "unknown error"}`,
        durationMs: response.durationMs ?? Date.now() - startedAt,
      };
    }

    let output = response.detail ?? action;
    if (response.width && response.height) {
      output += `\nscreen: ${response.width}x${response.height}`;
    }
    if (response.cursor) {
      output += `\npointer: ${response.cursor.x},${response.cursor.y}`;
    }
    if (response.window) {
      output += `\nactive window: ${response.window}`;
    }

    const artifacts: ToolArtifact[] = [];
    const images: ToolImage[] = [];
    if (response.screenshot) {
      mkdirSync(context.artifactsDir, { recursive: true });
      const filename = `${randomUUID()}.png`;
      writeFileSync(
        join(context.artifactsDir, filename),
        Buffer.from(response.screenshot, "base64"),
      );
      artifacts.push({ type: "image", url: `/artifacts/${filename}` });
      if (context.vision) {
        images.push({ data: response.screenshot, mimeType: "image/png" });
        output += "\nscreenshot captured and attached to the conversation";
      } else {
        output +=
          "\nscreenshot saved (visible to the user in the chat); this model " +
          "is not known to accept images, so the screenshot was not sent to " +
          "you. Use text observations (windows, cursor, page text) instead.";
      }
    }

    return {
      ok: true,
      output: truncate(output),
      durationMs: response.durationMs ?? Date.now() - startedAt,
      ...(artifacts.length ? { artifacts } : {}),
      ...(images.length ? { images } : {}),
    };
  },
};

const browseTool: Tool = {
  definition: {
    name: "browse",
    description:
      "Research a goal across multiple pages with the browser on your " +
      "computer. The harness drives navigation itself: it reads the current " +
      "page, follows links that make progress, and stops when the collected " +
      "evidence answers the goal or the step budget runs out. One approval " +
      "covers the whole run, and the result is the evidence collected. Use it " +
      "for multi-page research; it cannot type into forms or sign in, so use " +
      "the browser tool for those. If the run stops on a bot check, ask the " +
      "user to complete it in the Screen panel once, or pick another source. " +
      "Provide goal, and optionally startUrl and maxSteps (default 8, max 20).",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "What to find out, including every fact or constraint to verify.",
        },
        startUrl: {
          type: "string",
          description:
            "Page to start from. Defaults to the browser's current page.",
        },
        maxSteps: {
          type: "number",
          description: "Maximum links to follow (default 8, max 20).",
        },
      },
      required: ["goal"],
    },
  },
  async execute(context, args) {
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (!goal) {
      return { ok: false, output: "goal is required", durationMs: 0 };
    }
    if (context.computer === "mac") {
      return localResult(
        "the browse tool needs the Firecracker microVM computer; " +
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
    const client = context.decision?.client ?? null;
    if (!client) {
      return {
        ok: false,
        output:
          "the browse tool needs the Jev decision model; enable it in " +
          "Settings under Decision model.",
        durationMs: 0,
      };
    }
    await ensureSandbox(context, sandbox);

    const startUrl =
      typeof args.startUrl === "string" && args.startUrl.trim()
        ? args.startUrl.trim()
        : undefined;
    const requestedSteps = Number(args.maxSteps ?? BROWSE_MAX_STEPS_DEFAULT);
    const maxSteps = Number.isFinite(requestedSteps)
      ? Math.min(Math.max(Math.round(requestedSteps), 1), BROWSE_MAX_STEPS_CAP)
      : BROWSE_MAX_STEPS_DEFAULT;

    const result = await runBrowseLoop({
      sandbox,
      botId: browserSandboxId(context),
      client,
      goal,
      ...(startUrl ? { startUrl } : {}),
      maxSteps,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.onDecision ? { onDecision: context.onDecision } : {}),
      screenPage: async (page) => {
        const guardrail = context.decision?.settings.guardrail ?? "off";
        if (guardrail === "off" || !page.text) {
          return null;
        }
        try {
          const screenStartedAt = Date.now();
          const verdict = await screenUntrustedText({
            client,
            text: page.text,
            ...(context.signal ? { signal: context.signal } : {}),
          });
          if (!verdict.flagged) {
            return null;
          }
          console.info("guardrail.flagged", {
            botId: context.botId,
            tool: "browse",
            url: page.url,
            instructionOverride: verdict.instructionOverride,
            exfiltrationRequest: verdict.exfiltrationRequest,
          });
          context.onDecision?.({
            kind: "guardrail",
            summary: guardrailSummary(verdict),
            flagged: true,
            latencyMs: Date.now() - screenStartedAt,
            model: context.decision?.settings.model ?? null,
          });
          return guardrail === "block"
            ? GUARDRAIL_BLOCKED
            : `${GUARDRAIL_WARNING}\n${page.text}`;
        } catch (error) {
          console.warn(
            `guardrail check failed: ${(error as Error).message}`,
          );
          return null;
        }
      },
    });

    const finalPage = result.pages.at(-1);
    let output =
      `browse stopped: ${result.stoppedBy} ` +
      `(${result.pages.length} pages, ${result.decisionCalls} decisions)`;
    if (result.error) {
      output += `\nerror: ${result.error}`;
    }
    if (finalPage) {
      output += `\nurl: ${finalPage.url}\ntitle: ${finalPage.title}`;
    }
    if (result.pages.length > 0) {
      output += `\n\n${renderBrowseEvidence(result.pages)}`;
    } else {
      output += "\nno pages were collected";
    }

    return {
      ok: result.ok,
      output: truncate(output),
      durationMs: result.durationMs,
    };
  },
};

function orchestratorUnavailable(): ToolExecutionResult {
  return {
    ok: false,
    output: "The team orchestrator is not available in this configuration.",
    durationMs: 0,
  };
}

function formatElapsed(from: string, to: string | null): string {
  const ms = Math.max(
    0,
    new Date(to ?? new Date().toISOString()).getTime() -
      new Date(from).getTime(),
  );
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.round(minutes / 60)}h`;
}

const listRolesTool: Tool = {
  definition: {
    name: "list_roles",
    description:
      "List the team roles available to delegate work to. Returns each role's " +
      "name and id, specialty, model, computer, and whether it is busy. Use it " +
      "before spawn_worker when you do not already know the right role id.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  async execute(context) {
    const orchestrator = context.orchestrator;
    if (!orchestrator) {
      return orchestratorUnavailable();
    }
    const roles = orchestrator.listRoles();
    if (roles.length === 0) {
      return {
        ok: true,
        output:
          "No team roles yet. The user can create a role in the app's Team section.",
        durationMs: 0,
      };
    }
    const lines = roles.map((role) => {
      const specialty = role.role?.trim() ? ` — ${role.role.trim()}` : "";
      const busy = role.busyTaskId
        ? `busy with "${role.busyTaskTitle ?? "a task"}"`
        : "idle";
      const capability = role.delegates ? "manager (can delegate)" : "worker";
      return `- ${role.name} (id: ${role.id})${specialty} · ${capability} · model ${role.model.provider}/${role.model.model} · computer ${role.computer ?? "firecracker"} · ${busy}`;
    });
    return { ok: true, output: lines.join("\n"), durationMs: 0 };
  },
};

const spawnWorkerTool: Tool = {
  definition: {
    name: "spawn_worker",
    description:
      "Delegate a task to a team role. The worker runs in its own computer and " +
      "reports back with a result and evidence; you will be notified when it " +
      "finishes, so keep helping the user in the meantime. Write the brief so a " +
      "teammate with no memory of this conversation can complete it: objective, " +
      "constraints, deliverable shape, and what counts as done. Roles marked " +
      "manager (see list_roles) can delegate further; their final message is " +
      "the project report. The grant is the approval unit: when the user has " +
      "approvals on, approving this call authorizes the grant's tools and " +
      "budget for the whole task. A manager can only allocate tools and budget " +
      "that fit inside its own grant. Prefer delegating long, parallel, or " +
      "risky work and do quick lookups yourself.",
    parameters: {
      type: "object",
      properties: {
        roleId: {
          type: "string",
          description: "The id of the role to delegate to (see list_roles).",
        },
        brief: {
          type: "string",
          description:
            "The complete task brief: objective, constraints, deliverable " +
            "shape, and what counts as done.",
        },
        title: {
          type: "string",
          description:
            "Short task title for the workboard (defaults to the first line of the brief).",
        },
        display: {
          type: "string",
          enum: ["none", "browser", "desktop"],
          description:
            "What the worker may use to see: none (headless, default), browser " +
            "(a browser view), or desktop (a full desktop for native GUI work).",
        },
        grant: {
          type: "object",
          description:
            "The task grant: which tools the worker may use without asking " +
            "again, and its budget. Omit it for the default grant — the " +
            "default budget is generous, so only set limits when the user " +
            "asked for them or the task is clearly small.",
          properties: {
            tools: {
              type: "array",
              items: { type: "string" },
              description:
                "Tool names the worker may use (shell, read_file, write_file, " +
                "browser, browse, desktop). Defaults to all tools the role's " +
                "computer supports.",
            },
            budget: {
              type: "object",
              properties: {
                wallClockMs: { type: "number" },
                tokens: { type: "number" },
                toolCalls: { type: "number" },
              },
            },
          },
        },
      },
      required: ["roleId", "brief"],
    },
  },
  async execute(context, args) {
    const orchestrator = context.orchestrator;
    if (!orchestrator) {
      return orchestratorUnavailable();
    }
    const roleId = typeof args.roleId === "string" ? args.roleId.trim() : "";
    const brief = typeof args.brief === "string" ? args.brief.trim() : "";
    const title = typeof args.title === "string" ? args.title.trim() : undefined;
    const display: TaskDisplay | undefined =
      args.display === "browser" || args.display === "desktop"
        ? (args.display as TaskDisplay)
        : undefined;
    const grantArg =
      typeof args.grant === "object" && args.grant !== null
        ? (args.grant as Record<string, unknown>)
        : null;
    const tools = Array.isArray(grantArg?.tools)
      ? grantArg.tools.filter((tool): tool is string => typeof tool === "string")
      : undefined;
    const budgetArg =
      typeof grantArg?.budget === "object" && grantArg.budget !== null
        ? (grantArg.budget as Record<string, unknown>)
        : null;
    const numberOrNull = (value: unknown): number | null | undefined => {
      if (value === null) {
        return null;
      }
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    };
    const grant = grantArg
      ? {
          tools,
          display,
          budget: budgetArg
            ? {
                wallClockMs: numberOrNull(budgetArg.wallClockMs),
                tokens: numberOrNull(budgetArg.tokens),
                toolCalls: numberOrNull(budgetArg.toolCalls),
              }
            : undefined,
        }
      : undefined;
    if (!roleId || !brief) {
      return {
        ok: false,
        output: "roleId and brief are required.",
        durationMs: 0,
      };
    }
    try {
      const task = orchestrator.spawn({
        callerBotId: context.botId,
        parentTaskId: context.taskId,
        roleId,
        brief,
        title,
        display,
        grant,
      });
      return {
        ok: true,
        output:
          `Task created for ${task.roleName}: "${task.title}" (id: ${task.id}).\n` +
          (task.queued
            ? "The role is busy, so the task is queued and will start when it frees up."
            : "The worker is running now.") +
          " You will be notified when it finishes; keep going in the meantime.",
        durationMs: 0,
      };
    } catch (error) {
      return { ok: false, output: (error as Error).message, durationMs: 0 };
    }
  },
};

const workerStatusTool: Tool = {
  definition: {
    name: "worker_status",
    description:
      "Check on team tasks: status, elapsed time, result summary, or error. " +
      "Omit taskId to see all active and recent tasks. Use it to answer the " +
      "user about work in progress.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "A specific task id (optional).",
        },
      },
      required: [],
    },
  },
  async execute(context, args) {
    const orchestrator = context.orchestrator;
    if (!orchestrator) {
      return orchestratorUnavailable();
    }
    const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
    const all = orchestrator.status(taskId || undefined);
    // A manager's own request is "running" for as long as it works; listing it
    // in the overview reads as a stuck sibling. Keep it only when asked for by
    // id.
    const tasks = taskId
      ? all
      : all.filter((task) => task.id !== context.taskId);
    if (tasks.length === 0) {
      return {
        ok: true,
        output:
          taskId || all.length === 0
            ? "No team tasks yet."
            : "No other team tasks are active; this request is the only thing running.",
        durationMs: 0,
      };
    }
    const lines = tasks.map((task) => {
      const elapsed = task.endedAt
        ? `took ${formatElapsed(task.startedAt ?? task.createdAt, task.endedAt)}`
        : task.startedAt
          ? `running ${formatElapsed(task.startedAt, null)}`
          : "queued";
      const head = `- "${task.title}" (id: ${task.id}) · ${task.roleName} · ${task.status} · ${elapsed}`;
      if (task.status === "done" && task.result) {
        const excerpt =
          task.result.length > 400
            ? `${task.result.slice(0, 400)}…`
            : task.result;
        return `${head}\n  result: ${excerpt.replace(/\n/g, "\n  ")}`;
      }
      if (task.status === "failed" && task.error) {
        return `${head}\n  error: ${task.error}`;
      }
      return head;
    });
    return { ok: true, output: lines.join("\n"), durationMs: 0 };
  },
};

const cancelWorkerTool: Tool = {
  definition: {
    name: "cancel_worker",
    description:
      "Cancel a running team task by id. The worker stops and its partial " +
      "results stay in the task transcript.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task id to cancel." },
      },
      required: ["taskId"],
    },
  },
  async execute(context, args) {
    const orchestrator = context.orchestrator;
    if (!orchestrator) {
      return orchestratorUnavailable();
    }
    const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
    if (!taskId) {
      return { ok: false, output: "taskId is required.", durationMs: 0 };
    }
    const cancelled = orchestrator.cancel(taskId);
    return {
      ok: cancelled,
      output: cancelled
        ? `Task ${taskId} is being cancelled.`
        : `No running task found with id ${taskId}.`,
      durationMs: 0,
    };
  },
};

const listProjectsTool: Tool = {
  definition: {
    name: "list_projects",
    description:
      "List the projects the user already has. A project is a persistent " +
      "manager with its own computer that keeps that topic's context and " +
      "assets. Check this before creating anything: when a request matches an " +
      "existing project's scope, send it there with ask_project instead of " +
      "creating a new project.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  async execute(context) {
    const orchestrator = context.orchestrator;
    if (!orchestrator) {
      return orchestratorUnavailable();
    }
    const projects = orchestrator.listProjects();
    if (projects.length === 0) {
      return {
        ok: true,
        output:
          "No projects yet. Create one with create_project when the user asks " +
          "for something that will need ongoing or detailed work.",
        durationMs: 0,
      };
    }
    const lines = projects.map((project) => {
      const scope = project.scope?.trim() ? ` — ${project.scope.trim()}` : "";
      const status =
        project.status === "working"
          ? `working on "${project.activeTaskTitle ?? "a request"}"`
          : "idle";
      const open =
        project.openTasks > 0 ? ` · ${project.openTasks} open` : "";
      return `- ${project.name} (id: ${project.id})${scope} · ${status}${open}`;
    });
    return { ok: true, output: lines.join("\n"), durationMs: 0 };
  },
};

const createProjectTool: Tool = {
  definition: {
    name: "create_project",
    description:
      "Create a new project: a persistent manager with its own computer that " +
      "keeps the project's context and assets across requests. Only create a " +
      "project when list_projects has nothing that matches the user's request. " +
      "Name it after the thing being worked on (for example \"Buddy Weather\") " +
      "and give a one-line scope. The project owns all future work on that " +
      "topic; you route to it with ask_project.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short project name, for example \"Buddy Weather\".",
        },
        scope: {
          type: "string",
          description:
            "One line describing what this project is responsible for.",
        },
        brief: {
          type: "string",
          description:
            "Optional context for the project manager: what the user is " +
            "building, constraints, and any assets that already exist.",
        },
        model: {
          type: "object",
          description:
            "Optional model for the project manager (provider and model).",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
          },
        },
      },
      required: ["name", "scope"],
    },
  },
  async execute(context, args) {
    const orchestrator = context.orchestrator;
    if (!orchestrator) {
      return orchestratorUnavailable();
    }
    if (context.taskId) {
      return {
        ok: false,
        output:
          "Only the lead can create projects. Ask the lead to create it.",
        durationMs: 0,
      };
    }
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const scope = typeof args.scope === "string" ? args.scope.trim() : "";
    const brief = typeof args.brief === "string" ? args.brief.trim() : undefined;
    const modelArg =
      typeof args.model === "object" && args.model !== null
        ? (args.model as Record<string, unknown>)
        : null;
    const model =
      modelArg &&
      typeof modelArg.provider === "string" &&
      typeof modelArg.model === "string"
        ? { provider: modelArg.provider, model: modelArg.model }
        : undefined;
    if (!name || !scope) {
      return {
        ok: false,
        output: "name and scope are required.",
        durationMs: 0,
      };
    }
    try {
      const project = orchestrator.createProject({
        callerBotId: context.botId,
        name,
        scope,
        brief,
        model,
      });
      return {
        ok: true,
        output:
          `Project created: ${project.name} (id: ${project.id}).\n` +
          "It has its own computer and keeps this topic's context. Send the " +
          "user's request with ask_project.",
        durationMs: 0,
      };
    } catch (error) {
      return { ok: false, output: (error as Error).message, durationMs: 0 };
    }
  },
};

const askProjectTool: Tool = {
  definition: {
    name: "ask_project",
    description:
      "Send a request to an existing project's manager. The manager works on " +
      "its own computer, can delegate to workers, and reports back; you will " +
      "be notified when it finishes, so keep helping the user in the " +
      "meantime. Write the request so the manager can act without this " +
      "conversation: what the user wants, constraints, and the deliverable.",
    parameters: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The project id (see list_projects).",
        },
        request: {
          type: "string",
          description:
            "The complete request: what the user wants, constraints, and " +
            "what the deliverable is.",
        },
        title: {
          type: "string",
          description:
            "Short request title for the workboard (defaults to the first line).",
        },
        grant: {
          type: "object",
          description:
            "Optional budget for the request. The manager allocates tools and " +
            "budget to workers inside it.",
          properties: {
            budget: {
              type: "object",
              properties: {
                wallClockMs: { type: "number" },
                tokens: { type: "number" },
                toolCalls: { type: "number" },
              },
            },
          },
        },
      },
      required: ["projectId", "request"],
    },
  },
  async execute(context, args) {
    const orchestrator = context.orchestrator;
    if (!orchestrator) {
      return orchestratorUnavailable();
    }
    const projectId =
      typeof args.projectId === "string" ? args.projectId.trim() : "";
    const request = typeof args.request === "string" ? args.request.trim() : "";
    const title = typeof args.title === "string" ? args.title.trim() : undefined;
    const grantArg =
      typeof args.grant === "object" && args.grant !== null
        ? (args.grant as Record<string, unknown>)
        : null;
    const budgetArg =
      typeof grantArg?.budget === "object" && grantArg.budget !== null
        ? (grantArg.budget as Record<string, unknown>)
        : null;
    const numberOrNull = (value: unknown): number | null | undefined => {
      if (value === null) {
        return null;
      }
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    };
    const grant = budgetArg
      ? {
          budget: {
            wallClockMs: numberOrNull(budgetArg.wallClockMs),
            tokens: numberOrNull(budgetArg.tokens),
            toolCalls: numberOrNull(budgetArg.toolCalls),
          },
        }
      : undefined;
    if (!projectId || !request) {
      return {
        ok: false,
        output: "projectId and request are required.",
        durationMs: 0,
      };
    }
    try {
      const task = orchestrator.askProject({
        callerBotId: context.botId,
        projectId,
        request,
        title,
        grant,
      });
      return {
        ok: true,
        output:
          `Request sent to ${task.roleName}: "${task.title}" (id: ${task.id}).\n` +
          (task.queued
            ? "The project is busy, so the request is queued and will start when it frees up."
            : "The project manager is working on it now.") +
          " You will be notified when it finishes.",
        durationMs: 0,
      };
    } catch (error) {
      return { ok: false, output: (error as Error).message, durationMs: 0 };
    }
  },
};

function memoryUnavailable(): ToolExecutionResult {
  return {
    ok: false,
    output: "Memory is not available in this configuration.",
    durationMs: 0,
  };
}

const MEMORY_TYPES = new Set(["semantic", "relational", "procedural", "episodic"]);

const rememberTool: Tool = {
  definition: {
    name: "remember",
    description:
      "Save a durable memory: a fact about the user, a preference for how you " +
      "should work with them, a reusable procedure, or a notable event. Use it " +
      "when the user tells you something worth keeping, corrects you, or when " +
      "you learn something that should change future work. Do not save " +
      "transient chatter or one-off task details.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "One self-contained sentence.",
        },
        type: {
          type: "string",
          enum: ["semantic", "relational", "procedural", "episodic"],
        },
        importance: {
          type: "number",
          description: "0..1, how much this should matter later (default 0.5).",
        },
        confidence: {
          type: "number",
          description: "0..1, how sure you are (default 0.8).",
        },
      },
      required: ["content"],
    },
  },
  async execute(context, args) {
    const memory = context.memory;
    if (!memory) {
      return memoryUnavailable();
    }
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (content.length < 4) {
      return { ok: false, output: "content is required.", durationMs: 0 };
    }
    const type =
      typeof args.type === "string" && MEMORY_TYPES.has(args.type)
        ? (args.type as "semantic" | "relational" | "procedural" | "episodic")
        : "semantic";
    const importance =
      typeof args.importance === "number"
        ? Math.min(1, Math.max(0, args.importance))
        : 0.5;
    const confidence =
      typeof args.confidence === "number"
        ? Math.min(1, Math.max(0, args.confidence))
        : 0.8;
    const saved = await memory.remember({
      scope: context.memoryScope ?? "user",
      type,
      content,
      importance,
      confidence,
      source: context.taskId ? "project" : "lead",
    });
    return {
      ok: true,
      output: `Saved memory ${saved.id.slice(0, 8)} (${saved.type}): ${saved.content}`,
      durationMs: 0,
    };
  },
};

const recallTool: Tool = {
  definition: {
    name: "recall",
    description:
      "Search your durable memories. Use it when the user references earlier " +
      "work, a preference, or a project you may already know about, or before " +
      "answering something that may have been settled before.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        limit: {
          type: "number",
          description: "Maximum memories to return (default 8).",
        },
      },
      required: ["query"],
    },
  },
  async execute(context, args) {
    const memory = context.memory;
    if (!memory) {
      return memoryUnavailable();
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, output: "query is required.", durationMs: 0 };
    }
    const limit =
      typeof args.limit === "number"
        ? Math.min(20, Math.max(1, Math.round(args.limit)))
        : 8;
    const scope = context.memoryScope ?? "user";
    const scopes = scope === "user" ? ["user"] : [scope, "user"];
    const hits = await memory.recall(query, { scopes, limit });
    if (hits.length === 0) {
      return { ok: true, output: "No matching memories.", durationMs: 0 };
    }
    const lines = hits.map(
      (hit) =>
        `- [m:${hit.memory.id.slice(0, 8)}] (${hit.memory.type}, ` +
        `${hit.memory.confidence.toFixed(2)}, score ${hit.score.toFixed(2)}) ` +
        hit.memory.content,
    );
    return { ok: true, output: lines.join("\n"), durationMs: 0 };
  },
};

const forgetTool: Tool = {
  definition: {
    name: "forget",
    description:
      "Archive a memory that is wrong or no longer true. Use the memory id " +
      "from recall.",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "The memory id to archive." },
      },
      required: ["memoryId"],
    },
  },
  async execute(context, args) {
    const memory = context.memory;
    if (!memory) {
      return memoryUnavailable();
    }
    const memoryId =
      typeof args.memoryId === "string" ? args.memoryId.trim() : "";
    if (!memoryId) {
      return { ok: false, output: "memoryId is required.", durationMs: 0 };
    }
    const archived = memory.forget(memoryId);
    return {
      ok: archived,
      output: archived
        ? `Archived memory ${memoryId.slice(0, 8)}.`
        : `No active memory with id ${memoryId}.`,
      durationMs: 0,
    };
  },
};

const updateSoulTool: Tool = {
  definition: {
    name: "update_soul",
    description:
      "Update your soul: voice, commitments, and relationship. Use it when " +
      "the user changes how they want you to work, or when a lasting " +
      "commitment is made. Send only the parts that changed; every version is " +
      "kept and the user can revert.",
    parameters: {
      type: "object",
      properties: {
        voice: { type: "string", description: "How you should sound." },
        commitments: {
          type: "array",
          items: { type: "string" },
          description: "The full commitments list after the change.",
        },
        relationship: {
          type: "string",
          description: "What the working relationship is.",
        },
        reason: {
          type: "string",
          description: "Short reason for this change.",
        },
      },
      required: [],
    },
  },
  async execute(context, args) {
    const soul = context.soul;
    if (!soul) {
      return memoryUnavailable();
    }
    if (context.taskId) {
      return {
        ok: false,
        output: "Only the lead can update the soul.",
        durationMs: 0,
      };
    }
    const current = soul.current(context.botId);
    const commitments = Array.isArray(args.commitments)
      ? args.commitments.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : current.content.commitments;
    const version = soul.apply(
      context.botId,
      {
        voice:
          typeof args.voice === "string"
            ? args.voice
            : current.content.voice,
        commitments,
        relationship:
          typeof args.relationship === "string"
            ? args.relationship
            : current.content.relationship,
      },
      typeof args.reason === "string" ? args.reason : "lead update",
      "lead",
    );
    return {
      ok: true,
      output: `Soul updated to version ${version.version}.`,
      durationMs: 0,
    };
  },
};

const ORCHESTRATION_TOOL_NAMES = new Set([
  "list_roles",
  "spawn_worker",
  "worker_status",
  "cancel_worker",
  "list_projects",
  "create_project",
  "ask_project",
]);

// Reads never need approval; the tools that create or change work do.
const READ_ONLY_ORCHESTRATION_TOOL_NAMES = new Set([
  "list_roles",
  "worker_status",
  "list_projects",
]);

const MEMORY_TOOL_NAMES = new Set([
  "remember",
  "recall",
  "forget",
  "update_soul",
]);

export const tools: Tool[] = [
  shellTool,
  readFileTool,
  writeFileTool,
  browserTool,
  browserExecuteTool,
  browserStepTool,
  desktopTool,
  browseTool,
  listRolesTool,
  spawnWorkerTool,
  workerStatusTool,
  cancelWorkerTool,
  listProjectsTool,
  createProjectTool,
  askProjectTool,
  rememberTool,
  recallTool,
  forgetTool,
  updateSoulTool,
];

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
  options: { browse?: boolean; delegate?: boolean } = {},
): ToolDefinition[] {
  const browse = Boolean(options.browse) && computer !== "mac";
  const delegate = Boolean(options.delegate);
  return tools
    .filter((tool) => {
      const name = tool.definition.name;
      if (name === "browse") {
        return browse;
      }
      if (ORCHESTRATION_TOOL_NAMES.has(name) || MEMORY_TOOL_NAMES.has(name)) {
        return delegate;
      }
      return true;
    })
    .map((tool) =>
      computer === "mac"
        ? (LOCAL_DEFINITIONS[tool.definition.name] ?? tool.definition)
        : tool.definition,
    );
}

export function findTool(name: string): Tool | undefined {
  return tools.find((tool) => tool.definition.name === name);
}
