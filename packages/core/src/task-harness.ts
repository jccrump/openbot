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
  "clearly labeled unverified without overstating the conclusion. Return JSON only: " +
  '{"verdict":"pass"|"continue","issues":["..."],"instructions":"..."}.';

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

function observationId(index: number): string {
  return `browser-${String(index + 1).padStart(3, "0")}`;
}

function extractUrl(output: string): string | null {
  const match = /^url:\s*(\S+)/m.exec(output);
  return match?.[1] ?? null;
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
    `[evidence ${observationId(index)}; source=${kind}]\n` + output
  );
}

export function buildEvidenceLedger(
  records: ToolCallRecord[],
): EvidenceObservation[] {
  let browserIndex = 0;
  const observations: EvidenceObservation[] = [];
  for (const record of records) {
    if (record.name !== "browser") {
      continue;
    }
    const id = observationId(browserIndex);
    browserIndex += 1;
    const url = extractUrl(record.output);
    observations.push({
      id,
      tool: record.name,
      ok: record.ok,
      kind: classify(record, url),
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
      ? parsed.issues.filter((item): item is string => typeof item === "string")
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
  return records.some((record) => record.name === "browser");
}
