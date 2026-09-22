import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SelfGitInfo {
  branch: string;
  sha: string;
  dirty: boolean;
}

export interface SelfCheck {
  name: string;
  command: string;
}

/**
 * What the daemon knows about itself: where it runs from, where its data and
 * app live, how it was launched, and which checks the project defines. Each
 * agent gets a compact version in its prompt and can ask for the full picture
 * with the system_info tool.
 */
export interface SelfInfo {
  runMode: "dev" | "packaged";
  /** How the daemon can be restarted: watched, app-supervised, or manual. */
  supervised: "watch" | "app" | "none";
  repoRoot: string | null;
  appDir: string | null;
  daemonEntry: string;
  pid: number;
  version: string | null;
  nodeVersion: string;
  platform: string;
  arch: string;
  homeDir: string;
  dataDir: string;
  dbPath: string;
  artifactsDir: string;
  launchCommand: string | null;
  restartHint: string;
  git: SelfGitInfo | null;
  checks: SelfCheck[];
}

const CHECK_SCRIPTS = [
  "typecheck",
  "smoke",
  "code-tools:smoke",
  "websearch:smoke",
  "daemon-client:smoke",
];

function nearestRepoRoot(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

function parentCommand(): string | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const output = execFileSync(
      "ps",
      ["-o", "command=", "-p", String(process.ppid)],
      { encoding: "utf8", timeout: 2_000 },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

function gitInfo(repoRoot: string): SelfGitInfo | null {
  const run = (args: string[]): string =>
    execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    return {
      branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
      sha: run(["rev-parse", "--short", "HEAD"]),
      dirty: run(["status", "--porcelain"]).length > 0,
    };
  } catch {
    return null;
  }
}

function projectChecks(repoRoot: string): SelfCheck[] {
  try {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string>; version?: string };
    const scripts = pkg.scripts ?? {};
    return CHECK_SCRIPTS.filter((name) => typeof scripts[name] === "string").map(
      (name) => ({ name, command: `pnpm ${name}` }),
    );
  } catch {
    return [];
  }
}

function projectVersion(repoRoot: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function collectSelfInfo(input: {
  dataDir: string;
  artifactsDir: string;
}): SelfInfo {
  const entry = process.argv[1] ?? process.execPath;
  const repoRoot = nearestRepoRoot(dirname(entry));
  const launch = parentCommand();
  const packaged = process.env.OPENBOT_APP_PATH?.trim();
  const runMode = repoRoot ? "dev" : "packaged";
  const supervised: SelfInfo["supervised"] = packaged
    ? "app"
    : launch && /tsx/.test(launch) && /watch/.test(launch)
      ? "watch"
      : "none";
  const appDir = packaged
    ? packaged
    : repoRoot
      ? join(repoRoot, "apps", "mac")
      : null;
  const restartHint =
    supervised === "app"
      ? "The app supervises this daemon; the app can restart it."
      : supervised === "watch"
        ? "The dev watcher (tsx watch) restarts the daemon when source files change, which interrupts any running turn."
        : "The daemon was started manually; restarting it ends this process and any running turn.";
  return {
    runMode,
    supervised,
    repoRoot,
    appDir,
    daemonEntry: entry,
    pid: process.pid,
    version: repoRoot ? projectVersion(repoRoot) : (process.env.OPENBOT_VERSION ?? null),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
    dataDir: input.dataDir,
    dbPath: join(input.dataDir, "openbot.db"),
    artifactsDir: input.artifactsDir,
    launchCommand: launch,
    restartHint,
    git: repoRoot ? gitInfo(repoRoot) : null,
    checks: repoRoot ? projectChecks(repoRoot) : [],
  };
}

/** A compact note for an agent's prompt; the full detail is the tool. */
export function renderSelfNote(info: SelfInfo): string {
  if (info.runMode !== "dev" || !info.repoRoot) {
    return (
      "[self] You are a packaged OpenBot app. Use the system_info tool for " +
      "your paths and version."
    );
  }
  const git = info.git
    ? ` (${info.git.branch}@${info.git.sha}${info.git.dirty ? ", dirty" : ""})`
    : "";
  const checks = info.checks.map((check) => check.command).join(", ");
  return (
    `[self] You are OpenBot running from a dev checkout at ${info.repoRoot}${git}. ` +
    `Your data lives at ${info.dataDir}. ` +
    "To change your own behavior, edit the source there" +
    (checks ? `, verify with ${checks}` : "") +
    `, then restart the daemon — ${info.restartHint} ` +
    "Use the system_info tool for the full layout."
  );
}

export function renderSelfInfo(info: SelfInfo): string {
  const lines = [
    `run mode: ${info.runMode}`,
    `supervision: ${info.supervised}`,
    `version: ${info.version ?? "unknown"}`,
    `daemon: ${info.daemonEntry} (pid ${info.pid})`,
    `node: ${info.nodeVersion} · ${info.platform}/${info.arch}`,
    `home: ${info.homeDir}`,
    `data dir: ${info.dataDir}`,
    `database: ${info.dbPath}`,
    `artifacts: ${info.artifactsDir}`,
  ];
  if (info.repoRoot) {
    lines.push(`source: ${info.repoRoot}`);
  }
  if (info.appDir) {
    lines.push(`app: ${info.appDir}`);
  }
  if (info.git) {
    lines.push(
      `git: ${info.git.branch}@${info.git.sha}${
        info.git.dirty ? " (uncommitted changes)" : ""
      }`,
    );
  }
  if (info.launchCommand) {
    lines.push(`launched by: ${info.launchCommand}`);
  }
  lines.push(`restart: ${info.restartHint}`);
  if (info.checks.length > 0) {
    lines.push(
      `checks: ${info.checks.map((check) => check.command).join(", ")}`,
    );
  }
  return lines.join("\n");
}
