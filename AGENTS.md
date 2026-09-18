# AGENTS.md

## Current focus

- The built-in OpenBot harness (the daemon agent loop in `packages/core`) is the
  only harness that matters. Anything that runs OpenBot uses it.
- The Codex harness (`packages/core/src/codex.ts`, `packages/mcp/`, and the
  `scripts/codex-openbot.sh` path) is out of scope for now: do not build
  features for it, mirror changes into it, or treat it as a supported surface.
  Leave existing code alone unless a task explicitly names it.

## Checks

- `pnpm typecheck` — all packages and the app.
- `pnpm smoke` — end-to-end daemon/protocol suite with mock model and sandbox.
- `pnpm code-tools:smoke` — file tool checks.
- `pnpm websearch:smoke` — web search checks (add `OPENBOT_WEBSEARCH_LIVE=1` for
  a live provider call).
