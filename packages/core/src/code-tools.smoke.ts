/**
 * Focused checks for the code tools (read_file, edit, grep, glob).
 *
 * These run against the "This Mac" computer path with a throwaway workspace, so
 * the tools do real file I/O and real process execution without a microVM. That
 * keeps the interesting logic — exact-match editing, ambiguity detection, line
 * windowing, glob semantics, ignore directories — under test in CI, while the
 * smoke suite stays responsible for the daemon and protocol.
 *
 * Run with `pnpm code-tools:smoke`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "@openbot/protocol";
import { lineDiff } from "./diff";
import { listComputerFiles, readComputerFile } from "./files";
import { findTool, type ToolContext, type ToolExecutionResult } from "./tools";

const workspace = mkdtempSync(join(tmpdir(), "openbot-code-tools-"));

const context: ToolContext = {
  botId: "code-tools-smoke",
  computer: "mac",
  sandbox: null,
  workspaceDir: workspace,
  artifactsDir: join(workspace, "artifacts"),
  decision: null,
  vision: false,
  onSandboxState: () => {},
  readCache: new Map(),
};

function write(relativePath: string, content: string): void {
  const target = join(workspace, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

async function run(
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const found = findTool(tool);
  assert.ok(found, `tool ${tool} should exist`);
  return found.execute(context, args);
}

/** Mac-path results carry the `[local Mac]` marker; assertions want the body. */
function strip(output: string): string {
  return output.startsWith("[local Mac] ")
    ? output.slice("[local Mac] ".length)
    : output;
}

async function expectOk(
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await run(tool, args);
  assert.equal(
    result.ok,
    true,
    `${tool} should succeed, got: ${result.output}`,
  );
  return strip(result.output);
}

async function expectFail(
  tool: string,
  args: Record<string, unknown>,
  message: RegExp,
): Promise<string> {
  const result = await run(tool, args);
  assert.equal(result.ok, false, `${tool} should fail`);
  const output = strip(result.output);
  assert.match(output, message);
  return output;
}

const checks: Array<[string, () => Promise<void>]> = [];
function check(name: string, body: () => Promise<void>): void {
  checks.push([name, body]);
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

check("read_file numbers lines from 1", async () => {
  write("numbers.txt", "alpha\nbravo\ncharlie\n");
  const output = await expectOk("read_file", { path: "numbers.txt" });
  assert.match(output, /^1: alpha$/m);
  assert.match(output, /^2: bravo$/m);
  assert.match(output, /^3: charlie$/m);
});

check("read_file honours offset and limit", async () => {
  write("page.txt", "one\ntwo\nthree\nfour\nfive\n");
  const output = await expectOk("read_file", {
    path: "page.txt",
    offset: 2,
    limit: 2,
  });
  assert.match(output, /^2: two$/m);
  assert.match(output, /^3: three$/m);
  assert.doesNotMatch(output, /one/);
  assert.doesNotMatch(output, /four/);
  assert.match(output, /offset=4 to continue/);
});

check("read_file notes an unchanged file instead of repeating it", async () => {
  write("stable.txt", "one\ntwo\n");
  const first = await expectOk("read_file", { path: "stable.txt" });
  assert.match(first, /^1: one$/m);
  const second = await expectOk("read_file", { path: "stable.txt" });
  assert.match(second, /unchanged since your earlier read/);
  const forced = await expectOk("read_file", {
    path: "stable.txt",
    force: true,
  });
  assert.match(forced, /^1: one$/m);
});

check("read_file returns changed content again", async () => {
  write("changing.txt", "before\n");
  await expectOk("read_file", { path: "changing.txt" });
  write("changing.txt", "after\n");
  const output = await expectOk("read_file", { path: "changing.txt" });
  assert.match(output, /^1: after$/m);
  assert.doesNotMatch(output, /unchanged/);
});

check("read_file keeps its paging note on a long file", async () => {
  const lines = Array.from(
    { length: 3000 },
    (_, index) => `line ${index + 1} ${"z".repeat(40)}`,
  );
  write("long.txt", `${lines.join("\n")}\n`);
  const output = await expectOk("read_file", { path: "long.txt" });
  assert.match(
    output,
    /use offset=\d+ to continue/,
    "the note must survive the output budget, or the model cannot page",
  );
  assert.ok(output.length <= 30_100, "output should respect the shared budget");
});

check("read_file reports a missing file", async () => {
  await expectFail("read_file", { path: "nope.txt" }, /no such file/);
});

check("read_file refuses a directory", async () => {
  mkdirSync(join(workspace, "adir"), { recursive: true });
  await expectFail("read_file", { path: "adir" }, /is a directory/);
});

check("read_file rejects a path outside the workspace", async () => {
  await expectFail("read_file", { path: "/etc/hosts" }, /escapes the bot workspace/);
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

check("edit replaces one exact match and preserves the rest", async () => {
  write("app.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const output = await expectOk("edit", {
    path: "app.ts",
    oldString: "const b = 2;",
    newString: "const b = 42;",
  });
  assert.match(output, /Replaced 1 occurrence/);
  assert.equal(
    readFileSync(join(workspace, "app.ts"), "utf8"),
    "const a = 1;\nconst b = 42;\nconst c = 3;\n",
  );
});

check("edit refuses an ambiguous match", async () => {
  write("dup.ts", "let x = 1;\nlet x = 1;\n");
  const output = await expectFail(
    "edit",
    { path: "dup.ts", oldString: "let x = 1;", newString: "let x = 2;" },
    /appears 2 times/,
  );
  assert.match(output, /replaceAll/);
  assert.equal(
    readFileSync(join(workspace, "dup.ts"), "utf8"),
    "let x = 1;\nlet x = 1;\n",
    "a refused edit must not touch the file",
  );
});

check("edit with replaceAll changes every occurrence", async () => {
  write("dup2.ts", "let x = 1;\nlet x = 1;\n");
  const output = await expectOk("edit", {
    path: "dup2.ts",
    oldString: "let x = 1;",
    newString: "let x = 2;",
    replaceAll: true,
  });
  assert.match(output, /Replaced 2 occurrence/);
  assert.equal(
    readFileSync(join(workspace, "dup2.ts"), "utf8"),
    "let x = 2;\nlet x = 2;\n",
  );
});

check("edit reports a missing match", async () => {
  write("miss.ts", "const a = 1;\n");
  await expectFail(
    "edit",
    { path: "miss.ts", oldString: "const z = 9;", newString: "const z = 8;" },
    /not found/,
  );
});

check("edit hints when only the whitespace differs", async () => {
  // The file is indented with spaces; the model asked for a tab.
  write("indent.ts", "if (x) {\n    return 1;\n}\n");
  const output = await expectFail(
    "edit",
    { path: "indent.ts", oldString: "\treturn 1;", newString: "\treturn 2;" },
    /whitespace differs/,
  );
  assert.match(output, /indentation/);
});

check("edit rejects a no-op", async () => {
  write("same.ts", "const a = 1;\n");
  await expectFail(
    "edit",
    { path: "same.ts", oldString: "const a = 1;", newString: "const a = 1;" },
    /identical/,
  );
});

check("edit rejects a path outside the workspace", async () => {
  await expectFail(
    "edit",
    { path: "/etc/hosts", oldString: "a", newString: "b" },
    /escapes the bot workspace/,
  );
});

check("edit works on a path containing spaces", async () => {
  write("dir with spaces/file.txt", "before\n");
  await expectOk("edit", {
    path: "dir with spaces/file.txt",
    oldString: "before",
    newString: "after",
  });
  assert.equal(
    readFileSync(join(workspace, "dir with spaces/file.txt"), "utf8"),
    "after\n",
  );
});

check("write_file creates nested directories containing spaces", async () => {
  // An unquoted $(dirname ...) word-splits this path and the write fails.
  await expectOk("write_file", {
    path: "a dir/nested dir/file.txt",
    content: "hello\n",
  });
  assert.equal(
    readFileSync(join(workspace, "a dir/nested dir/file.txt"), "utf8"),
    "hello\n",
  );
});

// ---------------------------------------------------------------------------
// changed files (the app's per-turn card metadata)
// ---------------------------------------------------------------------------

check("write_file reports a new file as additions", async () => {
  const result = await run("write_file", {
    path: "changes/new.txt",
    content: "alpha\nbravo\n",
  });
  assert.equal(result.ok, true);
  const change = result.changes?.[0];
  assert.ok(change, "write_file should report the change");
  assert.equal(change.path, "changes/new.txt");
  assert.equal(change.additions, 2);
  assert.equal(change.deletions, 0);
  assert.match(change.diff ?? "", /^\+alpha$/m);
});

check("write_file reports overwrite stats with context", async () => {
  write("changes/overwrite.txt", "keep\nold\nkeep2\n");
  const result = await run("write_file", {
    path: "changes/overwrite.txt",
    content: "keep\nnew\nkeep2\n",
  });
  assert.equal(result.ok, true);
  const change = result.changes?.[0];
  assert.ok(change);
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 1);
  assert.match(change.diff ?? "", /^-old$/m);
  assert.match(change.diff ?? "", /^\+new$/m);
  assert.match(change.diff ?? "", /^ keep2$/m);
});

check("write_file skips the card when nothing changed", async () => {
  write("changes/same.txt", "same\n");
  const result = await run("write_file", {
    path: "changes/same.txt",
    content: "same\n",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changes, undefined);
});

check("edit reports the changed line", async () => {
  write("changes/edit.txt", "one\ntwo\nthree\n");
  const result = await run("edit", {
    path: "changes/edit.txt",
    oldString: "two",
    newString: "TWO",
  });
  assert.equal(result.ok, true);
  const change = result.changes?.[0];
  assert.ok(change);
  assert.equal(change.path, "changes/edit.txt");
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 1);
  assert.match(change.diff ?? "", /^-two$/m);
  assert.match(change.diff ?? "", /^\+TWO$/m);
});

check("lineDiff splits distant edits into separate hunks", async () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join(
    "\n",
  );
  const after = before
    .replace("line 2", "line two")
    .replace("line 39", "line thirty-nine");
  const stats = lineDiff(before, after);
  assert.equal(stats.additions, 2);
  assert.equal(stats.deletions, 2);
  const hunks = (stats.diff ?? "")
    .split("\n")
    .filter((line) => line.startsWith("@@"));
  assert.equal(hunks.length, 2, "distant edits should not share a hunk");
});

check("edit refuses a file larger than its limit", async () => {
  // A partial read written back would destroy the rest of the file, so this
  // must fail rather than silently truncate.
  const big = "x".repeat(200_001);
  write("big.txt", big);
  await expectFail(
    "edit",
    { path: "big.txt", oldString: "x", newString: "y", replaceAll: true },
    /larger than the 200000 byte limit/,
  );
  assert.equal(
    readFileSync(join(workspace, "big.txt"), "utf8").length,
    big.length,
    "a refused edit must leave the file byte-for-byte intact",
  );
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

check("grep finds matches with line numbers", async () => {
  write("src/one.ts", "const alpha = 1;\nconst beta = 2;\n");
  write("src/two.ts", "const gamma = 3;\n");
  const output = await expectOk("grep", { pattern: "const (alpha|gamma)" });
  assert.match(output, /one\.ts:1:const alpha = 1;/);
  assert.match(output, /two\.ts:1:const gamma = 3;/);
  assert.doesNotMatch(output, /beta/);
});

check("grep honours the include filter", async () => {
  write("src/three.ts", "needle here\n");
  write("src/three.js", "needle here\n");
  const output = await expectOk("grep", {
    pattern: "needle",
    include: "*.js",
  });
  assert.match(output, /three\.js/);
  assert.doesNotMatch(output, /three\.ts/);
});

check("grep skips node_modules and .git", async () => {
  write("node_modules/pkg/index.js", "needle in dependencies\n");
  write(".git/hooks/pre-commit", "needle in git internals\n");
  write("src/keep.ts", "needle in source\n");
  const output = await expectOk("grep", { pattern: "needle" });
  assert.match(output, /keep\.ts/);
  assert.doesNotMatch(output, /node_modules/);
  assert.doesNotMatch(output, /\.git/);
});

check("grep reports no matches without failing", async () => {
  const output = await expectOk("grep", { pattern: "zzz-nothing-matches-zzz" });
  assert.match(output, /No matches/);
});

check("grep rejects an invalid regular expression", async () => {
  await expectFail("grep", { pattern: "([unclosed" }, /invalid regular expression/i);
});

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

check("glob finds files by extension", async () => {
  write("lib/one.ts", "x\n");
  write("lib/nested/two.ts", "x\n");
  write("lib/three.md", "x\n");
  const output = await expectOk("glob", { pattern: "*.ts" });
  assert.match(output, /one\.ts/);
  assert.match(output, /two\.ts/);
  assert.doesNotMatch(output, /three\.md/);
});

check("glob skips node_modules", async () => {
  write("node_modules/pkg/index.ts", "x\n");
  write("app/main.ts", "x\n");
  const output = await expectOk("glob", { pattern: "**/*.ts" });
  assert.match(output, /main\.ts/);
  assert.doesNotMatch(output, /node_modules/);
});

check("glob reports no matches without failing", async () => {
  const output = await expectOk("glob", { pattern: "**/*.zzz" });
  assert.match(output, /No files match/);
});

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

check("list_dir marks directories and file sizes", async () => {
  write("listing/alpha.txt", "hello");
  write("listing/sub/beta.txt", "x");
  const output = await expectOk("list_dir", { path: "listing" });
  assert.match(output, /^dir  sub\/$/m);
  assert.match(output, /^file alpha\.txt \(5 bytes\)$/m);
  assert.doesNotMatch(output, /beta\.txt/);
});

check("list_dir skips ignored directories and says so", async () => {
  write("ignored/node_modules/pkg/index.ts", "x\n");
  write("ignored/keep.txt", "x\n");
  const output = await expectOk("list_dir", { path: "ignored" });
  assert.match(output, /keep\.txt/);
  assert.doesNotMatch(output, /^dir  node_modules\/$/m);
  assert.match(output, /skipped 1 ignored entry/);
});

check("list_dir reports a missing directory", async () => {
  await expectFail("list_dir", { path: "does-not-exist" }, /could not read directory/);
});

check("list_dir reports an empty directory", async () => {
  mkdirSync(join(workspace, "empty-dir"), { recursive: true });
  const output = await expectOk("list_dir", { path: "empty-dir" });
  assert.match(output, /the directory is empty/);
});

// ---------------------------------------------------------------------------
// files (the app's Files tab)
// ---------------------------------------------------------------------------

const fileOptions = {
  dataDir: workspace,
  artifactsDir: join(workspace, "artifacts"),
  sandbox: null,
  getBot: (botId: string): Bot | null =>
    botId === "code-tools-smoke"
      ? ({ id: botId, computers: ["mac"] } as Bot)
      : null,
};

check("files.list returns entries for the Mac workspace", async () => {
  write("workspaces/code-tools-smoke/hello.txt", "hi\n");
  write("workspaces/code-tools-smoke/sub/inner.txt", "x\n");
  const result = await listComputerFiles(fileOptions, "code-tools-smoke", "");
  assert.equal(result.error, null);
  const names = result.entries.map((entry) => entry.name);
  assert.ok(names.includes("hello.txt"), "the file should be listed");
  const sub = result.entries.find((entry) => entry.name === "sub");
  assert.equal(sub?.dir, true);
});

check("files.read returns text content", async () => {
  const result = await readComputerFile(
    fileOptions,
    "code-tools-smoke",
    "hello.txt",
  );
  assert.equal(result.error, null);
  assert.equal(result.kind, "text");
  assert.equal(result.content, "hi\n");
  assert.equal(result.truncated, false);
});

check("files.read reports a missing file", async () => {
  const result = await readComputerFile(
    fileOptions,
    "code-tools-smoke",
    "nope.txt",
  );
  assert.equal(result.kind, "missing");
  assert.match(result.error ?? "", /ENOENT/);
});

check("files.read rejects a path outside the workspace", async () => {
  const result = await readComputerFile(
    fileOptions,
    "code-tools-smoke",
    "../../etc/hosts",
  );
  assert.match(result.error ?? "", /escapes the bot workspace/);
});

check("files.list reports an unknown agent", async () => {
  const result = await listComputerFiles(fileOptions, "missing", "");
  assert.match(result.error ?? "", /agent not found/);
});

// ---------------------------------------------------------------------------
// access modes and self tools
// ---------------------------------------------------------------------------

check("home access refuses a path outside the home folder", async () => {
  const tool = findTool("read_file");
  assert.ok(tool);
  const result = await tool.execute(
    { ...context, access: "home" },
    { path: "/etc/hosts" },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /escapes the bot workspace/);
});

check("home access lists the home folder", async () => {
  const tool = findTool("list_dir");
  assert.ok(tool);
  const result = await tool.execute({ ...context, access: "home" }, {});
  assert.equal(result.ok, true);
});

check("full access reads a path outside the home folder", async () => {
  const tool = findTool("read_file");
  assert.ok(tool);
  const result = await tool.execute(
    { ...context, access: "full" },
    { path: "/etc/hosts" },
  );
  assert.equal(result.ok, true);
  assert.match(result.output, /localhost/);
});

check("system_info reports the daemon layout", async () => {
  const tool = findTool("system_info");
  assert.ok(tool);
  const result = await tool.execute(context, {});
  assert.equal(result.ok, true);
  assert.match(result.output, /run mode: dev/);
  assert.match(result.output, /data dir:/);
});

check("restart_daemon reports when no scheduler is available", async () => {
  const tool = findTool("restart_daemon");
  assert.ok(tool);
  const result = await tool.execute(context, {});
  assert.equal(result.ok, false);
  assert.match(result.output, /not available/);
});

check("restart_daemon forwards to the daemon scheduler", async () => {
  const tool = findTool("restart_daemon");
  assert.ok(tool);
  let called = 0;
  const result = await tool.execute(
    {
      ...context,
      requestRestart: () => {
        called += 1;
        return { ok: true, message: "restart scheduled" };
      },
    },
    {},
  );
  assert.equal(called, 1);
  assert.equal(result.ok, true);
  assert.match(result.output, /scheduled/);
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let failed = 0;
try {
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
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks.length} code-tool checks failed`);
  process.exit(1);
}
console.log(`\nCODE TOOLS OK — ${checks.length} checks passed`);
