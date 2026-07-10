#!/usr/bin/env bash
# Fetch the Tier-0 embedded-model assets (llama-server binary + GGUF weights)
# into the desktop app's git-ignored drop-in dirs. Idempotent — safe to re-run.
# See apps/desktop/SIDECAR.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI="$ROOT/apps/desktop/src-tauri"
BIN_DIR="$TAURI/binaries"
MODEL_DIR="$TAURI/models"

# Pinned versions — bump deliberately (keep in sync with SIDECAR.md).
LLAMA_VERSION="b9950"
MODEL_URL="https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf"
MODEL_PATH="$MODEL_DIR/model.gguf"

mkdir -p "$BIN_DIR" "$MODEL_DIR"

# --- model weights (platform-agnostic) ---
if [ -f "$MODEL_PATH" ]; then
  echo "✓ model present: $MODEL_PATH"
else
  echo "↓ downloading model (~1.3 GB)…"
  curl -L --fail -o "$MODEL_PATH" "$MODEL_URL"
  if [ "$(head -c 4 "$MODEL_PATH")" != "GGUF" ]; then
    echo "✗ downloaded file is not a valid GGUF" >&2
    rm -f "$MODEL_PATH"
    exit 1
  fi
  echo "✓ model saved: $MODEL_PATH"
fi

# --- llama-server binary + its shared libs (platform-specific) ---
if [ -x "$BIN_DIR/llama-server" ]; then
  echo "✓ llama-server present: $BIN_DIR/llama-server"
else
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os/$arch" in
    Linux/x86_64) asset="llama-${LLAMA_VERSION}-bin-ubuntu-x64.tar.gz" ;;
    *)
      echo "✗ no automatic llama-server download for $os/$arch." >&2
      echo "  Grab it from https://github.com/ggml-org/llama.cpp/releases/tag/${LLAMA_VERSION}" >&2
      echo "  and place llama-server + its libraries in $BIN_DIR (see binaries/README.md)." >&2
      exit 1 ;;
  esac
  url="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${asset}"
  echo "↓ downloading llama-server ($asset)…"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -L --fail -o "$tmp/llama.tar.gz" "$url"
  tar -xzf "$tmp/llama.tar.gz" -C "$tmp"
  # The archive extracts to a build dir holding the binary next to its libs.
  src="$(dirname "$(find "$tmp" -name llama-server -type f | head -1)")"
  cp "$src/llama-server" "$BIN_DIR/"
  cp "$src"/*.so* "$BIN_DIR/" 2>/dev/null || true
  chmod +x "$BIN_DIR/llama-server"
  echo "✓ llama-server + libs saved to $BIN_DIR"
fi

echo "Done. Next: pnpm desktop"
