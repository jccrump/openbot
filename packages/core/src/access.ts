import { spawn } from "node:child_process";
import { closeSync, openSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AccessState = "granted" | "denied" | "missing";

export interface AccessEntry {
  id: "documents" | "desktop" | "downloads" | "home" | "full-disk";
  label: string;
  path: string | null;
  state: AccessState;
  /** The System Settings privacy pane that governs this entry. */
  pane: AccessPane | null;
}

export type AccessPane =
  | "full-disk"
  | "files"
  | "documents"
  | "desktop"
  | "downloads";

export interface AccessReport {
  /** Which app macOS attributes the permission to. */
  owner: string;
  platform: string;
  entries: AccessEntry[];
}

const PANE_URLS: Record<AccessPane, string> = {
  "full-disk":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  files:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
  documents:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_DocumentsFolder",
  desktop:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_DesktopFolder",
  downloads:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_DownloadsFolder",
};

function probeDirectory(dir: string): AccessState {
  try {
    readdirSync(dir);
    return "granted";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "denied";
  }
}

/**
 * Full Disk Access has no request API: the only reliable signal is whether a
 * protected file can be opened. TCC.db is the standard probe.
 */
function probeFullDisk(): AccessState {
  const candidates = [
    join(homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db"),
    "/Library/Application Support/com.apple.TCC/TCC.db",
  ];
  let sawMissing = false;
  for (const path of candidates) {
    try {
      closeSync(openSync(path, "r"));
      return "granted";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        sawMissing = true;
        continue;
      }
      return "denied";
    }
  }
  return sawMissing ? "missing" : "denied";
}

/**
 * Probe the folders macOS gates behind TCC, plus Full Disk Access. A probe can
 * itself raise the system prompt when the user has never decided; a decided
 * denial only changes in System Settings.
 */
export function collectAccessReport(owner: string): AccessReport {
  const home = homedir();
  const folders: Array<{
    id: AccessEntry["id"];
    label: string;
    dir: string;
    pane: AccessPane;
  }> = [
    { id: "documents", label: "Documents", dir: join(home, "Documents"), pane: "documents" },
    { id: "desktop", label: "Desktop", dir: join(home, "Desktop"), pane: "desktop" },
    { id: "downloads", label: "Downloads", dir: join(home, "Downloads"), pane: "downloads" },
  ];
  const entries: AccessEntry[] = folders.map((folder) => ({
    id: folder.id,
    label: folder.label,
    path: folder.dir,
    state: probeDirectory(folder.dir),
    pane: folder.pane,
  }));
  entries.push({
    id: "home",
    label: "Home folder",
    path: home,
    state: probeDirectory(home),
    pane: "files",
  });
  entries.push({
    id: "full-disk",
    label: "Full Disk Access",
    path: null,
    state: process.platform === "darwin" ? probeFullDisk() : "missing",
    pane: "full-disk",
  });
  return { owner, platform: process.platform, entries };
}

/** Open the System Settings privacy pane for an entry. macOS only. */
export function openPrivacyPane(pane: AccessPane): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    const child = spawn("open", [PANE_URLS[pane]], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
