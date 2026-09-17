# OpenBot

Open-source Grok Bot-style agents that each own a computer — a Firecracker
microVM or your Mac. Each agent can run commands, read and write files, drive a
real browser, and show you its screen, with every action gated behind an
approval you control. Bring any model: DeepSeek, OpenAI, OpenRouter, Groq, xAI,
Google, Mistral, or a local model through Ollama or LM Studio. The built-in
OpenBot harness is the primary path; an optional, experimental Codex harness can
bring your ChatGPT subscription or drive non-OpenAI models through the local
responses bridge.

> **Status: early alpha.** The core loop works end to end on macOS Apple
> Silicon, but this is a rough-edged first release. Read
> [What is not ready yet](#what-is-not-ready-yet) before you invest time.

## Screenshots

| Chat with a computer | Browser automation + screen |
| --- | --- |
| ![Chat with a Computer tool card](docs/screenshot-chat.png) | ![Browser tool with a screenshot and the screen panel](docs/shell-light.png) |

| Create an agent and pick its computer | Running on This Mac |
| --- | --- |
| ![New agent modal with Firecracker and This Mac choices](docs/create-agent-computer.png) | ![A tool card from a This Mac agent](docs/local-tool-card.png) |

| Browser automation (dark) | Providers |
| --- | --- |
| ![Dark mode browser tool with a screenshot](docs/shell-dark.png) | ![Providers settings](docs/settings-providers.png) |

| Provider logos (light) | Provider logos (dark) |
| --- | --- |
| ![Provider logos in light mode](docs/logos-providers-light.png) | ![Provider logos in dark mode](docs/logos-providers-dark.png) |

| Light theme | Dark theme |
| --- | --- |
| ![Light chat and settings](docs/theme-light-chat.png) | ![Dark chat and settings](docs/theme-dark-chat.png) |

| Dark settings | Light settings |
| --- | --- |
| ![Dark settings](docs/theme-dark-settings.png) | ![Light settings](docs/theme-light-settings.png) |

| Thinking indicator (light) | Thinking indicator (dark) |
| --- | --- |
| ![Typing dots while the model thinks, light theme](docs/typing-light.png) | ![Typing dots while the model thinks, dark theme](docs/typing-dark.png) |

| Agent settings menu |
| --- |
| ![Computer switcher menu on a sidebar agent](docs/agent-settings-menu.png) |

## Quickstart

### Prerequisites

- macOS on Apple Silicon. The sandbox needs nested virtualization, which means
  an M3 or newer; M1/M2 Macs can still run chat and the local-Mac computer mode.
- Node.js 22.9 or newer and pnpm 11 or newer.
- [Lima](https://lima-vm.io) for bot computers: `brew install lima`.
- Optional: Rust (rustup) and the Xcode command line tools for the native
  Tauri window.
- Optional: the [Codex CLI](https://github.com/openai/codex) for the Codex
  harness.

### Install and run

```bash
git clone https://github.com/jccrump/openbot.git
cd openbot
pnpm install
```

Terminal 1 — the daemon:

```bash
pnpm dev:daemon
```

Terminal 2 — the app:

```bash
pnpm dev:mac     # native window (first run compiles Rust)
# or
pnpm dev:app     # browser at http://localhost:1420
```

No API key yet? Run the offline stack instead: `pnpm mock:model` in one
terminal and `pnpm dev:daemon:mock` in another. The mock model answers chat and
calls the shell tool when a message starts with `run:`.

### Add a provider

Open Settings (gear icon, bottom left) and go to **Providers**. Pick a preset
(DeepSeek, OpenAI, OpenRouter, Groq, xAI, Google, Mistral, Ollama, LM Studio),
paste an API key or point at an environment variable, press **Fetch models**,
and save. Keys typed into the app are stored in the daemon's SQLite database
inside a `0700` data directory with the file at `0600`; env-var references keep
the key out of the database entirely. See `.env.example` for the headless path.

### Create an agent

Press the **+** next to the sidebar search. Give it a name, optional role,
avatar, and color, pick a model, and choose its computer:

- **Firecracker microVM** — an isolated Linux computer with its own kernel and
  filesystem, plus a persistent per-agent browser profile presented in the same
  live desktop. Requires the sandbox below.
- **This Mac** — commands run directly on your Mac as your user, restricted to
  the agent's workspace for file tools, and always approval-gated.

### Set up the sandbox (bot computers)

Chat works without this; the shell, file, and browser tools appear once the
sandbox host is reachable.

```bash
pnpm sandbox:start    # boot the Lima VM with nested virtualization
pnpm sandbox:setup    # download Firecracker + kernel/rootfs, bake the guest agent
pnpm sandbox:deploy   # bundle the sandbox host service and start it in the VM
```

The first `setup` downloads a kernel and rootfs and takes a few minutes.
Run `sandbox:setup` again after guest-agent or desktop changes. It stamps the
base image with a content version; the next cold boot upgrades older agent
images while preserving `/root`, `/home`, `/srv`, and workspace directories.
The per-agent Chromium profile is stored beside the VM image, and the newest
prior image is kept as a compressed recovery artifact.
`pnpm sandbox:spike` boots a microVM and verifies exec over vsock; `pnpm
sandbox:logs` shows the host service log; `pnpm sandbox:stop` shuts the VM down.

### Chat, approve, watch

Ask the agent something that requires its computer — "what OS are you running
on?" or "open Hacker News and take a screenshot". The agent streams its reply,
the app shows a tool card, and execution pauses on an **Approval needed** card
with the exact command and Approve/Deny buttons. Approved browser screenshots
appear in the chat, while the screen panel on the right shows the live desktop
and falls back to the latest captured screenshot if VNC is unavailable. A
toggle in Settings turns the approval gate off for trusted work (local-Mac
tools always ask).

OpenBot keeps the live desktop connection warm while its window is unfocused,
but holds framebuffer update requests and disables input until the window is
active again. This avoids reconnect latency without letting an old tab quietly
consume the agent's CPU or make takeover input lag.

### Codex harness (optional, experimental)

The OpenBot loop is the default and the primary way agents run. The Codex
harness is a bring-your-own alternative: the agent's computer is also exposed as
an MCP server, so the Codex CLI can use its own harness — including ChatGPT
subscription models:

```bash
pnpm codex:vm "open example.com, screenshot it, and tell me the top headline"
```

Codex can also drive any OpenAI-compatible model through the local
Responses-to-Chat-Completions bridge (`packages/responses-bridge`), which maps
Responses API items onto Chat Completions (`developer` → `system`, reasoning
summaries → `reasoning_content` for thinking models, tool calls and outputs
preserved) so DeepSeek and similar providers accept the transcript:

```bash
OPENBOT_UPSTREAM_BASE_URL=https://api.deepseek.com/v1 \
OPENBOT_UPSTREAM_API_KEY=$DEEPSEEK_API_KEY \
OPENBOT_UPSTREAM_MODEL=deepseek-flash \
pnpm codex:vm "check what OS you're running on"
```

Non-OpenAI providers always run with an isolated `CODEX_HOME` that has no
`auth.json`, so a ChatGPT login can never be used (or quota spent) for them. The
same harness can be selected as the app's default in **Settings → Harness**
when the Codex CLI is on `PATH`.

## What works today

- **Chat** with streaming text, a three-dot typing bubble while the model is
  thinking (reasoning is hidden by default), message copy, per-agent threads
  with last-message previews, and agent search in the sidebar.
- **Providers** as user data: add/edit/remove/enable, presets for nine
  providers, "fetch models" from any OpenAI-compatible `/models` endpoint, and
  live rebuilds without restarting the daemon.
- **Agents**: create with name/role/avatar/color/model/computer, switch an
  existing agent between Firecracker and This Mac, single thread per agent.
- **Firecracker computers**: one microVM per agent with a versioned rootfs,
  persistent agent files and a per-agent Chromium profile, plus `shell`, `read_file`,
  `write_file`, and a `browser` tool (goto, click, type, text, links, screenshot,
  back, wait). Browser actions return bounded page text so models can collect
  evidence without a separate read after every navigation.
- **Local-Mac computers**: shell as your user and file tools confined to the
  agent's workspace, always approval-gated.
- **Approvals** for every tool call, with approve/deny cards and denied actions
  reported back to the model.
- **Live shared browser desktop** through Xvfb, Openbox, x11vnc, and noVNC.
  Model browser actions and user takeover operate the same Chromium session;
  browser-tool screenshots are also persisted as chat artifacts.
- **Two harnesses**: the built-in OpenBot loop (primary, default, any
  OpenAI-compatible model) and the optional Codex harness driving the same VM
  over MCP — with a ChatGPT subscription or a non-OpenAI model through the
  responses bridge.
- **Automatic conversation compaction** in the daemon when a thread approaches
  the model's context window, with an overflow retry path.
- **Completion-driven tool tasks** with no fixed round/action count. Runs stop
  when the model returns its answer or the user cancels; per-operation timeouts
  and honest failure recovery contain actual stalls without cutting off useful
  research.
- **Evidence-grounded browser completion**: browser results receive stable
  observation IDs and source-quality labels. A browser-backed draft is held
  until a separate completion audit checks the original request, exact-source
  support, and honest unknowns; failed drafts go back to the same agent for
  more research or revision instead of reaching chat as confident guesses.
- **Themes**: light, dark, and follow-system, persisted per machine.
- **Offline development** with the mock model and mock sandbox, plus
  `pnpm typecheck` and an end-to-end `pnpm smoke`.
- **Deterministic real-model evaluations** for research quality, grounding,
  provenance, recovery, latency, tool use, and token cost. See
  [`evals/README.md`](evals/README.md) for the file-based pre/post-change
  workflow.

## What is not ready yet

Be honest with yourself about the following before filing issues:

- **Image upgrades preserve the supported durable paths, not arbitrary system
  mutations.** Files under `/root`, `/home`, `/srv`, and the workspace
  directories migrate; hand-edited files elsewhere in the guest OS may be
  replaced by the new base. Only the newest compressed recovery image is kept.
- **Routines and the scheduler are not implemented.** The Routines section in
  the right panel is a labeled placeholder.
- **The Marketplace row is a placeholder** and is disabled.
- **Voice input and attachments are not implemented.** The mic and "+" buttons
  in the composer are disabled/labeled "coming soon".
- **Sharing is not implemented.** The share button is disabled; there is no URL
  scheme or link handling.
- **The Codex harness is experimental, and its ChatGPT subscription mode is not
  verified end to end.** The in-app Codex path and the `pnpm codex:vm` MCP path
  exist, but the subscription flow has only been exercised manually with a real
  plan. The responses bridge path is verified end to end against a real
  DeepSeek key, including a tool call executed in the microVM; the ChatGPT
  quota-isolation rule (isolated `CODEX_HOME` for non-OpenAI providers) is
  covered by code and by that run, not by an automated test.
- **Reasoning is hidden.** The daemon still streams `chat.reasoning`, but the UI
  intentionally renders only a three-dot typing bubble; there is no setting to
  show thinking yet.
- **The browser tool only works on the microVM computer.** On This Mac it
  returns a clear error.
- **No per-bot egress allowlists.** Every microVM shares the host NAT; there is
  no firewall policy per agent.
- **Browser and compute isolation are split.** Shell and file tools run in the
  per-agent Firecracker microVM. Chromium runs as a per-agent unprivileged Linux
  account with Chromium's sandbox enabled in the shared outer Lima VM so nested
  virtualization cannot stall its timers. Profiles are separate, but browsers
  do not have a separate kernel per agent.
- **No snapshots, restore, or pause/resume.** VMs are booted fresh and keep
  their rootfs, but there is no snapshotting.
- **No multi-user support.** The daemon binds `127.0.0.1` and trusts the local
  user; there is no auth layer.
- **No mobile app.** Mac-first; mobile is a later thin client.
- **No multi-agent collaboration.** No group chats, mentions, subagent
  handoffs, or shared memory — each agent is independent.
- **No memory.** Beyond thread history and compaction summaries, agents do not
  remember anything across threads.
- **No approvals inbox or policy engine.** Approvals are inline cards only, with
  one global toggle.
- **No API keys in the macOS Keychain.** Keys live in the SQLite database
  (`0600`) or in environment variables.
- **Single thread per agent.** There is no new-chat button, and thread search
  does not exist (sidebar search filters agents).
- **No message editing or regeneration**, no file uploads, and no Windows or
  Linux desktop app.

## Roadmap

1. **Multi-bot runtime** — DMs, group threads, mentions, handoffs, a shared
   team scope, and a "chief of staff" pattern.
2. **Routines** — record a trajectory, parameterize it, schedule it or trigger
   on events.
3. **Memory** — per-agent episodic log plus vector search in SQLite.
4. **Approvals policy engine** — auto/ask/deny tiers per tool and action, with
   an approvals inbox.
5. **Codex SDK provider** — ChatGPT sign-in inside the daemon with
   `@openai/codex-sdk`, mapping its stream into the OpenBot protocol.
6. **Snapshots and restore** for microVMs, plus pause/resume.
7. **Per-bot egress allowlists** and a real base image with Node, Python, and
   Chrome/Playwright.
8. **macOS Keychain** for provider keys.
9. **Mobile thin client** over Tailscale or a Cloudflare Tunnel.

The detailed design, protocol, data model, and decision log live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Research notes on how production
computer-use agents work — vision versus text versus hybrid, and what makes them
fast — live in [docs/research/computer-use.md](docs/research/computer-use.md).

## Development

```bash
pnpm typecheck     # all packages
pnpm smoke         # daemon test, including an RFB framebuffer through the proxy
pnpm sandbox:spike # boot a microVM and verify exec over vsock
pnpm vnc:smoke -- ws://127.0.0.1:4170/bots/<bot-id>/vnc
                   # negotiate RFB and read a real framebuffer rectangle
```

Layout:

- `apps/mac` — Tauri v2 + React desktop app
- `packages/core` — daemon: agents, threads, agent loop, tools, approvals,
  compaction, harnesses
- `packages/gateway` — model providers (OpenAI-compatible streaming client)
- `packages/sandbox` — sandbox host service (runs in the Lima VM) and client
- `packages/mcp` — MCP server exposing the computer's tools to Codex
- `packages/responses-bridge` — Responses API to Chat Completions bridge
- `packages/protocol` — shared Zod schemas for the daemon/UI protocol
- `docs/research` — background research on production computer-use agents

## Security

Single-user by design. The daemon binds `127.0.0.1` only, bot computers are
isolated microVMs, API keys live in the data directory (`0600` inside a `0700`
directory) or your environment, and commands require approval by default. The
sandbox is a real boundary: the model can only touch its own microVM. Local-Mac
agents are the exception — they run as you, restricted to their workspace for
file tools, and always require approval. There is no per-bot network policy yet,
so treat microVMs as sharing one network with your Mac.

## License

MIT — see [LICENSE](LICENSE).
