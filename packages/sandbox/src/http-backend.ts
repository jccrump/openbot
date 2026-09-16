import type {
  ExecRequest,
  ExecResult,
  SandboxBackend,
  SandboxStatus,
} from "./types";

export interface HttpSandboxBackendOptions {
  url: string;
  fetchImpl?: typeof fetch;
}

export class HttpSandboxBackend implements SandboxBackend {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSandboxBackendOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  status(botId: string): Promise<SandboxStatus> {
    return this.request(`/vms/${encodeURIComponent(botId)}/status`);
  }

  ensure(botId: string): Promise<SandboxStatus> {
    return this.request(`/vms/${encodeURIComponent(botId)}/ensure`, {
      method: "POST",
    });
  }

  exec(botId: string, request: ExecRequest): Promise<ExecResult> {
    return this.request(`/vms/${encodeURIComponent(botId)}/exec`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  stop(botId: string): Promise<SandboxStatus> {
    return this.request(`/vms/${encodeURIComponent(botId)}/stop`, {
      method: "POST",
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new Error(
        `sandbox host unreachable at ${this.baseUrl} (${(error as Error).message}). Start it with: pnpm sandbox:start && pnpm sandbox:deploy`,
      );
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `sandbox host returned ${response.status}: ${body.slice(0, 400)}`,
      );
    }
    return body ? (JSON.parse(body) as T) : (undefined as T);
  }
}
