import { probeRfbFramebuffer } from "./lib/rfb-probe.mjs";

const url =
  process.argv.slice(2).find((argument) => argument !== "--") ??
  process.env.OPENBOT_VNC_URL;
if (!url) {
  console.error(
    "usage: pnpm vnc:smoke -- ws://127.0.0.1:4170/bots/<bot-id>/vnc",
  );
  process.exit(2);
}

const result = await probeRfbFramebuffer(url, { timeoutMs: 45_000 });
console.log(
  `VNC SMOKE OK — ${result.protocol}, ${result.width}x${result.height}, ` +
    `${result.pixelBytes} framebuffer bytes from ${JSON.stringify(result.name)}`,
);
