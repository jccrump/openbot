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

function readJson(request) {
  return new Promise((resolvePromise) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolvePromise(JSON.parse(body));
      } catch {
        resolvePromise({});
      }
    });
  });
}

function mockSystemOne(body) {
  const questions =
    body && typeof body.questions === "object" && body.questions
      ? body.questions
      : {};
  const state = body?.state;
  const stateText =
    typeof state === "string" ? state : JSON.stringify(state ?? "");
  const proposedAnswer =
    state && typeof state === "object" && !Array.isArray(state)
      ? String(state.answer ?? state.candidate ?? "")
      : stateText;
  const wantsRepair = proposedAnswer.includes("definitely locally in stock");
  const injected = stateText.includes("IGNORE PREVIOUS INSTRUCTIONS");
  const browseState =
    state && typeof state === "object" && !Array.isArray(state) && "goal" in state;
  const visitedCount = Array.isArray(state?.pages_visited)
    ? state.pages_visited.length
    : 0;

  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!question || typeof question !== "object") {
      continue;
    }
    if (question.type === "noul") {
      let value = 0.95;
      if (id === "overstated" || id === "instruction_override") {
        value = 0.02;
      }
      if (id === "injection") {
        value = injected ? 0.98 : 0.02;
      }
      if (id === "goal_met") {
        value = browseState ? (visitedCount >= 3 ? 0.95 : 0.1) : 0.95;
      }
      if (wantsRepair) {
        value = id === "overstated" ? 0.9 : 0.3;
      }
      answers[id] = { type: "noul", noul: value };
      continue;
    }
    if (question.type === "choice") {
      const keys = Object.keys(question.criteria ?? {});
      let choice = keys[0] ?? "";
      if (id === "verdict") {
        choice = wantsRepair ? "continue" : "pass";
      }
      if (id === "next") {
        const candidate = keys.find(
          (key) => !key.startsWith("__") && key !== "done",
        );
        choice =
          visitedCount < 3 && candidate
            ? candidate
            : keys[keys.length - 1] ?? "";
      }
      if (!keys.includes(choice)) {
        choice = keys[0] ?? "";
      }
      const probabilities = {};
      for (const key of keys) {
        probabilities[key] = key === choice ? 0.9 : 0.1 / Math.max(1, keys.length - 1);
      }
      answers[id] = {
        type: "choice",
        choice,
        probabilities,
        confidence: 0.9,
      };
      continue;
    }
    if (question.type === "score") {
      const levels = Array.isArray(question.criteria) ? question.criteria : [];
      const probabilities = {};
      levels.forEach((_, index) => {
        probabilities[String(index)] = index === 0 ? 0.9 : 0.1 / Math.max(1, levels.length - 1);
      });
      answers[id] = {
        type: "score",
        score: 0,
        legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
        probabilities,
        confidence: 0.9,
      };
    }
  }
  return {
    model: "jev-mock",
    answers,
    usage: { input_tokens: 256, output_tokens: 32 },
  };
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, name: "mock-model" }));
    return;
  }
  if (request.method === "POST" && request.url?.endsWith("/v1/systemone")) {
    readJson(request).then((body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(mockSystemOne(body)));
    });
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

    const systemContent =
      typeof messages.find((message) => message.role === "system")?.content ===
      "string"
        ? messages.find((message) => message.role === "system").content
        : "";
    if (systemContent.includes("[memory extraction]")) {
      sseWrite(response, {
        choices: [
          {
            delta: {
              content: JSON.stringify([
                {
                  type: "relational",
                  content: "The user prefers concise answers in metric units.",
                  importance: 0.7,
                  confidence: 0.9,
                },
                {
                  type: "semantic",
                  content:
                    "The user's weather project is called Buddy Weather.",
                  importance: 0.6,
                  confidence: 0.8,
                },
                {
                  type: "procedural",
                  content:
                    "Use weather.gov and the NWS API for US forecasts instead of aggregator sites.",
                  importance: 0.6,
                  confidence: 0.7,
                },
              ]),
            },
          },
        ],
      });
      finish();
      return;
    }
    if (systemContent.includes("[soul reflection]")) {
      sseWrite(response, {
        choices: [
          {
            delta: {
              content: JSON.stringify({
                voice: "Concise and metric.",
                commitments: [
                  "Prefer metric units.",
                  "Ground every claim in evidence.",
                ],
                relationship: "A weather-focused working partnership.",
                reason: "reflection from recent memories",
              }),
            },
          },
        ],
      });
      finish();
      return;
    }

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

    const wantsBrowserExec =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("exec:");

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

    const wantsSlow =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("slow:");

    const wantsRemember =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("remember:");

    const wantsRecall =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("recall:");

    const wantsSoul =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("soul:");

    const wantsTodo =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("todo:");

    const wantsTodoList =
      Array.isArray(parsed.tools) &&
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.trim().startsWith("todo-list");

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

    if (wantsBrowserExec) {
      const code = last.content.trim().slice(5).trim();
      emitToolCall(
        "browser_execute",
        JSON.stringify({ code, description: "smoke exec" }),
      );
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

    if (wantsRemember) {
      emitToolCall(
        "remember",
        JSON.stringify({
          content: last.content.trim().slice("remember:".length).trim(),
          type: "relational",
          importance: 0.7,
        }),
      );
      return;
    }

    if (wantsRecall) {
      emitToolCall(
        "recall",
        JSON.stringify({
          query: last.content.trim().slice("recall:".length).trim(),
        }),
      );
      return;
    }

    if (wantsSoul) {
      emitToolCall(
        "update_soul",
        JSON.stringify({
          voice: last.content.trim().slice("soul:".length).trim(),
          reason: "test update",
        }),
      );
      return;
    }

    if (wantsTodo) {
      emitToolCall(
        "todo_write",
        JSON.stringify({
          action: "add",
          title: last.content.trim().slice("todo:".length).trim(),
        }),
      );
      return;
    }

    if (wantsTodoList) {
      emitToolCall("todo_list", JSON.stringify({}));
      return;
    }

    if (wantsSlow) {
      const seconds = Number(last.content.trim().slice(5).trim()) || 30;
      emitToolCall(
        "shell",
        JSON.stringify({
          command: `sleep ${seconds}`,
          timeoutSeconds: Math.min(300, seconds + 30),
        }),
      );
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
