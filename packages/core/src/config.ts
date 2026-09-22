import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_PRESETS, type ProviderDefinition } from "@openbot/gateway";
import type {
  ChatBusyBehavior,
  CompactionSettings,
  HarnessSettings,
} from "@openbot/protocol";
import { clampCompactionThreshold } from "./compaction";
import {
  decisionSettingsFromEnv,
  normalizeDecisionSettings,
  type DecisionSettings,
} from "./decision";
import { parseHarnessId } from "./harness";

export interface OpenBotConfig {
  port: number;
  dataDir: string;
  providers: ProviderDefinition[];
  defaultModel: { provider: string; model: string };
  sandboxUrl: string;
  requireApproval: boolean;
  compaction: CompactionSettings;
  harness: HarnessSettings;
  decision: DecisionSettings;
  chatBusyBehavior: ChatBusyBehavior;
  /** How often the routine scheduler checks for due routines. */
  routineTickMs?: number;
  /** Folders scanned for local projects on first run; user-editable later. */
  workspaceRoots: string[];
}

interface FileConfig {
  port?: number;
  providers?: ProviderDefinition[];
  defaultModel?: { provider: string; model: string };
  sandboxUrl?: string;
  requireApproval?: boolean;
  compaction?: {
    enabled?: boolean;
    thresholdTokens?: number | null;
  };
  harness?: {
    default?: string;
  };
  decision?: Partial<DecisionSettings>;
  chatBusyBehavior?: string;
  workspaceRoots?: string[];
}

export function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "OpenBot");
  }
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "OpenBot",
    );
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "openbot",
  );
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): OpenBotConfig {
  const dataDir = env.OPENBOT_DATA_DIR?.trim() || defaultDataDir();
  const configPath = join(dataDir, "config.json");

  let file: FileConfig = {};
  try {
    file = JSON.parse(readFileSync(configPath, "utf8")) as FileConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `failed to read ${configPath}: ${(error as Error).message}`,
      );
    }
  }

  const routineTickMs = parseRoutineTickMs(env);
  return {
    port: Number(env.OPENBOT_PORT ?? file.port ?? 4170),
    dataDir,
    providers: file.providers ?? [
      PROVIDER_PRESETS.deepseek,
      PROVIDER_PRESETS.openrouter,
      PROVIDER_PRESETS.ollama,
    ],
    defaultModel: file.defaultModel ?? {
      provider: "deepseek",
      model: "deepseek-v4-flash",
    },
    sandboxUrl:
      env.OPENBOT_SANDBOX_URL ??
      file.sandboxUrl ??
      "http://127.0.0.1:4171",
    requireApproval:
      env.OPENBOT_REQUIRE_APPROVAL !== undefined
        ? env.OPENBOT_REQUIRE_APPROVAL !== "false"
        : (file.requireApproval ?? true),
    compaction: {
      enabled: file.compaction?.enabled ?? true,
      thresholdTokens:
        typeof file.compaction?.thresholdTokens === "number"
          ? clampCompactionThreshold(file.compaction.thresholdTokens)
          : null,
    },
    harness: {
      default: parseHarnessId(env.OPENBOT_HARNESS ?? file.harness?.default),
    },
    decision: normalizeDecisionSettings(
      file.decision,
      decisionSettingsFromEnv(env),
    ),
    chatBusyBehavior: parseChatBusyBehavior(
      env.OPENBOT_CHAT_BUSY_BEHAVIOR ?? file.chatBusyBehavior,
    ),
    ...(routineTickMs !== null ? { routineTickMs } : {}),
    workspaceRoots: parseWorkspaceRoots(env, file),
  };
}

/** Test knob: how often the routine scheduler looks for due routines. */
function parseRoutineTickMs(
  env: Record<string, string | undefined>,
): number | null {
  const raw = Number(env.OPENBOT_ROUTINE_TICK_MS);
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : null;
}

function parseWorkspaceRoots(
  env: Record<string, string | undefined>,
  file: FileConfig,
): string[] {
  const fromEnv = env.OPENBOT_WORKSPACE_ROOTS?.trim();
  if (fromEnv) {
    return fromEnv
      .split(/[:,]/)
      .map((root) => root.trim())
      .filter(Boolean);
  }
  if (file.workspaceRoots && file.workspaceRoots.length > 0) {
    return file.workspaceRoots;
  }
  return defaultWorkspaceRoots();
}

/**
 * Conventional developer folders that exist on this machine, used to seed the
 * registry's scan roots. Everything stays user-editable in Settings.
 */
export function defaultWorkspaceRoots(): string[] {
  const home = homedir();
  const candidates = [
    join(home, "Documents", "Personal-Projects"),
    join(home, "Documents", "Projects"),
    join(home, "Projects"),
    join(home, "Developer"),
    join(home, "code"),
    join(home, "src"),
  ];
  return candidates.filter((dir) => existsSync(dir));
}

export function parseChatBusyBehavior(
  value: string | undefined,
): ChatBusyBehavior {
  return value === "queue" ? "queue" : "steer";
}
