import assert from "node:assert/strict";
import { scenarios } from "../evals/scenarios.mjs";

const ids = new Set();
for (const scenario of scenarios) {
  assert.ok(!ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
  ids.add(scenario.id);
  assert.ok(scenario.prompt.length > 20, `${scenario.id}: prompt is too short`);
  assert.ok(scenario.pages.length > 0, `${scenario.id}: no fixture pages`);

  const pageIds = scenario.pages.map((page) => page.id);
  assert.equal(
    new Set(pageIds).size,
    pageIds.length,
    `${scenario.id}: duplicate page id`,
  );
  const context = {
    answer: scenario.examples.good,
    visitedPageIds: pageIds,
    browserActions: 1,
  };
  const good = scenario.grade(context);
  assert.equal(
    good.pass,
    true,
    `${scenario.id}: documented good answer failed: ${good.checks
      .filter((check) => !check.passed)
      .map((check) => check.id)
      .join(", ")}`,
  );
  const bad = scenario.grade({ ...context, answer: scenario.examples.bad });
  assert.equal(
    bad.pass,
    false,
    `${scenario.id}: documented bad answer unexpectedly passed`,
  );
}

console.log(
  `EVAL FIXTURES OK — ${scenarios.length} scenarios and graders validated`,
);
