import type { ReasoningEffort } from "@openbot/protocol";
import type { SandboxState } from "./useDaemon";

export const AVATAR_COLORS = [
  "#1f8a65",
  "#d97706",
  "#7c3aed",
  "#2563eb",
  "#dc2626",
  "#0891b2",
];

// Reasoning effort is sent as `reasoning_effort`. DeepSeek supports
// none/low/high/max (minimal maps to low, medium to high); OpenAI supports
// minimal/low/medium/high. Unset keeps the provider's own default.
export const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const EFFORT_LABELS = new Map<ReasoningEffort, string>(
  EFFORT_OPTIONS.map((option) => [option.value, option.label]),
);

export function effortLabel(
  effort: ReasoningEffort | null | undefined,
): string {
  return effort ? (EFFORT_LABELS.get(effort) ?? effort) : "Default";
}

export const COMPUTER_LABEL: Record<SandboxState, string> = {
  stopped: "Computer off",
  booting: "Booting computer…",
  running: "Computer running",
  error: "Computer error",
};

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 9973;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "#1f8a65";
}

export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "A";
}
