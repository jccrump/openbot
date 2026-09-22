import { useEffect, useState } from "react";
import type {
  Bot,
  ComputerKind,
  Routine,
  RoutineSchedule,
} from "@openbot/protocol";
import { botComputers, primaryComputer } from "@openbot/protocol";
import { scheduleLabel } from "../lib/routineOptions";

export interface RoutineDraft {
  name: string;
  brief: string;
  computer: ComputerKind;
  schedule: RoutineSchedule;
  enabled: boolean;
}

function computerName(computer: ComputerKind): string {
  return computer === "firecracker" ? "Firecracker microVM" : "This Mac";
}

export function RoutineModal({
  open,
  bot,
  routine,
  onClose,
  onSubmit,
}: {
  open: boolean;
  bot: Bot | null;
  /** The routine being edited; null creates a new one. */
  routine: Routine | null;
  onClose: () => void;
  onSubmit: (draft: RoutineDraft) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [computer, setComputer] = useState<ComputerKind>("firecracker");
  const [kind, setKind] = useState<"interval" | "daily">("daily");
  const [intervalValue, setIntervalValue] = useState("60");
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours">(
    "minutes",
  );
  const [dailyTime, setDailyTime] = useState("09:00");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !bot) {
      return;
    }
    setError(null);
    setBusy(false);
    if (routine) {
      setName(routine.name);
      setBrief(routine.brief);
      setComputer(routine.computer);
      setEnabled(routine.enabled);
      if (routine.schedule.kind === "interval") {
        setKind("interval");
        setIntervalUnit(
          routine.schedule.minutes % 60 === 0 ? "hours" : "minutes",
        );
        setIntervalValue(
          String(
            routine.schedule.minutes % 60 === 0
              ? routine.schedule.minutes / 60
              : routine.schedule.minutes,
          ),
        );
        setDailyTime("09:00");
      } else {
        setKind("daily");
        setDailyTime(
          `${String(routine.schedule.hour).padStart(2, "0")}:${String(
            routine.schedule.minute,
          ).padStart(2, "0")}`,
        );
      }
      return;
    }
    setName("");
    setBrief("");
    setComputer(primaryComputer(bot));
    setKind("daily");
    setIntervalValue("60");
    setIntervalUnit("minutes");
    setDailyTime("09:00");
    setEnabled(true);
  }, [open, bot, routine]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open || !bot) {
    return null;
  }

  const granted = botComputers(bot);
  const computerOptions = granted.includes(computer)
    ? granted
    : [...granted, computer];
  const requestedIntervalMinutes = (): number => {
    const raw = Math.round(Number(intervalValue));
    return intervalUnit === "hours" ? raw * 60 : raw;
  };
  const schedule = (): RoutineSchedule => {
    if (kind === "daily") {
      const [hour, minute] = dailyTime.split(":").map(Number);
      return {
        kind: "daily",
        hour: Number.isFinite(hour) ? hour! : 9,
        minute: Number.isFinite(minute) ? minute! : 0,
      };
    }
    const minutes = requestedIntervalMinutes();
    return {
      kind: "interval",
      minutes: Number.isFinite(minutes)
        ? Math.min(7 * 24 * 60, Math.max(5, minutes))
        : 60,
    };
  };
  const preview = schedule();
  const requestedMinutes =
    kind === "interval" ? requestedIntervalMinutes() : null;
  const validInterval =
    requestedMinutes === null ||
    (Number.isFinite(requestedMinutes) &&
      requestedMinutes >= 5 &&
      requestedMinutes <= 7 * 24 * 60);
  const intervalHint =
    requestedMinutes !== null && Number.isFinite(requestedMinutes) &&
    requestedMinutes > 7 * 24 * 60
      ? "The longest interval is 7 days."
      : "The shortest interval is 5 minutes.";
  const canSave =
    name.trim().length > 0 &&
    brief.trim().length > 0 &&
    granted.includes(computer) &&
    validInterval &&
    !busy;

  const submit = async () => {
    if (!canSave) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        brief: brief.trim(),
        computer,
        schedule: preview,
        enabled,
      });
      onClose();
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-label={routine ? "Edit routine" : "New routine"}
      onClick={onClose}
    >
      <div
        className="modal routine-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-head-title">
            <h2>{routine ? "Edit routine" : "New routine"}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </header>

        <div className="modal-body">
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Morning inbox check"
              maxLength={120}
              aria-label="Routine name"
            />
          </label>

          <label className="field">
            <span>Brief</span>
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="Check the inbox, summarize anything urgent, and flag messages that need a reply."
              maxLength={8000}
              aria-label="Routine brief"
              rows={5}
            />
            <p className="computer-warning">
              Delivered to {bot.name} as a message on schedule. It runs
              unattended, so write it as a standing instruction.
            </p>
          </label>

          <label className="field">
            <span>Computer</span>
            <select
              value={computer}
              aria-label="Routine computer"
              onChange={(event) =>
                setComputer(event.target.value as ComputerKind)
              }
            >
              {computerOptions.map((option) => (
                <option key={option} value={option}>
                  {computerName(option)}
                  {granted.includes(option) ? "" : " — no access"}
                </option>
              ))}
            </select>
            <p className="computer-warning">
              {granted.length > 1
                ? "This routine runs on the selected computer. The agent keeps both computers; the other one is untouched."
                : `This agent only has ${computerName(granted[0] ?? "firecracker")}.`}
            </p>
          </label>

          <div className="field">
            <span>Schedule</span>
            <div className="routine-schedule-row">
              <select
                value={kind}
                aria-label="Routine schedule kind"
                onChange={(event) =>
                  setKind(event.target.value as "interval" | "daily")
                }
              >
                <option value="interval">Every…</option>
                <option value="daily">Daily at…</option>
              </select>
              {kind === "interval" ? (
                <div className="routine-interval-row">
                  <input
                    type="number"
                    min={1}
                    value={intervalValue}
                    aria-label="Routine interval"
                    onChange={(event) => setIntervalValue(event.target.value)}
                  />
                  <select
                    value={intervalUnit}
                    aria-label="Routine interval unit"
                    onChange={(event) =>
                      setIntervalUnit(
                        event.target.value as "minutes" | "hours",
                      )
                    }
                  >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                  </select>
                </div>
              ) : (
                <input
                  type="time"
                  value={dailyTime}
                  aria-label="Routine time of day"
                  onChange={(event) => setDailyTime(event.target.value)}
                />
              )}
            </div>
            <p className="computer-warning">
              {validInterval ? scheduleLabel(preview) : intervalHint}
            </p>
          </div>

          <div className="field routine-enabled-row">
            <span>Enabled</span>
            <button
              role="switch"
              aria-checked={enabled}
              aria-label="Routine enabled"
              className={`switch ${enabled ? "switch-on" : ""}`}
              onClick={() => setEnabled((value) => !value)}
            >
              <span className="switch-knob" />
            </button>
          </div>

          {error && <p className="routine-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="save-button"
            disabled={!canSave}
            onClick={() => void submit()}
          >
            {routine ? "Save" : "Create routine"}
          </button>
        </footer>
      </div>
    </div>
  );
}
