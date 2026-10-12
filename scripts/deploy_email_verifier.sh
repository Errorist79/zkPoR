#!/usr/bin/env bash
# Deploy the shared verifier with the email verification key.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

python3 "$ROOT_DIR/scripts/check_pins.py"
"$ROOT_DIR/scripts/fund_account.sh"
stellar contract build --optimize --package ultrahonk-verifier
BUILT_SHA=$(file_sha256 "$CONTRACT_WASM")
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$CONTRACT_WASM" \
  --source "$STELLAR_SOURCE_ACCOUNT" \
  --network "$ZKPOR_NETWORK" \
  -- --vk_bytes-file-path "$EMAIL_RELEASE_KEY")
CHAIN_SHA=$(deployed_wasm_sha256 "$CONTRACT_ID")
[ "$CHAIN_SHA" = "$BUILT_SHA" ] || {
  echo "The deployed email verifier bytes do not match the build." >&2
  exit 1
}
KEY_QUOTED=$(stellar contract invoke --id "$CONTRACT_ID" \
  --source "$STELLAR_SOURCE_ACCOUNT" --network "$ZKPOR_NETWORK" --send=no -- vk_bytes)
CHAIN_KEY=$(python3 -c 'import hashlib,json,sys;print(hashlib.sha256(bytes.fromhex(json.loads(sys.argv[1]))).hexdigest())' "$KEY_QUOTED")
[ "$CHAIN_KEY" = "$(file_sha256 "$EMAIL_RELEASE_KEY")" ] || {
  echo "The deployed email verifier key does not match the local key." >&2
  exit 1
}
printf '%s\n' "$CONTRACT_ID" > "$EMAIL_CONTRACT_ID_FILE"
printf 'Email verifier: %s\nWasm SHA256: %s\nKey SHA256: %s\n' "$CONTRACT_ID" "$CHAIN_SHA" "$CHAIN_KEY"
