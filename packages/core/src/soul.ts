import type { SoulContent, SoulVersion } from "@openbot/protocol";
import type { Store } from "./store";

export const DEFAULT_SOUL: SoulContent = {
  voice: "Concise, direct, and practical; no filler.",
  commitments: [
    "Ground every claim in evidence and label unknowns.",
  ],
  relationship:
    "A long-running working partnership, built one request at a time.",
};

const MAX_VOICE = 400;
const MAX_RELATIONSHIP = 400;
const MAX_COMMITMENT = 200;
const MAX_COMMITMENTS = 8;

function clampText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : fallback;
}

export function normalizeSoul(
  value: Partial<SoulContent>,
  fallback: SoulContent = DEFAULT_SOUL,
): SoulContent {
  const commitments = Array.isArray(value.commitments)
    ? value.commitments
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().replace(/\s+/g, " "))
        .filter(Boolean)
        .slice(0, MAX_COMMITMENTS)
        .map((entry) => entry.slice(0, MAX_COMMITMENT))
    : fallback.commitments;
  return {
    voice: clampText(value.voice, MAX_VOICE, fallback.voice),
    commitments: commitments.length > 0 ? commitments : fallback.commitments,
    relationship: clampText(
      value.relationship,
      MAX_RELATIONSHIP,
      fallback.relationship,
    ),
  };
}

export function renderSoul(content: SoulContent): string {
  const commitments = content.commitments.length
    ? content.commitments.map((entry) => `- ${entry}`).join("\n")
    : "- (none)";
  return [
    `Voice: ${content.voice}`,
    "Commitments:",
    commitments,
    `Relationship: ${content.relationship}`,
  ].join("\n");
}

export class SoulService {
  constructor(private readonly store: Store) {}

  current(botId: string): SoulVersion {
    const existing = this.store.currentSoulVersion(botId);
    if (existing) {
      return existing;
    }
    return this.store.addSoulVersion({
      botId,
      content: DEFAULT_SOUL,
      summary: renderSoul(DEFAULT_SOUL),
      reason: "initial soul",
      source: "seed",
    });
  }

  apply(
    botId: string,
    content: SoulContent,
    reason: string,
    source: string,
  ): SoulVersion {
    const normalized = normalizeSoul(content);
    return this.store.addSoulVersion({
      botId,
      content: normalized,
      summary: renderSoul(normalized),
      reason: reason.slice(0, 300),
      source,
    });
  }

  revert(botId: string, versionId: string): SoulVersion | null {
    const version = this.store.getSoulVersion(versionId);
    if (!version || version.botId !== botId) {
      return null;
    }
    return this.apply(
      botId,
      version.content,
      `reverted to version ${version.version}`,
      "user",
    );
  }

  list(botId: string): SoulVersion[] {
    return this.store.listSoulVersions(botId);
  }
}
