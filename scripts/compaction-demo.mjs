import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "openbot-compaction-"));
const modelRef = { provider: "deepseek", model: "deepseek-v4-flash" };
const threshold = 32000;
const seedTurns = 60;
const longContext =
  (
    "Keep staging on db.internal.example.com, never rotate the API key " +
    "without notifying the on-call engineer, and finish the export " +
    "pipeline before Friday. "
  ).repeat(25);

function readBody(request) {
  return new Promise((resolvePromise) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolvePromise(body));
  });
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamReply(response, parsed, text) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  writeSse(response, { choices: [{ delta: { content: text } }] });
  writeSse(response, {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: Math.ceil(JSON.stringify(parsed.messages).length / 4),
      completion_tokens: Math.ceil(text.length / 4),
    },
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function overflowResponse(response) {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 32768 tokens. " +
          "Please reduce the length of the messages.",
        code: "context_length_exceeded",
      },
    }),
  );
}

const overflowCalls = new Map();
const mockModelServer = createServer(async (request, response) => {
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: modelRef.model }] }));
    return;
  }
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404);
    response.end();
    return;
  }

  const parsed = JSON.parse(await readBody(request));
  const messages = parsed.messages ?? [];
  const system = messages[0];
  const isSummarizer =
    system?.role === "system" &&
    typeof system.content === "string" &&
    system.content.includes("compact an ongoing conversation");

  if (isSummarizer) {
    streamReply(
      response,
      parsed,
      "User goals, decisions, constraints (db.internal.example.com, key " +
        "rotation policy), and the unresolved export pipeline task are preserved.",
    );
    return;
  }

  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";

  if (text.startsWith("overflow-always:")) {
    overflowResponse(response);
    return;
  }
  if (text.startsWith("overflow-once:")) {
    const seen = overflowCalls.get(text) ?? 0;
    overflowCalls.set(text, seen + 1);
    if (seen === 0) {
      overflowResponse(response);
      return;
    }
  }

  streamReply(response, parsed, `Mock reply to: ${text}`);
});

const modelPort = await new Promise((resolvePromise) => {
  mockModelServer.listen(0, "127.0.0.1", () => {
    const address = mockModelServer.address();
    resolvePromise(typeof address === "object" && address ? address.port : 0);
  });
});

writeFileSync(
  join(dataDir, "config.json"),
  JSON.stringify(
    {
      port: 0,
      providers: [
        {
          id: "deepseek",
          label: "DeepSeek (mock)",
          kind: "openai-compatible",
          baseUrl: `http://127.0.0.1:${modelPort}`,
          apiKeyEnv: "MOCK_API_KEY",
          models: [modelRef.model],
        },
      ],
      defaultModel: modelRef,
      compaction: { enabled: true, thresholdTokens: threshold },
    },
    null,
    2,
  ),
);

const daemon = spawn(
  process.execPath,
  ["--import", "tsx", "src/bin/openbotd.ts"],
  {
    cwd: join(root, "packages", "core"),
    env: {
      ...process.env,
      OPENBOT_DATA_DIR: dataDir,
      OPENBOT_PORT: "0",
      OPENBOT_SANDBOX_URL: "http://127.0.0.1:1",
      OPENBOT_REQUIRE_APPROVAL: "false",
      MOCK_API_KEY: "compaction-demo-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let resolvePort;
const portPromise = new Promise((resolvePromise) => {
  resolvePort = resolvePromise;
});
let daemonStdout = "";
daemon.stdout.on("data", (data) => {
  daemonStdout += String(data);
  const match = daemonStdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) {
    resolvePort(Number(match[1]));
  }
});
daemon.stderr.on("data", (data) => process.stderr.write(`[daemon] ${data}`));

const daemonPort = await Promise.race([
  portPromise,
  new Promise((_, rejectPromise) =>
    setTimeout(
      () => rejectPromise(new Error("daemon did not report a port")),
      15000,
    ),
  ),
]);

let socket;
try {
  let healthy = false;
  for (let attempt = 0; attempt < 100 && !healthy; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      healthy = response.ok;
    } catch {
      healthy = false;
    }
    if (!healthy) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  assert.ok(healthy, "daemon did not become healthy");

  socket = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`);
  const received = [];
  const waiters = new Set();
  const claimed = new Set();

  socket.addEventListener("message", (event) => {
    received.push(JSON.parse(event.data));
    for (const waiter of [...waiters]) {
      waiter();
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", rejectPromise, { once: true });
  });

  const waitFor = (predicate, label, timeoutMs = 15000) =>
    new Promise((resolvePromise, rejectPromise) => {
      const attempt = () => {
        for (const message of received) {
          if (!claimed.has(message) && predicate(message)) {
            claimed.add(message);
            cleanup();
            resolvePromise(message);
            return;
          }
        }
      };
      const waiter = () => attempt();
      const timer = setTimeout(() => {
        cleanup();
        rejectPromise(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
      };
      waiters.add(waiter);
      attempt();
    });
  const waitForType = (type, timeoutMs) =>
    waitFor((message) => message.type === type, type, timeoutMs);

  socket.send(JSON.stringify({ type: "hello", client: "compaction-demo" }));
  const hello = await waitForType("hello");
  assert.equal(hello.bots.length, 1);
  assert.deepEqual(hello.compaction, {
    enabled: true,
    thresholdTokens: threshold,
  });
  const botId = hello.bots[0].id;

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId,
      text: `seed 0: ${longContext}`,
    }),
  );
  const firstSeed = await waitForType("chat.done");
  const threadId = firstSeed.threadId;
  console.log(
    `seeded thread ${threadId.slice(0, 8)}… (${seedTurns} turns) · threshold ${threshold} · auto compaction enabled`,
  );

  socket.send(
    JSON.stringify({
      type: "settings.update",
      settings: { compaction: { thresholdTokens: 1000000 } },
    }),
  );
  const raised = await waitForType("providers.updated");
  assert.equal(raised.compaction.thresholdTokens, 1000000);

  for (let index = 1; index < seedTurns; index += 1) {
    socket.send(
      JSON.stringify({
        type: "chat.send",
        botId,
        threadId,
        text: `seed ${index}: ${longContext}`,
      }),
    );
    const done = await waitForType("chat.done");
    assert.match(done.message.content, new RegExp(`Mock reply to: seed ${index}:`));
  }
  console.log(`seeded ${seedTurns} long turns without compaction (threshold raised)`);

  socket.send(
    JSON.stringify({
      type: "settings.update",
      settings: { compaction: { thresholdTokens: threshold } },
    }),
  );
  const lowered = await waitForType("providers.updated");
  assert.equal(lowered.compaction.thresholdTokens, threshold);

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId,
      threadId,
      text: "final question: what is the staging database?",
    }),
  );
  const start = await waitFor(
    (message) =>
      message.type === "chat.compaction" &&
      message.status === "start" &&
      message.trigger === "auto",
    "chat.compaction start",
  );
  const compacted = await waitFor(
    (message) =>
      message.type === "chat.compaction" &&
      message.status === "done" &&
      message.trigger === "auto",
    "chat.compaction done",
  );
  assert.equal(compacted.isFirstCompaction, true);
  assert.ok(compacted.messagesToCompact >= 1);
  assert.ok(compacted.tokensBefore >= threshold);
  assert.ok(compacted.tokensAfter < compacted.tokensBefore);
  assert.ok(compacted.summaryMessageId, "done event carries the summary message id");
  const finalDone = await waitForType("chat.done");
  assert.match(finalDone.message.content, /Mock reply to: final question/);
  assert.ok(
    finalDone.message.usage && finalDone.message.usage.inputTokens > 0,
    "assistant message persists provider usage",
  );
  console.log(
    `auto compaction: ${compacted.messagesToCompact} messages folded, tokens ${compacted.tokensBefore} -> ${compacted.tokensAfter}, first=${compacted.isFirstCompaction}`,
  );

  socket.send(JSON.stringify({ type: "thread.messages", threadId }));
  const history = await waitForType("thread.messages");
  const summaries = history.messages.filter((message) => message.compaction);
  assert.equal(summaries.length, 1, "exactly one summary message is active");
  assert.equal(summaries[0].id, compacted.summaryMessageId);
  assert.match(summaries[0].content, /^\[conversation summary\]/);
  assert.equal(
    history.messages.some((message) => message.content.startsWith("seed 0:")),
    false,
    "oldest messages were folded out of the active thread",
  );
  assert.equal(
    history.messages.some((message) => message.content.startsWith("seed 59:")),
    true,
    "recent messages stay verbatim",
  );
  assert.ok(history.messages.length < seedTurns * 2 + 2);
  console.log(
    `active thread: ${history.messages.length} messages (1 summary + recent), oldest seeds folded`,
  );

  socket.send(JSON.stringify({ type: "thread.list" }));
  const threads = await waitForType("threads");
  const threadInfo = threads.threads.find((entry) => entry.id === threadId);
  assert.equal(threadInfo.compactionCount, 1);
  assert.ok(threadInfo.lastCompactedAt, "thread records lastCompactedAt");
  console.log(
    `thread metadata: compactionCount=${threadInfo.compactionCount} lastCompactedAt=${threadInfo.lastCompactedAt}`,
  );

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId,
      threadId,
      text: "still there?",
    }),
  );
  const afterCompaction = await waitForType("chat.done");
  assert.match(afterCompaction.message.content, /Mock reply to: still there\?/);
  console.log("conversation still answers after compaction");

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId,
      threadId,
      text: "overflow-once: continue the plan",
    }),
  );
  const overflowStart = await waitFor(
    (message) =>
      message.type === "chat.compaction" &&
      message.status === "start" &&
      message.trigger === "overflow",
    "overflow compaction start",
  );
  const overflowDone = await waitFor(
    (message) =>
      message.type === "chat.compaction" &&
      message.status === "done" &&
      message.trigger === "overflow",
    "overflow compaction done",
  );
  const overflowRecovered = await waitForType("chat.done");
  assert.match(overflowRecovered.message.content, /Mock reply to: overflow-once/);
  console.log(
    `overflow retry: compacted (${overflowDone.messagesToCompact} messages folded) and the turn succeeded`,
  );

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId,
      threadId,
      text: "overflow-always: keep going",
    }),
  );
  await waitFor(
    (message) =>
      message.type === "chat.compaction" &&
      message.status === "done" &&
      message.trigger === "overflow",
    "second overflow compaction done",
  );
  const terminal = await waitForType("chat.error");
  assert.match(terminal.message, /context window overflow/);
  const terminalStarts = received.filter(
    (message) =>
      message.type === "chat.compaction" &&
      message.status === "start" &&
      message.runId === terminal.runId,
  );
  assert.equal(terminalStarts.length, 1, "overflow must not loop");
  console.log(
    `overflow terminal: "${terminal.message}" (compaction attempted once, no loop)`,
  );

  const verifyDb = new DatabaseSync(join(dataDir, "openbot.db"));
  const folded = verifyDb
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND folded_at IS NOT NULL",
    )
    .get(threadId);
  const usageRow = verifyDb
    .prepare(
      "SELECT input_tokens, output_tokens FROM messages WHERE thread_id = ? AND input_tokens IS NOT NULL LIMIT 1",
    )
    .get(threadId);
  const threadRow = verifyDb
    .prepare(
      "SELECT compaction_count, last_compacted_at FROM threads WHERE id = ?",
    )
    .get(threadId);
  verifyDb.close();
  assert.ok(folded.n >= 1, "folded messages are archived, not deleted");
  assert.ok(usageRow.input_tokens > 0 && usageRow.output_tokens > 0);
  assert.ok(threadRow.compaction_count >= 2);
  assert.ok(threadRow.last_compacted_at);
  console.log(
    `persistence: ${folded.n} folded rows archived, token usage stored, compactionCount=${threadRow.compaction_count}`,
  );

  console.log(
    "COMPACTION DEMO OK — summary message, folded history, chat.compaction events (auto + overflow), usage accounting, terminal overflow error, conversation still answers",
  );
} finally {
  socket?.close();
  daemon.kill("SIGTERM");
  mockModelServer.close();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  rmSync(dataDir, { recursive: true, force: true });
}
