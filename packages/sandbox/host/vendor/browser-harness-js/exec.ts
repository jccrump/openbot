/**
 * browser_execute runtime: run one JavaScript snippet against a persistent CDP
 * Session. Ported from browser-use/browsercode (`packages/bcode-browser/src/
 * browser-execute.ts`, MIT) onto the vendored browser-harness-js Session.
 *
 * Differences from upstream:
 * - No Effect: plain promises, since the OpenBot daemon is plain Node.
 * - Navigation egress guard: `Page.navigate` and `Target.createTarget` are
 *   checked against the task's egress allowlist before they reach Chrome.
 * - The result carries the current url/title so the tool can render an
 *   observation without a second round trip.
 */
import { Session, withSessionExecution, type SessionExecution } from './session';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_OUTPUT_BYTES = 8 * 1024;
const TIMEOUT_OUTPUT_TRUNCATED =
  '[partial console output truncated; showing final bytes]\n';

export interface Screenshot {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

export interface ExecRequest {
  /** WebSocket URL of the browser-level CDP endpoint. */
  wsUrl: string;
  code: string;
  timeoutMs?: number;
  /** Egress policy: hosts the snippet may navigate to. Empty allow + ask mode
   *  is enforced by the caller's approval; the guard here is the hard deny. */
  egress?: { mode: 'ask' | 'deny'; allow: string[] };
}

export interface ExecResult {
  output: string;
  result: string;
  screenshots: Screenshot[];
  url: string;
  title: string;
}

const SCREENSHOT_FORMAT_TO_MIME: Record<string, Screenshot['mime']> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const screenshotMime = (format: unknown): Screenshot['mime'] =>
  SCREENSHOT_FORMAT_TO_MIME[typeof format === 'string' ? format : 'png'] ??
  'image/png';

const AsyncFunction = (async () => {}).constructor as new (
  ...args: string[]
) => (...injected: unknown[]) => Promise<unknown>;

const serialize = (v: unknown): string => {
  if (v === undefined) return 'null';
  try {
    return (
      JSON.stringify(
        v,
        (_k, val) => (typeof val === 'bigint' ? val.toString() : val),
        2,
      ) ?? 'null'
    );
  } catch {
    return JSON.stringify(String(v));
  }
};

const timeoutOutput = (output: string): string => {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= MAX_TIMEOUT_OUTPUT_BYTES) return output;
  let start =
    bytes.length -
    (MAX_TIMEOUT_OUTPUT_BYTES - Buffer.byteLength(TIMEOUT_OUTPUT_TRUNCATED));
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return TIMEOUT_OUTPUT_TRUNCATED + bytes.subarray(start).toString('utf8');
};

export const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export const hostAllowed = (host: string, allow: string[]): boolean =>
  allow.some((entry) => {
    const suffix = entry.toLowerCase().replace(/^\./, '');
    return host === suffix || host.endsWith(`.${suffix}`);
  });

/**
 * Wrap the Session so navigation entry points enforce the egress allowlist.
 * CDP cannot be fully sandboxed from a snippet (that is why the tool is
 * approval-gated), but the common navigation vectors are checked here.
 */
const guardNavigation = (
  session: Session,
  egress: ExecRequest['egress'],
): Session => {
  // No policy configured (or egress off) — the tool-level approval is the gate.
  // Any configured egress mode (ask or deny) enforces the allowlist for
  // navigations, because a running snippet cannot pause to ask the user.
  if (!egress) return session;
  const check = (url: unknown): void => {
    if (typeof url !== 'string' || url === '' || url === 'about:blank') return;
    const host = hostOf(url);
    if (!host) return;
    if (!hostAllowed(host, egress.allow)) {
      throw new Error(
        `Blocked by the approvals policy: ${host} is not in the browser egress allowlist. Do not retry it.`,
      );
    }
  };
  const wrapDomain = (name: 'Page' | 'Target', methods: string[]) => {
    const domain = (session as unknown as Record<string, unknown>)[name] as
      | Record<string, unknown>
      | undefined;
    if (!domain) return domain;
    return new Proxy(domain, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function' && methods.includes(String(prop))) {
          return (...args: unknown[]) => {
            const first = args[0] as Record<string, unknown> | undefined;
            check(first?.url);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === 'Page') return wrapDomain('Page', ['navigate']);
      if (prop === 'Target') return wrapDomain('Target', ['createTarget']);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

/**
 * Network-level egress guard: while a snippet runs with an egress policy,
 * every request the page makes is paused and either continued or failed
 * against the allowlist. This covers subresources, XHR/fetch, and navigations
 * that the method-level guard cannot see. The guard is torn down when the
 * call ends, so requests never hang waiting on an absent handler.
 */
const startNetworkGuard = async (
  session: Session,
  egress: NonNullable<ExecRequest['egress']>,
): Promise<() => Promise<void>> => {
  const allowed = (url: string): boolean => {
    const host = hostOf(url);
    return !host || hostAllowed(host, egress.allow);
  };
  const unsubscribe = session.onEvent((method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const paused = params as {
      requestId?: string;
      request?: { url?: string };
    };
    if (typeof paused.requestId !== 'string') return;
    const call = allowed(paused.request?.url ?? '')
      ? session.domains.Fetch.continueRequest({ requestId: paused.requestId })
      : session.domains.Fetch.failRequest({
          requestId: paused.requestId,
          errorReason: 'AccessDenied',
        });
    call.catch(() => {
      // The request may already be gone (aborted navigation, closed tab).
    });
  });
  await session.domains.Fetch.enable({
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });
  return async () => {
    unsubscribe();
    await session.domains.Fetch.disable().catch(() => {});
  };
};

/**
 * One runner per browser daemon process. Holds the Session warm across calls
 * and reconnects when the browser restarts (new wsUrl).
 */
export class ExecRunner {
  private session: Session | null = null;
  private wsUrl: string | null = null;

  /** Drop the CDP session (called when the browser daemon resets). */
  close(): void {
    this.session?.close();
    this.session = null;
    this.wsUrl = null;
  }

  private async ensureSession(wsUrl: string): Promise<Session> {
    if (!this.session || this.wsUrl !== wsUrl) {
      this.session?.close();
      this.session = new Session();
      this.wsUrl = wsUrl;
    }
    if (!this.session.isConnected()) {
      await this.session.connect({ wsUrl });
    }
    if (!this.session.getActiveSession()) {
      const { targetInfos } = await this.session.domains.Target.getTargets({});
      const pages = (
        targetInfos as Array<{ type: string; url: string; targetId: string }>
      ).filter((target) => target.type === 'page');
      // Prefer a real page, but fall back to any page target: a fresh profile
      // starts on chrome://newtab, and an unattached session cannot run
      // page-level CDP methods at all.
      const page =
        pages.find(
          (target) =>
            !target.url.startsWith('chrome://') &&
            !target.url.startsWith('devtools://'),
        ) ?? pages[0];
      if (page) await this.session.use(page.targetId);
    }
    return this.session;
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    const session = await this.ensureSession(req.wsUrl);
    const guarded = guardNavigation(session, req.egress);
    const stopNetworkGuard = req.egress
      ? await startNetworkGuard(session, req.egress).catch(() => null)
      : null;
    const timeout = Math.min(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const captured = { active: true, output: '' };
    const execution: SessionExecution = { active: true };

    let wrapped: (...injected: unknown[]) => Promise<unknown>;
    try {
      wrapped = new AsyncFunction('session', 'console', req.code);
    } catch (error) {
      throw new Error(
        `syntax error in browser_execute snippet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const tee = (...args: unknown[]) => {
      if (!captured.active) return;
      captured.output +=
        args
          .map((x) => (typeof x === 'string' ? x : serialize(x)))
          .join(' ') + '\n';
    };
    const snippetConsole = Object.assign(Object.create(console), {
      log: tee,
      error: tee,
      warn: tee,
      info: tee,
      debug: tee,
    });

    const screenshots: Screenshot[] = [];
    const unsubscribe = session.onCallResult((method, params, result) => {
      if (method !== 'Page.captureScreenshot') return;
      const data = (result as { data?: unknown } | null)?.data;      if (typeof data !== 'string') return;
      const format = (params as { format?: unknown } | null)?.format;
      screenshots.push({ mime: screenshotMime(format), base64: data });
    });

    let timer: NodeJS.Timeout | null = null;
    const timeoutError = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        captured.active = false;
        execution.active = false;
        const output = timeoutOutput(captured.output);
        reject(
          new Error(
            [
              `browser_execute timed out after ${timeout} ms; this call can no longer issue CDP commands, but the next browser_execute call receives the unchanged CDP session`,
              output.trim()
                ? `Partial console output before timeout:\n${output.trimEnd()}`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          ),
        );
      }, timeout);
    });

    let ran: unknown;
    try {
      ran = await Promise.race([
        withSessionExecution(execution, () => wrapped(guarded, snippetConsole)),
        timeoutError,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (stopNetworkGuard) {
        await stopNetworkGuard().catch(() => {});
      }
    }

    let url = '';
    let title = '';
    try {
      const info = (await session.domains.Runtime.evaluate({
        expression:
          'JSON.stringify({url: location.href, title: document.title})',
        returnByValue: true,
      })) as { result?: { value?: string } };
      const parsed = JSON.parse(info.result?.value ?? '{}') as {
        url?: string;
        title?: string;
      };
      url = parsed.url ?? '';
      title = parsed.title ?? '';
    } catch {
      // Observation metadata is best-effort; the snippet result is the payload.
    }

    return {
      output: captured.output,
      result: serialize(ran),
      screenshots,
      url,
      title,
    };
  }
}
