mod db;

use std::sync::Mutex;

use tauri::path::BaseDirectory;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Tier-0 embedded model. On launch we spawn a bundled `llama-server` (Tauri
// sidecar) that serves an OpenAI-compatible API on 127.0.0.1; the web client's
// LocalEngine talks to it directly, so guidance works with no Ghost server and
// no network. See docs/AGENT_DESIGN.md and apps/desktop/SIDECAR.md.
//
// This is deliberately best-effort: a build without the binary or weights (the
// common dev case) logs a line and carries on. The app still runs; LocalEngine
// just reports the model offline until the assets are dropped in and the
// sidecar is enabled (SIDECAR.md).

// Must match the web client's VITE_LOCAL_LLM_URL default (127.0.0.1:8080).
const LLM_HOST: &str = "127.0.0.1";
const LLM_PORT: u16 = 8080;

/// Holds the running sidecar for the app's lifetime. Tauri terminates managed
/// sidecar processes when the app exits, so keeping it here avoids orphans.
struct LlmSidecar(#[allow(dead_code)] Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![db::db_exec])
        .setup(|app| {
            // Native persistence must come up before the webview asks for data;
            // unlike the sidecar this is not best-effort (see db.rs).
            db::open(app)?;
            spawn_llm_sidecar(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn spawn_llm_sidecar(app: tauri::AppHandle) {
    let resolve = |rel: &str| app.path().resolve(rel, BaseDirectory::Resource);

    // The model, shipped as a Tauri resource (SIDECAR.md). Absent in a build
    // without the weights — skip gracefully so the app still runs.
    let model = match resolve("models/model.gguf") {
        Ok(path) if path.exists() => path,
        _ => {
            eprintln!("[ghost] no bundled model found; local LLM sidecar not started");
            return;
        }
    };

    // The bundled llama-server. It is not a single file: it loads sibling
    // shared libraries (.so via rpath=$ORIGIN on Linux, .dll next to the .exe
    // on Windows), so the binary and its libs are bundled together under
    // resources/binaries/ and spawned from there (SIDECAR.md).
    let server_rel = if cfg!(windows) {
        "binaries/llama-server.exe"
    } else {
        "binaries/llama-server"
    };
    let server = match resolve(server_rel) {
        Ok(path) if path.exists() => path,
        _ => {
            eprintln!("[ghost] llama-server binary not bundled; sidecar not started");
            return;
        }
    };

    let command = app.shell().command(&server).args([
        "--model",
        &model.to_string_lossy(),
        "--host",
        LLM_HOST,
        "--port",
        &LLM_PORT.to_string(),
        // Apply the model's chat template (Qwen3 needs it).
        "--jinja",
        // Keep any <think> tags inline; the client strips them from the answer.
        "--reasoning-format",
        "none",
        // Disable thinking by default: on a small CPU model it emits thousands
        // of slow tokens, which is poor UX for guidance.
        "--reasoning-budget",
        "0",
        // Clean model id for the status pill.
        "-a",
        "qwen3-1.7b",
    ]);

    match command.spawn() {
        Ok((mut rx, child)) => {
            app.manage(LlmSidecar(Mutex::new(Some(child))));
            // Drain the event stream so the child never blocks on a full pipe.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stderr(bytes) = event {
                        eprintln!("[llama-server] {}", String::from_utf8_lossy(&bytes));
                    }
                }
            });
            eprintln!("[ghost] llama-server sidecar started on {LLM_HOST}:{LLM_PORT}");
        }
        Err(err) => eprintln!("[ghost] failed to start llama-server: {err}"),
    }
}
