use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The daemon this app starts when it is packaged. Running it as a sidecar of
/// OpenBot.app makes macOS attribute TCC grants (Documents, Desktop, Downloads,
/// Full Disk Access) to the app instead of Terminal.
struct SidecarProcess(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(SidecarProcess(Mutex::new(None)));
            // In development the daemon usually runs from a terminal
            // (`pnpm dev:daemon`), so only a packaged app starts its own.
            // OPENBOT_SIDECAR=1 forces the sidecar for a release-style test
            // from `tauri dev`.
            let spawn_sidecar = !cfg!(debug_assertions)
                || std::env::var("OPENBOT_SIDECAR").ok().as_deref() == Some("1");
            if spawn_sidecar {
                if let Err(error) = start_sidecar(app.handle()) {
                    eprintln!("[openbotd] could not start the sidecar: {error}");
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                stop_sidecar(app_handle);
            }
        });
}

fn start_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Report the .app bundle rather than Contents/MacOS when there is one, so
    // system_info describes the install the user actually has.
    let app_path = std::env::current_exe().ok().and_then(|exe| {
        exe.ancestors()
            .find(|path| {
                path.extension()
                    .map(|extension| extension == "app")
                    .unwrap_or(false)
            })
            .or_else(|| exe.parent())
            .map(|path| path.to_string_lossy().into_owned())
    });
    let mut command = app
        .shell()
        .sidecar("openbotd")?
        // The sidecar exits when this app dies, even on a hard kill.
        .env("OPENBOT_PARENT_WATCH", "1");
    if let Some(path) = app_path {
        command = command.env("OPENBOT_APP_PATH", path);
    }
    let (mut rx, child) = command.spawn()?;
    if let Some(state) = app.try_state::<SidecarProcess>() {
        *state.0.lock().unwrap() = Some(child);
    }
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    print!("[openbotd] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprint!("[openbotd] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[openbotd] exited with {:?}", payload.code);
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn stop_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarProcess>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}
