# Sidecar binaries

Drop the `llama-server` executable here, named with the Rust **target triple**
suffix that Tauri expects for an `externalBin`:

```
llama-server-<target-triple>[.exe]
```

Find your triple with `rustc -Vv | grep host`. Examples:

| Platform | File name |
|---|---|
| Linux x86_64 | `llama-server-x86_64-unknown-linux-gnu` |
| macOS Apple Silicon | `llama-server-aarch64-apple-darwin` |
| macOS Intel | `llama-server-x86_64-apple-darwin` |
| Windows x86_64 | `llama-server-x86_64-pc-windows-msvc.exe` |

Get the binary from a [llama.cpp release](https://github.com/ggml-org/llama.cpp/releases)
(the `llama-server` build) or build it yourself, then rename it as above and
`chmod +x` it on Unix.

The actual binaries are git-ignored (they are large and platform-specific). See
[../../SIDECAR.md](../../SIDECAR.md) for the full activation steps.
