import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  pageForUrl,
  scenarioSearchText,
  scenarios,
} from "../evals/scenarios.mjs";

const root = resolve(import.meta.dirname, "..");
const resultsDir = join(root, "evals", "results");
const SCREEN_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function parseArgs(argv) {
  const options = {
    runs: 1,
    label: "baseline",
    scenarioIds: [],
    compare: null,
    regrade: null,
    model: process.env.OPENBOT_EVAL_MODEL || "deepseek-flash",
    baseUrl: process.env.OPENBOT_EVAL_BASE_URL || "https://api.deepseek.com",
    timeoutMs: 5 * 60_000,
    list: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--") {
      continue;
    }
    if (argument === "--runs" && value) {
      options.runs = Number(value);
      index += 1;
    } else if (argument === "--label" && value) {
      options.label = value;
      index += 1;
    } else if (argument === "--scenario" && value) {
      options.scenarioIds.push(...value.split(",").filter(Boolean));
      index += 1;
    } else if (argument === "--compare" && value) {
      options.compare = value;
      index += 1;
    } else if (argument === "--regrade" && value) {
      options.regrade = value;
      index += 1;
    } else if (argument === "--model" && value) {
      options.model = value;
      index += 1;
    } else if (argument === "--base-url" && value) {
      options.baseUrl = value;
      index += 1;
    } else if (argument === "--timeout-ms" && value) {
      options.timeoutMs = Number(value);
      index += 1;
    } else if (argument === "--list") {
      options.list = true;
    } else if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50) {
    throw new Error("--runs must be an integer between 1 and 50");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000) {
    throw new Error("--timeout-ms must be at least 10000");
  }
  return options;
}

function printHelp() {
  console.log(`OpenBot deterministic real-model evaluation

Usage:
  pnpm eval -- --label pre-change --runs 5
  pnpm eval -- --label post-change --runs 5 --compare evals/results/<baseline>.json
  pnpm eval -- --regrade evals/results/<result>.json --label corrected-baseline
  pnpm eval -- --scenario soccer-local-inventory,pizza-conjunctive
  pnpm eval -- --list

Options:
  --runs N          Repetitions per scenario (default 1)
  --label NAME      Result label (default baseline)
  --scenario IDS    Comma-separated scenario IDs
  --compare PATH    Compare the new result with an earlier JSON result
  --regrade PATH    Reapply current graders to a saved result without model calls
  --model MODEL     OpenAI-compatible model ID
  --base-url URL    Provider base URL
  --timeout-ms MS   Per-run timeout (default 300000)
  --list            List scenarios without calling a model`);
}

function sanitizeLabel(value) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "eval"
  );
}

function readBody(request) {
  return new Promise((resolvePromise) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolvePromise(body));
  });
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise(typeof address === "object" && address ? address.port : 0);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function searchUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.includes("google.") ||
      host.includes("bing.com") ||
      host.includes("duckduckgo.com") ||
      host.includes("search.brave.com") ||
      host.includes("search.yahoo.com")
    );
  } catch {
    return false;
  }
}

function createFixtureSandbox(activeScenarios, browserTrace) {
  const currentUrls = new Map();
  return createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const rawUrl = request.url || "";
    if (rawUrl === "/health") {
      response.end(JSON.stringify({ ok: true, vms: activeScenarios.size }));
      return;
    }
    const match = /^\/vms\/([^/]+)\/(ensure|status|browser|exec|stop|destroy)$/.exec(
      rawUrl,
    );
    if (!match) {
      response.statusCode = 404;
      response.end("{}");
      return;
    }
    const botId = decodeURIComponent(match[1]);
    const operation = match[2];
    const scenario = activeScenarios.get(botId);
    if (operation === "ensure" || operation === "status") {
      response.end(
        JSON.stringify({
          botId,
          state: "running",
          cid: 3,
          bootedAt: new Date().toISOString(),
          error: null,
        }),
      );
      return;
    }
    if (operation === "stop" || operation === "destroy") {
      currentUrls.delete(botId);
      if (operation === "destroy") {
        activeScenarios.delete(botId);
      }
      response.end(
        JSON.stringify({
          botId,
          state: "stopped",
          cid: null,
          bootedAt: null,
          error: null,
        }),
      );
      return;
    }
    const rawBody = request.method === "POST" ? await readBody(request) : "";
    const body = rawBody ? JSON.parse(rawBody) : {};
    if (operation === "exec") {
      response.end(
        JSON.stringify({
          exit: 1,
          stdout: "",
          stderr:
            "The deterministic evaluation sandbox has no shell network access. Use the browser tool and the provided search results.",
          durationMs: 2,
        }),
      );
      return;
    }
    if (!scenario) {
      response.end(
        JSON.stringify({
          ok: false,
          error: "no evaluation scenario is assigned to this bot",
          durationMs: 1,
        }),
      );
      return;
    }

    const action = String(body.action || "");
    let targetUrl = currentUrls.get(botId) || "about:blank";
    if (action === "goto" && typeof body.url === "string") {
      targetUrl = body.url;
      currentUrls.set(botId, targetUrl);
    } else if (action === "back") {
      targetUrl = `https://www.google.com/search?q=${encodeURIComponent(scenario.prompt)}`;
      currentUrls.set(botId, targetUrl);
    }

    browserTrace.push({
      botId,
      scenarioId: scenario.id,
      action,
      requestedUrl: typeof body.url === "string" ? body.url : null,
      currentUrl: targetUrl,
      at: new Date().toISOString(),
    });

    if (action === "screenshot") {
      const page = pageForUrl(scenario, targetUrl);
      response.end(
        JSON.stringify({
          ok: true,
          url: targetUrl,
          title: page?.title || `Search results for ${scenario.title}`,
          screenshot: SCREEN_PNG,
          durationMs: 2,
        }),
      );
      return;
    }
    if (searchUrl(targetUrl) || targetUrl === "about:blank") {
      response.end(
        JSON.stringify({
          ok: true,
          url: targetUrl,
          title: `Search results for ${scenario.title}`,
          text: scenarioSearchText(scenario),
          durationMs: 2,
        }),
      );
      return;
    }
    const page = pageForUrl(scenario, targetUrl);
    if (page) {
      response.end(
        JSON.stringify({
          ok: true,
          url: targetUrl,
          title: page.title,
          text: page.text,
          durationMs: 2,
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        ok: true,
        url: targetUrl,
        title: "404 Page Not Found",
        text:
          "404 Page Not Found. This URL is not part of the deterministic evaluation website. Return to the search results and use one of its exact links.",
        durationMs: 2,
      }),
    );
  });
}

function storedProviderKey() {
  const databasePath = join(root, ".openbot-dev", "openbot.db");
  if (!existsSync(databasePath)) {
    return null;
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT api_key FROM providers WHERE id = ?")
      .get("deepseek");
    return typeof row?.api_key === "string" && row.api_key
      ? row.api_key
      : null;
  } finally {
    database.close();
  }
}

function resolveProviderKey() {
  return (
    process.env.OPENBOT_EVAL_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    storedProviderKey()
  );
}

function repositoryIdentity() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 50 * 1024 * 1024,
  });
  const fingerprint = createHash("sha256")
    .update(commit)
    .update(status)
    .update(diff)
    .digest("hex");
  return { commit, dirty: Boolean(status.trim()), fingerprint };
}

function evaluatorIdentity() {
  const scenarioSource = readFileSync(
    join(root, "evals", "scenarios.mjs"),
    "utf8",
  );
  const runnerSource = readFileSync(join(root, "scripts", "eval.mjs"), "utf8");
  return {
    scenariosSha256: createHash("sha256").update(scenarioSource).digest("hex"),
    runnerSha256: createHash("sha256").update(runnerSource).digest("hex"),
  };
}

function createSocketClient(url) {
  const queue = [];
  const events = [];
  const waiters = new Set();
  const socket = new WebSocket(url);
  const opened = new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener(
      "error",
      () => rejectPromise(new Error("evaluation websocket failed to connect")),
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    events.push({ message, receivedAt: Date.now() });
    queue.push(message);
    for (const wake of waiters) {
      wake();
    }
  });
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = queue.findIndex(predicate);
      if (index >= 0) {
        return queue.splice(index, 1)[0];
      }
      await new Promise((resolvePromise, rejectPromise) => {
        const remaining = deadline - Date.now();
        const timer = setTimeout(() => {
          waiters.delete(wake);
          rejectPromise(new Error("timed out waiting for daemon event"));
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolvePromise();
        };
        waiters.add(wake);
      });
    }
    throw new Error("timed out waiting for daemon event");
  };
  return {
    opened,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    waitFor,
    eventCount() {
      return events.length;
    },
    eventsSince(index) {
      return events.slice(index);
    },
    close() {
      socket.close();
    },
  };
}

function extractOutputUrl(output) {
  return /^url:\s*(\S+)/m.exec(output)?.[1] || null;
}

function runContext(scenario, message, toolCalls) {
  const visitedPageIds = new Set();
  for (const call of toolCalls) {
    if (call.name !== "browser") continue;
    let argumentsValue = {};
    try {
      argumentsValue = JSON.parse(call.arguments || "{}");
    } catch {
      // The failed call is still captured in the trace.
    }
    const candidates = [argumentsValue.url, extractOutputUrl(call.output)].filter(
      (value) => typeof value === "string",
    );
    for (const candidate of candidates) {
      const page = pageForUrl(scenario, candidate);
      if (page) visitedPageIds.add(page.id);
    }
  }
  return {
    answer: message.content || "",
    visitedPageIds: [...visitedPageIds],
    browserActions: toolCalls.filter((call) => call.name === "browser").length,
  };
}

function auditMetrics(logText, runId) {
  const escaped = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `completion\\.audit\\s*\\{[\\s\\S]*?runId: '${escaped}'[\\s\\S]*?verdict: '(pass|continue)'[\\s\\S]*?\\}`,
    "g",
  );
  const verdicts = [...logText.matchAll(pattern)].map((match) => match[1]);
  return {
    audits: verdicts.length,
    repairs: verdicts.filter((verdict) => verdict === "continue").length,
    verdicts,
  };
}

function firstEventDelay(events, startedAt, types) {
  const event = events.find(({ message }) => types.includes(message.type));
  return event ? Math.max(0, event.receivedAt - startedAt) : null;
}

function runSpeedMetrics(events, startedAt, toolCalls) {
  return {
    timeToFirstActionMs: firstEventDelay(events, startedAt, [
      "tool.start",
      "chat.delta",
    ]),
    timeToFirstToolMs: firstEventDelay(events, startedAt, ["tool.start"]),
    timeToFirstTextMs: firstEventDelay(events, startedAt, ["chat.delta"]),
    totalToolDurationMs: toolCalls.reduce(
      (total, call) => total + (Number(call.durationMs) || 0),
      0,
    ),
  };
}

async function evaluateRun(input) {
  const requestId = `eval-bot-${randomUUID()}`;
  input.client.send({
    type: "bots.create",
    requestId,
    name: `Eval ${input.scenario.id} ${input.repetition}`,
    model: { provider: "eval-provider", model: input.model },
  });
  const created = await input.client.waitFor(
    (message) => message.type === "bot.created" && message.requestId === requestId,
    15_000,
  );
  const botId = created.bot.id;
  input.activeScenarios.set(botId, input.scenario);
  const traceStart = input.browserTrace.length;
  const logStart = input.daemonLog.length;
  const eventStart = input.client.eventCount();
  const startedAt = Date.now();
  input.client.send({
    type: "chat.send",
    botId,
    text: input.scenario.prompt,
    model: { provider: "eval-provider", model: input.model },
  });
  const started = await input.client.waitFor(
    (message) => message.type === "chat.start" && message.threadId,
    15_000,
  );
  const completed = await input.client.waitFor(
    (message) =>
      (message.type === "chat.done" || message.type === "chat.error") &&
      message.runId === started.runId,
    input.timeoutMs,
  );
  const durationMs = Date.now() - startedAt;
  const runEvents = input.client
    .eventsSince(eventStart)
    .filter(({ message }) => message.runId === started.runId);
  let output;
  if (completed.type === "chat.done") {
    input.client.send({
      type: "thread.messages",
      threadId: started.threadId,
    });
    const history = await input.client.waitFor(
      (message) =>
        message.type === "thread.messages" &&
        message.threadId === started.threadId,
      15_000,
    );
    const toolCalls = history.messages.flatMap(
      (message) => message.toolCalls || [],
    );
    const context = runContext(input.scenario, completed.message, toolCalls);
    const grade = input.scenario.grade(context);
    output = {
      scenarioId: input.scenario.id,
      scenarioTitle: input.scenario.title,
      repetition: input.repetition,
      pass: grade.pass,
      score: grade.score,
      checks: grade.checks,
      answer: completed.message.content,
      visitedPageIds: context.visitedPageIds,
      browserActions: context.browserActions,
      totalToolCalls: toolCalls.length,
      failedToolCalls: toolCalls.filter((call) => !call.ok).length,
      durationMs,
      usage: completed.message.usage || null,
      toolCalls,
      browserTrace: input.browserTrace.slice(traceStart),
      error: null,
      ...runSpeedMetrics(runEvents, startedAt, toolCalls),
      ...auditMetrics(input.daemonLog.slice(logStart), started.runId),
    };
  } else {
    output = {
      scenarioId: input.scenario.id,
      scenarioTitle: input.scenario.title,
      repetition: input.repetition,
      pass: false,
      score: 0,
      checks: [],
      answer: "",
      visitedPageIds: [],
      browserActions: 0,
      totalToolCalls: 0,
      failedToolCalls: 0,
      durationMs,
      usage: null,
      toolCalls: [],
      browserTrace: input.browserTrace.slice(traceStart),
      error: completed.message,
      ...runSpeedMetrics(runEvents, startedAt, []),
      ...auditMetrics(input.daemonLog.slice(logStart), started.runId),
    };
  }

  const deleteRequestId = `eval-delete-${randomUUID()}`;
  input.client.send({ type: "bots.delete", requestId: deleteRequestId, botId });
  await input.client.waitFor(
    (message) =>
      message.type === "bot.deleted" && message.requestId === deleteRequestId,
    15_000,
  );
  return output;
}

function average(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function numeric(values) {
  return values.filter((value) => Number.isFinite(value));
}

function percentile(values, quantile) {
  const sorted = numeric(values).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function nullableAverage(values) {
  const usable = numeric(values);
  return usable.length ? average(usable) : null;
}

function summarize(runs, selectedScenarios) {
  const scenarioRows = selectedScenarios.map((scenario) => {
    const matching = runs.filter((run) => run.scenarioId === scenario.id);
    return {
      id: scenario.id,
      title: scenario.title,
      passes: matching.filter((run) => run.pass).length,
      runs: matching.length,
      passRate: matching.length
        ? matching.filter((run) => run.pass).length / matching.length
        : 0,
      averageScore: average(matching.map((run) => run.score)),
      averageActions: average(matching.map((run) => run.browserActions)),
      averageDurationMs: average(matching.map((run) => run.durationMs)),
      medianDurationMs: percentile(
        matching.map((run) => run.durationMs),
        0.5,
      ),
      p95DurationMs: percentile(
        matching.map((run) => run.durationMs),
        0.95,
      ),
      averageTimeToFirstActionMs: nullableAverage(
        matching.map((run) => run.timeToFirstActionMs),
      ),
      averageTimeToFirstToolMs: nullableAverage(
        matching.map((run) => run.timeToFirstToolMs),
      ),
    };
  });
  const inputTokens = runs.map((run) => run.usage?.inputTokens || 0);
  const outputTokens = runs.map((run) => run.usage?.outputTokens || 0);
  return {
    passes: runs.filter((run) => run.pass).length,
    runs: runs.length,
    strictPassRate: runs.length
      ? runs.filter((run) => run.pass).length / runs.length
      : 0,
    averageScore: average(runs.map((run) => run.score)),
    averageBrowserActions: average(runs.map((run) => run.browserActions)),
    averageDurationMs: average(runs.map((run) => run.durationMs)),
    medianDurationMs: percentile(runs.map((run) => run.durationMs), 0.5),
    p95DurationMs: percentile(runs.map((run) => run.durationMs), 0.95),
    averageTimeToFirstActionMs: nullableAverage(
      runs.map((run) => run.timeToFirstActionMs),
    ),
    medianTimeToFirstActionMs: percentile(
      runs.map((run) => run.timeToFirstActionMs),
      0.5,
    ),
    p95TimeToFirstActionMs: percentile(
      runs.map((run) => run.timeToFirstActionMs),
      0.95,
    ),
    averageTimeToFirstToolMs: nullableAverage(
      runs.map((run) => run.timeToFirstToolMs),
    ),
    medianTimeToFirstToolMs: percentile(
      runs.map((run) => run.timeToFirstToolMs),
      0.5,
    ),
    p95TimeToFirstToolMs: percentile(
      runs.map((run) => run.timeToFirstToolMs),
      0.95,
    ),
    averageTimeToFirstTextMs: nullableAverage(
      runs.map((run) => run.timeToFirstTextMs),
    ),
    medianTimeToFirstTextMs: percentile(
      runs.map((run) => run.timeToFirstTextMs),
      0.5,
    ),
    p95TimeToFirstTextMs: percentile(
      runs.map((run) => run.timeToFirstTextMs),
      0.95,
    ),
    averageToolDurationMs: average(
      runs.map((run) => run.totalToolDurationMs || 0),
    ),
    tasksPerMinute:
      runs.length && runs.some((run) => run.durationMs > 0)
        ? (runs.length * 60_000) /
          runs.reduce((total, run) => total + run.durationMs, 0)
        : 0,
    averageInputTokens: average(inputTokens),
    averageOutputTokens: average(outputTokens),
    totalVerifierRepairs: runs.reduce((total, run) => total + run.repairs, 0),
    totalFailedToolCalls: runs.reduce(
      (total, run) => total + run.failedToolCalls,
      0,
    ),
    scenarios: scenarioRows,
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function seconds(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "n/a";
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function decimal(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function comparisonRows(current, baseline) {
  if (!baseline) return [];
  const fields = [
    ["Strict pass rate", "strictPassRate", percent],
    ["Average score", "averageScore", percent],
    ["Average browser actions", "averageBrowserActions", (value) => decimal(value, 1)],
    ["Average duration", "averageDurationMs", seconds],
    ["Median duration", "medianDurationMs", seconds],
    ["P95 duration", "p95DurationMs", seconds],
    ["Average first action", "averageTimeToFirstActionMs", seconds],
    ["Median first action", "medianTimeToFirstActionMs", seconds],
    ["P95 first action", "p95TimeToFirstActionMs", seconds],
    ["Average first tool", "averageTimeToFirstToolMs", seconds],
    ["P95 first tool", "p95TimeToFirstToolMs", seconds],
    ["Average first text", "averageTimeToFirstTextMs", seconds],
    ["P95 first text", "p95TimeToFirstTextMs", seconds],
    ["Run-only tasks per minute", "tasksPerMinute", (value) => decimal(value)],
    ["Benchmark wall time", "benchmarkWallTimeMs", seconds],
    [
      "Effective tasks per minute",
      "benchmarkTasksPerMinute",
      (value) => decimal(value),
    ],
    ["Average input tokens", "averageInputTokens", (value) => decimal(value, 0)],
    ["Average output tokens", "averageOutputTokens", (value) => decimal(value, 0)],
  ];
  return fields.map(([label, key, format]) => ({
    label,
    before: format(baseline[key]),
    after: format(current[key]),
    delta:
      key === "strictPassRate" || key === "averageScore"
        ? `${((current[key] - baseline[key]) * 100).toFixed(1)} pp`
        : format(current[key] - baseline[key]),
  }));
}

function markdownReport(result, baseline) {
  const lines = [
    `# OpenBot evaluation: ${result.label}`,
    "",
    `- Created: ${result.createdAt}`,
    `- Model: \`${result.model}\``,
    `- Runs: ${result.summary.runs}`,
    `- Strict pass rate: **${percent(result.summary.strictPassRate)}** (${result.summary.passes}/${result.summary.runs})`,
    `- Average score: **${percent(result.summary.averageScore)}**`,
    `- Average browser actions: ${result.summary.averageBrowserActions.toFixed(1)}`,
    `- Completion time (average / median / p95): **${seconds(result.summary.averageDurationMs)} / ${seconds(result.summary.medianDurationMs)} / ${seconds(result.summary.p95DurationMs)}**`,
    `- Time to first action (average / median / p95): **${seconds(result.summary.averageTimeToFirstActionMs)} / ${seconds(result.summary.medianTimeToFirstActionMs)} / ${seconds(result.summary.p95TimeToFirstActionMs)}**`,
    `- Time to first tool (average / median / p95): ${seconds(result.summary.averageTimeToFirstToolMs)} / ${seconds(result.summary.medianTimeToFirstToolMs)} / ${seconds(result.summary.p95TimeToFirstToolMs)}`,
    `- Time to first text (average / median / p95): ${seconds(result.summary.averageTimeToFirstTextMs)} / ${seconds(result.summary.medianTimeToFirstTextMs)} / ${seconds(result.summary.p95TimeToFirstTextMs)}`,
    `- Run-only throughput: ${decimal(result.summary.tasksPerMinute)} tasks/minute`,
    `- Benchmark wall time / effective throughput: ${seconds(result.summary.benchmarkWallTimeMs)} / ${decimal(result.summary.benchmarkTasksPerMinute)} tasks/minute`,
    `- Verifier repairs: ${result.summary.totalVerifierRepairs}`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Strict pass | Avg score | Avg actions | Avg completion | P95 completion | Avg first action | Avg first tool |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...result.summary.scenarios.map(
      (row) =>
        `| ${row.id} | ${row.passes}/${row.runs} (${percent(row.passRate)}) | ${percent(row.averageScore)} | ${row.averageActions.toFixed(1)} | ${seconds(row.averageDurationMs)} | ${seconds(row.p95DurationMs)} | ${seconds(row.averageTimeToFirstActionMs)} | ${seconds(row.averageTimeToFirstToolMs)} |`,
    ),
  ];
  if (baseline) {
    lines.push(
      "",
      `## Comparison with ${baseline.label}`,
      "",
      "| Metric | Before | After | Delta |",
      "|---|---:|---:|---:|",
      ...comparisonRows(result.summary, baseline.summary).map(
        (row) => `| ${row.label} | ${row.before} | ${row.after} | ${row.delta} |`,
      ),
    );
  }
  const failed = result.runs.filter((run) => !run.pass);
  if (failed.length) {
    lines.push("", "## Failed checks", "");
    for (const run of failed) {
      const checks = run.checks
        .filter((check) => check.critical !== false && !check.passed)
        .map((check) => check.description)
        .join("; ");
      lines.push(
        `- **${run.scenarioId} run ${run.repetition}:** ${run.error || checks || "run failed"}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function assertComparable(result, baseline) {
  if (result.model !== baseline.model) {
    throw new Error(
      `comparison model mismatch: ${baseline.model} vs ${result.model}`,
    );
  }
  const currentIds = [...result.scenarioIds].sort().join(",");
  const baselineIds = [...baseline.scenarioIds].sort().join(",");
  if (currentIds !== baselineIds) {
    throw new Error("comparison scenario set does not match the baseline");
  }
  const currentGrader = result.evaluator?.scenariosSha256;
  const baselineGrader = baseline.evaluator?.scenariosSha256;
  if (!currentGrader || !baselineGrader || currentGrader !== baselineGrader) {
    throw new Error(
      "comparison grader mismatch; regrade the saved baseline with --regrade first",
    );
  }
  const currentRunner = result.evaluator?.runnerSha256;
  const baselineRunner = baseline.evaluator?.runnerSha256;
  if (!currentRunner || !baselineRunner || currentRunner !== baselineRunner) {
    throw new Error(
      "comparison runner mismatch; establish a new baseline with the current evaluator",
    );
  }
}

function saveResult(result, baseline) {
  if (baseline) assertComparable(result, baseline);
  mkdirSync(resultsDir, { recursive: true });
  const stamp = result.createdAt.replace(/[:.]/g, "-");
  const basename = `${stamp}-${sanitizeLabel(result.label)}`;
  const jsonPath = join(resultsDir, `${basename}.json`);
  const markdownPath = join(resultsDir, `${basename}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(markdownPath, markdownReport(result, baseline));
  return { jsonPath, markdownPath };
}

function regradeSavedResult(options) {
  const sourcePath = resolve(root, options.regrade);
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const selected = source.scenarioIds.map((id) => {
    const scenario = scenarios.find((candidate) => candidate.id === id);
    if (!scenario) throw new Error(`saved result references unknown scenario: ${id}`);
    return scenario;
  });
  const runs = source.runs.map((run) => {
    const scenario = selected.find((candidate) => candidate.id === run.scenarioId);
    const grade = scenario.grade({
      answer: run.answer || "",
      visitedPageIds: run.visitedPageIds || [],
      browserActions: run.browserActions || 0,
    });
    return { ...run, pass: grade.pass, score: grade.score, checks: grade.checks };
  });
  const createdAt = new Date().toISOString();
  const label =
    options.label === "baseline" ? `${source.label}-regraded` : options.label;
  const result = {
    ...source,
    schemaVersion: 1,
    label,
    createdAt,
    repository: repositoryIdentity(),
    evaluator: {
      ...evaluatorIdentity(),
      runnerSha256: source.evaluator?.runnerSha256 || null,
    },
    summary: {
      ...summarize(runs, selected),
      benchmarkWallTimeMs: source.summary?.benchmarkWallTimeMs ?? null,
      benchmarkTasksPerMinute:
        source.summary?.benchmarkTasksPerMinute ?? null,
    },
    runs,
    regradedFrom: sourcePath,
  };
  const baseline = options.compare
    ? JSON.parse(readFileSync(resolve(root, options.compare), "utf8"))
    : null;
  const paths = saveResult(result, baseline);
  console.log(
    `Regraded ${result.summary.runs} saved runs without calling the model.`,
  );
  printResultSummary(result, baseline, paths);
}

function printResultSummary(result, baseline, paths) {
  console.log("");
  console.log(
    `Strict pass: ${result.summary.passes}/${result.summary.runs} (${percent(result.summary.strictPassRate)})`,
  );
  console.log(`Average score: ${percent(result.summary.averageScore)}`);
  console.log(
    `Completion time avg/median/p95: ${seconds(result.summary.averageDurationMs)} / ${seconds(result.summary.medianDurationMs)} / ${seconds(result.summary.p95DurationMs)}`,
  );
  console.log(
    `First action avg/median/p95: ${seconds(result.summary.averageTimeToFirstActionMs)} / ${seconds(result.summary.medianTimeToFirstActionMs)} / ${seconds(result.summary.p95TimeToFirstActionMs)}`,
  );
  console.log(
    `First tool avg/median/p95: ${seconds(result.summary.averageTimeToFirstToolMs)} / ${seconds(result.summary.medianTimeToFirstToolMs)} / ${seconds(result.summary.p95TimeToFirstToolMs)}`,
  );
  console.log(
    `First text avg/median/p95: ${seconds(result.summary.averageTimeToFirstTextMs)} / ${seconds(result.summary.medianTimeToFirstTextMs)} / ${seconds(result.summary.p95TimeToFirstTextMs)}`,
  );
  console.log(`Run-only throughput: ${decimal(result.summary.tasksPerMinute)} tasks/minute`);
  console.log(
    `Benchmark wall time / effective throughput: ${seconds(result.summary.benchmarkWallTimeMs)} / ${decimal(result.summary.benchmarkTasksPerMinute)} tasks/minute`,
  );
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`Report: ${paths.markdownPath}`);
  if (baseline) {
    console.log("");
    for (const row of comparisonRows(result.summary, baseline.summary)) {
      console.log(`${row.label}: ${row.before} -> ${row.after} (${row.delta})`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const scenario of scenarios) {
      console.log(`${scenario.id}\t${scenario.title}`);
    }
    return;
  }
  if (options.regrade) {
    regradeSavedResult(options);
    return;
  }
  const selected = options.scenarioIds.length
    ? scenarios.filter((scenario) => options.scenarioIds.includes(scenario.id))
    : scenarios;
  const unknown = options.scenarioIds.filter(
    (id) => !selected.some((scenario) => scenario.id === id),
  );
  if (unknown.length) {
    throw new Error(`unknown scenarios: ${unknown.join(", ")}`);
  }
  const providerKey = resolveProviderKey();
  if (!providerKey) {
    throw new Error(
      "No evaluation provider key is available. Set OPENBOT_EVAL_API_KEY or DEEPSEEK_API_KEY, or save the DeepSeek key in OpenBot settings.",
    );
  }

  const benchmarkStartedAt = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "openbot-eval-"));
  const activeScenarios = new Map();
  const browserTrace = [];
  const sandbox = createFixtureSandbox(activeScenarios, browserTrace);
  const sandboxPort = await listen(sandbox);
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify(
      {
        port: 0,
        providers: [
          {
            id: "eval-provider",
            label: "Evaluation provider",
            kind: "openai-compatible",
            baseUrl: options.baseUrl,
            apiKeyEnv: "OPENBOT_EVAL_PROVIDER_KEY",
            models: [options.model],
          },
        ],
        defaultModel: { provider: "eval-provider", model: options.model },
        sandboxUrl: `http://127.0.0.1:${sandboxPort}`,
        requireApproval: false,
        compaction: { enabled: false, thresholdTokens: null },
        harness: { default: "openbot" },
      },
      null,
      2,
    ),
  );

  let daemonLog = "";
  const daemon = spawn(
    process.execPath,
    ["--import", "tsx", "src/bin/openbotd.ts"],
    {
      cwd: join(root, "packages", "core"),
      env: {
        ...process.env,
        OPENBOT_DATA_DIR: dataDir,
        OPENBOT_PORT: "0",
        OPENBOT_SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
        OPENBOT_REQUIRE_APPROVAL: "false",
        OPENBOT_EVAL_PROVIDER_KEY: providerKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const daemonPort = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("evaluation daemon did not start")),
      20_000,
    );
    const onData = (data) => {
      daemonLog += String(data);
      const match = daemonLog.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(Number(match[1]));
      }
    };
    daemon.stdout.on("data", onData);
    daemon.stderr.on("data", (data) => {
      daemonLog += String(data);
    });
    daemon.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`evaluation daemon exited early (${code})`));
    });
  });

  const client = createSocketClient(`ws://127.0.0.1:${daemonPort}/ws`);
  await client.opened;
  await client.waitFor((message) => message.type === "hello", 10_000);
  const runs = [];
  try {
    for (let repetition = 1; repetition <= options.runs; repetition += 1) {
      for (const scenario of selected) {
        process.stdout.write(
          `[${runs.length + 1}/${selected.length * options.runs}] ${scenario.id} ... `,
        );
        const attemptStartedAt = Date.now();
        let run;
        try {
          run = await evaluateRun({
            scenario,
            repetition,
            model: options.model,
            timeoutMs: options.timeoutMs,
            client,
            activeScenarios,
            browserTrace,
            get daemonLog() {
              return daemonLog;
            },
          });
        } catch (error) {
          run = {
            scenarioId: scenario.id,
            scenarioTitle: scenario.title,
            repetition,
            pass: false,
            score: 0,
            checks: [],
            answer: "",
            visitedPageIds: [],
            browserActions: 0,
            totalToolCalls: 0,
            failedToolCalls: 0,
            durationMs: Date.now() - attemptStartedAt,
            usage: null,
            toolCalls: [],
            browserTrace: [],
            error: error.message,
            timeToFirstActionMs: null,
            timeToFirstToolMs: null,
            timeToFirstTextMs: null,
            totalToolDurationMs: 0,
            audits: 0,
            repairs: 0,
            verdicts: [],
          };
        }
        runs.push(run);
        console.log(
          `${run.pass ? "PASS" : "FAIL"} score=${percent(run.score)} actions=${run.browserActions} time=${seconds(run.durationMs)}`,
        );
      }
    }
  } finally {
    client.close();
    daemon.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => daemon.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
    await closeServer(sandbox);
    rmSync(dataDir, { recursive: true, force: true });
  }

  const baselinePath = options.compare
    ? resolve(root, options.compare)
    : null;
  const baseline = baselinePath
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : null;
  const createdAt = new Date().toISOString();
  const benchmarkWallTimeMs = Date.now() - benchmarkStartedAt;
  const summary = {
    ...summarize(runs, selected),
    benchmarkWallTimeMs,
    benchmarkTasksPerMinute:
      benchmarkWallTimeMs > 0 ? (runs.length * 60_000) / benchmarkWallTimeMs : 0,
  };
  const result = {
    schemaVersion: 1,
    label: options.label,
    createdAt,
    model: options.model,
    providerBaseUrl: options.baseUrl,
    repetitions: options.runs,
    scenarioIds: selected.map((scenario) => scenario.id),
    repository: repositoryIdentity(),
    evaluator: evaluatorIdentity(),
    environment: { node: process.version, platform: process.platform },
    summary,
    runs,
  };
  const paths = saveResult(result, baseline);
  printResultSummary(result, baseline, paths);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
