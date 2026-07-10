# Local model sidecar (Tier 0)

The desktop app bundles a small model and runs it locally so guidance works with
**no server and no network** (docs/AGENT_DESIGN.md → "Local model delivery"). At
launch the Rust side spawns the bundled `llama-server`, which serves an
OpenAI-compatible API on `127.0.0.1:8080`; the web client's `LocalEngine` talks
to it directly.

## How it's wired

- `Cargo.toml` — depends on `tauri-plugin-shell`.
- `tauri.conf.json` → `bundle.resources` — ships the binary, **its `.so`
  libraries**, and the model into the app bundle.
- `src/lib.rs` — registers the shell plugin and, on startup, resolves the
  bundled `llama-server` + model from the resource dir and spawns the server with
  the guidance flags (`--jinja --reasoning-format none --reasoning-budget 0`).
  It is **best-effort**: if the binary or weights are missing it logs a line and
  the app runs normally (the model just shows offline). Backend spawning is not
  capability-gated, so no `capabilities/` change is needed.
- `LocalEngine` (web) defaults to `http://127.0.0.1:8080` — matches the port.

### Why not `externalBin`

`llama-server` is **not a single file** — it loads ~38 sibling `.so` libraries
via rpath `$ORIGIN`. Tauri's `externalBin` ships one file, which would strand the
libraries. So instead we bundle the whole `binaries/` dir (binary + `.so`s) as
`resources` and spawn the binary from there with `shell().command(path)`, so
`$ORIGIN` finds the libraries next to it.

## The assets (not committed)

Large, platform-specific files are git-ignored, so a fresh clone must fetch them
before `pnpm desktop` will build (the `resources` globs require them to exist):

- **Binary + libs** → `src-tauri/binaries/` — the `llama-server` build for your
  platform plus its `.so`s (see `binaries/README.md`).
- **Weights** → `src-tauri/models/model.gguf` — an Apache-2.0 model such as
  Qwen3 keeps redistribution clean (see `models/README.md`).

> TODO: a `fetch-model` / `fetch-binary` script so this is one command.

## Run it

```bash
pnpm desktop        # requires the Rust toolchain (cargo) + Tauri Linux libs
```

The Assistant module's pill turns from **Model offline** to **Ready ·
qwen3-1.7b** once `llama-server` has loaded the model.

## Notes

- **Toolchain:** needs `cargo` on PATH (`source ~/.cargo/env`) and the Tauri
  Linux system libraries (webkit2gtk etc.). The web app and `pnpm dev` don't.
- **Port:** if you change it, keep `lib.rs` (`LLM_PORT`) and the web client's
  `VITE_LOCAL_LLM_URL` in sync.
- **Web/mobile:** this native sidecar is the desktop path. Web downloads the
  model once and runs it in-browser; mobile uses a native module — both behind
  the same `LocalEngine` interface.
