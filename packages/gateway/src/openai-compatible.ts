import type {
  ChatEvent,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ProviderInfo,
  TokenUsage,
  ToolCall,
} from "./types";

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content ?? "",
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

export function createOpenAICompatibleProvider(
  options: OpenAICompatibleOptions,
): ChatProvider {
  const info: ProviderInfo = {
    id: options.id,
    label: options.label,
    models: options.models,
  };

  return {
    info,
    async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
      const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map(toWireMessage),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
        body.tool_choice = "auto";
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey
            ? { authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `provider ${options.id} returned HTTP ${response.status}: ${text.slice(0, 500)}`,
        );
      }

      const toolCalls = new Map<number, ToolCall>();
      let finishReason: string | undefined;
      let usage: TokenUsage | null = null;

      for await (const data of parseSSE(response.body)) {
        if (data === "[DONE]") break;
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        usage = parseUsage(payload) ?? usage;
        const choice = (payload as { choices?: Array<Record<string, unknown>> })
          .choices?.[0];
        if (!choice) continue;
        const delta = (choice.delta ?? {}) as Record<string, unknown>;

        const reasoning = extractReasoning(delta);
        if (reasoning) {
          yield { type: "reasoning_delta", text: reasoning };
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text_delta", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const partial of delta.tool_calls as Array<
            Record<string, unknown>
          >) {
            const index =
              typeof partial.index === "number" ? partial.index : 0;
            const current =
              toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof partial.id === "string" && partial.id) {
              current.id = partial.id;
            }
            const fn = (partial.function ?? {}) as Record<string, unknown>;
            if (typeof fn.name === "string" && fn.name) {
              current.name = fn.name;
            }
            if (typeof fn.arguments === "string") {
              current.arguments += fn.arguments;
            }
            toolCalls.set(index, current);
          }
        }
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
      }

      if (toolCalls.size > 0) {
        yield {
          type: "tool_calls",
          calls: [...toolCalls.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, call]) => call),
        };
      }
      if (usage) {
        yield { type: "usage", usage };
      }
      yield { type: "done", finishReason };
    },
  };
}

function extractReasoning(delta: Record<string, unknown>): string {
  for (const key of ["reasoning_content", "reasoning", "thinking"]) {
    const value = delta[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (value && typeof value === "object") {
      const text = (value as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        return text;
      }
    }
  }
  return "";
}

function parseUsage(payload: unknown): TokenUsage | null {
  const usage = (payload as { usage?: Record<string, unknown> | null }).usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") {
    return null;
  }
  return { inputTokens: input, outputTokens: output };
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

  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    yield tail.slice(5).trim();
  }
}
