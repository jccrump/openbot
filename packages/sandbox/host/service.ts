import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lookup } from "node:dns/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { connect } from "node:net";
import { deflateSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";

const FC_BIN = process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
const FC_DIR = process.env.FC_DIR ?? "/var/lib/fc";
const HOST_BROWSER_RUNTIME = join(FC_DIR, "openbot-browser-host");
const HOST_BROWSER_SCRIPT = join(FC_DIR, "openbot/browser.js");
const DESKTOP_ASSET_DIR = join(FC_DIR, "openbot");
const WALLPAPER_PATH = join(DESKTOP_ASSET_DIR, "wallpaper.png");
const CHROMIUM_ICON_PATH = join(DESKTOP_ASSET_DIR, "chromium.png");
const BASE_ROOTFS = join(FC_DIR, "rootfs.ext4");
const BASE_VERSION_FILE = join(FC_DIR, "rootfs.version");
const KERNEL = join(FC_DIR, "vmlinux");
const VMS_DIR = join(FC_DIR, "vms");
const PORT = Number(process.env.OPENBOT_HOST_PORT ?? 4171);
const VSOCK_PORT = 5000;
const PTY_VSOCK_PORT = 5001;
const VNC_VSOCK_PORT = 5900;
const DEFAULT_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 120_000;
const VNC_READY_TIMEOUT_MS = 30_000;
const VNC_BUFFER_HIGH_WATER_BYTES = 256 * 1024;
const ROOTFS_BACKUP_RETENTION = 1;
const NETWORK_ENABLED = process.env.OPENBOT_SANDBOX_NETWORK !== "false";
// Which daemon owns a VM. Carried per request so VM directories can be garbage
// collected without one daemon pruning another's (or an eval runner's) VMs.
const requestOwner = new AsyncLocalStorage<string>();
const BOOT_ARGS =
  "console=ttyS0 reboot=k panic=1 init=/usr/local/bin/openbot-agent.py";

type VmState = "stopped" | "booting" | "running" | "error";

interface VmNetwork {
  slot: number;
  tap: string;
  hostIp: string;
  guestIp: string;
  mac: string;
}

interface VmRecord {
  botId: string;
  dir: string;
  cid: number;
  slot: number;
  network: VmNetwork | null;
  state: VmState;
  error: string | null;
  bootedAt: string | null;
  pid: number | null;
  pendingUpgrade: RootfsUpgrade | null;
}

interface BrowserDesktopRecord {
  display: string;
  displayNumber: number;
  vncPort: number;
  children: ReturnType<typeof spawn>[];
  panel: ReturnType<typeof spawn> | null;
}

interface BrowserIdentity {
  user: string;
  uid: number;
  gid: number;
  home: string;
}

const vms = new Map<string, VmRecord>();
const ensures = new Map<string, Promise<VmRecord>>();
const browserDaemons = new Map<string, ReturnType<typeof spawn>>();
const browserDesktops = new Map<string, BrowserDesktopRecord>();
const browserIdentities = new Map<string, BrowserIdentity>();
let nextCid = 3;
let nextSlot = 1;
let uplinkInterface = "eth0";

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function tryExec(command: string): string | null {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch {
    return null;
  }
}

function setupNat() {
  if (!NETWORK_ENABLED) {
    log("network: disabled (OPENBOT_SANDBOX_NETWORK=false)");
    return;
  }
  const route = tryExec("ip route show default") ?? "";
  uplinkInterface = route.match(/default via \S+ dev (\S+)/)?.[1] ?? "eth0";
  tryExec("sysctl -w net.ipv4.ip_forward=1");

  const rules: Array<[string, string, string]> = [
    [
      "nat",
      "POSTROUTING",
      `-s 172.16.0.0/16 -o ${uplinkInterface} -j MASQUERADE`,
    ],
    [
      "filter",
      "FORWARD",
      `-s 172.16.0.0/16 -o ${uplinkInterface} -j ACCEPT`,
    ],
    [
      "filter",
      "FORWARD",
      `-d 172.16.0.0/16 -i ${uplinkInterface} -m state --state RELATED,ESTABLISHED -j ACCEPT`,
    ],
  ];
  for (const [table, chain, rule] of rules) {
    if (tryExec(`iptables -t ${table} -C ${chain} ${rule}`) === null) {
      tryExec(`iptables -t ${table} -I ${chain} 1 ${rule}`);
    }
  }
  log(`network: nat enabled via ${uplinkInterface}`);
}

// ---------------------------------------------------------------------------
// Per-VM shell egress. A hard `deny` policy is enforced with nftables on the
// VM's tap interface: only the resolved allowlist, DNS to the image's
// resolvers, and established/related traffic leave the VM. The browser runs on
// this host, so it is not affected by these rules.
// ---------------------------------------------------------------------------

const EGRESS_TABLE = "openbot_egress";
const EGRESS_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const EGRESS_MAX_HOSTS = 50;
const egressPolicies = new Map<string, { allow: string[]; ips: string[] }>();

function isIpAddress(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

async function resolveAllowlist(hosts: string[]): Promise<string[]> {
  const ips = new Set<string>();
  for (const host of hosts.slice(0, EGRESS_MAX_HOSTS)) {
    const name = host.trim().replace(/^\./, "");
    if (!name) {
      continue;
    }
    if (isIpAddress(name)) {
      ips.add(name);
      continue;
    }
    try {
      const results = await lookup(name, { all: true });
      for (const result of results) {
        if (result.family === 4) {
          ips.add(result.address);
        }
      }
    } catch {
      // An unresolvable host simply has no addresses; the rest still apply.
    }
  }
  return [...ips];
}

function egressScript(): string {
  const lines = [
    `add table inet ${EGRESS_TABLE}`,
    `add chain inet ${EGRESS_TABLE} forward { type filter hook forward priority -10; policy accept; }`,
  ];
  for (const [botId, policy] of egressPolicies) {
    const record = vms.get(botId);
    if (!record?.network) {
      continue;
    }
    const chain = `vm_${record.network.tap}`;
    const set = `${chain}_ips`;
    lines.push(`add chain inet ${EGRESS_TABLE} ${chain}`);
    lines.push(
      `add rule inet ${EGRESS_TABLE} forward iifname "${record.network.tap}" jump ${chain}`,
    );
    lines.push(
      `add rule inet ${EGRESS_TABLE} ${chain} ct state established,related accept`,
    );
    // The tap is IPv4-only, but drop IPv6 anyway so a future route cannot
    // bypass the allowlist.
    lines.push(`add rule inet ${EGRESS_TABLE} ${chain} meta nfproto ipv6 drop`);
    for (const server of EGRESS_DNS_SERVERS) {
      lines.push(
        `add rule inet ${EGRESS_TABLE} ${chain} ip daddr ${server} udp dport 53 accept`,
      );
      lines.push(
        `add rule inet ${EGRESS_TABLE} ${chain} ip daddr ${server} tcp dport 53 accept`,
      );
    }
    lines.push(
      `add rule inet ${EGRESS_TABLE} ${chain} icmp type echo-request accept`,
    );
    lines.push(
      `add set inet ${EGRESS_TABLE} ${set} { type ipv4_addr; flags interval; }`,
    );
    const allowed = policy.ips ?? [];
    if (allowed.length > 0) {
      lines.push(
        `add element inet ${EGRESS_TABLE} ${set} { ${allowed.join(", ")} }`,
      );
    }
    lines.push(
      `add rule inet ${EGRESS_TABLE} ${chain} ip daddr @${set} accept`,
    );
    lines.push(`add rule inet ${EGRESS_TABLE} ${chain} drop`);
  }
  return `${lines.join("\n")}\n`;
}

function applyEgressRules(): { ok: boolean; error?: string } {
  const scriptPath = join("/tmp", "openbot-egress.nft");
  try {
    tryExec(`nft delete table inet ${EGRESS_TABLE}`);
    if (egressPolicies.size === 0) {
      return { ok: true };
    }
    // nft on this image refuses `-f -`; hand it a real file.
    writeFileSync(scriptPath, egressScript());
    execFileSync("nft", ["-f", scriptPath]);
    return { ok: true };
  } catch (error) {
    const message = (error as Error).message;
    log(`egress rules failed: ${message}`);
    return { ok: false, error: message };
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

async function setEgressPolicy(
  botId: string,
  policy: { mode: "deny"; allow: string[] } | null,
): Promise<{ ok: boolean; ips?: string[]; error?: string }> {
  if (!policy || policy.mode !== "deny") {
    egressPolicies.delete(botId);
    return applyEgressRules();
  }
  const ips = await resolveAllowlist(policy.allow);
  egressPolicies.set(botId, { allow: policy.allow, ips });
  const applied = applyEgressRules();
  return { ...applied, ips };
}

function networkFor(slot: number): VmNetwork {
  return {
    slot,
    tap: `tap${slot}`,
    hostIp: `172.16.${slot}.1`,
    guestIp: `172.16.${slot}.2`,
    mac: `AA:FC:${slot.toString(16).padStart(2, "0")}:00:00:01`,
  };
}

function createTap(network: VmNetwork) {
  tryExec(`ip link del ${network.tap}`);
  execSync(`ip tuntap add dev ${network.tap} mode tap`);
  execSync(`ip addr add ${network.hostIp}/30 dev ${network.tap}`);
  execSync(`ip link set ${network.tap} up`);
}

function deleteTap(network: VmNetwork | null) {
  if (network) {
    tryExec(`ip link del ${network.tap}`);
  }
}

function bootArgsFor(network: VmNetwork | null): string {
  if (!network) {
    return BOOT_ARGS;
  }
  return `${BOOT_ARGS} ip=${network.guestIp}::${network.hostIp}:255.255.255.252::eth0:off`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeId(botId: string) {
  return botId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function vmDir(botId: string) {
  return join(VMS_DIR, safeId(botId));
}

function apiSock(botId: string) {
  return join(vmDir(botId), "api.sock");
}

function vsockSock(botId: string) {
  return join(vmDir(botId), "vsock.sock");
}

function serialLog(botId: string) {
  return join(vmDir(botId), "serial.log");
}

function browserSocket(botId: string) {
  return join(browserRuntimeDir(botId), "browser.sock");
}

function browserRuntimeDir(botId: string) {
  return join("/run/openbot-browsers", safeVersion(botId));
}

function browserProfile(botId: string) {
  return join(vmDir(botId), "browser-profile");
}

function browserLog(botId: string) {
  return join(vmDir(botId), "browser.log");
}

function launcherDir(botId: string) {
  return join(vmDir(botId), "desktop-launchers");
}

function tint2ConfigPath(botId: string) {
  return join(vmDir(botId), "desktop-tint2rc");
}

function vmVersionFile(botId: string) {
  return join(vmDir(botId), "rootfs.version");
}

function readVersion(path: string): string | null {
  try {
    const version = readFileSync(path, "utf8").trim();
    return version || null;
  } catch {
    return null;
  }
}

interface RootfsUpgrade {
  botId: string;
  oldVersion: string;
  newVersion: string;
  rootfs: string;
  previousRootfs: string;
}

const PERSISTENT_GUEST_DIRS = [
  "root",
  "home",
  "srv",
  "workspace",
  "workspaces",
] as const;

function safeVersion(version: string) {
  return version.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function copySparse(source: string, destination: string) {
  execFileSync("cp", ["--sparse=always", source, destination]);
}

function pruneRootfsBackups(dir: string, keep = ROOTFS_BACKUP_RETENTION) {
  const backups = readdirSync(dir)
    .filter((name) => /^rootfs\.backup-.*\.ext4(?:\.gz)?$/.test(name))
    .map((name) => {
      const path = join(dir, name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  for (const backup of backups.slice(keep)) {
    rmSync(backup.path, { force: true });
    log(`removed expired rootfs backup ${backup.path}`);
  }
}

/**
 * Free space and the space one new agent rootfs needs. Reported by /health so
 * a caller can tell the user before an agent starts that no computer fits.
 */
function imageCapacity(): { freeBytes: number; requiredBytes: number } {
  const filesystem = statfsSync(FC_DIR);
  const freeBytes = filesystem.bavail * filesystem.bsize;
  const baseBlocks = statSync(BASE_ROOTFS).blocks ?? 0;
  const baseAllocatedBytes = baseBlocks * 512;
  return {
    freeBytes,
    requiredBytes: baseAllocatedBytes + 512 * 1024 * 1024,
  };
}

function requireImageCapacity(dir: string) {
  // Image upgrades used to retain every prior base image indefinitely. Keep a
  // single rollback point so routine image refreshes cannot fill the host and
  // prevent the next VM from starting.
  pruneRootfsBackups(dir);
  const { freeBytes, requiredBytes } = imageCapacity();
  if (freeBytes < requiredBytes) {
    const gib = (value: number) => (value / 1024 ** 3).toFixed(1);
    throw new Error(
      `insufficient disk space for a safe image copy: ${gib(freeBytes)} GiB free, ${gib(requiredBytes)} GiB required; no agent image was deleted`,
    );
  }
}

function checkExt4(path: string, label: string) {
  const check = spawnSync("e2fsck", ["-pf", path], { encoding: "utf8" });
  if (check.status !== 0 && check.status !== 1) {
    throw new Error(
      `${label} failed e2fsck (${check.status}): ${(check.stderr || check.stdout).slice(0, 300)}`,
    );
  }
}

function unmount(path: string) {
  try {
    execFileSync("umount", [path]);
  } catch {
    // The mount may already have been released after an earlier failure.
  }
}

function copyPersistentGuestData(oldRoot: string, newRoot: string) {
  const managedTint2 = join(newRoot, "root/.config/tint2/tint2rc");
  const tint2 = existsSync(managedTint2)
    ? {
        contents: readFileSync(managedTint2),
        mode: statSync(managedTint2).mode,
      }
    : null;

  for (const relative of PERSISTENT_GUEST_DIRS) {
    const source = join(oldRoot, relative);
    if (!existsSync(source)) continue;
    const destination = join(newRoot, relative);
    mkdirSync(destination, { recursive: true });
    execFileSync("cp", ["-a", `${source}/.`, destination]);
  }

  // tint2rc is image-owned even though it lives below /root. Restore the
  // freshly baked copy after migrating the rest of the agent's home.
  if (tint2) {
    mkdirSync(join(newRoot, "root/.config/tint2"), { recursive: true });
    writeFileSync(managedTint2, tint2.contents, { mode: tint2.mode });
  }
}

function prepareRootfs(botId: string): RootfsUpgrade | null {
  const dir = vmDir(botId);
  const rootfs = join(dir, "rootfs.ext4");
  const baseVersion = readVersion(BASE_VERSION_FILE);
  if (!baseVersion) {
    throw new Error(
      `base image version is missing at ${BASE_VERSION_FILE}; run pnpm sandbox:setup`,
    );
  }

  if (!existsSync(rootfs)) {
    log(`vm ${botId}: creating rootfs from base image ${baseVersion}`);
    requireImageCapacity(dir);
    try {
      copySparse(BASE_ROOTFS, rootfs);
      checkExt4(rootfs, "new rootfs");
      writeFileSync(vmVersionFile(botId), `${baseVersion}\n`);
      writeFileSync(
        join(dir, "owner"),
        `${requestOwner.getStore() ?? "default"}\n`,
      );
    } catch (error) {
      rmSync(rootfs, { force: true });
      throw error;
    }
    return null;
  }

  const currentVersion = readVersion(vmVersionFile(botId));
  if (currentVersion === baseVersion) return null;

  const nextRootfs = join(dir, "rootfs.next.ext4");
  const mountOld = join(dir, ".mount-old");
  const mountNew = join(dir, ".mount-new");
  const oldVersion = currentVersion ?? "legacy-unversioned";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const previousRootfs = join(
    dir,
    `rootfs.backup-${safeVersion(oldVersion)}-${stamp}.ext4`,
  );

  log(
    `vm ${botId}: upgrading guest image ${oldVersion} -> ${baseVersion}; preserving agent data`,
  );
  rmSync(nextRootfs, { force: true });
  mkdirSync(mountOld, { recursive: true });
  mkdirSync(mountNew, { recursive: true });

  let oldMounted = false;
  let newMounted = false;
  try {
    // Firecracker root drives are often stopped without a guest shutdown, so
    // replay the ext4 journal before attempting a read-only migration mount.
    checkExt4(rootfs, "existing rootfs");
    requireImageCapacity(dir);
    copySparse(BASE_ROOTFS, nextRootfs);
    execFileSync("mount", ["-o", "loop,ro", rootfs, mountOld]);
    oldMounted = true;
    execFileSync("mount", ["-o", "loop", nextRootfs, mountNew]);
    newMounted = true;
    copyPersistentGuestData(mountOld, mountNew);
    execFileSync("sync", ["-f", mountNew]);
    unmount(mountNew);
    newMounted = false;
    unmount(mountOld);
    oldMounted = false;

    checkExt4(nextRootfs, "new rootfs");

    renameSync(rootfs, previousRootfs);
    renameSync(nextRootfs, rootfs);
    writeFileSync(vmVersionFile(botId), `${baseVersion}\n`);
    return {
      botId,
      oldVersion,
      newVersion: baseVersion,
      rootfs,
      previousRootfs,
    };
  } catch (error) {
    if (newMounted) unmount(mountNew);
    if (oldMounted) unmount(mountOld);
    rmSync(nextRootfs, { force: true });
    throw error;
  } finally {
    rmSync(mountOld, { recursive: true, force: true });
    rmSync(mountNew, { recursive: true, force: true });
  }
}

function rollbackRootfs(upgrade: RootfsUpgrade) {
  const failed = `${upgrade.rootfs}.failed-${safeVersion(upgrade.newVersion)}-${Date.now()}`;
  if (existsSync(upgrade.rootfs)) renameSync(upgrade.rootfs, failed);
  renameSync(upgrade.previousRootfs, upgrade.rootfs);
  if (upgrade.oldVersion === "legacy-unversioned") {
    rmSync(vmVersionFile(upgrade.botId), { force: true });
  } else {
    writeFileSync(vmVersionFile(upgrade.botId), `${upgrade.oldVersion}\n`);
  }
  let retained = failed;
  try {
    execFileSync("gzip", ["-1", failed]);
    retained = `${failed}.gz`;
  } catch {
    // Keep the uncompressed failed image if archiving cannot complete.
  }
  log(
    `vm ${upgrade.botId}: image upgrade rolled back; failed image retained at ${retained}`,
  );
}

function archivePreviousRootfs(upgrade: RootfsUpgrade) {
  const archive = spawn("gzip", ["-1", upgrade.previousRootfs], {
    stdio: "ignore",
  });
  archive.on("exit", (code) => {
    if (code === 0) {
      log(
        `vm ${upgrade.botId}: prior image retained at ${upgrade.previousRootfs}.gz`,
      );
      pruneRootfsBackups(vmDir(upgrade.botId));
      return;
    }
    log(
      `vm ${upgrade.botId}: could not compress prior image (exit ${code}); retained at ${upgrade.previousRootfs}`,
    );
  });
  archive.on("error", (error) => {
    log(
      `vm ${upgrade.botId}: could not compress prior image; retained at ${upgrade.previousRootfs}: ${(error as Error).message}`,
    );
  });
}

function statusOf(record: VmRecord) {
  return {
    botId: record.botId,
    state: record.state,
    cid: record.cid,
    bootedAt: record.bootedAt,
    error: record.error,
  };
}

// A host-service restart drops the in-memory VM records while the
// firecracker processes keep running. Probe the API socket and re-adopt them
// so status, screen capture, and VNC keep working without an action first.
async function adoptVmIfRunning(botId: string): Promise<VmRecord | null> {
  const existing = vms.get(botId);
  if (existing) {
    return existing;
  }
  if (!existsSync(apiSock(botId))) {
    return null;
  }
  try {
    await fcRequest(apiSock(botId), "GET", "/machine-config");
  } catch {
    return null;
  }
  let bootedAt: string | null = null;
  try {
    bootedAt = statSync(apiSock(botId)).mtime.toISOString();
  } catch {
    // best effort
  }
  const pidOutput = tryExec(
    `pgrep -f ${JSON.stringify(`firecracker --api-sock ${apiSock(botId)}`)}`,
  );
  const pid = pidOutput ? Number(pidOutput.split("\n")[0]) : NaN;
  const record: VmRecord = {
    botId,
    dir: vmDir(botId),
    cid: nextCid++,
    slot: nextSlot++,
    network: null,
    state: "running",
    error: null,
    bootedAt,
    pid: Number.isFinite(pid) ? pid : null,
    pendingUpgrade: null,
  };
  vms.set(botId, record);
  log(`vm ${botId}: adopted running VM after restart`);
  return record;
}

function fcRequest(
  sockPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        socketPath: sockPath,
        path,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (
            response.statusCode &&
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve(data ? JSON.parse(data) : null);
          } else {
            reject(
              new Error(
                `firecracker ${method} ${path} -> ${response.statusCode}: ${data.slice(0, 300)}`,
              ),
            );
          }
        });
      },
    );
    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

interface AgentResult {
  exit: number;
  stdout: string;
  stderr: string;
}

// The guest agent runs commands through /bin/sh; wrap them in bash so the
// common bash-only constructs agents write (PIPESTATUS, [[ ]], arrays) work.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function vsockExec(
  udsPath: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  onChunk?: (stream: "stdout" | "stderr", data: string) => void,
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(udsPath);
    let buffer = "";
    let phase: "handshake" | "response" = "handshake";
    let settled = false;

    const finish = (error: Error | null, result?: AgentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    };

    const timer = setTimeout(
      () => finish(new Error(`sandbox exec timed out after ${timeoutMs}ms`)),
      timeoutMs + 5000,
    );

    socket.on("connect", () => {
      socket.write(`CONNECT ${VSOCK_PORT}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      if (phase === "handshake") {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("OK")) {
          finish(new Error(`vsock handshake failed: ${line.slice(0, 120)}`));
          return;
        }
        phase = "response";
        socket.write(
          JSON.stringify({
            cmd: command,
            cwd,
            timeout: Math.ceil(timeoutMs / 1000),
          }) + "\n",
        );
      }

      if (phase === "response") {
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.trim()) continue;
          let payload: {
            type?: string;
            stream?: string;
            data?: string;
            exit?: number;
            stdout?: string;
            stderr?: string;
          };
          try {
            payload = JSON.parse(line) as typeof payload;
          } catch {
            finish(new Error(`bad agent response: ${line.slice(0, 200)}`));
            return;
          }
          if (payload.type === "chunk" && typeof payload.data === "string") {
            onChunk?.(
              payload.stream === "stderr" ? "stderr" : "stdout",
              payload.data,
            );
            continue;
          }
          finish(null, {
            exit: payload.exit ?? -1,
            stdout: payload.stdout ?? "",
            stderr: payload.stderr ?? "",
          });
          return;
        }
      }
    });

    socket.on("error", (error) => finish(error));
  });
}

// File browsing is a native guest-agent operation: the agent answers list and
// read requests in-process, so the app does not pay a Node cold start (the
// guest's Node binary is large and V8 init is ~800ms) per folder.
function vsockFiles(
  udsPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(udsPath);
    let buffer = "";
    let phase: "handshake" | "response" = "handshake";
    let settled = false;

    const finish = (error: Error | null, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    };

    const timer = setTimeout(
      () => finish(new Error(`sandbox files timed out after ${timeoutMs}ms`)),
      timeoutMs + 5000,
    );

    socket.on("connect", () => {
      socket.write(`CONNECT ${VSOCK_PORT}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      if (phase === "handshake") {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("OK")) {
          finish(new Error(`vsock handshake failed: ${line.slice(0, 120)}`));
          return;
        }
        phase = "response";
        socket.write(JSON.stringify(payload) + "\n");
      }

      if (phase === "response") {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        try {
          finish(null, JSON.parse(line) as Record<string, unknown>);
        } catch {
          finish(new Error(`bad agent response: ${line.slice(0, 200)}`));
        }
      }
    });

    socket.on("error", (error) => finish(error));
  });
}

function attachVnc(botId: string, client: WebSocket) {
  const socket = connect(vsockSock(botId));
  let pending = Buffer.alloc(0);
  const pendingClient: Buffer[] = [];
  let handshake = false;
  let closed = false;
  let resumeTimer: ReturnType<typeof setInterval> | null = null;

  const shutdown = (code = 1011, reason = "vnc stream closed") => {
    if (closed) return;
    closed = true;
    if (resumeTimer) {
      clearInterval(resumeTimer);
      resumeTimer = null;
    }
    socket.destroy();
    try {
      client.close(code, reason);
    } catch {
      // already closed
    }
  };

  const pauseUntilClientDrains = () => {
    socket.pause();
    if (resumeTimer) return;
    resumeTimer = setInterval(() => {
      if (closed || client.readyState !== client.OPEN) {
        if (resumeTimer) {
          clearInterval(resumeTimer);
          resumeTimer = null;
        }
        return;
      }
      if (client.bufferedAmount < VNC_BUFFER_HIGH_WATER_BYTES) {
        if (resumeTimer) {
          clearInterval(resumeTimer);
          resumeTimer = null;
        }
        socket.resume();
      }
    }, 5);
  };

  socket.on("connect", () => {
    socket.setTimeout(15_000);
    socket.write(`CONNECT ${VNC_VSOCK_PORT}\n`);
  });

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    if (!handshake) {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline === -1) return;
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      if (!line.startsWith("OK")) {
        log(`vnc ${botId}: vsock handshake failed: ${line.slice(0, 120)}`);
        shutdown();
        return;
      }
      handshake = true;
      socket.setTimeout(0);
      log(`vnc ${botId}: stream open`);
      for (const payload of pendingClient.splice(0)) {
        if (!socket.write(payload)) {
          client.pause();
          break;
        }
      }
      if (pending.length === 0) return;
      const rest = pending;
      pending = Buffer.alloc(0);
      client.send(rest, { binary: true }, (error) => {
        if (error) shutdown(1011, "client relay failed");
      });
      if (client.bufferedAmount > VNC_BUFFER_HIGH_WATER_BYTES) {
        pauseUntilClientDrains();
      }
      return;
    }
    client.send(chunk, { binary: true }, (error) => {
      if (error) shutdown(1011, "client relay failed");
    });
    if (client.bufferedAmount > VNC_BUFFER_HIGH_WATER_BYTES) {
      pauseUntilClientDrains();
    }
  });

  socket.on("drain", () => {
    if (!closed) client.resume();
  });
  socket.on("timeout", () => shutdown(1013, "guest vnc handshake timed out"));
  socket.on("error", () => shutdown(1011, "guest vnc unavailable"));
  socket.on("close", () => {
    log(`vnc ${botId}: stream closed`);
    shutdown(1011, "guest vnc stream closed");
  });

  client.on("message", (data, isBinary) => {
    if (closed) return;
    const payload = isBinary ? (data as Buffer) : Buffer.from(String(data));
    if (!handshake) {
      pendingClient.push(payload);
      return;
    }
    if (!socket.write(payload)) client.pause();
  });
  client.on("close", () => shutdown(1000, "client closed"));
  client.on("error", () => shutdown(1011, "client websocket failed"));
}

function attachBrowserVnc(botId: string, client: WebSocket) {
  const desktop = browserDesktops.get(botId);
  if (!desktop) {
    client.close(1013, "browser desktop unavailable");
    return;
  }
  const socket = connect({ host: "127.0.0.1", port: desktop.vncPort });
  const pendingClient: Buffer[] = [];
  let connected = false;
  let closed = false;
  let resumeTimer: ReturnType<typeof setInterval> | null = null;

  const shutdown = (code = 1011, reason = "browser vnc stream closed") => {
    if (closed) return;
    closed = true;
    if (resumeTimer) clearInterval(resumeTimer);
    socket.destroy();
    try {
      client.close(code, reason);
    } catch {
      // already closed
    }
  };

  const pauseUntilClientDrains = () => {
    socket.pause();
    if (resumeTimer) return;
    resumeTimer = setInterval(() => {
      if (closed || client.readyState !== client.OPEN) {
        if (resumeTimer) clearInterval(resumeTimer);
        resumeTimer = null;
        return;
      }
      if (client.bufferedAmount < VNC_BUFFER_HIGH_WATER_BYTES) {
        if (resumeTimer) clearInterval(resumeTimer);
        resumeTimer = null;
        socket.resume();
      }
    }, 5);
  };

  socket.on("connect", () => {
    connected = true;
    socket.setNoDelay(true);
    for (const payload of pendingClient.splice(0)) {
      if (!socket.write(payload)) {
        client.pause();
        break;
      }
    }
    log(`vnc ${botId}: browser desktop stream open`);
  });
  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    client.send(chunk, { binary: true }, (error) => {
      if (error) shutdown(1011, "client relay failed");
    });
    if (client.bufferedAmount > VNC_BUFFER_HIGH_WATER_BYTES) {
      pauseUntilClientDrains();
    }
  });
  socket.on("drain", () => {
    if (!closed) client.resume();
  });
  socket.on("error", () => shutdown(1011, "browser vnc unavailable"));
  socket.on("close", () => shutdown(1011, "browser vnc stream closed"));

  client.on("message", (data, isBinary) => {
    if (closed) return;
    const payload = isBinary ? (data as Buffer) : Buffer.from(String(data));
    if (!connected) {
      pendingClient.push(payload);
      return;
    }
    if (!socket.write(payload)) client.pause();
  });
  client.on("close", () => shutdown(1000, "client closed"));
  client.on("error", () => shutdown(1011, "client websocket failed"));
}

// The terminal is a newline-delimited JSON stream in both directions: the
// guest pty bridge frames base64 data, input, and resize messages that way, so
// the host relays whole lines and the client parses them.
function attachTerminal(botId: string, client: WebSocket) {
  const socket = connect(vsockSock(botId));
  let pending = Buffer.alloc(0);
  const pendingClient: Buffer[] = [];
  let handshake = false;
  let closed = false;
  let resumeTimer: ReturnType<typeof setInterval> | null = null;

  const shutdown = (code = 1011, reason = "terminal stream closed") => {
    if (closed) return;
    closed = true;
    if (resumeTimer) {
      clearInterval(resumeTimer);
      resumeTimer = null;
    }
    socket.destroy();
    try {
      client.close(code, reason);
    } catch {
      // already closed
    }
  };

  const pauseUntilClientDrains = () => {
    socket.pause();
    if (resumeTimer) return;
    resumeTimer = setInterval(() => {
      if (closed || client.readyState !== client.OPEN) {
        if (resumeTimer) clearInterval(resumeTimer);
        resumeTimer = null;
        return;
      }
      if (client.bufferedAmount < VNC_BUFFER_HIGH_WATER_BYTES) {
        if (resumeTimer) clearInterval(resumeTimer);
        resumeTimer = null;
        socket.resume();
      }
    }, 5);
  };

  socket.on("connect", () => {
    socket.setTimeout(15_000);
    socket.setNoDelay(true);
    socket.write(`CONNECT ${PTY_VSOCK_PORT}\n`);
  });

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    let payload = chunk;
    if (!handshake) {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline === -1) return;
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      if (!line.startsWith("OK")) {
        log(`terminal ${botId}: vsock handshake failed: ${line.slice(0, 120)}`);
        shutdown();
        return;
      }
      handshake = true;
      socket.setTimeout(0);
      log(`terminal ${botId}: session open`);
      for (const queued of pendingClient.splice(0)) {
        if (!socket.write(queued)) {
          client.pause();
          break;
        }
      }
      if (pending.length === 0) return;
      payload = pending;
      pending = Buffer.alloc(0);
    }
    client.send(payload, { binary: false }, (error) => {
      if (error) shutdown(1011, "client relay failed");
    });
    if (client.bufferedAmount > VNC_BUFFER_HIGH_WATER_BYTES) {
      pauseUntilClientDrains();
    }
  });

  socket.on("drain", () => {
    if (!closed) client.resume();
  });
  socket.on("timeout", () => shutdown(1013, "guest terminal handshake timed out"));
  socket.on("error", () => shutdown(1011, "guest terminal unavailable"));
  socket.on("close", () => shutdown(1011, "guest terminal stream closed"));

  client.on("message", (data, isBinary) => {
    if (closed) return;
    const text = isBinary
      ? (data as Buffer).toString("utf8")
      : String(data);
    const payload = Buffer.from(text.endsWith("\n") ? text : `${text}\n`);
    if (!handshake) {
      pendingClient.push(payload);
      return;
    }
    if (!socket.write(payload)) client.pause();
  });
  client.on("close", () => shutdown(1000, "client closed"));
  client.on("error", () => shutdown(1011, "client websocket failed"));
}

async function ensureVmUnlocked(botId: string): Promise<VmRecord> {
  const existing = vms.get(botId);
  if (existing && (existing.state === "running" || existing.state === "booting")) {
    return existing;
  }

  const record: VmRecord =
    existing ??
    ({
      botId,
      dir: vmDir(botId),
      cid: nextCid++,
      slot: nextSlot++,
      network: null,
      state: "stopped",
      error: null,
      bootedAt: null,
      pid: null,
      pendingUpgrade: null,
    } satisfies VmRecord);
  vms.set(botId, record);
  record.state = "booting";
  record.error = null;
  record.bootedAt = null;

  if (NETWORK_ENABLED && !record.network) {
    record.network = networkFor(record.slot);
  }
  if (record.network) {
    createTap(record.network);
    // Re-apply this VM's egress rules against the fresh tap.
    if (egressPolicies.has(botId)) {
      applyEgressRules();
    }
  }

  mkdirSync(record.dir, { recursive: true });
  const rootfs = join(record.dir, "rootfs.ext4");
  const upgrade = prepareRootfs(botId);
  record.pendingUpgrade = upgrade;
  rmSync(apiSock(botId), { force: true });
  rmSync(vsockSock(botId), { force: true });

  const logFd = openSync(serialLog(botId), "a");
  const child = spawn(FC_BIN, ["--api-sock", apiSock(botId)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  record.pid = child.pid ?? null;
  child.once("exit", (code, signal) => {
    if (record.pid !== child.pid) return;
    record.pid = null;
    record.bootedAt = null;
    if (record.state === "running" || record.state === "booting") {
      record.state = "error";
      record.error = `firecracker exited (${signal ?? code ?? "unknown"})`;
      deleteTap(record.network);
      record.network = null;
      log(`vm ${botId}: ${record.error}`);
    }
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!existsSync(apiSock(botId))) {
    if (Date.now() > deadline) {
      record.state = "error";
      record.error = "firecracker api socket did not appear";
      throw new Error(record.error);
    }
    await sleep(20);
  }

  await fcRequest(apiSock(botId), "PUT", "/boot-source", {
    kernel_image_path: KERNEL,
    boot_args: bootArgsFor(record.network),
  });
  await fcRequest(apiSock(botId), "PUT", "/drives/rootfs", {
    drive_id: "rootfs",
    path_on_host: rootfs,
    is_root_device: true,
    is_read_only: false,
  });
  await fcRequest(apiSock(botId), "PUT", "/machine-config", {
    vcpu_count: 4,
    mem_size_mib: 2048,
  });
  await fcRequest(apiSock(botId), "PUT", "/vsock", {
    guest_cid: record.cid,
    uds_path: vsockSock(botId),
  });
  if (record.network) {
    await fcRequest(apiSock(botId), "PUT", "/network-interfaces/eth0", {
      iface_id: "eth0",
      host_dev_name: record.network.tap,
      guest_mac: record.network.mac,
    });
  }
  await fcRequest(apiSock(botId), "PUT", "/actions", {
    action_type: "InstanceStart",
  });

  while (Date.now() < deadline) {
    try {
      const result = await vsockExec(vsockSock(botId), "true", "/", 5000);
      if (result.exit === 0) {
        const vncProbe = await vsockExec(
          vsockSock(botId),
          "python3 -c 'import socket; s=socket.create_connection((\"127.0.0.1\",5900),5); greeting=s.recv(12); assert greeting.startswith(b\"RFB \")'",
          "/",
          VNC_READY_TIMEOUT_MS,
        );
        if (vncProbe.exit === 0) {
          record.state = "running";
          record.bootedAt = new Date().toISOString();
          log(
            `vm ${botId}: running with desktop ready (cid ${record.cid}, pid ${record.pid})`,
          );
          if (upgrade) archivePreviousRootfs(upgrade);
          record.pendingUpgrade = null;
          return record;
        }
      }
    } catch {
      // Agent or framebuffer is not up yet.
    }
    await sleep(100);
  }

  record.state = "error";
  record.error = "guest agent and desktop did not become ready";
  if (record.pid) {
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      // already gone
    }
    record.pid = null;
  }
  deleteTap(record.network);
  record.network = null;
  if (upgrade) rollbackRootfs(upgrade);
  record.pendingUpgrade = null;
  throw new Error(record.error);
}

function ensureVm(botId: string): Promise<VmRecord> {
  const active = ensures.get(botId);
  if (active) return active;
  const pending = (async () => {
    // Wait for in-flight VM destruction so the capacity check sees the space
    // those destroys are about to free.
    await destroyQueue.catch(() => {});
    return ensureVmUnlocked(botId);
  })()
    .catch((error) => {
      const record = vms.get(botId);
      if (record) {
        if (record.pid) {
          try {
            process.kill(record.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        record.pid = null;
        record.bootedAt = null;
        deleteTap(record.network);
        record.network = null;
        rmSync(apiSock(botId), { force: true });
        rmSync(vsockSock(botId), { force: true });
        if (
          record.pendingUpgrade &&
          existsSync(record.pendingUpgrade.previousRootfs)
        ) {
          rollbackRootfs(record.pendingUpgrade);
        }
        record.pendingUpgrade = null;
        record.state = "error";
        record.error = (error as Error).message;
      }
      throw error;
    })
    .finally(() => {
      if (ensures.get(botId) === pending) ensures.delete(botId);
    });
  ensures.set(botId, pending);
  return pending;
}

function browserDisplayFor(botId: string) {
  const record = vms.get(botId);
  if (!record) throw new Error(`unknown vm: ${botId}`);
  return {
    displayNumber: 99 + record.slot,
    display: `:${99 + record.slot}`,
    vncPort: 5900 + record.slot,
  };
}

function browserUserName(botId: string) {
  const suffix = botId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  return `openbot-${suffix || "browser"}`;
}

function browserIdentity(botId: string): BrowserIdentity {
  const existing = browserIdentities.get(botId);
  if (existing) return existing;

  const user = browserUserName(botId);
  let uidResult = spawnSync("id", ["-u", user], { encoding: "utf8" });
  if (uidResult.status !== 0) {
    const created = spawnSync(
      "useradd",
      [
        "--system",
        "--no-create-home",
        "--home-dir",
        browserProfile(botId),
        "--shell",
        "/usr/sbin/nologin",
        user,
      ],
      { encoding: "utf8" },
    );
    if (created.status !== 0) {
      throw new Error(`could not create browser user: ${created.stderr.trim()}`);
    }
    uidResult = spawnSync("id", ["-u", user], { encoding: "utf8" });
  }
  const gidResult = spawnSync("id", ["-g", user], { encoding: "utf8" });
  const uid = Number.parseInt(uidResult.stdout.trim(), 10);
  const gid = Number.parseInt(gidResult.stdout.trim(), 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(`could not resolve browser user: ${user}`);
  }
  const identity = { user, uid, gid, home: browserProfile(botId) };
  browserIdentities.set(botId, identity);
  return identity;
}

function prepareBrowserIdentity(botId: string) {
  const identity = browserIdentity(botId);
  mkdirSync(identity.home, { recursive: true });
  const runtimeDir = browserRuntimeDir(botId);
  mkdirSync(runtimeDir, { recursive: true });
  chownSync(runtimeDir, identity.uid, identity.gid);
  chmodSync(runtimeDir, 0o700);
  const owned = spawnSync(
    "chown",
    ["-R", `${identity.uid}:${identity.gid}`, identity.home],
    { encoding: "utf8" },
  );
  if (owned.status !== 0) {
    throw new Error(`could not prepare browser profile: ${owned.stderr.trim()}`);
  }
  chmodSync(identity.home, 0o700);
  return identity;
}

function tcpReady(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function stopBrowserDesktop(botId: string) {
  const desktop = browserDesktops.get(botId);
  browserDesktops.delete(botId);
  if (!desktop) return;
  if (desktop.panel?.pid && desktop.panel.exitCode === null) {
    desktop.panel.kill("SIGTERM");
  }
  for (const child of [...desktop.children].reverse()) {
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
  }
  // Xvfb is the last tracked child to go; the terminal and file manager are
  // untracked but exit with the display they are connected to.
  rmSync(`/tmp/.X11-unix/X${desktop.displayNumber}`, { force: true });
  rmSync(`/tmp/.X${desktop.displayNumber}-lock`, { force: true });
}

function tint2Config(botId: string): string {
  return `# OpenBot desktop panel
rounded = 4
border_width = 0
background_color = #0d0f14 82
border_color = #000000 0
background_color_hover = #1a1e26 82
background_color_pressed = #08090c 82

# Task
rounded = 4
border_width = 1
background_color = #ffffff 10
border_color = #ffffff 16
background_color_hover = #ffffff 18
border_color_hover = #ffffff 32
background_color_pressed = #ffffff 8
border_color_pressed = #ffffff 32

# Active task
rounded = 4
border_width = 1
background_color = #2f6fed 46
border_color = #6ea0f8 62
background_color_hover = #2f6fed 56
border_color_hover = #93c5fd 72
background_color_pressed = #2f6fed 34
border_color_pressed = #93c5fd 72

# Tooltip
rounded = 4
border_width = 0
background_color = #0d0f14 96
border_color = #ffffff 0
background_color_hover = #0d0f14 96
background_color_pressed = #0d0f14 96

panel_items = LTSC
panel_size = 100% 32
panel_margin = 0 0
panel_padding = 6 0 6
panel_background_id = 1
panel_position = bottom center horizontal
panel_layer = top
panel_monitor = all
strut_policy = follow_size
panel_window_name = OpenBot
disable_transparency = 1
font_shadow = 0

launcher_padding = 2 0 8
launcher_background_id = 0
launcher_icon_size = 20
launcher_item_app = ${join(launcherDir(botId), "files.desktop")}
launcher_item_app = ${join(launcherDir(botId), "terminal.desktop")}
launcher_item_app = ${join(launcherDir(botId), "browser.desktop")}

taskbar_mode = single_desktop
taskbar_hide_if_empty = 0
taskbar_padding = 0 0 4
taskbar_background_id = 0
taskbar_active_background_id = 0
task_align = left
task_text = 1
task_icon = 1
task_centered = 1
task_maximum_size = 160 32
task_padding = 4 2 6
task_font_color = #e8e8ea 100
task_background_id = 2
task_active_background_id = 3
task_urgent_background_id = 2
task_iconified_background_id = 2
mouse_left = toggle_iconify
mouse_right = close
mouse_scroll_up = toggle
mouse_scroll_down = iconify

time1_format = %H:%M
time2_format = %A %d %B
clock_font_color = #e8e8ea 100
clock_padding = 6 0

tooltip_show_timeout = 0.3
tooltip_hide_timeout = 0.1
tooltip_padding = 6 4
tooltip_background_id = 4
tooltip_font_color = #e8e8ea 100
`;
}

const FILES_DESKTOP = `[Desktop Entry]
Type=Application
Version=1.0
Name=Files
Comment=Browse this computer's files
Exec=thunar /root
Icon=system-file-manager
Terminal=false
Categories=System;FileManager;
`;

const TERMINAL_DESKTOP = `[Desktop Entry]
Type=Application
Version=1.0
Name=Terminal
Comment=Open a terminal
Exec=xterm -title Terminal -fa "DejaVu Sans Mono" -fs 11 -bg #101216 -fg #e6e6e6
Icon=utilities-terminal
Terminal=false
Categories=System;TerminalEmulator;
`;

function browserLauncherScript(botId: string): string {
  const safeId = botId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `#!/usr/bin/env bash
set -u
# Open this agent's Chromium window, or focus it if it is already running.
# The browser daemon owns the profile and launches Chromium on demand.
BOT_ID='${safeId}'
if ! xdotool search --onlyvisible --class chromium-browser >/dev/null 2>&1; then
  curl -s -m 30 -X POST "http://127.0.0.1:4171/vms/$BOT_ID/browser" \\
    -H 'content-type: application/json' -d '{"action":"text"}' >/dev/null 2>&1
fi
xdotool search --onlyvisible --class chromium-browser windowactivate --sync %@ >/dev/null 2>&1 || true
`;
}

function browserDesktopEntry(botId: string): string {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Browser
Comment=Open this agent's browser
Exec=${join(launcherDir(botId), "browser.sh")}
Icon=${CHROMIUM_ICON_PATH}
Terminal=false
Categories=Network;WebBrowser;
`;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function gradientWallpaper(
  width: number,
  height: number,
  top: [number, number, number],
  bottom: [number, number, number],
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    const t = height === 1 ? 0 : y / (height - 1);
    const red = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const green = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const blue = Math.round(top[2] + (bottom[2] - top[2]) * t);
    for (let x = 0; x < width; x += 1) {
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function installChromiumIcon(): void {
  try {
    const browsersDir = join(HOST_BROWSER_RUNTIME, "browsers");
    const entry = readdirSync(browsersDir).find((name) =>
      name.startsWith("chromium-"),
    );
    if (!entry) return;
    const source = join(
      browsersDir,
      entry,
      "chrome-linux",
      "product_logo_48.png",
    );
    if (existsSync(source)) {
      copyFileSync(source, CHROMIUM_ICON_PATH);
    }
  } catch {
    // The icon is cosmetic; the launcher works without it.
  }
}

function writeDesktopAssets(botId: string): void {
  mkdirSync(DESKTOP_ASSET_DIR, { recursive: true });
  if (!existsSync(WALLPAPER_PATH)) {
    writeFileSync(
      WALLPAPER_PATH,
      gradientWallpaper(1280, 800, [15, 17, 23], [45, 50, 68]),
    );
  }
  installChromiumIcon();
  const dir = launcherDir(botId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "files.desktop"), FILES_DESKTOP);
  writeFileSync(join(dir, "terminal.desktop"), TERMINAL_DESKTOP);
  const script = join(dir, "browser.sh");
  writeFileSync(script, browserLauncherScript(botId));
  chmodSync(script, 0o755);
  writeFileSync(join(dir, "browser.desktop"), browserDesktopEntry(botId));
  writeFileSync(tint2ConfigPath(botId), tint2Config(botId));
}

function desktopEnvironment(
  botId: string,
  display: string,
): NodeJS.ProcessEnv {
  const runtimeDir = join(vmDir(botId), "desktop-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  chmodSync(runtimeDir, 0o700);
  return {
    ...process.env,
    DISPLAY: display,
    HOME: "/root",
    XDG_CONFIG_HOME: join(vmDir(botId), "desktop-config"),
    XDG_CACHE_HOME: join(vmDir(botId), "desktop-cache"),
    XDG_RUNTIME_DIR: runtimeDir,
  };
}

function startDesktopPanel(
  botId: string,
  display: string,
): ReturnType<typeof spawn> {
  const logFd = openSync(browserLog(botId), "a");
  const panel = spawn("tint2", ["-c", tint2ConfigPath(botId)], {
    stdio: ["ignore", logFd, logFd],
    env: desktopEnvironment(botId, display),
  });
  closeSync(logFd);
  return panel;
}

async function ensureBrowserDesktop(botId: string) {
  const existing = browserDesktops.get(botId);
  if (
    existing &&
    existing.children.every((child) => child.exitCode === null) &&
    existsSync(`/tmp/.X11-unix/X${existing.displayNumber}`) &&
    (await tcpReady("127.0.0.1", existing.vncPort))
  ) {
    if (!existing.panel || existing.panel.exitCode !== null) {
      existing.panel = startDesktopPanel(botId, existing.display);
    }
    return existing;
  }
  stopBrowserDesktop(botId);

  const { display, displayNumber, vncPort } = browserDisplayFor(botId);
  mkdirSync(vmDir(botId), { recursive: true });
  rmSync(`/tmp/.X11-unix/X${displayNumber}`, { force: true });
  rmSync(`/tmp/.X${displayNumber}-lock`, { force: true });
  writeDesktopAssets(botId);
  const logFd = openSync(browserLog(botId), "a");
  const desktopEnv = desktopEnvironment(botId, display);
  mkdirSync(desktopEnv.XDG_CONFIG_HOME as string, { recursive: true });
  mkdirSync(desktopEnv.XDG_CACHE_HOME as string, { recursive: true });

  const xvfb = spawn(
    "Xvfb",
    [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac", "-noreset"],
    { stdio: ["ignore", logFd, logFd], env: desktopEnv },
  );
  const children = [xvfb];
  const displayDeadline = Date.now() + 10_000;
  while (!existsSync(`/tmp/.X11-unix/X${displayNumber}`)) {
    if (xvfb.exitCode !== null || Date.now() >= displayDeadline) {
      closeSync(logFd);
      if (xvfb.pid && xvfb.exitCode === null) xvfb.kill("SIGKILL");
      rmSync(`/tmp/.X11-unix/X${displayNumber}`, { force: true });
      rmSync(`/tmp/.X${displayNumber}-lock`, { force: true });
      throw new Error("browser display did not become ready");
    }
    await sleep(50);
  }

  const openbox = spawn("openbox", [], {
    stdio: ["ignore", logFd, logFd],
    env: desktopEnv,
  });
  spawn("feh", ["--bg-fill", WALLPAPER_PATH], {
    stdio: ["ignore", logFd, logFd],
    env: desktopEnv,
  });
  const panel = spawn("tint2", ["-c", tint2ConfigPath(botId)], {
    stdio: ["ignore", logFd, logFd],
    env: desktopEnv,
  });
  spawn(
    "xterm",
    [
      "-title",
      "Terminal",
      "-geometry",
      "100x24+24+64",
      "-fa",
      "DejaVu Sans Mono",
      "-fs",
      "11",
      "-bg",
      "#101216",
      "-fg",
      "#e6e6e6",
    ],
    { stdio: ["ignore", logFd, logFd], env: desktopEnv },
  );
  const x11vnc = spawn(
    "x11vnc",
    [
      "-display",
      display,
      "-forever",
      "-shared",
      "-nopw",
      "-localhost",
      "-rfbport",
      String(vncPort),
      "-nothreads",
      // Draw the pointer into the framebuffer so viewers can see where the
      // model (or the user) is pointing; noVNC only renders cursor shapes at
      // the local pointer position otherwise.
      "-nocursorshape",
      "-wait",
      "16",
      "-defer",
      "10",
      "-speeds",
      "lan",
    ],
    { stdio: ["ignore", logFd, logFd], env: desktopEnv },
  );
  children.push(openbox, x11vnc);
  closeSync(logFd);
  const desktop = { display, displayNumber, vncPort, children, panel };
  browserDesktops.set(botId, desktop);

  const vncDeadline = Date.now() + 10_000;
  while (!(await tcpReady("127.0.0.1", vncPort))) {
    if (x11vnc.exitCode !== null || Date.now() >= vncDeadline) {
      stopBrowserDesktop(botId);
      throw new Error("browser VNC display did not become ready");
    }
    await sleep(50);
  }
  log(`browser ${botId}: desktop ready on ${display}, VNC ${vncPort}`);
  return desktop;
}

function browserEnvironment(botId: string): NodeJS.ProcessEnv {
  const desktop = browserDesktops.get(botId);
  if (!desktop) throw new Error(`browser desktop is not running: ${botId}`);
  const identity = browserIdentity(botId);
  return {
    ...process.env,
    HOME: identity.home,
    USER: identity.user,
    LOGNAME: identity.user,
    XDG_CONFIG_HOME: join(identity.home, ".config"),
    XDG_CACHE_HOME: join(identity.home, ".cache"),
    DISPLAY: desktop.display,
    OPENBOT_BROWSER_DISPLAY: desktop.display,
    OPENBOT_BROWSER_HEADLESS: "0",
    OPENBOT_BROWSER_PROFILE: browserProfile(botId),
    OPENBOT_BROWSER_RUNTIME: HOST_BROWSER_RUNTIME,
    OPENBOT_BROWSER_SOCKET: browserSocket(botId),
    OPENBOT_BROWSER_HAR: join(vmDir(botId), "network.har"),
    OPENBOT_BROWSER_DOWNLOADS: join(vmDir(botId), "browser-downloads"),
  };
}

function browserDaemonToken(botId: string) {
  return `${HOST_BROWSER_SCRIPT} serve ${botId}`;
}

async function ensureBrowserDaemon(botId: string) {
  await ensureBrowserDesktop(botId);
  const existing = browserDaemons.get(botId);
  if (existing?.pid && existing.exitCode === null && existsSync(browserSocket(botId))) {
    return;
  }
  mkdirSync(vmDir(botId), { recursive: true });
  const identity = prepareBrowserIdentity(botId);
  // The browser daemon runs as the unprivileged browser account; give it a
  // writable network trace file before it starts.
  const harPath = join(vmDir(botId), "network.har");
  if (!existsSync(harPath)) {
    writeFileSync(
      harPath,
      '{"log":{"version":"1.2","creator":{"name":"openbot-browser","version":"1.0"},"entries":[]}}',
    );
  }
  chownSync(harPath, identity.uid, identity.gid);
  chmodSync(harPath, 0o600);
  const downloadsDir = join(vmDir(botId), "browser-downloads");
  mkdirSync(downloadsDir, { recursive: true });
  chownSync(downloadsDir, identity.uid, identity.gid);
  rmSync(browserSocket(botId), { force: true });
  // A host-service restart leaves the previous daemon untracked. Kill it so
  // the new process loads the current browser script instead of stale code.
  spawnSync("pkill", ["-f", browserDaemonToken(botId)], { stdio: "ignore" });
  const logFd = openSync(browserLog(botId), "a");
  const child = spawn(
    "/usr/local/bin/node",
    [HOST_BROWSER_SCRIPT, "serve", botId],
    {
      stdio: ["ignore", logFd, logFd],
      env: browserEnvironment(botId),
      uid: identity.uid,
      gid: identity.gid,
    },
  );
  closeSync(logFd);
  browserDaemons.set(botId, child);
  child.once("exit", (code, signal) => {
    if (browserDaemons.get(botId) === child) {
      browserDaemons.delete(botId);
    }
    rmSync(browserSocket(botId), { force: true });
    log(`browser ${botId}: daemon exited (${signal ?? code ?? "unknown"})`);
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(browserSocket(botId))) {
    if (child.exitCode !== null) {
      throw new Error(`browser daemon exited during startup (${child.exitCode})`);
    }
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      throw new Error("browser daemon did not become ready");
    }
    await sleep(50);
  }
  log(`browser ${botId}: daemon ready (pid ${child.pid})`);
}

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * File inputs live in the browser, which runs on this host, while the agent's
 * files live in its microVM. An upload stages each guest path as a host copy
 * the browser account can read, then the browser action references those.
 */
async function stageUploadFiles(
  botId: string,
  guestPaths: unknown[],
): Promise<string[]> {
  const identity = browserIdentity(botId);
  const dir = join(browserRuntimeDir(botId), "uploads");
  mkdirSync(dir, { recursive: true });
  const staged: string[] = [];
  for (const rawPath of guestPaths) {
    const guestPath = String(rawPath ?? "");
    if (!guestPath) {
      throw new Error("each upload file needs a path in the computer");
    }
    const result = await vsockExec(
      vsockSock(botId),
      `base64 -w0 -- ${shellQuote(guestPath)}`,
      "/",
      30_000,
    );
    if (result.exit !== 0) {
      throw new Error(
        result.stderr.trim() || `could not read ${guestPath} in the computer`,
      );
    }
    const data = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    if (data.length > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${guestPath} is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB upload limit`,
      );
    }
    const target = join(
      dir,
      `upload-${randomUUID()}${extname(guestPath).slice(0, 12)}`,
    );
    writeFileSync(target, data);
    chownSync(target, identity.uid, identity.gid);
    chmodSync(target, 0o600);
    staged.push(target);
  }
  return staged;
}

const MAX_DOWNLOAD_FETCH_BYTES = 16 * 1024 * 1024;

/**
 * Downloads save on this host (where Chromium runs), but the model works in
 * its microVM, so a `downloads` action copies them into /root/Downloads and
 * returns those paths.
 */
async function fetchDownloads(botId: string): Promise<Record<string, unknown>> {
  const dir = join(vmDir(botId), "browser-downloads");
  if (!existsSync(dir)) {
    return { ok: true, url: "", title: "", text: "no downloads yet" };
  }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".crdownload"))
    .map((entry) => {
      const path = join(dir, entry.name);
      return { name: entry.name, size: statSync(path).size, path };
    });
  if (files.length === 0) {
    return { ok: true, url: "", title: "", text: "no downloads yet" };
  }
  const guestDir = "/root/Downloads";
  const lines: string[] = [];
  for (const file of files) {
    if (file.size > MAX_DOWNLOAD_FETCH_BYTES) {
      lines.push(
        `${file.name} (${file.size} bytes) — too large to copy into the computer`,
      );
      continue;
    }
    const encoded = readFileSync(file.path).toString("base64");
    const result = await vsockExec(
      vsockSock(botId),
      `mkdir -p ${shellQuote(guestDir)} && ` +
        `printf %s ${shellQuote(encoded)} | base64 -d > ` +
        shellQuote(`${guestDir}/${file.name}`),
      "/",
      60_000,
    );
    if (result.exit !== 0) {
      lines.push(
        `${file.name} (${file.size} bytes) — copy failed: ` +
          `${result.stderr.trim().slice(0, 120)}`,
      );
      continue;
    }
    lines.push(`${guestDir}/${file.name} (${file.size} bytes)`);
  }
  return {
    ok: true,
    url: "",
    title: "",
    text: `Downloads copied into the computer:\n${lines.join("\n")}`,
  };
}

async function runBrowserAction(
  botId: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  await ensureBrowserDaemon(botId);
  const identity = browserIdentity(botId);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/local/bin/node",
      [HOST_BROWSER_SCRIPT, "action", JSON.stringify(payload)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: browserEnvironment(botId),
        uid: identity.uid,
        gid: identity.gid,
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve({
          ...(JSON.parse(stdout.trim()) as Record<string, unknown>),
          durationMs: Date.now() - startedAt,
        });
      } catch {
        reject(
          new Error(
            `invalid browser response: ${(stderr || stdout).slice(0, 400)}`,
          ),
        );
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`browser action timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish());
  });
}

const DESKTOP_WIDTH = 1280;
const DESKTOP_HEIGHT = 800;
const DESKTOP_BUTTONS: Record<string, number> = {
  left: 1,
  middle: 2,
  right: 3,
};
const DESKTOP_SCROLL_BUTTONS: Record<string, number> = {
  up: 4,
  down: 5,
  left: 6,
  right: 7,
};
const DESKTOP_KEY_PATTERN = /^[A-Za-z0-9_+ -]+$/;
const DESKTOP_MAX_TYPE_CHARS = 8_000;

function xdotool(
  env: NodeJS.ProcessEnv,
  args: string[],
  timeoutMs = 10_000,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("xdotool", args, {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function requireNumber(
  value: unknown,
  name: string,
  maximum: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  const rounded = Math.round(parsed);
  if (rounded < 0 || rounded > maximum) {
    throw new Error(`${name} must be between 0 and ${maximum}`);
  }
  return rounded;
}

function requireCount(value: unknown, fallback: number, maximum: number) {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("count must be a number");
  }
  const rounded = Math.round(parsed);
  if (rounded < 1 || rounded > maximum) {
    throw new Error(`count must be between 1 and ${maximum}`);
  }
  return rounded;
}

function cursorPosition(
  env: NodeJS.ProcessEnv,
): { x: number; y: number } | null {
  const result = xdotool(env, ["getmouselocation", "--shell"]);
  if (result.status !== 0) return null;
  const x = /X=(\d+)/.exec(result.stdout)?.[1];
  const y = /Y=(\d+)/.exec(result.stdout)?.[1];
  return x && y ? { x: Number(x), y: Number(y) } : null;
}

function activeWindowName(env: NodeJS.ProcessEnv): string | null {
  const result = xdotool(env, ["getactivewindow", "getwindowname"]);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function visibleWindowTitles(env: NodeJS.ProcessEnv): string[] {
  const result = xdotool(env, [
    "search",
    "--onlyvisible",
    "--name",
    ".*",
    "getwindowname",
    "%@",
  ]);
  if (result.status !== 0) return [];
  return [
    ...new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function captureDesktop(botId: string, env: NodeJS.ProcessEnv): string {
  const path = join(vmDir(botId), "desktop-screenshot.png");
  rmSync(path, { force: true });
  // -p draws the pointer into the capture so the model and the user can see
  // where the pointer is.
  const result = spawnSync("scrot", ["-p", "-o", path], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0 || !existsSync(path)) {
    throw new Error(result.stderr?.trim() || "desktop screenshot failed");
  }
  return readFileSync(path).toString("base64");
}

async function runDesktopAction(
  botId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const action = typeof payload.action === "string" ? payload.action : "";
  try {
    if (!action) {
      throw new Error("action is required");
    }
    const desktop = await ensureBrowserDesktop(botId);
    const env = desktopEnvironment(botId, desktop.display);
    let detail = "";

    switch (action) {
      case "screenshot": {
        detail = "captured the desktop";
        break;
      }
      case "move": {
        const x = requireNumber(payload.x, "x", DESKTOP_WIDTH - 1);
        const y = requireNumber(payload.y, "y", DESKTOP_HEIGHT - 1);
        const result = xdotool(env, [
          "mousemove",
          "--sync",
          String(x),
          String(y),
        ]);
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || "could not move the pointer");
        }
        detail = `moved the pointer to ${x},${y}`;
        break;
      }
      case "click": {
        const x = requireNumber(payload.x, "x", DESKTOP_WIDTH - 1);
        const y = requireNumber(payload.y, "y", DESKTOP_HEIGHT - 1);
        const buttonName = String(payload.button ?? "left");
        const button = DESKTOP_BUTTONS[buttonName];
        if (!button) {
          throw new Error("button must be left, middle, or right");
        }
        const count = requireCount(payload.count, 1, 3);
        const result = xdotool(env, [
          "mousemove",
          "--sync",
          String(x),
          String(y),
          "click",
          "--repeat",
          String(count),
          "--delay",
          "60",
          String(button),
        ]);
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || "click failed");
        }
        detail = `${count > 1 ? `${count}x ` : ""}${buttonName} click at ${x},${y}`;
        break;
      }
      case "drag": {
        const fromX = requireNumber(payload.fromX, "fromX", DESKTOP_WIDTH - 1);
        const fromY = requireNumber(payload.fromY, "fromY", DESKTOP_HEIGHT - 1);
        const toX = requireNumber(payload.toX, "toX", DESKTOP_WIDTH - 1);
        const toY = requireNumber(payload.toY, "toY", DESKTOP_HEIGHT - 1);
        const buttonName = String(payload.button ?? "left");
        const button = DESKTOP_BUTTONS[buttonName];
        if (!button) {
          throw new Error("button must be left, middle, or right");
        }
        const durationMs =
          payload.durationMs === undefined
            ? 400
            : requireNumber(payload.durationMs, "durationMs", 5_000);
        const steps = Math.max(4, Math.min(20, Math.round(durationMs / 40)));
        const args = [
          "mousemove",
          "--sync",
          String(fromX),
          String(fromY),
          "mousedown",
          String(button),
        ];
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          const x = Math.round(fromX + (toX - fromX) * t);
          const y = Math.round(fromY + (toY - fromY) * t);
          args.push(
            "mousemove",
            "--sync",
            String(x),
            String(y),
            "sleep",
            "0.03",
          );
        }
        args.push("mouseup", String(button));
        const result = xdotool(env, args, durationMs + 10_000);
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || "drag failed");
        }
        detail = `dragged the ${buttonName} button from ${fromX},${fromY} to ${toX},${toY}`;
        break;
      }
      case "scroll": {
        const x = requireNumber(payload.x, "x", DESKTOP_WIDTH - 1);
        const y = requireNumber(payload.y, "y", DESKTOP_HEIGHT - 1);
        const direction = String(payload.direction ?? "down");
        const button = DESKTOP_SCROLL_BUTTONS[direction];
        if (!button) {
          throw new Error("direction must be up, down, left, or right");
        }
        const amount = requireCount(payload.amount, 3, 50);
        const result = xdotool(env, [
          "mousemove",
          "--sync",
          String(x),
          String(y),
          "click",
          "--repeat",
          String(amount),
          "--delay",
          "30",
          String(button),
        ]);
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || "scroll failed");
        }
        detail = `scrolled ${direction} ${amount} step${amount === 1 ? "" : "s"} at ${x},${y}`;
        break;
      }
      case "type": {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text) {
          throw new Error("text is required");
        }
        if (text.length > DESKTOP_MAX_TYPE_CHARS) {
          throw new Error(
            `text is limited to ${DESKTOP_MAX_TYPE_CHARS} characters`,
          );
        }
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (line) {
            const typed = xdotool(env, [
              "type",
              "--clearmodifiers",
              "--delay",
              "12",
              "--",
              line,
            ]);
            if (typed.status !== 0) {
              throw new Error(typed.stderr.trim() || "typing failed");
            }
          }
          if (index < lines.length - 1) {
            const enter = xdotool(env, ["key", "--clearmodifiers", "Return"]);
            if (enter.status !== 0) {
              throw new Error(enter.stderr.trim() || "typing failed");
            }
          }
        }
        detail = `typed ${text.length} character${text.length === 1 ? "" : "s"}`;
        break;
      }
      case "key": {
        const keys = typeof payload.keys === "string" ? payload.keys.trim() : "";
        if (!keys || keys.startsWith("-") || !DESKTOP_KEY_PATTERN.test(keys)) {
          throw new Error(
            "keys must be a key combination such as Return, alt+F4, or ctrl+shift+t",
          );
        }
        const result = xdotool(env, ["key", "--clearmodifiers", keys]);
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || "key press failed");
        }
        detail = `pressed ${keys}`;
        break;
      }
      case "wait": {
        const milliseconds = requireNumber(payload.milliseconds, "milliseconds", 10_000);
        await sleep(milliseconds);
        detail = `waited ${milliseconds}ms`;
        break;
      }
      case "windows": {
        const titles = visibleWindowTitles(env);
        detail = titles.length
          ? `visible windows:\n${titles.map((title) => `- ${title}`).join("\n")}`
          : "no visible windows";
        break;
      }
      case "activate": {
        const title = typeof payload.title === "string" ? payload.title.trim() : "";
        if (!title) {
          throw new Error("title is required");
        }
        const search = xdotool(env, ["search", "--onlyvisible", "--name", title]);
        const ids = search.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        if (ids.length === 0) {
          throw new Error(`no visible window matches: ${title}`);
        }
        const target = ids[ids.length - 1] as string;
        const result = xdotool(env, ["windowactivate", "--sync", target]);
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || "could not activate the window");
        }
        detail = `activated ${activeWindowName(env) ?? title}`;
        break;
      }
      default:
        throw new Error(`unknown desktop action: ${action}`);
    }

    const observe = payload.screenshot === true || action === "screenshot";
    const screenshot = observe ? captureDesktop(botId, env) : null;
    return {
      ok: true,
      action,
      detail,
      width: DESKTOP_WIDTH,
      height: DESKTOP_HEIGHT,
      cursor: cursorPosition(env),
      window: activeWindowName(env),
      ...(screenshot ? { screenshot } : {}),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      action,
      error: (error as Error).message,
      durationMs: Date.now() - startedAt,
    };
  }
}

function stopBrowser(botId: string) {
  const child = browserDaemons.get(botId);
  browserDaemons.delete(botId);
  if (child?.pid) {
    child.kill("SIGTERM");
  }
  spawnSync("pkill", ["-f", browserDaemonToken(botId)], { stdio: "ignore" });
  spawnSync("pkill", ["-f", browserProfile(botId)], { stdio: "ignore" });
  rmSync(browserSocket(botId), { force: true });
  stopBrowserDesktop(botId);
}

// A site can flag a profile and serve it a bot check forever, even after the
// user solves it. Moving the profile aside gives that agent a clean browser
// while keeping one backup for recovery.
function resetBrowserProfile(botId: string): {
  botId: string;
  backup: string | null;
} {
  stopBrowser(botId);
  const profile = browserProfile(botId);
  let backup: string | null = null;
  if (existsSync(profile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${profile}.flagged-${stamp}`;
    renameSync(profile, target);
    backup = target;
    const base = browserProfile(botId).split("/").pop() ?? "browser-profile";
    const backups = readdirSync(vmDir(botId))
      .filter((entry) => entry.startsWith(`${base}.flagged-`))
      .sort()
      .slice(0, -1);
    for (const stale of backups) {
      rmSync(join(vmDir(botId), stale), { recursive: true, force: true });
    }
  }
  mkdirSync(profile, { recursive: true });
  log(`browser ${botId}: profile reset${backup ? ` (backup ${backup})` : ""}`);
  return { botId, backup };
}

async function stopVm(record: VmRecord) {
  stopBrowser(record.botId);
  const pid = record.pid;
  record.state = "stopped";
  record.pid = null;
  record.bootedAt = null;
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already dead
    }
    await sleep(300);
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // exited after SIGTERM
    }
  }
  deleteTap(record.network);
  record.network = null;
  rmSync(apiSock(record.botId), { force: true });
  rmSync(vsockSock(record.botId), { force: true });
  log(`vm ${record.botId}: stopped`);
}

/**
 * Rootfs cleanup and creation must not race: destroying a VM frees several GiB
 * that the next VM's capacity check and rootfs copy need. Creation waits for
 * in-flight destroys before it checks capacity, so deleting an agent and
 * immediately creating another cannot fail on space that is already being
 * freed.
 */
let destroyQueue: Promise<unknown> = Promise.resolve();

function destroyVm(botId: string): Promise<void> {
  const run = destroyQueue.then(
    () => destroyVmUnlocked(botId),
    () => destroyVmUnlocked(botId),
  );
  destroyQueue = run.catch(() => {});
  return run;
}

async function destroyVmUnlocked(botId: string) {
  const record = vms.get(botId);
  if (record) {
    await stopVm(record);
    vms.delete(botId);
  }
  if (egressPolicies.delete(botId)) {
    applyEgressRules();
  }
  // Worker sessions key their browser by task id and have no VM of their own,
  // so the browser daemon and profile still need to be released here.
  stopBrowser(botId);
  rmSync(vmDir(botId), { recursive: true, force: true });
  rmSync(browserRuntimeDir(botId), { recursive: true, force: true });
  browserIdentities.delete(botId);
  const user = browserUserName(botId);
  if (spawnSync("id", ["-u", user]).status === 0) {
    spawnSync("userdel", [user], { stdio: "ignore" });
  }
}

/**
 * Remove stopped VM directories this owner no longer uses. A daemon calls this
 * on startup with every computer id it still knows; anything else it owns was
 * deleted while the daemon or host was down, and its rootfs would otherwise
 * sit on disk forever. VMs owned by another daemon, and VMs without an owner
 * marker (created before ownership was recorded), are left alone.
 */
function pruneOwnedVms(keep: Set<string>, owner: string): string[] {
  if (!existsSync(VMS_DIR)) {
    return [];
  }
  const removed: string[] = [];
  for (const entry of readdirSync(VMS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (keep.has(id)) continue;
    const record = vms.get(id);
    if (record?.pid) continue;
    const ownerFile = join(VMS_DIR, id, "owner");
    const vmOwner = existsSync(ownerFile)
      ? readFileSync(ownerFile, "utf8").trim()
      : "";
    if (vmOwner !== owner) continue;
    stopBrowser(id);
    vms.delete(id);
    rmSync(join(VMS_DIR, id), { recursive: true, force: true });
    rmSync(browserRuntimeDir(id), { recursive: true, force: true });
    browserIdentities.delete(id);
    const user = browserUserName(id);
    if (spawnSync("id", ["-u", user]).status === 0) {
      spawnSync("userdel", [user], { stdio: "ignore" });
    }
    removed.push(id);
  }
  return removed;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${(error as Error).message}`));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const owner =
    String(request.headers["x-openbot-owner"] ?? "").trim() || "default";

  await requestOwner.run(owner, async () => {
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      const capacity = imageCapacity();
      sendJson(response, 200, {
        ok: true,
        vms: vms.size,
        disk: {
          freeBytes: capacity.freeBytes,
          requiredBytes: capacity.requiredBytes,
          canStartVm: capacity.freeBytes >= capacity.requiredBytes,
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/prune") {
      const body = (await readJsonBody(request)) as { keep?: unknown };
      const keep = new Set(
        Array.isArray(body.keep) ? body.keep.map((id) => String(id)) : [],
      );
      const owner = requestOwner.getStore() ?? "default";
      const removed = pruneOwnedVms(keep, owner);
      log(
        `prune ${owner}: kept ${keep.size}, removed ${removed.length}` +
          (removed.length ? ` (${removed.join(", ")})` : ""),
      );
      sendJson(response, 200, { removed });
      return;
    }

    if (
      request.method === "GET" &&
      parts[0] === "vms" &&
      parts[1] &&
      parts[2] === "network"
    ) {
      const botId = decodeURIComponent(parts[1]);
      const harPath = join(vmDir(botId), "network.har");
      if (!existsSync(harPath)) {
        sendJson(response, 404, { error: "no network trace yet" });
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(readFileSync(harPath));
      return;
    }

    if (parts[0] !== "vms" || !parts[1]) {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    const botId = decodeURIComponent(parts[1]);
    const action = parts[2];

    if (request.method === "POST" && action === "network-policy") {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const allow = Array.isArray(body.allow)
        ? body.allow.map((entry) => String(entry)).filter(Boolean)
        : [];
      const result =
        body.mode === "deny"
          ? await setEgressPolicy(botId, { mode: "deny", allow })
          : await setEgressPolicy(botId, null);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "GET" && action === "status") {
      const record = await adoptVmIfRunning(botId);
      sendJson(
        response,
        200,
        record
          ? statusOf(record)
          : {
              botId,
              state: "stopped",
              cid: null,
              bootedAt: null,
              error: null,
            },
      );
      return;
    }

    if (request.method === "POST" && action === "ensure") {
      const record = await ensureVm(botId);
      sendJson(response, 200, statusOf(record));
      return;
    }

    if (request.method === "POST" && action === "exec") {
      const body = (await readJsonBody(request)) as {
        command?: string;
        cwd?: string;
        timeoutMs?: number;
        stream?: boolean;
      };
      if (!body.command || typeof body.command !== "string") {
        sendJson(response, 400, { error: "command is required" });
        return;
      }
      const record = await ensureVm(botId);
      const timeoutMs = body.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const startedAt = Date.now();
      if (body.stream) {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        });
        const result = await vsockExec(
          vsockSock(botId),
          `bash -c ${shellQuote(body.command)}`,
          body.cwd ?? "/",
          timeoutMs,
          (stream, data) => {
            response.write(
              JSON.stringify({ type: "chunk", stream, data }) + "\n",
            );
          },
        );
        response.end(
          JSON.stringify({
            type: "result",
            exit: result.exit,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: Date.now() - startedAt,
          }) + "\n",
        );
        return;
      }
      const result = await vsockExec(
        vsockSock(botId),
        `bash -c ${shellQuote(body.command)}`,
        body.cwd ?? "/",
        timeoutMs,
      );
      sendJson(response, 200, {
        exit: result.exit,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (request.method === "POST" && action === "files") {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const op = body.op;
      if (op !== "list" && op !== "read") {
        sendJson(response, 400, { error: "op must be list or read" });
        return;
      }
      await ensureVm(botId);
      const result = await vsockFiles(vsockSock(botId), body, 20_000);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && action === "browser" && parts[3] === "reset") {
      sendJson(response, 200, resetBrowserProfile(botId));
      return;
    }

    if (request.method === "POST" && action === "browser") {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      if (typeof body.action !== "string" || !body.action) {
        sendJson(response, 400, { error: "browser action is required" });
        return;
      }
      await ensureVm(botId);
      const isExec = body.action === "exec";
      const requested =
        typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
      const timeoutMs = Math.min(
        Math.max(requested ?? (isExec ? 60_000 : 75_000), 1_000),
        isExec ? 300_000 : 90_000,
      );
      if (body.action === "downloads") {
        sendJson(response, 200, await fetchDownloads(botId));
        return;
      }
      const { timeoutMs: _ignored, ...payload } = body;
      let actionPayload = payload;
      if (body.action === "upload") {
        const files = Array.isArray(body.files) ? body.files : [];
        try {
          actionPayload = {
            ...payload,
            files: await stageUploadFiles(botId, files),
          };
        } catch (error) {
          sendJson(response, 400, { error: (error as Error).message });
          return;
        }
      }
      const result = await runBrowserAction(
        botId,
        isExec ? { ...actionPayload, timeoutMs } : actionPayload,
        isExec ? timeoutMs + 15_000 : timeoutMs,
      );
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && action === "desktop") {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      if (typeof body.action !== "string" || !body.action) {
        sendJson(response, 400, { error: "desktop action is required" });
        return;
      }
      await ensureVm(botId);
      const result = await runDesktopAction(botId, body);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && action === "stop") {
      const record = vms.get(botId);
      if (record) {
        await stopVm(record);
      }
      sendJson(response, 200, {
        botId,
        state: "stopped",
        cid: null,
        bootedAt: null,
        error: null,
      });
      return;
    }

    if (request.method === "POST" && action === "destroy") {
      await destroyVm(botId);
      sendJson(response, 200, {
        botId,
        state: "stopped",
        cid: null,
        bootedAt: null,
        error: null,
      });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    log(`request failed: ${(error as Error).message}`);
    sendJson(response, 500, { error: (error as Error).message });
  }
  });
});

const vncWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const terminalMatch = /^\/vms\/([^/]+)\/terminal$/.exec(url.pathname);
  if (terminalMatch) {
    const botId = decodeURIComponent(terminalMatch[1] ?? "");
    void adoptVmIfRunning(botId)
      .then((record) => {
        if (!record || record.state !== "running") {
          socket.write(
            "HTTP/1.1 409 Conflict\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
          );
          socket.destroy();
          return;
        }
        terminalWss.handleUpgrade(request, socket, head, (client) => {
          attachTerminal(botId, client);
        });
      })
      .catch((error) => {
        log(`terminal ${botId}: ${(error as Error).message}`);
        socket.destroy();
      });
    return;
  }
  const match = /^\/vms\/([^/]+)\/vnc$/.exec(url.pathname);
  if (!match) {
    socket.destroy();
    return;
  }
  const botId = decodeURIComponent(match[1] ?? "");
  void adoptVmIfRunning(botId)
    .then((record) => {
      if (!record || record.state !== "running") {
        socket.write(
          "HTTP/1.1 409 Conflict\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        );
        socket.destroy();
        return null;
      }
      return ensureBrowserDesktop(botId);
    })
    .then(() => {
      if (socket.destroyed) {
        return;
      }
      vncWss.handleUpgrade(request, socket, head, (client) => {
        attachBrowserVnc(botId, client);
      });
    })
    .catch((error) => {
      log(`vnc ${botId}: browser desktop failed: ${(error as Error).message}`);
      if (socket.destroyed) {
        return;
      }
      vncWss.handleUpgrade(request, socket, head, (client) => {
        attachVnc(botId, client);
      });
    });
});

function cleanup() {
  try {
    execSync("pkill -f 'firecracker --api-sock' || true");
    execSync("pkill -f '/var/lib/fc/openbot/browser.js' || true");
  } catch {
    // nothing running
  }
  const links = tryExec("ip -o link show") ?? "";
  for (const match of links.matchAll(/\b(tap\d+)\b/g)) {
    tryExec(`ip link del ${match[1]}`);
  }
}

cleanup();
setupNat();
mkdirSync(VMS_DIR, { recursive: true });
// A restart drops the in-memory policies; clear any rules they left behind so
// the daemon re-applies them per turn.
tryExec(`nft delete table inet ${EGRESS_TABLE}`);

server.listen(PORT, "127.0.0.1", () => {
  log(`openbot sandbox host listening on http://127.0.0.1:${PORT}`);
  log(`base rootfs: ${BASE_ROOTFS}, kernel: ${KERNEL}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("shutting down, stopping vms");
    for (const botId of browserDaemons.keys()) {
      stopBrowser(botId);
    }
    for (const record of vms.values()) {
      if (record.pid) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    process.exit(0);
  });
}
