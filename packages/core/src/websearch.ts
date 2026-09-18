/**
 * Host-side web search over hosted MCP endpoints.
 *
 * The daemon calls the same MCP servers opencode uses — Exa
 * (https://mcp.exa.ai/mcp) and Parallel (https://search.parallel.ai/mcp) —
 * with a plain JSON-RPC `tools/call`, so search works without a browser, a
 * microVM, or any SDK. Both endpoints work without a key; EXA_API_KEY and
 * PARALLEL_API_KEY are optional and only raise rate limits. The response is
 * an LLM-ready context string, returned as-is to the model.
 *
 * This is deliberately separate from the sandbox browser tools: it runs in
 * the daemon process and therefore also works when the agent's computer is
 * "This Mac", where the browser tools are unavailable.
 */

export type WebSearchProvider = "exa" | "parallel";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

export const WEB_SEARCH_DEFAULT_RESULTS = 8;
export const WEB_SEARCH_DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Pick the provider: an explicit OPENBOT_WEBSEARCH_PROVIDER wins, then a key
 * for exactly one of the services, then Exa. Exa is the default because its
 * endpoint is keyless.
 */
export function selectWebSearchProvider(
  env: Record<string, string | undefined> = process.env,
): WebSearchProvider {
  const override = env.OPENBOT_WEBSEARCH_PROVIDER?.trim().toLowerCase();
  if (override === "exa" || override === "parallel") {
    return override;
  }
  if (!env.EXA_API_KEY?.trim() && env.PARALLEL_API_KEY?.trim()) {
    return "parallel";
  }
  return "exa";
}

export function webSearchProviderLabel(provider: WebSearchProvider): string {
  return provider === "parallel" ? "Parallel Web Search" : "Exa Web Search";
}

interface McpContentItem {
  type?: unknown;
  text?: unknown;
}

function textFromPayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      result?: { content?: McpContentItem[] };
    };
    const content = parsed.result?.content;
    if (!Array.isArray(content)) {
      return null;
    }
    const item = content.find(
      (entry) => typeof entry?.text === "string" && entry.text.length > 0,
    );
    return item && typeof item.text === "string" ? item.text : null;
  } catch {
    return null;
  }
}

/**
 * The MCP servers answer with either plain JSON or an SSE stream
 * (`event: message` then `data: {...}`); accept both, like opencode does.
 */
export function parseMcpText(body: string): string | null {
  const direct = textFromPayload(body);
  if (direct) {
    return direct;
  }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const text = textFromPayload(line.slice(6));
    if (text) {
      return text;
    }
  }
  return null;
}

export interface WebSearchInput {
  query: string;
  provider?: WebSearchProvider;
  numResults?: number;
  type?: "auto" | "fast" | "deep";
  livecrawl?: "fallback" | "preferred";
  contextMaxCharacters?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Endpoint override for tests; keys are not appended when set. */
  url?: string;
  env?: Record<string, string | undefined>;
}

export interface WebSearchOutcome {
  provider: WebSearchProvider;
  /** The provider's context text, or null when it returned no content. */
  text: string | null;
}

export function webSearchEndpoint(
  provider: WebSearchProvider,
  env: Record<string, string | undefined> = process.env,
): string {
  if (provider === "parallel") {
    return PARALLEL_MCP_URL;
  }
  const key = env.EXA_API_KEY?.trim();
  return key ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(key)}` : EXA_MCP_URL;
}

function requestArgs(
  provider: WebSearchProvider,
  input: WebSearchInput,
): Record<string, unknown> {
  if (provider === "parallel") {
    return {
      objective: input.query,
      search_queries: [input.query],
    };
  }
  return {
    query: input.query,
    type: input.type ?? "auto",
    numResults: input.numResults ?? WEB_SEARCH_DEFAULT_RESULTS,
    livecrawl: input.livecrawl ?? "fallback",
    ...(typeof input.contextMaxCharacters === "number"
      ? { contextMaxCharacters: input.contextMaxCharacters }
      : {}),
  };
}

/**
 * Run one search. Throws on transport or provider errors; a provider that
 * answered successfully but had no content returns `text: null`.
 */
export async function runWebSearch(
  input: WebSearchInput,
): Promise<WebSearchOutcome> {
  const env = input.env ?? process.env;
  const provider = input.provider ?? selectWebSearchProvider(env);
  const tool = provider === "parallel" ? "web_search" : "web_search_exa";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": "openbot/0.1.0",
  };
  const parallelKey = env.PARALLEL_API_KEY?.trim();
  if (provider === "parallel" && parallelKey) {
    headers.authorization = `Bearer ${parallelKey}`;
  }

  const timeout = AbortSignal.timeout(
    input.timeoutMs ?? WEB_SEARCH_DEFAULT_TIMEOUT_MS,
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;

  const response = await fetch(input.url ?? webSearchEndpoint(provider, env), {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: requestArgs(provider, input) },
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${webSearchProviderLabel(provider)} returned HTTP ${response.status}` +
        (detail ? `: ${detail.slice(0, 300)}` : ""),
    );
  }

  const body = await response.text();
  return { provider, text: parseMcpText(body) };
}
