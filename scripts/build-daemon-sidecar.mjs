/**
 * Build the daemon sidecar that ships inside the macOS app bundle.
 *
 * The app spawns this binary instead of `pnpm dev:daemon`, which makes macOS
 * attribute TCC permissions (Documents, Desktop, Downloads, Full Disk Access)
 * to OpenBot.app rather than Terminal. The build bundles the daemon to a
 * single CJS file, turns it into a Node single-executable application, and
 * ad-hoc signs it.
 *
 * Run with `pnpm sidecar:build`. Output:
 *   apps/mac/src-tauri/binaries/openbotd-<target-triple>
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch } from "node:process";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "apps", "mac", "src-tauri", "binaries");
const workDir = join(outDir, ".build");
const triple = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const sidecarPath = join(outDir, `openbotd-${triple}`);
const bundlePath = join(workDir, "openbotd.cjs");
const blobPath = join(workDir, "openbotd.blob");
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

mkdirSync(workDir, { recursive: true });

console.log("bundling the daemon…");
await build({
  entryPoints: [join(root, "packages", "core", "src", "bin", "openbotd.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  logLevel: "warning",
  // ws optionally requires native speedups that are not installed.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js:
      "const importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "importMetaUrl" },
});

console.log("generating the SEA blob…");
const seaConfigPath = join(workDir, "sea-config.json");
writeFileSync(
  seaConfigPath,
  JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
  cwd: workDir,
  stdio: "inherit",
});

console.log(`copying the Node runtime to ${sidecarPath}…`);
rmSync(sidecarPath, { force: true });
copyFileSync(process.execPath, sidecarPath);
chmodSync(sidecarPath, 0o755);
try {
  execFileSync("codesign", ["--remove-signature", sidecarPath], {
    stdio: "ignore",
  });
} catch {
  // unsigned already
}

console.log("injecting the blob…");
execFileSync(
  process.execPath,
  [
    join(root, "node_modules", "postject", "dist", "cli.js"),
    sidecarPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    SENTINEL,
    "--macho-segment-name",
    "NODE_SEA",
  ],
  { stdio: "inherit" },
);

console.log("ad-hoc signing…");
execFileSync("codesign", ["--sign", "-", "--force", sidecarPath], {
  stdio: "inherit",
});

console.log(`sidecar ready: ${sidecarPath}`);
