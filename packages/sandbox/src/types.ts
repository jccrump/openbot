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
  stop(botId: string): Promise<SandboxStatus>;
  destroy(botId: string): Promise<SandboxStatus>;
}
