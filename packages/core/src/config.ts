import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_PRESETS, type ProviderDefinition } from "@openbot/gateway";
import type { CompactionSettings, HarnessSettings } from "@openbot/protocol";
import { clampCompactionThreshold } from "./compaction";
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
  };
}
