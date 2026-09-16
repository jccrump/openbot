import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "openbot-smoke-"));

function readBody(request) {
  return new Promise((resolvePromise) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolvePromise(body));
  });
}

const mockModelServer = createServer(async (request, response) => {
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }],
      }),
    );
    return;
  }
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404);
    response.end();
    return;
  }
  const parsed = JSON.parse(await readBody(request));
  const messages = parsed.messages ?? [];
  const last = messages[messages.length - 1];

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const write = (payload) => {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const finish = () => {
    write({ choices: [{ delta: {}, finish_reason: "stop" }] });
    response.write("data: [DONE]\n\n");
    response.end();
  };

  const wantsTool =
    Array.isArray(parsed.tools) &&
    last?.role === "user" &&
    typeof last.content === "string" &&
    last.content.startsWith("run:");

  if (wantsTool) {
    const command = last.content.slice(4).trim();
    const args = JSON.stringify({ command });
    write({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_mock_1",
                type: "function",
                function: { name: "shell", arguments: args.slice(0, 5) },
              },
            ],
          },
        },
      ],
    });
    write({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }],
          },
        },
      ],
    });
    write({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  if (last?.role === "tool") {
    write({
      choices: [
        { delta: { content: `Done. ${String(last.content).split("\n")[0]}` } },
      ],
    });
    finish();
    return;
  }

  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  write({
    choices: [{ delta: { content: `Mock reply to: ${lastUser?.content ?? ""}` } }],
  });
  finish();
});

const SCREEN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const executedCommands = [];
const mockSandboxServer = createServer(async (request, response) => {
  const url = request.url ?? "";
  response.setHeader("content-type", "application/json");

  if (url === "/health") {
    response.end(JSON.stringify({ ok: true, vms: 1 }));
    return;
  }

  const rawBody = request.method === "POST" ? await readBody(request) : "";
  const body = rawBody ? JSON.parse(rawBody) : {};

  if (url.endsWith("/ensure") || url.endsWith("/status")) {
    response.end(
      JSON.stringify({
        botId: "bot",
        state: "running",
        cid: 3,
        bootedAt: new Date().toISOString(),
        error: null,
      }),
    );
    return;
  }

  if (url.endsWith("/exec")) {
    if (
      typeof body.command === "string" &&
      body.command.includes("openbot-browser.js")
    ) {
      const action = body.command.includes("screenshot")
        ? { screenshot: SCREEN_PNG.toString("base64") }
        : {};
      response.end(
        JSON.stringify({
          exit: 0,
          stdout: JSON.stringify({
            ok: true,
            url: "about:blank",
            title: "",
            ...action,
          }),
          stderr: "",
          durationMs: 5,
        }),
      );
      return;
    }
    executedCommands.push(body.command);
    if (body.command === "uname -a") {
      response.end(
        JSON.stringify({
          exit: 0,
          stdout: "Linux mockvm 5.10.239 aarch64 GNU/Linux\n",
          stderr: "",
          durationMs: 7,
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({ exit: 1, stdout: "", stderr: "unexpected command", durationMs: 3 }),
    );
    return;
  }

  response.statusCode = 404;
  response.end("{}");
});

const modelPort = await new Promise((resolvePromise) => {
  mockModelServer.listen(0, "127.0.0.1", () => {
    const address = mockModelServer.address();
    resolvePromise(typeof address === "object" && address ? address.port : 0);
  });
});
const sandboxPort = await new Promise((resolvePromise) => {
  mockSandboxServer.listen(0, "127.0.0.1", () => {
    const address = mockSandboxServer.address();
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
          models: ["deepseek-v4-flash"],
        },
      ],
      defaultModel: { provider: "deepseek", model: "deepseek-v4-flash" },
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
      OPENBOT_SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
      MOCK_API_KEY: "smoke-test-key",
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
  process.stdout.write(`[daemon] ${data}`);
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

  const waitFor = (type, timeoutMs = 10000) =>
    new Promise((resolvePromise, rejectPromise) => {
      const start = received.length;
      const check = () => {
        for (let index = start; index < received.length; index += 1) {
          if (received[index].type === type) {
            cleanup();
            resolvePromise(received[index]);
            return;
          }
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        rejectPromise(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      const waiter = () => check();
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
      };
      waiters.add(waiter);
      check();
    });

  socket.send(JSON.stringify({ type: "hello", client: "smoke" }));
  const hello = await waitFor("hello");
  assert.equal(hello.bots.length, 1, "expected one seeded bot");
  assert.equal(hello.providers[0].id, "deepseek");
  assert.ok(hello.presets.length >= 5, "expected provider presets");
  assert.equal(hello.requireApproval, true);
  const botId = hello.bots[0].id;

  socket.send(JSON.stringify({ type: "chat.send", botId, text: "hello there" }));
  const textDone = await waitFor("chat.done");
  assert.match(textDone.message.content, /Mock reply to: hello there/);
  assert.equal(textDone.message.toolCalls, null);

  socket.send(
    JSON.stringify({ type: "chat.send", botId, text: "run: uname -a" }),
  );
  const approval = await waitFor("approval.request");
  assert.equal(approval.name, "shell");
  assert.match(approval.arguments, /uname -a/);
  socket.send(
    JSON.stringify({
      type: "approval.respond",
      requestId: approval.requestId,
      decision: "approve",
    }),
  );
  const toolResult = await waitFor("tool.result");
  assert.equal(toolResult.ok, true);
  assert.match(toolResult.output, /exit code: 0/);
  assert.match(toolResult.output, /Linux mockvm/);
  const approvedDone = await waitFor("chat.done");
  assert.equal(approvedDone.message.toolCalls.length, 1);
  assert.equal(approvedDone.message.toolCalls[0].name, "shell");
  assert.equal(approvedDone.message.toolCalls[0].ok, true);
  assert.deepEqual(executedCommands, ["uname -a"]);

  socket.send(JSON.stringify({ type: "thread.list" }));
  const threadList = await waitFor("threads");
  assert.equal(threadList.threads.length, 1, "each bot owns a single thread");
  assert.equal(threadList.threads[0].botId, botId);
  assert.equal(threadList.threads[0].id, approvedDone.threadId);

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId,
      threadId: approvedDone.threadId,
      text: "run: rm -rf /",
    }),
  );
  const deniedApproval = await waitFor("approval.request");
  socket.send(
    JSON.stringify({
      type: "approval.respond",
      requestId: deniedApproval.requestId,
      decision: "deny",
    }),
  );
  const deniedResult = await waitFor("tool.result");
  assert.equal(deniedResult.ok, false);
  assert.match(deniedResult.output, /denied/);
  const deniedDone = await waitFor("chat.done");
  assert.equal(deniedDone.message.toolCalls[0].ok, false);
  assert.deepEqual(executedCommands, ["uname -a"], "denied command must not run");

  socket.send(
    JSON.stringify({ type: "thread.messages", threadId: approvedDone.threadId }),
  );
  const history = await waitFor("thread.messages");
  const assistantWithTools = history.messages.filter(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  assert.equal(assistantWithTools.length, 2, "tool runs persist on assistant messages");

  const screenResponse = await fetch(
    `http://127.0.0.1:${daemonPort}/bots/${botId}/screen`,
  );
  assert.equal(screenResponse.status, 200, "screen endpoint should serve a frame");
  assert.equal(screenResponse.headers.get("content-type"), "image/png");
  assert.ok(
    screenResponse.headers.get("x-screen-captured-at"),
    "screen endpoint should report the capture time",
  );
  const screenBytes = Buffer.from(await screenResponse.arrayBuffer());
  assert.ok(
    screenBytes.equals(SCREEN_PNG),
    "screen endpoint should return the captured PNG bytes",
  );

  const unknownScreen = await fetch(
    `http://127.0.0.1:${daemonPort}/bots/nope/screen`,
  );
  assert.equal(unknownScreen.status, 404, "unknown bot has no screen");

  socket.send(
    JSON.stringify({
      type: "bots.create",
      requestId: "bot-local-1",
      name: "Local Tester",
      computer: "mac",
    }),
  );
  const localCreated = await waitFor("bot.created");
  assert.equal(localCreated.bot.computer, "mac");
  const localBotId = localCreated.bot.id;

  socket.send(
    JSON.stringify({
      type: "bots.update",
      requestId: "bot-update-1",
      botId: localBotId,
      computer: "firecracker",
    }),
  );
  const updatedToVm = await waitFor("bot.updated");
  assert.equal(updatedToVm.bot.computer, "firecracker");

  socket.send(
    JSON.stringify({
      type: "bots.update",
      requestId: "bot-update-2",
      botId: localBotId,
      computer: "mac",
    }),
  );
  const updatedToLocal = await waitFor("bot.updated");
  assert.equal(updatedToLocal.bot.computer, "mac");

  const macScreen = await fetch(
    `http://127.0.0.1:${daemonPort}/bots/${localBotId}/screen`,
  );
  assert.equal(macScreen.status, 409, "This Mac computers have no VM screen");
  const macScreenBody = await macScreen.json();
  assert.equal(macScreenBody.code, "mac");

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId: localBotId,
      text: "run: uname -a",
    }),
  );
  const localApproval = await waitFor("approval.request");
  assert.equal(localApproval.name, "shell");
  socket.send(
    JSON.stringify({
      type: "approval.respond",
      requestId: localApproval.requestId,
      decision: "approve",
    }),
  );
  const localResult = await waitFor("tool.result");
  assert.equal(localResult.ok, true);
  assert.match(localResult.output, /\[local Mac\]/);
  assert.match(localResult.output, /exit code: 0/);
  if (process.platform === "darwin") {
    assert.match(localResult.output, /Darwin/);
  }
  const localDone = await waitFor("chat.done");
  assert.equal(localDone.message.toolCalls[0].name, "shell");
  assert.deepEqual(
    executedCommands,
    ["uname -a"],
    "local-mode commands must run on the host, not in the sandbox",
  );

  socket.send(
    JSON.stringify({
      type: "settings.update",
      settings: { requireApproval: false },
    }),
  );
  await waitFor("providers.updated");

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId: localBotId,
      text: "run: echo forced-approval",
    }),
  );
  const forcedApproval = await waitFor("approval.request");
  assert.equal(forcedApproval.name, "shell");
  socket.send(
    JSON.stringify({
      type: "approval.respond",
      requestId: forcedApproval.requestId,
      decision: "deny",
    }),
  );
  const forcedDenied = await waitFor("tool.result");
  assert.equal(forcedDenied.ok, false);
  assert.match(forcedDenied.output, /denied/);
  await waitFor("chat.done");

  socket.send(
    JSON.stringify({
      type: "settings.update",
      settings: { requireApproval: true },
    }),
  );
  await waitFor("providers.updated");

  socket.send(
    JSON.stringify({
      type: "provider.upsert",
      provider: {
        label: "Local Test",
        baseUrl: `http://127.0.0.1:${modelPort}`,
        apiKey: "local-test-key",
        models: [],
      },
    }),
  );
  const afterUpsert = await waitFor("providers.updated");
  const added = afterUpsert.providers.find(
    (provider) => provider.label === "Local Test",
  );
  assert.ok(added, "provider should be added");
  assert.equal(added.hasApiKey, true);

  socket.send(
    JSON.stringify({
      type: "provider.fetchModels",
      requestId: "fetch-1",
      providerId: added.id,
      baseUrl: added.baseUrl,
    }),
  );
  const models = await waitFor("provider.models");
  assert.equal(models.ok, true);
  assert.deepEqual(models.models, ["deepseek-v4-flash", "deepseek-v4-pro"]);

  socket.send(
    JSON.stringify({
      type: "settings.update",
      settings: { defaultModel: { provider: added.id, model: "deepseek-v4-pro" } },
    }),
  );
  const afterSettings = await waitFor("providers.updated");
  assert.deepEqual(afterSettings.defaultModel, {
    provider: added.id,
    model: "deepseek-v4-pro",
  });

  socket.send(
    JSON.stringify({ type: "provider.remove", id: added.id }),
  );
  const afterRemove = await waitFor("providers.updated");
  assert.equal(
    afterRemove.providers.some((provider) => provider.id === added.id),
    false,
    "provider should be removed",
  );
  assert.equal(
    afterRemove.defaultModel.provider,
    "deepseek",
    "default model should fall back after removal",
  );

  socket.send(
    JSON.stringify({
      type: "chat.send",
      botId,
      text: "this should fail",
      model: { provider: "nope", model: "m" },
    }),
  );
  const error = await waitFor("chat.error");
  assert.match(error.message, /unknown provider: nope/);

  console.log(
    `SMOKE OK — text chat, single thread per bot, approved shell tool (${executedCommands[0]}), denied command, persistence, local-computer bot (host exec, forced approvals, bots.update), provider CRUD, settings, error path`,
  );
} finally {
  socket?.close();
  daemon.kill("SIGTERM");
  mockModelServer.close();
  mockSandboxServer.close();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  rmSync(dataDir, { recursive: true, force: true });
}
