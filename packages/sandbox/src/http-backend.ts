import type {
  BrowserActionRequest,
  BrowserActionResult,
  DesktopActionRequest,
  DesktopActionResult,
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

  async exec(botId: string, request: ExecRequest): Promise<ExecResult> {
    const { onOutput, ...wire } = request;
    if (!onOutput) {
      return this.request(`/vms/${encodeURIComponent(botId)}/exec`, {
        method: "POST",
        body: JSON.stringify(wire),
      });
    }
    const response = await this.fetchImpl(
      `${this.baseUrl}/vms/${encodeURIComponent(botId)}/exec`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wire, stream: true }),
      },
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `sandbox exec failed (HTTP ${response.status}): ${text.slice(0, 300)}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("ndjson")) {
      return (await response.json()) as ExecResult;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: ExecResult | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let payload: {
          type?: string;
          stream?: string;
          data?: string;
          exit?: number;
          stdout?: string;
          stderr?: string;
          durationMs?: number;
        };
        try {
          payload = JSON.parse(line) as typeof payload;
        } catch {
          continue;
        }
        if (payload.type === "chunk" && typeof payload.data === "string") {
          onOutput({
            stream: payload.stream === "stderr" ? "stderr" : "stdout",
            text: payload.data,
          });
          continue;
        }
        result = {
          exit: payload.exit ?? -1,
          stdout: payload.stdout ?? "",
          stderr: payload.stderr ?? "",
          durationMs: payload.durationMs ?? 0,
        };
      }
    }
    if (!result) {
      throw new Error("sandbox exec stream ended without a result");
    }
    return result;
  }

  browser(
    botId: string,
    request: BrowserActionRequest,
  ): Promise<BrowserActionResult> {
    return this.request(`/vms/${encodeURIComponent(botId)}/browser`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  desktop(
    botId: string,
    request: DesktopActionRequest,
  ): Promise<DesktopActionResult> {
    return this.request(`/vms/${encodeURIComponent(botId)}/desktop`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  stop(botId: string): Promise<SandboxStatus> {
    return this.request(`/vms/${encodeURIComponent(botId)}/stop`, {
      method: "POST",
    });
  }

  destroy(botId: string): Promise<SandboxStatus> {
    return this.request(`/vms/${encodeURIComponent(botId)}/destroy`, {
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
