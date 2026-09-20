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

const config = loadConfig();
const db = openDatabase(config.dataDir);
const store = new Store(db);
store.ensureLeadBot(config.defaultModel);
store.migrateLegacyPrompts();
store.seedProviders(config.providers);
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
const daemon = createDaemon({
  config,
  store,
  registry,
  sandbox,
  approvals,
  challenges,
  presets: providerPresetList(),
  workspaces,
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
