import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  AccessMode,
  Bot,
  ComputerKind,
  Message,
  ModelRef,
  ServerMessage,
  Task,
  TaskBudget,
  TaskDisplay,
  TaskGrant,
  TaskUsage,
} from "@openbot/protocol";
import { runAgent, type AgentDeps } from "./agent";
import { normalizeComputers, systemPromptForBot } from "./store";
import { renderEvidenceLedger } from "./task-harness";
import type {
  OrchestratorHandle,
  ProjectSummary,
  RoleSummary,
  SpawnedTask,
  TaskGrantRequest,
  TaskSummary,
  WorkspaceSummary,
} from "./tools";

const MAX_DEPTH = 1;
// Worker sessions share the project's computer, so the limit is about model
// and browser concurrency rather than memory.
const MAX_CONCURRENT_TASKS = 4;
// The lead and managers build the team on demand, so the cap is a runaway
// guard rather than a team-size policy: reuse beats hiring at the limit.
const MAX_TEAM_ROLES = 12;
const PROJECT_MANAGER_CONTRACT =
  "You own this project's computer, its files, and its detailed context; the " +
  "lead only sees your reports. Keep the project's assets in your home " +
  "directory. Delegate work with spawn_worker: each worker runs as an " +
  "ephemeral session inside your computer with its own browser and a " +
  "workspace under /root/workspaces/<taskId>, and it has no memory of this " +
  "conversation, so write each brief fully: objective, constraints, " +
  "deliverable, and what counts as done. When no existing role fits a task, " +
  "build the team: create a worker with create_worker and then delegate to " +
  "it; the new role persists for future tasks. Review worker results, resolve " +
  "conflicts between them, and answer the lead with one report that keeps " +
  "evidence handles (observation ids, URLs) instead of paraphrasing them " +
  "away. Leave worker budgets unset unless the user asked for limits: the " +
  "default is generous, and a tight budget can stop useful work early. Never " +
  "wait for workers with sleep or polling loops: end your turn and you will " +
  "be woken with each child result. When you finish your turn with no workers " +
  "still running, your final message is the report to the lead.";
const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;
const DEFAULT_TOOL_CALLS = 60;
// Cumulative tokens across a multi-step browser research run add up quickly
// (page text plus reasoning), so the default is deliberately generous.
const DEFAULT_TOKENS = 1_000_000;
const NOTE_LIMIT = 4000;

export interface OrchestratorOptions {
  deps: AgentDeps;
  emit: (message: ServerMessage) => void;
  onTaskSettled: (task: Task) => void;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function describeBudget(budget: TaskBudget | null | undefined): string {
  if (!budget) {
    return "unlimited";
  }
  const parts: string[] = [];
  if (budget.wallClockMs != null) {
    parts.push(`${Math.round(budget.wallClockMs / 1000)}s`);
  }
  if (budget.toolCalls != null) {
    parts.push(`${budget.toolCalls} tool calls`);
  }
  if (budget.tokens != null) {
    parts.push(`${budget.tokens} tokens`);
  }
  return parts.join(", ") || "unlimited";
}

function lastAssistantMessage(messages: Message[]): Message | null {
  return (
    [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          (message.content.trim().length > 0 || message.toolCalls?.length),
      ) ?? null
  );
}

function computeUsage(task: Task, messages: Message[]): TaskUsage {
  const toolCalls = messages.reduce(
    (total, message) => total + (message.toolCalls?.length ?? 0),
    0,
  );
  const inputTokens = messages.reduce(
    (total, message) => total + (message.usage?.inputTokens ?? 0),
    0,
  );
  const outputTokens = messages.reduce(
    (total, message) => total + (message.usage?.outputTokens ?? 0),
    0,
  );
  const cacheReadTokens = messages.reduce(
    (total, message) => total + (message.usage?.cacheReadTokens ?? 0),
    0,
  );
  const startedAt = task.startedAt
    ? Date.parse(task.startedAt)
    : Date.parse(task.createdAt);
  const endedAt = task.endedAt ? Date.parse(task.endedAt) : Date.now();
  return {
    toolCalls,
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    wallClockMs: Math.max(0, endedAt - startedAt),
  };
}

export class Orchestrator implements OrchestratorHandle {
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly inboxes = new Map<string, string[]>();

  constructor(private readonly options: OrchestratorOptions) {}

  private roleSummary(bot: Bot): RoleSummary {
    const active = this.options.deps.store.activeTaskForRole(bot.id);
    const workspace = bot.workspaceId
      ? this.options.deps.store.getWorkspace(bot.workspaceId)
      : null;
    return {
      id: bot.id,
      name: bot.name,
      role: bot.role ?? null,
      model: bot.model,
      computer: bot.computer ?? null,
      computers: bot.computers,
      access: bot.access,
      workspaceId: bot.workspaceId ?? null,
      workspace: workspace?.name ?? null,
      delegates: bot.delegates,
      busyTaskId: active?.id ?? null,
      busyTaskTitle: active?.title ?? null,
    };
  }

  listRoles(): RoleSummary[] {
    return this.options.deps.store
      .listBots()
      .filter((bot) => bot.kind === "role")
      .map((bot) => this.roleSummary(bot));
  }

  /**
   * The lead and managers build the team on demand: when no existing role
   * fits a task, create a persistent worker instead of doing the work in the
   * wrong role or failing. A duplicate name returns the existing role so a
   * model that loses track of the team cannot fork it.
   */
  createWorker(input: {
    callerBotId: string;
    name: string;
    specialty: string;
    instructions?: string;
    model?: ModelRef;
    computers?: ComputerKind[];
    workspaceId?: string | null;
    access?: AccessMode;
  }): { role: RoleSummary; created: boolean } {
    const store = this.options.deps.store;
    const caller = store.getBot(input.callerBotId);
    if (!caller) {
      throw new Error(`unknown caller: ${input.callerBotId}`);
    }
    const name = input.name.trim();
    const specialty = input.specialty.trim();
    if (!name) {
      throw new Error("a worker needs a name");
    }
    if (!specialty) {
      throw new Error("a worker needs a specialty");
    }
    const bots = store.listBots();
    const existing = bots.find(
      (bot) =>
        bot.kind === "role" &&
        bot.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      return { role: this.roleSummary(existing), created: false };
    }
    const roles = bots.filter((bot) => bot.kind === "role");
    if (roles.length >= MAX_TEAM_ROLES) {
      throw new Error(
        `the team already has ${MAX_TEAM_ROLES} workers; reuse an existing ` +
          "role or ask the user to remove one",
      );
    }
    const model = input.model ?? caller.model;
    if (!model) {
      throw new Error("no model is available for the worker");
    }
    const systemPrompt = [
      systemPromptForBot(name, specialty),
      input.instructions?.trim() ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // Workers inherit the caller's computers (ADR-021) and workspace
    // (ADR-022): capability and project follow the manager's approval instead
    // of being chosen per worker.
    const computers = normalizeComputers(
      input.computers ?? caller.computers,
      caller.computers,
    );
    const bot = store.createBot({
      name,
      systemPrompt,
      model,
      kind: "role",
      role: specialty,
      computers,
      workspaceId: input.workspaceId ?? caller.workspaceId ?? null,
      access: input.access ?? caller.access,
      delegates: false,
    });
    this.options.emit({
      type: "bot.created",
      requestId: `worker:${bot.id}`,
      bot,
    });
    return { role: this.roleSummary(bot), created: true };
  }

  listProjects(): ProjectSummary[] {
    const store = this.options.deps.store;
    return store
      .listBots()
      .filter((bot) => bot.kind === "project")
      .map((bot) => this.projectSummary(bot));
  }

  listWorkspaces(): WorkspaceSummary[] {
    const store = this.options.deps.store;
    const bots = store.listBots();
    return store.listWorkspaces().map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      root: workspace.root,
      markers: workspace.markers,
      missing: !existsSync(workspace.root),
      agentCount: bots.filter((bot) => bot.workspaceId === workspace.id).length,
    }));
  }

  createProject(input: {
    callerBotId: string;
    name: string;
    scope: string;
    brief?: string;
    model?: ModelRef;
    computers?: ComputerKind[];
    workspaceId?: string | null;
    access?: AccessMode;
  }): ProjectSummary {
    const store = this.options.deps.store;
    const caller = store.getBot(input.callerBotId);
    const model = input.model ?? caller?.model;
    if (!model) {
      throw new Error("no model is available for the project manager");
    }
    const systemPrompt = [
      `You are the manager of the "${input.name}" project. ${input.scope}.`,
      input.brief?.trim() ? `Context from the lead: ${input.brief.trim()}` : "",
      PROJECT_MANAGER_CONTRACT,
    ]
      .filter(Boolean)
      .join("\n\n");
    const project = store.createBot({
      name: input.name,
      systemPrompt,
      model,
      kind: "project",
      role: input.scope,
      avatar: "🗂️",
      color: "#2563eb",
      computers: normalizeComputers(input.computers ?? null),
      workspaceId: input.workspaceId ?? null,
      access: input.access ?? "project",
      delegates: true,
    });
    this.options.emit({
      type: "bot.created",
      requestId: `project:${project.id}`,
      bot: project,
    });
    return this.projectSummary(project);
  }

  askProject(input: {
    callerBotId: string;
    projectId: string;
    request: string;
    title?: string;
    grant?: TaskGrantRequest;
  }): SpawnedTask {
    const store = this.options.deps.store;
    const project = store.getBot(input.projectId);
    if (!project) {
      throw new Error(`unknown project: ${input.projectId}`);
    }
    if (project.kind !== "project") {
      throw new Error(`${project.name} is not a project.`);
    }
    const thread = store.getOrCreateThread(project.id);
    const request = input.request.trim();
    const title = (input.title?.trim() || request.split("\n")[0] || "Request")
      .slice(0, 80);
    const grant = this.resolveGrant(project, input.grant, null, undefined);
    const task = store.createTask({
      leadId: input.callerBotId,
      roleId: project.id,
      title,
      brief: request,
      projectId: project.id,
      threadId: thread.id,
      depth: 0,
      display: grant.display,
      grant,
      budget: grant.budget,
    });
    this.options.emit({ type: "task.upserted", task });
    this.pumpQueue();
    const current = store.getTask(task.id) ?? task;
    return {
      id: current.id,
      title: current.title,
      roleName: project.name,
      status: current.status,
      parentId: current.parentId,
      depth: current.depth,
      queued: current.status === "queued",
    };
  }

  private projectSummary(project: Bot): ProjectSummary {
    const store = this.options.deps.store;
    const active = store.activeRequestForProject(project.id);
    const openTasks = store
      .listTasksForProject(project.id)
      .filter(
        (task) => task.status === "queued" || task.status === "running",
      ).length;
    return {
      id: project.id,
      name: project.name,
      scope: project.role ?? null,
      model: project.model,
      status: active?.status === "running" ? "working" : "idle",
      activeTaskId: active?.id ?? null,
      activeTaskTitle: active?.title ?? null,
      openTasks,
      updatedAt: project.createdAt,
    };
  }

  spawn(input: {
    callerBotId: string;
    parentTaskId?: string;
    roleId: string;
    brief: string;
    title?: string;
    display?: TaskDisplay;
    grant?: TaskGrantRequest;
  }): SpawnedTask {
    const store = this.options.deps.store;
    const role = store.getBot(input.roleId);
    if (!role) {
      throw new Error(`unknown role: ${input.roleId}`);
    }
    if (role.kind !== "role") {
      throw new Error(`${role.name} is the lead, not a role to delegate to.`);
    }
    const parent = input.parentTaskId
      ? store.getTask(input.parentTaskId)
      : null;
    if (input.parentTaskId && !parent) {
      throw new Error(`unknown parent task: ${input.parentTaskId}`);
    }
    if (parent && parent.depth >= MAX_DEPTH) {
      throw new Error(
        "Workers cannot delegate: the hierarchy is capped at project → worker.",
      );
    }
    const leadId = parent ? parent.leadId : input.callerBotId;
    const depth = parent ? parent.depth + 1 : 0;
    const grant = this.resolveGrant(role, input.grant, parent, input.display);
    const brief = input.brief.trim();
    const title = (input.title?.trim() || brief.split("\n")[0] || "Task").slice(
      0,
      80,
    );
    const task = store.createTask({
      leadId,
      roleId: role.id,
      title,
      brief,
      projectId: parent?.projectId ?? null,
      parentId: parent?.id ?? null,
      depth,
      display: grant.display,
      grant,
      budget: grant.budget,
    });
    this.options.emit({ type: "task.upserted", task });
    this.pumpQueue();
    const current = store.getTask(task.id) ?? task;
    return {
      id: current.id,
      title: current.title,
      roleName: role.name,
      status: current.status,
      parentId: current.parentId,
      depth: current.depth,
      queued: current.status === "queued",
    };
  }

  status(taskId?: string): TaskSummary[] {
    const store = this.options.deps.store;
    const tasks = taskId
      ? [store.getTask(taskId)].filter((task): task is Task => Boolean(task))
      : store.listTasks(50);
    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      roleName: store.getBot(task.roleId)?.name ?? "unknown role",
      status: task.status,
      display: task.display,
      parentId: task.parentId,
      depth: task.depth,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      result: task.result,
      error: task.error,
    }));
  }

  cancel(taskId: string): boolean {
    const store = this.options.deps.store;
    const task = store.getTask(taskId);
    if (!task) {
      return false;
    }
    let cancelled = false;
    for (const child of store.listChildTasks(taskId)) {
      if (child.status === "queued" || child.status === "running") {
        cancelled = this.cancel(child.id) || cancelled;
      }
    }
    const controller = this.controllers.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    if (task.status === "queued") {
      const updated = store.updateTask(taskId, {
        status: "cancelled",
        endedAt: new Date().toISOString(),
      });
      if (updated) {
        this.options.emit({ type: "task.upserted", task: updated });
        this.notifyParent(updated);
      }
      return true;
    }
    return cancelled;
  }

  cancelForRole(roleId: string): void {
    const store = this.options.deps.store;
    for (const task of store.listTasksForRole(roleId)) {
      if (task.status === "queued" || task.status === "running") {
        this.cancel(task.id);
      }
    }
  }

  isRunning(taskId: string): boolean {
    return this.controllers.has(taskId);
  }

  async stop(): Promise<void> {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.activeRuns]);
  }

  private defaultGrant(role: Bot): TaskGrant {
    // Browser and desktop live only on the microVM; shell and file tools work
    // on either computer. The grant follows the role's capability set, and a
    // chat-only role gets no computer tools at all (ADR-021).
    const vmTools = [
      "shell",
      "read_file",
      "write_file",
      "browser",
      "browser_execute",
      "browser_step",
      "browse",
      "desktop",
    ];
    const localTools = ["shell", "read_file", "write_file"];
    const tools = role.computers.includes("firecracker")
      ? vmTools
      : role.computers.includes("mac")
        ? localTools
        : [];
    return {
      tools,
      display: "none",
      budget: {
        wallClockMs: DEFAULT_WALL_CLOCK_MS,
        toolCalls: DEFAULT_TOOL_CALLS,
        tokens: DEFAULT_TOKENS,
      },
    };
  }

  private resolveGrant(
    role: Bot,
    request: TaskGrantRequest | undefined,
    parent: Task | null,
    display: TaskDisplay | undefined,
  ): TaskGrant {
    const base = this.defaultGrant(role);
    let tools =
      request?.tools && request.tools.length > 0
        ? [...new Set(request.tools)]
        : [...base.tools];
    const grantDisplay = request?.display ?? display ?? base.display;
    const budget: TaskBudget = {
      wallClockMs: request?.budget?.wallClockMs ?? base.budget.wallClockMs,
      toolCalls: request?.budget?.toolCalls ?? base.budget.toolCalls,
      tokens: request?.budget?.tokens ?? base.budget.tokens,
    };

    if (parent?.grant) {
      const parentTools = new Set(parent.grant.tools);
      tools = tools.filter((tool) => parentTools.has(tool));
      if (tools.length === 0) {
        throw new Error(
          "the requested tools are outside the parent grant; a manager can only allocate what it was given.",
        );
      }
      const remaining = this.remainingBudget(parent);
      budget.wallClockMs = this.clampBudget(
        budget.wallClockMs,
        remaining.wallClockMs,
      );
      budget.toolCalls = this.clampBudget(
        budget.toolCalls,
        remaining.toolCalls,
      );
      budget.tokens = this.clampBudget(budget.tokens, remaining.tokens);
      if (
        (budget.toolCalls !== null && budget.toolCalls <= 0) ||
        (budget.wallClockMs !== null && budget.wallClockMs <= 0) ||
        (budget.tokens !== null && budget.tokens <= 0)
      ) {
        throw new Error(
          "the project budget is exhausted; no budget is left for another child task.",
        );
      }
    }

    return { tools, display: grantDisplay, budget };
  }

  private clampBudget(
    requested: number | null | undefined,
    remaining: number | null | undefined,
  ): number | null {
    if (remaining === null || remaining === undefined) {
      return requested ?? null;
    }
    if (requested === null || requested === undefined) {
      return remaining;
    }
    return Math.min(requested, remaining);
  }

  private remainingBudget(parent: Task): TaskBudget {
    const store = this.options.deps.store;
    const children = store.listChildTasks(parent.id);
    // Children consume the parent's budget as they work, so what is left is
    // the parent's own usage plus everything its children have already spent.
    const usedWallClock =
      (parent.usage?.wallClockMs ?? 0) +
      children.reduce(
        (total, child) => total + (child.usage?.wallClockMs ?? 0),
        0,
      );
    const usedToolCalls =
      (parent.usage?.toolCalls ?? 0) +
      children.reduce(
        (total, child) => total + (child.usage?.toolCalls ?? 0),
        0,
      );
    const usedTokens =
      (parent.usage?.inputTokens ?? 0) +
      (parent.usage?.outputTokens ?? 0) +
      children.reduce(
        (total, child) =>
          total +
          (child.usage?.inputTokens ?? 0) +
          (child.usage?.outputTokens ?? 0),
        0,
      );
    const remaining = (
      limit: number | null | undefined,
      used: number,
    ): number | null => {
      if (limit === null || limit === undefined) {
        return null;
      }
      return Math.max(0, limit - used);
    };
    return {
      wallClockMs: remaining(parent.budget?.wallClockMs, usedWallClock),
      toolCalls: remaining(parent.budget?.toolCalls, usedToolCalls),
      tokens: remaining(parent.budget?.tokens, usedTokens),
    };
  }

  /**
   * A task's budget bounds the whole task, not one turn: each new turn (a
   * manager woken by a child, an overflow retry) gets only what is left after
   * the task's own usage and its children's usage.
   */
  private remainingTaskBudget(task: Task): {
    budget: TaskBudget | null;
    exhausted: string | null;
  } {
    if (!task.budget) {
      return { budget: null, exhausted: null };
    }
    const store = this.options.deps.store;
    const messages = task.threadId
      ? store.listMessages(task.threadId, { includeFolded: true })
      : [];
    const own = computeUsage(task, messages);
    const children = store.listChildTasks(task.id);
    const usedTokens =
      own.inputTokens +
      own.outputTokens +
      children.reduce(
        (total, child) =>
          total +
          (child.usage ? child.usage.inputTokens + child.usage.outputTokens : 0),
        0,
      );
    const usedCalls =
      own.toolCalls +
      children.reduce(
        (total, child) => total + (child.usage?.toolCalls ?? 0),
        0,
      );
    const remaining: TaskBudget = {
      wallClockMs:
        task.budget.wallClockMs === null ||
        task.budget.wallClockMs === undefined
          ? null
          : Math.max(0, task.budget.wallClockMs - own.wallClockMs),
      toolCalls:
        task.budget.toolCalls === null || task.budget.toolCalls === undefined
          ? null
          : Math.max(0, task.budget.toolCalls - usedCalls),
      tokens:
        task.budget.tokens === null || task.budget.tokens === undefined
          ? null
          : Math.max(0, task.budget.tokens - usedTokens),
    };
    if ((remaining.toolCalls ?? 1) <= 0) {
      return {
        budget: remaining,
        exhausted: `task tool-call budget exhausted (${task.budget.toolCalls})`,
      };
    }
    if ((remaining.tokens ?? 1) <= 0) {
      return {
        budget: remaining,
        exhausted: `task token budget exhausted (${task.budget.tokens})`,
      };
    }
    if ((remaining.wallClockMs ?? 1) <= 0) {
      return {
        budget: remaining,
        exhausted: `task time budget exhausted (${Math.round((task.budget.wallClockMs ?? 0) / 1000)}s)`,
      };
    }
    return { budget: remaining, exhausted: null };
  }

  private pumpQueue(): void {
    for (const next of this.options.deps.store.listQueuedTasks()) {
      if (this.controllers.size >= MAX_CONCURRENT_TASKS) {
        return;
      }
      if (!this.canStart(next)) {
        continue;
      }
      this.startTask(next);
    }
  }

  private canStart(task: Task): boolean {
    const projectId = task.projectId ?? null;
    if (!projectId) {
      return true;
    }
    if (task.roleId !== projectId) {
      // A worker session: it runs while its project's request is running.
      return true;
    }
    // A project request: one at a time per project.
    const active = this.options.deps.store.activeRequestForProject(projectId);
    return !active || active.id === task.id;
  }

  private destroyComputer(taskId: string): void {
    const store = this.options.deps.store;
    const task = store.getTask(taskId);
    if (!task) {
      return;
    }
    const projectId = task.projectId ?? null;
    const isRequest = projectId !== null && task.roleId === projectId;
    if (isRequest) {
      // The project's computer is persistent; only its explicit deletion
      // destroys it.
      return;
    }
    this.options.emit({
      type: "sandbox.state",
      botId: task.roleId,
      taskId,
      state: "stopped",
    });
    const sandbox = this.options.deps.sandbox;
    if (!sandbox) {
      return;
    }
    // For a worker session this releases the session's own browser daemon and
    // profile; for a standalone task it destroys its computer.
    void sandbox.destroy(taskId).catch((error) => {
      console.warn(
        `failed to destroy computer for task ${taskId}: ${(error as Error).message}`,
      );
    });
  }

  cancelForProject(projectId: string): void {
    const store = this.options.deps.store;
    for (const task of store.listTasksForProject(projectId)) {
      if (task.status === "queued" || task.status === "running") {
        this.cancel(task.id);
      }
    }
  }

  /**
   * Fail tasks that were queued or running when the daemon stopped, and remove
   * their computers. Recovery is silent: no lead turn, no model calls.
   */
  recover(): void {
    const store = this.options.deps.store;
    for (const task of store.listTasks(200)) {
      if (task.status !== "queued" && task.status !== "running") {
        continue;
      }
      const updated = store.updateTask(task.id, {
        status: "failed",
        error: "the daemon restarted while this task was running",
        endedAt: new Date().toISOString(),
      });
      if (updated) {
        this.options.emit({ type: "task.upserted", task: updated });
        this.destroyComputer(task.id);
      }
    }
  }

  private taskContextNote(task: Task, role: Bot): string {
    const parts: string[] = [];
    if (role.delegates) {
      parts.push(
        "You are managing this project. Delegate work with spawn_worker; each " +
          "child runs in its own computer. When you stop speaking with no " +
          "children still running, your final message becomes the project " +
          "report and the project closes. While children run, the project " +
          "stays open and you are woken with each result. Keep the evidence " +
          "handles from child results in your report; do not paraphrase them " +
          "away. You can only allocate tools and budget that fit inside your " +
          "own grant.",
      );
    }
    if (task.grant) {
      parts.push(
        `Your grant: tools ${task.grant.tools.join(", ") || "none"}; ` +
          `display ${task.grant.display}; budget ${describeBudget(task.budget)}. ` +
          "Tool calls inside the grant run without asking; anything outside " +
          "it needs approval.",
      );
    }
    return parts.join("\n\n");
  }

  private childNote(child: Task, parent: Task): string {
    const store = this.options.deps.store;
    const roleName = store.getBot(child.roleId)?.name ?? "a teammate";
    const lines = [
      `[child task ${child.status}] "${child.title}" — ${roleName}`,
      `Task id: ${child.id}`,
    ];
    if (child.error) {
      lines.push(`Error: ${child.error}`);
    }
    if (child.result) {
      lines.push(`Result:\n${truncate(child.result, NOTE_LIMIT)}`);
    }
    if (child.evidence) {
      lines.push(`Evidence ledger:\n${truncate(child.evidence, NOTE_LIMIT)}`);
    }
    if (child.usage) {
      lines.push(
        `Used: ${child.usage.toolCalls} tool calls, ` +
          `${child.usage.inputTokens + child.usage.outputTokens} tokens, ` +
          `${Math.round(child.usage.wallClockMs / 1000)}s`,
      );
    }
    const active = store
      .listChildTasks(parent.id)
      .filter(
        (candidate) =>
          candidate.id !== child.id &&
          (candidate.status === "queued" || candidate.status === "running"),
      );
    if (active.length > 0) {
      lines.push(
        `Still running:\n${active
          .map(
            (candidate) =>
              `- "${candidate.title}" (${store.getBot(candidate.roleId)?.name ?? "unknown role"})`,
          )
          .join("\n")}`,
      );
    }
    lines.push(
      `Remaining project budget: ${describeBudget(this.remainingBudget(parent))}`,
    );
    return lines.join("\n\n");
  }

  private startTask(
    task: Task,
    internal?: { text: string; contextNote: string },
  ): void {
    const { deps, emit } = this.options;
    const store = deps.store;
    const role = store.getBot(task.roleId);
    if (!role) {
      const updated = store.updateTask(task.id, {
        status: "failed",
        error: `unknown role: ${task.roleId}`,
        endedAt: new Date().toISOString(),
      });
      if (updated) {
        emit({ type: "task.upserted", task: updated });
        this.notifyParent(updated);
      }
      return;
    }

    const remaining = this.remainingTaskBudget(task);
    if (remaining.exhausted) {
      const messages = task.threadId
        ? store.listMessages(task.threadId, { includeFolded: true })
        : [];
      const updated = store.updateTask(task.id, {
        status: "failed",
        error: remaining.exhausted,
        usage: computeUsage(task, messages),
        endedAt: new Date().toISOString(),
      });
      if (updated) {
        emit({ type: "task.upserted", task: updated });
        this.notifyParent(updated);
      }
      return;
    }

    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const running = store.updateTask(task.id, {
      status: "running",
      startedAt: task.startedAt ?? new Date().toISOString(),
    });
    if (running) {
      emit({ type: "task.upserted", task: running });
    }

    const runId = randomUUID();
    let failure: string | null = null;
    const forward = (message: ServerMessage): void => {
      // Worker errors surface through the task row, not as chat errors.
      if (message.type === "chat.error") {
        failure = message.message;
        return;
      }
      emit(message);
    };

    const projectId = task.projectId ?? null;
    const isRequest = projectId !== null && task.roleId === projectId;
    const computerId = projectId ?? task.id;
    const browserId = projectId && !isRequest ? task.id : undefined;
    const guestCwd =
      projectId && !isRequest ? `/root/workspaces/${task.id}` : undefined;

    const contextParts = [this.taskContextNote(task, role)];
    if (guestCwd) {
      contextParts.push(
        `Your workspace on this computer is ${guestCwd}; keep new files there. ` +
          "The project's shared assets live in the project manager's home directory.",
      );
    }
    if (internal?.contextNote) {
      contextParts.push(internal.contextNote);
    }
    const run = runAgent(
      deps,
      {
        runId,
        botId: task.roleId,
        threadId: task.threadId ?? undefined,
        text: internal?.text ?? task.brief,
        internal: Boolean(internal),
        contextNote: contextParts.filter(Boolean).join("\n\n"),
        taskId: task.id,
        projectId,
        computerId,
        browserId,
        guestCwd,
        grant: task.grant,
        budget: remaining.budget ?? task.budget,
      },
      forward,
      controller.signal,
    )
      .catch((error) => {
        failure = (error as Error).message;
      })
      .finally(() => {
        this.controllers.delete(task.id);
        this.activeRuns.delete(run);
        this.finishRun(task.id, failure, controller.signal.aborted);
        this.pumpQueue();
      });
    this.activeRuns.add(run);
    void run;
  }

  private finishRun(
    taskId: string,
    failure: string | null,
    aborted: boolean,
  ): void {
    const store = this.options.deps.store;
    const task = store.getTask(taskId);
    if (!task) {
      return;
    }
    const messages = task.threadId
      ? store.listMessages(task.threadId, { includeFolded: true })
      : [];
    const final = lastAssistantMessage(messages);
    const records = messages.flatMap((message) => message.toolCalls ?? []);
    const evidence = records.length ? renderEvidenceLedger(records) : null;
    const usage = computeUsage(task, messages);
    const endedAt = new Date().toISOString();

    if (aborted) {
      const updated = store.updateTask(taskId, {
        status: "cancelled",
        usage,
        endedAt,
      });
      if (updated) {
        this.options.emit({ type: "task.upserted", task: updated });
        this.destroyComputer(taskId);
        this.notifyParent(updated);
      }
      return;
    }
    if (failure) {
      const updated = store.updateTask(taskId, {
        status: "failed",
        error: failure,
        result: final?.content ?? null,
        evidence,
        usage,
        endedAt,
      });
      if (updated) {
        this.options.emit({ type: "task.upserted", task: updated });
        this.destroyComputer(taskId);
        this.notifyParent(updated);
      }
      return;
    }

    const queued = this.inboxes.get(taskId);
    if (queued && queued.length > 0) {
      this.inboxes.delete(taskId);
      const updated = store.updateTask(taskId, { usage });
      if (updated) {
        this.options.emit({ type: "task.upserted", task: updated });
      }
      this.startTask(updated ?? task, {
        text:
          "A child task finished. Review its result and evidence, then " +
          "continue the project: delegate more work, revise, or produce your " +
          "final project report if the work is complete.",
        contextNote: queued.join("\n\n"),
      });
      return;
    }

    if (store.countActiveChildren(taskId) > 0) {
      // A manager stays open while its children run; the next child event
      // wakes it with a new internal turn.
      const updated = store.updateTask(taskId, { usage });
      if (updated) {
        this.options.emit({ type: "task.upserted", task: updated });
      }
      return;
    }

    const updated = store.updateTask(taskId, {
      status: "done",
      result: final?.content ?? null,
      evidence,
      usage,
      endedAt,
    });
    if (updated) {
      this.options.emit({ type: "task.upserted", task: updated });
      this.destroyComputer(taskId);
      this.notifyParent(updated);
    }
  }

  private notifyParent(task: Task): void {
    if (!task.parentId) {
      this.options.onTaskSettled(task);
      return;
    }
    const store = this.options.deps.store;
    const parent = store.getTask(task.parentId);
    if (
      !parent ||
      parent.status === "done" ||
      parent.status === "failed" ||
      parent.status === "cancelled"
    ) {
      return;
    }
    const note = this.childNote(task, parent);
    if (this.controllers.has(parent.id)) {
      const queue = this.inboxes.get(parent.id) ?? [];
      queue.push(note);
      this.inboxes.set(parent.id, queue);
      return;
    }
    this.startTask(parent, {
      text:
        "A child task finished. Review its result and evidence, then continue " +
        "the project: delegate more work, revise, or produce your final " +
        "project report if the work is complete.",
      contextNote: note,
    });
  }
}
