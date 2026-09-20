import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ToolDefinition } from "@openbot/gateway";
import { choice } from "@openbot/gateway";
import type {
  AccessMode,
  ComputerKind,
  FileChange,
  ModelRef,
  PlanStep,
  PolicySettings,
  ReasoningEffort,
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
import { lineDiff } from "./diff";
import {
  collectSelfInfo,
  renderSelfInfo,
  type SelfInfo,
} from "./self";
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
import { CODE_TOOLS_SOURCE } from "./code-tools.generated";
import {
  runWebSearch,
  selectWebSearchProvider,
  webSearchProviderLabel,
  WEB_SEARCH_DEFAULT_RESULTS,
} from "./websearch";

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
  /** Files this call changed, for the app's changed-files card. */
  changes?: FileChange[];
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
  /** Every computer this agent may act on; defaults to [computer]. */
  computers?: ComputerKind[];
  /** How far the agent's local file tools may reach (ADR-023). */
  access?: AccessMode;
  /** What the daemon knows about itself, for the system_info tool. */
  self?: SelfInfo;
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
  /** Persist the thread's working plan (the update_plan tool). */
  updatePlan?: (plan: PlanStep[]) => void;
  /** Content hashes of files read this turn, keyed by path+window. */
  readCache?: Map<string, string>;
}

export function computerLabel(kind: ComputerKind): string {
  return kind === "mac" ? "This Mac" : "the Firecracker microVM";
}

/**
 * Resolve which computer a call acts on: the explicit `computer` argument when
 * the agent has that computer, otherwise the agent's primary. An unavailable
 * computer is an error the model can correct instead of a silent fallback
 * (ADR-021).
 */
export function resolveToolComputer(
  context: ToolContext,
  args: Record<string, unknown>,
): { computer: ComputerKind; error: string | null } {
  const allowed =
    context.computers && context.computers.length > 0
      ? context.computers
      : [context.computer];
  const requested =
    args.computer === "mac" || args.computer === "firecracker"
      ? args.computer
      : null;
  if (requested && !allowed.includes(requested)) {
    return {
      computer: context.computer,
      error:
        `This agent does not have ${computerLabel(requested)}. ` +
        `Available: ${allowed.map(computerLabel).join(" and ")}.`,
    };
  }
  return { computer: requested ?? context.computer, error: null };
}

/**
 * The computer a call targets for policy purposes: the requested one when the
 * agent has it, otherwise the primary. The execute path rejects a computer the
 * agent does not have; policy only needs the tier and scope.
 */
export function callComputer(
  computers: ComputerKind[],
  primary: ComputerKind,
  args: Record<string, unknown>,
): ComputerKind {
  const requested =
    args.computer === "mac" || args.computer === "firecracker"
      ? args.computer
      : null;
  if (!requested) {
    return primary;
  }
  return computers.includes(requested) ? requested : primary;
}

export interface RoleSummary {
  id: string;
  name: string;
  role: string | null;
  model: ModelRef;
  computer: string | null;
  computers: ComputerKind[];
  access: AccessMode;
  workspaceId: string | null;
  workspace: string | null;
  delegates: boolean;
  busyTaskId: string | null;
  busyTaskTitle: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  root: string;
  markers: string[];
  missing: boolean;
  agentCount: number;
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
  listWorkspaces(): WorkspaceSummary[];
  createProject(input: {
    callerBotId: string;
    name: string;
    scope: string;
    brief?: string;
    model?: ModelRef;
    computers?: ComputerKind[];
    workspaceId?: string | null;
    access?: AccessMode;
  }): ProjectSummary;
  createWorker(input: {
    callerBotId: string;
    name: string;
    specialty: string;
    instructions?: string;
    model?: ModelRef;
    computers?: ComputerKind[];
    workspaceId?: string | null;
    access?: AccessMode;
  }): { role: RoleSummary; created: boolean };
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
    name === "system_info" ||
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

const SPILL_DIR = "/root/.openbot-spill";

/**
 * When a command's transcript is longer than the model can read in one tool
 * result, keep the whole thing in the computer's filesystem and hand back the
 * path: nothing is lost and the model can page through it with read_file.
 */
async function spillOutput(
  context: ToolContext,
  result: { exit: number; stdout: string; stderr: string },
): Promise<string | null> {
  const name = `spill-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
  const body =
    `exit code: ${result.exit}\n` +
    `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`;
  try {
    if (context.computer === "mac") {
      const dir =
        accessMode(context) === "project"
          ? join(ensureWorkspace(context.workspaceDir), ".openbot-spill")
          : join(context.artifactsDir, "spill");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, name);
      writeFileSync(file, body, "utf8");
      return file;
    }
    const sandbox = context.sandbox;
    if (!sandbox) {
      return null;
    }
    const target = `${SPILL_DIR}/${name}`;
    const encoded = Buffer.from(body, "utf8").toString("base64");
    const written = await sandbox.exec(sandboxId(context), {
      command:
        `mkdir -p ${shellQuote(SPILL_DIR)} && ` +
        `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`,
      cwd: "/",
      timeoutMs: 15_000,
    });
    return written.exit === 0 ? target : null;
  } catch (error) {
    console.warn(`could not spill output: ${(error as Error).message}`);
    return null;
  }
}

async function formatWithSpill(
  context: ToolContext,
  result: { exit: number; stdout: string; stderr: string },
): Promise<string> {
  const formatted = formatExecResult(result);
  if (formatted.length <= MAX_OUTPUT) {
    return formatted;
  }
  const path = await spillOutput(context, result);
  const note = path
    ? `\n[output truncated at ${MAX_OUTPUT} characters; the full output is saved at ${path} — read it with read_file]`
    : `\n[output truncated at ${MAX_OUTPUT} characters]`;
  return `${formatted.slice(0, MAX_OUTPUT)}${note}`;
}

async function runCommand(
  context: ToolContext,
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<ToolExecutionResult> {
  if (context.computer === "mac") {
    const base =
      accessMode(context) === "project"
        ? ensureWorkspace(context.workspaceDir)
        : homedir();
    const resolvedCwd = resolveLocalCwd(base, cwd || base);
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
      await formatWithSpill(context, result),
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
    output: await formatWithSpill(context, result),
    durationMs: Date.now() - startedAt,
  };
}

export interface RawExecResult {
  exit: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Run a command and hand back its raw streams. `runCommand` formats a terminal
 * transcript for the model to read; the code tools need untouched stdout so
 * they can slice lines, count matches, and parse paths.
 */
async function runCapture(
  context: ToolContext,
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<RawExecResult> {
  const startedAt = Date.now();
  if (context.computer === "mac") {
    const base =
      accessMode(context) === "project"
        ? ensureWorkspace(context.workspaceDir)
        : homedir();
    const resolvedCwd = resolveLocalCwd(base, cwd || base);
    if (resolvedCwd.error || !resolvedCwd.path) {
      return {
        exit: 1,
        stdout: "",
        stderr: resolvedCwd.error ?? "invalid cwd",
        durationMs: 0,
      };
    }
    const result = await execLocal(
      command,
      resolvedCwd.path,
      timeoutSeconds * 1000,
    );
    return {
      exit: result.exit,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  }

  const sandbox = context.sandbox;
  if (!sandbox) {
    return {
      exit: 1,
      stdout: "",
      stderr: "sandbox is not available",
      durationMs: 0,
    };
  }
  await ensureGuestWorkspace(context, sandbox);
  const result = await sandbox.exec(sandboxId(context), {
    command,
    cwd: cwd || context.guestCwd,
    timeoutMs: timeoutSeconds * 1000,
  });
  return {
    exit: result.exit,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt,
  };
}

/** Resolve a tool path against the computer that owns it. */
function resolveToolPath(
  context: ToolContext,
  path: string,
): { path: string | null; error: string | null } {
  if (context.computer === "mac") {
    return resolveLocalPath(context, path);
  }
  // The guest has no confinement, so a relative path is taken from the
  // session's working directory rather than the process's.
  return {
    path: path.startsWith("/") ? path : join(codeRoot(context), path),
    error: null,
  };
}

function accessMode(context: ToolContext): AccessMode {
  return context.access ?? "project";
}

/**
 * Resolve a local path for the agent's access mode: confined to the project
 * folder, to the home folder, or free (ADR-023).
 */
function resolveLocalPath(
  context: ToolContext,
  path: string,
): { path: string | null; error: string | null } {
  const access = accessMode(context);
  if (access === "full") {
    return {
      path: isAbsolute(path) ? resolve(path) : resolve(homedir(), path),
      error: null,
    };
  }
  if (access === "home") {
    return resolveWorkspacePath(homedir(), path);
  }
  ensureWorkspace(context.workspaceDir);
  return resolveWorkspacePath(context.workspaceDir, path);
}

/** The Mac folder the agent starts from for the current access mode. */
function macBase(context: ToolContext): string {
  return accessMode(context) === "project" ? context.workspaceDir : homedir();
}

/** The directory a code tool starts from when the model gives no path. */
function codeRoot(context: ToolContext): string {
  if (context.computer === "mac") {
    return macBase(context);
  }
  return context.guestCwd ?? "/root";
}

function codeCwd(context: ToolContext): string {
  return context.computer === "mac" ? macBase(context) : "/root";
}

const CODE_TOOL_HELPER_NAME = "openbot-code-tools.mjs";
const codeToolHelpers = new Map<string, Promise<string>>();

/**
 * Write the grep/glob helper into the agent's computer and return its path.
 * One copy per computer, best effort: a failure here surfaces as a tool error
 * rather than being cached as broken.
 */
export async function ensureCodeToolHelper(
  context: ToolContext,
  sandbox: SandboxBackend | null,
): Promise<string> {
  if (context.computer === "mac") {
    const dir = join(tmpdir(), "openbot-code-tools");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, CODE_TOOL_HELPER_NAME);
    writeFileSync(file, CODE_TOOLS_SOURCE, "utf8");
    return file;
  }
  if (!sandbox) {
    throw new Error("sandbox is not available");
  }
  const id = sandboxId(context);
  const existing = codeToolHelpers.get(id);
  if (existing) {
    return existing;
  }
  const task = (async () => {
    await ensureSandbox(context, sandbox);
    const target = `/tmp/${CODE_TOOL_HELPER_NAME}`;
    const encoded = Buffer.from(CODE_TOOLS_SOURCE, "utf8").toString("base64");
    const result = await sandbox.exec(id, {
      command: `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`,
      cwd: "/",
      timeoutMs: 30_000,
    });
    if (result.exit !== 0) {
      throw new Error(
        result.stderr.trim() || "could not install the code-tools helper",
      );
    }
    return target;
  })().catch((error) => {
    codeToolHelpers.delete(id);
    throw error;
  });
  codeToolHelpers.set(id, task);
  return task;
}

/** Run the bundled helper in the agent's computer and return its stdout. */
export async function runCodeToolHelper(
  context: ToolContext,
  payload: Record<string, unknown>,
  timeoutSeconds: number,
): Promise<RawExecResult> {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64",
  );
  const attempt = async (): Promise<RawExecResult> => {
    let helper: string;
    try {
      helper = await ensureCodeToolHelper(context, context.sandbox);
    } catch (error) {
      return {
        exit: 1,
        stdout: "",
        stderr: (error as Error).message,
        durationMs: 0,
      };
    }
    return runCapture(
      context,
      `node ${shellQuote(helper)} ${shellQuote(encoded)}`,
      codeCwd(context),
      timeoutSeconds,
    );
  };

  const first = await attempt();
  // A rebuilt computer (start fresh, an image upgrade) comes back without the
  // helper in /tmp, so drop the cached path and install it again once.
  if (first.exit !== 0 && /Cannot find module|MODULE_NOT_FOUND/.test(first.stderr)) {
    codeToolHelpers.delete(sandboxId(context));
    return attempt();
  }
  return first;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

const MAX_EDIT_BYTES = 200_000;

async function readRawFile(
  context: ToolContext,
  path: string,
  maxBytes: number,
): Promise<
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; error: string; missing?: boolean }
> {
  const resolved = resolveToolPath(context, path);
  if (resolved.error || !resolved.path) {
    return { ok: false, error: resolved.error ?? "invalid path" };
  }
  const target = resolved.path;
  const result = await runCapture(
    context,
    `if [ ! -e ${shellQuote(target)} ]; then echo ${shellQuote(`no such file: ${path}`)} >&2; exit 3; fi; ` +
      `if [ -d ${shellQuote(target)} ]; then echo ${shellQuote(`is a directory: ${path}`)} >&2; exit 1; fi; ` +
      `head -c ${Math.floor(maxBytes)} -- ${shellQuote(target)}`,
    codeCwd(context),
    30,
  );
  if (result.exit !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `could not read ${path}`,
      missing: result.exit === 3,
    };
  }
  return {
    ok: true,
    content: result.stdout,
    truncated: result.stdout.length >= maxBytes,
  };
}

async function writeRawFile(
  context: ToolContext,
  path: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = resolveToolPath(context, path);
  if (resolved.error || !resolved.path) {
    return { ok: false, error: resolved.error ?? "invalid path" };
  }
  const target = resolved.path;
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const result = await runCapture(
    context,
    // The command substitution is quoted so a path containing spaces is not
    // word-split into several directories.
    `mkdir -p -- "$(dirname ${shellQuote(target)})" && ` +
      `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`,
    codeCwd(context),
    30,
  );
  if (result.exit !== 0) {
    return { ok: false, error: result.stderr.trim() || `could not write ${path}` };
  }
  return { ok: true };
}

/**
 * The path shown in the changed-files card: workspace-relative when the file
 * lives under the agent's root, so rows read like repo paths rather than
 * absolute temp-directory names.
 */
function changeDisplayPath(
  context: ToolContext,
  resolved: string,
  rawPath: string,
): string {
  const root = codeRoot(context).replace(/\/+$/, "");
  if (resolved === root) {
    return rawPath;
  }
  if (resolved.startsWith(`${root}/`)) {
    return resolved.slice(root.length + 1);
  }
  return resolved;
}

/**
 * Build the card metadata for one file edit. Returns null when there is
 * nothing to show: the diff would be empty, the path is invalid, or the text
 * is past the size the tools track.
 */
function buildFileChange(
  context: ToolContext,
  rawPath: string,
  before: string,
  after: string,
): FileChange | null {
  if (before.length > MAX_EDIT_BYTES || after.length > MAX_EDIT_BYTES) {
    return null;
  }
  const resolved = resolveToolPath(context, rawPath);
  if (resolved.error || !resolved.path) {
    return null;
  }
  const stats = lineDiff(before, after);
  if (stats.additions === 0 && stats.deletions === 0) {
    return null;
  }
  return {
    path: changeDisplayPath(context, resolved.path, rawPath),
    additions: stats.additions,
    deletions: stats.deletions,
    diff: stats.diff,
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

/**
 * Start a command detached with its output in a log file, so servers, watchers,
 * and builds that outlive the 300s command cap keep running. The wrapper
 * redirects the standard streams, or the guest's output pump would wait on the
 * background child forever.
 */
async function runBackgroundCommand(
  context: ToolContext,
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const name = `bg-${Date.now()}-${randomUUID().slice(0, 8)}.log`;
  const wrapper = (dir: string, log: string) =>
    `mkdir -p ${shellQuote(dir)} && { ` +
    `nohup bash -c ${shellQuote(command)} > ${shellQuote(log)} 2>&1 < /dev/null & ` +
    `echo $!; }`;

  if (context.computer === "mac") {
    const base =
      accessMode(context) === "project"
        ? ensureWorkspace(context.workspaceDir)
        : homedir();
    const resolvedCwd = resolveLocalCwd(base, cwd || base);
    if (resolvedCwd.error || !resolvedCwd.path) {
      return localResult(resolvedCwd.error ?? "invalid cwd", false, 0);
    }
    const dir =
      accessMode(context) === "project"
        ? join(base, ".openbot-logs")
        : join(context.artifactsDir, "logs");
    const log = join(dir, name);
    const result = await execLocal(
      wrapper(dir, log),
      resolvedCwd.path,
      Math.max(timeoutSeconds, 30) * 1000,
    );
    const pid = result.stdout.trim().split("\n").pop()?.trim() ?? "";
    return localResult(
      `started in the background (pid ${pid}).\n` +
        `log: ${log}\n` +
        `check it with: tail -n 50 ${shellQuote(log)}; stop it with: kill ${pid}`,
      result.exit === 0,
      Date.now() - startedAt,
    );
  }

  const sandbox = context.sandbox;
  if (!sandbox) {
    return { ok: false, output: "sandbox is not available", durationMs: 0 };
  }
  await ensureGuestWorkspace(context, sandbox);
  const dir = "/root/.openbot-logs";
  const log = `${dir}/${name}`;
  const result = await sandbox.exec(sandboxId(context), {
    command: wrapper(dir, log),
    cwd: cwd || context.guestCwd,
    timeoutMs: Math.max(timeoutSeconds, 30) * 1000,
  });
  const pid = result.stdout.trim().split("\n").pop()?.trim() ?? "";
  return {
    ok: result.exit === 0,
    output:
      `started in the background (pid ${pid}).\n` +
      `log: ${log}\n` +
      `check it with: tail -n 50 ${log}; stop it with: kill ${pid}`,
    durationMs: Date.now() - startedAt,
  };
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
      "are allowed (up to 300 seconds). For a server, watcher, or build that " +
      "must outlive the call, set background=true: it returns immediately with " +
      "a log file and pid, and the process keeps running.",
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
        background: {
          type: "boolean",
          description:
            "Start the command detached and return its pid and log file.",
        },
      },
      required: ["command"],
    },
  },
  async execute(context, args) {
    const target = resolveToolComputer(context, args);
    if (target.error) {
      return { ok: false, output: target.error, durationMs: 0 };
    }
    context = { ...context, computer: target.computer };
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) {
      return { ok: false, output: "command is required", durationMs: 0 };
    }
    const fallback = context.computer === "mac" ? context.workspaceDir : "/root";
    const cwd = readCwd(args, fallback);
    const timeoutSeconds = readTimeout(args);
    if (args.background === true) {
      return runBackgroundCommand(context, command, cwd, timeoutSeconds);
    }
    return runCommand(context, command, cwd, timeoutSeconds);
  },
};

const READ_DEFAULT_LINES = 2_000;
const READ_MAX_LINES = 10_000;

const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description:
      "Read a file from your computer. Each line comes back with its line " +
      "number, so you can target a change precisely with the edit tool. Use " +
      "offset and limit to page through a file that is longer than the window.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file." },
        offset: {
          type: "number",
          description: "First line to return, 1-based. Defaults to 1.",
        },
        limit: {
          type: "number",
          description: `Maximum lines to return (default ${READ_DEFAULT_LINES}).`,
        },
        maxBytes: {
          type: "number",
          description: "Maximum bytes to read (default 100000).",
        },
        force: {
          type: "boolean",
          description:
            "Read the file even if it is unchanged since your last read.",
        },
      },
      required: ["path"],
    },
  },
  async execute(context, args) {
    const computerTarget = resolveToolComputer(context, args);
    if (computerTarget.error) {
      return { ok: false, output: computerTarget.error, durationMs: 0 };
    }
    context = { ...context, computer: computerTarget.computer };
    const path = typeof args.path === "string" ? args.path : "";
    if (!path) {
      return { ok: false, output: "path is required", durationMs: 0 };
    }
    const startedAt = Date.now();
    const offset = Math.max(1, Math.floor(Number(args.offset ?? 1) || 1));
    const limit = Math.min(
      Math.max(1, Math.floor(Number(args.limit ?? READ_DEFAULT_LINES) || READ_DEFAULT_LINES)),
      READ_MAX_LINES,
    );
    const maxBytes = Math.min(Number(args.maxBytes ?? 100_000) || 100_000, 200_000);
    const force = args.force === true;

    const resolved = resolveToolPath(context, path);
    if (resolved.error || !resolved.path) {
      const message = resolved.error ?? "invalid path";
      return context.computer === "mac"
        ? localResult(message, false, Date.now() - startedAt)
        : { ok: false, output: message, durationMs: Date.now() - startedAt };
    }
    const target = resolved.path;
    const end = offset + limit - 1;
    const result = await runCapture(
      context,
      `if [ ! -e ${shellQuote(target)} ]; then echo ${shellQuote(`no such file: ${path}`)} >&2; exit 1; fi; ` +
        `if [ -d ${shellQuote(target)} ]; then echo ${shellQuote(`is a directory: ${path}`)} >&2; exit 1; fi; ` +
        `sed -n ${shellQuote(`${offset},${end}p;${end}q`)} ${shellQuote(target)} | head -c ${Math.floor(maxBytes)}`,
      codeCwd(context),
      30,
    );
    if (result.exit !== 0) {
      const message = result.stderr.trim() || `could not read ${path}`;
      return context.computer === "mac"
        ? localResult(message, false, Date.now() - startedAt)
        : { ok: false, output: message, durationMs: Date.now() - startedAt };
    }

    const text = result.stdout;
    const lines =
      text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
    const cappedBytes = text.length >= maxBytes;

    // Number the window up to the shared output budget rather than numbering
    // everything and truncating afterwards, so the paging note always survives
    // and names the line the model actually reached.
    const shown: string[] = [];
    let used = 0;
    for (const [index, line] of lines.entries()) {
      const entry = `${offset + index}: ${line}`;
      if (used + entry.length + 1 > MAX_OUTPUT) {
        if (shown.length === 0) {
          shown.push(`${offset + index}: ${line.slice(0, MAX_OUTPUT)}\n[line truncated]`);
        }
        break;
      }
      shown.push(entry);
      used += entry.length + 1;
    }
    const lastLine = offset + shown.length - 1;
    const clipped = shown.length < lines.length;
    const notes: string[] = [];
    if (clipped || lines.length >= limit) {
      notes.push(`use offset=${lastLine + 1} to continue`);
    }
    if (cappedBytes) {
      notes.push(`output capped at ${maxBytes} bytes`);
    }
    const trailer = notes.length
      ? `\n[showing lines ${offset}-${lastLine}; ${notes.join("; ")}]`
      : "";
    const body = shown.length
      ? `${shown.join("\n")}${trailer}`
      : text.length === 0 && offset === 1
        ? "(the file is empty)"
        : `(no lines in the requested range; the file may be shorter than offset ${offset})`;
    // Re-reading a file that has not changed since the same window was read
    // earlier this turn only burns context; answer with a note unless the
    // model explicitly asks for it again.
    const cacheKey = `${target}\u0000${offset}\u0000${limit}`;
    const hash = createHash("sha256").update(text).digest("hex");
    if (!force && context.readCache?.get(cacheKey) === hash) {
      const note =
        `(${path} is unchanged since your earlier read; the content is ` +
        "earlier in this conversation. Pass force=true to read it again.)";
      return context.computer === "mac"
        ? localResult(note, true, Date.now() - startedAt)
        : { ok: true, output: note, durationMs: Date.now() - startedAt };
    }
    context.readCache?.set(cacheKey, hash);
    return context.computer === "mac"
      ? localResult(body, true, Date.now() - startedAt)
      : { ok: true, output: body, durationMs: Date.now() - startedAt };
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
    const target = resolveToolComputer(context, args);
    if (target.error) {
      return { ok: false, output: target.error, durationMs: 0 };
    }
    context = { ...context, computer: target.computer };
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    if (!path) {
      return { ok: false, output: "path is required", durationMs: 0 };
    }
    // Read what is there now so the app can show the before/after diff. A
    // missing file is a new file; any other read failure just skips the card.
    const previous = await readRawFile(context, path, MAX_EDIT_BYTES);
    let before: string | null = null;
    if (previous.ok) {
      before = previous.truncated ? null : previous.content;
    } else if (previous.missing) {
      before = "";
    }

    const encoded = Buffer.from(content, "utf8").toString("base64");
    let result: ToolExecutionResult;
    if (context.computer === "mac") {
      const resolved = resolveLocalPath(context, path);
      if (resolved.error || !resolved.path) {
        return localResult(resolved.error ?? "invalid path", false, 0);
      }
      const command = `mkdir -p -- "$(dirname ${shellQuote(resolved.path)})" && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(resolved.path)} && wc -c < ${shellQuote(resolved.path)}`;
      result = await runCommand(context, command, macBase(context), 30);
    } else {
      const command = `mkdir -p -- "$(dirname ${shellQuote(path)})" && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)} && wc -c < ${shellQuote(path)}`;
      result = await runCommand(context, command, "/root", 30);
    }

    if (result.ok && before !== null) {
      const change = buildFileChange(context, path, before, content);
      if (change) {
        result.changes = [change];
      }
    }
    return result;
  },
};

const editTool: Tool = {
  definition: {
    name: "edit",
    description:
      "Change an existing file by replacing an exact string. Prefer this over " +
      "write_file for edits: it preserves everything around the change, so a " +
      "small fix stays a small diff. `oldString` must match the file exactly, " +
      "including indentation and line breaks. If it appears more than once, " +
      "include more surrounding lines to make it unique, or set replaceAll to " +
      "change every occurrence. Read the file first so the match is exact.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file." },
        oldString: {
          type: "string",
          description: "Exact text to find, including indentation.",
        },
        newString: { type: "string", description: "Replacement text." },
        replaceAll: {
          type: "boolean",
          description: "Replace every occurrence (default false).",
        },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  async execute(context, args) {
    const target = resolveToolComputer(context, args);
    if (target.error) {
      return { ok: false, output: target.error, durationMs: 0 };
    }
    context = { ...context, computer: target.computer };
    const path = typeof args.path === "string" ? args.path : "";
    const oldString = typeof args.oldString === "string" ? args.oldString : "";
    const newString = typeof args.newString === "string" ? args.newString : "";
    const replaceAll = args.replaceAll === true;
    if (!path) {
      return { ok: false, output: "path is required", durationMs: 0 };
    }
    if (!oldString) {
      return { ok: false, output: "oldString is required", durationMs: 0 };
    }
    if (oldString === newString) {
      return {
        ok: false,
        output: "oldString and newString are identical; there is nothing to change.",
        durationMs: 0,
      };
    }

    const startedAt = Date.now();
    const read = await readRawFile(context, path, MAX_EDIT_BYTES);
    if (!read.ok) {
      return { ok: false, output: read.error, durationMs: Date.now() - startedAt };
    }
    if (read.truncated) {
      // Editing a partial read would write the truncated text back and destroy
      // the rest of the file, so refuse rather than risk it.
      return {
        ok: false,
        output:
          `${path} is larger than the ${MAX_EDIT_BYTES} byte limit for edit. ` +
          "Use shell to change it, or write_file if you intend to replace it entirely.",
        durationMs: Date.now() - startedAt,
      };
    }
    const content = read.content;
    const count = countOccurrences(content, oldString);
    if (count === 0) {
      const trimmed = oldString.trim();
      const hint =
        trimmed && content.includes(trimmed)
          ? " The text is present but the surrounding whitespace differs, so check the indentation."
          : "";
      return {
        ok: false,
        output: `oldString was not found in ${path}.${hint}`,
        durationMs: Date.now() - startedAt,
      };
    }
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        output:
          `oldString appears ${count} times in ${path}. Include more surrounding ` +
          "context to make it unique, or set replaceAll to replace every occurrence.",
        durationMs: Date.now() - startedAt,
      };
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    const write = await writeRawFile(context, path, updated);
    if (!write.ok) {
      return { ok: false, output: write.error, durationMs: Date.now() - startedAt };
    }
    const change = buildFileChange(context, path, content, updated);
    return {
      ok: true,
      output: `Replaced ${count} occurrence(s) in ${path}.`,
      durationMs: Date.now() - startedAt,
      ...(change ? { changes: [change] } : {}),
    };
  },
};

const grepTool: Tool = {
  definition: {
    name: "grep",
    description:
      "Search file contents with a regular expression and return " +
      "`path:line:text` for every match. Skips .git, node_modules, dist, " +
      "build, and similar directories. Use include to narrow by filename " +
      "(for example \"*.ts\", which is matched recursively). Results are " +
      "capped, so narrow the pattern or the path when a search is too broad.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression matched against each line.",
        },
        path: {
          type: "string",
          description:
            "File or directory to search. Defaults to the working directory.",
        },
        include: {
          type: "string",
          description: "Glob filter for filenames, for example \"*.ts\".",
        },
        maxResults: {
          type: "number",
          description: "Maximum matches to return (default 200).",
        },
      },
      required: ["pattern"],
    },
  },
  async execute(context, args) {
    const target = resolveToolComputer(context, args);
    if (target.error) {
      return { ok: false, output: target.error, durationMs: 0 };
    }
    context = { ...context, computer: target.computer };
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) {
      return { ok: false, output: "pattern is required", durationMs: 0 };
    }
    const startedAt = Date.now();
    const rawPath =
      typeof args.path === "string" && args.path ? args.path : codeRoot(context);
    const resolved = resolveToolPath(context, rawPath);
    if (resolved.error || !resolved.path) {
      return {
        ok: false,
        output: resolved.error ?? "invalid path",
        durationMs: Date.now() - startedAt,
      };
    }
    const cap = Math.min(
      Math.max(1, Math.floor(Number(args.maxResults ?? 200) || 200)),
      500,
    );
    const result = await runCodeToolHelper(
      context,
      {
        mode: "grep",
        root: resolved.path,
        pattern,
        ...(typeof args.include === "string" && args.include
          ? { include: args.include }
          : {}),
        cap,
      },
      60,
    );
    if (result.exit !== 0) {
      return {
        ok: false,
        output: result.stderr.trim() || "grep failed",
        durationMs: Date.now() - startedAt,
      };
    }
    const output = result.stdout.trim();
    return {
      ok: true,
      output: output
        ? truncate(output)
        : `No matches for /${pattern}/ under ${resolved.path}`,
      durationMs: Date.now() - startedAt,
    };
  },
};

const globTool: Tool = {
  definition: {
    name: "glob",
    description:
      "Find files by path pattern, for example \"**/*.ts\" or \"src/**/*.js\". " +
      "A pattern with no slash is matched recursively, so \"*.json\" finds " +
      "JSON anywhere in the tree. Skips .git, node_modules, dist, build, and " +
      "similar directories. Use this to locate files before reading them.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, for example \"**/*.ts\".",
        },
        path: {
          type: "string",
          description: "Directory to search. Defaults to the working directory.",
        },
        maxResults: {
          type: "number",
          description: "Maximum files to return (default 200).",
        },
      },
      required: ["pattern"],
    },
  },
  async execute(context, args) {
    const target = resolveToolComputer(context, args);
    if (target.error) {
      return { ok: false, output: target.error, durationMs: 0 };
    }
    context = { ...context, computer: target.computer };
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) {
      return { ok: false, output: "pattern is required", durationMs: 0 };
    }
    const startedAt = Date.now();
    const rawPath =
      typeof args.path === "string" && args.path ? args.path : codeRoot(context);
    const resolved = resolveToolPath(context, rawPath);
    if (resolved.error || !resolved.path) {
      return {
        ok: false,
        output: resolved.error ?? "invalid path",
        durationMs: Date.now() - startedAt,
      };
    }
    const cap = Math.min(
      Math.max(1, Math.floor(Number(args.maxResults ?? 200) || 200)),
      500,
    );
    const result = await runCodeToolHelper(
      context,
      { mode: "glob", root: resolved.path, pattern, cap },
      60,
    );
    if (result.exit !== 0) {
      return {
        ok: false,
        output: result.stderr.trim() || "glob failed",
        durationMs: Date.now() - startedAt,
      };
    }
    const output = result.stdout.trim();
    return {
      ok: true,
      output: output
        ? truncate(output)
        : `No files match ${pattern} under ${resolved.path}`,
      durationMs: Date.now() - startedAt,
    };
  },
};

const updatePlanTool: Tool = {
  definition: {
    name: "update_plan",
    description:
      "Record or update your working plan for the current task so you and the " +
      "user can see the steps and which one is in progress. Send the whole " +
      "plan each time; keep it to 2-8 short steps, at most one in_progress, " +
      "and mark steps done as you finish them. Use it for multi-step work, " +
      "not for a single action or a simple question.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "The full plan, in order.",
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "What the step does." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
              },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["steps"],
    },
  },
  async execute(context, args) {
    const raw = Array.isArray(args.steps) ? args.steps : [];
    const plan: PlanStep[] = [];
    for (const entry of raw.slice(0, 20)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const step = typeof record.step === "string" ? record.step.trim() : "";
      const status =
        record.status === "done" || record.status === "in_progress"
          ? record.status
          : "pending";
      if (step) {
        plan.push({ step, status });
      }
    }
    if (!plan.length) {
      return {
        ok: false,
        output: "steps is required and must not be empty",
        durationMs: 0,
      };
    }
    if (!context.updatePlan) {
      return {
        ok: false,
        output: "planning is not available for this run",
        durationMs: 0,
      };
    }
    context.updatePlan(plan);
    const rendered = plan
      .map((item) =>
        item.status === "done"
          ? `[x] ${item.step}`
          : item.status === "in_progress"
            ? `[>] ${item.step}`
            : `[ ] ${item.step}`,
      )
      .join("\n");
    return { ok: true, output: `Plan updated:\n${rendered}`, durationMs: 0 };
  },
};

const listDirTool: Tool = {
  definition: {
    name: "list_dir",
    description:
      "List the entries in a directory on your computer: names, which entries " +
      "are directories, and file sizes. Use it to orient yourself before " +
      "reading or changing files, instead of guessing paths. Entries such as " +
      ".git, node_modules, dist, and build are skipped.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory to list. Defaults to the working directory.",
        },
        maxResults: {
          type: "number",
          description: "Maximum entries to return (default 500).",
        },
      },
    },
  },
  async execute(context, args) {
    const target = resolveToolComputer(context, args);
    if (target.error) {
      return { ok: false, output: target.error, durationMs: 0 };
    }
    context = { ...context, computer: target.computer };
    const startedAt = Date.now();
    const rawPath =
      typeof args.path === "string" && args.path ? args.path : codeRoot(context);
    const resolved = resolveToolPath(context, rawPath);
    if (resolved.error || !resolved.path) {
      return {
        ok: false,
        output: resolved.error ?? "invalid path",
        durationMs: Date.now() - startedAt,
      };
    }
    const cap = Math.min(
      Math.max(1, Math.floor(Number(args.maxResults ?? 500) || 500)),
      2_000,
    );
    const result = await runCodeToolHelper(
      context,
      { mode: "list", root: resolved.path, cap },
      30,
    );
    if (result.exit !== 0) {
      return {
        ok: false,
        output:
          result.stderr.trim() || `could not list ${resolved.path}`,
        durationMs: Date.now() - startedAt,
      };
    }
    const output = result.stdout.trimEnd();
    return {
      ok: true,
      output: output
        ? truncate(output)
        : `(the directory is empty: ${resolved.path})`,
      durationMs: Date.now() - startedAt,
    };
  },
};

/**
 * The run's network egress policy when it should be enforced inside the guest.
 * A hard `deny` policy is enforced for every request (subresources, XHR/fetch),
 * not only the top-level navigation the daemon can see. `ask` approvals happen
 * per navigation at the daemon; a running page cannot pause to ask, so those
 * are not forwarded.
 */
function policyEgress(
  context: ToolContext,
): { mode: "deny"; allow: string[] } | null {
  const setting = context.policy?.egress;
  return setting && setting.mode === "deny"
    ? { mode: "deny", allow: setting.allow }
    : null;
}

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
  // The browser host reports `{mime, base64}`; the smoke mock and older hosts
  // send a bare base64 string.
  screenshots?: Array<string | { mime?: string; base64?: string }>;
  /** Hosts the guest blocked because they are not in the egress allowlist. */
  egressBlocked?: string[];
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
    ...(typeof payload.key === "string" ? { key: payload.key } : {}),
    ...(typeof payload.option === "string" ? { option: payload.option } : {}),
    ...(Array.isArray(payload.files)
      ? {
          files: payload.files.filter(
            (file): file is string => typeof file === "string" && Boolean(file),
          ),
        }
      : {}),
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
      let saved = 0;
      for (const shot of screenshots) {
        const base64 = typeof shot === "string" ? shot : shot.base64;
        if (typeof base64 !== "string" || !base64) {
          continue;
        }
        const mime =
          typeof shot === "string" || typeof shot.mime !== "string"
            ? "image/png"
            : shot.mime;
        const filename = `${randomUUID()}.png`;
        writeFileSync(
          join(context.artifactsDir, filename),
          Buffer.from(base64, "base64"),
        );
        artifacts.push({ type: "image", url: `/artifacts/${filename}` });
        if (context.vision) {
          images.push({ data: base64, mimeType: mime });
        }
        saved += 1;
      }
      if (saved > 0) {
        output += `\n${saved} screenshot${saved === 1 ? "" : "s"} ${
          context.vision
            ? "captured and attached to the conversation"
            : "saved (visible to the user in the chat)"
        }`;
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
      "(selector), type (selector, text, submit), press (key, optional " +
      "selector to focus first), select (selector, option), upload (selector, " +
      "files: paths in your computer), fields (visible inputs and buttons with " +
      "ready selectors), snapshot (every interactive element with a ready " +
      "selector), links (optional selector, returns link labels and URLs), " +
      "scroll (pixels, or selector to bring an element into view), text " +
      "(optional selector), screenshot (returns a picture), back, wait " +
      "(selector or milliseconds), wait_for (selector or text with a timeout), " +
      "tabs, new_tab (url), switch_tab (index), close_tab to manage windows, " +
      "and downloads (copies anything the page downloaded into /root/Downloads " +
      "and returns the paths). For research, collect facts from each " +
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
            "press",
            "select",
            "wait_for",
            "snapshot",
            "upload",
            "tabs",
            "new_tab",
            "switch_tab",
            "close_tab",
            "downloads",
          ],
        },
        url: { type: "string", description: "URL for the goto action." },
        href: {
          type: "string",
          description: "Link URL from the links action, for clickLink.",
        },
        index: {
          type: "number",
          description:
            "Link index for clickLink when href is not known, or the tab " +
            "number from tabs for switch_tab (1-based).",
        },
        files: {
          type: "array",
          description:
            "Absolute paths in your computer to attach for upload.",
          items: { type: "string" },
        },
        selector: {
          type: "string",
          description:
            "CSS selector for click, type, press, select, wait, wait_for, " +
            "text, or scroll.",
        },
        text: {
          type: "string",
          description: "Text to type, or the text wait_for should wait for.",
        },
        submit: {
          type: "boolean",
          description: "Press Enter after typing.",
        },
        milliseconds: {
          type: "number",
          description: "Wait duration for the wait action.",
        },
        key: {
          type: "string",
          description:
            "Keyboard key for press, for example Enter, Tab, Escape, " +
            "ArrowDown, or Meta+A.",
        },
        option: {
          type: "string",
          description:
            "Option value or visible label to pick with select.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Timeout for wait_for in milliseconds (default 10000, max 60000).",
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

    const egress = policyEgress(context);
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
        key: args.key,
        option: args.option,
        files: args.files,
        timeoutMs: args.timeoutMs,
        ...(egress ? { egress } : {}),
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
    if (parsed.egressBlocked?.length) {
      output +=
        `\n[egress] blocked request(s) to ${parsed.egressBlocked.join(", ")}: ` +
        "not in the browser egress allowlist";
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

    const egress = policyEgress(context);
    const result = await runBrowseLoop({
      sandbox,
      botId: browserSandboxId(context),
      client,
      goal,
      ...(startUrl ? { startUrl } : {}),
      ...(egress ? { egress } : {}),
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

const WEB_SEARCH_YEAR = new Date().getFullYear();

const webSearchTool: Tool = {
  definition: {
    name: "web_search",
    description:
      "Search the live web and get back the most relevant page content with " +
      "titles and URLs. Use it for current events, recent facts, prices, and " +
      "anything beyond your knowledge cutoff, and cite the URLs it returns. " +
      "It runs on the host, not on the agent's computer, so it works on any " +
      "computer — including This Mac, where the browser tools are " +
      "unavailable. Use the browser tools instead when you need to interact " +
      "with a page, sign in, or read a page the user named. One call is one " +
      "search: phrase the query the way a person would, and search again " +
      `rather than guessing. The current year is ${WEB_SEARCH_YEAR}; include ` +
      "it when searching for recent information or current events.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query, phrased the way a person would type it.",
        },
        numResults: {
          type: "number",
          description: `How many results to return (default ${WEB_SEARCH_DEFAULT_RESULTS}, max 20).`,
        },
        type: {
          type: "string",
          enum: ["auto", "fast", "deep"],
          description:
            "Search depth: auto (balanced, default), fast (quick results), " +
            "or deep (comprehensive).",
        },
        livecrawl: {
          type: "string",
          enum: ["fallback", "preferred"],
          description:
            "Live crawl mode: fallback uses cached content unless it is " +
            "unavailable (default), preferred prioritizes fetching the live " +
            "page.",
        },
        contextMaxCharacters: {
          type: "number",
          description:
            "Maximum characters of context to return (default 10000, max 50000).",
        },
      },
      required: ["query"],
    },
  },
  async execute(context, args) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, output: "query is required", durationMs: 0 };
    }
    const provider = selectWebSearchProvider();
    const requestedResults = Number(
      args.numResults ?? WEB_SEARCH_DEFAULT_RESULTS,
    );
    const numResults = Number.isFinite(requestedResults)
      ? Math.min(Math.max(Math.round(requestedResults), 1), 20)
      : WEB_SEARCH_DEFAULT_RESULTS;
    const type =
      args.type === "fast" || args.type === "deep" ? args.type : "auto";
    const livecrawl =
      args.livecrawl === "preferred" ? "preferred" : "fallback";
    const requestedContext = Number(args.contextMaxCharacters ?? 0);
    const contextMaxCharacters =
      Number.isFinite(requestedContext) && requestedContext > 0
        ? Math.min(Math.max(Math.round(requestedContext), 500), 50_000)
        : undefined;

    const startedAt = Date.now();
    try {
      const result = await runWebSearch({
        query,
        provider,
        numResults,
        type,
        livecrawl,
        ...(contextMaxCharacters ? { contextMaxCharacters } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!result.text) {
        return {
          ok: false,
          output:
            `No results for "${query}" from ${webSearchProviderLabel(provider)}. ` +
            "Try a different query.",
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        ok: true,
        output: truncate(result.text),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const failure = error as Error;
      const message =
        failure.name === "TimeoutError"
          ? "the search timed out"
          : failure.message || String(error);
      return {
        ok: false,
        output: `web search failed: ${message}`,
        durationMs: Date.now() - startedAt,
      };
    }
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

const systemInfoTool: Tool = {
  definition: {
    name: "system_info",
    description:
      "Report where this OpenBot is installed and running: run mode (dev " +
      "checkout or packaged app), source path, app path, version, git " +
      "revision, daemon entry and pid, data and database paths, how the " +
      "daemon was launched, and the project's check commands. Use it before " +
      "working on OpenBot itself or explaining how to update it.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  async execute(context) {
    const info =
      context.self ??
      collectSelfInfo({
        dataDir: dirname(context.artifactsDir),
        artifactsDir: context.artifactsDir,
      });
    return { ok: true, output: renderSelfInfo(info), durationMs: 0 };
  },
};

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
                "browser, browse, desktop, web_search). Defaults to all tools " +
                "the role's computer supports.",
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

const REASONING_EFFORTS = new Set<string>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
]);

/**
 * Parse the optional `model` argument the team-building tools accept. The
 * effort is validated here so a model string that never reached the schema
 * cannot reach a provider request.
 */
function parseModelArg(value: unknown): ModelRef | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.model !== "string") {
    return undefined;
  }
  const effort =
    typeof record.effort === "string" && REASONING_EFFORTS.has(record.effort)
      ? (record.effort as ReasoningEffort)
      : undefined;
  return {
    provider: record.provider,
    model: record.model,
    ...(effort ? { effort } : {}),
  };
}

/**
 * Parse a computers argument: valid kinds only, deduped, in the given order.
 * Returns null when the caller did not choose (missing, invalid, or empty), so
 * the tool can ask instead of guessing.
 */
function parseComputersArg(value: unknown): ComputerKind[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const seen = new Set<ComputerKind>();
  for (const item of value) {
    if (item === "firecracker" || item === "mac") {
      seen.add(item);
    }
  }
  return seen.size > 0 ? [...seen] : null;
}

const createWorkerTool: Tool = {
  definition: {
    name: "create_worker",
    description:
      "Add a persistent team worker when list_roles has no role that fits a " +
      "task. The worker inherits your computers and stays on the team for " +
      "future tasks, so the team grows only as the work needs it. Give it a " +
      "short name and a one-line specialty, then delegate to it with " +
      "spawn_worker using the returned id. Check list_roles first and reuse " +
      "an existing role whenever one fits.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short worker name, for example \"Weather Watcher\".",
        },
        specialty: {
          type: "string",
          description:
            "One line describing what this worker is for, for example " +
            "\"checks National Weather Service forecasts and active alerts\".",
        },
        instructions: {
          type: "string",
          description:
            "Optional extra instructions for the worker: sites, tools, or " +
            "rules it should always follow.",
        },
        model: {
          type: "object",
          description:
            "Optional model for the worker (provider, model, and reasoning effort).",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
            effort: {
              type: "string",
              enum: ["none", "minimal", "low", "medium", "high", "max"],
              description: "Optional reasoning effort for the worker's model.",
            },
          },
        },
      },
      required: ["name", "specialty"],
    },
  },
  async execute(context, args) {
    const orchestrator = context.orchestrator;
    if (!orchestrator) {
      return orchestratorUnavailable();
    }
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const specialty =
      typeof args.specialty === "string" ? args.specialty.trim() : "";
    const instructions =
      typeof args.instructions === "string" ? args.instructions.trim() : undefined;
    const model = parseModelArg(args.model);
    if (!name || !specialty) {
      return {
        ok: false,
        output: "name and specialty are required.",
        durationMs: 0,
      };
    }
    try {
      const { role, created } = orchestrator.createWorker({
        callerBotId: context.botId,
        name,
        specialty,
        instructions,
        model,
      });
      return {
        ok: true,
        output: created
          ? `Worker created: ${role.name} (id: ${role.id}) — ${specialty}.\n` +
            "It is on the team now; delegate to it with spawn_worker using " +
            "this id."
          : `A worker named ${role.name} already exists (id: ${role.id}); ` +
            "reusing it. Delegate to it with spawn_worker.",
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

const listWorkspacesTool: Tool = {
  definition: {
    name: "list_workspaces",
    description:
      "List the user's project folders (workspaces) that the daemon has " +
      "registered on this Mac. Each has an id, a name, and a root path. When " +
      "a request is about an existing project, create its manager with " +
      "create_project and pass that workspace id so the manager's file tools " +
      "and shell work inside the project folder.",
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
    const workspaces = orchestrator.listWorkspaces();
    if (workspaces.length === 0) {
      return {
        ok: true,
        output:
          "No project folders are registered. The user can add or scan for " +
          "them in Settings → Workspaces.",
        durationMs: 0,
      };
    }
    const lines = workspaces.map((workspace) => {
      const markers = workspace.markers.length
        ? ` · ${workspace.markers.join(", ")}`
        : "";
      const agents =
        workspace.agentCount > 0
          ? ` · ${workspace.agentCount} agent${
              workspace.agentCount === 1 ? "" : "s"
            }`
          : "";
      const missing = workspace.missing ? " · MISSING on disk" : "";
      return (
        `- ${workspace.name} (id: ${workspace.id}) at ${workspace.root}` +
        `${markers}${agents}${missing}`
      );
    });
    return { ok: true, output: lines.join("\n"), durationMs: 0 };
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
      "topic; you route to it with ask_project. If the user has not said " +
      "which computers the project should have, ask before calling this tool: " +
      "the Firecracker microVM, This Mac, or both.",
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
        computers: {
          type: "array",
          items: { type: "string", enum: ["firecracker", "mac"] },
          description:
            "Which computers the manager and its workers may use: " +
            "[\"firecracker\"] for the isolated microVM, [\"mac\"] for This " +
            "Mac, or both. Do not guess: ask the user when the request does " +
            "not say.",
        },
        workspace: {
          type: "string",
          description:
            "Optional project folder for the manager: a workspace id from " +
            "list_workspaces, or its name. Omit for a managed scratch folder.",
        },
        model: {
          type: "object",
          description:
            "Optional model for the project manager (provider, model, and reasoning effort).",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
            effort: {
              type: "string",
              enum: ["none", "minimal", "low", "medium", "high", "max"],
              description: "Optional reasoning effort for the manager's model.",
            },
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
    const model = parseModelArg(args.model);
    const computers = parseComputersArg(args.computers);
    if (!name || !scope) {
      return {
        ok: false,
        output: "name and scope are required.",
        durationMs: 0,
      };
    }
    if (!computers) {
      return {
        ok: false,
        output:
          "No computers were chosen for this project. Ask the user whether " +
          "the manager should have the Firecracker microVM, This Mac, or " +
          "both, then call create_project again with the answer.",
        durationMs: 0,
      };
    }
    let workspaceId: string | null = null;
    if (typeof args.workspace === "string" && args.workspace.trim()) {
      const wanted = args.workspace.trim().toLowerCase();
      const match = orchestrator
        .listWorkspaces()
        .find(
          (workspace) =>
            workspace.id === args.workspace ||
            workspace.name.toLowerCase() === wanted,
        );
      if (!match) {
        return {
          ok: false,
          output:
            `No workspace matches "${args.workspace}". Check list_workspaces ` +
            "and pass the id or exact name, or omit workspace for a scratch " +
            "folder.",
          durationMs: 0,
        };
      }
      workspaceId = match.id;
    }
    try {
      const project = orchestrator.createProject({
        callerBotId: context.botId,
        name,
        scope,
        brief,
        model,
        computers,
        workspaceId,
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
  "create_worker",
  "worker_status",
  "cancel_worker",
  "list_projects",
  "create_project",
  "ask_project",
  "list_workspaces",
]);

// Reads never need approval; the tools that create or change work do.
const READ_ONLY_ORCHESTRATION_TOOL_NAMES = new Set([
  "list_roles",
  "worker_status",
  "list_projects",
  "list_workspaces",
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
  editTool,
  grepTool,
  globTool,
  listDirTool,
  updatePlanTool,
  browserTool,
  browserExecuteTool,
  browserStepTool,
  desktopTool,
  browseTool,
  webSearchTool,
  systemInfoTool,
  listRolesTool,
  spawnWorkerTool,
  createWorkerTool,
  workerStatusTool,
  cancelWorkerTool,
  listProjectsTool,
  createProjectTool,
  askProjectTool,
  listWorkspacesTool,
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
        background: {
          type: "boolean",
          description:
            "Start the command detached and return its pid and log file.",
        },
      },
      required: ["command"],
    },
  },
  read_file: {
    name: "read_file",
    description:
      "Read a file from this agent's workspace folder on the user's Mac. Each " +
      "line comes back with its line number, so you can target a change " +
      "precisely with the edit tool. Paths outside the workspace are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file, relative to the workspace or absolute inside it.",
        },
        offset: {
          type: "number",
          description: "First line to return, 1-based. Defaults to 1.",
        },
        limit: {
          type: "number",
          description: "Maximum lines to return (default 2000).",
        },
        maxBytes: {
          type: "number",
          description: "Maximum bytes to read (default 100000).",
        },
        force: {
          type: "boolean",
          description:
            "Read the file even if it is unchanged since your last read.",
        },
      },
      required: ["path"],
    },
  },
  edit: {
    name: "edit",
    description:
      "Change a file in this agent's workspace on the user's Mac by replacing " +
      "an exact string. Prefer this over write_file for edits: it preserves " +
      "everything around the change. `oldString` must match exactly, including " +
      "indentation; if it appears more than once, add surrounding lines or set " +
      "replaceAll. Paths outside the workspace are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file, relative to the workspace or absolute inside it.",
        },
        oldString: {
          type: "string",
          description: "Exact text to find, including indentation.",
        },
        newString: { type: "string", description: "Replacement text." },
        replaceAll: {
          type: "boolean",
          description: "Replace every occurrence (default false).",
        },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  grep: {
    name: "grep",
    description:
      "Search file contents in this agent's workspace on the user's Mac with a " +
      "regular expression, returning `path:line:text`. Skips .git, " +
      "node_modules, dist, and build. Paths outside the workspace are rejected.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression matched against each line.",
        },
        path: {
          type: "string",
          description:
            "File or directory to search, relative to the workspace or " +
            "absolute inside it. Defaults to the workspace root.",
        },
        include: {
          type: "string",
          description: "Glob filter for filenames, for example \"*.ts\".",
        },
        maxResults: {
          type: "number",
          description: "Maximum matches to return (default 200).",
        },
      },
      required: ["pattern"],
    },
  },
  glob: {
    name: "glob",
    description:
      "Find files in this agent's workspace on the user's Mac by path pattern, " +
      "for example \"**/*.ts\". A pattern with no slash is matched recursively. " +
      "Skips .git, node_modules, dist, and build. Paths outside the workspace " +
      "are rejected.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, for example \"**/*.ts\".",
        },
        path: {
          type: "string",
          description:
            "Directory to search, relative to the workspace or absolute " +
            "inside it. Defaults to the workspace root.",
        },
        maxResults: {
          type: "number",
          description: "Maximum files to return (default 200).",
        },
      },
      required: ["pattern"],
    },
  },
  update_plan: {
    name: "update_plan",
    description:
      "Record or update your working plan for the current task so you and the " +
      "user can see the steps and which one is in progress. Send the whole " +
      "plan each time; keep it to 2-8 short steps, at most one in_progress, " +
      "and mark steps done as you finish them.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "The full plan, in order.",
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "What the step does." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
              },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["steps"],
    },
  },
  list_dir: {
    name: "list_dir",
    description:
      "List the entries in a directory in this agent's workspace on the user's " +
      "Mac: names, which entries are directories, and file sizes. Entries such " +
      "as .git, node_modules, dist, and build are skipped. Paths outside the " +
      "workspace are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory to list, relative to the workspace or absolute inside " +
            "it. Defaults to the workspace root.",
        },
        maxResults: {
          type: "number",
          description: "Maximum entries to return (default 500).",
        },
      },
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

const COMPUTER_TOOL_NAMES = new Set([
  "shell",
  "read_file",
  "write_file",
  "edit",
  "grep",
  "glob",
  "list_dir",
]);

const VM_ONLY_TOOL_NAMES = new Set([
  "browser",
  "browser_execute",
  "browser_step",
  "desktop",
]);

/**
 * An agent with both computers gets one tool set, not two: the shared tools
 * grow an optional `computer` argument and the description says so (ADR-021).
 */
function withComputerChoice(
  definition: ToolDefinition,
  computers: ComputerKind[],
): ToolDefinition {
  const labels = computers.map(computerLabel).join(" or ");
  const parameters = definition.parameters as {
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  return {
    ...definition,
    description:
      `${definition.description} This agent has more than one computer ` +
      `(${labels}); pass computer to choose which one this call acts on.`,
    parameters: {
      ...parameters,
      properties: {
        ...(parameters.properties ?? {}),
        computer: {
          type: "string",
          enum: ["firecracker", "mac"],
          description:
            "Which computer to act on: \"firecracker\" is the isolated " +
            "Linux microVM (the default); \"mac\" is the user's Mac, where " +
            "file tools are confined to the agent's workspace folder and " +
            "every action is approval-gated.",
        },
      },
    },
  };
}

export function toolDefinitions(
  computers: ComputerKind[] = ["firecracker"],
  options: { browse?: boolean; delegate?: boolean } = {},
): ToolDefinition[] {
  const hasVm = computers.includes("firecracker");
  const hasMac = computers.includes("mac");
  const hasComputer = hasVm || hasMac;
  const browse = Boolean(options.browse) && hasVm;
  const delegate = Boolean(options.delegate);
  // Deterministic evaluations replace the web with fixtures; the live search
  // tool would silently bypass them, so it is disabled there.
  const webSearch = process.env.OPENBOT_WEBSEARCH_DISABLED !== "1";
  return tools
    .filter((tool) => {
      const name = tool.definition.name;
      if (COMPUTER_TOOL_NAMES.has(name)) {
        return hasComputer;
      }
      if (VM_ONLY_TOOL_NAMES.has(name)) {
        return hasVm;
      }
      if (name === "browse") {
        return browse;
      }
      if (name === "web_search") {
        return webSearch;
      }
      if (ORCHESTRATION_TOOL_NAMES.has(name) || MEMORY_TOOL_NAMES.has(name)) {
        return delegate;
      }
      return true;
    })
    .map((tool) => {
      const name = tool.definition.name;
      if (!COMPUTER_TOOL_NAMES.has(name)) {
        return tool.definition;
      }
      if (hasVm && hasMac) {
        return withComputerChoice(tool.definition, computers);
      }
      return hasMac
        ? (LOCAL_DEFINITIONS[name] ?? tool.definition)
        : tool.definition;
    });
}

export function findTool(name: string): Tool | undefined {
  return tools.find((tool) => tool.definition.name === name);
}
