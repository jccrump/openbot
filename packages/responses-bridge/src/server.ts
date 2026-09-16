import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface ResponsesBridgeOptions {
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  upstreamModel?: string;
  port?: number;
}

export interface ResponsesBridge {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface ResponsesRequestBody {
  model?: string;
  instructions?: string;
  input?: unknown;
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
}

interface OutputItem {
  id: string;
  type: "message" | "function_call";
  role?: string;
  status?: string;
  content?: Array<{ type: string; text: string }>;
  name?: string;
  namespace?: string;
  arguments?: string;
  call_id?: string;
}

interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  outputIndex: number;
  added: boolean;
}

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
      }
      return "";
    })
    .join("");
}

function toChatMessages(body: ResponsesRequestBody): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = Array.isArray(body.input)
    ? body.input
    : typeof body.input === "string"
      ? [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: body.input }],
          },
        ]
      : [];

  for (const rawItem of input) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const type = String(item.type ?? "message");

    if (type === "message") {
      messages.push({
        role: String(item.role ?? "user"),
        content: extractText(item.content),
      });
      continue;
    }
    if (type === "function_call") {
      const namespace =
        typeof item.namespace === "string" && item.namespace
          ? `${item.namespace}__`
          : "";
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: String(item.call_id ?? item.id ?? `call_${messages.length}`),
            type: "function",
            function: {
              name: `${namespace}${String(item.name ?? "")}`,
              arguments:
                typeof item.arguments === "string"
                  ? item.arguments
                  : JSON.stringify(item.arguments ?? {}),
            },
          },
        ],
      });
      continue;
    }
    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? ""),
        content: extractText(item.output),
      });
      continue;
    }
    if (type === "reasoning") {
      const text = extractText(item.summary ?? item.content);
      if (text) {
        messages.push({ role: "assistant", content: text });
      }
    }
  }
  return messages;
}

function toChatTools(tools: Array<Record<string, unknown>> | undefined): {
  tools: ChatTool[];
  namespaces: Map<string, { namespace: string; name: string }>;
} {
  const result: ChatTool[] = [];
  const namespaces = new Map<string, { namespace: string; name: string }>();
  for (const tool of tools ?? []) {
    if (tool.type === "function" && typeof tool.name === "string") {
      result.push({
        type: "function",
        function: {
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          parameters: tool.parameters ?? { type: "object", properties: {} },
        },
      });
      continue;
    }
    if (
      tool.type === "namespace" &&
      typeof tool.name === "string" &&
      Array.isArray(tool.tools)
    ) {
      for (const raw of tool.tools) {
        if (!raw || typeof raw !== "object") continue;
        const nested = raw as Record<string, unknown>;
        if (nested.type !== "function" || typeof nested.name !== "string") {
          continue;
        }
        const flat = `${tool.name}__${nested.name}`;
        namespaces.set(flat, { namespace: tool.name, name: nested.name });
        result.push({
          type: "function",
          function: {
            name: flat,
            description:
              typeof nested.description === "string"
                ? nested.description
                : typeof tool.description === "string"
                  ? tool.description
                  : "",
            parameters:
              nested.parameters ?? { type: "object", properties: {} },
          },
        });
      }
    }
  }
  return { tools: result, namespaces };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) {
        yield line.slice(5).trim();
      }
      index = buffer.indexOf("\n");
    }
  }
}

async function handleResponses(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    upstreamBase: string;
    upstreamKey: string;
    upstreamModel: string;
  },
) {
  const body = JSON.parse(await readBody(request)) as ResponsesRequestBody;
  const model = options.upstreamModel || body.model || "unknown";
  const messages = toChatMessages(body);
  const { tools, namespaces } = toChatTools(body.tools);

  const upstream = await fetch(`${options.upstreamBase}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.upstreamKey
        ? { authorization: `Bearer ${options.upstreamKey}` }
        : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      ...(body.temperature !== undefined
        ? { temperature: body.temperature }
        : {}),
      ...(body.max_output_tokens !== undefined
        ? { max_tokens: body.max_output_tokens }
        : {}),
    }),
  });

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (type: string, payload: Record<string, unknown>) => {
    response.write(`event: ${type}\n`);
    response.write(
      `data: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`,
    );
  };
  let sequence = 1;

  const responseId = `resp_${Date.now().toString(36)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model,
    output: [] as OutputItem[],
    output_text: "",
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    instructions: body.instructions ?? null,
    metadata: {},
    temperature: body.temperature ?? null,
    top_p: null,
    max_output_tokens: body.max_output_tokens ?? null,
    store: false,
    truncation: "disabled",
    incomplete_details: null,
    error: null,
    usage: null,
  };
  send("response.created", { response: baseResponse });

  const output: OutputItem[] = [];
  const toolCalls = new Map<number, ToolCallState>();
  let messageItem: OutputItem | null = null;
  let messageIndex = -1;
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | null = null;

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    send("response.failed", {
      response: {
        ...baseResponse,
        status: "failed",
        error: { code: "upstream_error", message: text.slice(0, 500) },
      },
    });
    response.end();
    return;
  }

  const itemForCall = (call: ToolCallState): OutputItem => {
    const mapped = namespaces.get(call.name);
    return {
      id: call.id,
      type: "function_call",
      ...(mapped
        ? { name: mapped.name, namespace: mapped.namespace }
        : { name: call.name }),
      arguments: call.arguments,
      call_id: call.id,
      status: "in_progress",
    };
  };

  for await (const data of parseSSE(upstream.body)) {
    if (data === "[DONE]") break;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (payload.usage) {
      usage = payload.usage as Record<string, unknown>;
    }
    const choice = (payload.choices as Array<Record<string, unknown>>)?.[0];
    if (!choice) continue;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!messageItem) {
        messageItem = {
          id: `msg_${Date.now().toString(36)}`,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [{ type: "output_text", text: "" }],
        };
        messageIndex = output.length;
        output.push(messageItem);
        send("response.output_item.added", {
          output_index: messageIndex,
          item: { ...messageItem, content: [{ type: "output_text", text: "" }] },
        });
        send("response.content_part.added", {
          item_id: messageItem.id,
          output_index: messageIndex,
          content_index: 0,
          part: { type: "output_text", text: "" },
        });
      }
      send("response.output_text.delta", {
        item_id: messageItem.id,
        output_index: messageIndex,
        content_index: 0,
        delta: delta.content,
      });
      const part = messageItem.content![0];
      if (part) {
        part.text += delta.content;
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const partial of delta.tool_calls as Array<Record<string, unknown>>) {
        const index = typeof partial.index === "number" ? partial.index : 0;
        let call = toolCalls.get(index);
        if (!call) {
          const fn = (partial.function ?? {}) as Record<string, unknown>;
          call = {
            id: String(partial.id ?? fn.id ?? `call_${index}`),
            name: "",
            arguments: "",
            outputIndex: output.length,
            added: false,
          };
          toolCalls.set(index, call);
          output.push(itemForCall(call));
        }
        const fn = (partial.function ?? {}) as Record<string, unknown>;
        if (typeof partial.id === "string" && partial.id && call.id.startsWith("call_")) {
          call.id = partial.id;
        }
        if (typeof fn.name === "string" && fn.name && !call.name) {
          call.name = fn.name;
        }
        if (call.name && !call.added) {
          call.added = true;
          const item = itemForCall(call);
          output[call.outputIndex] = item;
          send("response.output_item.added", {
            output_index: call.outputIndex,
            item,
          });
        }
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          call.arguments += fn.arguments;
          if (call.added) {
            send("response.function_call_arguments.delta", {
              item_id: call.id,
              output_index: call.outputIndex,
              delta: fn.arguments,
            });
          }
        }
      }
    }

    if (typeof choice.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }
  }

  if (messageItem) {
    const text = messageItem.content?.[0]?.text ?? "";
    send("response.output_text.done", {
      item_id: messageItem.id,
      output_index: messageIndex,
      content_index: 0,
      text,
    });
    send("response.content_part.done", {
      item_id: messageItem.id,
      output_index: messageIndex,
      content_index: 0,
      part: { type: "output_text", text },
    });
    messageItem.status = "completed";
    send("response.output_item.done", {
      output_index: messageIndex,
      item: messageItem,
    });
  }

  for (const call of toolCalls.values()) {
    if (!call.added) {
      call.added = true;
      output[call.outputIndex] = itemForCall(call);
      send("response.output_item.added", {
        output_index: call.outputIndex,
        item: output[call.outputIndex],
      });
    }
    send("response.function_call_arguments.done", {
      item_id: call.id,
      output_index: call.outputIndex,
      arguments: call.arguments,
    });
    const item = output[call.outputIndex];
    if (item) {
      item.arguments = call.arguments;
      item.status = "completed";
      send("response.output_item.done", {
        output_index: call.outputIndex,
        item,
      });
    }
  }

  send("response.completed", {
    response: {
      ...baseResponse,
      status: "completed",
      finish_reason: finishReason ?? "stop",
      output,
      output_text: messageItem?.content?.[0]?.text ?? "",
      usage: usage
        ? {
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
          }
        : null,
    },
  });
  response.end();
}

export function startResponsesBridge(
  options: ResponsesBridgeOptions,
): Promise<ResponsesBridge> {
  const upstreamBase = options.upstreamBaseUrl.replace(/\/+$/, "");
  const upstreamKey = options.upstreamApiKey ?? "";
  const upstreamModel = options.upstreamModel ?? "";

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, upstream: upstreamBase }));
        return;
      }
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: upstreamModel || "openbot",
                object: "model",
                owned_by: "openbot",
              },
            ],
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/responses")) {
        await handleResponses(request, response, {
          upstreamBase,
          upstreamKey,
          upstreamModel,
        });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      log(`request failed: ${(error as Error).message}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: (error as Error).message }));
      } else {
        response.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const port =
        typeof address === "object" && address !== null
          ? address.port
          : (options.port ?? 0);
      resolve({
        port,
        url: `http://127.0.0.1:${port}/v1`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.closeAllConnections();
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      });
    });
  });
}
