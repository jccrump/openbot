import { createServer } from "node:http";

const port = Number(process.env.MOCK_MODEL_PORT ?? 43171);
const wordDelayMs = Number(process.env.MOCK_MODEL_DELAY ?? 30);

function sseWrite(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamText(response, text, onDone) {
  const words = text.split(" ");
  let index = 0;
  const timer = setInterval(() => {
    if (index >= words.length) {
      clearInterval(timer);
      onDone();
      return;
    }
    const chunk = index === 0 ? words[index] : ` ${words[index]}`;
    sseWrite(response, { choices: [{ delta: { content: chunk } }] });
    index += 1;
  }, wordDelayMs);
  response.on("close", () => clearInterval(timer));
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, name: "mock-model" }));
    return;
  }
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          { id: "deepseek-v4-flash" },
          { id: "deepseek-v4-pro" },
          { id: "mock-reasoner" },
        ],
      }),
    );
    return;
  }
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404);
    response.end();
    return;
  }

  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const parsed = JSON.parse(body);
    const messages = parsed.messages ?? [];
    const last = messages[messages.length - 1];

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });

    const finish = () => {
      sseWrite(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
      response.write("data: [DONE]\n\n");
      response.end();
    };

    const wantsTool =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("run:");

    const wantsBrowser =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("browse:");

    const wantsRead =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("read:");

    const wantsWrite =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("write:");

    const emitToolCall = (name, args) => {
      const split = Math.min(8, args.length);
      const callId = `call_mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      sseWrite(response, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: "function",
                  function: { name, arguments: args.slice(0, split) },
                },
              ],
            },
          },
        ],
      });
      setTimeout(() => {
        sseWrite(response, {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: args.slice(split) } },
                ],
              },
            },
          ],
        });
        sseWrite(response, {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
        });
        response.write("data: [DONE]\n\n");
        response.end();
      }, 50);
    };

    if (wantsBrowser) {
      const url = last.content.trim().slice(7).trim();
      emitToolCall("browser", JSON.stringify({ action: "goto", url }));
      return;
    }

    if (wantsRead) {
      const path = last.content.trim().slice(5).trim();
      emitToolCall("read_file", JSON.stringify({ path }));
      return;
    }

    if (wantsWrite) {
      const rest = last.content.trim().slice(6).trim();
      const separator = rest.indexOf("::");
      const path = separator === -1 ? rest : rest.slice(0, separator).trim();
      const content = separator === -1 ? "" : rest.slice(separator + 2).trim();
      emitToolCall("write_file", JSON.stringify({ path, content }));
      return;
    }

    if (wantsTool) {
      const command = last.content.trim().slice(4).trim();
      emitToolCall("shell", JSON.stringify({ command }));
      return;
    }

    if (
      last?.role === "tool" &&
      typeof last.content === "string" &&
      last.content.startsWith("url:") &&
      !last.content.includes("screenshot saved") &&
      Array.isArray(parsed.tools)
    ) {
      emitToolCall("browser", JSON.stringify({ action: "screenshot" }));
      return;
    }

    if (last?.role === "tool") {
      streamText(
        response,
        `Command finished. The computer returned:\n\n${last.content}`,
        finish,
      );
      return;
    }

    const lastUser = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    streamText(
      response,
      `Mock model here. You said: "${lastUser?.content ?? ""}". Wire a real provider in config.json when you're ready.`,
      finish,
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock model listening on http://127.0.0.1:${port}`);
});
