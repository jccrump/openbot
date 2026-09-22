import { randomUUID } from "node:crypto";
import type { ComputerKind, Routine, RoutineSchedule } from "@openbot/protocol";
import { botHasComputer } from "@openbot/protocol";
import type { Store } from "./store";

const DEFAULT_TICK_MS = 30_000;

export interface RoutineStartResult {
  ok: boolean;
  /**
   * The agent is mid-turn. The firing is not journaled and the routine keeps
   * its due time so it fires as soon as the agent is free.
   */
  retry?: boolean;
  message?: string;
}

export interface RoutineStartInput {
  routine: Routine;
  runId: string;
  threadId: string;
}

export interface RoutineServiceDeps {
  store: Store;
  /** Start a turn for the routine on its computer. */
  start: (input: RoutineStartInput) => RoutineStartResult;
  /** Broadcast the routine list after any change. */
  changed: () => void;
  tickMs?: number;
  now?: () => Date;
}

export function computerLabel(computer: ComputerKind): string {
  return computer === "mac" ? "This Mac" : "the Firecracker microVM";
}

/** The next time a schedule fires strictly after `from`. */
export function nextOccurrence(schedule: RoutineSchedule, from: Date): Date {
  if (schedule.kind === "interval") {
    return new Date(from.getTime() + schedule.minutes * 60_000);
  }
  const next = new Date(from);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

/**
 * Routines are agent-owned scheduled spawns (ADR-027). The service owns the
 * clock: it fires due routines into the agent's thread on the routine's
 * computer, journals every firing, and skips routines whose computer the agent
 * no longer has access to. It never runs two turns at once for one agent.
 */
export class RoutineService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly deps: RoutineServiceDeps) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.tickMs ?? DEFAULT_TICK_MS,
    );
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  list(): Routine[] {
    return this.deps.store.listRoutines();
  }

  runs(routineId: string, limit = 20) {
    return this.deps.store.listRoutineRuns(routineId, limit);
  }

  create(input: {
    botId: string;
    name: string;
    brief: string;
    computer: ComputerKind;
    schedule: RoutineSchedule;
    enabled?: boolean;
  }): Routine {
    const enabled = input.enabled !== false;
    const routine = this.deps.store.createRoutine({
      ...input,
      enabled,
      nextRunAt: enabled
        ? nextOccurrence(input.schedule, this.now()).toISOString()
        : null,
    });
    this.deps.changed();
    return routine;
  }

  update(
    id: string,
    patch: {
      name?: string;
      brief?: string;
      computer?: ComputerKind;
      schedule?: RoutineSchedule;
      enabled?: boolean;
    },
  ): Routine | null {
    const existing = this.deps.store.getRoutine(id);
    if (!existing) {
      return null;
    }
    const enabled = patch.enabled ?? existing.enabled;
    const schedule = patch.schedule ?? existing.schedule;
    const reschedule =
      patch.schedule !== undefined ||
      (patch.enabled === true && !existing.enabled) ||
      existing.nextRunAt === null;
    const nextRunAt = enabled
      ? reschedule
        ? nextOccurrence(schedule, this.now()).toISOString()
        : existing.nextRunAt
      : null;
    const routine = this.deps.store.updateRoutine(id, { ...patch, nextRunAt });
    this.deps.changed();
    return routine;
  }

  remove(id: string): boolean {
    const removed = this.deps.store.deleteRoutine(id);
    if (removed) {
      this.deps.changed();
    }
    return removed;
  }

  /** Fire a routine now, regardless of its schedule. */
  runNow(routineId: string): { ok: boolean; message: string | null } {
    const routine = this.deps.store.getRoutine(routineId);
    if (!routine) {
      return { ok: false, message: "unknown routine" };
    }
    const refusal = this.refusal(routine);
    if (refusal) {
      return { ok: false, message: refusal };
    }
    const bot = this.deps.store.getBot(routine.botId)!;
    const thread = this.deps.store.getOrCreateThread(bot.id);
    const runId = randomUUID();
    const started = this.deps.start({
      routine,
      runId,
      threadId: thread.id,
    });
    if (!started.ok) {
      return {
        ok: false,
        message: started.message ?? "could not start the routine",
      };
    }
    this.deps.store.createRoutineRun({
      id: runId,
      routineId: routine.id,
      botId: bot.id,
      threadId: thread.id,
      status: "running",
    });
    this.deps.changed();
    return { ok: true, message: null };
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const now = this.now();
      // A routine enabled without a due time (fresh, or reset) is scheduled
      // from now rather than fired immediately.
      let rescheduled = false;
      for (const routine of this.deps.store.listRoutines()) {
        if (routine.enabled && routine.nextRunAt === null) {
          this.deps.store.updateRoutine(routine.id, {
            nextRunAt: nextOccurrence(routine.schedule, now).toISOString(),
          });
          rescheduled = true;
        }
      }
      if (rescheduled) {
        this.deps.changed();
      }
      for (const routine of this.deps.store.routinesDue(now.toISOString())) {
        this.fire(routine, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Fire one due routine. The due time always advances (except when the agent
   * is busy, where the firing waits for the next tick) so a routine cannot
   * pile up missed runs.
   */
  private fire(routine: Routine, now: Date): void {
    const advance = (): void => {
      this.deps.store.updateRoutine(routine.id, {
        nextRunAt: nextOccurrence(routine.schedule, now).toISOString(),
      });
    };
    const skip = (reason: string): void => {
      this.deps.store.createRoutineRun({
        routineId: routine.id,
        botId: routine.botId,
        status: "skipped",
        reason,
        finishedAt: new Date().toISOString(),
      });
      advance();
      this.deps.changed();
    };

    const refusal = this.refusal(routine);
    if (refusal) {
      skip(refusal);
      return;
    }
    const bot = this.deps.store.getBot(routine.botId)!;
    const thread = this.deps.store.getOrCreateThread(bot.id);
    const runId = randomUUID();
    const started = this.deps.start({ routine, runId, threadId: thread.id });
    if (!started.ok) {
      if (started.retry) {
        // Leave the due time in place: the run fires once the agent is free.
        return;
      }
      this.deps.store.createRoutineRun({
        id: runId,
        routineId: routine.id,
        botId: bot.id,
        threadId: thread.id,
        status: "error",
        reason: started.message ?? "could not start the routine",
        finishedAt: new Date().toISOString(),
      });
      advance();
      this.deps.changed();
      return;
    }
    this.deps.store.createRoutineRun({
      id: runId,
      routineId: routine.id,
      botId: bot.id,
      threadId: thread.id,
      status: "running",
    });
    advance();
    this.deps.changed();
  }

  /** Why the routine cannot run, or null when it can. */
  private refusal(routine: Routine): string | null {
    const bot = this.deps.store.getBot(routine.botId);
    if (!bot) {
      return "the agent no longer exists";
    }
    if (!botHasComputer(bot, routine.computer)) {
      return `the agent no longer has access to ${computerLabel(routine.computer)}`;
    }
    return null;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
