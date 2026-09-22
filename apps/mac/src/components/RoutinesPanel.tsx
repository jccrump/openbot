import { useEffect, useState } from "react";
import type { Bot, Routine, RoutineRun } from "@openbot/protocol";
import type { RoutineActionResult } from "../lib/useDaemon";
import { scheduleLabel, relativeLabel } from "../lib/routineOptions";
import { ConfirmDialog } from "./ConfirmDialog";

function runStatusLabel(run: RoutineRun): string {
  if (run.status === "ok") {
    return "Finished";
  }
  if (run.status === "running") {
    return "Running";
  }
  if (run.status === "skipped") {
    return "Skipped";
  }
  return "Failed";
}

export function RoutinesPanel({
  bot,
  routines,
  onEdit,
  onRun,
  onToggle,
  onRemove,
  onLoadRuns,
}: {
  bot: Bot | null;
  routines: Routine[];
  onEdit: (routine: Routine) => void;
  onRun: (routine: Routine) => Promise<RoutineActionResult>;
  onToggle: (routine: Routine, enabled: boolean) => Promise<void>;
  onRemove: (routine: Routine) => Promise<void>;
  onLoadRuns: (routineId: string) => Promise<RoutineRun[]>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RoutineRun[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Routine | null>(null);

  // Keep an open history fresh while a run settles.
  const expandedLastRun =
    routines.find((routine) => routine.id === expanded)?.lastRun ?? null;
  const expandedLastRunId = expandedLastRun?.id ?? null;
  const expandedLastRunStatus = expandedLastRun?.status ?? null;
  useEffect(() => {
    if (!expanded) {
      return;
    }
    let cancelled = false;
    void onLoadRuns(expanded).then((history) => {
      if (!cancelled) {
        setRuns((current) => ({ ...current, [expanded]: history }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, expandedLastRunId, expandedLastRunStatus, onLoadRuns]);

  if (!bot) {
    return (
      <div className="routines-empty">
        <p className="routines-title">No agent selected</p>
        <p className="routines-sub">
          Routines belong to an agent and run on that agent's computers.
        </p>
      </div>
    );
  }

  const toggleHistory = async (routine: Routine) => {
    if (expanded === routine.id) {
      setExpanded(null);
      return;
    }
    setExpanded(routine.id);
    setNotice(null);
    const history = await onLoadRuns(routine.id);
    setRuns((current) => ({ ...current, [routine.id]: history }));
  };

  const runNow = async (routine: Routine) => {
    setBusyId(routine.id);
    setNotice(null);
    const result = await onRun(routine);
    if (!result.ok && result.message) {
      setNotice(result.message);
    }
    setBusyId(null);
  };

  const toggle = async (routine: Routine, enabled: boolean) => {
    setNotice(null);
    try {
      await onToggle(routine, enabled);
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  return (
    <div className="routines-panel">
      {notice && <p className="routine-error">{notice}</p>}

      {routines.length === 0 ? (
        <div className="routines-empty">
          <p className="routines-title">No routines yet</p>
          <p className="routines-sub">
            Create one to have {bot.name} do something on a schedule.
          </p>
        </div>
      ) : (
        <ul className="routine-list">
          {routines.map((routine) => {
            const history = runs[routine.id] ?? [];
            const last = routine.lastRun;
            return (
              <li
                key={routine.id}
                className={`routine-card${
                  routine.available ? "" : " routine-card-blocked"
                }`}
              >
                <div className="routine-card-head">
                  <div className="routine-card-title">
                    <span className="routine-name">{routine.name}</span>
                    <span
                      className={`routine-computer routine-computer-${routine.computer}`}
                    >
                      {routine.computer === "firecracker" ? "VM" : "Local"}
                    </span>
                  </div>
                  <button
                    role="switch"
                    aria-checked={routine.enabled}
                    aria-label={`${routine.name} enabled`}
                    className={`switch ${routine.enabled ? "switch-on" : ""}`}
                    onClick={() => void toggle(routine, !routine.enabled)}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                <p className="routine-brief">{routine.brief}</p>

                <div className="routine-meta">
                  <span>{scheduleLabel(routine.schedule)}</span>
                  {routine.enabled && routine.nextRunAt && (
                    <span>Next {relativeLabel(routine.nextRunAt)}</span>
                  )}
                  {last && (
                    <span className={`routine-status routine-status-${last.status}`}>
                      {runStatusLabel(last)}
                      {last.finishedAt
                        ? ` ${relativeLabel(last.finishedAt)}`
                        : ""}
                    </span>
                  )}
                </div>

                {!routine.available && (
                  <p className="routine-blocked">
                    {bot.name} has no access to{" "}
                    {routine.computer === "firecracker"
                      ? "the Firecracker microVM"
                      : "This Mac"}
                    . Grant it in Agent settings or edit the routine.
                  </p>
                )}
                {last?.status === "error" && last.reason && (
                  <p className="routine-blocked">{last.reason}</p>
                )}
                {last?.status === "skipped" && last.reason && (
                  <p className="routine-blocked">{last.reason}</p>
                )}

                <div className="routine-actions">
                  <button
                    className="ghost-button routine-action"
                    disabled={busyId === routine.id || !routine.available}
                    onClick={() => void runNow(routine)}
                  >
                    {busyId === routine.id ? "Starting…" : "Run now"}
                  </button>
                  <button
                    className="ghost-button routine-action"
                    aria-pressed={expanded === routine.id}
                    onClick={() => void toggleHistory(routine)}
                  >
                    History
                  </button>
                  <button
                    className="ghost-button routine-action"
                    onClick={() => onEdit(routine)}
                  >
                    Edit
                  </button>
                  <button
                    className="ghost-button routine-action routine-action-danger"
                    onClick={() => setConfirming(routine)}
                  >
                    Delete
                  </button>
                </div>

                {expanded === routine.id && (
                  <div className="routine-history">
                    {history.length === 0 ? (
                      <p className="routines-sub">No runs yet.</p>
                    ) : (
                      <ul className="routine-run-list">
                        {history.map((run) => (
                          <li key={run.id} className="routine-run">
                            <span
                              className={`routine-status routine-status-${run.status}`}
                            >
                              {runStatusLabel(run)}
                            </span>
                            <span className="routine-run-time">
                              {relativeLabel(run.startedAt)}
                            </span>
                            {run.reason && (
                              <span className="routine-run-reason">
                                {run.reason}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? `Delete ${confirming.name}?` : "Delete routine?"}
        description={
          confirming
            ? `This removes the schedule. Past runs stay in ${bot.name}'s thread.`
            : ""
        }
        confirmLabel="Delete routine"
        onConfirm={() => {
          const routine = confirming;
          setConfirming(null);
          if (routine) {
            void onRemove(routine).catch((error) =>
              setNotice((error as Error).message),
            );
          }
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
