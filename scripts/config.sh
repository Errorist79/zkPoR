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
# `stellar contract build --optimize` (26.1.0) optimizes it in place.
export CONTRACT_WASM="$ROOT_DIR/target/wasm32v1-none/release/ultrahonk_verifier.wasm"

# CIRCUIT selects which circuit's VK/proof to deploy and verify (the VK is set
# per verifier instance at deploy). Contract id is tracked per circuit.
export CIRCUIT="${CIRCUIT:-simple_circuit}"
export DATASET_DIR="$ROOT_DIR/circuits/$CIRCUIT/target"
export CONTRACT_ID_FILE="$ROOT_DIR/.contract_id.$CIRCUIT"
export BUILD_CIRCUITS_SCRIPT="$ROOT_DIR/circuits/scripts/build_all.sh"

export RED='\033[0;31m'; export GREEN='\033[0;32m'; export BLUE='\033[0;34m'; export NC='\033[0m'
