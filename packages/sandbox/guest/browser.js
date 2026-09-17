#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const { execFileSync, spawn } = require("node:child_process");

const BROWSER_RUNTIME =
  process.env.OPENBOT_BROWSER_RUNTIME || "/opt/openbot-browser";
const BROWSERS_ROOT = `${BROWSER_RUNTIME}/browsers`;
const SOCKET_PATH = process.env.OPENBOT_BROWSER_SOCKET || "/tmp/openbot-browser.sock";
const USER_DATA_DIR =
  process.env.OPENBOT_BROWSER_PROFILE || "/root/.openbot-chromium";
const HEADLESS = process.env.OPENBOT_BROWSER_HEADLESS === "1";
const DISPLAY_NAME = process.env.OPENBOT_BROWSER_DISPLAY || ":99";
const MAX_TEXT = 8000;
const MAX_OBSERVATION_TEXT = 6000;
const DISPLAY_DEADLINE_MS = 10_000;
const BROWSER_START_TIMEOUT_MS = Number(
  process.env.OPENBOT_BROWSER_START_TIMEOUT_MS || 30_000,
);
const PAGE_TIMEOUT_MS = 30_000;
const DAEMON_ACTION_TIMEOUT_MS = 70_000;
const CHALLENGE_WAIT_MS = 8_000;
const CHALLENGE_RETRY_WAIT_MS = 6_000;
const CONTENT_MIN_CHARS = 40;
const CONTENT_SETTLE_MS = 300;
const CONTENT_WAIT_TIMEOUT_MS = 3_500;
const NAVIGATION_WAIT_MS = 1_200;
const SELECTOR_TIMEOUT_MS = 10_000;

const CHALLENGE_TITLE_PATTERNS = [
  /just a moment/i,
  /attention required/i,
  /checking your browser/i,
  /verify you are human/i,
  /one more step/i,
];

const CHALLENGE_TEXT_PATTERNS = [
  /verify you are human/i,
  /checking your browser/i,
  /enable javascript and cookies to continue/i,
  /just a moment/i,
  /complete the security check/i,
];

const CHALLENGE_MARKERS =
  'iframe[src*="challenges.cloudflare.com"], .cf-turnstile, #challenge-form, #challenge-stage, [data-turnstile-widget]';

const MODE = process.argv[2] === "serve" ? "serve" : "action";

function log(message) {
  console.error(`[openbot-browser] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // fall through to the error below
  }
  throw new Error(`no chromium binary under ${BROWSERS_ROOT}`);
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

async function launchBrowser() {
  const startedAt = Date.now();
  if (!HEADLESS) {
    await waitForDisplay();
  }
  killStaleBrowser();
  clearProfileLock();
  const binary = findChromiumBinary();
  log(`launching ${binary} (remote debugging)`);
  fs.rmSync(`${USER_DATA_DIR}/DevToolsActivePort`, { force: true });
  const child = spawn(binary, chromiumLaunchArgs(), {
    env: {
      ...process.env,
      ...(HEADLESS ? {} : { DISPLAY: DISPLAY_NAME }),
      LIBGL_ALWAYS_SOFTWARE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      log(`chromium: ${line.slice(0, 400)}`);
    }
  });
  let wsUrl;
  try {
    wsUrl = await readDevToolsActivePort(Date.now() + BROWSER_START_TIMEOUT_MS);
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    killStaleBrowser();
    clearProfileLock();
    const message = error && error.message ? error.message : String(error);
    log(`launch failed after ${Date.now() - startedAt}ms: ${message}`);
    throw new Error(
      `browser unavailable: chromium did not become ready within ${Math.round(BROWSER_START_TIMEOUT_MS / 1000)} seconds. The failed process was cleaned up; do not retry this browser action in the same turn.`,
    );
  }
  log(`ready in ${Date.now() - startedAt}ms (cdp ${wsUrl})`);
  return { wsUrl, child };
}


function chromiumLaunchArgs() {
  const args = [
    `--user-data-dir=${USER_DATA_DIR}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-crash-restore-bubble",
    "--disable-blink-features=AutomationControlled",
    "--lang=en-US",
  ];
  if (HEADLESS) {
    args.push("--headless=new", "--window-size=1280,800");
  } else {
    args.push("--start-maximized");
  }
  return args;
}

async function readDevToolsActivePort(deadline) {
  const file = `${USER_DATA_DIR}/DevToolsActivePort`;
  let lastError = "file not written";
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      const [portStr, path] = text.split("\n");
      const port = Number(portStr);
      if (Number.isInteger(port) && port > 0 && path && path.startsWith("/devtools/")) {
        return `ws://127.0.0.1:${port}${path}`;
      }
      lastError = `malformed DevToolsActivePort: ${JSON.stringify(text)}`;
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`DevToolsActivePort never appeared (${lastError})`);
}

// Launch Chromium ourselves with a remote debugging port instead of letting
// Playwright own the process: the browser-harness CDP session and the
// Playwright action bridge then drive the same browser. This is the seam that
// lets `browser_execute` share the profile, cookies, and display with the
// existing action tools.

// ---------------------------------------------------------------------------
// CDP layer. Actions drive the same Chromium through the browser-harness
// Session (vendored from browser-use/browser-harness-js, MIT) that
// browser_execute uses — one engine, one profile, no Playwright.
// ---------------------------------------------------------------------------

let harnessModule = null;
async function loadHarness() {
  if (!harnessModule) {
    harnessModule = await import("./browser-harness.mjs");
  }
  return harnessModule;
}

function evaluateValue(response) {
  if (!response) {
    return undefined;
  }
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    const description =
      details.exception?.description ??
      details.text ??
      "JavaScript evaluation failed";
    throw new Error(description);
  }
  return response.result ? response.result.value : undefined;
}

async function evaluate(session, expression) {
  const response = await session.domains.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return evaluateValue(response);
}

async function pageInfo(session) {
  const info = await evaluate(
    session,
    "JSON.stringify({url: location.href, title: document.title})",
  );
  try {
    return JSON.parse(info ?? "{}");
  } catch {
    return { url: "", title: "" };
  }
}

async function bodyText(session, maxLength = MAX_OBSERVATION_TEXT) {
  try {
    const text = await evaluate(session, "document.body ? document.body.innerText : ''");
    return (text ?? "").slice(0, maxLength);
  } catch {
    return "";
  }
}

async function waitForLoad(session, timeoutMs = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(session, "document.readyState === 'complete'")) {
        return true;
      }
    } catch {
      // mid-navigation; retry until the deadline
    }
    await sleep(150);
  }
  return false;
}

async function waitForFunction(session, expression, timeoutMs, pollMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(session, expression)) {
        return true;
      }
    } catch {
      // mid-navigation; retry until the deadline
    }
    await sleep(pollMs);
  }
  return false;
}

async function waitForSelector(session, selector, timeoutMs = SELECTOR_TIMEOUT_MS) {
  return waitForFunction(
    session,
    `!!resolveOpenbotElement(${JSON.stringify(selector)})`,
    timeoutMs,
  );
}

// Clicks, submits, and link follows usually navigate. The page signals a
// navigation with a changed URL or a replaced document; wait briefly for
// either so the observation describes the page the action produced instead of
// the one it left behind. DOM mutations resolve the wait too, so in-place
// interactions stay fast.
async function runWithNavigation(session, action) {
  const before = (await pageInfo(session)).url ?? "";
  const token = await evaluate(
    session,
    "(() => { window.__openbotDoc = String(Math.random());"
      + " if (window.__openbotObserver) { window.__openbotObserver.disconnect(); }"
      + " window.__openbotNav = false;"
      + " window.__openbotObserver = new MutationObserver(() => { window.__openbotNav = true; });"
      + " window.__openbotObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });"
      + " return window.__openbotDoc; })()",
  ).catch(() => null);
  await action();
  await waitForFunction(
    session,
    `location.href !== ${JSON.stringify(before)}`
      + ` || window.__openbotDoc !== ${JSON.stringify(token)}`
      + " || window.__openbotNav === true",
    NAVIGATION_WAIT_MS,
  ).catch(() => {});
}

// Client-rendered pages finish painting well after domcontentloaded. Wait for
// real body text plus a short stretch of DOM silence instead of a fixed sleep,
// bounded so a noisy or broken page can never stall the action.
async function waitForSettledContent(session, timeoutMs = CONTENT_WAIT_TIMEOUT_MS) {
  await waitForLoad(session, Math.min(3_000, timeoutMs)).catch(() => {});
  await waitForFunction(
    session,
    `(() => { const body = document.body; if (!body) { return false; }`
      + ` if ((body.innerText || '').trim().length < ${CONTENT_MIN_CHARS}) { return false; }`
      + " const now = Date.now(); let state = window.__openbotSettle;"
      + " if (!state) { state = { lastMutation: now, observed: null, observer: null }; window.__openbotSettle = state; }"
      + " if (state.observed !== body) {"
      + "   if (state.observer) { state.observer.disconnect(); }"
      + "   state.observer = new MutationObserver(() => { state.lastMutation = Date.now(); });"
      + "   state.observer.observe(body, { childList: true, subtree: true, characterData: true });"
      + "   state.observed = body; state.lastMutation = now;"
      + " }"
      + ` return now - state.lastMutation >= ${CONTENT_SETTLE_MS}; })()`,
    timeoutMs,
  ).catch(() => {});
}

// Element resolution shared by click/type/wait. Supports the `text=Label`
// pseudo-selector that the fields action emits for buttons, plus plain CSS.
const ELEMENT_HELPERS = [
  "function resolveOpenbotElement(selector) {",
  "  if (!selector) { return null; }",
  "  if (selector.startsWith('text=')) {",
  "    const wanted = selector.slice(5).trim().toLowerCase();",
  "    const candidates = document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit], input[type=button], summary, label');",
  "    for (const element of candidates) {",
  "      const label = (element.innerText || element.value || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().toLowerCase();",
  "      if (label === wanted || (wanted.length > 2 && label.includes(wanted))) { return element; }",
  "    }",
  "    return null;",
  "  }",
  "  return document.querySelector(selector);",
  "}",
].join("\n");

async function resolveElement(session, selector) {
  return evaluate(
    session,
    `(() => { ${ELEMENT_HELPERS} const element = resolveOpenbotElement(${JSON.stringify(selector)});`
      + " if (!element) { return null; }"
      + " element.scrollIntoView({ block: 'center', inline: 'center' });"
      + " const rect = element.getBoundingClientRect();"
      + " return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height }; })()",
  );
}

async function clickAt(session, x, y) {
  await session.domains.Input.dispatchMouseEvent({
    type: "mouseMoved",
    x,
    y,
    button: "none",
    clickCount: 0,
  });
  await session.domains.Input.dispatchMouseEvent({
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await session.domains.Input.dispatchMouseEvent({
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function clickSelector(session, selector) {
  const target = await resolveElement(session, selector);
  if (!target) {
    throw new Error(`element not found: ${selector}`);
  }
  await clickAt(session, target.x, target.y);
}

async function clickLinkByIndex(session, index) {
  const target = await evaluate(
    session,
    `(() => { const links = document.querySelectorAll('a[href]');`
      + ` const element = links[${index}];`
      + " if (!element) { return null; }"
      + " element.scrollIntoView({ block: 'center', inline: 'center' });"
      + " const rect = element.getBoundingClientRect();"
      + " return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()",
  );
  if (!target) {
    throw new Error(`link index out of range: ${index}`);
  }
  await clickAt(session, target.x, target.y);
}

async function fillInput(session, selector, text) {
  const focused = await evaluate(
    session,
    `(() => { ${ELEMENT_HELPERS} const element = resolveOpenbotElement(${JSON.stringify(selector)});`
      + " if (!element) { return false; }"
      + " element.scrollIntoView({ block: 'center', inline: 'center' });"
      + " element.focus();"
      + " if (typeof element.select === 'function') { element.select(); }"
      + " else if (element.setSelectionRange) { element.setSelectionRange(0, (element.value || '').length); }"
      + " return true; })()",
  );
  if (!focused) {
    throw new Error(`element not found: ${selector}`);
  }
  await session.domains.Input.insertText({ text: text ?? "" });
  await evaluate(
    session,
    `(() => { ${ELEMENT_HELPERS} const element = resolveOpenbotElement(${JSON.stringify(selector)});`
      + " if (!element) { return; }"
      + " element.dispatchEvent(new Event('input', { bubbles: true }));"
      + " element.dispatchEvent(new Event('change', { bubbles: true })); })()",
  );
}

async function pressEnter(session) {
  const base = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await session.domains.Input.dispatchKeyEvent({
    type: "rawKeyDown",
    ...base,
  });
  await session.domains.Input.dispatchKeyEvent({
    type: "char",
    text: "\r",
    ...base,
  });
  await session.domains.Input.dispatchKeyEvent({ type: "keyUp", ...base });
}

async function scrollBy(session, dy) {
  const viewport = await evaluate(
    session,
    "({ w: window.innerWidth, h: window.innerHeight })",
  );
  await session.domains.Input.dispatchMouseEvent({
    type: "mouseWheel",
    x: Math.round((viewport?.w ?? 1160) / 2),
    y: Math.round((viewport?.h ?? 700) / 2),
    deltaX: 0,
    deltaY: dy,
  });
}

async function scrollSelectorIntoView(session, selector) {
  const ok = await evaluate(
    session,
    `(() => { ${ELEMENT_HELPERS} const element = resolveOpenbotElement(${JSON.stringify(selector)});`
      + " if (!element) { return false; }"
      + " element.scrollIntoView({ block: 'center', inline: 'center' }); return true; })()",
  );
  if (!ok) {
    throw new Error(`element not found: ${selector}`);
  }
}

async function takeScreenshot(session) {
  const result = await session.domains.Page.captureScreenshot({ format: "png" });
  return result.data;
}

async function navigateTo(session, url) {
  await session.domains.Page.navigate({ url });
  await waitForLoad(session, PAGE_TIMEOUT_MS);
}

async function goBack(session) {
  const history = await session.domains.Page.getNavigationHistory({});
  const index = history.currentIndex - 1;
  const entry = history.entries[index];
  if (!entry) {
    throw new Error("no previous page in history");
  }
  await session.domains.Page.navigateToHistoryEntry({ entryId: entry.id });
  await waitForLoad(session, PAGE_TIMEOUT_MS);
}

async function challengeState(session) {
  let title = "";
  let text = "";
  try {
    title = (await pageInfo(session)).title ?? "";
  } catch {
    // The page may be navigating; treat as no signal.
  }
  try {
    text = (await bodyText(session, 1_500)) ?? "";
  } catch {
    // Same as above.
  }
  const titleMatch = CHALLENGE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const textMatch = CHALLENGE_TEXT_PATTERNS.some((pattern) => pattern.test(text));
  if (!titleMatch && !textMatch) {
    return false;
  }
  if (titleMatch) {
    return true;
  }
  const markers = await evaluate(
    session,
    `document.querySelectorAll(${JSON.stringify(CHALLENGE_MARKERS)}).length`,
  ).catch(() => 0);
  return (markers ?? 0) > 0 || text.length < 600;
}

// Many bot checks pass on their own once the page's JavaScript finishes. Wait
// briefly for that, and if the interstitial is stuck in a loop, try one fresh
// navigation before declaring the page blocked.
async function settleChallenge(session) {
  if (!(await challengeState(session))) {
    return false;
  }
  const waitForClear = async (waitMs) => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(500);
      if (!(await challengeState(session))) {
        return true;
      }
    }
    return false;
  };
  if (await waitForClear(CHALLENGE_WAIT_MS)) {
    return false;
  }
  try {
    await session.domains.Page.reload({});
    await waitForLoad(session, PAGE_TIMEOUT_MS);
  } catch {
    return true;
  }
  return !(await waitForClear(CHALLENGE_RETRY_WAIT_MS));
}

async function performAction(session, action) {
  const result = await runAction(session, action);
  if (result && result.ok !== false && !result.challenge) {
    if (await settleChallenge(session)) {
      const info = await pageInfo(session);
      return {
        ok: false,
        challenge: true,
        url: info.url,
        title: info.title,
        error:
          `blocked by a bot check (Cloudflare/Turnstile) at ${info.url}. ` +
          "Ask the user to open the Screen panel and complete the check once; " +
          "the browser profile keeps the clearance for later actions. Do not retry this action in a loop.",
      };
    }
  }
  return result;
}

async function runAction(session, action) {
  const pageState = async () => {
    const info = await pageInfo(session);
    return { url: info.url, title: info.title, text: await bodyText(session) };
  };

  switch (action.action) {
    case "goto": {
      await navigateTo(session, action.url);
      if (!(await challengeState(session))) {
        await waitForSettledContent(session);
      }
      return pageState();
    }
    case "back": {
      await goBack(session);
      if (!(await challengeState(session))) {
        await waitForSettledContent(session);
      }
      return pageState();
    }
    case "clickLink": {
      if (action.href) {
        const target = await evaluate(
          session,
          "(() => { const anchors = Array.from(document.querySelectorAll('a[href]'));"
            + ` const wanted = ${JSON.stringify(action.href)};`
            + " const trim = (value) => value.replace(/\\/$/, '');"
            + " const element = anchors.find((anchor) => anchor.href === wanted)"
            + "   || anchors.find((anchor) => trim(anchor.href) === trim(wanted));"
            + " if (!element) { return null; }"
            + " element.scrollIntoView({ block: 'center', inline: 'center' });"
            + " const rect = element.getBoundingClientRect();"
            + " return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()",
        );
        if (!target) {
          throw new Error(`link not found: ${action.href}`);
        }
        await runWithNavigation(session, () => clickAt(session, target.x, target.y));
      } else {
        const index = Number.isInteger(action.index) ? action.index : 0;
        await runWithNavigation(session, () => clickLinkByIndex(session, index));
      }
      await waitForSettledContent(session);
      return pageState();
    }
    case "click": {
      await runWithNavigation(session, () => clickSelector(session, action.selector));
      await waitForSettledContent(session);
      return pageState();
    }
    case "type": {
      await fillInput(session, action.selector, action.text ?? "");
      if (action.submit) {
        await runWithNavigation(session, () => pressEnter(session));
        await waitForSettledContent(session);
      }
      return pageState();
    }
    case "text": {
      const text = action.selector
        ? await evaluate(
            session,
            `(() => { ${ELEMENT_HELPERS} const element = resolveOpenbotElement(${JSON.stringify(action.selector)});`
              + " return element ? (element.innerText || element.textContent || '') : null; })()",
          )
        : await evaluate(session, "document.body ? document.body.innerText : ''");
      const info = await pageInfo(session);
      return {
        url: info.url,
        title: info.title,
        text: (text ?? "").slice(0, MAX_TEXT),
      };
    }
    case "wait": {
      if (action.selector) {
        await waitForSelector(session, action.selector, SELECTOR_TIMEOUT_MS);
      } else {
        await sleep(Math.min(action.milliseconds ?? 1000, 30_000));
      }
      return pageState();
    }
    case "scroll": {
      if (action.selector) {
        await scrollSelectorIntoView(session, action.selector);
      } else {
        const pixels = Number.isFinite(action.pixels)
          ? Math.max(Math.min(action.pixels, 5_000), -5_000)
          : 600;
        await scrollBy(session, pixels);
      }
      await waitForSettledContent(session);
      return pageState();
    }
    case "links": {
      const links = await evaluate(
        session,
        `(() => { ${ELEMENT_HELPERS} const root = ${action.selector ? `resolveOpenbotElement(${JSON.stringify(action.selector)})` : "document.body"};`
          + " if (!root) { return []; }"
          + " return Array.from(root.querySelectorAll('a[href]'))"
          + "   .map((element) => ({"
          + "     text: (element.innerText || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(),"
          + "     href: element.href,"
          + "   }))"
          + "   .filter((link) => link.href && link.text)"
          + "   .slice(0, 100); })()",
      );
      const info = await pageInfo(session);
      return {
        url: info.url,
        title: info.title,
        text: (links ?? [])
          .map((link) => `${link.text} — ${link.href}`)
          .join("\n")
          .slice(0, MAX_TEXT),
      };
    }
    case "fields": {
      const fields = await evaluate(
        session,
        "(() => {"
          + " const selectorFor = (element) => {"
          + "   if (element.id) { return '#' + CSS.escape(element.id); }"
          + "   const name = element.getAttribute('name');"
          + "   if (name) { return element.tagName.toLowerCase() + '[name=\"' + CSS.escape(name) + '\"]'; }"
          + "   const aria = element.getAttribute('aria-label');"
          + "   if (aria) { return element.tagName.toLowerCase() + '[aria-label=\"' + CSS.escape(aria) + '\"]'; }"
          + "   const placeholder = element.getAttribute('placeholder');"
          + "   if (placeholder) { return element.tagName.toLowerCase() + '[placeholder=\"' + CSS.escape(placeholder) + '\"]'; }"
          + "   if (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button') {"
          + "     const label = (element.innerText || '').replace(/\\s+/g, ' ').trim();"
          + "     if (label) { return 'text=' + label; }"
          + "   }"
          + "   return null;"
          + " };"
          + " const visible = (element) => { const rect = element.getBoundingClientRect();"
          + "   if (rect.width < 2 || rect.height < 2) { return false; }"
          + "   const style = getComputedStyle(element);"
          + "   return style.display !== 'none' && style.visibility !== 'hidden'; };"
          + " const nodes = Array.from(document.querySelectorAll('input, textarea, select, button, [role=button], [contenteditable=true]'));"
          + " return nodes.filter(visible).map((element) => ({"
          + "   selector: selectorFor(element),"
          + "   tag: element.tagName.toLowerCase(),"
          + "   type: element.getAttribute('type') || '',"
          + "   label: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.innerText || element.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),"
          + " })).filter((field) => field.selector).slice(0, 60); })()",
      );
      const info = await pageInfo(session);
      return {
        url: info.url,
        title: info.title,
        text: (fields ?? [])
          .map(
            (field) =>
              `${field.selector} — ${field.tag}${field.type ? `[${field.type}]` : ""}${field.label ? ` "${field.label}"` : ""}`,
          )
          .join("\n")
          .slice(0, MAX_TEXT),
      };
    }
    case "snapshot": {
      const elements = await evaluate(
        session,
        "(() => {"
          + " const selectorFor = (element) => {"
          + "   if (element.id) { return '#' + CSS.escape(element.id); }"
          + "   const name = element.getAttribute('name');"
          + "   if (name) { return element.tagName.toLowerCase() + '[name=\"' + CSS.escape(name) + '\"]'; }"
          + "   const aria = element.getAttribute('aria-label');"
          + "   if (aria) { return element.tagName.toLowerCase() + '[aria-label=\"' + CSS.escape(aria) + '\"]'; }"
          + "   const placeholder = element.getAttribute('placeholder');"
          + "   if (placeholder) { return element.tagName.toLowerCase() + '[placeholder=\"' + CSS.escape(placeholder) + '\"]'; }"
          + "   if (element.tagName === 'A' && element.getAttribute('href')) {"
          + "     return 'a[href=\"' + CSS.escape(element.getAttribute('href')) + '\"]';"
          + "   }"
          + "   if (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button' || element.tagName === 'SUMMARY') {"
          + "     const label = (element.innerText || '').replace(/\\s+/g, ' ').trim();"
          + "     if (label) { return 'text=' + label; }"
          + "   }"
          + "   return null;"
          + " };"
          + " const visible = (element) => { const rect = element.getBoundingClientRect();"
          + "   if (rect.width < 2 || rect.height < 2) { return false; }"
          + "   const style = getComputedStyle(element);"
          + "   return style.display !== 'none' && style.visibility !== 'hidden'; };"
          + " const roleOf = (element) => {"
          + "   const tag = element.tagName.toLowerCase();"
          + "   if (tag === 'a') { return 'link'; }"
          + "   if (tag === 'select') { return 'select'; }"
          + "   if (tag === 'textarea' || tag === 'input' || element.getAttribute('contenteditable') === 'true') { return 'field'; }"
          + "   if (tag === 'summary') { return 'summary'; }"
          + "   return 'button';"
          + " };"
          + " const nodes = Array.from(document.querySelectorAll('a[href], button, [role=button], [role=link], input:not([type=hidden]), textarea, select, summary, [contenteditable=true]'));"
          + " const seen = new Set();"
          + " const out = [];"
          + " for (const element of nodes) {"
          + "   if (!visible(element)) { continue; }"
          + "   const selector = selectorFor(element);"
          + "   if (!selector || seen.has(selector)) { continue; }"
          + "   seen.add(selector);"
          + "   out.push({"
          + "     id: 'e' + out.length,"
          + "     selector,"
          + "     role: roleOf(element),"
          + "     tag: element.tagName.toLowerCase(),"
          + "     type: element.getAttribute('type') || '',"
          + "     label: (element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || element.href || '').replace(/\\s+/g, ' ').trim().slice(0, 100),"
          + "   });"
          + "   if (out.length >= 60) { break; }"
          + " }"
          + " return out; })()",
      );
      const info = await pageInfo(session);
      return {
        url: info.url,
        title: info.title,
        text: (elements ?? [])
          .map(
            (element) =>
              `${element.id} ${element.role} "${element.label}" (${element.selector})`,
          )
          .join("\n")
          .slice(0, MAX_TEXT),
        elements: elements ?? [],
      };
    }
    case "screenshot": {
      const info = await pageInfo(session);
      return {
        url: info.url,
        title: info.title,
        screenshot: await takeScreenshot(session),
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
  let execRunner = null;
  let actionSession = null;

  const runExec = async (action) => {
    const current = await getSession();
    const harness = await loadHarness();
    if (!execRunner) {
      execRunner = new harness.ExecRunner();
    }
    return execRunner.run({
      wsUrl: current.wsUrl,
      code: action.code,
      timeoutMs: action.timeoutMs,
      egress: action.egress,
    });
  };

  // Actions and browser_execute each hold their own CDP session against the
  // same browser: one WS for the deterministic action loop, one for snippets.
  const getActionSession = async () => {
    const current = await getSession();
    if (!actionSession) {
      const harness = await loadHarness();
      actionSession = new harness.Session();
    }
    if (!actionSession.isConnected()) {
      await actionSession.connect({ wsUrl: current.wsUrl });
    }
    // Re-attach whenever there is no active target: the browser may still have
    // been starting when the session first connected, and page-level CDP
    // methods fail with "'X' wasn't found" on an unattached session.
    if (!actionSession.getActiveSession()) {
      const { targetInfos } = await actionSession.domains.Target.getTargets({});
      const pages = (targetInfos ?? []).filter((target) => target.type === "page");
      const page =
        pages.find(
          (target) =>
            !target.url.startsWith("chrome://") &&
            !target.url.startsWith("devtools://"),
        ) ?? pages[0];
      if (page) {
        await actionSession.use(page.targetId);
      } else {
        throw new Error("browser has no page target to attach to");
      }
    }
    return actionSession;
  };

  const openSession = async () => {
    const opened = await launchBrowser();
    session = opened;
    opened.child.on("exit", () => {
      if (session === opened) {
        session = null;
      }
      log("browser process exited");
    });
    return opened;
  };

  const resetSession = async (reason) => {
    const current = session;
    session = null;
    actionSession = null;
    if (execRunner) {
      try {
        execRunner.close();
      } catch {
        // The runner reconnects lazily on the next exec.
      }
      execRunner = null;
    }
    if (current?.child) {
      try {
        current.child.kill("SIGTERM");
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
            if (action.action === "exec") {
              response = { ok: true, ...(await runExec(action)) };
            } else {
              const current = await getActionSession();
              const result = await performAction(current, action);
              response = { ok: true, ...result };
            }
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
      }, waitMs);

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
  const browser = await launchBrowser();
  try {
    const harness = await loadHarness();
    if (payload.action === "exec") {
      const runner = new harness.ExecRunner();
      try {
        return {
          ok: true,
          ...(await runner.run({
            wsUrl: browser.wsUrl,
            code: payload.code,
            timeoutMs: payload.timeoutMs,
            egress: payload.egress,
          })),
        };
      } finally {
        runner.close();
      }
    }
    const session = new harness.Session();
    try {
      await session.connect({ wsUrl: browser.wsUrl });
      const { targetInfos } = await session.domains.Target.getTargets({});
      const page = (targetInfos ?? []).find(
        (target) =>
          target.type === "page" &&
          !target.url.startsWith("chrome://") &&
          !target.url.startsWith("devtools://"),
      );
      if (page) {
        await session.use(page.targetId);
      }
      const result = await performAction(session, payload);
      return { ok: true, ...result };
    } finally {
      session.close();
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    try {
      browser.child.kill("SIGTERM");
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
    const waitMs =
      payload.action === "exec"
        ? (typeof payload.timeoutMs === "number" ? payload.timeoutMs : 60_000) + 10_000
        : DAEMON_ACTION_TIMEOUT_MS;
    response = await callDaemon(payload, waitMs);
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
