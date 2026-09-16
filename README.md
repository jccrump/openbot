# OpenBot

Open-source Grok Bot-style agents that each own a computer — a Firecracker
microVM or your Mac. Each agent can run commands, read and write files, drive a
real browser, and show you its screen, with every action gated behind an
approval you control. Bring any model: DeepSeek, OpenAI, OpenRouter, Groq, xAI,
Google, Mistral, or a local model through Ollama or LM Studio — plus an optional
Codex harness for ChatGPT subscription models.

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

- **Firecracker microVM** — an isolated Linux computer with its own kernel,
  filesystem, and browser profile. Requires the sandbox below.
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
`pnpm sandbox:spike` boots a microVM and verifies exec over vsock; `pnpm
sandbox:logs` shows the host service log; `pnpm sandbox:stop` shuts the VM down.

### Chat, approve, watch

Ask the agent something that requires its computer — "what OS are you running
on?" or "open Hacker News and take a screenshot". The agent streams its reply,
the app shows a tool card, and execution pauses on an **Approval needed** card
with the exact command and Approve/Deny buttons. Approved browser screenshots
appear in the chat and in the screen panel on the right, which always shows the
latest screenshot the agent captured. A toggle in Settings turns the approval
gate off for trusted work (local-Mac tools always ask).

### Codex harness (optional)

The agent's computer is also exposed as an MCP server, so the Codex CLI can use
its own harness — including ChatGPT subscription models:

```bash
pnpm codex:vm "open example.com, screenshot it, and tell me the top headline"
```

Any OpenAI-compatible model works through a local Responses-to-Chat-Completions
bridge, with an isolated `CODEX_HOME` so non-OpenAI providers can never touch a
ChatGPT login:

```bash
OPENBOT_UPSTREAM_BASE_URL=https://api.deepseek.com/v1 \
OPENBOT_UPSTREAM_API_KEY=$DEEPSEEK_API_KEY \
OPENBOT_UPSTREAM_MODEL=deepseek-v4-flash \
pnpm codex:vm "check what OS you're running on"
```

The same harness can be selected as the app's default in **Settings →
Harness** when the Codex CLI is on `PATH`.

## What works today

- **Chat** with streaming text and reasoning, message copy, per-agent threads
  with last-message previews, and agent search in the sidebar.
- **Providers** as user data: add/edit/remove/enable, presets for nine
  providers, "fetch models" from any OpenAI-compatible `/models` endpoint, and
  live rebuilds without restarting the daemon.
- **Agents**: create with name/role/avatar/color/model/computer, switch an
  existing agent between Firecracker and This Mac, single thread per agent.
- **Firecracker computers**: one microVM per agent with a persistent rootfs,
  booted on demand (~10 s cold, milliseconds warm), plus `shell`, `read_file`,
  `write_file`, and a `browser` tool (goto, click, type, text, screenshot,
  back, wait) with persistent cookies and sign-ins.
- **Local-Mac computers**: shell as your user and file tools confined to the
  agent's workspace, always approval-gated.
- **Approvals** for every tool call, with approve/deny cards and denied actions
  reported back to the model.
- **Screenshots** captured by the browser tool are persisted as artifacts,
  rendered in the chat, and shown in the screen panel.
- **Two harnesses**: the built-in OpenBot loop for any OpenAI-compatible model,
  and Codex driving the same VM over MCP.
- **Automatic conversation compaction** in the daemon when a thread approaches
  the model's context window, with an overflow retry path.
- **Themes**: light, dark, and follow-system, persisted per machine.
- **Offline development** with the mock model and mock sandbox, plus
  `pnpm typecheck` and an end-to-end `pnpm smoke`.

## What is not ready yet

Be honest with yourself about the following before filing issues:

- **The screen panel is the latest screenshot, not a live stream.** It updates
  only when the agent captures a browser screenshot.
- **Routines and the scheduler are not implemented.** The Routines section in
  the right panel is a labeled placeholder.
- **The Marketplace row is a placeholder** and is disabled.
- **Voice input and attachments are not implemented.** The mic and "+" buttons
  in the composer are disabled/labeled "coming soon".
- **Sharing is not implemented.** The share button is disabled; there is no URL
  scheme or link handling.
- **ChatGPT subscription mode is not verified end to end.** The in-app Codex
  harness path and the `pnpm codex:vm` MCP path exist, but the subscription
  flow has only been exercised manually. The Responses bridge is verified with
  the mock provider; tool calling with a real non-OpenAI provider still needs a
  key and a live test.
- **The browser tool only works on the microVM computer.** On This Mac it
  returns a clear error.
- **No per-bot egress allowlists.** Every microVM shares the host NAT; there is
  no firewall policy per agent.
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
8. **Live screen view** instead of the latest-screenshot panel.
9. **macOS Keychain** for provider keys.
10. **Mobile thin client** over Tailscale or a Cloudflare Tunnel.

The detailed design, protocol, data model, and decision log live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```bash
pnpm typecheck     # all packages
pnpm smoke         # end-to-end daemon test with a mock model and mock sandbox
pnpm sandbox:spike # boot a microVM and verify exec over vsock
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
