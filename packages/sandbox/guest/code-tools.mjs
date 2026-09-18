// OpenBot code-tools helper: grep and glob over a directory tree.
//
// The daemon runs this inside whichever computer the agent owns — the
// Firecracker guest or the local Mac — so the same glob semantics and the same
// ignore list apply on both. It exists because the two userlands disagree:
// macOS ships BSD grep (no --include, no --exclude-dir) and BSD find (no
// -printf), and GNU ripgrep is not installed in the guest. Node 22 is present
// in both places, so the traversal is written once here.
//
// Invoked as: node code-tools.mjs <base64-json>
//   { mode: "grep", root, pattern, include?, cap, maxFiles? }
//   { mode: "glob", root, pattern, cap, maxFiles? }
//
// Prints matches to stdout, diagnostics to stderr. Exit 2 on bad input.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORED = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  "coverage",
]);

const DEFAULT_MAX_FILES = 20000;

function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
        }
        out += "(?:.*/)?";
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".indexOf(ch) >= 0) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(out + "$");
}

// A pattern without a slash is almost always meant recursively: "*.ts" should
// find nested TypeScript, not only files beside the root.
function normalizeGlob(pattern) {
  return pattern.indexOf("/") >= 0 ? pattern : "**/" + pattern;
}

function walk(dir, files, cap) {
  if (files.length >= cap) {
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= cap) {
      return;
    }
    if (IGNORED.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files, cap);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(2);
}

function main() {
  const raw = process.argv[2];
  if (!raw) {
    fail("usage: node code-tools.mjs <base64-json>");
  }
  let args;
  try {
    args = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    fail("could not decode arguments");
  }

  const root = args.root;
  if (!root) {
    fail("root is required");
  }
  const cap = Number(args.cap) > 0 ? Number(args.cap) : 200;
  const maxFiles = Number(args.maxFiles) > 0 ? Number(args.maxFiles) : DEFAULT_MAX_FILES;

  const files = [];
  walk(root, files, maxFiles);

  if (args.mode === "glob") {
    let matcher;
    try {
      matcher = globToRegExp(normalizeGlob(args.pattern));
    } catch {
      fail("invalid pattern: " + args.pattern);
    }
    const matched = [];
    for (const file of files) {
      const rel = relative(root, file).split(sep).join("/");
      if (matcher.test(rel)) {
        matched.push(file);
      }
    }
    matched.sort();
    const shown = matched.slice(0, cap);
    if (shown.length > 0) {
      process.stdout.write(shown.join("\n") + "\n");
    }
    if (matched.length > cap) {
      process.stdout.write(
        "[truncated: " + matched.length + " files matched, showing " + cap + "]\n",
      );
    }
    return;
  }

  if (args.mode !== "grep") {
    fail("unknown mode: " + args.mode);
  }

  let matcher;
  try {
    matcher = new RegExp(args.pattern);
  } catch {
    fail("invalid regular expression: " + args.pattern);
  }
  const include = args.include
    ? globToRegExp(normalizeGlob(args.include))
    : null;
  const includeHasSlash = Boolean(args.include && args.include.indexOf("/") >= 0);

  const out = [];
  for (const file of files) {
    if (out.length >= cap) {
      break;
    }
    const rel = relative(root, file).split(sep).join("/");
    if (include) {
      const target = includeHasSlash ? rel : rel.split("/").pop();
      if (!include.test(target)) {
        continue;
      }
    }
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Skip binaries: a NUL byte in the first block is the usual tell.
    if (content.indexOf(String.fromCharCode(0)) >= 0) {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (matcher.test(lines[i])) {
        out.push(file + ":" + (i + 1) + ":" + lines[i]);
        if (out.length >= cap) {
          break;
        }
      }
    }
  }

  if (out.length > 0) {
    process.stdout.write(out.join("\n") + "\n");
  }
  if (out.length >= cap) {
    process.stdout.write("[truncated: stopping at " + cap + " matches]\n");
  }
}

main();
