/**
 * Line-level diff for the changed-files card.
 *
 * The file tools hand back the text before and after an edit; the app renders
 * the per-file `+N/-M` summary and, when a row is expanded, the hunks. A full
 * Myers diff is more than this needs: edits usually touch a small window of a
 * large file, so common prefix and suffix lines are trimmed first and only the
 * middle is aligned with an LCS table. When the middle is too large to align
 * cheaply, the change is reported as stats only and the row has no diff to
 * expand.
 */

export interface FileChangeStats {
  additions: number;
  deletions: number;
  diff: string | null;
}

const CONTEXT_LINES = 3;
const MAX_LCS_CELLS = 250_000;
const MAX_DIFF_LINES = 400;
const MAX_DIFF_CHARS = 20_000;
const TRUNCATED = "[diff truncated]";

type OpKind = "same" | "add" | "del";

interface Op {
  kind: OpKind;
  text: string;
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const lines = text.split("\n");
  // A trailing newline is a terminator, not an extra empty line.
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Align two line arrays with an LCS table. Returns null when the table would
 * be too large to build, so the caller can fall back to coarse stats.
 */
function alignLines(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) {
    return b.map((text) => ({ kind: "add" as const, text }));
  }
  if (m === 0) {
    return a.map((text) => ({ kind: "del" as const, text }));
  }
  if (n * m > MAX_LCS_CELLS) {
    return null;
  }

  // table[i][j] is the LCS length of a[i..] and b[j..].
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      ops.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: b[j]! });
    j += 1;
  }
  return ops;
}

interface PositionedOp extends Op {
  oldLine: number;
  newLine: number;
}

/**
 * Group ops into unified-diff hunks with three lines of context, capping the
 * output so a huge rewrite cannot balloon the persisted message.
 */
function formatHunks(ops: Op[]): string | null {
  let oldLine = 1;
  let newLine = 1;
  const positioned: PositionedOp[] = ops.map((op) => {
    const entry = { ...op, oldLine, newLine };
    if (op.kind === "same") {
      oldLine += 1;
      newLine += 1;
    } else if (op.kind === "del") {
      oldLine += 1;
    } else {
      newLine += 1;
    }
    return entry;
  });

  // Ranges of change indices, padded by context and merged when they touch.
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < positioned.length; index += 1) {
    if (positioned[index]!.kind === "same") {
      continue;
    }
    const start = Math.max(0, index - CONTEXT_LINES);
    let end = index;
    while (
      end + 1 < positioned.length &&
      positioned[end + 1]!.kind !== "same"
    ) {
      end += 1;
    }
    end = Math.min(positioned.length - 1, end + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  if (ranges.length === 0) {
    return null;
  }

  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  outer: for (const range of ranges) {
    const slice = positioned.slice(range.start, range.end + 1);
    const oldCount = slice.filter((op) => op.kind !== "add").length;
    const newCount = slice.filter((op) => op.kind !== "del").length;
    const header =
      `@@ -${slice[0]!.oldLine},${oldCount} ` +
      `+${slice[0]!.newLine},${newCount} @@`;
    for (const line of [header, ...slice.map(formatLine)]) {
      if (
        lines.length >= MAX_DIFF_LINES ||
        chars + line.length + 1 > MAX_DIFF_CHARS
      ) {
        truncated = true;
        break outer;
      }
      lines.push(line);
      chars += line.length + 1;
    }
  }
  if (truncated) {
    lines.push(TRUNCATED);
  }
  return lines.join("\n");
}

function formatLine(op: PositionedOp): string {
  if (op.kind === "add") {
    return `+${op.text}`;
  }
  if (op.kind === "del") {
    return `-${op.text}`;
  }
  return ` ${op.text}`;
}

export function lineDiff(before: string, after: string): FileChangeStats {
  const a = splitLines(before);
  const b = splitLines(after);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const middle = alignLines(middleA, middleB);
  if (!middle) {
    // Too large to align cheaply: report the changed block without hunks.
    return {
      additions: middleB.length,
      deletions: middleA.length,
      diff: null,
    };
  }

  const additions = middle.filter((op) => op.kind === "add").length;
  const deletions = middle.filter((op) => op.kind === "del").length;
  if (additions === 0 && deletions === 0) {
    return { additions: 0, deletions: 0, diff: null };
  }
  const ops: Op[] = [
    ...a.slice(0, prefix).map((text) => ({ kind: "same" as const, text })),
    ...middle,
    ...a.slice(a.length - suffix).map((text) => ({ kind: "same" as const, text })),
  ];
  return { additions, deletions, diff: formatHunks(ops) };
}
