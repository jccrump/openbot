// Live check for the browser_execute network egress guard (not part of the
// smoke suite: it needs the real daemon, the real sandbox, and a real model).
// Usage: node scripts/egress-live.mjs
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "packages/core/package.json"));
const { WebSocket } = require("ws");

const daemonPort = Number(process.env.OPENBOT_PORT ?? 4170);
const agentName = process.env.EGRESS_LEAD ?? "Test Agent";

const socket = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`);
const messages = [];
const waiters = [];

socket.on("message", (raw) => {
  messages.push(JSON.parse(String(raw)));
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];
    const at = messages.findIndex((message) => message.type === waiter.type);
    if (at === -1) {
      continue;
    }
    const [found] = messages.splice(at, 1);
    waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(found);
  }
});

function waitFor(type, timeoutMs = 180_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const at = messages.findIndex((message) => message.type === type);
    if (at !== -1) {
      const [found] = messages.splice(at, 1);
      resolvePromise(found);
      return;
    }
    const waiter = { type, resolve: resolvePromise, timer: null };
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
      }
      rejectPromise(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

await new Promise((resolvePromise) => socket.on("open", resolvePromise));
socket.send(JSON.stringify({ type: "hello", client: "egress-live" }));
const hello = await waitFor("hello");
const agent = hello.bots.find((bot) => bot.name === agentName) ?? hello.bots[0];
if (!agent) {
  throw new Error("no agent bot found");
}
console.log(`agent: ${agent.name} (${agent.id})`);

const setPolicy = (policy) =>
  new Promise((resolvePromise) => {
    socket.send(JSON.stringify({ type: "settings.update", settings: { policy } }));
    resolvePromise();
  });

const ask = async (text) => {
  socket.send(JSON.stringify({ type: "chat.send", botId: agent.id, text }));
  const approval = await waitFor("approval.request");
  socket.send(
    JSON.stringify({
      type: "approval.respond",
      requestId: approval.requestId,
      decision: "approve",
    }),
  );
  const result = await waitFor("tool.result");
  await waitFor("chat.done");
  return result;
};

const results = [];
try {
  await setPolicy({
    timeoutMs: 60_000,
    defaultTier: "inherit",
    tools: {},
    rules: [],
    egress: { mode: "deny", allow: ["example.com"] },
  });
  await waitFor("providers.updated");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

  const blocked = await ask(
    "Use browser_execute with this exact code and nothing else:\n" +
      "await session.Page.navigate({url:'https://example.com'});\n" +
      "await new Promise(r=>setTimeout(r,1200));\n" +
      "const r = await session.Runtime.evaluate({expression:\"fetch('https://news.ycombinator.com').then(x=>'status '+x.status).catch(e=>'fetch failed: '+e.message)\", returnByValue:true, awaitPromise:true});\n" +
      "return r.result.value;",
  );
  results.push({ name: "blocked fetch", output: blocked.output.slice(0, 300) });

  const allowed = await ask(
    "Use browser_execute with this exact code and nothing else:\n" +
      "await session.Page.navigate({url:'https://example.com'});\n" +
      "await new Promise(r=>setTimeout(r,1200));\n" +
      "const r = await session.Runtime.evaluate({expression:\"fetch('https://example.com').then(x=>'status '+x.status).catch(e=>'fetch failed: '+e.message)\", returnByValue:true, awaitPromise:true});\n" +
      "return r.result.value;",
  );
  results.push({ name: "allowed fetch", output: allowed.output.slice(0, 300) });
} finally {
  await setPolicy({
    timeoutMs: 60_000,
    defaultTier: "inherit",
    tools: {},
    rules: [],
    egress: { mode: "off", allow: [] },
  });
  await waitFor("providers.updated").catch(() => {});
  socket.close();
}

for (const result of results) {
  console.log(`\n== ${result.name} ==\n${result.output}`);
}
const blockedOk = /fetch failed|AccessDenied|not in the browser egress allowlist/i.test(
  results[0]?.output ?? "",
);
const allowedOk = /status 200/.test(results[1]?.output ?? "");
console.log(`\nblocked-as-expected: ${blockedOk}`);
console.log(`allowed-as-expected: ${allowedOk}`);
process.exit(blockedOk && allowedOk ? 0 : 1);
