# Local model sidecar (Tier 0)

The desktop app can bundle a small model and run it locally so guidance works
with **no server and no network** (docs/AGENT_DESIGN.md → "Local model
delivery"). At launch the Rust side spawns a bundled `llama-server` that serves
an OpenAI-compatible API on `127.0.0.1:8080`; the web client's `LocalEngine`
talks to it directly.

## What's already wired

- `Cargo.toml` — depends on `tauri-plugin-shell`.
- `src/lib.rs` — registers the shell plugin and spawns the `llama-server`
  sidecar on startup, pointed at the bundled model on `127.0.0.1:8080`. It is
  **best-effort**: with no binary or weights present it logs a line and the app
  runs normally (the model just shows as offline). Backend spawning is not
  capability-gated, so no `capabilities/` change is needed.
- `LocalEngine` (web) defaults to `http://127.0.0.1:8080` — matches the port above.

## Activation (once, when you have the assets)

Bundling requires large, platform-specific files that are **not committed**, so
the final two config lines are left out of `tauri.conf.json` on purpose: adding
them before the files exist would break `tauri dev`/`build`. Do this to turn it
on:

### 1. Add the binary and model

- Binary → `src-tauri/binaries/llama-server-<target-triple>` (see
  `binaries/README.md`).
- Weights → `src-tauri/models/model.gguf` (see `models/README.md`; an
  Apache-2.0 model such as Qwen3 keeps redistribution clean).

### 2. Declare them in `tauri.conf.json`

Add to the `bundle` object:

```jsonc
"bundle": {
  // …existing keys…
  "externalBin": ["binaries/llama-server"],
  "resources": ["models/model.gguf"]
}
```

`externalBin` names the sidecar **without** the target-triple suffix — Tauri
picks the right file per platform. `resources` ships the weights into the app
bundle so `lib.rs` can resolve them from the resource dir.

### 3. Run it

```bash
pnpm desktop        # requires the Rust toolchain — see repo README
```

The Assistant module's pill should turn from **Model offline** to **Ready** once
`llama-server` has loaded the model.

## Notes

- **Toolchain:** the Rust code only compiles/runs with `cargo` installed. Until
  then, `pnpm desktop` cannot build (the web app and `pnpm dev` are unaffected).
- **Port:** if you change the port, keep `lib.rs` (`LLM_PORT`) and the web
  client's `VITE_LOCAL_LLM_URL` in sync.
- **Web/mobile:** this native sidecar is the desktop path. Web downloads the
  model once and runs it in-browser; mobile uses a native module — both behind
  the same `LocalEngine` interface (docs/AGENT_DESIGN.md).
