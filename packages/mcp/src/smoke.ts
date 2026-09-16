import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/bin.ts"],
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
  stderr: "inherit",
});

const client = new Client({ name: "openbot-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(
  "tools:",
  tools.tools.map((tool) => tool.name).join(", "),
);

const status = await client.callTool({ name: "computer_status", arguments: {} });
console.log("status:", JSON.stringify(status.content).slice(0, 200));

const shell = await client.callTool(
  { name: "shell", arguments: { command: "echo hello from mcp && uname -m" } },
  undefined,
  { timeout: 180_000 },
);
console.log("shell:", JSON.stringify(shell.content).slice(0, 300));

const write = await client.callTool({
  name: "write_file",
  arguments: { path: "/root/mcp-proof.txt", content: "written over mcp\n" },
});
console.log("write_file:", JSON.stringify(write.content).slice(0, 200));

const read = await client.callTool({
  name: "read_file",
  arguments: { path: "/root/mcp-proof.txt" },
});
console.log("read_file:", JSON.stringify(read.content).slice(0, 200));

const browser = await client.callTool(
  {
    name: "browser",
    arguments: { action: "goto", url: "https://example.com" },
  },
  undefined,
  { timeout: 240_000 },
);
const browserEntries = browser.content as Array<{ type: string }>;
console.log(
  "browser:",
  JSON.stringify(browserEntries.map((entry) => entry.type)),
  JSON.stringify(browserEntries[0]).slice(0, 200),
);

const screenshot = await client.callTool(
  { name: "browser", arguments: { action: "screenshot" } },
  undefined,
  { timeout: 240_000 },
);
const screenshotContent = screenshot.content as Array<{
  type: string;
  data?: string;
}>;
const image = screenshotContent.find((entry) => entry.type === "image");
console.log(
  "screenshot:",
  image ? `image ${image.data?.length ?? 0} base64 chars` : "no image",
);

await client.close();
