#!/usr/bin/env bash
# Fetch the Tier-0 embedded-model assets (llama-server binary + GGUF weights)
# into the desktop app's git-ignored drop-in dirs. Idempotent — safe to re-run.
# Works on Linux, macOS, and Windows (Git Bash). See apps/desktop/SIDECAR.md.
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
# Pick the release asset and the names the binary + libraries carry here.
os="$(uname -s)"; arch="$(uname -m)"
server_bin="llama-server"
case "$os/$arch" in
  Linux/x86_64)   asset="llama-${LLAMA_VERSION}-bin-ubuntu-x64.tar.gz";  libs="so" ;;
  Darwin/arm64)   asset="llama-${LLAMA_VERSION}-bin-macos-arm64.tar.gz"; libs="dylib" ;;
  Darwin/x86_64)  asset="llama-${LLAMA_VERSION}-bin-macos-x64.tar.gz";   libs="dylib" ;;
  MINGW*/x86_64 | MSYS*/x86_64 | CYGWIN*/x86_64)
    asset="llama-${LLAMA_VERSION}-bin-win-cpu-x64.zip"
    libs="dll"; server_bin="llama-server.exe" ;;
  MINGW*/aarch64 | MSYS*/aarch64 | MINGW*/arm64 | MSYS*/arm64)
    asset="llama-${LLAMA_VERSION}-bin-win-cpu-arm64.zip"
    libs="dll"; server_bin="llama-server.exe" ;;
  *)
    echo "! no automatic llama-server download for $os/$arch."
    echo "  Grab a build from https://github.com/ggml-org/llama.cpp/releases/tag/${LLAMA_VERSION}"
    echo "  and place $server_bin + its libraries in $BIN_DIR (see binaries/README.md)."
    echo "✓ model is in place; only the binary is left to add."
    exit 0 ;;
esac

if [ -e "$BIN_DIR/$server_bin" ]; then
  echo "✓ llama-server present: $BIN_DIR/$server_bin"
else
  url="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${asset}"
  echo "↓ downloading llama-server ($asset)…"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -L --fail -o "$tmp/$asset" "$url"
  case "$asset" in
    *.tar.gz) tar -xzf "$tmp/$asset" -C "$tmp" ;;
    *.zip)
      # Git Bash doesn't always ship unzip; Windows' own bsdtar reads zips.
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "$tmp/$asset" -d "$tmp"
      elif [ -x "/c/Windows/System32/tar.exe" ]; then
        /c/Windows/System32/tar.exe -xf "$(cygpath -w "$tmp/$asset")" -C "$(cygpath -w "$tmp")"
      else
        echo "✗ need 'unzip' or C:\\Windows\\System32\\tar.exe to extract $asset" >&2
        exit 1
      fi ;;
  esac
  # The archive extracts to a build dir holding the binary next to its libs.
  src="$(dirname "$(find "$tmp" -name "$server_bin" -type f | head -1)")"
  cp "$src/$server_bin" "$BIN_DIR/"
  cp "$src"/*."$libs"* "$BIN_DIR/" 2>/dev/null || true
  chmod +x "$BIN_DIR/$server_bin"
  echo "✓ llama-server + libs saved to $BIN_DIR"
fi

echo "Done. Next: pnpm desktop"
