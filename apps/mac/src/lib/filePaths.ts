const EXTENSIONS = new Set([
  "7z",
  "app",
  "bash",
  "c",
  "cc",
  "cfg",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "diff",
  "dmg",
  "doc",
  "docx",
  "env",
  "gif",
  "go",
  "gz",
  "h",
  "hpp",
  "html",
  "ico",
  "ini",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "json5",
  "jsx",
  "kt",
  "lock",
  "log",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mov",
  "mp3",
  "mp4",
  "pdf",
  "php",
  "plist",
  "png",
  "pptx",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "tar",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "xml",
  "yaml",
  "yml",
  "zip",
  "zsh",
]);

const BARE_NAMES = new Set([
  "brewfile",
  "changelog",
  "dockerfile",
  "gemfile",
  "license",
  "licence",
  "makefile",
  "procfile",
  "readme",
]);

const SEGMENT = /^[\w@+-][\w.@+-]*$/;
const EXTENSION = /^\.[A-Za-z0-9]{1,12}$/;

export interface FilePathMatch {
  /** The path alone, without a trailing `:line` or `:line:col`. */
  path: string;
  /** The original text, e.g. `src/App.tsx:12`. */
  label: string;
}

/**
 * Recognize a file reference the way agents write them: inline code and links
 * like `src/App.tsx`, `/root/report.html`, `~/notes.md`, or `docs/a.md:12`.
 * A bare name needs a known extension, so code snippets such as `array.map`
 * are left alone. `explicit` accepts multi-segment paths with any final name,
 * for prose references that always start at a root (`/Users/me/Downloads`).
 */
export function filePathFromText(
  raw: string,
  explicit = false,
): FilePathMatch | null {
  const text = raw.trim();
  if (!text || text.length > 240 || /\s/.test(text)) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return null;
  }
  const lineSuffix = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
  const candidate = lineSuffix ? lineSuffix[1] ?? "" : text;
  if (!candidate) {
    return null;
  }
  const rooted = candidate.startsWith("/") || candidate.startsWith("~/");
  const segments = candidate.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (!SEGMENT.test(base)) {
    return null;
  }
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const hasExtension = EXTENSION.test(dot === -1 ? "" : base.slice(dot));
  const hasBareName = BARE_NAMES.has(base.toLowerCase());
  const dotfile = base.startsWith(".") && /^[\w.-]{2,24}$/.test(base);
  if (segments.length === 1) {
    if (!EXTENSIONS.has(extension) && !hasBareName && !dotfile) {
      return null;
    }
  } else if (!hasExtension && !hasBareName && !(explicit && rooted)) {
    return null;
  }
  return { path: candidate, label: text };
}

/** A `file://` URL the agent may emit instead of a bare path. */
export function filePathFromUrl(url: string): string | null {
  if (!/^file:\/\//i.test(url)) {
    return null;
  }
  let path = url.replace(/^file:\/\//i, "");
  if (path.startsWith("localhost/")) {
    path = path.slice("localhost".length);
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  return path || null;
}
