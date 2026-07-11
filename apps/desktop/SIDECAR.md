# Local model sidecar (Tier 0)

The desktop app bundles a small model and runs it locally so guidance works with
**no server and no network** (docs/AGENT_DESIGN.md → "Local model delivery"). At
launch the Rust side spawns the bundled `llama-server`, which serves an
OpenAI-compatible API on `127.0.0.1:8080`; the web client's `LocalEngine` talks
to it directly.

## How it's wired

- `Cargo.toml` — depends on `tauri-plugin-shell`.
- `tauri.conf.json` → `bundle.resources` — ships everything in `binaries/`
  (the server **and its shared libraries**) and `models/` into the app bundle.
  Directory globs, so a build without the assets still succeeds; the sidecar
  simply doesn't start.
- `src/lib.rs` — registers the shell plugin and, on startup, resolves the
  bundled `llama-server` (`llama-server.exe` on Windows) + model from the
  resource dir and spawns the server with the guidance flags
  (`--jinja --reasoning-format none --reasoning-budget 0`). It is
  **best-effort**: if the binary or weights are missing it logs a line and the
  app runs normally (the model just shows offline). Backend spawning is not
  capability-gated, so no `capabilities/` change is needed.
- `LocalEngine` (web) defaults to `http://127.0.0.1:8080` — matches the port.

### Why not `externalBin`

`llama-server` is **not a single file** — it loads sibling shared libraries
(`.so` via rpath `$ORIGIN` on Linux, `.dll` next to the `.exe` on Windows,
`.dylib` on macOS). Tauri's `externalBin` ships one file, which would strand the
libraries. So instead we bundle the whole `binaries/` dir as `resources` and
spawn the binary from there with `shell().command(path)`, so it finds its
libraries next to itself.

## The assets (not committed)

Large, platform-specific files are git-ignored. One command fetches both,
idempotently, on Linux, macOS, and Windows (Git Bash):

```bash
pnpm fetch-assets   # scripts/fetch-assets.mjs → finds a bash, runs fetch-assets.sh
```

It downloads the pinned Qwen3-1.7B Q4_K_M weights → `src-tauri/models/model.gguf`
and the matching `llama-server` build + its libraries → `src-tauri/binaries/`.
On platforms without a pinned release build it fetches the model and points you
to `binaries/README.md` for the manual step.

The app builds and runs without the assets — the Assistant pill just shows
**Model offline** — so fetching is only needed to exercise the local model.

## Run it

```bash
pnpm desktop        # requires the Rust toolchain (cargo)
```

The Assistant module's pill turns from **Model offline** to **Ready ·
qwen3-1.7b** once `llama-server` has loaded the model.

## Notes

- **Toolchain:** needs `cargo` on PATH. On Linux also the Tauri system
  libraries (webkit2gtk etc.). The web app and `pnpm dev` don't.
- **Port:** if you change it, keep `lib.rs` (`LLM_PORT`) and the web client's
  `VITE_LOCAL_LLM_URL` in sync.
- **Pinned versions:** the llama.cpp release tag and model URL live at the top
  of `scripts/fetch-assets.sh`; bump them deliberately.
- **Web/mobile:** this native sidecar is the desktop path. Web downloads the
  model once and runs it in-browser; mobile uses a native module — both behind
  the same `LocalEngine` interface (docs/AGENT_DESIGN.md).
