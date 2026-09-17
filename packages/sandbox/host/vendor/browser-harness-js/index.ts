/**
 * Vendored browser-use/browser-harness-js CDP layer (MIT).
 *
 * Upstream: https://github.com/browser-use/browser-harness-js (sdk/)
 * Generated bindings: browser-use/browsercode packages/bcode-browser/src/cdp/generated.ts
 * Local patches: Node instead of Bun, onCallResult tap, execution-scope guard.
 * See PROVENANCE.md for the exact sources and the patch list.
 */
export {
  Session,
  CdpError,
  detectBrowsers,
  resolveWsUrl,
  listPageTargets,
  withSessionExecution,
} from './session';
export type {
  ConnectOptions,
  DetectedBrowser,
  PageTarget,
  SessionExecution,
} from './session';
export { ExecRunner, hostAllowed, hostOf } from './exec';
export type { ExecRequest, ExecResult, Screenshot } from './exec';
