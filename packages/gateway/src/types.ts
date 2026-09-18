export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Sent as `reasoning_effort`; unset keeps the provider default. */
  reasoningEffort?: ReasoningEffort;
}

/** Mirrors ReasoningEffortSchema in @openbot/protocol. */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ChatEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; finishReason?: string };

export interface ProviderInfo {
  id: string;
  label: string;
  models: string[];
}

export interface ChatProvider {
  info: ProviderInfo;
  chat(request: ChatRequest): AsyncIterable<ChatEvent>;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  kind: "openai-compatible";
  baseUrl: string;
  apiKey?: string | null;
  apiKeyEnv?: string | null;
  models: string[];
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string | null;
  models: string[];
}
