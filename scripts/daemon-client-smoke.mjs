/**
 * Regression check for the Mac app's daemon socket lifecycle.
 *
 * A StrictMode/Fast-Refresh remount used to leak a live WebSocket: the stale
 * socket's close event fired after `connect()` had cleared the closed flag, so
 * it scheduled a reconnect while the fresh socket was already open. The daemon
 * broadcasts every event to every live socket, and the app appends each
 * `chat.decision` without dedupe, so one Jev decision rendered once per leaked
 * socket.
 *
 * Run with: pnpm daemon-client:smoke
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DaemonClient } from "../apps/mac/src/lib/daemon.ts";

const root = resolve(import.meta.dirname, "..");
const requireFromCore = createRequire(
  resolve(root, "packages/core/package.json"),
);
const { WebSocketServer } = requireFromCore("ws");

const sleep = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const wss = new WebSocketServer({ port: 0 });
await new Promise((resolvePromise) =>
  wss.once("listening", () => resolvePromise()),
);
const address = wss.address();
assert.ok(address && typeof address === "object", "server should have a port");
const port = address.port;

const client = new DaemonClient(`ws://127.0.0.1:${port}/ws`);
let decisions = 0;
client.onMessage((message) => {
  if (message.type === "chat.decision") {
    decisions += 1;
  }
});

const decision = {
  type: "chat.decision",
  runId: "run-1",
  threadId: "thread-1",
  messageId: "message-1",
  kind: "route",
  summary: "chat · confidence 0.37",
  flagged: false,
  latencyMs: 469,
  model: "jev-1.13.0",
};

const broadcast = () => {
  for (const socket of wss.clients) {
    socket.send(JSON.stringify(decision));
  }
};

// StrictMode mounts, cleans up, then mounts again in the same tick.
client.connect();
await sleep(30);
client.disconnect();
client.connect();
await sleep(2_500);
assert.equal(
  wss.clients.size,
  1,
  "a StrictMode remount must leave exactly one live socket",
);

// Fast Refresh repeats that cleanup/setup cycle on every edit.
for (let cycle = 1; cycle <= 3; cycle += 1) {
  client.disconnect();
  client.connect();
  await sleep(2_500);
  assert.equal(
    wss.clients.size,
    1,
    `remount ${cycle} must leave exactly one live socket`,
  );
}

// One daemon broadcast must reach the listener exactly once.
decisions = 0;
broadcast();
await sleep(300);
assert.equal(decisions, 1, "one broadcast must deliver one decision");

client.disconnect();
assert.equal(client.status, "disconnected", "disconnect should update status");
for (const socket of wss.clients) {
  socket.terminate();
}
wss.close();
console.log("daemon client smoke ok");
