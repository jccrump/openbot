# OpenBot Architecture

OpenBot is a Grok Bot-style platform: always-on AI teammates ("agents") that
each get their own computer, act through shell, file, and browser tools, and
run on any model you connect — an API provider (DeepSeek first) or a local
model. The built-in OpenBot harness (our loop + VM tools) is the primary path;
the optional Codex harness can bring a ChatGPT subscription or drive non-OpenAI
models through the local responses bridge.

Single-user, Mac-first. Mobile is a later thin client.

## Status

- **M0 (done):** monorepo, daemon, model gateway, SQLite persistence,
  WebSocket protocol, Mac UI, mock-provider smoke test.
- **M1 (mostly done):** Lima + Firecracker sandbox host, one microVM per agent,
  guest agent over vsock, shell/file tools, host-routed browser tools,
  approvals, local-Mac
  computer mode. Still missing: snapshots, per-bot egress policy, a polished
  base image.
- **M2 (in progress):** browser automation with persistent sign-ins and
  screenshots works. The shared Chromium/Xvfb desktop is delivered through
  x11vnc, two localhost WebSocket relays, and noVNC; the guest desktop remains
  as a fallback. Sign-in polish is still incomplete.
- **M3 (partial):** the optional Codex harness runs in the daemon and the
  Responses-to-Chat-Completions bridge drives non-OpenAI models (verified end
  to end with a real DeepSeek key, including a tool call in the microVM). The
  ChatGPT subscription flow has not been verified end to end from the app.
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
|    agent list - chat - tool cards - approvals - live noVNC desktop    |
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
|  (OpenAI-compatible,       +-- Chromium/Xvfb per agent (shared view)  |
|   Codex CLI + bridge)      +-- Firecracker microVM per agent          |
|                                 guest agent: exec, files, fallback VNC|
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
packages/sandbox/          Sandbox client + Lima/Firecracker host service,
                           host browser daemon, and guest agent
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
- Surfaces today: agent list with search, last-message previews, a per-agent
  settings menu, and the model picker in the sidebar; chat with streaming text
  and a three-dot typing bubble while the model is thinking (reasoning deltas
  are received but hidden by default); a computer switcher; tool cards with
  output and screenshots; inline approval cards; a collapsible live noVNC
  screen panel with screenshot fallback and a draggable resizer; create-agent modal; and
  Settings.
- Background or unfocused windows keep their RFB connection and last rendered
  canvas warm, but hold framebuffer update requests, disable input, and suspend
  screenshot polling. The pending update is released on focus, avoiding a new
  handshake without creating background x11vnc encoding work.
- Not present: approvals inbox, run log, routines browser, memory browser, and
  group chats.

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

### Harnesses: the OpenBot loop (primary) and Codex (optional)

Two ways to drive an agent's computer, both selectable in Settings. The OpenBot
loop is the primary path; Codex is an optional, experimental bring-your-own
mode.

1. **OpenBot loop** (`agent.ts`) — the daemon owns the agent loop and the
   tools. Approvals surface in the app, streaming maps directly onto the
   protocol, reasoning deltas are hidden by the UI (the typing bubble signals
   thinking), and any OpenAI-compatible model works. This is the default.
2. **Codex** (`codex.ts`) — the daemon spawns `codex exec --json` with
   `--ignore-user-config --skip-git-repo-check --ephemeral --sandbox
   read-only`, registers `packages/mcp` as the only MCP server, and maps Codex
   JSONL events (`agent_message`, `reasoning`, `mcp_tool_call`,
   `command_execution`, `turn.completed`, `turn.failed`) onto the OpenBot
   protocol. Codex plans; every action still runs inside the agent's microVM
   through the MCP tools. The daemon refuses Codex runs for This Mac agents.

**Codex with non-OpenAI models.** When the selected provider is not
OpenAI/ChatGPT, the daemon starts the Responses-to-Chat-Completions bridge
in-process (`packages/responses-bridge`) and points Codex at it with
`wire_api = "responses"`. Codex 0.154 sends Responses-API `developer`-role
messages and reasoning items, so the bridge normalizes the transcript before
forwarding it upstream:

- `developer` and `system` messages map to `system` (merged with the
  `instructions` block); `user`, `assistant`, and `tool` pass through; unknown
  roles fall back to `user`.
- Reasoning summaries are folded into the assistant tool-call message as
  `reasoning_content` instead of a separate assistant message, which thinking
  models such as DeepSeek require when a tool call is passed back. Reasoning
  that is not followed by a tool call is dropped.
- Consecutive `function_call` items merge into one assistant message with
  multiple `tool_calls`, `function_call_output` becomes a `tool` message, and
  empty message content or tool outputs without a `call_id` are skipped so the
  transcript stays valid.
- Tool definitions in a namespace are flattened to `namespace__name` and mapped
  back on the way out.

**The ChatGPT-quota isolation rule.** Codex can authenticate with a ChatGPT
subscription, and subscription quota must only ever be spent on OpenAI/ChatGPT
models. `isOpenAIChatGptProvider()` classifies the selected provider by id,
label, and base URL host (`openai.com`, `chatgpt.com`):

- **OpenAI/ChatGPT provider:** Codex runs with the user's normal `CODEX_HOME`
  and ChatGPT login. Subscription auth is allowed.
- **Any other provider:** the daemon deletes `auth.json` in an isolated
  `CODEX_HOME` under the data dir and uses the bridge described above. Codex
  cannot reach the ChatGPT backend from that home, so subscription quota is
  never touched and the provider key is only passed to the bridge.

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
  (`vmlinux-6.1.155`) and Ubuntu 24.04 rootfs (squashfs converted to a 4 GiB
  ext4). Node 22 is installed and the rootfs is provisioned with the guest
  agent, desktop stack, and standalone DNS resolvers.
- The guest agent (`packages/sandbox/guest/agent.py`) runs as PID 1 via the
  `init=` boot arg and listens on vsock port 5000. It mounts /proc, /sys, and
  /dev itself, executes newline-delimited JSON requests
  (`{cmd, cwd?, timeout?}` to `{exit, stdout, stderr}`), and survives
  individual connection failures.
- Browsers do not run inside nested Firecracker. Both Chromium and Firefox
  repeatedly stalled there despite healthy networking, software rendering, and
  a 6.1 kernel; the identical browser/rootfs loaded pages normally on the outer
  Lima kernel. The sandbox host therefore launches one persistent Chromium
  daemon and one Xvfb/x11vnc desktop per agent. Chromium runs under a dedicated
  unprivileged Linux account with its sandbox enabled, while the profile and
  Unix socket are private to that account. Warm actions typically complete in
  tens to hundreds of milliseconds.
- The live noVNC stream is the same outer X display Chromium renders into.
  Model actions and manual takeover therefore share a page, cookies, focus, and
  navigation history. The guest still owns shell/files and runs its lightweight
  desktop as a fallback if the browser presentation layer cannot start. Design
  notes on computer-use batching, DOM text, screenshots, and observation
  budgets are in
  [research/computer-use.md](research/computer-use.md).
- The desktop supervisor starts Xvfb at 1280x800, Openbox, tint2, xterm, and
  x11vnc. x11vnc listens only on guest loopback. The guest agent verifies an
  `RFB 003.x` greeting before exposing the stream on vsock port 5900 and
  restarts the complete desktop stack if a long-lived component exits.

**Sandbox host service.** `packages/sandbox/host/service.ts` is bundled with
esbuild into a single `service.mjs`, installed into the Lima VM at
`/var/lib/fc/openbot/service.mjs`, and run by systemd as `openbot-host` on
`127.0.0.1:4171` (Lima forwards the port to the Mac). It manages per-agent VMs:

- `GET /health`, `GET /vms/:botId/status`
- `POST /vms/:botId/ensure` boots the VM if needed, serializes concurrent
  ensures, configures Firecracker through its API, and does not report
  `running` until both the exec agent and an RFB framebuffer are reachable
- `POST /vms/:botId/exec` runs a command through the vsock agent
- `POST /vms/:botId/browser` runs an action in the persistent per-agent browser
- `POST /vms/:botId/stop` and `POST /vms/:botId/destroy`

Per-agent state lives in `/var/lib/fc/vms/<botId>/` (rootfs copy and version,
newest recovery image, browser profile/log, `api.sock`, `vsock.sock`,
`serial.log`). `sandbox:setup`
hashes the managed guest payload into `/var/lib/fc/rootfs.version`. On a version
mismatch, the host checks and mounts the stopped old image, creates a fresh
rootfs from the base, copies durable data from `/root`, `/home`, `/srv`, and
workspace directories, boots and checks the new desktop, then gzip-compresses
the old rootfs as a recovery artifact. A failed boot rolls back atomically and
keeps the failed image for diagnosis. Low disk space fails before copying,
partial first-boot copies are removed, and successful upgrades retain only the
newest compressed rollback image.

The host exposes RFB only as `ws://127.0.0.1:4171/vms/:id/vnc`; the daemon
validates the bot and browser origin and relays it as
`ws://127.0.0.1:4170/bots/:id/vnc`. noVNC uses exponential reconnect backoff
with jitter and disposes canvases, sockets, and timers when the panel changes.
`pnpm vnc:smoke` performs an RFB 3.8 handshake, requests Raw encoding, and
requires actual framebuffer bytes, so an HTTP/WebSocket upgrade alone cannot
pass.

**Networking.** Each microVM gets a tap device and a static IP
(`172.16.<slot>.2`) with NAT through the Lima VM's uplink. Set
`OPENBOT_SANDBOX_NETWORK=false` in the sandbox host service to run computers
offline. There is **no per-bot egress policy**: every VM shares the same NAT
and can reach anything the host can.

**One microVM per agent.** Each agent gets its own kernel and persistent durable
data, plus a separate outer-browser profile and Linux account for sign-ins.
Deleting an agent aborts its active runs,
deletes its threads and messages, removes its local workspace, and destroys its
VM (`POST /vms/:botId/destroy`). Image-upgrade rollback exists; general user
snapshots, pause/resume, and point-in-time restore do not.

### Tools and approvals

The daemon exposes four tools to any model that supports function calling:

- `shell` — run a command on the agent's computer
- `read_file` — read a file from the agent's computer
- `write_file` — write a file, creating parent directories
- `browser` — drive the real browser: `goto`, `click`, `type`, `text`, `links`,
  `screenshot`, `back`, `wait`. Navigation and interaction actions include a
  bounded text observation of the resulting page; `links` returns link labels
  and URLs. Cookies and sign-ins persist in the browser profile between calls,
  and screenshots are saved as artifacts and rendered in the chat and screen
  panel. Every result is labeled with a stable per-run observation ID and a
  coarse source type (`direct-page`, `search-results`, `blocked-or-missing`, or
  `failed`) before it is returned to the model and persisted.

Tool activity is streamed to the app (`tool.start`, `tool.result`) and
persisted on the assistant message as `toolCalls`, so the next turn rebuilds a
correct assistant/tool-call/tool-result history for the provider.

The built-in agent loop is completion-driven. Every model-requested tool call
is executed and returned to the model, and the loop continues until the model
emits a response with no more tool calls. There is no fixed round or action
count. The user can cancel the run, each provider round and tool action has its
own timeout, and connection failures after tool activity persist an honest
incomplete response instead of treating progress narration as success.

When a run used the browser, the first proposed final answer is buffered rather
than shown immediately. The daemon builds a bounded evidence ledger from the
persisted observations and asks the same configured model to audit the draft
against the original user request. The verifier must keep claims bound to the
exact entity and source that support them. A passing draft is released to chat;
a rejected draft and its concrete gaps are returned privately to the executor,
which may browse again or revise unknown claims before another audit. Invalid or
unavailable verifier output fails open so a provider formatting problem cannot
strand an otherwise completed run.

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
- `bots.create`, `bots.update`, `bots.delete`
- `provider.upsert`, `provider.remove`, `provider.fetchModels`
- `settings.update` — default model, approval toggle, harness
- `approval.respond`

Server to client:

- `hello` — snapshot: agents, threads, providers, presets, default model,
  approval setting, harness, Codex info
- `threads`, `thread.messages`, `thread.upserted`
- `chat.start`, `chat.delta`, `chat.reasoning`, `chat.done`, `chat.error`,
  `chat.compaction` — the app receives reasoning deltas but hides them by
  default; the typing bubble is the only thinking signal
- `tool.start`, `tool.result` — live tool activity for the transcript cards
- `approval.request` — asks the user to approve a tool action
- `sandbox.state` — agent computer state (stopped, booting, running, error)
- `bot.created`, `bot.updated`, `bot.deleted`, `providers.updated`,
  `provider.models`

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
- x11vnc has no password because it is reachable only on the outer Lima
  loopback. The sandbox host and daemon WebSockets are also loopback-only; this
  is a local-user trust boundary, not multi-user auth.
- Provider keys live in the SQLite database (`0600` file in a `0700` directory)
  or in environment variables referenced by name. The macOS Keychain is
  planned, not implemented. Keys are never logged.
- Firecracker microVMs isolate shell and file execution for cloud models.
- Chromium runs under a dedicated per-agent Linux account with Chromium's
  namespace sandbox enabled in the shared outer Lima VM. Profiles and runtime
  sockets are owner-only, but browser processes do not have per-agent kernels;
  Lima remains the outer containment boundary for browser compromise.
- This Mac agents run as the user. The only boundary is the workspace path
  check for file tools plus mandatory approvals for every action.
- There are no per-bot egress allowlists and no snapshots before risky
  operations yet.

## Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 | Monorepo, daemon, gateway, SQLite, WS protocol, chat UI, smoke test | Done |
| M1 | Lima + Firecracker host, one agent VM, guest agent, shell/file tools, approvals | Done except snapshots and egress policy |
| M2 | Browser automation, persistent sign-ins, live screen view | Browser automation, screenshots, and live noVNC desktop done; sign-in polish pending |
| M3 | Codex provider with ChatGPT sign-in | Optional Codex harness + responses bridge implemented; bridge verified end to end with a real non-OpenAI provider; ChatGPT subscription flow not verified end to end; SDK provider planned |
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
caching and refresh handled by Codex, works with Plus/Pro plans. The same
harness is reused for non-OpenAI models through the responses bridge with an
isolated `CODEX_HOME`, so subscription quota is never spent on other providers.
The tradeoffs are a coding-agent-shaped harness, plan limits, and Responses-API
translation that must track Codex releases (see the harness section). Unofficial
ChatGPT-web reverse engineering was rejected (ToS risk, constant breakage).

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

**ADR-012: Tool tasks are completion-driven.** Research and multi-site work can
legitimately need more than a handful of browser actions, so action counts are
not a completion signal. Browser navigation returns page evidence in the same
action and the model continues until it chooses to answer. Cancellation,
per-operation timeouts, and honest failure recovery contain real failures. The
default system prompt is a small general contract about completing the request,
binding facts to their evidence, separating verification from inference, and
returning the useful result to chat.

**ADR-013: Verify browser-backed answers against an evidence ledger.** Prompt
instructions alone do not prevent a weaker model from combining a price from
one product, pickup language from another, and a nearby store into a false local
availability claim. Browser outputs therefore become numbered, source-typed
observations. The harness holds the draft, runs a separate evidence-grounded
completion audit, and returns gaps to the executor until it can either support
the claim or label it unknown. The verifier is intentionally separate from the
compact general system prompt so research-specific quality control does not grow
that prompt into a catalog of situations.

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
pnpm vnc:smoke -- ws://127.0.0.1:4170/bots/<bot-id>/vnc
                 # prove RFB negotiation reaches actual framebuffer bytes
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
  subscription flow still needs a real-quota end-to-end test. The bridge path
  is verified against DeepSeek, but Codex release changes to Responses items
  can break the translation and need a live re-check.
- **VM image size.** A Chrome + Node + Python rootfs is heavy; image build and
  compressed recovery-image sizes need to stay manageable. Recovery artifacts
  are intentionally retained and require manual capacity management.
- **Compaction quality.** Summaries are model-written and can lose detail.
  There is no way to inspect or edit a summary beyond reading the message.
- **Tauri mobile.** Tauri v2 mobile is younger than React Native; if it
  disappoints at M6, the UI is React and can be ported.
