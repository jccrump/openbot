# OpenBot Architecture

OpenBot is a Grok Bot-style platform: always-on AI teammates ("agents") that
each get their own computer, act through shell, file, and browser tools, and
run on any model you connect — an API provider (DeepSeek first) or a local
model. The built-in OpenBot harness (our loop + VM tools) is the primary path;
the optional Codex harness can bring a ChatGPT subscription or drive non-OpenAI
models through the local responses bridge.

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
- **M4 (done):** one agent per thread — every agent owns its own computer set
  (the microVM, This Mac, or both), its own memory and soul, and nothing routes
  work between agents. See [Agents](#agents).
- **M5+ (planned):** mobile. Routines shipped ahead of the milestone (ADR-027).

Subagent handoffs and group chats are not implemented. Every agent is
independent: it has exactly one thread and its own computer set, and nothing
routes work between agents.

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
- Surfaces today: the thread rail on the left (one entry per agent); chat with
  streaming text, a three-dot typing bubble while the model is thinking
  (reasoning deltas are received but hidden by default), collapsible
  **Worked N actions** groups, tool cards with output and screenshots, and
  inline approval cards; the agent panel with Screen, Files, and Terminal tabs
  and a draggable resizer; and the approvals, memory, agent-settings, and
  Settings modals.
- **Agent panel.** The Screen tab is the live noVNC view with screenshot
  fallback and full-screen takeover; the VNC socket is only opened while that
  tab is active, so the desktop is never streamed in the background. The Files
  tab lists the agent's computer through `files.list`/`files.read`: on This Mac
  the daemon runs the workspace-confined `code-tools.mjs` helper, and in the
  guest the long-running Python agent answers `list`/`read` ops natively. The
  native path matters: the guest's Node binary is 122 MB and a Node cold start
  costs ~800 ms there, while the in-process op answers a directory in ~10 ms.
  The Terminal tab opens `ws://…/bots/:id/terminal`, proxied to the sandbox
  host and then to a PTY bridge in the guest, and renders it with xterm.js;
  input, resize, and base64 output are newline-delimited JSON frames, and the
  session stays alive across tab switches and ends when the panel closes or the
  agent changes.
- Background or unfocused windows keep their RFB connection and last rendered
  canvas warm, but hold framebuffer update requests, disable input, and suspend
  screenshot polling. The pending update is released on focus, avoiding a new
  handshake without creating background x11vnc encoding work.
- The screenshot fallback captures the display host's desktop — the same
  display the browser and desktop tools act on — so the panel never shows a
  different desktop than the model is working with. While the VM is stopped the
  panel backs off to a slow poll instead of hammering the daemon with 409s.
- The screen panel preview is view-only: the small desktop view streams live
  frames but noVNC never captures clicks, cursor, or keyboard there. Hovering
  the preview shows a centered **Open** pill; clicking the preview or the pill
  expands it to a full-screen takeover view where input is live, and Esc (or
  the collapse control) returns to the view-only preview. Model actions over
  VNC and manual takeover share the same display, so the model can keep
  working while the user watches, and either can take over.
- Not present yet: approvals inbox, memory browser, and
  group chats. The thread rail is a flat list of agents.

**Settings layout.** Seven sections in a left nav with search:

- **General** — default model and the global "ask before running commands"
  toggle.
- **Appearance** — theme: System, Light, or Dark. The preference is stored in
  `localStorage` and applied before React mounts; "System" follows the Mac and
  updates live.
- **Providers** — list, enable/disable, add/edit/remove, presets, key fields,
  model list, and "Fetch models".
- **Workspaces** — the local project registry: scan roots, discovered projects,
  add/ignore/remove, and per-project trusted command patterns.
- **Access** — probes the macOS-gated folders (Documents, Desktop, Downloads,
  Full Disk Access) and deep-links the matching privacy pane.
- **Harness** — pick the default harness (OpenBot or Codex). Codex is only
  selectable when the CLI is detected on `PATH`.
- **Decision model** — the optional Jev (TypeSafe System One) integration:
  enable, base URL, model, API key or environment variable, confidence
  threshold, per-call timeout, and toggles for the completion audit, the
  `browse` tool, and the untrusted-content guardrail (off / annotate / block).

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
  events. Abortable per run; completion-driven, with no fixed round limit.
- `browse.ts` — the Jev-driven browse loop: reads the current page and its
  links, asks the decision model which link to follow and whether the evidence
  is sufficient, and returns the collected pages.
- `guardrail.ts` — Jev screening of untrusted page text for instruction
  override and exfiltration requests.
- `compaction.ts` — context-window management (see [Compaction](#compaction)).
- `decision.ts` — Jev settings, key resolution, and the decision-client
  factory (env < `config.json` < stored settings).
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
search message text. Clearing a chat (`thread.clear`) is the fresh-start
affordance without a second thread: the daemon aborts the active run, drops
queued messages, folds every message, drops the working plan, resets the title,
and stamps `clearedAt`. The thread and its memory stay; folded
messages remain readable through `thread.messages` with `includeFolded`.

### Harnesses: the OpenBot loop (primary) and Codex (optional)

Two ways to drive an agent's computer, both selectable in Settings. The OpenBot
loop is the primary path; Codex is an optional, experimental bring-your-own
mode.

1. **OpenBot loop** (`agent.ts`) — the daemon owns the agent loop and the
   tools. Approvals surface in the app, streaming maps directly onto the
   protocol, reasoning deltas are hidden by the UI (the typing bubble signals
   thinking), and any OpenAI-compatible model works. This is the default. The
   loop is completion-driven and bounded: it keeps taking tool steps until the
   model returns a final answer, with a step cap (60) that ends the turn with
   a note instead of looping forever, a duplicate-failure stop after three
   identical failing calls, one retry for transient sandbox and provider
   failures, model-readable `[tool error]` results so a failed call can be
   recovered in the same turn, and automatic compaction on context overflow.
   Tool output longer than the model's budget is spilled to a file inside the
   computer and named in the result, so nothing is lost. Tool failures never
   crash a turn: the model sees what happened and adapts. Within a turn, a file
   re-read unchanged and a byte-identical repeat of the same call collapse to
   short notes, so a long run does not pay for the same content twice; both
   caches clear when compaction rebuilds the transcript. `update_plan` stores a
   short working plan on the thread — it is injected into later turns as
   `[plan]`, so it survives compaction and context growth. File and command
   output is screened for prompt injection: output that looks like it addresses
   the agent goes to the decision model, and `annotate` warns while `block`
   withholds it. `shell` can detach a command with `background: true` — a
   server, watcher, or build keeps running past the command timeout with its
   output in a log file the model can tail or kill by pid.
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

### Agents

The runtime is **one agent per thread**. Every agent is a durable identity: it
owns its conversation, its soul, and its memory, and it has exactly one
computer — a Firecracker microVM or This Mac — chosen when it is created.

- An agent is a `bots` row with a name, role description, avatar, color, model,
  and a single `computer` (`firecracker` or `mac`). The first agent is seeded
  on a fresh install.
- One continuous thread per agent (`getOrCreateThread`); there is no
  new-chat affordance, and clearing the thread is the fresh-start path.
- An agent acts directly on its own computer through the shell, file, browser,
  desktop, and web_search tools. It can also assign itself a registered project
  folder (workspace) and an access mode, so a This Mac agent can work inside a
  real repo.
- Memory and soul are per-agent: each agent owns a memory scope keyed by its id
  and a versioned soul that a background reflection pass updates.

### Memory and soul

Memory is a SQLite store (`memories`) with FTS5 keyword search plus brute-force
vector search over stored embeddings. The embedding client is any
OpenAI-compatible `/embeddings` endpoint; with none configured, a deterministic
hashed-embedding fallback keeps retrieval working offline. (`sqlite-vec` via
`loadExtension` is the upgrade path if brute force ever matters at this scale.)
Memories are typed (semantic, relational, procedural, episodic), scoped per
agent (the bot id), and carry evidence, confidence, importance, use counts, and
status (`active` / `suspect` / `archived`).

- **Writes.** Each agent writes its own memories explicitly with `remember`,
  searches with `recall`, and archives with `forget`.
- **Injection.** Every turn retrieves a bounded, relevant slice from the
  agent's own scope and injects it as a system note with memory ids. Used
  memories get a use-count bump, which feeds ranking.
- **Automatic upkeep.** A background reflection pass runs on a debounce after
  turns and on a timer. It extracts durable memories from the new conversation
  using the scope's model, folds near-duplicates into existing rows, decays
  unused memories toward an archive threshold, and merges near-duplicates.
  `memory.consolidate` lets the UI force a prune.
- **Soul.** Each agent's soul is a versioned constitution (`soul_versions`):
  voice, commitments, relationship. The agent can update it with `update_soul`,
  and the reflection pass rewrites it once enough new memories accumulate.
  Every version is kept and the user can revert from the Memory panel.

**Routines.** A routine is an agent-owned scheduled spawn: a brief template
and a schedule, pinned to one of the agent's computers. The daemon's
`RoutineService` fires due routines into the agent's thread — the brief lands
as a user message marked with a `routine` ref, so the transcript shows what
triggered the turn — and journals every firing in `routine_runs`. A routine
runs on its computer only while the agent still has that computer (ADR-021):
when the grant is revoked the routine is listed as unavailable and its
firings are journaled as skipped instead of silently running elsewhere. The
scheduler never interrupts a running turn; a firing waits for the agent to go
idle. The schedule is structural — an interval or a daily local time — so
there is no cron parser. Runs keep the agent's approval policy, so an
unattended This Mac routine can stall on an approval card until the policy
timeout denies it (ADR-027).

### Model gateway (`packages/gateway`)

- `ChatProvider` interface: `chat(request) -> AsyncIterable<ChatEvent>`, where
  events are `text_delta`, `reasoning_delta`, `tool_calls`, `usage`, or `done`.
- `openai-compatible.ts` — streaming SSE client for any OpenAI-compatible
  endpoint (DeepSeek, OpenAI, OpenRouter, Groq, xAI, Google, Mistral, Ollama,
  LM Studio, vLLM, ...). Handles `reasoning_content` deltas and accumulates
  streamed tool calls.
- `decision.ts` — TypeSafe System One client (`@typesafe-ai/sdk`) wrapped
  behind a small `DecisionClient.evaluate({state, questions})` interface. It is
  not a `ChatProvider`: Jev returns typed answers (`noul`, `choice`, `score`)
  with calibrated confidence instead of streaming text, with per-call timeouts
  and retries.
- `presets.ts` — provider presets used by the settings UI; `models.ts` fetches
  the model list from any OpenAI-compatible `/models` endpoint.
- There is no `@openai/codex-sdk` provider yet; the Codex path shells out to
  the CLI instead. A daemon-native SDK provider is on the roadmap (M3).

### Provider settings

Providers are user data, not code. They live in the `providers` table and are
managed from Settings:

- Add, edit, remove, and enable/disable providers with a name, base URL,
  models, and either an API key or the name of an environment variable holding
  one (an environment variable wins when both exist). There is no
  capability setting to configure: `packages/gateway/model-capabilities.ts`
  indexes model families (vision support and context window) and the harness
  looks up the selected model. Vision-capable models receive screenshots from
  the browser and desktop tools as a follow-up user message — DeepSeek and
  other OpenAI-compatible providers only accept images in `user` messages —
  while unknown or text-only models never receive image content, so a request
  cannot fail on an image. Only the latest screenshot is kept in history.
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
  daemon uses 75% of the context window from the model capability index
  (`packages/gateway/model-capabilities.ts`; DeepSeek models are mapped to
  128k) and falls back to 100,000 tokens for unknown models.
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
- **Clear.** `thread.clear` reuses folding for a user-driven fresh start: the
  active run is aborted, queued messages dropped, and the whole transcript
  folded with no summary message, so the next turn begins from the system
  prompt, soul, and memory only. `cleared_at` marks the break for the app, and
  the reflector still extracts memories from the folded text.
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
  (`{cmd, cwd?, timeout?}` to `{exit, stdout, stderr}`), streams stdout/stderr
  chunks (`{type: "chunk", stream, data}`) before the final result line, and
  survives individual connection failures.
- Browsers do not run inside nested Firecracker. Both Chromium and Firefox
  repeatedly stalled there despite healthy networking, software rendering, and
  a 6.1 kernel; the identical browser/rootfs loaded pages normally on the outer
  Lima kernel. The sandbox host therefore launches one persistent Chromium
  daemon and one Xvfb/x11vnc desktop per agent. Chromium runs under a dedicated
  unprivileged Linux account with its sandbox enabled, while the profile and
  Unix socket are private to that account. Warm actions typically complete in
  tens to hundreds of milliseconds.
- **The browser engine is CDP, not Playwright.** The host launches Chromium
  itself with `--remote-debugging-port=0` (the daemon reads the port and path
  from `DevToolsActivePort`) and drives it through the vendored
  `browser-use/browser-harness-js` session
  (`packages/sandbox/host/vendor/browser-harness-js/`, MIT — see its
  PROVENANCE.md for the three local patches). Two sessions attach to the same
  browser: a deterministic action session for the `browser` tool
  (goto/click/type/links/fields/text/scroll/screenshot/back/wait/clickLink/
  snapshot) and a snippet session for `browser_execute`, which runs
  agent-written JavaScript against the full CDP surface with console capture,
  JSON return values, auto-attached screenshots, and a scoped timeout guard.
  playwright-core is still installed on the host only as the Chromium binary
  downloader. `browser_step` pairs a page snapshot with a Jev choice so Jev
  picks the element (~300 ms) and the browser acts, and
  `/root/openbot-skills/browser-execute/` in the guest carries the vendored
  playbook and interaction recipes for the model to read.
- **The agent desktop is a small shell, not just a browser.** The host starts
  Xvfb at 1280x800 with Openbox, a tint2 panel (Files, Browser, and Terminal
  launchers, taskbar, clock), an xterm terminal, and a generated gradient
  wallpaper; the browser opens as a window so the desktop stays visible. Files
  is Thunar running against `/root`, and both apps are ordinary X clients of
  the same display the agent drives, so the user can browse the VM while the
  agent works. The Browser launcher is a per-agent script (written with the
  agent's id and the Playwright Chromium icon) that opens the same persistent
  profile the model uses through the host browser API, or focuses the existing
  Chromium window when it is already running. The panel is tracked separately and respawned if it exits; closing the
  terminal never tears down the session. The browser disables the
  AutomationControlled blink feature so pages do not see
  `navigator.webdriver`; a Chromium policy suppresses the resulting
  command-line warning bar so the shared screen stays clean.
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
- `POST /vms/:botId/exec` runs a command through the vsock agent; the host
  wraps it in `bash -c` so bash-only constructs (PIPESTATUS, `[[ ]]`, arrays)
  behave the way agents expect. The guest agent streams stdout/stderr as it is
  produced, and with `stream: true` the host relays NDJSON chunk lines
  followed by the final result, so the app can show terminal output live.
- `POST /vms/:botId/browser` runs an action in the persistent per-agent browser
- `POST /vms/:botId/desktop` runs a mouse, keyboard, scroll, drag, or window
  action on the agent's desktop display with xdotool (installed in the outer
  Lima VM), and captures screenshots with scrot
- `ws://…/vms/:botId/terminal` relays a PTY session: the host connects to
  guest vsock port 5001, where `agent.py` spawns `/bin/bash -l` on a pty and
  frames input, resize, and base64 output as newline-delimited JSON
- `POST /vms/:botId/files` sends `{ op: "list" | "read", … }` to the guest
  agent over vsock and returns its JSON answer, so the app's file browser does
  not spawn a process per folder
- `POST /vms/:botId/stop` and `POST /vms/:botId/destroy`
- `GET /vms/:botId/network` returns the browser session's HAR network trace
  (`/var/lib/fc/vms/<botId>/network.har`), recorded per page request with a
  bounded, debounced rewrite. A browser `upload` action stages guest files as
  host copies the browser account can read before attaching them to a file
  input, since Chromium runs on the host while the agent's files live in the
  microVM; a `downloads` action copies the host download directory back into
  `/root/Downloads` in the VM for the same reason
- `POST /vms/:botId/network-policy` sets a hard shell egress allowlist for the
  VM. The host resolves the hostnames to IPv4 addresses and rebuilds the
  `inet openbot_egress` table, whose forward hook jumps to a per-tap chain that
  drops everything outside the allowlist (plus DNS to the image's resolvers
  and established traffic). Rules re-apply on boot and are removed with the VM

Per-agent state lives in `/var/lib/fc/vms/<botId>/` (rootfs copy and version,
newest recovery image, browser profile/log, `api.sock`, `vsock.sock`,
`serial.log`). Each VM records the daemon that created it (`owner`, a hash of
the data dir).
On startup a daemon calls `POST /prune` with every bot it still knows; the host
removes that owner's stopped VM
directories that are not in the list. A delete lost to a daemon or host restart
therefore costs disk only until the next start, and one daemon can never prune
another's (or an eval runner's) computers. `sandbox:setup`
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
`ws://127.0.0.1:4170/bots/:id/vnc`. The terminal follows the same shape:
`ws://127.0.0.1:4171/vms/:id/terminal` relayed as
`ws://127.0.0.1:4170/bots/:id/terminal`, with the same origin check and a
Firecracker-only rule (This Mac gets a clear message in the UI). noVNC uses
exponential reconnect backoff with jitter and disposes canvases, sockets, and
timers when the panel changes. `pnpm vnc:smoke` performs an RFB 3.8 handshake,
requests Raw encoding, and requires actual framebuffer bytes, so an
HTTP/WebSocket upgrade alone cannot pass.

**Networking.** Each microVM gets a tap device and a static IP
(`172.16.<slot>.2`) with NAT through the Lima VM's uplink. Set
`OPENBOT_SANDBOX_NETWORK=false` in the sandbox host service to run computers
offline. There is **no per-bot egress policy**: every VM shares the same NAT
and can reach anything the host can.

**One microVM per agent.** Each agent gets its own kernel and persistent durable
data, plus a separate outer-browser profile and Linux account for sign-ins.
Deleting an agent aborts its active runs,
deletes its threads and messages, removes its local workspace, and destroys its
VM (`POST /vms/:botId/destroy`). **Start fresh** (`bots.reset`) is the
non-destructive variant: it aborts runs, deletes the threads, messages, and
workspace, destroys the VM — including the browser profile — and immediately
rebuilds it from the base image so the next use is a clean install. The app
confirms it with a dedicated dialog before sending anything, and the sandbox
state (`stopped` → `booting` → `running`) streams to the UI while the VM
rebuilds. Image-upgrade rollback exists; general user snapshots, pause/resume,
and point-in-time restore do not.

### Tools and approvals

The daemon exposes these tools to any model that supports function calling:

- `shell` — run a command on the agent's computer
- `read_file` — read a file from the agent's computer
- `write_file` — write a file, creating parent directories
- `browser` — drive the real browser: `goto`, `clickLink`, `click`, `type`,
  `fields`, `text`, `links`, `scroll`, `screenshot`, `back`, `wait`. The tool
  and the default system prompt steer human-style browsing: open the site, use
  its own search bar, follow menus and links (`links` then `clickLink`), check
  category pages and pagination, and try a sitemap (an HTML sitemap page or
  `/sitemap.xml`) before inventing deep URLs; `fields` lists visible inputs and
  buttons with ready selectors so the model can type into the site's search
  box, and `scroll` loads content that appears as you move down the page.
  `click`, `type` with submit, and `clickLink` are navigation-aware: they wait
  briefly for a changed URL, a replaced document, or DOM activity before
  reading the page, so the observation describes the page the action produced
  instead of the one it left behind, and in-place interactions stay fast.
  Selector waits for `click` and `type` fail after ten seconds instead of
  thirty, so a stale selector costs less. Navigation and interaction actions
  include a bounded text observation of the resulting page; `links` returns
  link labels and URLs. After a navigation or interaction the action waits for
  the page's own signals — the load event, then real body text plus a short
  stretch of DOM silence (MutationObserver), capped at 3.5 seconds — so
  client-rendered pages are observed after they paint instead of returning an
  empty body, while static pages resolve in a few hundred milliseconds.
  Cookies and sign-ins persist in the browser profile
  between calls, and screenshots are saved as artifacts and rendered in the
  chat and screen panel. Every result is labeled with a stable per-run
  observation ID and a coarse source type (`direct-page`, `search-results`,
  `blocked-or-missing`, or `failed`) before it is returned to the model and
  persisted.
- `desktop` — drive the live desktop GUI itself (the same 1280x800 X display
  the app shows over VNC and Chromium renders into), for anything the browser
  tool cannot reach: native dialogs, drag and drop, context menus, scrolling
  inside apps, the terminal and file manager windows, and coordinate-level
  interaction. Actions: `screenshot`, `move`, `click` (left/middle/right,
  1-3 clicks), `drag` (with intermediate motion so drop targets register),
  `scroll`, `type`, `key` (for example `alt+F4`, `ctrl+shift+t`), `wait`,
  `windows`, and `activate`. Every action returns the pointer position, the
  active window, and by default a fresh screenshot, which becomes a chat
  artifact. Screenshots are captured with `scrot -p` and the desktop x11vnc
  runs with `-nocursorshape`, so the pointer is drawn into both the captures
  and the live framebuffer — the user can see where the model is pointing in
  the screen panel and in the chat. Input is injected with xdotool by the
  sandbox host on the agent's display; shell and file tools still run in the
  microVM, so the desktop is a presentation and interaction layer, not a
  second filesystem.
- `browse` — offered only on Firecracker computers with Jev enabled. The
  daemon runs the loop itself: it reads the page and its links, asks Jev
  `goal_met` (noul) and `next` (choice over the candidate links plus
  `__back__`/`__done__`), follows the chosen link with `clickLink`, and stops
  when the evidence is sufficient, the model chooses `__done__`, or the step
  and wall-clock budgets run out. One approval covers the whole run; the result
  is the collected evidence with `browse-00N` observation IDs, which the
  completion audit expands into one observation per page. It cannot type or
  sign in; the plain `browser` tool remains for that.
- `web_search` — search the live web from the daemon process through a hosted
  MCP endpoint (Exa by default, Parallel when configured) and return the
  provider's LLM-ready context text with titles and URLs. It never touches the
  agent's computer, so it also works on This Mac, where the browser tools are
  unavailable. `EXA_API_KEY` and `PARALLEL_API_KEY` are optional — the Exa
  endpoint is keyless — and `OPENBOT_WEBSEARCH_PROVIDER=exa|parallel` forces
  the provider. Search is an ordinary approval-gated tool call; the `read-only`
  policy preset auto-allows it and `locked` denies it.

**Bot checks.** Chromium launches with
`--disable-blink-features=AutomationControlled` and a consistent `en-US` locale,
and every browser action checks the resulting page for a Cloudflare/Turnstile
interstitial. Most non-interactive challenges clear on their own, so the action
waits up to eight seconds, and if the interstitial is stuck in a loop it tries
one fresh reload before giving up. A page that is still challenged returns
`ok: false` with `challenge: true`, and the run pauses: the daemon emits
`challenge.request` and waits (up to five minutes, or until the run is
cancelled) for the user to solve the check in the live screen panel. The app
shows a Bot check card with Open Screen, Retry, and Skip; Retry re-runs the same
browser action in place, so the model receives the page it originally asked
for, while Skip and timeouts return the blocked result and the model falls back
to another source. The `browse` loop stops with reason `challenge` instead of
burning its step budget on a blocked page.

A persistent profile is what keeps sign-ins and clearances, but a profile that
was flagged under older automation settings can keep looping even after a
manual solve. `POST /vms/:botId/browser/reset` stops the browser, moves the
profile to `browser-profile.flagged-<timestamp>` (keeping the newest backup),
and lets the next action start clean; `pnpm browser:reset -- "<agent name>"`
wraps that with agent-name resolution through the daemon.

Tool activity is streamed to the app (`tool.start`, `tool.result`) and each
step's narration and tool calls are persisted together as that step's assistant
message, so the next turn rebuilds a correct assistant/tool-call/tool-result
history for the provider. The app groups a turn's step messages and tool calls
under one collapsed work group once the final answer arrives.

The built-in agent loop is completion-driven. Every model-requested tool call
is executed and returned to the model, and the loop continues until the model
emits a response with no more tool calls. There is no fixed round or action
count. A step's narration and its tool calls are persisted as one assistant
message (`chat.message`) and the live bubble is cleared: while the run is
active the app shows each step as it happens, and when the final answer arrives
the turn's steps and tool calls collapse into a single work group above it. The
user can cancel the run, each provider round and tool action has its own
timeout, and connection failures after tool activity persist an honest
incomplete response instead of treating progress narration as success.

When a run used the browser (or the `browse` tool) and the completion audit is
on, the draft answer streams to chat as it is written but is not final until it
passes. The daemon builds a bounded evidence ledger from the persisted
observations and audits the draft against the original user request. With Jev
enabled, the audit is a single typed decision call (~100–500 ms): a
`pass`/`continue` choice plus atomic `noul` checks for deliverables covered,
claims bound to their exact subject, search-result discipline, labeled
unknowns, and overstatement. Feedback text is composed in code from the failed
checks. A decisive failure returns the draft privately to the executor for
revision and the streamed text is cleared; an all-pass draft is released; only
a passing draft with checks inside a small margin of their threshold escalates
to the model verifier below, and revisions are capped at two attempts before
the current draft is released with a flagged decision notice. The model
verifier answers with a compact JSON verdict plus issue codes instead of prose.
Invalid or unavailable verifier output fails open so a provider formatting
problem cannot strand an otherwise completed run. Turning the completion audit
off in Settings skips verification entirely and ships the draft.

With Jev enabled, untrusted page text returned by the `browser` tool and every
page collected by the `browse` loop is also screened for prompt injection
(`instruction_override`, `exfiltration_request`). In `annotate` mode a
`[guardrail: …]` banner is prepended and the event is logged; in `block` mode
the page text is replaced with the warning. Jev errors fail open, and the mode
is configurable in Settings.

Approvals gate execution. With `requireApproval` on (default), the daemon emits
`approval.request` and waits; the app shows a card with the exact command and
Approve/Deny buttons. Denied actions never run and the model is told the user
denied it. `OPENBOT_REQUIRE_APPROVAL=false` runs tools without asking, which is
useful for trusted local experimentation.

**Approvals policy.** The policy engine decides `auto` / `ask` / `deny` for
every tool call: all matching rules apply and the strictest wins (tool,
computer scope, and an argument regex over the command, path, URL host, or
text), then the per-tool tier, then the default tier (which can inherit the
global switch). Deny is absolute, and This Mac tools ask unless a mac-scoped
rule allows them.
Built-in rules deny recursive deletes of `/` and home and raw disk writes, and
ask for `sudo` and piping a download into a shell. A blocked call returns
`Blocked by the approvals policy: <reason>` to the model instead of asking.

Named **presets** (balanced, read-only, trusted, locked) are one-click starting
points that always keep the built-in deny rules. Each agent can carry a
**policy** (`bots.policy`): a preset that can only make things stricter
than the global policy, since tool tiers take the stricter of the two, rules
accumulate, and timeouts take the shorter. **Egress** adds an allowlist for
browser traffic: with mode `ask` or `deny`, a host outside the list is asked
for or blocked, and subdomains of an entry count as allowed. In `deny` mode
the guest enforces the allowlist at the network level for every request the
page makes — subresources and XHR/fetch included — so a denied host cannot be
reached through a frame or a script. `ask` mode approves per navigation at the
daemon. In `deny` mode the host also enforces the allowlist for the VM's own
shell traffic: the daemon pushes the resolved policy per turn, and nftables on
the VM's tap permits only allowlisted addresses, DNS to the image's resolvers,
and established traffic. This Mac commands are never filtered.

Every request and decision is persisted with its tier, reason, and who decided
(`user`, `timeout`, `abort`); unanswered requests auto-deny after the
configured timeout; and the Approvals panel shows pending plus history with a
policy editor for tiers, timeout, rules, egress, and presets.

**Local computers (This Mac).** An agent can be created with `computer: "mac"`
("This Mac" in the create-agent modal) instead of the default Firecracker
microVM. Constraints, all enforced in `local-computer.ts` and `tools.ts`:

- `shell` runs `bash -lc` as the logged-in user with
  `<dataDir>/workspaces/<botId>` as the default working directory (created on
  demand). Any `cwd` inside the workspace is allowed; the timeout is capped at
  300 s and output at 30,000 characters, matching the sandbox path.
- `read_file` and `write_file` resolve paths inside that workspace only;
  paths that escape it (including symlink escapes) are rejected. They are
  implemented as shell commands on the host rather than direct file I/O.
- Approvals are **always required** for local tools regardless of the global
  setting, and output is prefixed with `[local Mac]`.
- `browser` returns a clear error because it needs the microVM.
- The Codex harness refuses to run against a This Mac agent.

The chat header's computer pill switches an existing agent between Firecracker
and This Mac (`bots.update` → `bot.updated`). The gear on a sidebar row opens
the **agent settings modal** (`apps/mac/src/components/AgentSettingsModal.tsx`):
it edits name, role, icon, and color, carries the same computer switch, and
adds a microVM power switch (`bots.power` → `sandbox.stop`/`ensure`, with
`sandbox.state` streaming stopped → booting → running back to the UI). Opening
the modal asks the daemon for the live computer state (`sandbox.status`).
Start fresh and Delete live in the modal's danger zone, each behind a
confirmation dialog.

### Protocol

Client to server:

- `hello` — client identification
- `chat.send` — `{ botId, threadId?, text, model?, messageId?, delivery? }`;
  `messageId` is the client-generated id echoed by the persisted transcript,
  and `delivery` (`steer` | `queue`) decides what happens when the thread
  already has a run, defaulting to the busy-turn setting
- `chat.cancel` — `{ runId }`
- `thread.list`, `thread.messages` (`includeFolded` returns the archived
  transcript), `thread.clear`
- `bots.create`, `bots.update` (name, role, avatar, color, computer),
  `bots.delete`, `bots.reset`, `bots.power`, `sandbox.status`
- `files.list` — `{ botId, path? }`, lists a directory on the agent's computer
- `files.read` — `{ botId, path }`, reads one file for the Files preview
- `provider.upsert`, `provider.remove`, `provider.fetchModels`
- `settings.update` — default model, approval toggle, harness, compaction,
  decision-model settings (enabled, base URL, model, key or env var, audit,
  browse, guardrail, timeout), busy-turn delivery default
- `approval.respond`
- `challenge.respond`

Server to client:

- `hello` — snapshot: bots, threads, providers, presets, default model,
  approval setting, harness, decision-model info, Codex info, busy-turn default
- `threads`, `thread.messages`, `thread.upserted`, `thread.cleared`
- `chat.start`, `chat.delta`, `chat.reasoning`, `chat.done`, `chat.message`,
  `chat.error`, `chat.compaction` — streaming text and live reasoning deltas
  (rendered in the expanded work group while a run is active; reasoning is not
  persisted); `chat.message` appends a persisted step message mid-run
- `chat.queued`, `chat.dequeued` — a busy-thread message was held for the next
  run, and that run has now started
- `chat.decision` — one Jev evaluation (audit, browse step, or guardrail
  screen) with its summary, latency, model, and whether it flagged something;
  the app renders these in the per-turn work group
- `tool.start`, `tool.result` — live tool activity for the transcript cards
- `tool.output` — a stdout/stderr chunk streamed while a tool runs; the app
  appends it to the running card so shell commands show their terminal output
  live instead of only when they finish
- `approval.request` — asks the user to approve a tool action
- `challenge.request` — pauses the run on a bot check until the user retries or
  skips it
- `sandbox.state` — agent computer state (stopped, booting, running, error)
- `files.list` — directory entries (name, dir, size, mtime) and the resolved
  path, or a readable error (for example, the computer is not running)
- `files.read` — `{ kind: text | image | binary | dir | missing, content, mime,
  size, truncated }`; images arrive base64 for the preview
- `bot.created`, `bot.updated`, `bot.deleted`, `bot.reset`, `providers.updated`,
  `provider.models`

Every message is defined once in `packages/protocol` with Zod and validated on
both sides.

### Data model

```
bots       id, name, system_prompt, provider, model, created_at,
           role, avatar, color, computer, workspace_id, access, policy
threads    id, bot_id, title, created_at, updated_at,
           last_compacted_at, compaction_count
messages   id, thread_id, role, content, provider, model, created_at,
           tool_calls, input_tokens, output_tokens, compaction, folded_at
providers  id, label, base_url, api_key, api_key_env, models, enabled,
           created_at, updated_at
settings   key, value
```

A bot has a `computers` capability set (`firecracker`, `mac`, or both), an
optional `workspace_id`, an `access` mode for This Mac reach, and an optional
`policy` that can only narrow the global approvals policy. A routine is a
brief plus a schedule pinned to one of the agent's computers.

```
approvals     id, request_id, run_id, thread_id, bot_id, tool, arguments,
              tier, reason, decision, decided_by, requested_at, decided_at
memories      id, scope, type, content, evidence, confidence, importance,
              status, source, embedding, embedding_model, embedding_dims,
              created_at, updated_at, last_used_at, use_count
soul_versions id, bot_id, version, content, summary, reason, source,
              created_at
routines      id, bot_id, name, brief, computer, schedule, enabled,
              next_run_at, created_at, updated_at
routine_runs  id, routine_id, bot_id, thread_id, status, reason, started_at,
              finished_at
todos         id, bot_id, parent_id, title, status, position, created_at,
              updated_at
```

`memories` also has an FTS5 companion table (`memories_fts`) kept in sync on
write. Planned additions: a general `runs` journal, `secrets`.
(references only; values would move to the macOS Keychain).

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
- Jev is off unless enabled (a `TYPESAFE_API_KEY` env var turns it on). When it
  is on, page text, answer drafts, and tool observations are sent to the
  configured TypeSafe endpoint; its key is stored exactly like provider keys.
  The guardrail screens untrusted page text before it reaches the model, and
  every Jev path fails open to the local model behavior.
- Firecracker microVMs isolate shell and file execution for cloud models.
- Chromium runs under a dedicated per-agent Linux account with Chromium's
  namespace sandbox enabled in the shared outer Lima VM. Profiles and runtime
  sockets are owner-only, but browser processes do not have per-agent kernels;
  Lima remains the outer containment boundary for browser compromise.
- This Mac agents run as the user. The only boundary is the workspace path
  check for file tools plus approvals for every action.
- There are no per-bot egress allowlists and no snapshots before risky
  operations yet.

## Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 | Monorepo, daemon, gateway, SQLite, WS protocol, chat UI, smoke test | Done |
| M1 | Lima + Firecracker host, one agent VM, guest agent, shell/file tools, approvals | Done except snapshots and egress policy |
| M2 | Browser automation, persistent sign-ins, live screen view | Browser automation, screenshots, and live noVNC desktop done; sign-in polish pending |
| M3 | Codex provider with ChatGPT sign-in | Optional Codex harness + responses bridge implemented; bridge verified end to end with a real non-OpenAI provider; ChatGPT subscription flow not verified end to end; SDK provider planned |
| M4 | One agent per thread: independent agents, each with its own computer, memory, and soul | Done |
| M5 | Routines: scheduled spawns, procedural memory, replay | Routines done (ADR-027); procedural memory and replay planned |
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

**ADR-010: Local-Mac computer mode is opt-in and approval-gated.**
Running agents directly on the Mac is useful for work that needs the user's
files and tools, but it is not sandboxed. It is an explicit per-agent choice
with path confinement for file tools, approvals on by default, and no browser
tool. Approval is the user's global switch: with "ask before running commands"
on, local tools ask even when a tool tier or the default says auto, unless a
mac-scoped rule allows them; with it off, local tools follow the same tiers as
anything else, and deny rules still win. **Always allow** on an approval card
and per-project trusted command patterns are the middle path: deliberate,
per-tool or per-command trust without turning the whole machine loose
(ADR-018 amendment, ADR-022).

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
finding things the way a person would (search bars, menus, links, category
pages, sitemaps), binding facts to their evidence, separating verification from
inference, and returning the useful result to chat.

**ADR-013: Verify browser-backed answers against an evidence ledger.** Prompt
instructions alone do not prevent a weaker model from combining a price from
one product, pickup language from another, and a nearby store into a false local
availability claim. Browser outputs therefore become numbered, source-typed
observations. The harness holds the draft, runs a separate evidence-grounded
completion audit, and returns gaps to the executor until it can either support
the claim or label it unknown. The verifier is intentionally separate from the
compact general system prompt so research-specific quality control does not grow
that prompt into a catalog of situations.

**ADR-014 amendment (superseded): Jev routing was removed.** The lead/worker
model had Jev route each request to conversation, direct work, or a project.
That routing was reverted with the lead/worker runtime — see ADR-026 below —
so Jev now only audits, browses, and screens text.

**ADR-014: Use Jev (TypeSafe System One) for decisions, with the configured
model as fallback.** The audit, link selection, and injection screening are
judgments, not text generation. A decision model answers them as typed values
with calibrated confidence in ~100–500 ms at negligible cost, where the same
judgment as an LLM call costs seconds, tokens, and JSON-parsing failure modes.
The integration is deliberately auxiliary and fail-open: Jev never writes user
facing text, cannot type into forms, and every path — audit, browse, guardrail —
falls back to the existing model behavior when Jev is disabled, unauthenticated,
borderline, or erroring. Feature toggles and the per-call timeout live in
Settings so the trade-off is visible and tunable, and the direct TypeSafe API is
the only transport (no AI SDK dependency). Rejected: making Jev the primary
model (it cannot chat or call tools), and auto-approving tool calls from a risk
score (that changes the safety model; approvals stay human).

**ADR-015 (superseded): One agent per thread.** An earlier lead/worker model
gave one lead a team of ephemeral workers and projects. That was reverted — see
ADR-026 below — because the hierarchy did not work out; OpenBot now gives every
agent its own chat, computer, memory, and soul.

**ADR-016 (superseded): Task grants and display-on-demand were removed with the
lead/worker runtime.** There are no tasks, grants, budgets, or worker displays;
each agent runs its own computer directly.

**ADR-018: Policy is the ceiling.** The global
approval toggle was too coarse; users need
per-tool tiers and argument-level rules without re-approving every call. The
engine evaluates rules first, then the tool tier, then the default (which can
inherit the global switch). Deny is absolute, and This Mac tools ask unless a
mac-scoped rule says otherwise. Every request and decision is persisted with
its tier, reason, and who decided; unanswered requests auto-deny on a
configurable timeout; an inbox shows pending plus history. Presets are
one-click starting points that keep the built-in deny floor, and an agent's
policy can only narrow the global policy. Egress allowlists gate browser
traffic per host; a `deny` policy is enforced inside the guest for every
request the page makes, while `ask` approves per navigation at the daemon, and
shell egress is enforced at the network layer in `deny` mode (nftables on the
VM's tap; DNS to the image's resolvers stays open, and This Mac is out of
scope). Rejected: per-action risk scoring that auto-approves
(approvals stay human) and policy in the prompt (the model must not be able to
widen its own permissions).

**ADR-019 (superseded): on-demand team building was removed with the lead/worker
runtime.** Agents are created by the user in the app, not by other agents.

**ADR-020: Messages sent mid-turn steer or queue.** Sending while the agent
works used to be dropped by the composer, and a second client's message would
start a concurrent run in the daemon. Now the daemon serializes per thread: a
`chat.send` that lands on a thread with an active run is either steered —
persisted immediately, folded into the running turn at its next step boundary
so the model can change course without losing completed tool work — or queued,
held in memory (never written to the transcript early, or the running turn
would read it as already delivered) and started as a fresh run when the thread
goes idle. The default is the `chatBusyBehavior` setting (`steer` or `queue`),
overridable per send; runs that cannot take steering (the
Codex harness) fall back to queueing, and a steer that lands after the last
step is answered by a follow-up run so it is never left hanging. Rejected:
abort-and-resend (throws away completed tool work and re-bills the turn); a
client-side-only queue (lost on reload, no cross-window consistency); injecting
mid-provider-call (a stream cannot accept a new user turn).

**ADR-021: An agent has a computer set.** A bot's `computers` is a capability
set (`["firecracker"]`, `["mac"]`, or both), not a single kind. The app's
right-column panels switch between the agent's computers; the agent's computer
tools (`shell`, `read_file`, `write_file`, `edit`, `grep`, `glob`, `list_dir`)
target its primary computer — the microVM when present, otherwise This Mac —
unless the call names another computer the agent has, in which case the call
runs there under that computer's own rules (a Mac call still honors `access`
and the approvals policy). The `computer` argument is only offered when the
agent has both, so single-computer agents keep the plain schema. `browser` and
`desktop` stay microVM-only and `web_search` stays host-side. A missing or
empty set means the microVM. The lead/worker parts of the earlier
capability-set design (the lead getting both, managers choosing a set, workers
inheriting it) were removed with ADR-026. Rejected: a separate tool name per
computer (doubles the tool surface and descriptions); defaulting an unspecified
set to This Mac (the microVM is the safe default); a silent fallback when a
call names a computer the agent lacks (the model should learn the real set).

**ADR-022: Workspaces map local projects; agents reference them by id.** The
daemon keeps a registry of local project folders — name, root, detected markers
(`.git`, `package.json`, `pnpm-workspace.yaml`, `Cargo.toml`, …), and an ignored
flag. Scan roots are user data, seeded from conventional developer folders and
editable in Settings → Workspaces; a scan walks them breadth-first, registers
marker directories, stops at a project root, skips build directories and
`node_modules`, and never follows symlinks. Discovery only proposes: a folder
becomes reachable when it is registered, and ignoring one keeps a scan from
re-adding it. An agent assigned a workspace roots its file tools and shell in
the project folder (still realpath-confined) instead of a managed scratch
folder; on the microVM the same workspace maps to `/root/projects/<slug>`.
A workspace also carries trusted shell command patterns: a
matching command runs without an approval card, while the built-in deny rules
and any ask rule still win, and file writes keep asking. Rejected: pointing
agents at raw paths (paths drift, no allowlist, nothing to show in the UI);
auto-assigning every discovered folder (agents would silently gain access to
unrelated repos); deleting the project folder on Start fresh (only the scratch
folder and the computer are rebuilt).

**ADR-023: Local reach is a per-agent grant, and OpenBot knows itself.** A This
Mac agent's `access` is `project` (its assigned folder, or a managed scratch
folder), `home`, or `full`. In a packaged
app macOS TCC is the real boundary — the app requests Documents/Desktop/
Downloads and the user grants Full Disk Access — while in a dev checkout the
terminal's permissions apply. Approvals remain the guardrail: every local action
still asks unless the workspace's trusted patterns or a policy rule allow it.
Separately, the daemon collects a `SelfInfo` (run mode, source and app paths,
version, git revision, launch command, data and database paths, check commands),
injects a compact `[self]` note into each agent's prompt, and exposes the detail
through a `system_info` tool, so an agent asked to work on OpenBot can ground
itself and explain how to restart or update it. Rejected: full access for every
agent (reach should be a deliberate grant); confinement as the only model (too
manual for a personal machine); the agent guessing its own install layout.

**ADR-024: Permissions are surfaced, and the daemon can restart itself.**
macOS gates Documents, Desktop, Downloads, and Full Disk Access behind TCC, and
the grant belongs to the app that launched the daemon (Terminal in development,
OpenBot once it runs as an app sidecar). Settings → Access probes each folder
and the TCC database on demand — a probe can raise the first-time system prompt;
a decided denial only changes in System Settings — shows the state, and
deep-links the matching Privacy pane. Nothing is probed at startup, so OpenBot
never prompts before the user asks. Separately, the `restart_daemon` tool lets
an agent apply its own code changes: the request is scheduled, the current turn
and running tasks settle, then the daemon exits — a `tsx watch` watcher is
nudged with a touch of its entry file, a packaged app restarts its sidecar, and
a manually started daemon re-execs itself detached. A guard file refuses more
than three restarts in ten minutes so a broken change cannot loop. Rejected:
probing permissions at startup (prompts without consent); restarting on every
source save in dev (the watcher already does, and it kills the turn); a silent
restart (the tool reports exactly what will happen).

**ADR-025: The packaged app ships the daemon as a sidecar.** A release build
bundles the daemon as a Node single-executable application
(`scripts/build-daemon-sidecar.mjs` bundles the entry with esbuild, injects it
into a copy of the Node runtime, and ad-hoc signs it) and lists it in
`bundle.externalBin`. The Tauri app starts it on launch and stops it on quit;
the daemon also watches its stdin pipe and parent pid, so it cannot outlive the
app even on a hard kill. Running the daemon as a child of OpenBot.app is what
makes macOS attribute TCC grants to OpenBot instead of Terminal — the app's
Info.plist carries the folder usage strings — and `system_info` reports the
bundle path. In development the daemon still runs from a terminal
(`OPENBOT_SIDECAR=1` forces the sidecar for a release-style test), and the
Tauri updater is wired but inert until a release channel sets a public key and
endpoints. Rejected: requiring Node on the user's machine (the SEA binary is
self-contained); launching the daemon as a detached process (TCC would credit
whoever started it, and quitting the app would leave it running).

**ADR-018 amendment: approvals can be remembered.** An ask-tier card offers
**Always allow** next to Approve and Deny. Approving with it writes a tool-level
policy rule (`match: "any"`, tier `auto`) and resolves the pending request, so
the tool stops asking. The rule is ordinary policy: deny rules
and more specific ask rules still win, and it can be edited or removed in the
policy editor. Rejected: a session-only memory (the user's intent is "stop
asking", not "stop asking today"); per-agent rules (the policy engine is global).

**ADR-017 amendment: memory and soul adapt automatically, but stay legible.**
The user asked for memory and soul to change over time without being told to,
so reflection is automatic: a background pass extracts durable memories from
new conversations, and the soul is rewritten once enough new memories
accumulate. The safety property is legibility rather than a manual gate —
every soul version is kept with its reason, the Memory panel shows what the
assistant believes with confidence and usage, and any memory or soul version
can be deleted or reverted in one click. Memory is per-agent: each agent owns
its own scope.

**ADR-017: One writer for memory, a versioned soul.** Each agent is the writer
of its own durable memory. Memory is typed (semantic, procedural, relational,
episodic), carries provenance (source), confidence, and
decay, and is reinforced when it proves useful. The soul is a bounded, versioned
constitution — voice, commitments, relationship — that the agent may update
with `update_soul`, so identity change is reviewable instead of
silent. Retrieval happens at turn time as a bounded, ID'd slice. Completion
audits may mark contradicted memories suspect instead
of leaving them stale. Rejected: a static soul file (a costume that never
develops); silent self-rewriting (no audit trail, alignment risk).

**ADR-026: One agent per thread.** The lead/worker runtime (one lead, project
managers, ephemeral workers, task grants, and Jev routing — ADR-014/015/016/019)
did not work out as a one-to-many product. OpenBot reverted to the original
Grok Bot model: every agent is an independent identity with exactly one thread,
its own computer set, one memory scope, and one soul, and nothing hands work
between agents. Agents can still run on This Mac via a registered workspace and a
per-agent access mode. Rejected: keeping the hierarchy (complexity without a
clear win); a middle-ground shared-memory model (reintroduces the identity
problem the revert removed).

**ADR-027: Routines are agent-owned scheduled spawns.** A routine is a brief
plus a schedule, pinned to one of the agent's computers. The daemon's
`RoutineService` fires due routines into the agent's thread: the brief is
persisted as a user message marked with a `routine` ref (id, name, run id) so
the transcript shows what triggered the turn, and the run is journaled in
`routine_runs`. Execution uses the routine's computer only while the agent
still has it (`botHasComputer`); if the grant is revoked, the routine is listed
as unavailable and its firings are journaled as skipped rather than run on the
other computer. An agent that is mid-turn is never interrupted: the firing
keeps its due time and retries on a later tick. The schedule is structural — an
interval (5 minutes to 7 days) or a daily local time — so there is no cron
parser. Runs on This Mac keep the agent's approval policy, so an unattended
routine can stall on an approval card until the policy timeout denies it.
Rejected: a per-routine model override (the agent's model is its identity);
cron expressions (surface area without a user need); firing once per granted
computer (double side effects); a dedicated thread per routine (the one-agent
model already gives each routine a home, and inline runs keep the surrounding
context).

**ADR-028: The todo list is durable, per-agent state shared by the user and the
agent.** Each agent owns one todo list that lives in SQLite, not in a thread:
items carry a status (`hold`, `working`, `waiting`, `done`), optionally hang
under a top-level parent as subtasks, and survive chats, restarts, and the
thread's clear. A subtask is a plain checklist item — done or not — because a
nested status is more bookkeeping than the work needs; every todo has a check
circle, and richer statuses belong to top-level tasks. The user edits the list in the app's right column (under the
screen, above routines); the agent reads and writes the same list through
`todo_list` and `todo_write`, which are host-side tools offered on either
computer and exempt from approval cards. A `TodoService` is the one writer, so
both paths share validation and every change is broadcast as the agent's full
list, keeping the UI and the next turn's `[todos]` note current. The thread's
ephemeral `update_plan` working plan stays separate: it is scoped to one task
and replaced each turn, while todos are the durable commitments. Rejected:
storing todos on the thread (the user's own items would vanish with a clear);
letting the agent replace the whole list (it would drop the user's items);
deeper nesting (one level covers subtasks without a tree UI).

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
