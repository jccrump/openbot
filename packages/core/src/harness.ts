import type { HarnessId, HarnessSettings } from "@openbot/protocol";

export const HARNESS_SETTING_KEY = "harness";
export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = { default: "openbot" };

export function parseHarnessId(value: unknown): HarnessId {
  return value === "codex" ? "codex" : "openbot";
}

export function parseHarnessSettings(raw: string | null): HarnessSettings {
  if (raw === null) {
    return DEFAULT_HARNESS_SETTINGS;
  }
  try {
    const parsed = JSON.parse(raw) as { default?: unknown };
    return { default: parseHarnessId(parsed.default) };
  } catch {
    return DEFAULT_HARNESS_SETTINGS;
  }
}
