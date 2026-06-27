#!/usr/bin/env bash
# Bootstrap the exact pinned toolchain on a fresh (Linux) machine.
# Idempotent: skips anything already present. Versions come from versions.env.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/versions.env"

echo "### Rust toolchain (rust-toolchain.toml pins ${RUST_VERSION} + wasm32v1-none) ###"
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
( cd "$ROOT_DIR" && rustup show >/dev/null )   # triggers toolchain + target install
rustc --version

echo "### nargo ${NARGO_VERSION} ###"
if [ ! -x "$HOME/.nargo/bin/nargo" ]; then
  curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
  "$HOME/.nargo/bin/noirup" -v "${NARGO_VERSION}"
fi
"$HOME/.nargo/bin/nargo" --version | head -1

echo "### bb ${BB_VERSION} ###"
if [ ! -x "$HOME/.bb/bin/bb" ]; then
  mkdir -p "$HOME/.bb/bin"
  uname_m=$(uname -m)
  case "$(uname -s)_${uname_m}" in
    Linux_x86_64)  file="barretenberg-amd64-linux.tar.gz" ;;
    Darwin_arm64)  file="barretenberg-arm64-darwin.tar.gz" ;;
    Darwin_x86_64) file="barretenberg-amd64-darwin.tar.gz" ;;
    *) echo "unsupported platform"; exit 1 ;;
  esac
  curl -L "https://github.com/AztecProtocol/aztec-packages/releases/download/${BB_VERSION}/${file}" -o /tmp/bb.tar.gz
  tar -xzf /tmp/bb.tar.gz -C "$HOME/.bb/bin"
  chmod +x "$HOME/.bb/bin/bb"
fi
"$HOME/.bb/bin/bb" --version

echo "### stellar-cli ${STELLAR_CLI_VERSION} (must match Protocol ${PROTOCOL_VERSION}) ###"
NEED_STELLAR=1
if command -v stellar >/dev/null 2>&1 && stellar --version | grep -q "stellar ${STELLAR_CLI_VERSION}"; then NEED_STELLAR=0; fi
if [ "$NEED_STELLAR" -eq 1 ]; then
  mkdir -p "$HOME/.local/bin"
  url="https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
  curl -fL "$url" -o /tmp/stellar.tar.gz
  tar -xzf /tmp/stellar.tar.gz -C "$HOME/.local/bin"
  chmod +x "$HOME/.local/bin/stellar"
fi
echo "PATH must include \$HOME/.local/bin \$HOME/.nargo/bin \$HOME/.bb/bin \$HOME/.cargo/bin"
"$HOME/.local/bin/stellar" --version 2>/dev/null | head -1 || stellar --version | head -1

echo "### Done. Pinned toolchain ready. ###"
