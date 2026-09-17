import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { connect } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

const FC_BIN = process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
const FC_DIR = process.env.FC_DIR ?? "/var/lib/fc";
const HOST_BROWSER_RUNTIME = join(FC_DIR, "openbot-browser-host");
const HOST_BROWSER_SCRIPT = join(FC_DIR, "openbot/browser.js");
const BASE_ROOTFS = join(FC_DIR, "rootfs.ext4");
const BASE_VERSION_FILE = join(FC_DIR, "rootfs.version");
const KERNEL = join(FC_DIR, "vmlinux");
const VMS_DIR = join(FC_DIR, "vms");
const PORT = Number(process.env.OPENBOT_HOST_PORT ?? 4171);
const VSOCK_PORT = 5000;
const VNC_VSOCK_PORT = 5900;
const DEFAULT_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 120_000;
const VNC_READY_TIMEOUT_MS = 30_000;
const VNC_BUFFER_HIGH_WATER_BYTES = 256 * 1024;
const ROOTFS_BACKUP_RETENTION = 1;
const NETWORK_ENABLED = process.env.OPENBOT_SANDBOX_NETWORK !== "false";
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

function requireImageCapacity(dir: string) {
  // Image upgrades used to retain every prior base image indefinitely. Keep a
  // single rollback point so routine image refreshes cannot fill the host and
  // prevent the next VM from starting.
  pruneRootfsBackups(dir);
  const filesystem = statfsSync(dir);
  const freeBytes = filesystem.bavail * filesystem.bsize;
  const baseBlocks = statSync(BASE_ROOTFS).blocks ?? 0;
  const baseAllocatedBytes = baseBlocks * 512;
  const requiredBytes = baseAllocatedBytes + 512 * 1024 * 1024;
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

function vsockExec(
  udsPath: string,
  command: string,
  cwd: string,
  timeoutMs: number,
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
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        try {
          finish(null, JSON.parse(line) as AgentResult);
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
  const pending = ensureVmUnlocked(botId)
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
  for (const child of [...desktop.children].reverse()) {
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
  }
  rmSync(`/tmp/.X11-unix/X${desktop.displayNumber}`, { force: true });
  rmSync(`/tmp/.X${desktop.displayNumber}-lock`, { force: true });
}

async function ensureBrowserDesktop(botId: string) {
  const existing = browserDesktops.get(botId);
  if (
    existing &&
    existing.children.every((child) => child.exitCode === null) &&
    existsSync(`/tmp/.X11-unix/X${existing.displayNumber}`) &&
    (await tcpReady("127.0.0.1", existing.vncPort))
  ) {
    return existing;
  }
  stopBrowserDesktop(botId);

  const { display, displayNumber, vncPort } = browserDisplayFor(botId);
  mkdirSync(vmDir(botId), { recursive: true });
  rmSync(`/tmp/.X11-unix/X${displayNumber}`, { force: true });
  rmSync(`/tmp/.X${displayNumber}-lock`, { force: true });
  const logFd = openSync(browserLog(botId), "a");
  const desktopEnv = {
    ...process.env,
    DISPLAY: display,
    HOME: "/root",
    XDG_CONFIG_HOME: join(vmDir(botId), "desktop-config"),
    XDG_CACHE_HOME: join(vmDir(botId), "desktop-cache"),
  };
  mkdirSync(desktopEnv.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(desktopEnv.XDG_CACHE_HOME, { recursive: true });

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
  const desktop = { display, displayNumber, vncPort, children };
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
    OPENBOT_BROWSER_ENGINE: "chromium",
    OPENBOT_BROWSER_HEADLESS: "0",
    OPENBOT_BROWSER_PROFILE: browserProfile(botId),
    OPENBOT_BROWSER_RUNTIME: HOST_BROWSER_RUNTIME,
    OPENBOT_BROWSER_SOCKET: browserSocket(botId),
  };
}

async function ensureBrowserDaemon(botId: string) {
  await ensureBrowserDesktop(botId);
  const existing = browserDaemons.get(botId);
  if (existing?.pid && existing.exitCode === null && existsSync(browserSocket(botId))) {
    return;
  }
  mkdirSync(vmDir(botId), { recursive: true });
  const identity = prepareBrowserIdentity(botId);
  rmSync(browserSocket(botId), { force: true });
  const logFd = openSync(browserLog(botId), "a");
  const child = spawn("/usr/local/bin/node", [HOST_BROWSER_SCRIPT, "serve"], {
    stdio: ["ignore", logFd, logFd],
    env: browserEnvironment(botId),
    uid: identity.uid,
    gid: identity.gid,
  });
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

function stopBrowser(botId: string) {
  const child = browserDaemons.get(botId);
  browserDaemons.delete(botId);
  if (child?.pid) {
    child.kill("SIGTERM");
  }
  spawnSync("pkill", ["-f", browserProfile(botId)], { stdio: "ignore" });
  rmSync(browserSocket(botId), { force: true });
  stopBrowserDesktop(botId);
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

async function destroyVm(botId: string) {
  const record = vms.get(botId);
  if (record) {
    await stopVm(record);
    vms.delete(botId);
  }
  rmSync(vmDir(botId), { recursive: true, force: true });
  rmSync(browserRuntimeDir(botId), { recursive: true, force: true });
  browserIdentities.delete(botId);
  const user = browserUserName(botId);
  if (spawnSync("id", ["-u", user]).status === 0) {
    spawnSync("userdel", [user], { stdio: "ignore" });
  }
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

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, vms: vms.size });
      return;
    }

    if (parts[0] !== "vms" || !parts[1]) {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    const botId = decodeURIComponent(parts[1]);
    const action = parts[2];

    if (request.method === "GET" && action === "status") {
      const record = vms.get(botId);
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
      };
      if (!body.command || typeof body.command !== "string") {
        sendJson(response, 400, { error: "command is required" });
        return;
      }
      const record = await ensureVm(botId);
      const timeoutMs = body.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const startedAt = Date.now();
      const result = await vsockExec(
        vsockSock(botId),
        body.command,
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

    if (request.method === "POST" && action === "browser") {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      if (typeof body.action !== "string" || !body.action) {
        sendJson(response, 400, { error: "browser action is required" });
        return;
      }
      await ensureVm(botId);
      const timeoutMs =
        typeof body.timeoutMs === "number"
          ? Math.min(Math.max(body.timeoutMs, 1_000), 90_000)
          : 75_000;
      const { timeoutMs: _ignored, ...payload } = body;
      const result = await runBrowserAction(botId, payload, timeoutMs);
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

const vncWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const match = /^\/vms\/([^/]+)\/vnc$/.exec(url.pathname);
  if (!match) {
    socket.destroy();
    return;
  }
  const botId = decodeURIComponent(match[1] ?? "");
  const record = vms.get(botId);
  if (!record || record.state !== "running") {
    socket.write(
      "HTTP/1.1 409 Conflict\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  void ensureBrowserDesktop(botId)
    .then(() => {
      vncWss.handleUpgrade(request, socket, head, (client) => {
        attachBrowserVnc(botId, client);
      });
    })
    .catch((error) => {
      log(`vnc ${botId}: browser desktop failed: ${(error as Error).message}`);
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
