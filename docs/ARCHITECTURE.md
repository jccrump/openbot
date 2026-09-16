# OpenBot Architecture

OpenBot is a Grok Bot-style platform: always-on AI teammates ("agents") that
each get their own computer, act through shell, file, and browser tools, and
run on any model you connect — an API provider (DeepSeek first), a local model,
or the Codex harness with ChatGPT subscription auth.

Single-user, Mac-first. Mobile is a later thin client.

## Status

- **M0 (done):** monorepo, daemon, model gateway, SQLite persistence,
  WebSocket protocol, Mac UI, mock-provider smoke test.
- **M1 (mostly done):** Lima + Firecracker sandbox host, one microVM per agent,
  guest agent over vsock, shell/file/browser tools, approvals, local-Mac
  computer mode. Still missing: snapshots, per-bot egress policy, a polished
  base image.
- **M2 (in progress):** browser automation with persistent sign-ins and
  screenshots works. Live screen view and sign-in polish are not started.
- **M3 (partial):** the Codex harness runs in the daemon and the
  Responses-to-Chat-Completions bridge exists. The ChatGPT subscription flow
  has not been verified end to end from the app.
- **M4+ (planned):** multi-agent messaging, memory, routines, mobile. See
  [Milestones](#milestones).

Subagent handoffs, group chats, and mentions are **planned for M4 and are not
implemented**. Every agent today is independent: it has exactly one thread, and
nothing routes work between agents.

## System overview

```
+------------------------------- Mac ----------------------------------+
|                                                                      |
|  OpenBot.app (Tauri v2 + React)                                      |
|    agent list - chat - tool cards - approvals - latest screen shot    |
|        |                                                             |
|        | WebSocket  ws://127.0.0.1:4170/ws                            |
|        v                                                             |
|  openbotd (Node/TS daemon)                                           |
|    agent registry - agent loop - compaction - harness switch          |
|    SQLite store (bots, threads, messages, providers, settings)        |
|        |                        |                                    |
|        | model gateway          | sandbox control                    |
|        v                        v                                    |
|  providers                 Lima VM (Linux, nested virtualization)     |
|  (OpenAI-compatible,       +-- Firecracker microVM per agent          |
|   Codex CLI + bridge)           guest agent: exec, files             |
|                                 browser daemon: Chromium over CDP      |
+----------------------------------------------------------------------+
             | optional: Tailscale / Cloudflare Tunnel (planned)
             v
       mobile app (thin client, later)
```

The daemon is the brain. Agents are rows in the daemon; their microVMs are the
hands. Model swapping, compaction, approvals, and orchestration stay
centralized while the sandbox stays disposable and replaceable.

## Repo layout

```
apps/mac/                  Tauri v2 + React desktop app
packages/protocol/         Zod schemas for domain types and the WS protocol
packages/gateway/          Model providers: provider interface, OpenAI-compatible
                           client, presets, /models fetching
packages/core/             The daemon: config, SQLite store, agent loop,
                           compaction, harnesses, tools, WS server
packages/mcp/              MCP server exposing a computer to Codex / any client
packages/responses-bridge/ Responses API -> Chat Completions bridge for Codex
packages/sandbox/          Sandbox client + Lima/Firecracker host service and
                           guest agent/browser daemon
scripts/                   smoke test, compaction demo, mock model, Codex wrapper
docs/                      This document and screenshots
.openbot-dev/              Dev data dir (gitignored)
```

## Components

### Mac app (`apps/mac`)

- Tauri v2 shell + React (Vite) UI. Ships as a normal `.app` later; during
  development it also runs in a browser via `pnpm dev:app`.
- Talks to the daemon exclusively over the WebSocket protocol. Reconnects
  automatically; the daemon can restart underneath it.
- Surfaces today: agent list with search and last-message previews, chat with
  streaming text and reasoning, model picker, computer switcher, tool cards
  with output and screenshots, inline approval cards, a screen panel that shows
  the latest screenshot, create-agent modal, and Settings.
- Not present: approvals inbox, run log, routines browser, memory browser,
  group chats, live screen view.

**Settings layout.** Four sections in a left nav with search:

- **General** — default model and the global "ask before running commands"
  toggle.
- **Appearance** — theme: System, Light, or Dark. The preference is stored in
  `localStorage` and applied before React mounts; "System" follows the Mac and
  updates live.
- **Providers** — list, enable/disable, add/edit/remove, presets, key fields,
  model list, and "Fetch models".
- **Harness** — pick the default harness (OpenBot or Codex). Codex is only
  selectable when the CLI is detected on `PATH`.

**Design language.** The UI matches the Grok Bot desktop app: light surfaces
(`#fcfcfc` chat, `#fafafa` sidebar) and a dark theme, `system-ui` type at 14px
with -0.15px tracking, a 280px sidebar with a 32px search field and 32px
circular avatars, near-black `#0a0a0a` text with a muted `rgba(20,20,20,0.4)`
scale, subtle `rgba(16,16,16,0.045)` message bubbles at 16px radius, a fully
rounded pill composer, and a black circular send button. Window chrome uses
`titleBarStyle: Overlay` so traffic lights float over the sidebar header, which
is also the drag region.

### Daemon (`packages/core`)

- `config.ts` — config precedence: defaults < `config.json` in the data dir <
  environment variables (`OPENBOT_PORT`, `OPENBOT_DATA_DIR`,
  `OPENBOT_SANDBOX_URL`, `OPENBOT_REQUIRE_APPROVAL`, `OPENBOT_HARNESS`).
- `db.ts` / `store.ts` — SQLite via `node:sqlite`; bots, threads, messages,
  providers, settings. The database file is created `0600` inside a `0700` data
  directory; WAL is enabled. Schema migrations are additive `ALTER TABLE`
  checks.
- `agent.ts` — the built-in run loop for one message: resolve agent and model,
  persist the user message, compact if needed, stream provider events, execute
  tool calls with approvals, persist the assistant message, emit protocol
  events. Abortable per run; at most 8 model/tool steps per user message.
- `compaction.ts` — context-window management (see [Compaction](#compaction)).
- `harness.ts` — persisted harness selection.
- `codex.ts` — the Codex harness: binary detection, provider classification,
  bridge lifecycle, `codex exec` supervision, and JSONL event mapping (see
  [Harnesses](#harnesses-our-loop-or-codex)).
- `server.ts` — HTTP (`/health`, `/artifacts/*`) + WebSocket (`/ws`), validates
  every inbound message with the shared Zod schemas, tracks runs for
  cancellation.
- `bin/openbotd.ts` — entrypoint; loads `.env` if present, seeds the default
  agent, starts the server, handles SIGINT/SIGTERM.

**One thread per agent.** `getOrCreateThread(botId)` returns the agent's single
thread; the app has no new-chat affordance. The thread title is set from the
first user message. Sidebar search filters agents by name/role — it does not
search message text.

### Harnesses: our loop, or Codex

Two ways to drive an agent's computer, both selectable in Settings:

1. **OpenBot loop** (`agent.ts`) — the daemon owns the agent loop and the
   tools. Approvals surface in the app, streaming maps directly onto the
   protocol, and any OpenAI-compatible model works. This is the default.
2. **Codex** (`codex.ts`) — the daemon spawns `codex exec --json` with
   `--ignore-user-config --skip-git-repo-check --ephemeral --sandbox
   read-only`, registers `packages/mcp` as the only MCP server, and maps Codex
   JSONL events (`agent_message`, `reasoning`, `mcp_tool_call`,
   `command_execution`, `turn.completed`, `turn.failed`) onto the OpenBot
   protocol. Codex plans; every action still runs inside the agent's microVM
   through the MCP tools. The daemon refuses Codex runs for This Mac agents.

**The ChatGPT-quota isolation rule.** Codex can authenticate with a ChatGPT
subscription, and subscription quota must only ever be spent on OpenAI/ChatGPT
models. `isOpenAIChatGptProvider()` classifies the selected provider by id,
label, and base URL host (`openai.com`, `chatgpt.com`):

- **OpenAI/ChatGPT provider:** Codex runs with the user's normal `CODEX_HOME`
  and ChatGPT login. Subscription auth is allowed.
- **Any other provider:** the daemon deletes `auth.json` in an isolated
  `CODEX_HOME` under the data dir, starts a local Responses bridge in-process
  (`packages/responses-bridge`) pointed at that provider, and tells Codex to
  use the bridge with `wire_api = "responses"`. Codex cannot reach the ChatGPT
  backend from that home, so subscription quota is never touched and the
  provider key is only passed to the bridge.

`scripts/codex-openbot.sh` implements the same rule for the standalone
`pnpm codex:vm` path, with the bridge as a background process.

MCP tools default to requiring approval; the daemon and wrapper configure
`default_tools_approval_mode = "approve"` and a long tool timeout because first
boots and browser actions can take minutes.

### Model gateway (`packages/gateway`)

- `ChatProvider` interface: `chat(request) -> AsyncIterable<ChatEvent>`, where
  events are `text_delta`, `reasoning_delta`, `tool_calls`, `usage`, or `done`.
- `openai-compatible.ts` — streaming SSE client for any OpenAI-compatible
  endpoint (DeepSeek, OpenAI, OpenRouter, Groq, xAI, Google, Mistral, Ollama,
  LM Studio, vLLM, ...). Handles `reasoning_content` deltas and accumulates
  streamed tool calls.
- `presets.ts` — provider presets used by the settings UI; `models.ts` fetches
  the model list from any OpenAI-compatible `/models` endpoint.
- There is no `@openai/codex-sdk` provider yet; the Codex path shells out to
  the CLI instead. A daemon-native SDK provider is on the roadmap (M3).

### Provider settings

Providers are user data, not code. They live in the `providers` table and are
managed from Settings:

- Add, edit, remove, and enable/disable providers with a name, base URL,
  models, and either an API key or the name of an environment variable holding
  one (an environment variable wins when both exist).
- Presets for DeepSeek, OpenAI, OpenRouter, Groq, xAI, Google, Mistral, Ollama,
  and LM Studio prefill the form.
- "Fetch models" calls the provider's `/models` endpoint; models can also be
  typed by hand.
- Changing providers broadcasts `providers.updated` and rebuilds the live
  provider registry, so new keys and models apply without restarting.
- Chat settings: default model and the global approval toggle, persisted in the
  `settings` table.
- Keys typed in the UI are stored in the SQLite file (`0600`). The macOS
  Keychain is planned, not implemented.

### Compaction

Long threads are compacted instead of dropped. `compaction.ts` owns the policy:

- **Threshold.** Settings are `{enabled, thresholdTokens}`. An explicit
  threshold is clamped to 32,000–1,000,000. With no explicit threshold the
  daemon uses 75% of a known context window (`deepseek-v4-flash` and
  `deepseek-v4-pro` are mapped to 128k) and falls back to 100,000 tokens.
- **Planning.** `planCompaction()` folds the oldest messages until the
  remaining estimated tokens are at or below the target (half the threshold for
  automatic compaction, half the current total for overflow/manual), always
  keeping at least the last 4 messages.
- **Trigger.** Before a run starts, if the thread estimates at or above the
  threshold the daemon compacts automatically (`trigger: "auto"`). If a
  provider rejects a request with a context-overflow error (known message
  patterns or HTTP 413), the daemon compacts once and retries the step
  (`trigger: "overflow"`); a second overflow becomes a clear chat error.
- **Contract.** The folded messages are summarized by the same model into a
  single assistant message prefixed `[conversation summary] Earlier messages
  were compacted. Key context:`, written at the timestamp of the last folded
  message with `compaction` metadata (`messagesToCompact`, `tokensBefore`,
  `tokensAfter`, `isFirstCompaction`). Folded messages keep a `folded_at` mark
  and are excluded from provider history, so the provider sees the summary plus
  the recent messages. Compaction events (`chat.compaction`) are emitted on the
  protocol; the app does not render a compaction indicator yet.
- `scripts/compaction-demo.mjs` exercises the whole path against a mock model.

### Sandbox

Working recipe, validated on an M4 Pro (macOS 27, Lima 2.2.0):

- A Lima VM (`packages/sandbox/host/lima.yaml`) with `vmType: vz` and
  `nestedVirtualization: true` exposes `/dev/kvm` on Apple Silicon (M3+).
- Inside it: Firecracker v1.16.0 plus the Firecracker CI aarch64 kernel
  (`vmlinux-5.10.239`) and Ubuntu 24.04 rootfs (squashfs converted to a 4 GiB
  ext4). Node 22 is installed and the rootfs is provisioned with the guest
  agent, the browser daemon, Playwright's Chromium plus its system
  dependencies, and DNS resolvers.
- The guest agent (`packages/sandbox/guest/agent.py`) runs as PID 1 via the
  `init=` boot arg and listens on vsock port 5000. It mounts /proc, /sys, and
  /dev itself, executes newline-delimited JSON requests
  (`{cmd, cwd?, timeout?}` to `{exit, stdout, stderr}`), and survives
  individual connection failures.
- The browser daemon (`packages/sandbox/guest/browser.js`) starts at boot,
  launches `chrome-headless-shell` once, holds a persistent CDP connection, and
  serves browser actions over a Unix socket. That keeps per-action latency to a
  few seconds instead of paying a Node + Chromium start per call. Measured:
  first navigation after boot ~15–25 s, later actions 2–8 s. Design notes on
  how production computer-use agents batch actions, combine DOM text with
  screenshots, and budget observations are in
  [research/computer-use.md](research/computer-use.md).

**Sandbox host service.** `packages/sandbox/host/service.ts` is bundled with
esbuild into a single `service.mjs`, installed into the Lima VM at
`/var/lib/fc/openbot/service.mjs`, and run by systemd as `openbot-host` on
`127.0.0.1:4171` (Lima forwards the port to the Mac). It manages per-agent VMs:

- `GET /health`, `GET /vms/:botId/status`
- `POST /vms/:botId/ensure` boots the VM if needed (copies the base rootfs,
  spawns Firecracker with its API socket, configures kernel/rootfs/machine/vsock
  and the network interface through the Firecracker API, then waits for the
  guest agent)
- `POST /vms/:botId/exec` runs a command through the vsock agent
- `POST /vms/:botId/stop` and `POST /vms/:botId/destroy`

Per-agent state lives in `/var/lib/fc/vms/<botId>/` (rootfs copy, `api.sock`,
`vsock.sock`, `serial.log`). Firecracker is driven through its API rather than
`--config-file` so snapshot/restore is a later addition, not a rewrite.
Measured: cold `ensure` (rootfs copy plus boot) ~10 s, warm exec 3–40 ms.

**Networking.** Each microVM gets a tap device and a static IP
(`172.16.<slot>.2`) with NAT through the Lima VM's uplink. Set
`OPENBOT_SANDBOX_NETWORK=false` in the sandbox host service to run computers
offline. There is **no per-bot egress policy**: every VM shares the same NAT
and can reach anything the host can.

**One microVM per agent.** Each agent gets its own kernel, persistent rootfs,
browser profile, and sign-ins. Per-agent snapshots, pause/resume, and rollback
are not implemented. `SandboxBackend` stays interface-first so the same images
can run on a Linux host with Firecracker later (true 24/7 when the Mac sleeps).

### Tools and approvals

The daemon exposes four tools to any model that supports function calling:

- `shell` — run a command on the agent's computer
- `read_file` — read a file from the agent's computer
- `write_file` — write a file, creating parent directories
- `browser` — drive the real browser: `goto`, `click`, `type`, `text`,
  `screenshot`, `back`, `wait`. Cookies and sign-ins persist in the browser
  profile between calls, and screenshots are saved as artifacts and rendered in
  the chat and screen panel.

Tool activity is streamed to the app (`tool.start`, `tool.result`) and
persisted on the assistant message as `toolCalls`, so the next turn rebuilds a
correct assistant/tool-call/tool-result history for the provider.

Approvals gate execution. With `requireApproval` on (default), the daemon emits
`approval.request` and waits; the app shows a card with the exact command and
Approve/Deny buttons. Denied actions never run and the model is told the user
denied it. `OPENBOT_REQUIRE_APPROVAL=false` runs tools without asking, which is
useful for trusted local experimentation. There is no per-tool policy engine or
approvals inbox yet.

**Local computers (This Mac).** An agent can be created with `computer: "mac"`
("This Mac" in the create-agent modal) instead of the default Firecracker
microVM. Constraints, all enforced in `local-computer.ts` and `tools.ts`:

- `shell` runs `bash -lc` as the logged-in user with
  `<dataDir>/workspaces/<botId>` as the default working directory (created on
  demand). Any `cwd` inside the workspace is allowed; the timeout is capped at
  120 s and output at 30,000 characters, matching the sandbox path.
- `read_file` and `write_file` resolve paths inside that workspace only;
  paths that escape it (including symlink escapes) are rejected. They are
  implemented as shell commands on the host rather than direct file I/O.
- Approvals are **always required** for local tools regardless of the global
  setting, and output is prefixed with `[local Mac]`.
- `browser` returns a clear error because it needs the microVM.
- The Codex harness refuses to run against a This Mac agent.

The chat header's computer pill switches an existing agent between Firecracker
and This Mac (`bots.update` → `bot.updated`).

### Protocol

Client to server:

- `hello` — client identification
- `chat.send` — `{ botId, threadId?, text, model? }`
- `chat.cancel` — `{ runId }`
- `thread.list`, `thread.messages`
- `bots.create`, `bots.update`
- `provider.upsert`, `provider.remove`, `provider.fetchModels`
- `settings.update` — default model, approval toggle, harness
- `approval.respond`

Server to client:

- `hello` — snapshot: agents, threads, providers, presets, default model,
  approval setting, harness, Codex info
- `threads`, `thread.messages`, `thread.upserted`
- `chat.start`, `chat.delta`, `chat.reasoning`, `chat.done`, `chat.error`,
  `chat.compaction`
- `tool.start`, `tool.result` — live tool activity for the transcript cards
- `approval.request` — asks the user to approve a tool action
- `sandbox.state` — agent computer state (stopped, booting, running, error)
- `bot.created`, `bot.updated`, `providers.updated`, `provider.models`

Every message is defined once in `packages/protocol` with Zod and validated on
both sides.

### Data model

```
bots       id, name, system_prompt, provider, model, created_at,
           role, avatar, color, computer
threads    id, bot_id, title, created_at, updated_at,
           last_compacted_at, compaction_count
messages   id, thread_id, role, content, provider, model, created_at,
           tool_calls, input_tokens, output_tokens, compaction, folded_at
providers  id, label, base_url, api_key, api_key_env, models, enabled,
           created_at, updated_at
settings   key, value
```

Planned additions: `runs` (journal), `routines`, `memory`, `approvals`,
`secrets` (references only; values would move to the macOS Keychain).

## Security model

- Single-user: the daemon binds `127.0.0.1` only. There is no authentication
  layer; anything that can reach the loopback port is trusted. Remote/mobile
  access would go through Tailscale or a Cloudflare Tunnel, never a public port.
- Provider keys live in the SQLite database (`0600` file in a `0700` directory)
  or in environment variables referenced by name. The macOS Keychain is
  planned, not implemented. Keys are never logged.
- Firecracker microVMs are the isolation boundary for cloud models; agents can
  only touch their own VM.
- This Mac agents run as the user. The only boundary is the workspace path
  check for file tools plus mandatory approvals for every action.
- There are no per-bot egress allowlists and no snapshots before risky
  operations yet.

## Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 | Monorepo, daemon, gateway, SQLite, WS protocol, chat UI, smoke test | Done |
| M1 | Lima + Firecracker host, one agent VM, guest agent, shell/file tools, approvals | Done except snapshots and egress policy |
| M2 | Browser automation, persistent sign-ins, live screen view | Browser automation + screenshots done; live view and sign-in polish pending |
| M3 | Codex provider with ChatGPT sign-in | Codex harness + responses bridge implemented; ChatGPT flow not verified end to end; SDK provider planned |
| M4 | Multi-agent messaging, group chats, handoffs, memory | Planned |
| M5 | Routines: record, replay, schedule | Planned |
| M6 | Mobile thin client over Tailscale | Planned |

## Decisions

**ADR-001: Tauri v2 + React for the Mac app.** Lightweight native shell, web UI
carries to mobile later, and the Node sidecar is natural for the Codex CLI and
the agent runtime. Rejected: SwiftUI (great Mac feel, but Android is harder and
a sidecar is still required), Electron (heavy, no mobile path).

**ADR-002: One microVM per agent.** Strong isolation, independent sign-ins, and
per-agent snapshots later. Costs more RAM than a shared VM; accepted on 48 GB.
Cross-agent work would use an explicit shared workspace instead of implicit
shared state.

**ADR-003: Firecracker via Lima nested virtualization on macOS.** Firecracker
needs KVM; Apple Silicon (M3+) with nested virtualization exposes `/dev/kvm`
inside a Linux VM. Keeps the same microVM stack portable to a Linux VPS later.
Rejected: running agents on the bare Mac (no isolation), managed sandboxes
(less control, per-use cost), Apple containers (weaker isolation than KVM).

**ADR-004: Codex for ChatGPT subscription access.** Official OAuth flow, token
caching and refresh handled by Codex, works with Plus/Pro plans. The tradeoff is
a coding-agent-shaped harness and plan limits. Unofficial ChatGPT-web reverse
engineering was rejected (ToS risk, constant breakage).

**ADR-005: Host-side harness, VM as the hands.** The agent loop, compaction,
and policy live in the daemon; the VM exposes tools. Swapping models or
upgrading the loop never requires touching VM images, and one policy engine can
govern all agents.

**ADR-006: `node:sqlite` for storage.** Zero native dependencies on Node 22,
synchronous API is fine for single-user load, WAL enabled. Swappable for a
server database if multi-user ever happens.

**ADR-007: pnpm workspace monorepo with internal TS packages.** `@openbot/*`
packages export TypeScript sources directly; Vite and tsx consume them without a
build step. Types are shared end to end with no duplication.

**ADR-008: Zod-validated WebSocket protocol.** One definition of every message,
validated on both sides; malformed input fails loudly in development and is
rejected safely in production.

**ADR-009: Match the Grok Bot design language.** The app is styled to the
official Grok Bot desktop app rather than a generic chat look: frosted surfaces,
system type at 14px with -0.15px tracking, 280px sidebar, subtle 16px-radius
bubbles, pill composer, black circular send, and a muted `rgba(20,20,20,*)`
text scale. Light and dark themes both ship.

**ADR-010: Local-Mac computer mode is opt-in and always approval-gated.**
Running agents directly on the Mac is useful for work that needs the user's
files and tools, but it is not sandboxed. It is an explicit per-agent choice
with path confinement for file tools, mandatory approvals, and no browser
tool.

**ADR-011: Compact instead of truncate.** Long threads keep working by folding
old messages into a model-written summary that stays in the transcript as a
normal assistant message. This keeps provider history valid (no dangling tool
calls) and keeps the summary visible in the UI rather than hidden state.

## Running it

```bash
pnpm install

# terminal 1: mock model (no API key needed)
pnpm mock:model

# terminal 2: daemon pointed at the mock provider
pnpm dev:daemon:mock

# terminal 3: the app UI (browser at http://localhost:1420)
pnpm dev:app

# or the real Tauri window once Rust is installed
pnpm dev:mac
```

Real models: open the app's Settings and add a provider — DeepSeek, OpenAI,
OpenRouter, or a local model. Paste an API key or point at an environment
variable, fetch models, and pick a default. No config files or code edits
required; `config.json` and `.env` remain supported for headless setups and are
seeded into the database on first run.

Chat with a real model that has a computer:

```bash
pnpm sandbox:start        # boot the Lima VM (first run: sandbox:setup, sandbox:deploy)
pnpm dev:daemon           # daemon
pnpm dev:mac              # native app (or: pnpm dev:app for the browser)
```

Checks:

```bash
pnpm typecheck   # all packages
pnpm smoke       # end-to-end daemon test against an in-process mock provider
```

Sandbox host (Lima VM with nested virtualization, one-time setup then reuse):

```bash
pnpm sandbox:start   # boot the Lima VM
pnpm sandbox:setup   # firecracker + kernel + rootfs + node + guest agent (first run)
pnpm sandbox:deploy  # bundle the host service and restart it in the VM
pnpm sandbox:spike   # boot a microVM and verify exec over vsock
pnpm sandbox:logs    # host service logs
pnpm sandbox:stop    # shut the Lima VM down
```

## Risks and open questions

- **Nested virtualization performance.** Measured in the spike: a microVM boots
  to first exec in ~4.7 s inside the Lima VM, which is fine for long-lived
  per-agent VMs. Snapshot/restore will cut latency for newly created agents; if
  it disappoints, fall back to Apple's Containerization framework.
- **Mac sleep vs always-on.** Agents stop when the Mac sleeps. True 24/7
  requires the Linux backend; the `SandboxBackend` interface keeps that door
  open.
- **Codex harness shape.** It is built for coding agents. Using it as a general
  teammate model may need prompt and tool adaptation, and the in-app
  subscription flow still needs an end-to-end test.
- **VM image size.** A Chrome + Node + Python rootfs is heavy; image build and
  snapshot sizes need to stay manageable.
- **Compaction quality.** Summaries are model-written and can lose detail.
  There is no way to inspect or edit a summary beyond reading the message.
- **Tauri mobile.** Tauri v2 mobile is younger than React Native; if it
  disappoints at M6, the UI is React and can be ported.
