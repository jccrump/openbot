# External agent benchmarks: survey and adoption notes

Research snapshot (September 2026) of public benchmarks we could use to measure
OpenBot's coding, browser, and computer-use ability, plus notes on what can run
on a Mac today. Sources are linked inline; sizes and grading are from the
official pages at the time of writing.

## Coding

| Benchmark | Size | Grading | Infra | Notes |
|---|---|---|---|---|
| [SWE-bench](https://www.swebench.com/) | 2,294 full / 500 Verified / 300 Lite / 300 Multilingual / 480 Multimodal | Apply patch, run repo tests (fail-to-pass + pass-to-pass) | Docker per instance; official harness | The leaderboard standard. Verified is the usual target. Heavy to run at home |
| [Terminal-Bench](https://github.com/laude-institute/terminal-bench) ([tbench.ai](https://www.tbench.ai)) | ~100 beta | Per-task test script + oracle solution | Docker; `tb` CLI; Apache-2.0 | Shell-in-a-container tasks; best structural fit for OpenBot's computer agent. New Harbor framework runs Terminal-Bench 2.0 |
| [Aider polyglot](https://aider.chat/docs/leaderboards/) | 225 Exercism exercises across C++, Go, Java, JavaScript, Python, Rust | Run exercise tests | Local language runtimes, no Docker | Cheapest strong coding signal. DeepSeek-V3.2 scored 74.2% for ~$1.30 total. Dataset: [Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark) |
| [Commit0](https://commit-0.github.io/) | 57 Python libraries built from scratch | Unit tests | pip package; Docker or Modal backend | Long-horizon; aider-only agent adapter today |
| [Multi-SWE-bench](https://github.com/multi-swe-bench/multi-swe-bench) | 1,632 instances, 7 languages | Repo tests | Docker | Good non-Python coverage |
| [SWE-Lancer](https://github.com/openai/SWELancer-Benchmark) | 1,400+ Upwork tasks ($1M payouts) | End-to-end tests | Docker | Expensive; economics-style scoring |
| [MLE-bench](https://github.com/openai/mle-bench) | 75 Kaggle competitions | Leaderboard medals | Docker, often GPU | ML engineering, not general coding |
| [SWT-Bench](https://github.com/logic-star-ai/swt-bench) | ~1,900 test-generation tasks | Generated tests | Docker | Tests generation from issues |
| [BigCodeBench](https://bigcode-bench.github.io/) / [LiveCodeBench](https://livecodebench.github.io/) | 1,140 / rolling | Unit tests | Local | Function-level and contamination-free; not agentic |

Also on the SWE-bench site: ProgramBench (May 2026, build software from
scratch), CodeClash (Nov 2025, goal-oriented development), SWE-smith
(training-data generation).

## Browser / web

| Benchmark | Size | Grading | Infra | Notes |
|---|---|---|---|---|
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) | 812 verified / 258-task hard subset | Deterministic, type-aware; offline evaluation from answer + HAR network trace | Docker site images (Docker Hub), `pip`/`uvx` CLI | Best fit: evaluate our Chromium's own traffic. Successor to WebArena's LLM-judge scoring |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) + [AgentLab](https://github.com/ServiceNow/AgentLab) | Hub: MiniWoB, WebArena, WebArena-Verified, VisualWebArena, WorkArena, AssistantBench, WebLINX, OpenApps, TimeWarp | Per-benchmark | `pip install browsergym`, Playwright | Best hub if we implement an AgentLab agent adapter |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | 100+ synthetic tasks | Deterministic reward | Selenium/Chrome or BrowserGym; MIT | Easiest to start; maintenance mode; simple tasks |
| [Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web) | 300 tasks, 136 live sites | WebJudge-7B / o4-mini judge (85.7% human agreement) | Live web; CC-BY data | Real-web signal; flaky, judge-based |
| [WebArena](https://webarena.dev/) | 812 | Programmatic + LLM judge | Self-hosted Docker sites | Prefer WebArena-Verified today |
| [VisualWebArena](https://jykoh.com/vwa) | 910 | Programmatic | Docker + vision | Multimodal variant |
| [GAIA](https://huggingface.co/datasets/gaia-benchmark/GAIA) | 466 (165 validation) | Exact match | Live web + tools; gated | Hard, multi-tool reasoning |
| [BrowseComp](https://openai.com/index/browsecomp/) | 1,266 | Exact match | Live web; encrypted dataset | Very hard browsing |
| [AssistantBench](https://assistantbench.github.io/) | 214 | Exact match | Live web | Time-consuming realistic tasks |
| [WorkArena](https://github.com/ServiceNow/WorkArena) / WorkArena++ | 29 tasks / 682 | Programmatic | ServiceNow instance | Enterprise workflows |

## Computer use and tool use

| Benchmark | Size | Grading | Infra | Notes |
|---|---|---|---|---|
| [OSWorld / OSWorld-Verified](https://os-world.github.io/) | ~369 Ubuntu desktop tasks | Post-state scripts | VMware, VirtualBox, Docker+KVM, Modal, Daytona, AWS; Apache-2.0 | pyautogui-style actions + screenshots. Needs KVM or cloud; macOS hosts excluded |
| [TheAgentCompany](https://the-agent-company.com/) | 175 tasks | Deterministic + LLM evaluators | Docker, host networking, 30+ GB; MIT | Simulated company (GitLab, ownCloud, Plane, RocketChat); coding + browsing + chat |
| [τ²/τ³-bench](https://github.com/sierra-research/tau2-bench) | Airline, retail, banking, voice | Database state checks + simulated user | Pure Python + API calls | Tool-agent-user interaction; cheap; tests policy compliance |
| [AgentBench](https://github.com/THUDM/AgentBench) | 8 environments | Per-environment | Docker | Older but broad |

Frameworks: [inspect-ai](https://inspect.aisi.org.uk/) (custom solvers,
OpenAI-compatible endpoints), [HAL](https://github.com/princeton-pli/hal-harness)
(Princeton, runs SWE-bench/GAIA), AgentLab (web), OpenHands evaluation harness.

## What runs on a Mac today

- **Native, no Docker**: Aider polyglot (needs language runtimes; this machine
  has Python 3.9, Node 22, Java 17 — no Go/Rust yet), τ²-bench, MiniWoB++,
  Online-Mind2Web / GAIA / BrowseComp (internet + judge model).
- **Docker Desktop**: WebArena-Verified sites (shopping/reddit/gitlab/CMS are
  light; wikipedia/map need multi-GB downloads), Terminal-Bench, TheAgentCompany
  (host networking, 30+ GB). x86_64 images are emulated on Apple Silicon.
- **Not on macOS**: OSWorld (needs KVM; use Modal/Daytona/AWS, or a Linux host).
- **Integration wrinkle**: OpenBot's agent lives in its microVM, so benchmark
  sites running on the Mac must be reachable at the Mac's LAN IP (or run the
  sites inside the Lima VM and allow that host in the egress policy).

## Adoption plan

1. Aider polyglot (Python first) — cheap, deterministic, runs today.
2. WebArena-Verified hard subset — capture HAR from the agent's Chromium and
   submit answer + trace to its evaluator.
3. Terminal-Bench via a Harbor agent adapter — closest to OpenBot's computer.
4. SWE-bench Verified and OSWorld later, on a cloud Linux host.

## What we have run

### Aider polyglot — `scripts/polyglot-eval.mjs`

Drives the real daemon with a real model against a "This Mac" bot per exercise:
the exercise is copied into the bot's workspace, the bot is asked to make the
tests pass, and the tests are then run on the host to grade.

```bash
pnpm polyglot:eval -- --limit 5 --label sample
pnpm polyglot:eval -- --exercise proverb,wordy
pnpm polyglot:eval -- --list
```

Baseline (2026-09-18, `deepseek-flash`): **34/34 Python exercises passed**,
341 tool calls (25 failed), 2.87M tokens, 17.7 minutes. Result files:
`evals/results/*-polyglot-python-full.{json,md}`.

### In-repo browser eval — `pnpm eval`

Deterministic browser/research scenarios with a fixture sandbox and the real
model. Post-harness pass (2026-09-18, `deepseek-flash`): **8/8 strict pass**,
100% average score, 317s wall time.

### WebArena-Verified setup notes

- 812 tasks; 324 use only `AgentResponseEvaluator` and need **no HAR**; the
  other 488 also need `NetworkEventEvaluator` (capture the agent browser's HAR).
- Run logs live at `<output-dir>/<task_id>/agent_response.json` with
  `{ task_type, status, retrieved_data, error_details }`; grade with
  `webarena-verified eval-tasks --output-dir <dir> --config <config>`.
- `agent-input-get --config` renders `__SHOPPING__`-style URLs for the agent.
- Site images: `am1n3e/webarena-verified-<site>` (shopping 7770, shopping_admin
  7780, reddit 9999, gitlab 8023).
- Blocked on this Mac (2026-09-18): the host data volume is 99% full (~12 GB
  free), so Docker cannot extract the shopping image. Free disk or run on a
  cloud/Linux host first.
- The microVM must reach the sites at the Mac's LAN IP (e.g.
  `http://192.168.1.124:7770`), not `localhost`.
