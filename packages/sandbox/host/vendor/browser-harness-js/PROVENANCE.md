# Vendored: browser-use/browser-harness-js

Source: https://github.com/browser-use/browser-harness-js (MIT), `sdk/session.ts`
at commit `95b7a22a923714c45d2f7234b2bfa8fa6322c2eb` (the same revision
browsercode recorded in its own `cdp/PROVENANCE.md`).

`generated.ts` is the codegen output committed by
https://github.com/browser-use/browsercode (`packages/bcode-browser/src/cdp/
generated.ts`), produced by `gen.ts` from `browser_protocol.json` +
`js_protocol.json` (mirrors of `chromedevtools/devtools-protocol`). Upstream
browser-harness-js does not commit the generated file, so we take the published
artifact rather than running the Bun-only generator.

`exec.ts` is a port of browsercode's `browser-execute.ts` (MIT) onto this
Session: no Effect, plain promises, plus the egress navigation guard and
url/title observation.

## Local patches to session.ts

1. `Bun.file` / `Bun.sleep` replaced with `node:fs/promises` + `setTimeout`
   (the OpenBot host daemon is plain Node, not Bun).
2. `onCallResult` listener added (from browsercode's fork) so the exec runtime
   can tap `Page.captureScreenshot` responses.
3. `withSessionExecution` / `assertExecutionActive` (AsyncLocalStorage) added
   so a timed-out snippet's orphaned CDP calls reject instead of mutating the
   browser the next call owns.
4. Import specifiers dropped their `.ts` extension (Bun-style → bundler-style)
   so the package typechecks under `moduleResolution: "Bundler"`.

Do not edit `generated.ts` by hand; regenerate upstream if the protocol moves.
