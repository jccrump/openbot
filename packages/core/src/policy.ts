import type {
  ApprovalTier,
  ComputerKind,
  PolicyPresetId,
  PolicyRule,
  PolicySettings,
  RolePolicy,
} from "@openbot/protocol";

export const POLICY_SETTING_KEY = "policy";

const TIER_STRICTNESS: Record<ApprovalTier, number> = {
  auto: 0,
  ask: 1,
  deny: 2,
};

function strictestTier(
  a: ApprovalTier | undefined,
  b: ApprovalTier | undefined,
): ApprovalTier | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return TIER_STRICTNESS[a] >= TIER_STRICTNESS[b] ? a : b;
}

export const DEFAULT_POLICY: PolicySettings = {
  timeoutMs: 10 * 60_000,
  defaultTier: "inherit",
  tools: {},
  rules: [
    {
      id: "deny-root-delete",
      tool: "shell",
      scope: "*",
      match: "command",
      pattern: "\\brm\\s+-[a-z]*[rf][a-z]*\\s+(/|~|\\$HOME)(\\s|$)",
      tier: "deny",
      note: "refuses recursive deletes of / or home",
    },
    {
      id: "deny-raw-disk-write",
      tool: "shell",
      scope: "*",
      match: "command",
      pattern: "\\b(mkfs(\\.\\w+)?|dd\\b[^|]*of=/dev/)",
      tier: "deny",
      note: "refuses raw disk writes",
    },
    {
      id: "ask-sudo",
      tool: "shell",
      scope: "*",
      match: "command",
      pattern: "^\\s*sudo\\b",
      tier: "ask",
      note: "privilege escalation",
    },
    {
      id: "ask-pipe-to-shell",
      tool: "shell",
      scope: "*",
      match: "command",
      pattern: "(curl|wget)[^|]*\\|\\s*(ba|z|da)?sh\\b",
      tier: "ask",
      note: "piping a download into a shell",
    },
  ],
};

const DENY_RULES = DEFAULT_POLICY.rules.filter((rule) => rule.tier === "deny");

/**
 * Named starting points. Presets always keep the built-in deny rules so a
 * preset can never remove a safety floor.
 */
export function policyPreset(id: PolicyPresetId): PolicySettings {
  switch (id) {
    case "read-only":
      return {
        timeoutMs: 10 * 60_000,
        defaultTier: "inherit",
        tools: {
          read_file: "auto",
          grep: "auto",
          glob: "auto",
          web_search: "auto",
          browser: "ask",
          browser_execute: "ask",
          browser_step: "ask",
          browse: "ask",
          shell: "deny",
          write_file: "deny",
          edit: "deny",
          desktop: "deny",
        },
        rules: DEFAULT_POLICY.rules,
      };
    case "trusted":
      return {
        timeoutMs: 2 * 60_000,
        defaultTier: "auto",
        tools: {},
        rules: DENY_RULES,
      };
    case "locked":
      return {
        timeoutMs: 5 * 60_000,
        defaultTier: "inherit",
        tools: {
          read_file: "auto",
          grep: "auto",
          glob: "auto",
          web_search: "deny",
          browser: "deny",
          browser_execute: "deny",
          browser_step: "deny",
          browse: "deny",
          shell: "deny",
          write_file: "deny",
          edit: "deny",
          desktop: "deny",
        },
        rules: DEFAULT_POLICY.rules,
      };
    case "balanced":
    default:
      return DEFAULT_POLICY;
  }
}

/**
 * Narrow a base policy with an overlay. Overlays can only make things
 * stricter: tool tiers take the stricter of the two, defaults take the
 * stricter, timeouts take the shorter, rules accumulate, and egress modes
 * take the stricter with the intersection of their allow lists.
 */
export function mergePolicies(
  base: PolicySettings,
  overlay: PolicySettings,
): PolicySettings {
  const tools: Record<string, ApprovalTier> = { ...base.tools };
  for (const [tool, tier] of Object.entries(overlay.tools)) {
    const merged = strictestTier(tools[tool], tier);
    if (merged) {
      tools[tool] = merged;
    }
  }
  const defaultTier =
    base.defaultTier === "inherit"
      ? overlay.defaultTier
      : overlay.defaultTier === "inherit"
        ? base.defaultTier
        : TIER_STRICTNESS[base.defaultTier] >= TIER_STRICTNESS[overlay.defaultTier]
          ? base.defaultTier
          : overlay.defaultTier;
  const baseEgress = base.egress ?? { mode: "off", allow: [] };
  const overlayEgress = overlay.egress ?? { mode: "off", allow: [] };
  const egressMode =
    TIER_STRICTNESS[baseEgress.mode === "off" ? "auto" : baseEgress.mode] >=
    TIER_STRICTNESS[overlayEgress.mode === "off" ? "auto" : overlayEgress.mode]
      ? baseEgress.mode
      : overlayEgress.mode;
  const egress =
    egressMode === "off"
      ? undefined
      : {
          mode: egressMode,
          allow:
            baseEgress.mode !== "off" && overlayEgress.mode !== "off"
              ? baseEgress.allow.filter((entry) =>
                  overlayEgress.allow.includes(entry),
                )
              : baseEgress.mode !== "off"
                ? baseEgress.allow
                : overlayEgress.allow,
        };
  return {
    timeoutMs: Math.min(base.timeoutMs, overlay.timeoutMs),
    defaultTier,
    tools,
    rules: [...base.rules, ...overlay.rules],
    ...(egress ? { egress } : {}),
  };
}

export function rolePolicySettings(policy: RolePolicy): PolicySettings | null {
  return policy === "inherit" ? null : policyPreset(policy);
}

function sanitizeRule(value: unknown): PolicyRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const tier = record.tier;
  const match = record.match;
  const tool = typeof record.tool === "string" ? record.tool : "*";
  const pattern = typeof record.pattern === "string" ? record.pattern : "";
  if (
    (tier !== "auto" && tier !== "ask" && tier !== "deny") ||
    (match !== "command" &&
      match !== "path" &&
      match !== "domain" &&
      match !== "text") ||
    !pattern
  ) {
    return null;
  }
  return {
    id:
      typeof record.id === "string" && record.id
        ? record.id
        : `rule-${Math.random().toString(36).slice(2, 8)}`,
    tool,
    scope:
      record.scope === "firecracker" || record.scope === "mac"
        ? record.scope
        : "*",
    match,
    pattern,
    tier,
    note: typeof record.note === "string" ? record.note : null,
  };
}

export function parsePolicy(raw: string | null): PolicySettings {
  if (!raw) {
    return DEFAULT_POLICY;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tools: Record<string, ApprovalTier> = {};
    if (parsed.tools && typeof parsed.tools === "object") {
      for (const [name, tier] of Object.entries(
        parsed.tools as Record<string, unknown>,
      )) {
        if (tier === "auto" || tier === "ask" || tier === "deny") {
          tools[name] = tier;
        }
      }
    }
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules
          .map(sanitizeRule)
          .filter((rule): rule is PolicyRule => Boolean(rule))
      : DEFAULT_POLICY.rules;
    let egress: PolicySettings["egress"];
    if (parsed.egress && typeof parsed.egress === "object") {
      const raw = parsed.egress as Record<string, unknown>;
      const mode =
        raw.mode === "ask" || raw.mode === "deny" ? raw.mode : "off";
      const allow = Array.isArray(raw.allow)
        ? raw.allow
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 200)
        : [];
      if (mode !== "off") {
        egress = { mode, allow };
      }
    }
    return {
      timeoutMs:
        typeof parsed.timeoutMs === "number" && parsed.timeoutMs >= 0
          ? Math.min(parsed.timeoutMs, 86_400_000)
          : DEFAULT_POLICY.timeoutMs,
      defaultTier:
        parsed.defaultTier === "auto" ||
        parsed.defaultTier === "ask" ||
        parsed.defaultTier === "deny"
          ? parsed.defaultTier
          : "inherit",
      tools,
      rules,
      ...(egress ? { egress } : {}),
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

export function serializePolicy(policy: PolicySettings): string {
  return JSON.stringify(policy);
}

export interface PolicyDecision {
  tier: ApprovalTier;
  reason: string;
  ruleId: string | null;
}

function matchValue(
  rule: PolicyRule,
  args: Record<string, unknown>,
): string | null {
  switch (rule.match) {
    case "command":
      return typeof args.command === "string" ? args.command : null;
    case "path":
      return typeof args.path === "string" ? args.path : null;
    case "domain": {
      const url = args.url ?? args.href;
      if (typeof url !== "string") {
        return null;
      }
      try {
        return new URL(url).hostname.toLowerCase();
      } catch {
        return url.toLowerCase();
      }
    }
    case "text": {
      const value = args.text ?? args.keys ?? args.selector ?? args.title;
      return typeof value === "string" ? value : null;
    }
    default:
      return null;
  }
}

function domainOf(args: Record<string, unknown>): string | null {
  const url = args.url ?? args.href;
  if (typeof url !== "string") {
    return null;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function strictestDecision(
  a: PolicyDecision | null,
  b: PolicyDecision | null,
): PolicyDecision | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return TIER_STRICTNESS[a.tier] >= TIER_STRICTNESS[b.tier] ? a : b;
}

export function evaluatePolicy(input: {
  policy: PolicySettings;
  requireApproval: boolean;
  tool: string;
  args: Record<string, unknown>;
  computer: ComputerKind;
  granted: boolean;
  local: boolean;
}): PolicyDecision {
  let ruleDecision: PolicyDecision | null = null;
  for (const rule of input.policy.rules) {
    if (rule.tool !== "*" && rule.tool !== input.tool) {
      continue;
    }
    if (rule.scope !== "*" && rule.scope !== input.computer) {
      continue;
    }
    const value = matchValue(rule, input.args);
    if (value === null) {
      continue;
    }
    let matches = false;
    try {
      matches = new RegExp(rule.pattern, "i").test(value);
    } catch {
      continue;
    }
    if (!matches) {
      continue;
    }
    ruleDecision = strictestDecision(ruleDecision, {
      tier: rule.tier,
      reason: rule.note?.trim() || `matched policy rule ${rule.id}`,
      ruleId: rule.id,
    });
  }

  let egressDecision: PolicyDecision | null = null;
  const egress = input.policy.egress;
  if (
    egress &&
    egress.mode !== "off" &&
    (input.tool === "browser" || input.tool === "browse")
  ) {
    const host = domainOf(input.args);
    if (host) {
      const allowed = egress.allow.some(
        (entry) => host === entry || host.endsWith(`.${entry}`),
      );
      if (!allowed) {
        egressDecision = {
          tier: egress.mode,
          reason: `${host} is not in the egress allowlist`,
          ruleId: null,
        };
      }
    }
  }

  const strictest = strictestDecision(ruleDecision, egressDecision);
  if (strictest) {
    return strictest;
  }

  const explicit = input.policy.defaultTier;
  const toolTier = input.policy.tools[input.tool];
  const tier: ApprovalTier =
    toolTier ??
    (explicit === "inherit"
      ? input.requireApproval
        ? "ask"
        : "auto"
      : explicit);
  const reason = toolTier
    ? `${input.tool} is set to ${toolTier} in the approvals policy`
    : explicit === "inherit"
      ? input.requireApproval
        ? "approvals are on by default"
        : "approvals are off by default"
      : `the default tier is ${explicit}`;

  // Local-Mac runs always ask unless a mac-scoped rule says otherwise
  // (ADR-010); tool tiers and the default never auto-allow local tools.
  if (input.local) {
    return {
      tier: tier === "deny" ? "deny" : "ask",
      reason:
        tier === "deny"
          ? reason
          : "local Mac tools always ask unless a mac-scoped rule allows them",
      ruleId: null,
    };
  }

  // A task grant is the user's approval of the brief: it pre-approves ask-tier
  // tools, but it can never widen a deny.
  if (tier === "ask" && input.granted) {
    return {
      tier: "auto",
      reason: "covered by the task grant",
      ruleId: null,
    };
  }
  return { tier, reason, ruleId: null };
}

export function normalizePolicy(value: unknown): PolicySettings {
  const base =
    value && typeof value === "object"
      ? JSON.stringify(value)
      : JSON.stringify(DEFAULT_POLICY);
  return parsePolicy(base);
}
