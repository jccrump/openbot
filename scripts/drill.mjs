import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const requireFromCore = createRequire(
  join(import.meta.dirname, "../packages/core/package.json"),
);
const { WebSocket } = requireFromCore("ws");

const PORT = Number(process.env.DRILL_PORT ?? 4180);
const URL = `ws://127.0.0.1:${PORT}/ws`;
const TASK_TIMEOUT_MS = Number(process.env.DRILL_TASK_TIMEOUT_MS ?? 8 * 60_000);
const REPORT_PATH = process.env.DRILL_REPORT ?? "/tmp/openbot-drill/report.json";

const DEFAULT_TASKS = [
  "Find the current price of a Game Boy Color at three different stores and tell me which is cheapest.",
  "Download https://raw.githubusercontent.com/plotly/datasets/master/2014_usa_states.csv, find the 3 states with the highest population, and write them to a file called top-states.txt in your workspace.",
  "Write a Python script that prints the first 20 prime numbers, run it, and show me the output.",
  "Open Wikipedia, use the site's search box to search for mechanical keyboard, open the article, and list the first three keyboard brands mentioned.",
  "Take a screenshot of your desktop, then open the file manager and show me what is in your home folder.",
  "Check your disk usage and memory, then tell me whether you have enough space to store a 2 GB file.",
];

const DENY_PATTERNS = [
  /\brm\s+-rf\s+\/(?!tmp|root\/workspace)/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
  /:\(\)\s*\{/,
];

function tasksFromArgv() {
  const file = process.argv[2];
  if (!file) {
    return DEFAULT_TASKS;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((task) => typeof task !== "string")) {
    throw new Error("task file must be a JSON array of strings");
  }
  return parsed;
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(URL);
    const received = [];
    const waiters = new Set();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      received.push(message);
      for (const wake of waiters) {
        wake();
      }
    });
    socket.addEventListener("error", reject);
    socket.addEventListener("open", () => {
      const waitFor = (predicate, timeoutMs, label) =>
        new Promise((resolveWait, rejectWait) => {
          const start = received.length;
          const check = () => {
            for (let index = start; index < received.length; index += 1) {
              if (predicate(received[index])) {
                cleanup();
                resolveWait(received[index]);
                return;
              }
            }
          };
          const timer = setTimeout(() => {
            cleanup();
            rejectWait(new Error(`timeout waiting for ${label}`));
          }, timeoutMs);
          const wake = () => check();
          const cleanup = () => {
            clearTimeout(timer);
            waiters.delete(wake);
          };
          waiters.add(wake);
          check();
        });
      resolve({
        socket,
        received,
        waitFor,
        send(message) {
          socket.send(JSON.stringify(message));
        },
        mark() {
          return received.length;
        },
        since(index) {
          return received.slice(index);
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

function preview(value, length = 160) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .slice(0, length);
}

async function main() {
  const tasks = tasksFromArgv();
  const client = await connect();
  client.send({ type: "hello", client: "drill" });
  await client.waitFor((message) => message.type === "hello", 15_000, "hello");

  const requestId = `drill-bot-${randomUUID()}`;
  client.send({
    type: "bots.create",
    requestId,
    name: `Drill ${new Date().toISOString().slice(11, 19)}`,
    model: { provider: "deepseek", model: "deepseek-v4-flash" },
  });
  const created = await client.waitFor(
    (message) => message.type === "bot.created" && message.requestId === requestId,
    20_000,
    "bot.created",
  );
  const botId = created.bot.id;
  console.log(`drill bot: ${botId}`);

  const report = { botId, tasks: [] };

  for (const [index, task] of tasks.entries()) {
    console.log(`\n=== task ${index + 1}/${tasks.length}: ${task}`);
    const startedAt = Date.now();
    const mark = client.mark();
    let status = "done";
    let answer = "";
    let error = null;

    client.send({ type: "chat.send", botId, text: task });

    const deadline = Date.now() + TASK_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        const message = await client.waitFor(
          (candidate) =>
            (candidate.type === "chat.done" && candidate.threadId) ||
            candidate.type === "chat.error" ||
            candidate.type === "approval.request" ||
            candidate.type === "challenge.request",
          deadline - Date.now(),
          "task event",
        );
        if (message.type === "approval.request") {
          const denied = DENY_PATTERNS.some((pattern) =>
            pattern.test(message.arguments),
          );
          console.log(
            `  ${denied ? "DENY" : "approve"} ${message.name}: ${preview(message.arguments, 100)}`,
          );
          client.send({
            type: "approval.respond",
            requestId: message.requestId,
            decision: denied ? "deny" : "approve",
          });
          continue;
        }
        if (message.type === "challenge.request") {
          console.log(`  bot check at ${message.url ?? "unknown"} — skipping`);
          client.send({
            type: "challenge.respond",
            requestId: message.requestId,
            action: "skip",
          });
          continue;
        }
        if (message.type === "chat.done") {
          answer = message.message.content;
          break;
        }
        status = "error";
        error = message.message;
        break;
      }
      if (status === "done" && !answer && Date.now() >= deadline) {
        status = "timeout";
      }
    } catch (caught) {
      status = "timeout";
      error = caught.message;
      client.send({ type: "chat.cancel", runId: "unknown" });
    }

    const events = client.since(mark);
    const calls = [];
    const pending = new Map();
    for (const event of events) {
      if (event.type === "tool.start") {
        pending.set(event.callId, {
          name: event.name,
          arguments: preview(event.arguments, 200),
          at: Date.now(),
        });
      } else if (event.type === "tool.result") {
        const call = pending.get(event.callId) ?? { name: event.name };
        calls.push({
          name: event.name,
          ok: event.ok,
          durationMs: event.durationMs,
          arguments: call.arguments ?? "",
          output: preview(event.output, 200),
        });
      }
    }
    const failures = calls.filter((call) => !call.ok);
    const slow = calls.filter((call) => call.durationMs > 15_000);
    const decisions = events
      .filter((event) => event.type === "chat.decision")
      .map((event) => `${event.kind}: ${event.summary}`);

    console.log(
      `  ${status} in ${Math.round((Date.now() - startedAt) / 1000)}s — ${calls.length} calls, ${failures.length} failed`,
    );
    for (const call of calls) {
      console.log(
        `    ${call.ok ? "ok  " : "FAIL"} ${call.name} ${call.durationMs}ms ${call.arguments.slice(0, 90)}`,
      );
    }
    for (const call of failures) {
      console.log(`    ↳ ${call.output}`);
    }
    if (answer) {
      console.log(`  answer: ${preview(answer, 300)}`);
    }

    report.tasks.push({
      task,
      status,
      durationMs: Date.now() - startedAt,
      calls,
      failures,
      slow,
      decisions,
      answer,
      error,
    });
  }

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nreport: ${REPORT_PATH}`);

  const deleteId = `drill-delete-${randomUUID()}`;
  client.send({ type: "bots.delete", requestId: deleteId, botId });
  await client
    .waitFor(
      (message) => message.type === "bot.deleted" && message.requestId === deleteId,
      20_000,
      "bot.deleted",
    )
    .catch(() => {});
  client.close();
}

main().catch((error) => {
  console.error("drill failed:", error);
  process.exit(1);
});
