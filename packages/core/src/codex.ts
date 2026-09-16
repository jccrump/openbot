import { randomUUID } from "node:crypto";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexInfo } from "@openbot/protocol";
import type {
  Message,
  ServerMessage,
  TokenUsage,
  ToolArtifact,
  ToolCallRecord,
} from "@openbot/protocol";
import { startResponsesBridge, type ResponsesBridge } from "@openbot/responses-bridge";
import type { AgentDeps, AgentInput } from "./agent";
import type { ProviderRecord } from "./store";
import { DEFAULT_THREAD_TITLE } from "./store";

const MAX_TRANSCRIPT_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TOOL_ARGUMENT_CHARS = 500;
const MAX_TOOL_OUTPUT_CHARS = 1_500;
const TOOL_TIMEOUT_SECONDS = 600;
const KILL_GRACE_MS = 5_000;

export function resolveCodexBinary(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const override = env.OPENBOT_CODEX_BIN?.trim();
  if (override) {
    return override;
  }
  const names =
    process.platform === "win32"
      ? ["codex.cmd", "codex.exe", "codex"]
      : ["codex"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export class CodexDetector {
  private current: CodexInfo = { available: false, version: null, path: null };
  private pending: Promise<void> | null = null;

  info(): CodexInfo {
    return this.current;
  }

  refresh(): Promise<void> {
    if (!this.pending) {
      this.pending = this.detect().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async detect(): Promise<void> {
    const binary = resolveCodexBinary();
    if (!binary) {
      this.current = { available: false, version: null, path: null };
      return;
    }
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          binary,
          ["--version"],
          { timeout: 10_000 },
          (error, stdout) => {
            if (error) {
              reject(error);
            } else {
              resolve(String(stdout));
            }
          },
        );
      });
      const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
      this.current = {
        available: true,
        version: match?.[0] ?? output.trim(),
        path: binary,
      };
    } catch {
      this.current = { available: false, version: null, path: binary };
    }
  }
}

export function isOpenAIChatGptProvider(record: ProviderRecord): boolean {
  const haystack = `${record.id} ${record.label}`.toLowerCase();
  if (haystack.includes("openai") || haystack.includes("chatgpt")) {
    return true;
  }
  try {
    const host = new URL(record.baseUrl).hostname.toLowerCase();
    return (
      host === "api.openai.com" ||
      host.endsWith(".openai.com") ||
      host === "chatgpt.com" ||
      host.endsWith(".chatgpt.com")
    );
  } catch {
    return false;
  }
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

function renderTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages.slice(-MAX_TRANSCRIPT_MESSAGES)) {
    if (message.role === "user") {
      parts.push(`User: ${truncate(message.content, MAX_MESSAGE_CHARS)}`);
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) {
        parts.push(`Assistant: ${truncate(message.content, MAX_MESSAGE_CHARS)}`);
      }
      for (const call of message.toolCalls ?? []) {
        parts.push(
          `[tool ${call.name}] ${truncate(call.arguments, MAX_TOOL_ARGUMENT_CHARS)} -> ${truncate(call.output, MAX_TOOL_OUTPUT_CHARS)}`,
        );
      }
      continue;
    }
    parts.push(`System: ${truncate(message.content, MAX_MESSAGE_CHARS)}`);
  }
  return parts.join("\n\n");
}

function mcpServerArgs(botId: string, sandboxUrl: string): string[] {
  const mcpDir = fileURLToPath(new URL("../../mcp/", import.meta.url));
  const mcpScript = join(mcpDir, "src", "bin.ts");
  const tsxBin = join(
    mcpDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  const useTsx = existsSync(tsxBin);
  const scriptArgs = useTsx ? [mcpScript] : ["--import", "tsx", mcpScript];
  const entry =
    `mcp_servers.openbot={command=${tomlString(useTsx ? tsxBin : process.execPath)}, ` +
    `args=[${scriptArgs.map(tomlString).join(", ")}], ` +
    `default_tools_approval_mode="approve", tool_timeout_sec=${TOOL_TIMEOUT_SECONDS}, ` +
    `env={OPENBOT_BOT_ID=${tomlString(botId)}, OPENBOT_SANDBOX_URL=${tomlString(sandboxUrl)}}}`;
  return useTsx ? [entry] : [entry, `cwd=${tomlString(mcpDir)}`];
}

function addUsage(total: TokenUsage | null, usage: TokenUsage): TokenUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
  };
}

function extractResultText(
  result: unknown,
  artifactsDir: string,
  artifacts: ToolArtifact[],
): string {
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as {
      type?: unknown;
      text?: unknown;
      data?: unknown;
      mimeType?: unknown;
    };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "image" && typeof part.data === "string") {
      try {
        mkdirSync(artifactsDir, { recursive: true });
        const filename = `${randomUUID()}.png`;
        writeFileSync(join(artifactsDir, filename), Buffer.from(part.data, "base64"));
        artifacts.push({ type: "image", url: `/artifacts/${filename}` });
        parts.push("screenshot saved (visible to the user in the chat)");
      } catch {
        // ignore artifacts that cannot be written
      }
    }
  }
  return parts.join("\n");
}

function killProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to the direct kill
    }
  }
  child.kill(signal);
}

function processTree(pid: number): number[] {
  const result: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let output = "";
    try {
      output = execFileSync("pgrep", ["-P", String(current)], {
        encoding: "utf8",
      });
    } catch {
      continue;
    }
    for (const line of output.split("\n")) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) {
        result.push(child);
        queue.push(child);
      }
    }
  }
  return result;
}

function killPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export async function runCodexTurn(
  deps: AgentDeps,
  input: AgentInput,
  emit: (message: ServerMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const { runId } = input;
  const bot = deps.store.getBot(input.botId);
  if (!bot) {
    emit({ type: "chat.error", runId, message: `unknown bot: ${input.botId}` });
    return;
  }

  if (bot.computer === "mac") {
    emit({
      type: "chat.error",
      runId,
      message:
        "The Codex harness always runs on the Firecracker microVM, but this " +
        "agent uses This Mac. Switch this agent's computer to the microVM or " +
        "switch the harness to OpenBot in Settings.",
    });
    return;
  }

  const model = input.model ?? bot.model;
  const requested = input.threadId
    ? deps.store.getThread(input.threadId)
    : null;
  let thread =
    requested && requested.botId === bot.id
      ? requested
      : deps.store.getOrCreateThread(bot.id);

  deps.store.addMessage({
    threadId: thread.id,
    role: "user",
    content: input.text,
    model: null,
  });

  if (thread.title === DEFAULT_THREAD_TITLE) {
    const updated = deps.store.touchThread(thread.id, {
      title: input.text.slice(0, 60),
    });
    if (updated) {
      thread = updated;
      emit({ type: "thread.upserted", thread });
    }
  }

  const provider = deps.providers.get(model.provider);
  const record = deps.providerRecord(model.provider);
  if (!provider || !record) {
    emit({
      type: "chat.error",
      runId,
      threadId: thread.id,
      message: `unknown provider: ${model.provider}`,
    });
    return;
  }

  const binary = resolveCodexBinary();
  const assistantMessageId = randomUUID();
  emit({
    type: "chat.start",
    runId,
    threadId: thread.id,
    messageId: assistantMessageId,
  });

  if (!binary) {
    emit({
      type: "chat.error",
      runId,
      threadId: thread.id,
      message:
        "Codex is not installed. Install the Codex CLI or set OPENBOT_CODEX_BIN.",
    });
    return;
  }

  const subscription = isOpenAIChatGptProvider(record);
  const env: NodeJS.ProcessEnv = { ...process.env };
  let bridge: ResponsesBridge | null = null;
  const args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-c",
    'default_tools_approval_mode="approve"',
    "-c",
    `tool_timeout_sec=${TOOL_TIMEOUT_SECONDS}`,
    "-m",
    model.model,
  ];
  for (const entry of mcpServerArgs(bot.id, deps.sandboxUrl)) {
    args.push("-c", entry);
  }

  if (!subscription) {
    bridge = await startResponsesBridge({
      upstreamBaseUrl: record.baseUrl,
      upstreamApiKey: deps.resolveProviderKey(record),
      upstreamModel: model.model,
      port: 0,
    });
    const isolatedHome = join(deps.dataDir, "codex-home");
    mkdirSync(isolatedHome, { recursive: true });
    rmSync(join(isolatedHome, "auth.json"), { force: true });
    env.CODEX_HOME = isolatedHome;
    env.OPENBOT_UPSTREAM_API_KEY =
      deps.resolveProviderKey(record) ?? "unused";
    args.push(
      "-c",
      'model_provider="openbot"',
      "-c",
      `model_providers.openbot={name="OpenBot bridge", base_url=${tomlString(`${bridge.url}`)}, env_key="OPENBOT_UPSTREAM_API_KEY", wire_api="responses"}`,
      "-c",
      `chatgpt_base_url=${tomlString(`http://127.0.0.1:${bridge.port}`)}`,
      "-c",
      "features.apps=false",
      "-c",
      "features.remote_plugin=false",
      "-c",
      "features.plugins=false",
    );
  }

  const messages = deps.store.listMessages(thread.id);
  const prompt = [
    bot.systemPrompt,
    "You are driving this bot through the OpenBot daemon. The mcp__openbot tools (shell, read_file, write_file, browser) run inside the bot's own Linux microVM and are the right way to act on the computer. Report what actually happened and keep replies concise.",
    `Conversation so far:\n${renderTranscript(messages)}`,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  const workspaceDir = join(deps.dataDir, "codex", "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  let content = "";
  let finalText = "";
  let turnUsage: TokenUsage | null = null;
  let turnError: string | null = null;
  let stderrTail = "";
  const records: ToolCallRecord[] = [];
  const started = new Map<string, number>();
  const finished = new Set<string>();
  const emittedText = new Map<string, string>();

  const emitText = (messageId: string, text: string): void => {
    const previous = emittedText.get(messageId) ?? "";
    if (text.startsWith(previous)) {
      const delta = text.slice(previous.length);
      if (!delta) return;
      emittedText.set(messageId, text);
      content += delta;
      emit({
        type: "chat.delta",
        runId,
        threadId: thread.id,
        messageId: assistantMessageId,
        text: delta,
      });
      return;
    }
    emittedText.set(messageId, text);
    if (!text) return;
    content = text;
    emit({
      type: "chat.delta",
      runId,
      threadId: thread.id,
      messageId: assistantMessageId,
      text,
    });
  };

  const finishTool = (
    callId: string,
    name: string,
    callArguments: string,
    ok: boolean,
    output: string,
    artifacts: ToolArtifact[] | null,
  ): void => {
    if (finished.has(callId)) return;
    finished.add(callId);
    const durationMs = Math.max(0, Date.now() - (started.get(callId) ?? Date.now()));
    const record: ToolCallRecord = {
      id: callId,
      name,
      arguments: callArguments,
      output,
      ok,
      durationMs,
      artifacts,
    };
    records.push(record);
    emit({
      type: "tool.result",
      runId,
      threadId: thread.id,
      callId,
      ok,
      output,
      durationMs,
      artifacts,
    });
  };

  const handleItem = (
    phase: "started" | "updated" | "completed",
    item: Record<string, unknown>,
  ): void => {
    const type = String(item.type ?? "");
    const itemId = String(item.id ?? randomUUID());
    const itemStatus = String(item.status ?? "");

    if (type === "agent_message") {
      const text = typeof item.text === "string" ? item.text : "";
      emitText(itemId, text);
      if (phase === "completed") {
        finalText = text;
      }
      return;
    }
    if (type === "reasoning") {
      const text =
        typeof item.text === "string"
          ? item.text
          : typeof item.summary === "string"
            ? item.summary
            : "";
      const previous = emittedText.get(`reasoning:${itemId}`) ?? "";
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      if (delta) {
        emittedText.set(`reasoning:${itemId}`, text);
        emit({
          type: "chat.reasoning",
          runId,
          threadId: thread.id,
          messageId: assistantMessageId,
          text: delta,
        });
      }
      return;
    }
    if (type === "mcp_tool_call") {
      const name = String(item.tool ?? "tool");
      const callArguments =
        item.arguments === undefined ? "{}" : JSON.stringify(item.arguments);
      if (phase === "started") {
        started.set(itemId, Date.now());
        emit({
          type: "tool.start",
          runId,
          threadId: thread.id,
          callId: itemId,
          name,
          arguments: callArguments,
        });
        return;
      }
      if (phase === "completed") {
        const artifacts: ToolArtifact[] = [];
        const output = extractResultText(item.result, deps.artifactsDir, artifacts);
        const error =
          typeof item.error === "string" && item.error ? item.error : null;
        finishTool(
          itemId,
          name,
          callArguments,
          itemStatus !== "failed" && !error,
          error ? `${output}\n${error}`.trim() : output,
          artifacts.length ? artifacts : null,
        );
      }
      return;
    }
    if (type === "command_execution") {
      const command =
        typeof item.command === "string" ? item.command : String(item.command ?? "");
      const callArguments = JSON.stringify({ command });
      if (phase === "started") {
        started.set(itemId, Date.now());
        emit({
          type: "tool.start",
          runId,
          threadId: thread.id,
          callId: itemId,
          name: "shell",
          arguments: callArguments,
        });
        return;
      }
      if (phase === "completed") {
        const exitCode =
          typeof item.exit_code === "number" ? item.exit_code : null;
        const output =
          typeof item.aggregated_output === "string"
            ? item.aggregated_output
            : [item.stdout, item.stderr]
                .filter((part): part is string => typeof part === "string")
                .join("\n");
        finishTool(
          itemId,
          "shell",
          callArguments,
          itemStatus !== "failed" && (exitCode ?? 0) === 0,
          output,
          null,
        );
      }
    }
  };

  const child = spawn(binary, [...args, prompt], {
    cwd: workspaceDir,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    const descendants = child.pid ? processTree(child.pid) : [];
    killProcess(child, "SIGTERM");
    killPids(descendants, "SIGTERM");
    killTimer = setTimeout(() => {
      killProcess(child, "SIGKILL");
      killPids(descendants, "SIGKILL");
    }, KILL_GRACE_MS);
    killTimer.unref();
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const stdout = createInterface({ input: child.stdout! });
  stdout.on("line", (line) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type ?? "");
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = event.item;
      if (item && typeof item === "object") {
        handleItem(
          type.slice("item.".length) as "started" | "updated" | "completed",
          item as Record<string, unknown>,
        );
      }
      return;
    }
    if (type === "turn.completed") {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        turnUsage = addUsage(turnUsage, {
          inputTokens:
            typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          outputTokens:
            typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        });
      }
      return;
    }
    if (type === "turn.failed") {
      const error = event.error as Record<string, unknown> | undefined;
      turnError =
        error && typeof error.message === "string"
          ? error.message
          : "codex turn failed";
      return;
    }
    if (type === "error" && typeof event.message === "string") {
      turnError = event.message;
    }
  });

  child.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-4_000);
  });

  const exited = await new Promise<{ code: number | null; error: Error | null }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("close", (code) => resolve({ code, error: null }));
    },
  );

  stdout.close();
  if (killTimer) {
    clearTimeout(killTimer);
  }
  signal.removeEventListener("abort", onAbort);
  if (bridge) {
    await bridge.close().catch(() => undefined);
  }

  if (signal.aborted) {
    if (content.length > 0) {
      deps.store.addMessage({
        id: assistantMessageId,
        threadId: thread.id,
        role: "assistant",
        content,
        model,
        toolCalls: records.length ? records : null,
        usage: turnUsage,
      });
      deps.store.touchThread(thread.id);
    }
    emit({
      type: "chat.error",
      runId,
      threadId: thread.id,
      message: "cancelled",
    });
    return;
  }

  if (turnError || exited.error || exited.code !== 0) {
    const stderrDetail = stderrTail.trim().split("\n").slice(-3).join("\n");
    emit({
      type: "chat.error",
      runId,
      threadId: thread.id,
      message:
        turnError ??
        exited.error?.message ??
        (stderrDetail || `codex exited with code ${exited.code ?? "unknown"}`),
    });
    return;
  }

  const message = deps.store.addMessage({
    id: assistantMessageId,
    threadId: thread.id,
    role: "assistant",
    content: finalText || content,
    model,
    toolCalls: records.length ? records : null,
    usage: turnUsage,
  });
  const refreshed = deps.store.touchThread(thread.id);
  if (refreshed) {
    emit({ type: "thread.upserted", thread: refreshed });
  }
  emit({ type: "chat.done", runId, threadId: thread.id, message });
}
