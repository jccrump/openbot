import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "packages/core/package.json"));
const { WebSocket } = require("ws");

const query = process.argv
  .slice(2)
  .filter((argument) => argument !== "--")
  .join(" ")
  .trim();
if (!query) {
  console.error("usage: pnpm browser:reset -- <agent name or id>");
  process.exit(1);
}

const daemonPort = Number(process.env.OPENBOT_PORT ?? 4170);
const sandboxUrl = (
  process.env.OPENBOT_SANDBOX_URL ?? "http://127.0.0.1:4171"
).replace(/\/+$/, "");

function listBots() {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`);
    const timer = setTimeout(() => {
      socket.terminate();
      rejectPromise(new Error("timed out talking to the daemon"));
    }, 5_000);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "hello", client: "browser-reset" }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "hello") {
        clearTimeout(timer);
        socket.close();
        resolvePromise(message.bots);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

let bots;
try {
  bots = await listBots();
} catch (error) {
  console.error(`could not reach the daemon: ${error.message}`);
  process.exit(1);
}

const matches = bots.filter(
  (bot) =>
    bot.id === query || bot.name.toLowerCase() === query.toLowerCase(),
);
if (matches.length === 0) {
  console.error(`no agent matches "${query}"`);
  if (bots.length > 0) {
    console.error(`agents: ${bots.map((bot) => bot.name).join(", ")}`);
  }
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`multiple agents match "${query}"; use the agent id instead`);
  process.exit(1);
}

const bot = matches[0];
if (bot.computer === "mac") {
  console.error("This Mac agents have no browser profile");
  process.exit(1);
}

const response = await fetch(
  `${sandboxUrl}/vms/${encodeURIComponent(bot.id)}/browser/reset`,
  { method: "POST" },
);
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(
    `reset failed (HTTP ${response.status}): ${body.error ?? "unknown error"}`,
  );
  process.exit(1);
}

console.log(`browser profile reset for ${bot.name} (${bot.id})`);
if (body.backup) {
  console.log(`previous profile kept at ${body.backup}`);
}
console.log(
  "the next browser action starts a clean browser; cookies and sign-ins are gone",
);
