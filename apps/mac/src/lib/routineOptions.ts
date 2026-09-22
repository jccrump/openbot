import type { RoutineSchedule } from "@openbot/protocol";

export function scheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.kind === "interval") {
    const minutes = schedule.minutes;
    if (minutes % (24 * 60) === 0) {
      const days = minutes / (24 * 60);
      return days === 1 ? "Every day" : `Every ${days} days`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours === 1 ? "Every hour" : `Every ${hours} hours`;
    }
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(
    schedule.minute,
  ).padStart(2, "0")}`;
  return `Daily at ${time}`;
}

/** "in 5 min", "now", "3 min ago" — for next/last run times. */
export function relativeLabel(
  iso: string | null,
  now = Date.now(),
): string | null {
  if (!iso) {
    return null;
  }
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return null;
  }
  const deltaMs = at - now;
  const past = deltaMs < 0;
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);
  const value =
    minutes < 1
      ? "less than a minute"
      : minutes < 60
        ? `${minutes} min`
        : minutes < 24 * 60
          ? `${Math.round(minutes / 60)} h`
          : `${Math.round(minutes / (24 * 60))} d`;
  if (minutes < 1 && !past) {
    return "any moment";
  }
  return past ? `${value} ago` : `in ${value}`;
}
