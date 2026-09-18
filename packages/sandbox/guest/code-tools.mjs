// OpenBot code-tools helper: list, grep, and glob over a directory tree.
//
// The daemon runs this inside whichever computer the agent owns — the
// Firecracker guest or the local Mac — so the same glob semantics and the same
// ignore list apply on both. It exists because the two userlands disagree:
// macOS ships BSD grep (no --include, no --exclude-dir) and BSD find (no
// -printf), and GNU ripgrep is not installed in the guest. Node 22 is present
// in both places, so the traversal is written once here.
//
// Invoked as: node code-tools.mjs <base64-json>
//   { mode: "list", root, cap }
//   { mode: "entries", root, cap }
//   { mode: "read", path, maxBytes }
//   { mode: "grep", root, pattern, include?, cap, maxFiles? }
//   { mode: "glob", root, pattern, cap, maxFiles? }
//
// Prints matches to stdout, diagnostics to stderr. Exit 2 on bad input. The
// entries and read modes print one JSON object so the app can browse the
// agent's computer without parsing human-readable listing text.

import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const DEFAULT_READ_BYTES = 512 * 1024;

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
  if (!root && args.mode !== "read") {
    fail("root is required");
  }
  const cap = Number(args.cap) > 0 ? Number(args.cap) : 200;
  const maxFiles = Number(args.maxFiles) > 0 ? Number(args.maxFiles) : DEFAULT_MAX_FILES;

  if (args.mode === "list") {
    let items;
    try {
      items = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      fail(
        "could not read directory: " +
          (error && error.message ? error.message : String(error)),
      );
    }
    const entries = [];
    let skipped = 0;
    for (const entry of items) {
      if (IGNORED.has(entry.name)) {
        skipped += 1;
        continue;
      }
      let size = null;
      try {
        size = statSync(join(root, entry.name)).size;
      } catch {
        // A broken symlink or a race: list it without a size.
      }
      entries.push({ name: entry.name, dir: entry.isDirectory(), size });
    }
    // Directories first, then files, each alphabetically: the shape of a tree
    // is what the model needs before it picks a path.
    entries.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
    );
    for (const entry of entries.slice(0, cap)) {
      process.stdout.write(
        entry.dir
          ? "dir  " + entry.name + "/\n"
          : "file " + entry.name + (entry.size === null ? "" : " (" + entry.size + " bytes)") + "\n",
      );
    }
    if (entries.length > cap) {
      process.stdout.write(
        "[truncated: " + entries.length + " entries, showing " + cap + "]\n",
      );
    }
    if (skipped > 0) {
      process.stdout.write(
        "[skipped " + skipped + " ignored entr" + (skipped === 1 ? "y" : "ies") +
          " such as .git, node_modules, dist]\n",
      );
    }
    return;
  }

  if (args.mode === "entries") {
    let items;
    try {
      items = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          error:
            "could not read directory: " +
            (error && error.message ? error.message : String(error)),
        }) + "\n",
      );
      return;
    }
    const entries = [];
    let skipped = 0;
    for (const entry of items) {
      if (IGNORED.has(entry.name)) {
        skipped += 1;
        continue;
      }
      let size = null;
      let mtime = null;
      try {
        const info = statSync(join(root, entry.name));
        size = info.size;
        mtime = info.mtimeMs;
      } catch {
        // A broken symlink or a race: list it without metadata.
      }
      entries.push({
        name: entry.name,
        dir: entry.isDirectory(),
        size,
        mtime,
      });
    }
    entries.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
    );
    process.stdout.write(
      JSON.stringify({
        entries: entries.slice(0, cap),
        total: entries.length,
        skipped,
      }) + "\n",
    );
    return;
  }

  if (args.mode === "read") {
    const path = args.path;
    if (!path) {
      fail("path is required");
    }
    const maxBytes =
      Number(args.maxBytes) > 0 ? Number(args.maxBytes) : DEFAULT_READ_BYTES;
    let info;
    try {
      info = statSync(path);
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          kind: "missing",
          size: 0,
          truncated: false,
          content: null,
          mime: null,
          error: error && error.message ? error.message : String(error),
        }) + "\n",
      );
      return;
    }
    if (info.isDirectory()) {
      process.stdout.write(
        JSON.stringify({
          kind: "dir",
          size: 0,
          truncated: false,
          content: null,
          mime: null,
          error: null,
        }) + "\n",
      );
      return;
    }
    const extension = path.toLowerCase().split(".").pop();
    const imageMime = IMAGE_MIME[extension];
    if (imageMime) {
      const limit = Math.min(info.size, 8 * 1024 * 1024);
      const buffer = Buffer.alloc(limit);
      let bytes = 0;
      let fd;
      try {
        fd = openSync(path, "r");
        bytes = readSync(fd, buffer, 0, limit, 0);
      } catch (error) {
        fail("could not read file: " + (error && error.message ? error.message : String(error)));
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      process.stdout.write(
        JSON.stringify({
          kind: "image",
          size: info.size,
          truncated: info.size > limit,
          content: buffer.subarray(0, bytes).toString("base64"),
          mime: imageMime,
          error: null,
        }) + "\n",
      );
      return;
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    let fd;
    try {
      fd = openSync(path, "r");
      bytes = readSync(fd, buffer, 0, maxBytes + 1, 0);
    } catch (error) {
      fail("could not read file: " + (error && error.message ? error.message : String(error)));
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const truncated = bytes > maxBytes;
    const data = buffer.subarray(0, Math.min(bytes, maxBytes));
    const binary = data.subarray(0, 8192).indexOf(0) >= 0;
    process.stdout.write(
      JSON.stringify({
        kind: binary ? "binary" : "text",
        size: info.size,
        truncated,
        content: binary ? null : data.toString("utf8"),
        mime: null,
        error: null,
      }) + "\n",
    );
    return;
  }

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
