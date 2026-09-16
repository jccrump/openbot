#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");

const BROWSERS_ROOT = "/opt/openbot-browser/browsers";
const PLAYWRIGHT_CORE = "/opt/openbot-browser/node_modules/playwright-core";
const SOCKET_PATH = "/tmp/openbot-browser.sock";
const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const USER_DATA_DIR = "/root/.openbot-chrome";
const MAX_TEXT = 8000;
const LOCK_DIR = "/tmp/openbot-chrome.lock";
const START_DEADLINE_MS = 120_000;
const PAGE_TIMEOUT_MS = 60_000;

const MODE = process.argv[2] === "serve" ? "serve" : "action";

function log(message) {
  console.error(`[openbot-browser] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChromeBinary() {
  try {
    for (const entry of fs.readdirSync(BROWSERS_ROOT)) {
      if (entry.startsWith("chromium_headless_shell-")) {
        const candidate = `${BROWSERS_ROOT}/${entry}/chrome-headless-shell-linux-arm64/chrome-headless-shell`;
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // fall through to playwright's chromium
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_ROOT;
  const { chromium } = require(PLAYWRIGHT_CORE);
  return chromium.executablePath();
}

function cdpAlive() {
  return new Promise((resolve) => {
    const request = http.get(
      `${CDP_URL}/json/version`,
      { timeout: 1000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function withLock(fn) {
  const deadline = Date.now() + START_DEADLINE_MS;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch {
      try {
        const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
        if (age > START_DEADLINE_MS) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished, retry
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the chrome start lock");
      }
      await sleep(500);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

function killStaleChrome() {
  try {
    execFileSync("pkill", ["-f", "remote-debugging-port=9222"], {
      stdio: "ignore",
    });
  } catch {
    // nothing to kill
  }
}

async function ensureChrome() {
  if (await cdpAlive()) {
    return;
  }
  await withLock(async () => {
    if (await cdpAlive()) {
      return;
    }
    killStaleChrome();
    await sleep(500);
    const binary = findChromeBinary();
    const child = spawn(
      binary,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-background-networking",
        "--window-size=1280,800",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    const deadline = Date.now() + START_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (await cdpAlive()) {
        return;
      }
      await sleep(500);
    }
    throw new Error("chromium did not start");
  });
}

async function connect() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_ROOT;
  const { chromium } = require(PLAYWRIGHT_CORE);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  return { browser, page };
}

async function performAction(page, action) {
  switch (action.action) {
    case "goto": {
      await page.goto(action.url, { waitUntil: "domcontentloaded" });
      return { url: page.url(), title: await page.title() };
    }
    case "back": {
      await page.goBack({ waitUntil: "domcontentloaded" });
      return { url: page.url(), title: await page.title() };
    }
    case "click": {
      await page.click(action.selector);
      return { url: page.url(), title: await page.title() };
    }
    case "type": {
      await page.fill(action.selector, action.text ?? "");
      if (action.submit) {
        await page.keyboard.press("Enter");
      }
      return { url: page.url(), title: await page.title() };
    }
    case "text": {
      const text = action.selector
        ? await page.textContent(action.selector)
        : await page.innerText("body");
      return {
        url: page.url(),
        title: await page.title(),
        text: (text ?? "").slice(0, MAX_TEXT),
      };
    }
    case "wait": {
      if (action.selector) {
        await page.waitForSelector(action.selector);
      } else {
        await page.waitForTimeout(Math.min(action.milliseconds ?? 1000, 30_000));
      }
      return { url: page.url(), title: await page.title() };
    }
    case "screenshot": {
      const buffer = await page.screenshot({ type: "png" });
      return {
        url: page.url(),
        title: await page.title(),
        screenshot: buffer.toString("base64"),
      };
    }
    default:
      throw new Error(`unknown action: ${action.action}`);
  }
}

async function serve() {
  try {
    fs.rmSync(SOCKET_PATH, { force: true });
  } catch {
    // ignore
  }
  await ensureChrome();
  let session = await connect();
  log("ready");

  const server = net.createServer((socket) => {
    let buffer = "";
    let busy = false;
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      if (busy) {
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      busy = true;
      let response;
      try {
        const action = JSON.parse(line);
        const result = await performAction(session.page, action);
        response = { ok: true, ...result };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        response = { ok: false, error: message };
        if (/Target closed|Browser closed|disconnected/i.test(message)) {
          try {
            session = await connect();
          } catch {
            // next action will retry
          }
        }
      }
      busy = false;
      socket.write(JSON.stringify(response) + "\n");
    });
    socket.on("error", () => {
      // client went away
    });
  });
  server.listen(SOCKET_PATH);
}

function callDaemon(payload, waitMs = 150_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + waitMs;
    const attempt = () => {
      const socket = net.connect(SOCKET_PATH);
      let buffer = "";
      let connected = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timeout talking to the browser daemon"));
      }, 200_000);

      socket.on("connect", () => {
        connected = true;
        socket.write(JSON.stringify(payload) + "\n");
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        clearTimeout(timer);
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newline)));
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        if (!connected && Date.now() < deadline) {
          setTimeout(attempt, 500);
          return;
        }
        reject(error);
      });
    };
    attempt();
  });
}

async function runInline(payload) {
  await ensureChrome();
  const session = await connect();
  try {
    const result = await performAction(session.page, payload);
    return { ok: true, ...result };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function main() {
  if (MODE === "serve") {
    await serve();
    return;
  }
  const payload = JSON.parse(process.argv[3] || process.argv[2] || "{}");
  let response;
  try {
    response = await callDaemon(payload);
  } catch {
    response = await runInline(payload);
  }
  process.stdout.write(JSON.stringify(response) + "\n", () => {
    process.exit(response.ok ? 0 : 1);
  });
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n", () => {
    process.exit(1);
  });
});
