import { choice, noul, type DecisionClient } from "@openbot/gateway";
import type { SandboxBackend } from "@openbot/sandbox";
import type { DecisionNotice } from "./decision";
import { annotateBrowserObservation } from "./task-harness";

export const BROWSE_MAX_STEPS_DEFAULT = 8;
export const BROWSE_MAX_STEPS_CAP = 20;
export const BROWSE_WALL_BUDGET_MS = 90_000;
export const BROWSE_MAX_PAGES = 12;
export const BROWSE_PAGE_CHARS = 2_500;
export const BROWSE_MAX_EVIDENCE_CHARS = 64_000;
export const BROWSE_GOAL_THRESHOLD = 0.85;

const BROWSER_ACTION_TIMEOUT_MS = 60_000;
const BROWSE_MAX_LINKS = 80;

export interface BrowsePage {
  url: string;
  title: string;
  text: string;
}

export interface BrowseLink {
  href: string;
  label: string;
}

export type BrowseStopReason =
  | "goal-met"
  | "done"
  | "budget"
  | "no-links"
  | "challenge"
  | "browser-error"
  | "decision-error"
  | "aborted";

export interface BrowseLoopInput {
  sandbox: SandboxBackend;
  botId: string;
  client: DecisionClient;
  goal: string;
  startUrl?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Network egress policy enforced inside the guest for every request. */
  egress?: { mode: "ask" | "deny"; allow: string[] };
  screenPage?: (page: BrowsePage) => Promise<string | null>;
  onDecision?: (notice: DecisionNotice) => void;
}
export interface BrowseLoopResult {
  ok: boolean;
  pages: BrowsePage[];
  stoppedBy: BrowseStopReason;
  error: string | null;
  decisionCalls: number;
  browserActions: number;
  durationMs: number;
}

export function parseBrowseLinks(text: string): BrowseLink[] {
  const links: BrowseLink[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const marker = line.lastIndexOf(" — ");
    if (marker <= 0) {
      continue;
    }
    const label = line.slice(0, marker).trim();
    const href = line.slice(marker + 3).trim();
    if (!/^https?:\/\//i.test(href) || seen.has(href)) {
      continue;
    }
    seen.add(href);
    links.push({ href, label: label || href });
    if (links.length >= BROWSE_MAX_LINKS) {
      break;
    }
  }
  return links;
}

function browseQuestions(links: BrowseLink[]) {
  const criteria: Record<string, string> = {};
  for (const link of links) {
    criteria[link.href] = `${link.label} (${link.href})`;
  }
  criteria.__back__ = "Go back to the previous page.";
  criteria.__done__ =
    "Stop browsing and answer with the evidence collected so far.";
  return {
    goal_met: noul(
      "Does the evidence collected so far answer the research goal well enough to stop browsing?",
      {
        true: "The evidence covers the goal; stop and answer.",
        false: "More pages are needed before answering.",
      },
    ),
    next: choice(
      "Which link should the agent open next to make progress on the goal?",
      criteria,
    ),
  };
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  return `${value.slice(0, maximum)}\n[truncated]`;
}

function toPage(result: {
  url?: string;
  title?: string;
  text?: string;
}): BrowsePage {
  return {
    url: result.url ?? "",
    title: result.title ?? "",
    text: result.text ?? "",
  };
}

export function renderBrowseEvidence(pages: BrowsePage[]): string {
  const sections = pages.map((page, index) => {
    const body =
      `url: ${page.url}\n` +
      `title: ${page.title}\n` +
      `text:\n${truncate(page.text, BROWSE_PAGE_CHARS)}`;
    return annotateBrowserObservation(body, true, index, "browse");
  });
  let output = sections.join("\n\n---\n\n");
  if (output.length > BROWSE_MAX_EVIDENCE_CHARS) {
    output = `${output.slice(0, BROWSE_MAX_EVIDENCE_CHARS)}\n[evidence truncated]`;
  }
  return output;
}

export async function runBrowseLoop(
  input: BrowseLoopInput,
): Promise<BrowseLoopResult> {
  const startedAt = Date.now();
  const maxSteps = Math.min(
    Math.max(input.maxSteps ?? BROWSE_MAX_STEPS_DEFAULT, 1),
    BROWSE_MAX_STEPS_CAP,
  );
  const pages: BrowsePage[] = [];
  const visited = new Set<string>();
  let stoppedBy: BrowseStopReason = "budget";
  let error: string | null = null;
  let decisionCalls = 0;
  let browserActions = 0;

  const browser = async (
    payload: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    error?: string;
    url?: string;
    title?: string;
    text?: string;
    challenge?: boolean;
  }> => {
    browserActions += 1;
    const result = await input.sandbox.browser(input.botId, {
      action: String(payload.action ?? ""),
      ...(typeof payload.url === "string" ? { url: payload.url } : {}),
      ...(typeof payload.href === "string" ? { href: payload.href } : {}),
      ...(typeof payload.index === "number" ? { index: payload.index } : {}),
      ...(input.egress ? { egress: input.egress } : {}),
      timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    });
    const blocked = (result as { egressBlocked?: string[] }).egressBlocked;
    if (blocked?.length && result.text) {
      return {
        ...result,
        text:
          `${result.text}\n[egress] blocked request(s) to ${blocked.join(", ")}: ` +
          "not in the browser egress allowlist",
      };
    }
    return result;
  };

  const record = async (result: {
    ok: boolean;
    error?: string;
    url?: string;
    title?: string;
    text?: string;
    challenge?: boolean;
  }): Promise<boolean> => {
    if (result.ok === false) {
      error = result.error ?? "browser action failed";
      stoppedBy = result.challenge ? "challenge" : "browser-error";
      return false;
    }
    const page = toPage(result);
    if (input.screenPage) {
      const replacement = await input.screenPage(page);
      if (replacement !== null) {
        page.text = replacement;
      }
    }
    pages.push(page);
    if (page.url) {
      visited.add(page.url);
    }
    return true;
  };

  try {
    if (input.startUrl) {
      const opened = await browser({ action: "goto", url: input.startUrl });
      if (!(await record(opened))) {
        return finish();
      }
    } else {
      const current = await browser({ action: "text" });
      if (!(await record(current))) {
        return finish();
      }
    }

    for (let step = 0; step < maxSteps; step += 1) {
      if (input.signal?.aborted) {
        stoppedBy = "aborted";
        break;
      }
      if (Date.now() - startedAt > BROWSE_WALL_BUDGET_MS) {
        stoppedBy = "budget";
        break;
      }
      if (pages.length >= BROWSE_MAX_PAGES) {
        stoppedBy = "budget";
        break;
      }

      const listed = await browser({ action: "links" });
      if (listed.ok === false) {
        stoppedBy = "browser-error";
        error = listed.error ?? "links action failed";
        break;
      }
      const links = parseBrowseLinks(listed.text ?? "").filter(
        (link) => !visited.has(link.href),
      );
      if (links.length === 0) {
        stoppedBy = "no-links";
        break;
      }

      const current = pages.at(-1);
      const decisionStartedAt = Date.now();
      let decision;
      try {
        decision = await input.client.evaluate({
          state: {
            goal: input.goal,
            current_page: current
              ? {
                  url: current.url,
                  title: current.title,
                  text: truncate(current.text, BROWSE_PAGE_CHARS),
                }
              : null,
            pages_visited: pages.map((page) => ({
              url: page.url,
              title: page.title,
            })),
            links: links.map((link) => ({
              href: link.href,
              label: link.label,
            })),
          },
          questions: browseQuestions(links),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (caught) {
        if (input.signal?.aborted) {
          stoppedBy = "aborted";
          break;
        }
        stoppedBy = "decision-error";
        error = (caught as Error).message;
        break;
      }
      decisionCalls += 1;

      const goalMet =
        decision.answers.goal_met.noul >= BROWSE_GOAL_THRESHOLD;
      const next = decision.answers.next.choice;
      const picked = links.find((link) => link.href === next);
      input.onDecision?.({
        kind: "browse",
        summary: goalMet
          ? `goal met after ${pages.length} page${pages.length === 1 ? "" : "s"}`
          : next === "__done__"
            ? "done — answer with the collected evidence"
            : next === "__back__"
              ? "go back one page"
              : `picked ${(picked?.label ?? next).slice(0, 60)}`,
        flagged: false,
        latencyMs: Date.now() - decisionStartedAt,
        model: decision.model,
      });

      if (goalMet) {
        stoppedBy = "goal-met";
        break;
      }
      if (next === "__done__") {
        stoppedBy = "done";
        break;
      }
      if (next === "__back__") {
        const back = await browser({ action: "back" });
        if (!(await record(back))) {
          break;
        }
        continue;
      }
      visited.add(next);
      const clicked = await browser({ action: "clickLink", href: next });
      if (!(await record(clicked))) {
        break;
      }
    }
  } catch (caught) {
    stoppedBy = "browser-error";
    error = (caught as Error).message;
  }

  return finish();

  function finish(): BrowseLoopResult {
    return {
      ok: pages.length > 0,
      pages,
      stoppedBy,
      error,
      decisionCalls,
      browserActions,
      durationMs: Date.now() - startedAt,
    };
  }
}
