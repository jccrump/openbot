import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { providerPresetList } from "@openbot/gateway";
import { HttpSandboxBackend } from "@openbot/sandbox";
import { ApprovalBroker } from "../approvals";
import { ChallengeBroker } from "../challenges";
import { loadConfig, defaultWorkspaceRoots } from "../config";
import { openDatabase } from "../db";
import { ProviderRegistry } from "../provider-registry";
import { createDaemon } from "../server";
import { collectSelfInfo } from "../self";
import { Store } from "../store";
import { WorkspaceService } from "../workspaces";

for (const candidate of [
  join(process.cwd(), ".env"),
  join(process.cwd(), "..", "..", ".env"),
]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

// No top-level await: the packaged sidecar runs as a Node single-executable
// application, whose main script must stay CommonJS-friendly.
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);
  const store = new Store(db);
  store.ensureDefaultBot(config.defaultModel);
  store.migrateLegacyPrompts();
  store.seedProviders(config.providers);
  const expiredApprovals = store.expirePendingApprovals();
  if (expiredApprovals > 0) {
    console.log(
      `abandoned ${expiredApprovals} pending approval(s) from a previous run`,
    );
  }
  if (!store.getSetting("defaultModel")) {
    store.setSetting("defaultModel", JSON.stringify(config.defaultModel));
  }

  const registry = new ProviderRegistry();
  registry.reload(store.listProviders());

  // The owner id is stable per data directory, so this daemon can prune its own
  // orphaned VMs on startup without touching another daemon's computers.
  const sandboxOwner = createHash("sha256")
    .update(config.dataDir)
    .digest("hex")
    .slice(0, 16);
  const sandbox = new HttpSandboxBackend({
    url: config.sandboxUrl,
    owner: sandboxOwner,
  });
  const approvals = new ApprovalBroker({ store });
  const challenges = new ChallengeBroker();
  const workspaces = new WorkspaceService(store, config.workspaceRoots);
  const artifactsDir = join(config.dataDir, "artifacts");
  const self = collectSelfInfo({ dataDir: config.dataDir, artifactsDir });
  const daemon = createDaemon({
    config,
    store,
    registry,
    sandbox,
    approvals,
    challenges,
    presets: providerPresetList(),
    workspaces,
    self,
  });
  const { port } = await daemon.start();

  console.log(`openbotd listening on http://127.0.0.1:${port}`);
  console.log(`websocket: ws://127.0.0.1:${port}/ws`);
  console.log(`data dir: ${config.dataDir}`);
  console.log(
    `providers: ${registry.infos().map((provider) => `${provider.id}${provider.hasApiKey ? "" : " (no key)"}`).join(", ") || "none configured"}`,
  );
  console.log(
    `sandbox: ${config.sandboxUrl} | approvals: ${config.requireApproval ? "required" : "auto"}`,
  );

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // As a packaged app's sidecar the daemon must not outlive the app: watch the
  // stdin pipe (closed when the app dies) and the parent pid (changed on
  // reparent). Only active when the app asks for it, so a standalone daemon
  // with a closed stdin keeps running.
  if (process.env.OPENBOT_PARENT_WATCH === "1") {
    const parentPid = process.ppid;
    process.stdin.resume();
    process.stdin.on("close", () => void shutdown());
    const watch = setInterval(() => {
      if (process.ppid !== parentPid) {
        void shutdown();
      }
    }, 2_000);
    watch.unref();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
