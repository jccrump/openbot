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
const CHROME_LOG = "/tmp/openbot-chrome.log";
const LOCK_DEADLINE_MS = 120_000;
const DISPLAY_DEADLINE_MS = 120_000;
const CHROME_START_DEADLINE_MS = 300_000;
const CDP_PROBE_TIMEOUT_MS = 3_000;
const PAGE_TIMEOUT_MS = 60_000;

const DISPLAY = ":99";
const DISPLAY_SOCKET = "/tmp/.X11-unix/X99";
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
      if (!entry.startsWith("chromium-")) {
        continue;
      }
      for (const platform of ["chrome-linux-arm64", "chrome-linux"]) {
        const candidate = `${BROWSERS_ROOT}/${entry}/${platform}/chrome`;
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

async function waitForDisplay() {
  const deadline = Date.now() + DISPLAY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(DISPLAY_SOCKET)) {
      return;
    }
    await sleep(200);
  }
  throw new Error("X display did not become ready");
}

function cdpAlive() {
  return new Promise((resolve) => {
    const request = http.get(
      `${CDP_URL}/json/version`,
      { timeout: CDP_PROBE_TIMEOUT_MS },
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
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch {
      try {
        const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
        if (age > LOCK_DEADLINE_MS) {
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

function spawnChrome() {
  const binary = findChromeBinary();
  const logFd = fs.openSync(CHROME_LOG, "a");
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-backgrounding-occluded-windows",
      "--password-store=basic",
      "--use-mock-keychain",
      "--window-position=0,0",
      "--window-size=1280,800",
      "--start-maximized",
      "about:blank",
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, DISPLAY },
    },
  );
  fs.closeSync(logFd);
  child.unref();
  return child;
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
    await waitForDisplay();
    const deadline = Date.now() + CHROME_START_DEADLINE_MS;
    while (Date.now() < deadline) {
      const child = spawnChrome();
      let exited = false;
      child.on("exit", () => {
        exited = true;
      });
      while (Date.now() < deadline) {
        if (await cdpAlive()) {
          return;
        }
        if (exited) {
          break;
        }
        await sleep(1000);
      }
      if (Date.now() >= deadline) {
        break;
      }
      log("chrome exited during startup; restarting it");
      killStaleChrome();
      await sleep(1000);
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

  let session = null;
  let opening = null;

  const openSession = async () => {
    await ensureChrome();
    const opened = await connect();
    session = opened;
    log("ready");
    return opened;
  };

  const getSession = async () => {
    if (session) {
      return session;
    }
    if (!opening) {
      opening = openSession().finally(() => {
        opening = null;
      });
    }
    return opening;
  };

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
        const current = await getSession();
        const result = await performAction(current.page, action);
        response = { ok: true, ...result };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        response = { ok: false, error: message };
        if (/Target closed|Browser closed|disconnected|Protocol error/i.test(message)) {
          session = null;
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
  log("listening");
  getSession().catch((error) => {
    log(`chrome warm-up failed: ${error && error.message ? error.message : error}`);
  });
}

function callDaemon(payload, waitMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + waitMs;
    const attempt = () => {
      const socket = net.connect(SOCKET_PATH);
      let buffer = "";
      let connected = false;
      const timer = setTimeout(() => {
        socket.destroy();
        const error = new Error("timeout talking to the browser daemon");
        error.daemonReachable = connected;
        reject(error);
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
        error.daemonReachable = connected;
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
  } catch (error) {
    if (error && error.daemonReachable) {
      response = {
        ok: false,
        error: error.message ? error.message : String(error),
      };
    } else {
      response = await runInline(payload);
    }
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
