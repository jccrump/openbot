import { useState } from "react";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; version: string }
  | { kind: "available"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "installed"; version: string }
  | { kind: "unavailable"; message: string };

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Checks the configured Tauri update channel. A build without endpoints (the
 * default for a source checkout) reports that updates are not configured
 * rather than failing silently.
 */
export function UpdateCard() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [pending, setPending] = useState<Awaited<
    ReturnType<typeof import("@tauri-apps/plugin-updater")["check"]>
  > | null>(null);

  const check = async () => {
    if (!inTauri()) {
      setState({
        kind: "unavailable",
        message:
          "This is the browser build; updates apply to the packaged macOS app.",
      });
      return;
    }
    setState({ kind: "checking" });
    try {
      const { check: checkUpdate } = await import(
        "@tauri-apps/plugin-updater"
      );
      const update = await checkUpdate();
      if (!update) {
        const { getVersion } = await import("@tauri-apps/api/app");
        setState({ kind: "current", version: await getVersion() });
        return;
      }
      setPending(update);
      setState({ kind: "available", version: update.version });
    } catch (error) {
      setState({
        kind: "unavailable",
        message: (error as Error).message,
      });
    }
  };

  const install = async () => {
    if (!pending) {
      return;
    }
    const version = pending.version;
    setState({ kind: "installing", version });
    try {
      await pending.downloadAndInstall();
      setPending(null);
      setState({ kind: "installed", version });
    } catch (error) {
      setState({ kind: "unavailable", message: (error as Error).message });
    }
  };

  const status =
    state.kind === "idle"
      ? "Checks the update channel this build was configured with."
      : state.kind === "checking"
        ? "Checking…"
        : state.kind === "current"
          ? `OpenBot ${state.version} is up to date.`
          : state.kind === "available"
            ? `Version ${state.version} is available.`
            : state.kind === "installing"
              ? `Downloading ${state.version}…`
              : state.kind === "installed"
                ? `Version ${state.version} installed — quit and reopen OpenBot to use it.`
                : state.message;

  return (
    <section className="settings-card">
      <div className="settings-row">
        <span>Software update</span>
        {state.kind === "available" ? (
          <button className="save-button" onClick={() => void install()}>
            Install update
          </button>
        ) : (
          <button
            className="ghost-button"
            onClick={() => void check()}
            disabled={state.kind === "checking" || state.kind === "installing"}
          >
            Check for updates
          </button>
        )}
      </div>
      <p className="settings-note">{status}</p>
    </section>
  );
}
