import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HttpSandboxBackend, type SandboxBackend } from "@openbot/sandbox";

const SANDBOX_URL = process.env.OPENBOT_SANDBOX_URL ?? "http://127.0.0.1:4171";
const BOT_ID = process.env.OPENBOT_BOT_ID ?? "assistant";
const MAX_OUTPUT = 30_000;
const MAX_TIMEOUT_SECONDS = 240;

const sandbox: SandboxBackend = new HttpSandboxBackend({ url: SANDBOX_URL });

function truncate(value: string): string {
  return value.length <= MAX_OUTPUT
    ? value
    : `${value.slice(0, MAX_OUTPUT)}\n[output truncated]`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatExec(result: {
  exit: number;
  stdout: string;
  stderr: string;
}): string {
  const parts = [`exit code: ${result.exit}`];
  if (result.stdout.trim()) {
    parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  }
  if (result.stderr.trim()) {
    parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  }
  return parts.join("\n");
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<{ text: string; isError: boolean }> {
  const result = await sandbox.exec(BOT_ID, {
    command,
    cwd,
    timeoutMs: timeoutSeconds * 1000,
  });
  return {
    text: truncate(formatExec(result)),
    isError: result.exit !== 0,
  };
}

const server = new McpServer(
  { name: "openbot-sandbox", version: "0.1.0" },
  {
    instructions:
      "Controls an isolated Linux microVM (the bot's own computer) that " +
      "persists between sessions. Use `shell` to run commands and manage " +
      "files, and `browser` for web work: it keeps cookies and sign-ins, and " +
      "returns screenshots you can see. The computer starts automatically on " +
      "first use and has internet access.",
  },
);

server.registerTool(
  "computer_status",
  {
    title: "Computer status",
    description:
      "Check the state of the bot's computer (stopped, booting, running, error).",
    inputSchema: {},
  },
  async () => {
    const status = await sandbox.status(BOT_ID);
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
  },
);

server.registerTool(
  "shell",
  {
    title: "Run a shell command",
    description:
      "Run a shell command inside the bot's Linux computer. Use it to inspect " +
      "the environment, install packages, create and read files, and run scripts.",
    inputSchema: {
      command: z.string().describe("The shell command to run."),
      cwd: z.string().optional().describe("Working directory. Defaults to /root."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("Timeout in seconds (default 60, max 240)."),
    },
  },
  async ({ command, cwd, timeoutSeconds }) => {
    const timeout = Math.min(
      Math.max(timeoutSeconds ?? 60, 1),
      MAX_TIMEOUT_SECONDS,
    );
    const result = await runCommand(command, cwd ?? "/root", timeout);
    return {
      content: [{ type: "text", text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read a file",
    description: "Read a file from the bot's computer as text.",
    inputSchema: {
      path: z.string().describe("Absolute path to the file."),
      maxBytes: z
        .number()
        .optional()
        .describe("Maximum bytes to read (default 100000)."),
    },
  },
  async ({ path, maxBytes }) => {
    const limit = Math.min(Math.max(maxBytes ?? 100_000, 1), 200_000);
    const result = await runCommand(
      `head -c ${Math.floor(limit)} -- ${shellQuote(path)}`,
      "/root",
      30,
    );
    return {
      content: [{ type: "text", text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  },
);

server.registerTool(
  "write_file",
  {
    title: "Write a file",
    description:
      "Write text to a file on the bot's computer, creating parent directories.",
    inputSchema: {
      path: z.string().describe("Absolute path to write."),
      content: z.string().describe("File contents."),
    },
  },
  async ({ path, content }) => {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const command = `mkdir -p -- $(dirname ${shellQuote(path)}) && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)} && wc -c < ${shellQuote(path)}`;
    const result = await runCommand(command, "/root", 30);
    return {
      content: [{ type: "text", text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  },
);

server.registerTool(
  "browser",
  {
    title: "Control the web browser",
    description:
      "Control the browser on the bot's computer. The browser keeps cookies " +
      "and sign-ins between calls. Navigation and interaction actions return " +
      "the current page text automatically. Actions: goto (url), click " +
      "(selector), type (selector, text, submit), text (optional selector), " +
      "links (optional selector, returns labels and URLs), screenshot (returns " +
      "an image), back, wait (selector or milliseconds).",
    inputSchema: {
      action: z.enum([
        "goto",
        "click",
        "type",
        "text",
        "links",
        "screenshot",
        "back",
        "wait",
      ]),
      url: z.string().optional().describe("URL for the goto action."),
      selector: z.string().optional().describe("CSS selector."),
      text: z.string().optional().describe("Text to type."),
      submit: z.boolean().optional().describe("Press Enter after typing."),
      milliseconds: z.number().optional().describe("Wait duration."),
    },
  },
  async (args) => {
    const parsed = await sandbox.browser(BOT_ID, {
      action: args.action,
      url: args.url,
      selector: args.selector,
      text: args.text,
      submit: args.submit,
      milliseconds: args.milliseconds,
      timeoutMs: 75_000,
    });
    if (parsed.ok === false) {
      return {
        content: [
          { type: "text", text: `browser error: ${parsed.error ?? "unknown"}` },
        ],
        isError: true,
      };
    }

    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [
      {
        type: "text",
        text: `url: ${parsed.url ?? ""}\ntitle: ${parsed.title ?? ""}${
          parsed.text ? `\ntext:\n${parsed.text}` : ""
        }`,
      },
    ];
    if (parsed.screenshot) {
      content.push({
        type: "image",
        data: parsed.screenshot,
        mimeType: "image/png",
      });
    }
    return { content };
  },
);

server.registerTool(
  "browser_execute",
  {
    title: "Run browser JavaScript (CDP)",
    description:
      "Drive the browser by writing JavaScript against a persistent Chrome " +
      "DevTools Protocol session. In scope: `session` (every CDP domain — " +
      "session.Page, session.Runtime, session.DOM, session.Target, " +
      "session.Network, ...) and `console`. Return a value to see it as JSON; " +
      "console.log output comes back too. Screenshots taken with " +
      "`await session.Page.captureScreenshot({format:'png'})` attach as images. " +
      "The session persists across calls, so tabs, cookies, and sign-ins " +
      "survive. Prefer this over the step-by-step browser tool for multi-step " +
      "work: one snippet can navigate, wait, extract, click, and verify.",
    inputSchema: {
      code: z
        .string()
        .describe(
          "JavaScript snippet. `session` (CDP) and `console` are in scope; " +
            "`return` a value to see it as JSON.",
        ),
      description: z
        .string()
        .optional()
        .describe("Clear, concise description of the snippet in 3-7 words."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default 60000, max 300000)."),
    },
  },
  async (args) => {
    const parsed = await sandbox.browser(BOT_ID, {
      action: "exec",
      code: args.code,
      timeoutMs: Math.min(Math.max(args.timeout ?? 60_000, 1_000), 300_000),
    });
    if (parsed.ok === false) {
      return {
        content: [
          {
            type: "text",
            text: `browser_execute error: ${parsed.error ?? "unknown"}`,
          },
        ],
        isError: true,
      };
    }
    const lines = [
      `url: ${parsed.url ?? ""}\ntitle: ${parsed.title ?? ""}`,
    ];
    if (parsed.output?.trim()) {
      lines.push(`console:\n${parsed.output.trimEnd()}`);
    }
    if (parsed.result && parsed.result !== "null") {
      lines.push(`=> ${parsed.result}`);
    }
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: lines.join("\n") }];
    for (const screenshot of parsed.screenshots ?? []) {
      content.push({
        type: "image",
        data: screenshot,
        mimeType: "image/png",
      });
    }
    return { content };
  },
);

server.registerTool(
  "desktop",
  {
    title: "Control the desktop",
    description:
      "Control the desktop GUI of the bot's computer directly with the mouse " +
      "and keyboard: clicks, double clicks, click-and-drag, scrolling, typing, " +
      "key presses, and window management. The screen is 1280x800; take a " +
      "screenshot first and act on the coordinates you saw. Actions: " +
      "screenshot, move (x, y), click (x, y, button, count), drag (fromX, " +
      "fromY, toX, toY, button, durationMs), scroll (x, y, direction, amount), " +
      "type (text), key (keys), wait (milliseconds), windows, activate (title).",
    inputSchema: {
      action: z.enum([
        "screenshot",
        "move",
        "click",
        "drag",
        "scroll",
        "type",
        "key",
        "wait",
        "windows",
        "activate",
      ]),
      x: z.number().optional().describe("Pointer x coordinate (0-1279)."),
      y: z.number().optional().describe("Pointer y coordinate (0-799)."),
      fromX: z.number().optional().describe("Drag start x coordinate."),
      fromY: z.number().optional().describe("Drag start y coordinate."),
      toX: z.number().optional().describe("Drag end x coordinate."),
      toY: z.number().optional().describe("Drag end y coordinate."),
      button: z.enum(["left", "middle", "right"]).optional(),
      count: z.number().optional().describe("Click count, 1-3."),
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().optional().describe("Scroll steps, 1-50."),
      durationMs: z.number().optional().describe("Drag duration."),
      text: z.string().optional().describe("Text to type."),
      keys: z.string().optional().describe("Key combination, such as alt+F4."),
      milliseconds: z.number().optional().describe("Wait duration."),
      title: z.string().optional().describe("Window title for activate."),
      observe: z
        .boolean()
        .optional()
        .describe("Capture a screenshot after the action (default true)."),
    },
  },
  async (args) => {
    const parsed = await sandbox.desktop(BOT_ID, {
      action: args.action,
      x: args.x,
      y: args.y,
      fromX: args.fromX,
      fromY: args.fromY,
      toX: args.toX,
      toY: args.toY,
      button: args.button,
      count: args.count,
      direction: args.direction,
      amount: args.amount,
      durationMs: args.durationMs,
      text: args.text,
      keys: args.keys,
      milliseconds: args.milliseconds,
      title: args.title,
      screenshot: args.observe !== false,
    });
    if (parsed.ok === false) {
      return {
        content: [
          {
            type: "text",
            text: `desktop error: ${parsed.error ?? "unknown"}`,
          },
        ],
        isError: true,
      };
    }
    const lines = [parsed.detail ?? args.action];
    if (parsed.width && parsed.height) {
      lines.push(`screen: ${parsed.width}x${parsed.height}`);
    }
    if (parsed.cursor) {
      lines.push(`pointer: ${parsed.cursor.x},${parsed.cursor.y}`);
    }
    if (parsed.window) {
      lines.push(`active window: ${parsed.window}`);
    }
    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: lines.join("\n") }];
    if (parsed.screenshot) {
      content.push({
        type: "image",
        data: parsed.screenshot,
        mimeType: "image/png",
      });
    }
    return { content };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
