import { existsSync } from "node:fs";
import { join } from "node:path";
import { providerPresetList } from "@openbot/gateway";
import { HttpSandboxBackend } from "@openbot/sandbox";
import { ApprovalBroker } from "../approvals";
import { loadConfig } from "../config";
import { openDatabase } from "../db";
import { ProviderRegistry } from "../provider-registry";
import { createDaemon } from "../server";
import { Store } from "../store";

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
store.ensureDefaultBot(config.defaultModel);
store.migrateLegacyPrompts();
store.seedProviders(config.providers);
if (!store.getSetting("defaultModel")) {
  store.setSetting("defaultModel", JSON.stringify(config.defaultModel));
}

const registry = new ProviderRegistry();
registry.reload(store.listProviders());

const sandbox = new HttpSandboxBackend({ url: config.sandboxUrl });
const approvals = new ApprovalBroker();
const daemon = createDaemon({
  config,
  store,
  registry,
  sandbox,
  approvals,
  presets: providerPresetList(),
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
