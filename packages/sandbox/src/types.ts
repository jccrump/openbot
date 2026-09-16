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

export interface SandboxBackend {
  status(botId: string): Promise<SandboxStatus>;
  ensure(botId: string): Promise<SandboxStatus>;
  exec(botId: string, request: ExecRequest): Promise<ExecResult>;
  stop(botId: string): Promise<SandboxStatus>;
}
