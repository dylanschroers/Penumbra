mod db;
mod fs;

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent};

// Tier-0 embedded model. On launch we spawn a bundled `llama-server` that serves
// an OpenAI-compatible API on 127.0.0.1; the web client's LocalEngine talks to it
// directly, so guidance works with no Penumbra server and no network. See
// docs/AGENT_DESIGN.md and apps/desktop/SIDECAR.md.
//
// This is deliberately best-effort: a build without the binary or weights (the
// common dev case) logs a line and carries on. The app still runs; LocalEngine
// just reports the model offline until the assets are dropped in and the sidecar
// is enabled (SIDECAR.md).

// Must match the web client's VITE_LOCAL_LLM_URL default (127.0.0.1:8080).
const LLM_HOST: &str = "127.0.0.1";
const LLM_PORT: u16 = 8080;

/// Holds the running sidecar so we can terminate it when the app exits.
///
/// Teardown is layered, because a single mechanism can't cover every way a dev
/// process dies:
///   1. On Linux the child is given `PR_SET_PDEATHSIG` at spawn, so the kernel
///      kills it when we die *for any reason* — clean exit, panic, SIGKILL, an
///      IDE "stop". This is the case that used to leak an orphan holding :8080.
///   2. The `RunEvent::Exit` handler kills it explicitly on a graceful shutdown,
///      and is the primary safety net on platforms without PR_SET_PDEATHSIG
///      (macOS, Windows).
struct LlmSidecar(Mutex<Option<Child>>);

impl LlmSidecar {
    fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            db::db_exec,
            fs::fs_list,
            fs::fs_move,
            fs::fs_read_head,
            fs::fs_read_chunk
        ])
        .setup(|app| {
            // Native persistence must come up before the webview asks for data;
            // unlike the sidecar this is not best-effort (see db.rs).
            db::open(app)?;
            spawn_llm_sidecar(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // Kill the sidecar as the event loop tears down. PR_SET_PDEATHSIG already
    // covers the abrupt-death cases on Linux; this is the graceful path and the
    // main guarantee elsewhere.
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(sidecar) = app.try_state::<LlmSidecar>() {
                sidecar.kill();
            }
        }
    });
}

fn spawn_llm_sidecar(app: tauri::AppHandle) {
    let resolve = |rel: &str| app.path().resolve(rel, BaseDirectory::Resource);

    // The model, shipped as a Tauri resource (SIDECAR.md). Absent in a build
    // without the weights — skip gracefully so the app still runs.
    let model = match resolve("models/model.gguf") {
        Ok(path) if path.exists() => path,
        _ => {
            eprintln!("[penumbra] no bundled model found; local LLM sidecar not started");
            return;
        }
    };

    // The bundled llama-server. It is not a single file: it loads sibling shared
    // libraries (.so via rpath=$ORIGIN on Linux, .dll next to the .exe on
    // Windows), so the binary and its libs are bundled together under
    // resources/binaries/ and spawned from there (SIDECAR.md).
    let server_rel = if cfg!(windows) {
        "binaries/llama-server.exe"
    } else {
        "binaries/llama-server"
    };
    let server = match resolve(server_rel) {
        Ok(path) if path.exists() => path,
        _ => {
            eprintln!("[penumbra] llama-server binary not bundled; sidecar not started");
            return;
        }
    };

    let mut command = Command::new(&server);
    command
        .args([
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
        ])
        // Discard stdout, capture stderr so we can surface llama-server logs and
        // the child never blocks on a full pipe.
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // Tie the child's lifetime to ours at the OS level so it can never outlive the
    // app — even on a crash or SIGKILL, where no Rust teardown runs. Linux
    // delivers the death signal when the parent *thread* dies; setup runs on the
    // main thread, which lives for the whole process, so that's the process
    // lifetime in practice.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id();
        // SAFETY: pre_exec runs in the forked child before exec; it only calls
        // async-signal-safe libc functions (prctl, getppid, _exit).
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Race guard: if the parent already died before prctl armed, the
                // death signal will never arrive — exit now instead of orphaning.
                if libc::getppid() as u32 != parent {
                    libc::_exit(0);
                }
                Ok(())
            });
        }
    }

    match command.spawn() {
        Ok(mut child) => {
            // Drain stderr on a background thread so a full pipe never blocks the
            // child, and forward the lines the way the old sidecar plumbing did.
            if let Some(stderr) = child.stderr.take() {
                thread::spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        eprintln!("[llama-server] {line}");
                    }
                });
            }
            app.manage(LlmSidecar(Mutex::new(Some(child))));
            eprintln!("[penumbra] llama-server sidecar started on {LLM_HOST}:{LLM_PORT}");
        }
        Err(err) => eprintln!("[penumbra] failed to start llama-server: {err}"),
    }
}
