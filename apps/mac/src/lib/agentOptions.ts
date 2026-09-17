import type { SandboxState } from "./useDaemon";

export const AVATAR_COLORS = [
  "#1f8a65",
  "#d97706",
  "#7c3aed",
  "#2563eb",
  "#dc2626",
  "#0891b2",
];

export const EMOJI_CHOICES = [
  "🤖",
  "🧠",
  "📈",
  "🎨",
  "🛠️",
  "🔬",
  "✍️",
  "🚀",
  "📣",
  "🧭",
  "⚙️",
  "🦾",
];

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
