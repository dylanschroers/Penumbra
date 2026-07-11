# Sidecar binaries

This directory is bundled into the app as a Tauri resource (`bundle.resources`
in `tauri.conf.json`). At startup the Rust side spawns `llama-server` from here
— see `../src/lib.rs` and [../../SIDECAR.md](../../SIDECAR.md).

The easy path is `pnpm fetch-assets`, which fills this directory on Linux,
macOS, and Windows (Git Bash). To do it by hand instead, drop in:

| Platform | Files |
|---|---|
| Linux | `llama-server` + its `*.so*` libraries |
| macOS | `llama-server` + its `*.dylib` libraries |
| Windows | `llama-server.exe` + its `*.dll` libraries |

Use the plain names above — no target-triple suffix. (That convention belongs
to Tauri's `externalBin`, which we deliberately don't use: `llama-server` loads
sibling shared libraries, so the whole directory ships as resources and the
binary is spawned from there, where it finds its libs next to itself.)

Get the files from a [llama.cpp release](https://github.com/ggml-org/llama.cpp/releases)
(the binary and its libraries sit together in the archive's build dir), and
`chmod +x llama-server` on Unix.

The actual binaries are git-ignored (large and platform-specific); only this
README is committed.
