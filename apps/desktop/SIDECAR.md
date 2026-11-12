# Local model sidecar (Tier 0)

At launch, `src-tauri/src/lib.rs` spawns the bundled `llama-server` with
`std::process::Command`, serving an OpenAI-compatible API on `127.0.0.1:8080`.
The web client's `LocalEngine` talks to it directly.

## Assets

The weights and binaries are git-ignored. Fetch them once (Linux, macOS, or
Windows with Git Bash):

```bash
pnpm fetch-assets
```

This puts the pinned Qwen3-1.7B Q4_K_M at `src-tauri/models/model.gguf` and the
matching `llama-server` plus its shared libraries in `src-tauri/binaries/`. The
pinned release tag and model URL are at the top of `scripts/fetch-assets.sh`.
Where no release build is pinned, it fetches only the model; put `llama-server`
(or `llama-server.exe`) and its `.so`/`.dylib`/`.dll` files in `binaries/` by
hand from a [llama.cpp release](https://github.com/ggml-org/llama.cpp/releases),
with no target-triple suffix.

Without the assets the app still builds and runs; the assistant just reports
the model offline.

## Gotchas

- **Not `externalBin`.** `llama-server` loads sibling shared libraries, and
  `externalBin` ships a single file. So `binaries/` and `models/` ship whole as
  `bundle.resources` and the binary is spawned from there.
- **Shutdown.** On Linux the child gets `PR_SET_PDEATHSIG`, so it dies with the
  app even on SIGKILL. A `RunEvent::Exit` handler covers graceful exit
  elsewhere. Otherwise a crashed app leaves the sidecar holding `:8080`.
- **Port.** Changing it means changing `LLM_PORT` in `lib.rs` and
  `VITE_LOCAL_LLM_URL` in the web client together.
- **Toolchain.** `pnpm desktop` needs `cargo`, plus the Tauri system libraries
  (webkit2gtk etc.) on Linux.
