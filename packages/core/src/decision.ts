import {
  createDecisionClient,
  type DecisionClient,
} from "@openbot/gateway";
import type { DecisionGuardrailMode, DecisionInfo } from "@openbot/protocol";

export const DECISION_SETTING_KEY = "decision";

export interface DecisionSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  apiKeyEnv: string | null;
  audit: boolean;
  browse: boolean;
  route: boolean;
  guardrail: DecisionGuardrailMode;
  timeoutMs: number;
}

export interface DecisionRuntime {
  settings: DecisionSettings;
  client: DecisionClient | null;
}

export interface DecisionNotice {
  kind: "audit" | "browse" | "route" | "guardrail";
  summary: string;
  flagged: boolean;
  latencyMs: number | null;
  model: string | null;
  route?: "chat" | "direct" | "project" | "new_project";
}

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  enabled: false,
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  apiKey: null,
  apiKeyEnv: "TYPESAFE_API_KEY",
  audit: true,
  browse: true,
  route: true,
  guardrail: "annotate",
  timeoutMs: 3_000,
};

function isGuardrailMode(value: unknown): value is DecisionGuardrailMode {
  return value === "off" || value === "annotate" || value === "block";
}

export function normalizeDecisionSettings(
  input: Partial<DecisionSettings> | null | undefined,
  base: DecisionSettings = DEFAULT_DECISION_SETTINGS,
): DecisionSettings {
  const source = input ?? {};
  return {
    enabled:
      typeof source.enabled === "boolean" ? source.enabled : base.enabled,
    baseUrl:
      typeof source.baseUrl === "string" && source.baseUrl.trim()
        ? source.baseUrl.trim()
        : base.baseUrl,
    model:
      typeof source.model === "string" && source.model.trim()
        ? source.model.trim()
        : base.model,
    apiKey:
      source.apiKey === null
        ? null
        : typeof source.apiKey === "string" && source.apiKey
          ? source.apiKey
          : base.apiKey,
    apiKeyEnv:
      source.apiKeyEnv === null
        ? null
        : typeof source.apiKeyEnv === "string"
          ? source.apiKeyEnv
          : base.apiKeyEnv,
    audit: typeof source.audit === "boolean" ? source.audit : base.audit,
    browse: typeof source.browse === "boolean" ? source.browse : base.browse,
    route: typeof source.route === "boolean" ? source.route : base.route,
    guardrail: isGuardrailMode(source.guardrail)
      ? source.guardrail
      : base.guardrail,
    timeoutMs:
      typeof source.timeoutMs === "number" &&
      source.timeoutMs >= 500 &&
      source.timeoutMs <= 30_000
        ? source.timeoutMs
        : base.timeoutMs,
  };
}

export function decisionSettingsFromEnv(
  env: Record<string, string | undefined>,
): DecisionSettings {
  const settings = { ...DEFAULT_DECISION_SETTINGS };
  const baseUrl = env.TYPESAFE_BASE_URL?.trim();
  if (baseUrl) {
    settings.baseUrl = baseUrl;
  }
  const model = env.TYPESAFE_DEFAULT_MODEL?.trim();
  if (model) {
    settings.model = model;
  }
  if (env.TYPESAFE_API_KEY) {
    settings.enabled = true;
  }
  if (env.OPENBOT_DECISION_ENABLED !== undefined) {
    settings.enabled = env.OPENBOT_DECISION_ENABLED !== "false";
  }
  return settings;
}

export function parseDecisionSettings(raw: string | null): DecisionSettings {
  if (raw === null) {
    return DEFAULT_DECISION_SETTINGS;
  }
  try {
    return normalizeDecisionSettings(
      JSON.parse(raw) as Partial<DecisionSettings>,
    );
  } catch {
    return DEFAULT_DECISION_SETTINGS;
  }
}

export function resolveDecisionKey(
  settings: DecisionSettings,
  env: Record<string, string | undefined>,
): string | undefined {
  if (settings.apiKey) {
    return settings.apiKey;
  }
  if (settings.apiKeyEnv) {
    return env[settings.apiKeyEnv];
  }
  return undefined;
}

export function decisionInfo(
  settings: DecisionSettings,
  env: Record<string, string | undefined>,
): DecisionInfo {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: Boolean(resolveDecisionKey(settings, env)),
    apiKeyEnv: settings.apiKeyEnv,
    audit: settings.audit,
    browse: settings.browse,
    route: settings.route,
    guardrail: settings.guardrail,
    timeoutMs: settings.timeoutMs,
  };
}

export function decisionRuntime(
  settings: DecisionSettings,
  env: Record<string, string | undefined>,
): DecisionRuntime {
  if (!settings.enabled) {
    return { settings, client: null };
  }
  const apiKey = resolveDecisionKey(settings, env);
  if (!apiKey) {
    return { settings, client: null };
  }
  return {
    settings,
    client: createDecisionClient({
      apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
    }),
  };
}
