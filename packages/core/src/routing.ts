import { choice, noul, type DecisionClient } from "@openbot/gateway";

export interface RouteCandidate {
  id: string;
  name: string;
  scope: string | null;
}

export type RouteTarget = "chat" | "direct" | "project" | "new_project";

export interface RouteDecision {
  needsWork: boolean;
  target: RouteTarget;
  projectId: string | null;
  confidence: number;
  summary: string;
  model: string | null;
  latencyMs: number;
}

const NEEDS_WORK_YES = 0.7;
const NEEDS_WORK_NO = 0.3;
const ROUTE_CONFIDENCE = 0.8;

/**
 * A fast, typed routing decision for the lead: is this conversation or work,
 * and if it is work, does an existing project own it, does it need a new one,
 * or should the lead handle it directly? Returns null when the decision is not
 * confident enough, in which case the model decides as before.
 */
export async function decideRoute(input: {
  client: DecisionClient;
  message: string;
  projects: RouteCandidate[];
  signal?: AbortSignal;
}): Promise<RouteDecision | null> {
  const criteria: Record<string, string> = {
    direct: "Handle it directly in this chat with your own tools",
    "new:project": "No existing project covers this; create a new project",
  };
  for (const project of input.projects.slice(0, 12)) {
    criteria[`project:${project.id}`] =
      `Route it to project "${project.name}"` +
      (project.scope ? ` (${project.scope})` : "");
  }

  const startedAt = Date.now();
  const result = await input.client.evaluate({
    state: {
      message: input.message,
      projects: input.projects.map((project) => ({
        name: project.name,
        scope: project.scope,
      })),
    },
    questions: {
      needs_work: noul(
        "Does this message ask the assistant to do something that requires " +
          "acting — running commands, browsing, changing files, or producing " +
          "a deliverable — rather than just conversation?",
        {
          true: "The message asks for real work or information that needs acting.",
          false:
            "The message is conversation, a greeting, or something answerable without acting.",
        },
      ),
      route: choice("Where should this request be handled?", criteria),
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const latencyMs = Date.now() - startedAt;
  const needsWorkValue = result.answers.needs_work.noul;
  const confidence = result.answers.route.confidence;
  const choiceKey = result.answers.route.choice;

  if (needsWorkValue < NEEDS_WORK_NO) {
    return {
      needsWork: false,
      target: "chat",
      projectId: null,
      confidence,
      summary: `chat · confidence ${confidence.toFixed(2)}`,
      model: result.model,
      latencyMs,
    };
  }
  if (needsWorkValue < NEEDS_WORK_YES || confidence < ROUTE_CONFIDENCE) {
    return null;
  }

  let target: RouteTarget = "direct";
  let projectId: string | null = null;
  if (choiceKey === "new:project") {
    target = "new_project";
  } else if (choiceKey.startsWith("project:")) {
    const candidate = choiceKey.slice("project:".length);
    if (input.projects.some((project) => project.id === candidate)) {
      target = "project";
      projectId = candidate;
    }
  }

  const projectName = input.projects.find(
    (project) => project.id === projectId,
  )?.name;
  const summary =
    target === "project"
      ? `project "${projectName}" · confidence ${confidence.toFixed(2)}`
      : target === "new_project"
        ? `new project · confidence ${confidence.toFixed(2)}`
        : `direct · confidence ${confidence.toFixed(2)}`;
  return {
    needsWork: true,
    target,
    projectId,
    confidence,
    summary,
    model: result.model,
    latencyMs,
  };
}
