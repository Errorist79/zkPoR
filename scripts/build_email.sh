#!/usr/bin/env bash
# Build the email circuit with its separate compiler and pin its verification key.
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT_DIR/scripts/versions.env"
: "${ZKPOR_EMAIL_NARGO:?set ZKPOR_EMAIL_NARGO to the beta.5 executable}"
EMAIL_NARGO_ACTUAL=$("$ZKPOR_EMAIL_NARGO" --version)
EMAIL_NARGO_FIRST_LINE=${EMAIL_NARGO_ACTUAL%%$'\n'*}
EMAIL_BB_ACTUAL=$(bb --version)
[[ "$EMAIL_NARGO_FIRST_LINE" == "nargo version = $EMAIL_NARGO_VERSION" ]] || { echo "the email compiler differs from the pin" >&2; exit 1; }
[[ "$EMAIL_BB_ACTUAL" == "${BB_VERSION#v}" ]] || { echo "the email prover differs from the pin" >&2; exit 1; }
cd "$ROOT_DIR/circuits/email"
"$ZKPOR_EMAIL_NARGO" compile
bb write_vk --scheme "$PROOF_SCHEME" --oracle_hash "$TERMINAL_ORACLE_HASH" \
  -b target/zkpor_email.json --output_path target/key --output_format bytes_and_fields
node "$ROOT_DIR/tools/email/pin_key.mjs" target/zkpor_email.json target/key/vk
