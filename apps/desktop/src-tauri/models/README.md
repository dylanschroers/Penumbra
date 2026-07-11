# Bundled model

Drop the GGUF weights here as:

```
model.gguf
```

(That exact name is what `src/lib.rs` resolves at runtime; the whole directory
ships via the `models/*` resources entry in `tauri.conf.json`. To use a
different name, update the `resolve("models/model.gguf", …)` call. The easy
path is `pnpm fetch-assets`, which downloads the pinned weights here.)

## Recommended model

A small **Apache-2.0** instruct model, so the weights can be redistributed under
the repo's own Apache-2.0 license — e.g. **Qwen3** (0.6B / 1.7B) at Q4. A ~1.7B
Q4 GGUF is roughly 1 GB.

The weights are git-ignored (large; not committed). See
[../../SIDECAR.md](../../SIDECAR.md) for the full activation steps.
