import { execSync, spawn } from "node:child_process";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

const FC_BIN = process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
const FC_DIR = process.env.FC_DIR ?? "/var/lib/fc";
const BASE_ROOTFS = join(FC_DIR, "rootfs.ext4");
const KERNEL = join(FC_DIR, "vmlinux");
const VMS_DIR = join(FC_DIR, "vms");
const PORT = Number(process.env.OPENBOT_HOST_PORT ?? 4171);
const VSOCK_PORT = 5000;
const VNC_VSOCK_PORT = 5900;
const DEFAULT_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 45_000;
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
}

const vms = new Map<string, VmRecord>();
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
  let handshake = false;
  let closed = false;
  let resumeTimer: ReturnType<typeof setInterval> | null = null;

  const shutdown = () => {
    if (closed) return;
    closed = true;
    if (resumeTimer) {
      clearInterval(resumeTimer);
      resumeTimer = null;
    }
    socket.destroy();
    try {
      client.close();
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
      if (client.bufferedAmount < 1_000_000) {
        if (resumeTimer) {
          clearInterval(resumeTimer);
          resumeTimer = null;
        }
        socket.resume();
      }
    }, 25);
  };

  socket.on("connect", () => {
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
      log(`vnc ${botId}: stream open`);
      if (pending.length === 0) return;
      const rest = pending;
      pending = Buffer.alloc(0);
      client.send(rest, { binary: true });
      if (client.bufferedAmount > 1_000_000) pauseUntilClientDrains();
      return;
    }
    client.send(chunk, { binary: true });
    if (client.bufferedAmount > 1_000_000) pauseUntilClientDrains();
  });

  socket.on("drain", () => {
    if (!closed) client.resume();
  });
  socket.on("error", () => shutdown());
  socket.on("close", () => {
    log(`vnc ${botId}: stream closed`);
    shutdown();
  });

  client.on("message", (data, isBinary) => {
    if (closed || !handshake) return;
    const payload = isBinary ? (data as Buffer) : Buffer.from(String(data));
    if (!socket.write(payload)) client.pause();
  });
  client.on("close", () => shutdown());
  client.on("error", () => shutdown());
}

async function ensureVm(botId: string): Promise<VmRecord> {
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
  if (!existsSync(rootfs)) {
    log(`vm ${botId}: creating rootfs from base image`);
    execSync(`cp --sparse=always ${BASE_ROOTFS} ${rootfs}`);
  }
  rmSync(apiSock(botId), { force: true });
  rmSync(vsockSock(botId), { force: true });

  const logFd = openSync(serialLog(botId), "a");
  const child = spawn(FC_BIN, ["--api-sock", apiSock(botId)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  record.pid = child.pid ?? null;

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
        record.state = "running";
        record.bootedAt = new Date().toISOString();
        log(`vm ${botId}: running (cid ${record.cid}, pid ${record.pid})`);
        return record;
      }
    } catch {
      // agent not up yet
    }
    await sleep(100);
  }

  record.state = "error";
  record.error = "guest agent did not become ready";
  throw new Error(record.error);
}

async function stopVm(record: VmRecord) {
  try {
    await fcRequest(apiSock(record.botId), "PUT", "/actions", {
      action_type: "InstanceStop",
    });
  } catch {
    // instance may already be gone
  }
  await sleep(200);
  if (record.pid) {
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
  record.state = "stopped";
  record.pid = null;
  record.bootedAt = null;
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
  vncWss.handleUpgrade(request, socket, head, (client) => {
    attachVnc(botId, client);
  });
});

function cleanup() {
  try {
    execSync("pkill -f 'firecracker --api-sock' || true");
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
