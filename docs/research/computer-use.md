# How ChatGPT's Computer Use Works

Research notes on how OpenAI's computer-use agents see screens, decide, and act —
and what makes them fast. Written to inform OpenBot's browser and harness design,
not as a survey of the whole GUI-agent field.

Last updated: 2026-09-16.

## TL;DR

- **It is hybrid, but the split is layered.** Vision is the grounding layer
  (screenshots → where to click); text and code are the execution layer (DOM,
  accessibility tree, shell, Playwright). OpenAI started pure-vision, then added
  text channels where pixels are unreliable.
- **Quality comes from training, not scaffolding.** Supervised learning on human
  demonstrations teaches clicking; reinforcement learning teaches recovery and
  adaptation. Grounding is now near-solved at the frontier
  (ScreenSpot-Pro 92.7% with no tools).
- **Speed comes from collapsing the loop.** The biggest lever is not a faster
  model — it is replacing N screenshot→click round trips with one code call that
  performs many actions. OpenAI's own API docs now recommend a code-execution
  harness over the step-by-step `computer` tool.
- **The residual risks are prompt injection and mistakes, not capability.**
  OpenAI's post-mitigation prompt-injection susceptibility was 23%, with a
  monitor model at 99% recall and user confirmations cutting mistake risk ~90%.
  Layering matters more than any single defense.

## Three generations

| Generation | Product | Perception | Action | Notable results |
| --- | --- | --- | --- | --- |
| Jan 2025 | Operator (CUA) | Screenshots only; no DOM, accessibility tree, or OS APIs | Virtual mouse and keyboard | OSWorld 38.1%, WebArena 58.1%, WebVoyager 87% (self-reported) |
| Jul 2025 | ChatGPT agent | Visual browser + text browser + terminal + connectors | Model picks the cheapest path per step | HLE 41.6, BrowseComp 68.9%, SpreadsheetBench 45.5 with direct `.xlsx` editing |
| 2026 | GPT-6 Astra / ChatGPT Work | Screenshots + ARIA/DOM + headless Chrome | Playwright/PyAutoGUI code execution | OSWorld 2.0 72.6% in ~40 min/task, ScreenSpot-Pro 92.7% no tools |

Sources: [Computer-Using Agent](https://openai.com/index/computer-using-agent/),
[ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/),
[GPT-6 Astra](https://openai.com/index/gpt-6-astra/),
[computer use docs](https://platform.openai.com/docs/guides/tools-computer-use).

The through-line: every generation kept pixels as the universal interface and
added text channels for the cases where pixels are lossy — reading long content,
typing precise strings, running commands, editing code. The
[Operator System Card](https://openai.com/index/operator-system-card/) is
explicit that pure vision hurt the model on terminal work and on OCR of
random-looking strings like API keys and DNA sequences. The hybrid turn was a
fix for observed failures, not a philosophical choice.

## Image, text, or hybrid?

The honest answer depends on which layer you are asking about.

**Perception is image-based at the core.** CUA "processes raw pixel data" and
acts through a virtual mouse and keyboard, with no OS- or web-specific APIs. The
stated reason is generality: the long tail of software has no agent-friendly
interface, and a universal screen/cursor/keyboard action space reaches all of
it. This is also true of competitors — Anthropic's computer use is
screenshot-only, and Gemini 2.5 Computer Use takes a screenshot plus a history
of recent actions and the current URL.

**The current system is hybrid in observation and action.** ChatGPT agent's
toolbox is a visual browser, a text-based browser for reasoning over page
content, a terminal, and direct API access through connectors. OpenAI's framing
is that the model "can choose the optimal path to most efficiently perform
tasks." By 2026, ChatGPT Work drives a full headless Chrome instance and runs
JavaScript against the DOM — Simon Willison documented Playwright evaluation,
a persistent `/workspace` filesystem, sub-agents, and a tool catalog of roughly
223 tools and 44 skills, including a `control-browser` skill. OpenAI's own
developer FAQ for Atlas says the agent "uses ARIA tags — the same labels and
roles that support screen readers — to interpret page structure and interactive
elements," and recommends publishers follow WAI-ARIA best practices.

**The research agrees that hybrid grounding wins on the web.** SeeAct found that
the best grounding strategy for a GPT-4V web agent "leverages both the HTML
structure and visuals," and that Set-of-Mark prompting alone — overlaying
numbered marks on interactive regions — was not effective for web agents. The
broader lesson: text representations are cheap, precise, and brittle; pixels are
expensive, fuzzy, and general. Production systems use both and route between
them.

## Why it's good

- **Two-stage training.** Supervised learning on specialized data and human
  trainer demonstrations teaches base perception and input control; RL then adds
  reasoning, error correction, and adaptation to unexpected events
  ([Operator System Card](https://openai.com/index/operator-system-card/)).
- **Reasoning inside the loop.** CUA's "inner monologue" chain-of-thought
  evaluates observations, tracks intermediate steps, and self-corrects. CUA also
  shows test-time scaling: more allowed steps means higher success.
- **Grounding is the bottleneck, and it got solved.** GPT-6 Astra scores 92.7%
  on ScreenSpot-Pro with no tools. Most perceived "agent quality" is really
  click accuracy — fewer misses means fewer retry loops and less drift.
- **Iterative training from its own traces.** UI-TARS showed that an
  end-to-end native vision agent can beat wrapped commercial models by
  collecting, filtering, and reflectively refining interaction traces on
  hundreds of virtual machines ([UI-TARS](https://arxiv.org/abs/2501.12326)).
- **Representation alignment matters more than scaffolding.** AgentOccam gained
  26.6 points on WebArena (+161%) over comparable plain agents just by tuning
  the observation and action space, with no new agent roles or search
  ([AgentOccam](https://arxiv.org/abs/2410.13825)).

## Why it's fast

Seven levers, roughly in order of impact.

1. **Code execution collapses the loop.** The current API docs recommend giving
   the model a function tool that accepts a script (`exec_py` with PyAutoGUI,
   `exec_js` with Playwright) instead of the structured `computer` tool: "One
   call can combine actions, loops, or conditional logic." One model turn now
   does what used to be N screenshot→click round trips. This is the single
   biggest latency win in the stack.
2. **Batched actions per turn.** Even the legacy `computer` tool returns an
   ordered `actions` array — a `click` followed by a `type` in one call — rather
   than one action per model response.
3. **Observation budget discipline.** Send the current screenshot plus a short
   history of recent actions, not the full image history. Keep images in memory,
   request `detail: "original"` to preserve resolution, and map coordinates back
   when downscaling. Gemini's documented loop is exactly this: screenshot,
   recent actions, URL, repeat.
4. **Model and harness efficiency.** GPT-6 Astra scores 72.6% on OSWorld 2.0 in
   about 40 minutes per task, versus 65.7% in about 75 minutes for the previous
   model — roughly 47% less time per task. The updated Codex harness delivers a
   1.9x faster Mind2Web run. On Agents' Last Exam, Astra used roughly 65% fewer
   output tokens than Claude Opus 5 at top settings, and the API offers a fast
   mode at 2x speed for 2x price.
5. **Tool routing.** Prefer APIs, connectors, and text extraction when they can
   answer the question; reserve the visual browser for interfaces that only
   exist as pixels.
6. **Parallelism.** OpenAI ran up to eight attempts at once for HLE and picked
   the highest-confidence result (41.6 → 44.4). ChatGPT Work runs sub-agents in
   parallel.
7. **Harness-side overhead still matters.** Per-action cost is not just model
   inference: screenshot capture, CDP round trips, and serialization add up.
   OpenBot's own browser daemon already reflects this — a persistent CDP
   connection keeps later actions at 2–8 s versus 15–25 s for first navigation
   after boot (see [ARCHITECTURE.md](../ARCHITECTURE.md), Sandbox).

Independent context: Browserbase measured Gemini 2.5 Computer Use at the best
accuracy/latency frontier of its time — about 225 seconds per task at 70%+
accuracy on Online-Mind2Web — after roughly 4,000 browser hours of evaluation.
That is the shape of the problem: even the fast option is minutes per task, and
per-step overhead dominates.

## What the research says

Annotated starting points.

- [Computer-Using Agent](https://openai.com/index/computer-using-agent/) —
  OpenAI's CUA announcement: pixel perception, inner monologue, benchmark
  numbers, and the safety layering.
- [Operator System Card](https://openai.com/index/operator-system-card/) — the
  most useful OpenAI document for builders. SL + RL training, OCR and terminal
  failure modes, prompt-injection numbers, confirmation recall, watch mode.
- [ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/) — the
  hybrid toolbox and the "optimal path" framing; terminal with limited network
  access.
- [GPT-6 Astra](https://openai.com/index/gpt-6-astra/) — current capability and
  efficiency numbers, the OSWorld 2.0 time comparison, and the fast-mode
  pricing.
- [Computer use API guide](https://platform.openai.com/docs/guides/tools-computer-use) —
  the actual loop: code execution versus `computer` tool, batched actions,
  screenshot handling, state preservation, safety guidance.
- [Gemini 2.5 Computer Use](https://blog.google/technology/google-deepmind/gemini-computer-use-model/) —
  the low-latency alternative and its per-step safety service.
- [Claude computer use](https://www.anthropic.com/news/3-5-models-and-computer-use) —
  the original public beta; useful for the historical baseline (OSWorld 14.9%
  screenshot-only, 22.0% with more steps in 2024).
- [SeeAct](https://arxiv.org/abs/2401.01614) — GPT-4V as a web agent; HTML +
  visuals beat Set-of-Mark alone for grounding.
- [Set-of-Mark](https://arxiv.org/abs/2310.11441) — visual prompting with
  numbered regions; the canonical grounding aid for weaker vision models.
- [AgentOccam](https://arxiv.org/abs/2410.13825) — observation/action space
  alignment as the highest-leverage change.
- [UI-TARS](https://arxiv.org/abs/2501.12326) — end-to-end native GUI agent
  with System-2 reasoning and iterative training from reflective traces.
- [OSWorld](https://arxiv.org/abs/2404.07972) and
  [WebArena](https://arxiv.org/abs/2307.13854) — the benchmarks, with human
  baselines.
- [GUI agent survey](https://arxiv.org/abs/2411.18279) — taxonomy of frameworks,
  data, training, and evaluation if a broader sweep is needed.
- [Simon Willison: Understanding ChatGPT Work](https://simonwillison.net/2026/Aug/30/understanding-chatgpt-work/) —
  independent teardown of the current product: headless Chrome, Playwright,
  persistent filesystem, sub-agents, and the 223-tool catalog.
- [Browserbase evaluation](https://www.browserbase.com/blog/evaluating-browser-agents) —
  independent, reproducible latency/accuracy comparisons across providers.

**Benchmark hygiene.** Do not compare numbers across versions. OSWorld v1
(human 72.4%) and OSWorld 2.0 are different suites; WebArena and WebVoyager
numbers are mostly self-reported; live-web tasks like WebVoyager's go stale as
sites change. Browserbase's point stands: if everyone quietly prunes different
tasks, the benchmark stops being a benchmark.

## What this means for OpenBot

Candidate directions, mapped to what already exists. None of this is
implemented; it is input for M2/M3 work and the roadmap.

1. **Batch browser actions or add a code-execution tool.** The `browser` tool
   takes one action per call (`goto`, `click`, `type`, `text`, `screenshot`,
   `back`, `wait`), and each call costs a model round trip plus an approval.
   Accepting an action list, or adding a Playwright-style script tool that runs
   against the existing persistent CDP session in the browser daemon, is the
   biggest available speed lever. A script preview could keep the approval
   meaningful: approve the code, not each click.
2. **Add text observations alongside screenshots.** The browser daemon already
   speaks CDP, which exposes the DOM and the accessibility tree for free. A
   compact text view of interactive elements — role, name, value — sent with the
   screenshot mirrors what OpenAI ships (ARIA in Atlas) and matters more for
   OpenBot because it is model-agnostic. Most open models ground pixels worse
   than frontier models; text closes part of that gap.
3. **Budget observations explicitly.** Send the latest screenshot plus a short
   action history; do not accumulate screenshots in provider history. OpenBot's
   compaction keeps context bounded, but images are the most expensive tokens in
   the loop. If screenshots are downscaled, map coordinates back before
   executing.
4. **Bias the loop toward cheap tools.** Shell with `curl` and text extraction
   can answer many "check this page" tasks without the browser at all. The
   browser should be the fallback for human-only UIs, not the default.
5. **Offer Set-of-Mark overlays as an option.** For models with weak grounding,
   an optional numbered-overlay screenshot (DOM-derived boxes, no ML needed) is
   a cheap grounding aid. Pair it with a small internal task suite so the effect
   is measured, not assumed.
6. **Keep the safety layers, and plan the missing one.** OpenAI's own numbers
   show residual risk: 23% prompt-injection susceptibility after mitigation,
   with confirmations cutting mistake risk ~90% and a monitor model catching
   injections at 99% recall. OpenBot has approval gates but no per-bot egress
   policy (roadmap item 7) and no monitor model. The "lethal trifecta" —
   private data, untrusted content, and an exfiltration path — applies to every
   agent with a logged-in browser and network access. Allowlists, logged-out
   browser profiles, and script-level approval previews are the layered answer.
7. **Measure OpenBot on its own terms.** Before and after the changes above,
   run a small fixed task suite (a handful of WebVoyager-style and
   desktop-style tasks) and record success rate, model turns, wall-clock time,
   and tokens per task. Provider numbers are not comparable across versions;
   OpenBot's own numbers are.

The Codex harness already points in the right direction: it plans in code and
acts through tools, which is exactly the code-execution shape the frontier
converged on. The built-in loop is the one that still thinks one action at a
time.
