/**
 * Focused checks for the host-side web search (the `web_search` tool).
 *
 * The client is deterministic: the MCP wire format is exercised against a
 * throwaway HTTP server that speaks the same JSON-RPC and SSE shapes as Exa
 * and Parallel, and the tool is registered on every computer, including
 * This Mac. The live provider check is opt-in because it needs the network:
 *
 *   OPENBOT_WEBSEARCH_LIVE=1 pnpm websearch:smoke
 *
 * Run with `pnpm websearch:smoke`.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ToolCallRecord } from "@openbot/protocol";
import { findTool, toolDefinitions, type ToolContext } from "./tools";
import {
  annotateWebSearchObservation,
  buildEvidenceLedger,
  shouldAuditCompletion,
} from "./task-harness";
import {
  EXA_MCP_URL,
  PARALLEL_MCP_URL,
  parseMcpText,
  runWebSearch,
  selectWebSearchProvider,
  webSearchEndpoint,
} from "./websearch";

const context: ToolContext = {
  botId: "websearch-smoke",
  computer: "mac",
  sandbox: null,
  workspaceDir: "/tmp/openbot-websearch-smoke",
  artifactsDir: "/tmp/openbot-websearch-smoke/artifacts",
  decision: null,
  vision: false,
  onSandboxState: () => {},
};

interface CapturedRequest {
  url: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

interface MockServer {
  url: string;
  last: () => CapturedRequest | null;
  close: () => Promise<void>;
}

async function startMock(
  responder: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<MockServer> {
  let last: CapturedRequest | null = null;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      last = {
        url: request.url ?? "",
        method: request.method ?? "",
        headers: request.headers,
        body,
      };
      responder(last, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "mock server should bind");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    last: () => last,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function mcpPayload(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  });
}

function ssePayload(text: string): string {
  return `event: message\ndata: ${mcpPayload(text)}\n\n`;
}

const checks: Array<[string, () => Promise<void>]> = [];
function check(name: string, body: () => Promise<void>): void {
  checks.push([name, body]);
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

check("parseMcpText reads a plain JSON result", async () => {
  assert.equal(parseMcpText(mcpPayload("hello web")), "hello web");
});

check("parseMcpText reads an SSE stream", async () => {
  assert.equal(parseMcpText(ssePayload("hello sse")), "hello sse");
});

check("parseMcpText skips non-text content items", async () => {
  const body = JSON.stringify({
    result: { content: [{ type: "image", data: "abc" }, { type: "text", text: "picked" }] },
  });
  assert.equal(parseMcpText(body), "picked");
});

check("parseMcpText returns null for garbage and empty content", async () => {
  assert.equal(parseMcpText("<html>not mcp</html>"), null);
  assert.equal(parseMcpText(""), null);
  assert.equal(parseMcpText(JSON.stringify({ result: { content: [] } })), null);
  assert.equal(parseMcpText("data: {not json"), null);
});

// ---------------------------------------------------------------------------
// provider selection
// ---------------------------------------------------------------------------

check("selectWebSearchProvider defaults to exa", async () => {
  assert.equal(selectWebSearchProvider({}), "exa");
});

check("selectWebSearchProvider honours the explicit override", async () => {
  assert.equal(
    selectWebSearchProvider({
      OPENBOT_WEBSEARCH_PROVIDER: "parallel",
      EXA_API_KEY: "present",
    }),
    "parallel",
  );
  assert.equal(
    selectWebSearchProvider({ OPENBOT_WEBSEARCH_PROVIDER: "exa" }),
    "exa",
  );
  assert.equal(
    selectWebSearchProvider({ OPENBOT_WEBSEARCH_PROVIDER: "nonsense" }),
    "exa",
  );
});

check("selectWebSearchProvider picks parallel when only that key exists", async () => {
  assert.equal(
    selectWebSearchProvider({ PARALLEL_API_KEY: "p" }),
    "parallel",
  );
  assert.equal(
    selectWebSearchProvider({ PARALLEL_API_KEY: "p", EXA_API_KEY: "e" }),
    "exa",
  );
});

check("webSearchEndpoint appends the Exa key and leaves Parallel alone", async () => {
  assert.equal(webSearchEndpoint("exa", {}), EXA_MCP_URL);
  assert.equal(
    webSearchEndpoint("exa", { EXA_API_KEY: "k ey" }),
    `${EXA_MCP_URL}?exaApiKey=k%20ey`,
  );
  assert.equal(webSearchEndpoint("parallel", { PARALLEL_API_KEY: "p" }), PARALLEL_MCP_URL);
});

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

check("runWebSearch sends a JSON-RPC tools/call and returns the text", async () => {
  const mock = await startMock((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(ssePayload("Title: Example\nURL: https://example.com\nBody"));
  });
  try {
    const result = await runWebSearch({
      query: "example query",
      url: mock.url,
      numResults: 3,
      type: "deep",
    });
    assert.equal(result.provider, "exa");
    assert.equal(
      result.text,
      "Title: Example\nURL: https://example.com\nBody",
    );
    const sent = mock.last();
    assert.ok(sent, "the mock server should have seen a request");
    assert.equal(sent.method, "POST");
    assert.match(sent.url, /\/mcp$/);
    assert.equal(sent.body.method, "tools/call");
    const params = sent.body.params as {
      name: string;
      arguments: Record<string, unknown>;
    };
    assert.equal(params.name, "web_search_exa");
    assert.equal(params.arguments.query, "example query");
    assert.equal(params.arguments.numResults, 3);
    assert.equal(params.arguments.type, "deep");
    assert.equal(params.arguments.livecrawl, "fallback");
  } finally {
    await mock.close();
  }
});

check("runWebSearch uses the Parallel tool and key when selected", async () => {
  const mock = await startMock((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(mcpPayload("parallel results"));
  });
  try {
    const result = await runWebSearch({
      query: "who won",
      provider: "parallel",
      url: mock.url,
      env: { PARALLEL_API_KEY: "secret" },
    });
    assert.equal(result.provider, "parallel");
    assert.equal(result.text, "parallel results");
    const sent = mock.last();
    assert.ok(sent);
    assert.equal(sent.headers.authorization, "Bearer secret");
    const params = sent.body.params as {
      name: string;
      arguments: Record<string, unknown>;
    };
    assert.equal(params.name, "web_search");
    assert.equal(params.arguments.objective, "who won");
    assert.deepEqual(params.arguments.search_queries, ["who won"]);
  } finally {
    await mock.close();
  }
});

check("runWebSearch reports an HTTP failure", async () => {
  const mock = await startMock((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("upstream exploded");
  });
  try {
    await assert.rejects(
      runWebSearch({ query: "x", url: mock.url }),
      /Exa Web Search returned HTTP 500/,
    );
  } finally {
    await mock.close();
  }
});

check("runWebSearch returns null text when the provider is empty", async () => {
  const mock = await startMock((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { content: [] } }));
  });
  try {
    const result = await runWebSearch({ query: "x", url: mock.url });
    assert.equal(result.text, null);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// tool wiring
// ---------------------------------------------------------------------------

check("web_search is registered and offered on both computers", async () => {
  assert.ok(findTool("web_search"), "the tool should be registered");
  for (const computer of ["firecracker", "mac"] as const) {
    const names = toolDefinitions(computer).map((definition) => definition.name);
    assert.ok(
      names.includes("web_search"),
      `web_search should be offered on ${computer}`,
    );
  }
});

check("the tool refuses an empty query without a network call", async () => {
  const tool = findTool("web_search");
  assert.ok(tool);
  const result = await tool.execute(context, { query: "   " });
  assert.equal(result.ok, false);
  assert.match(result.output, /query is required/);
});

// ---------------------------------------------------------------------------
// completion-audit evidence
// ---------------------------------------------------------------------------

function searchRecord(output: string): ToolCallRecord {
  return {
    id: "call-web-1",
    name: "web_search",
    arguments: JSON.stringify({ query: "example" }),
    output,
    ok: true,
    durationMs: 5,
    artifacts: null,
  };
}

check("a web search triggers the completion audit", async () => {
  assert.equal(shouldAuditCompletion([searchRecord("plain")]), true);
});

check("web search observations are annotated as search results", async () => {
  assert.match(
    annotateWebSearchObservation("Title: x", true, 1),
    /^\[evidence websearch-002; source=search-results\]\nTitle: x$/,
  );
  assert.match(
    annotateWebSearchObservation("boom", false, 0),
    /^\[evidence websearch-001; source=failed\]/,
  );
});

check("web search evidence keeps its observation id and search source", async () => {
  const annotated =
    "[evidence websearch-002; source=search-results]\n" +
    "Title: Example\nURL: https://example.com/page\nBody";
  const ledger = buildEvidenceLedger([searchRecord(annotated)]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.id, "websearch-002");
  assert.equal(ledger[0]?.kind, "search-results");
  assert.equal(ledger[0]?.url, "https://example.com/page");
});

check("browser and web search ids do not collide in the ledger", async () => {
  const browser: ToolCallRecord = {
    id: "call-browser-1",
    name: "browser",
    arguments: JSON.stringify({ action: "goto" }),
    output: "[evidence browser-001; source=direct-page]\nurl: https://site.test",
    ok: true,
    durationMs: 5,
    artifacts: null,
  };
  const ledger = buildEvidenceLedger([
    browser,
    searchRecord(
      "[evidence websearch-002; source=search-results]\nURL: https://search.test",
    ),
  ]);
  assert.deepEqual(
    ledger.map((observation) => observation.id),
    ["browser-001", "websearch-002"],
  );
  assert.deepEqual(
    ledger.map((observation) => observation.kind),
    ["direct-page", "search-results"],
  );
});

// ---------------------------------------------------------------------------
// live provider (opt-in)
// ---------------------------------------------------------------------------

if (process.env.OPENBOT_WEBSEARCH_LIVE === "1") {
  check("live: the tool returns real results", async () => {
    const tool = findTool("web_search");
    assert.ok(tool);
    const result = await tool.execute(context, {
      query: "Cloudflare Durable Objects what are they",
      numResults: 2,
    });
    assert.equal(result.ok, true, `live search failed: ${result.output}`);
    assert.ok(result.output.length > 100, "expected real page content");
  });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let failed = 0;
for (const [name, body] of checks) {
  try {
    await body();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${(error as Error).message.split("\n").join("\n     ")}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks.length} web search checks failed`);
  process.exit(1);
}
console.log(`\nWEB SEARCH OK — ${checks.length} checks passed`);
