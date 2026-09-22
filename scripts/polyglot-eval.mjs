/**
 * Aider polyglot coding benchmark for the real OpenBot harness.
 *
 * Runs the public Exercism exercise set from Aider-AI/polyglot-benchmark
 * against a live daemon with a real model. Each exercise is copied into a
 * "This Mac" bot's workspace, the bot is asked to make the tests pass, and the
 * tests are then run on the host to grade the result.
 *
 * Usage:
 *   node scripts/polyglot-eval.mjs --limit 5 --label polyglot-python
 *   node scripts/polyglot-eval.mjs --exercise proverb,wordy
 *   node scripts/polyglot-eval.mjs --list
 *
 * Results land in evals/results/ as JSON + Markdown.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const resultsDir = join(root, "evals", "results");
const cacheDir = join(root, "evals", ".cache", "polyglot-benchmark");
const venvDir = join(root, "evals", ".cache", "polyglot-venv");
const venvPython = join(venvDir, "bin", "python");

function parseArgs(argv) {
  const options = {
    language: "python",
    limit: 5,
    exerciseIds: [],
    model: process.env.OPENBOT_EVAL_MODEL || "deepseek-flash",
    baseUrl: process.env.OPENBOT_EVAL_BASE_URL || "https://api.deepseek.com",
    label: "polyglot",
    timeoutMs: 600_000,
    testTimeoutMs: 180_000,
    list: false,
    verbose: false,
    computer: "vm",
    sandboxUrl:
      process.env.OPENBOT_SANDBOX_URL || "http://127.0.0.1:4171",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--language" && value) {
      options.language = value;
      index += 1;
    } else if (argument === "--limit" && value) {
      options.limit = Number(value);
      index += 1;
    } else if (argument === "--exercise" && value) {
      options.exerciseIds = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      index += 1;
    } else if (argument === "--model" && value) {
      options.model = value;
      index += 1;
    } else if (argument === "--base-url" && value) {
      options.baseUrl = value;
      index += 1;
    } else if (argument === "--label" && value) {
      options.label = value;
      index += 1;
    } else if (argument === "--timeout-ms" && value) {
      options.timeoutMs = Number(value);
      index += 1;
    } else if (argument === "--test-timeout-ms" && value) {
      options.testTimeoutMs = Number(value);
      index += 1;
    } else if (argument === "--list") {
      options.list = true;
    } else if (argument === "--verbose") {
      options.verbose = true;
    } else if (argument === "--computer" && value) {
      options.computer = value;
      index += 1;
    } else if (argument === "--sandbox-url" && value) {
      options.sandboxUrl = value;
      index += 1;
    } else if (argument === "--") {
      // pnpm forwards the argument separator; ignore it.
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        [
          "OpenBot Aider polyglot evaluation",
          "",
          "  --language NAME       Exercise language (default python)",
          "  --limit N             Run the first N exercises (default 5)",
          "  --exercise A,B        Run specific exercise ids",
          "  --model MODEL         OpenAI-compatible model id",
          "  --base-url URL        Provider base URL",
          "  --label NAME          Result label",
          "  --timeout-ms MS       Per-exercise agent timeout (default 600000)",
          "  --test-timeout-ms MS  Test run timeout (default 180000)",
          "  --computer vm|mac     Agent computer (default vm)",
          "  --sandbox-url URL     Sandbox host for vm runs (default 127.0.0.1:4171)",
          "  --list                List exercises without calling a model",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  if (options.language !== "python") {
    throw new Error(
      `unsupported language: ${options.language} (only python is wired up)`,
    );
  }
  if (options.computer !== "vm" && options.computer !== "mac") {
    throw new Error(`unsupported computer: ${options.computer}`);
  }
  return options;
}

async function sandboxExec(sandboxUrl, botId, body) {
  const response = await fetch(
    `${sandboxUrl}/vms/${encodeURIComponent(botId)}/exec`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `sandbox exec failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }
  return response.json();
}

async function ensureGuestPytest(sandboxUrl, botId) {
  const check = await sandboxExec(sandboxUrl, botId, {
    command:
      "python3 -m pytest --version >/dev/null 2>&1 || " +
      "(apt-get update -qq >/dev/null 2>&1 && " +
      "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-pytest >/dev/null 2>&1); " +
      "python3 -m pytest --version",
    cwd: "/root",
    timeoutMs: 300_000,
  });
  if (check.exit !== 0) {
    throw new Error(
      `could not install pytest in the VM: ${String(check.stderr ?? "").slice(0, 200)}`,
    );
  }
}

function uploadExerciseToGuest(exerciseId, source) {
  const tar = execFileSync("tar", ["-czf", "-", "-C", source, "."], {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const encoded = tar.toString("base64");
  const dir = `/root/exercises/${exerciseId}`;
  return {
    dir,
    command:
      `rm -rf ${dir} && mkdir -p ${dir} && ` +
      `printf %s '${encoded}' | base64 -d | tar xz -C ${dir}`,
  };
}

function storedProviderKey() {
  const databasePath = join(root, ".openbot-dev", "openbot.db");
  if (!existsSync(databasePath)) {
    return null;
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT api_key FROM providers WHERE id = ?")
      .get("deepseek");
    return typeof row?.api_key === "string" && row.api_key
      ? row.api_key
      : null;
  } finally {
    database.close();
  }
}

function resolveProviderKey() {
  return (
    process.env.OPENBOT_EVAL_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    storedProviderKey()
  );
}

function ensureBenchmarkCache() {
  if (!existsSync(join(cacheDir, ".git"))) {
    console.log("cloning polyglot-benchmark ...");
    mkdirSync(join(root, "evals", ".cache"), { recursive: true });
    execFileSync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "https://github.com/Aider-AI/polyglot-benchmark",
        cacheDir,
      ],
      { stdio: "inherit" },
    );
  }
  if (!existsSync(venvPython)) {
    console.log("creating the pytest venv ...");
    execFileSync("python3", ["-m", "venv", venvDir], { stdio: "inherit" });
    execFileSync(
      join(venvDir, "bin", "pip"),
      ["install", "--quiet", "pytest"],
      { stdio: "inherit" },
    );
  }
}

function listExercises(language) {
  const practiceDir = join(cacheDir, language, "exercises", "practice");
  return readdirSync(practiceDir)
    .filter((entry) => statSync(join(practiceDir, entry)).isDirectory())
    .filter((entry) =>
      readdirSync(join(practiceDir, entry)).some((file) =>
        file.endsWith("_test.py"),
      ),
    )
    .sort();
}

function createSocketClient(url, onEvent, autoApprove = false) {
  const queue = [];
  const waiters = new Set();
  const socket = new WebSocket(url);
  const opened = new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener(
      "error",
      () => rejectPromise(new Error("evaluation websocket failed to connect")),
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    // Mac computers always ask before tools run; the benchmark stands in for
    // the user and approves each request immediately.
    if (autoApprove && message.type === "approval.request") {
      socket.send(
        JSON.stringify({
          type: "approval.respond",
          requestId: message.requestId,
          decision: "approve",
        }),
      );
    }
    if (onEvent) {
      onEvent(message);
    }
    queue.push(message);
    for (const wake of waiters) {
      wake();
    }
  });
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = queue.findIndex(predicate);
      if (index >= 0) {
        return queue.splice(index, 1)[0];
      }
      await new Promise((resolvePromise, rejectPromise) => {
        const remaining = deadline - Date.now();
        const timer = setTimeout(() => {
          waiters.delete(wake);
          rejectPromise(new Error("timed out waiting for daemon event"));
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolvePromise();
        };
        waiters.add(wake);
      });
    }
    throw new Error("timed out waiting for daemon event");
  };
  return {
    opened,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    waitFor,
    close() {
      socket.close();
    },
  };
}

function exercisePrompt(exerciseId, target) {
  const testFile = target.files.find((file) => file.endsWith("_test.py"));
  return [
    `Solve the "${exerciseId}" coding exercise in ${target.dir} on your computer.`,
    "",
    `Files: ${target.files.join(", ")}.`,
    `The tests are in ${testFile}; make them pass by editing the solution file.`,
    "Do not modify the tests. Read them first: they define the expected behavior.",
    "",
    "Run the tests with:",
    `  cd ${target.dir} && ${target.testCommand}`,
    "",
    "Keep working until the tests pass, then report what you changed.",
  ].join("\n");
}

async function evaluateExercise(input) {
  const {
    client,
    dataDir,
    exerciseId,
    options,
    index,
    total,
    getDaemonLog,
  } = input;
  const requestId = `polyglot-bot-${randomUUID()}`;
  client.send({
    type: "bots.create",
    requestId,
    name: `Polyglot ${exerciseId}`,
    model: { provider: "eval-provider", model: options.model },
    computers: [options.computer === "vm" ? "firecracker" : "mac"],
  });
  const created = await client.waitFor(
    (message) =>
      message.type === "bot.created" && message.requestId === requestId,
    15_000,
  );
  const botId = created.bot.id;
  const source = join(
    cacheDir,
    options.language,
    "exercises",
    "practice",
    exerciseId,
  );
  const files = readdirSync(source).sort();

  const startedAt = Date.now();
  let record;
  try {
    let target;
    if (options.computer === "vm") {
      const upload = uploadExerciseToGuest(exerciseId, source);
      const uploaded = await sandboxExec(options.sandboxUrl, botId, {
        command: upload.command,
        cwd: "/root",
        timeoutMs: 120_000,
      });
      if (uploaded.exit !== 0) {
        throw new Error(
          `could not upload the exercise: ${String(uploaded.stderr ?? "").slice(0, 200)}`,
        );
      }
      await ensureGuestPytest(options.sandboxUrl, botId);
      target = {
        dir: upload.dir,
        files,
        testCommand: "python3 -m pytest -q",
      };
    } else {
      const workspace = join(dataDir, "workspaces", botId);
      mkdirSync(workspace, { recursive: true });
      cpSync(source, workspace, { recursive: true });
      target = {
        dir: workspace,
        files,
        testCommand: `${venvPython} -m pytest -q`,
      };
    }
    client.send({
      type: "chat.send",
      botId,
      text: exercisePrompt(exerciseId, target),
      model: { provider: "eval-provider", model: options.model },
    });
    const started = await client.waitFor(
      (message) => message.type === "chat.start" && message.threadId,
      15_000,
    );
    const completed = await client.waitFor(
      (message) =>
        (message.type === "chat.done" || message.type === "chat.error") &&
        message.runId === started.runId,
      options.timeoutMs,
    );
    const agentMs = Date.now() - startedAt;

    let toolCalls = [];
    let steps = 0;
    if (completed.type === "chat.done") {
      client.send({ type: "thread.messages", threadId: started.threadId });
      const history = await client.waitFor(
        (message) =>
          message.type === "thread.messages" &&
          message.threadId === started.threadId,
        15_000,
      );
      toolCalls = history.messages.flatMap(
        (message) => message.toolCalls || [],
      );
      steps = history.messages.filter(
        (message) => message.role === "assistant" && message.toolCalls?.length,
      ).length;
    }
    const failedCalls = toolCalls
      .filter((call) => !call.ok)
      .map((call) => ({
        name: call.name,
        arguments: String(call.arguments ?? "").slice(0, 300),
        output: String(call.output ?? "").slice(0, 400),
      }));

    let testExit;
    let testOutput;
    if (options.computer === "vm") {
      const test = await sandboxExec(options.sandboxUrl, botId, {
        command: "python3 -m pytest -q --no-header -p no:cacheprovider",
        cwd: target.dir,
        timeoutMs: options.testTimeoutMs,
      });
      testExit = test.exit;
      testOutput = `${test.stdout ?? ""}${test.stderr ?? ""}`.trim();
    } else {
      const test = spawnSync(
        venvPython,
        ["-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider"],
        {
          cwd: target.dir,
          encoding: "utf8",
          timeout: options.testTimeoutMs,
        },
      );
      testExit = test.status;
      testOutput = `${test.stdout ?? ""}${test.stderr ?? ""}`.trim();
    }
    record = {
      exerciseId,
      pass: testExit === 0,
      agentMs,
      totalMs: Date.now() - startedAt,
      toolCalls: toolCalls.length,
      failedToolCalls: failedCalls.length,
      steps,
      failedCalls,
      usage: completed.message?.usage ?? null,
      answer: completed.message?.content ?? "",
      error: completed.type === "chat.error" ? completed.message.message : null,
      testExit,
      testOutput: testOutput.slice(-2_000),
    };
  } catch (error) {
    record = {
      exerciseId,
      pass: false,
      agentMs: Date.now() - startedAt,
      totalMs: Date.now() - startedAt,
      toolCalls: 0,
      failedToolCalls: 0,
      steps: 0,
      failedCalls: [],
      usage: null,
      answer: "",
      error: error.message,
      daemonTail: getDaemonLog().slice(-4_000),
      testExit: null,
      testOutput: "",
    };
  }

  try {
    const deleteRequestId = `polyglot-delete-${randomUUID()}`;
    client.send({ type: "bots.delete", requestId: deleteRequestId, botId });
    await client.waitFor(
      (message) =>
        message.type === "bot.deleted" && message.requestId === deleteRequestId,
      15_000,
    );
  } catch {
    // Cleanup is best effort; the temp data dir is removed at the end.
  }

  console.log(
    `[${index}/${total}] ${exerciseId} ${record.pass ? "PASS" : "FAIL"} ` +
      `${Math.round(record.totalMs / 1000)}s tools=${record.toolCalls}`,
  );
  return record;
}

function repositoryIdentity() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  const fingerprint = createHash("sha256")
    .update(commit)
    .update(status)
    .digest("hex");
  return { commit, dirty: Boolean(status.trim()), fingerprint };
}

function writeResults(options, results, startedAt) {
  mkdirSync(resultsDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const passed = results.filter((result) => result.pass).length;
  const payload = {
    kind: "aider-polyglot",
    createdAt,
    label: options.label,
    language: options.language,
    model: options.model,
    repository: repositoryIdentity(),
    wallTimeMs: Date.now() - startedAt,
    summary: {
      total: results.length,
      passed,
      passRate: results.length ? passed / results.length : 0,
      totalToolCalls: results.reduce(
        (sum, result) => sum + result.toolCalls,
        0,
      ),
      failedToolCalls: results.reduce(
        (sum, result) => sum + result.failedToolCalls,
        0,
      ),
    },
    results,
  };
  const jsonPath = join(resultsDir, `${stamp}-polyglot-${options.label}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const lines = [
    `# Aider polyglot — ${options.label}`,
    "",
    `- Language: ${options.language}`,
    `- Model: \`${options.model}\``,
    `- Passed: ${passed}/${results.length}`,
    `- Wall time: ${Math.round(payload.wallTimeMs / 1000)}s`,
    "",
    "| Exercise | Result | Time | Tools | Failed |",
    "|---|---|---:|---:|---:|",
    ...results.map(
      (result) =>
        `| ${result.exerciseId} | ${result.pass ? "pass" : "fail"} | ` +
        `${Math.round(result.totalMs / 1000)}s | ${result.toolCalls} | ` +
        `${result.failedToolCalls} |`,
    ),
    "",
  ];
  const failed = results.filter((result) => !result.pass);
  if (failed.length) {
    lines.push("## Failures", "");
    for (const result of failed) {
      lines.push(`### ${result.exerciseId}`, "");
      if (result.error) {
        lines.push(`Agent error: ${result.error}`, "");
      }
      if (result.testOutput) {
        lines.push("```", result.testOutput, "```", "");
      }
    }
  }
  const mdPath = join(resultsDir, `${stamp}-polyglot-${options.label}.md`);
  writeFileSync(mdPath, `${lines.join("\n")}\n`);
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureBenchmarkCache();
  const allExercises = listExercises(options.language);
  if (options.list) {
    for (const exercise of allExercises) {
      console.log(exercise);
    }
    return;
  }
  const selected = options.exerciseIds.length
    ? allExercises.filter((exercise) =>
        options.exerciseIds.includes(exercise),
      )
    : allExercises.slice(0, options.limit);
  const unknown = options.exerciseIds.filter(
    (id) => !allExercises.includes(id),
  );
  if (unknown.length) {
    throw new Error(`unknown exercises: ${unknown.join(", ")}`);
  }
  if (!selected.length) {
    throw new Error("no exercises selected");
  }

  const providerKey = resolveProviderKey();
  if (!providerKey) {
    throw new Error(
      "No evaluation provider key. Set OPENBOT_EVAL_API_KEY or DEEPSEEK_API_KEY, " +
        "or save the DeepSeek key in OpenBot settings.",
    );
  }

  const startedAt = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "openbot-polyglot-"));
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify(
      {
        port: 0,
        providers: [
          {
            id: "eval-provider",
            label: "Evaluation provider",
            kind: "openai-compatible",
            baseUrl: options.baseUrl,
            apiKeyEnv: "OPENBOT_EVAL_PROVIDER_KEY",
            models: [options.model],
          },
        ],
        defaultModel: { provider: "eval-provider", model: options.model },
        sandboxUrl:
          options.computer === "vm"
            ? options.sandboxUrl
            : "http://127.0.0.1:9",
        requireApproval: false,
        compaction: { enabled: false, thresholdTokens: null },
        harness: { default: "openbot" },
      },
      null,
      2,
    ),
  );

  let daemonLog = "";
  const daemon = spawn(
    process.execPath,
    ["--import", "tsx", "src/bin/openbotd.ts"],
    {
      cwd: join(root, "packages", "core"),
      env: {
        ...process.env,
        OPENBOT_DATA_DIR: dataDir,
        OPENBOT_PORT: "0",
        OPENBOT_REQUIRE_APPROVAL: "false",
        OPENBOT_SANDBOX_URL:
          options.computer === "vm"
            ? options.sandboxUrl
            : "http://127.0.0.1:9",
        OPENBOT_EVAL_PROVIDER_KEY: providerKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const daemonPort = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("evaluation daemon did not start")),
      20_000,
    );
    const onData = (data) => {
      daemonLog += String(data);
      const match = daemonLog.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(Number(match[1]));
      }
    };
    daemon.stdout.on("data", onData);
    daemon.stderr.on("data", (data) => {
      daemonLog += String(data);
    });
    daemon.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`evaluation daemon exited early (${code})`));
    });
  });

  const verboseTypes = new Set([
    "tool.start",
    "tool.result",
    "chat.start",
    "chat.done",
    "chat.error",
    "approval.request",
  ]);
  const client = createSocketClient(
    `ws://127.0.0.1:${daemonPort}/ws`,
    options.verbose
      ? (message) => {
          if (verboseTypes.has(message.type)) {
            console.log(
              `    ${message.type} ${message.name ?? ""} ${
                message.ok === false ? "failed" : ""
              }`,
            );
          }
        }
      : undefined,
    true,
  );
  await client.opened;
  await client.waitFor((message) => message.type === "hello", 10_000);

  const results = [];
  try {
    console.log(
      `Running ${selected.length} ${options.language} exercises on ` +
        `${options.model}`,
    );
    for (let index = 0; index < selected.length; index += 1) {
      results.push(
        await evaluateExercise({
          client,
          dataDir,
          exerciseId: selected[index],
          options,
          index: index + 1,
          total: selected.length,
          getDaemonLog: () => daemonLog,
        }),
      );
    }
  } finally {
    client.close();
    daemon.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => daemon.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
    rmSync(dataDir, { recursive: true, force: true });
  }

  const { jsonPath, mdPath } = writeResults(options, results, startedAt);
  const passed = results.filter((result) => result.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  console.log(`json: ${jsonPath}`);
  console.log(`md:   ${mdPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
