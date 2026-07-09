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
        .setup(|app| {
            spawn_llm_sidecar(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn spawn_llm_sidecar(app: tauri::AppHandle) {
    // The model, shipped as a Tauri resource (SIDECAR.md). Absent in dev builds
    // without the weights dropped in — skip gracefully.
    let model = match app
        .path()
        .resolve("models/model.gguf", BaseDirectory::Resource)
    {
        Ok(path) if path.exists() => path,
        _ => {
            eprintln!("[ghost] no bundled model found; local LLM sidecar not started");
            return;
        }
    };

    // The bundled llama-server binary (Tauri externalBin, SIDECAR.md). Returns
    // Err until externalBin is configured — treated as "not enabled yet".
    let command = match app.shell().sidecar("llama-server") {
        Ok(cmd) => cmd.args([
            "--model",
            &model.to_string_lossy(),
            "--host",
            LLM_HOST,
            "--port",
            &LLM_PORT.to_string(),
        ]),
        Err(err) => {
            eprintln!("[ghost] llama-server sidecar not configured: {err}");
            return;
        }
    };

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
