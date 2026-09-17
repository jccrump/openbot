export type SandboxState = "stopped" | "booting" | "running" | "error";

export interface SandboxStatus {
  botId: string;
  state: SandboxState;
  cid: number | null;
  bootedAt: string | null;
  error: string | null;
}

export interface ExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
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
  timeoutMs?: number;
}

export interface BrowserActionResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  text?: string;
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
  stop(botId: string): Promise<SandboxStatus>;
  destroy(botId: string): Promise<SandboxStatus>;
}
