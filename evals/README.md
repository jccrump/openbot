# OpenBot agent evaluations

This suite measures whether the real OpenBot harness can research, reason, and
return a grounded answer. It uses the configured model and normal daemon/tool
loop, but replaces the public web with deterministic pages whose truth is known
to the grader.

That split is intentional:

- Model and harness behavior are real.
- Search results, websites, failures, and contradictions are repeatable.
- A website changing tomorrow cannot make a code change look better or worse.
- Full answers, tool calls, page visits, timing, token use, completion audits,
  and failed checks are retained for diagnosis.

The scenarios cover exact-product provenance, conjunctive requirements,
multi-source research, misleading snippets, blocked sources, honest unknowns,
and simple navigation. Ground truth and grading live in `scenarios.mjs`.

## Establish a baseline

First verify that every example answer is classified correctly:

```bash
pnpm eval:validate
```

Then record the current system before changing it:

```bash
pnpm eval -- --label pre-decision-change --runs 5
```

The runner disables the live `web_search` tool for the run
(`OPENBOT_WEBSEARCH_DISABLED=1`) so the fixture pages stay authoritative.

The runner uses `OPENBOT_EVAL_API_KEY`, then `DEEPSEEK_API_KEY`, then the saved
DeepSeek key in `.openbot-dev/openbot.db`. The key is passed by environment
reference and is never included in the report.

Results are written to ignored JSON and Markdown files under `evals/results/`.
Keep the JSON path printed by the command; it is the comparison input.
Each result fingerprints the scenario grader and evaluation runner. A
comparison refuses to mix incompatible evaluator versions.

## Compare a change

Run the same scenarios, model, and repetition count after the change:

```bash
pnpm eval -- \
  --label post-decision-change \
  --runs 5 \
  --compare evals/results/<pre-change-result>.json
```

Use at least five repetitions for directional work and 20 for a release-level
comparison. Model output is stochastic even though the websites are fixed.
Judge a change primarily by strict pass rate and average score, then check
browser actions, latency, token use, failed tool calls, and verifier repairs for
the cost of that quality.

### Evaluating the Jev decision paths

The daemon enables the decision model automatically when `TYPESAFE_API_KEY` is
set (override the endpoint or model with `TYPESAFE_BASE_URL` and
`TYPESAFE_DEFAULT_MODEL`). Record a baseline without the key, then run the same
scenarios with it. The decision paths add `decisionCalls` to the daemon log
(`completion.audit` with `engine: "jev"`, `guardrail.flagged`) and the runner's
verifier-repair counts show whether the typed audit accepted or returned
drafts.

### Speed metrics

Speed is a first-class comparison dimension. The runner records these values
for every run and summarizes them overall and per scenario:

- end-to-end completion time from `chat.send` until `chat.done`;
- time to first visible action, meaning the first `tool.start` or streamed text;
- time to first tool and time to first text separately in the JSON trace;
- average, median, and p95 latency;
- run-only throughput plus full benchmark wall time and effective throughput;
- browser action count, tool execution time, and token use as efficiency
  diagnostics.

Use median latency to describe the typical experience and p95 to catch stalls.
In comparison tables, a negative latency delta is faster, while a positive
tasks-per-minute delta is better. These are wall-clock measurements, so provider
network variability still exists; use the same machine, provider, model, and
repetition count before and after a change.

Useful focused commands:

```bash
pnpm eval -- --list
pnpm eval -- --scenario pizza-conjunctive --runs 3 --label pizza-debug
pnpm eval -- --scenario soccer-local-inventory,gameboy-five-sellers
```

If a grader bug is fixed, reapply the current graders to the original saved
answers and traces without another model call:

```bash
pnpm eval -- \
  --regrade evals/results/<old-result>.json \
  --label pre-decision-change-regraded
```

## What a strict pass means

Each scenario has critical checks derived from hidden ground truth. A strict
pass requires every critical check. Partial score is the fraction of all checks
that passed and helps distinguish a near miss from an unsupported answer.

The report also records:

- pages actually visited, not merely named in the answer;
- total and browser tool calls, including failures;
- end-to-end duration and provider token usage;
- first-action latency, median and p95 completion latency, and throughput;
- completion-audit verdicts and repair attempts;
- the Git commit, dirty-worktree flag, and code fingerprint.

The benchmark does not claim that public-web browsing is healthy. Keep a small
manual live-web acceptance pass for connectivity, consent dialogs, rendering,
and browser compatibility. Do not mix those unstable results into the
deterministic quality score.
