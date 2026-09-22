# Vendored skill docs: browser_execute

Source: https://github.com/browser-use/browsercode (MIT),
`packages/bcode-browser/skills/browser-execute/SKILL.md`, and
https://github.com/browser-use/browser-harness-js (MIT),
`interaction-skills/*.md`.

These teach the snippet model for the `browser_execute` tool: the persistent
CDP `session`, the `console` capture, and per-topic recipes (tabs, uploads,
dialogs, iframes, shadow DOM, network waits, downloads, screenshots, ...).

The condensed version of this material lives in the tool description
(`packages/core/src/tools.ts`). Delivery of the full docs into an agent's
workspace is a follow-up; the files are vendored here so the text has a
versioned home.
