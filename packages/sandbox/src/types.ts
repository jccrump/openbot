export type SandboxState = "stopped" | "booting" | "running" | "error";

export interface SandboxStatus {
  botId: string;
  state: SandboxState;
  cid: number | null;
  bootedAt: string | null;
  error: string | null;
}

export interface ExecOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  onOutput?: (chunk: ExecOutputChunk) => void;
}

export interface ExecResult {
  exit: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface BrowserActionRequest {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  submit?: boolean;
  milliseconds?: number;
  pixels?: number;
  href?: string;
  index?: number;
  /** `press` only: keyboard key, optionally with modifiers (e.g. "Meta+A"). */
  key?: string;
  /** `select` only: option value or visible label to pick. */
  option?: string;
  /** `upload` only: file paths in the agent's computer to attach. */
  files?: string[];
  timeoutMs?: number;
  /** `exec` only: JavaScript snippet run against the persistent CDP session. */
  code?: string;
  /** `exec` only: navigation egress policy enforced inside the session. */
  egress?: { mode: "ask" | "deny"; allow: string[] };
}

export interface BrowserActionResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  text?: string;
  screenshot?: string;
  challenge?: boolean;
  durationMs: number;
  /** `exec` only: captured console output. */
  output?: string;
  /** `exec` only: JSON-serialized snippet return value. */
  result?: string;
  /** `exec` only: screenshots taken during the snippet (base64 PNG/JPEG/WebP). */
  screenshots?: string[];
  /** `snapshot` only: visible interactive elements with stable selectors. */
  elements?: Array<{
    id: string;
    selector: string;
    role: string;
    tag: string;
    type: string;
    label: string;
  }>;
}

export interface DesktopActionRequest {
  action: string;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  button?: string;
  count?: number;
  direction?: string;
  amount?: number;
  durationMs?: number;
  text?: string;
  keys?: string;
  milliseconds?: number;
  title?: string;
  screenshot?: boolean;
}

export interface DesktopActionResult {
  ok: boolean;
  action: string;
  detail?: string;
  error?: string;
  width?: number;
  height?: number;
  cursor?: { x: number; y: number } | null;
  window?: string | null;
  screenshot?: string;
  durationMs: number;
}

export interface FileListRequest {
  path: string;
  cap?: number;
}

export interface FileListEntry {
  name: string;
  dir: boolean;
  size: number | null;
  mtime: number | null;
}

export interface FileListResponse {
  entries: FileListEntry[];
  total: number;
  skipped: number;
  error: string | null;
}

export interface FileReadRequest {
  path: string;
  maxBytes?: number;
}

export interface FileReadResponse {
  kind: "text" | "image" | "binary" | "dir" | "missing";
  content: string | null;
  mime: string | null;
  size: number;
  truncated: boolean;
  error: string | null;
}

export interface SandboxBackend {
  status(botId: string): Promise<SandboxStatus>;
  ensure(botId: string): Promise<SandboxStatus>;
  exec(botId: string, request: ExecRequest): Promise<ExecResult>;
  browser(
    botId: string,
    request: BrowserActionRequest,
  ): Promise<BrowserActionResult>;
  desktop(
    botId: string,
    request: DesktopActionRequest,
  ): Promise<DesktopActionResult>;
  filesList(
    botId: string,
    request: FileListRequest,
  ): Promise<FileListResponse>;
  filesRead(
    botId: string,
    request: FileReadRequest,
  ): Promise<FileReadResponse>;
  stop(botId: string): Promise<SandboxStatus>;
  destroy(botId: string): Promise<SandboxStatus>;
  /** Remove stopped VMs this owner no longer references (startup GC). */
  prune(keep: string[]): Promise<{ removed: string[] }>;
  /** Enforce a hard shell egress allowlist for this computer (null clears). */
  setNetworkPolicy(
    botId: string,
    policy: { mode: "deny"; allow: string[] } | null,
  ): Promise<{ ok: boolean; ips?: string[]; error?: string }>;
}
