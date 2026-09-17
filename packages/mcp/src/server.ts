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

const transport = new StdioServerTransport();
await server.connect(transport);
