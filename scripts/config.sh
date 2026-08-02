#!/usr/bin/env bash
# Shared configuration for the localnet build / deploy / verify scripts.
# Adapted from the yugocabrio reference.
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT_DIR/.env" ]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi
source "$ROOT_DIR/scripts/versions.env"

# Network profile: local (default) / testnet / mainnet.
export STELLAR_NETWORK_NAME="${STELLAR_NETWORK_NAME:-local}"
case "$STELLAR_NETWORK_NAME" in
  testnet)
    export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
    export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
    ;;
  mainnet)
    export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://mainnet.sorobanrpc.com}"
    export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Public Global Stellar Network ; September 2015}"
    ;;
  *)
    export STELLAR_RPC_URL="${STELLAR_RPC_URL:-http://localhost:8000/soroban/rpc}"
    export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"
    ;;
esac

export STELLAR_DEPLOY_RETRIES="${STELLAR_DEPLOY_RETRIES:-24}"
export STELLAR_DEPLOY_RETRY_INTERVAL="${STELLAR_DEPLOY_RETRY_INTERVAL:-10}"
export STELLAR_HEALTH_RETRIES="${STELLAR_HEALTH_RETRIES:-120}"
export STELLAR_HEALTH_RETRY_INTERVAL="${STELLAR_HEALTH_RETRY_INTERVAL:-1}"

export STELLAR_SOURCE_ACCOUNT="${STELLAR_SOURCE_ACCOUNT:-alice}"
export STELLAR_CONTAINER_NAME="${STELLAR_CONTAINER_NAME:-stellar-local}"

# Build artifacts. The package "ultrahonk-verifier" emits ultrahonk_verifier.wasm.
# `stellar contract build --optimize` ($STELLAR_CLI_VERSION) optimizes it in place.
export CONTRACT_WASM="$ROOT_DIR/target/wasm32v1-none/release/ultrahonk_verifier.wasm"

# The release artifact. One aggregator circuit produces one verification key,
# the manifest records what that key is, and deploy.sh records where it went.
export MANIFEST_FILE="$ROOT_DIR/circuits/recursion/manifest.json"
export RELEASE_KEY="$ROOT_DIR/circuits/recursion/agg/vk"
export AGG_TARGET="$ROOT_DIR/circuits/recursion/agg/target"
export CONTRACT_ID_FILE="$ROOT_DIR/.contract_id.recursion"
export REGISTRY_ID_FILE="$ROOT_DIR/.contract_id.registry"
export TAMPER_SCRIPT="$ROOT_DIR/scripts/tamper_public_input.py"

# One field of the manifest. Both the deploy path and the verify path read the
# artifact identity from there, and never from a value written in a script.
manifest_field() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" \
    "$MANIFEST_FILE" "$1"
}

# The position of one public input inside the byte string.
manifest_position() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['public_input_positions'][sys.argv[2]])" \
    "$MANIFEST_FILE" "$1"
}

export RED='\033[0;31m'; export GREEN='\033[0;32m'; export BLUE='\033[0;34m'; export NC='\033[0m'
