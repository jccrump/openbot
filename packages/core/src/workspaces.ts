import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Workspace } from "@openbot/protocol";
import type { Store } from "./store";

const WORKSPACE_ROOTS_KEY = "workspaceRoots";

/** A folder containing any of these is treated as a project root. */
const MARKER_FILES = [
  ".git",
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "composer.json",
  "Gemfile",
  "build.gradle",
  "CMakeLists.txt",
];

const MARKER_SUFFIXES = [".xcodeproj", ".xcworkspace"];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "Pods",
  "DerivedData",
  "Library",
  ".Trash",
]);

const DEFAULT_MAX_DEPTH = 4;
const MAX_DIRS = 20_000;

export interface DiscoveredWorkspace {
  root: string;
  name: string;
  markers: string[];
}

function markerNames(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const present = new Set(entries);
  const markers: string[] = [];
  for (const marker of MARKER_FILES) {
    if (present.has(marker)) {
      markers.push(marker);
    }
  }
  for (const entry of entries) {
    if (MARKER_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
      markers.push(entry);
    }
  }
  return markers;
}

/**
 * Breadth-first scan of the configured roots. A directory with a project
 * marker is registered as one workspace and not descended into, so nested
 * packages do not flood the registry. Directory symlinks are not followed and
 * heavy build directories are skipped.
 */
export function discoverWorkspaces(
  roots: string[],
  options: { maxDepth?: number } = {},
): DiscoveredWorkspace[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const found = new Map<string, DiscoveredWorkspace>();
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const root of roots) {
    const absolute = resolve(root);
    if (existsSync(absolute)) {
      queue.push({ dir: absolute, depth: 0 });
    }
  }
  let visited = 0;
  while (queue.length > 0 && visited < MAX_DIRS) {
    const current = queue.shift()!;
    visited += 1;
    const markers = markerNames(current.dir);
    if (markers.length > 0) {
      found.set(current.dir, {
        root: current.dir,
        name: basename(current.dir) || current.dir,
        markers,
      });
      continue;
    }
    if (current.depth >= maxDepth) {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // isDirectory() is false for symlinks, so they are never followed.
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return [...found.values()].sort((a, b) => a.root.localeCompare(b.root));
}

/** A stable per-workspace folder inside a microVM, created on first use. */
export function workspaceGuestRoot(workspace: Pick<Workspace, "root">): string {
  const slug =
    basename(workspace.root)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  return `/root/projects/${slug}`;
}

/**
 * The registry: configured scan roots plus the known workspaces. Discovery
 * proposes; only registered rows are reachable by agents, and ignored rows
 * stay visible so a scan does not keep re-adding a folder the user rejected.
 */
export class WorkspaceService {
  constructor(
    private readonly store: Store,
    private readonly defaultRoots: string[],
  ) {}

  roots(): string[] {
    const raw = this.store.getSetting(WORKSPACE_ROOTS_KEY);
    if (!raw) {
      const seeded = [...this.defaultRoots];
      this.store.setSetting(WORKSPACE_ROOTS_KEY, JSON.stringify(seeded));
      return seeded;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      // fall through to an empty list
    }
    return [];
  }

  setRoots(roots: string[]): string[] {
    const normalized = [
      ...new Set(
        roots
          .map((root) => root.trim())
          .filter(Boolean)
          .map((root) => resolve(root)),
      ),
    ];
    this.store.setSetting(WORKSPACE_ROOTS_KEY, JSON.stringify(normalized));
    return normalized;
  }

  list(): Workspace[] {
    return this.store.listWorkspaces().map((workspace) => ({
      ...workspace,
      missing: !existsSync(workspace.root),
    }));
  }

  get(id: string | null | undefined): Workspace | null {
    if (!id) {
      return null;
    }
    const workspace = this.store.getWorkspace(id);
    if (!workspace) {
      return null;
    }
    return { ...workspace, missing: !existsSync(workspace.root) };
  }

  add(root: string): Workspace {
    const absolute = resolve(root.trim());
    if (!existsSync(absolute)) {
      throw new Error(`no such folder: ${absolute}`);
    }
    const markers = markerNames(absolute);
    const now = new Date().toISOString();
    const existing = this.store.getWorkspaceByRoot(absolute);
    if (existing) {
      // An explicit add un-ignores and refreshes the detected markers.
      return this.store.updateWorkspace(existing.id, {
        ignored: false,
        markers,
        lastSeenAt: now,
      })!;
    }
    return this.store.createWorkspace({
      name: this.uniqueName(basename(absolute) || absolute),
      root: absolute,
      markers,
    });
  }

  update(
    id: string,
    patch: { name?: string; ignored?: boolean; autoApprove?: string[] },
  ): Workspace | null {
    const workspace = this.store.getWorkspace(id);
    if (!workspace) {
      return null;
    }
    const name =
      patch.name !== undefined ? this.uniqueName(patch.name.trim(), id) : undefined;
    return this.store.updateWorkspace(id, {
      ...(name ? { name } : {}),
      ...(patch.ignored !== undefined ? { ignored: patch.ignored } : {}),
      ...(patch.autoApprove !== undefined
        ? {
            autoApprove: patch.autoApprove
              .map((pattern) => pattern.trim())
              .filter(Boolean),
          }
        : {}),
    });
  }

  remove(id: string): boolean {
    return this.store.deleteWorkspace(id);
  }

  scan(): { workspaces: Workspace[]; discovered: number } {
    const discovered = discoverWorkspaces(this.roots());
    const now = new Date().toISOString();
    let added = 0;
    for (const item of discovered) {
      const existing = this.store.getWorkspaceByRoot(item.root);
      if (existing) {
        this.store.updateWorkspace(existing.id, {
          markers: item.markers,
          lastSeenAt: now,
        });
        continue;
      }
      this.store.createWorkspace({
        name: this.uniqueName(item.name),
        root: item.root,
        markers: item.markers,
      });
      added += 1;
    }
    return { workspaces: this.list(), discovered: added };
  }

  private uniqueName(candidate: string, exceptId?: string): string {
    const taken = new Set(
      this.store
        .listWorkspaces()
        .filter((workspace) => workspace.id !== exceptId)
        .map((workspace) => workspace.name.toLowerCase()),
    );
    const base = candidate || "Workspace";
    if (!taken.has(base.toLowerCase())) {
      return base;
    }
    let suffix = 2;
    while (taken.has(`${base} ${suffix}`.toLowerCase())) {
      suffix += 1;
    }
    return `${base} ${suffix}`;
  }
}
