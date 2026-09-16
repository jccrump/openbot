import { startResponsesBridge } from "./server";

const upstreamBaseUrl = process.env.OPENBOT_UPSTREAM_BASE_URL ?? "";

if (!upstreamBaseUrl) {
  console.error(
    "OPENBOT_UPSTREAM_BASE_URL is required (e.g. https://api.deepseek.com/v1)",
  );
  process.exit(1);
}

const bridge = await startResponsesBridge({
  upstreamBaseUrl,
  upstreamApiKey: process.env.OPENBOT_UPSTREAM_API_KEY,
  upstreamModel: process.env.OPENBOT_UPSTREAM_MODEL,
  port: Number(process.env.OPENBOT_BRIDGE_PORT ?? 4180),
});

console.log(
  new Date().toISOString(),
  `responses bridge on http://127.0.0.1:${bridge.port}/v1`,
);
console.log(
  new Date().toISOString(),
  `upstream: ${upstreamBaseUrl} (model override: ${process.env.OPENBOT_UPSTREAM_MODEL || "none"})`,
);
