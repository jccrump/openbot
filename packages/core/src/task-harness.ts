import {
  choice,
  noul,
  type DecisionClient,
  type EntryType,
} from "@openbot/gateway";
import type { ToolCallRecord } from "@openbot/protocol";

export type EvidenceKind =
  | "direct-page"
  | "search-results"
  | "blocked-or-missing"
  | "failed";

export interface EvidenceObservation {
  id: string;
  tool: string;
  ok: boolean;
  kind: EvidenceKind;
  url: string | null;
  arguments: string;
  output: string;
}

export interface CompletionAudit {
  verdict: "pass" | "continue";
  issues: string[];
  instructions: string;
}

export const COMPLETION_AUDIT_MARKER = "[OpenBot completion audit]";
export const VERIFICATION_FEEDBACK_MARKER =
  "[OpenBot verification feedback - continue the original task]";

export const COMPLETION_VERIFIER_SYSTEM_PROMPT =
  "You are OpenBot's completion verifier. Audit a proposed answer against the " +
  "original request and the numbered tool observations. Be strict about factual " +
  "support but practical about honest limitations. A claim is verified only when " +
  "an observation supports that exact entity, product, place, price, availability, " +
  "or other stated constraint; never combine nearby facts from different subjects. " +
  "Search-result pages support discovery, not strong availability or product claims. " +
  "Failed, blocked, missing, or 404 pages support nothing. Pass when every requested " +
  "deliverable is answered with supported facts, or when unavailable facts are " +
  "clearly labeled unverified without overstating the conclusion. Reply with compact " +
  'JSON only and no prose: {"verdict":"pass"|"continue","issues":["<code>"]}. ' +
  "Valid issue codes: deliverables_covered, claims_bound, no_search_upgrade, " +
  "unknowns_labeled, overstated. Include only the codes that apply.";

const SEARCH_HOSTS = new Set([
  "bing.com",
  "www.bing.com",
  "google.com",
  "www.google.com",
  "duckduckgo.com",
  "www.duckduckgo.com",
  "search.brave.com",
  "search.yahoo.com",
  "www.search.yahoo.com",
]);

const BLOCKED_PATTERNS = [
  /^title:.*\b404\b/im,
  /\b(?:http|error)\s*404\b/i,
  /page not found/i,
  /access denied/i,
  /request blocked/i,
  /captcha/i,
  /verify you are human/i,
];

const MAX_OBSERVATION_CHARS = 2_500;
const MAX_LEDGER_CHARS = 64_000;

function observationId(index: number, prefix = "browser"): string {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

const EVIDENCE_MARKER = /\[evidence ((?:browser|browse|websearch)-\d+); source=([a-z-]+)\]/;

export const WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * Tools whose results enter the completion audit's evidence ledger. Browser
 * observations are page reads; web_search observations are aggregated search
 * results, so the verifier treats them as discovery rather than confirmation.
 */
export const EVIDENCE_TOOL_NAMES = new Set([
  "browser",
  "browser_execute",
  "browser_step",
  "browse",
  WEB_SEARCH_TOOL_NAME,
]);

function extractUrl(output: string): string | null {
  const match = /^url:\s*(\S+)/im.exec(output);
  return match?.[1] ?? null;
}

function fallbackKind(record: ToolCallRecord, url: string | null): EvidenceKind {
  if (record.name === WEB_SEARCH_TOOL_NAME) {
    return record.ok ? "search-results" : "failed";
  }
  return classify(record, url);
}

function classify(record: ToolCallRecord, url: string | null): EvidenceKind {
  if (!record.ok) {
    return "failed";
  }
  if (url) {
    try {
      if (SEARCH_HOSTS.has(new URL(url).hostname.toLowerCase())) {
        return "search-results";
      }
    } catch {
      // A malformed URL stays a direct observation; the verifier still sees it.
    }
  }
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(record.output))) {
    return "blocked-or-missing";
  }
  return "direct-page";
}

export function annotateBrowserObservation(
  output: string,
  ok: boolean,
  index: number,
  prefix = "browser",
): string {
  const record = {
    id: "",
    name: "browser",
    arguments: "",
    output,
    ok,
    durationMs: 0,
    artifacts: null,
  } satisfies ToolCallRecord;
  const kind = classify(record, extractUrl(output));
  return (
    `[evidence ${observationId(index, prefix)}; source=${kind}]\n` + output
  );
}

/**
 * A web search returns several pages at once, so it is one aggregated
 * observation classified as search results: useful for discovery and for
 * finding the URL to open, not as direct confirmation of a fact.
 */
export function annotateWebSearchObservation(
  output: string,
  ok: boolean,
  index: number,
): string {
  const kind: EvidenceKind = ok ? "search-results" : "failed";
  return (
    `[evidence ${observationId(index, "websearch")}; source=${kind}]\n` + output
  );
}

export function buildEvidenceLedger(
  records: ToolCallRecord[],
): EvidenceObservation[] {
  let browserIndex = 0;
  const observations: EvidenceObservation[] = [];
  for (const record of records) {
    if (!EVIDENCE_TOOL_NAMES.has(record.name)) {
      continue;
    }
    if (record.name === "browse") {
      for (const chunk of record.output.split("\n\n---\n\n")) {
        const marker = EVIDENCE_MARKER.exec(chunk);
        observations.push({
          id: marker?.[1] ?? observationId(browserIndex, "browse"),
          tool: record.name,
          ok: record.ok,
          kind: (marker?.[2] as EvidenceKind | undefined) ?? "direct-page",
          url: extractUrl(chunk),
          arguments: record.arguments,
          output: chunk,
        });
        browserIndex += 1;
      }
      continue;
    }
    const marker = EVIDENCE_MARKER.exec(record.output);
    const url = extractUrl(record.output);
    const id =
      marker?.[1] ??
      observationId(
        browserIndex,
        record.name === WEB_SEARCH_TOOL_NAME ? "websearch" : "browser",
      );
    browserIndex += 1;
    observations.push({
      id,
      tool: record.name,
      ok: record.ok,
      kind: (marker?.[2] as EvidenceKind | undefined) ?? fallbackKind(record, url),
      url,
      arguments: record.arguments,
      output: record.output,
    });
  }
  return observations;
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const tail = Math.floor(maximum * 0.3);
  return (
    `${value.slice(0, maximum - tail)}\n[observation middle truncated]\n` +
    value.slice(value.length - tail)
  );
}

export function renderEvidenceLedger(records: ToolCallRecord[]): string {
  const rendered: string[] = [];
  let length = 0;
  for (const observation of buildEvidenceLedger(records)) {
    const entry =
      `Observation ${observation.id}\n` +
      `Status: ${observation.ok ? "success" : "failed"}\n` +
      `Source type: ${observation.kind}\n` +
      `URL: ${observation.url ?? "unknown"}\n` +
      `Tool arguments: ${observation.arguments}\n` +
      `Result:\n${truncate(observation.output, MAX_OBSERVATION_CHARS)}`;
    if (length + entry.length > MAX_LEDGER_CHARS) {
      rendered.push("[remaining observations omitted from verifier packet]");
      break;
    }
    rendered.push(entry);
    length += entry.length;
  }
  return rendered.join("\n\n---\n\n");
}

export function buildCompletionAuditRequest(
  userRequest: string,
  candidate: string,
  records: ToolCallRecord[],
): string {
  return (
    `${COMPLETION_AUDIT_MARKER}\n\n` +
    `Original request:\n${userRequest}\n\n` +
    "Task contract:\n" +
    "- Address every explicit constraint and requested deliverable.\n" +
    "- Keep claims bound to the exact subject shown by their evidence.\n" +
    "- Distinguish verified facts, reasonable inference, and unknowns.\n" +
    "- If direct verification is unavailable, say that instead of upgrading a lead into a fact.\n\n" +
    `Numbered evidence ledger:\n${renderEvidenceLedger(records)}\n\n` +
    `Proposed answer:\n${candidate}`
  );
}

function jsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  return start >= 0 && end > start ? source.slice(start, end + 1) : null;
}

export function parseCompletionAudit(text: string): CompletionAudit | null {
  const source = jsonObject(text);
  if (!source) {
    return null;
  }
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    if (parsed.verdict !== "pass" && parsed.verdict !== "continue") {
      return null;
    }
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues
          .filter((item): item is string => typeof item === "string")
          .map((item) => JEV_ISSUE_TEXT[item] ?? item)
      : [];
    const instructions =
      typeof parsed.instructions === "string" ? parsed.instructions : "";
    return { verdict: parsed.verdict, issues, instructions };
  } catch {
    return null;
  }
}

export function buildVerificationFeedback(audit: CompletionAudit): string {
  const issues = audit.issues.length
    ? audit.issues.map((issue) => `- ${issue}`).join("\n")
    : "- The proposed answer did not yet satisfy the task contract.";
  return (
    `${VERIFICATION_FEEDBACK_MARKER}\n` +
    "Your proposed answer was not shown to the user. Continue working on the " +
    "original request. Use more tools if evidence is missing; otherwise revise " +
    "the answer so unknowns remain explicitly unknown. Do not discuss this internal audit.\n\n" +
    `Issues:\n${issues}\n\n` +
    `Next step:\n${audit.instructions || "Resolve the issues, then provide a corrected final answer."}`
  );
}

export function shouldAuditCompletion(records: ToolCallRecord[]): boolean {
  return records.some((record) => EVIDENCE_TOOL_NAMES.has(record.name));
}

export const JEV_AUDIT_QUESTIONS = {
  verdict: choice(
    "Should this proposed answer be shown to the user, or does the agent need to keep working?",
    {
      pass: "Every explicit deliverable is answered with facts the observations support, or unavailable facts are clearly labeled unverified without overstating the conclusion.",
      continue:
        "At least one deliverable is missing, unsupported, or overstated relative to the observations.",
    },
  ),
  deliverables_covered: noul(
    "Does the proposed answer address every explicit constraint and requested deliverable in the original request?",
    {
      true: "Every requested item and constraint is addressed.",
      false: "One or more requested items or constraints are missing.",
    },
  ),
  claims_bound: noul(
    "Is every factual claim bound to an observation about that exact subject — same entity, product, place, price, or availability?",
    {
      true: "Claims match the exact subject of the observation that supports them.",
      false: "At least one claim combines facts from different subjects or drifts from the observed subject.",
    },
  ),
  no_search_upgrade: noul(
    "Does the proposed answer avoid treating search-result pages as strong evidence of availability, price, or product details?",
    {
      true: "Search results are treated as leads only, never as direct evidence.",
      false: "A search-result page is used as if it confirmed a product, price, or availability.",
    },
  ),
  unknowns_labeled: noul(
    "Are facts that the observations do not verify clearly labeled unknown or unverified?",
    {
      true: "Unverified facts are presented as unverified.",
      false: "Unverified facts are presented as known or omitted silently.",
    },
  ),
  overstated: noul(
    "Does the proposed answer state anything as verified that the observations do not support?",
    {
      true: "The answer claims more certainty than the observations support.",
      false: "Every verified-sounding claim is supported by an observation.",
    },
  ),
};

const JEV_PASS_NOUL = 0.85;
const JEV_OVERSTATED_NOUL = 0.15;
const JEV_BORDERLINE_MARGIN = 0.05;

const JEV_POSITIVE_CHECKS = [
  "deliverables_covered",
  "claims_bound",
  "no_search_upgrade",
  "unknowns_labeled",
] as const;

function nearThreshold(score: number, threshold: number): boolean {
  return Math.abs(score - threshold) <= JEV_BORDERLINE_MARGIN;
}

const JEV_ISSUE_TEXT: Record<string, string> = {
  deliverables_covered:
    "the answer does not address every requested deliverable or constraint",
  claims_bound:
    "some claims are not bound to an observation about that exact subject",
  no_search_upgrade:
    "search-result pages are treated as stronger evidence than they are",
  unknowns_labeled: "unverified facts are not clearly labeled unknown",
  overstated: "the answer states more certainty than the observations support",
};

export interface JevAuditOutcome {
  verdict: "pass" | "continue";
  confidence: number;
  failed: string[];
  borderline: string[];
  scores: Record<string, number>;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export function buildJevAuditState(
  userRequest: string,
  candidate: string,
  records: ToolCallRecord[],
): EntryType {
  return {
    request: userRequest,
    proposed_answer: candidate,
    observations: buildEvidenceLedger(records).map((observation) => ({
      id: observation.id,
      status: observation.ok ? "success" : "failed",
      source_type: observation.kind,
      url: observation.url,
      tool_arguments: observation.arguments,
      result: truncate(observation.output, MAX_OBSERVATION_CHARS),
    })),
  };
}

export async function evaluateJevAudit(input: {
  client: DecisionClient;
  userRequest: string;
  candidate: string;
  records: ToolCallRecord[];
  signal?: AbortSignal;
}): Promise<JevAuditOutcome> {
  const result = await input.client.evaluate({
    state: buildJevAuditState(input.userRequest, input.candidate, input.records),
    questions: JEV_AUDIT_QUESTIONS,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const answers = result.answers;
  const scores = {
    deliverables_covered: answers.deliverables_covered.noul,
    claims_bound: answers.claims_bound.noul,
    no_search_upgrade: answers.no_search_upgrade.noul,
    unknowns_labeled: answers.unknowns_labeled.noul,
    overstated: answers.overstated.noul,
  };
  const failed: string[] = [];
  const borderline: string[] = [];
  for (const id of JEV_POSITIVE_CHECKS) {
    const score = scores[id];
    if (score < JEV_PASS_NOUL) {
      failed.push(id);
    }
    if (nearThreshold(score, JEV_PASS_NOUL)) {
      borderline.push(id);
    }
  }
  if (scores.overstated > JEV_OVERSTATED_NOUL) {
    failed.push("overstated");
  }
  if (nearThreshold(scores.overstated, JEV_OVERSTATED_NOUL)) {
    borderline.push("overstated");
  }
  return {
    verdict:
      answers.verdict.choice === "pass" && failed.length === 0
        ? "pass"
        : "continue",
    confidence: answers.verdict.confidence,
    failed,
    borderline,
    scores,
    model: result.model,
    usage: result.usage,
  };
}

export function buildJevVerificationFeedback(outcome: JevAuditOutcome): string {
  const issues = outcome.failed.length
    ? outcome.failed
        .map((id) => `- ${JEV_ISSUE_TEXT[id] ?? id}`)
        .join("\n")
    : "- The proposed answer did not yet satisfy the task contract.";
  return (
    `${VERIFICATION_FEEDBACK_MARKER}\n` +
    "Your proposed answer was not shown to the user. Continue working on the " +
    "original request. Use more tools if evidence is missing; otherwise revise " +
    "the answer so unknowns remain explicitly unknown. Do not discuss this internal audit.\n\n" +
    `Issues:\n${issues}\n\n` +
    "Next step:\nResolve the issues, then provide a corrected final answer."
  );
}
