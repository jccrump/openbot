#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const { execFileSync } = require("node:child_process");

const BROWSER_RUNTIME =
  process.env.OPENBOT_BROWSER_RUNTIME || "/opt/openbot-browser";
const BROWSERS_ROOT = `${BROWSER_RUNTIME}/browsers`;
const PLAYWRIGHT_CORE = `${BROWSER_RUNTIME}/node_modules/playwright-core`;
const SOCKET_PATH = process.env.OPENBOT_BROWSER_SOCKET || "/tmp/openbot-browser.sock";
const USER_DATA_DIR =
  process.env.OPENBOT_BROWSER_PROFILE || "/root/.openbot-firefox";
const HEADLESS = process.env.OPENBOT_BROWSER_HEADLESS === "1";
const DISPLAY_NAME = process.env.OPENBOT_BROWSER_DISPLAY || ":99";
const BROWSER_ENGINE =
  process.env.OPENBOT_BROWSER_ENGINE === "chromium" ? "chromium" : "firefox";
const MAX_TEXT = 8000;
const MAX_OBSERVATION_TEXT = 6000;
const DISPLAY_DEADLINE_MS = 10_000;
const BROWSER_START_TIMEOUT_MS = Number(
  process.env.OPENBOT_BROWSER_START_TIMEOUT_MS || 30_000,
);
const PAGE_TIMEOUT_MS = 30_000;
const DAEMON_ACTION_TIMEOUT_MS = 70_000;

const MODE = process.argv[2] === "serve" ? "serve" : "action";

function log(message) {
  console.error(`[openbot-browser] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFirefoxBinary() {
  try {
    for (const entry of fs.readdirSync(BROWSERS_ROOT)) {
      if (!entry.startsWith("firefox-")) {
        continue;
      }
      const candidate = `${BROWSERS_ROOT}/${entry}/firefox/firefox`;
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // fall through to Playwright's Firefox executable
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_ROOT;
  const { firefox } = require(PLAYWRIGHT_CORE);
  return firefox.executablePath();
}

function findChromiumBinary() {
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
    // fall through to Playwright's Chromium executable
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_ROOT;
  const { chromium } = require(PLAYWRIGHT_CORE);
  return chromium.executablePath();
}

async function waitForDisplay() {
  const deadline = Date.now() + DISPLAY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (DISPLAY_NAME.startsWith(":")) {
      const displayNumber = Number.parseInt(DISPLAY_NAME.slice(1), 10);
      if (
        Number.isInteger(displayNumber) &&
        fs.existsSync(`/tmp/.X11-unix/X${displayNumber}`)
      ) {
        return;
      }
    } else {
      const match = /^(.*):(\d+)$/.exec(DISPLAY_NAME);
      if (match && (await tcpReachable(match[1], 6000 + Number(match[2])))) {
        return;
      }
    }
    await sleep(100);
  }
  throw new Error(`X display ${DISPLAY_NAME} did not become ready`);
}

function tcpReachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function killStaleBrowser() {
  try {
    execFileSync("pkill", ["-TERM", "-f", USER_DATA_DIR], {
      stdio: "ignore",
    });
  } catch {
    // nothing to kill
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      execFileSync("pgrep", ["-f", USER_DATA_DIR], {
        stdio: "ignore",
      });
    } catch {
      return;
    }
    execFileSync("sleep", ["0.15"]);
  }
  try {
    execFileSync("pkill", ["-KILL", "-f", USER_DATA_DIR], {
      stdio: "ignore",
    });
  } catch {
    // already gone
  }
}

function clearProfileLock() {
  for (const name of [".parentlock", "lock"]) {
    try {
      fs.rmSync(`${USER_DATA_DIR}/${name}`, { force: true });
    } catch {
      // best effort
    }
  }
}

async function launchSession() {
  const startedAt = Date.now();
  if (!HEADLESS) {
    await waitForDisplay();
  }
  killStaleBrowser();
  clearProfileLock();
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_ROOT;
  const playwright = require(PLAYWRIGHT_CORE);
  const browserType = playwright[BROWSER_ENGINE];
  const binary =
    BROWSER_ENGINE === "chromium" ? findChromiumBinary() : findFirefoxBinary();
  log(`launching ${binary}`);
  let context;
  try {
    context = await browserType.launchPersistentContext(USER_DATA_DIR, {
      executablePath: binary,
      headless: HEADLESS,
      ...(BROWSER_ENGINE === "chromium" ? { chromiumSandbox: true } : {}),
      viewport: HEADLESS ? { width: 1280, height: 800 } : null,
      timeout: BROWSER_START_TIMEOUT_MS,
      env: {
        ...process.env,
        ...(HEADLESS ? {} : { DISPLAY: DISPLAY_NAME }),
        LIBGL_ALWAYS_SOFTWARE: "1",
        MOZ_AVOID_OPENGL_ALTOGETHER: "1",
      },
      args:
        BROWSER_ENGINE === "chromium"
          ? [
              "--disable-gpu",
              "--disable-dev-shm-usage",
              "--hide-crash-restore-bubble",
              "--window-size=1280,800",
            ]
          : HEADLESS
            ? []
            : ["--width=1280", "--height=800"],
      ...(BROWSER_ENGINE === "firefox"
        ? {
            firefoxUserPrefs: {
              "browser.shell.checkDefaultBrowser": false,
              "browser.startup.page": 0,
              "browser.tabs.warnOnClose": false,
              "gfx.webrender.all": false,
              "gfx.webrender.software": true,
              "layers.acceleration.disabled": true,
              "media.hardware-video-decoding.enabled": false,
              "webgl.disabled": true,
            },
          }
        : {}),
    });
  } catch (error) {
    killStaleBrowser();
    clearProfileLock();
    const message = error && error.message ? error.message : String(error);
    log(`launch failed after ${Date.now() - startedAt}ms: ${message}`);
    throw new Error(
      `browser unavailable: ${BROWSER_ENGINE} did not become ready within ${Math.round(BROWSER_START_TIMEOUT_MS / 1000)} seconds. The failed process was cleaned up; do not retry this browser action in the same turn.`,
    );
  }
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  log(`ready in ${Date.now() - startedAt}ms`);
  return { context, page };
}

async function performAction(page, action) {
  const observe = async (maxLength = MAX_OBSERVATION_TEXT) => {
    try {
      const text = await page.innerText("body");
      return text.slice(0, maxLength);
    } catch {
      return "";
    }
  };
  const pageState = async () => ({
    url: page.url(),
    title: await page.title(),
    text: await observe(),
  });
  const settle = async () => {
    await page
      .waitForLoadState("domcontentloaded", { timeout: 2_000 })
      .catch(() => {});
    await page.waitForTimeout(150);
  };

  switch (action.action) {
    case "goto": {
      await page.goto(action.url, { waitUntil: "domcontentloaded" });
      return pageState();
    }
    case "back": {
      await page.goBack({ waitUntil: "domcontentloaded" });
      return pageState();
    }
    case "click": {
      await page.click(action.selector);
      await settle();
      return pageState();
    }
    case "type": {
      await page.fill(action.selector, action.text ?? "");
      if (action.submit) {
        await page.keyboard.press("Enter");
        await settle();
      }
      return pageState();
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
      return pageState();
    }
    case "links": {
      const root = action.selector
        ? page.locator(action.selector)
        : page.locator("body");
      const links = await root.locator("a[href]").evaluateAll((elements) =>
        elements
          .map((element) => ({
            text: (element.innerText || element.getAttribute("aria-label") || "")
              .replace(/\s+/g, " ")
              .trim(),
            href: element.href,
          }))
          .filter((link) => link.href && link.text)
          .slice(0, 100),
      );
      return {
        url: page.url(),
        title: await page.title(),
        text: links
          .map((link) => `${link.text} — ${link.href}`)
          .join("\n")
          .slice(0, MAX_TEXT),
      };
    }
    case "screenshot": {
      const buffer = await page.screenshot({ type: "png", timeout: 15_000 });
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
    const opened = await launchSession();
    session = opened;
    opened.context.on("close", () => {
      if (session?.context === opened.context) {
        session = null;
      }
      log("browser context closed");
    });
    return opened;
  };

  const resetSession = async (reason) => {
    const current = session;
    session = null;
    if (current) {
      try {
        await Promise.race([current.context.close(), sleep(3_000)]);
      } catch {
        // The process cleanup below is authoritative.
      }
    }
    killStaleBrowser();
    clearProfileLock();
    log(`session reset: ${reason}`);
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

  let queue = Promise.resolve();

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) {
          continue;
        }
        queue = queue.then(async () => {
          let response;
          try {
            const action = JSON.parse(line);
            const current = await getSession();
            const result = await performAction(current.page, action);
            response = { ok: true, ...result };
          } catch (error) {
            const message = error && error.message ? error.message : String(error);
            response = { ok: false, error: message };
            if (
              /browser unavailable|Target closed|Browser closed|disconnected|Protocol error/i.test(
                message,
              )
            ) {
              await resetSession(message.slice(0, 160));
            }
          }
          if (socket.destroyed) {
            return;
          }
          socket.write(JSON.stringify(response) + "\n");
        });
      }
    });
    socket.on("error", () => {
      // client went away
    });
  });
  server.listen(SOCKET_PATH);
  log("listening");
  // The browser is started lazily on the first action. A warm-up at boot keeps
  // the whole microVM busy while the desktop is otherwise idle.
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
      }, DAEMON_ACTION_TIMEOUT_MS);

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
  const session = await launchSession();
  try {
    const result = await performAction(session.page, payload);
    return { ok: true, ...result };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    try {
      await session.context.close();
    } catch {
      killStaleBrowser();
    }
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
