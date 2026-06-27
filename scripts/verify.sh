#!/usr/bin/env bash
# Verifier check on $CIRCUIT: a valid proof must be ACCEPTED; a tampered proof
# and tampered public inputs (e.g. a wrong total L) must be REJECTED.
# Reads CONTRACT_ID from $1 or .contract_id.$CIRCUIT.
set -e
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

if [ -n "${1:-}" ]; then
  CONTRACT_ID="$1"
elif [ -f "$CONTRACT_ID_FILE" ]; then
  CONTRACT_ID=$(cat "$CONTRACT_ID_FILE")
else
  echo -e "${RED}Usage: $0 <CONTRACT_ID>  (or run deploy.sh first)${NC}"; exit 1
fi

PUBLIC_INPUTS="$DATASET_DIR/public_inputs"
PROOF="$DATASET_DIR/proof"
[ -f "$PUBLIC_INPUTS" ] && [ -f "$PROOF" ] || { echo -e "${RED}Missing artifacts in $DATASET_DIR${NC}"; exit 1; }

invoke() { # $1 = public_inputs file, $2 = proof file
  stellar contract invoke \
    --id "$CONTRACT_ID" --source "$STELLAR_SOURCE_ACCOUNT" \
    --network "$STELLAR_NETWORK_NAME" --send yes \
    -- verify_proof \
    --public_inputs-file-path "$1" \
    --proof_bytes-file-path "$2"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo -e "${BLUE}[1/3] VALID proof -> expect ACCEPT${NC}"
if invoke "$PUBLIC_INPUTS" "$PROOF"; then
  echo -e "${GREEN}  PASS: valid proof accepted${NC}"
else
  echo -e "${RED}  FAIL: valid proof was rejected${NC}"; exit 1
fi

echo -e "${BLUE}[2/3] TAMPERED proof -> expect REJECT${NC}"
cp "$PROOF" "$TMP/proof_bad"
python3 - "$TMP/proof_bad" <<'PY'
import sys
d = bytearray(open(sys.argv[1], "rb").read())
for i in (5000, 5001, 7000, 9000):
    if i < len(d):
        d[i] ^= 0xFF
open(sys.argv[1], "wb").write(d)
PY
if invoke "$PUBLIC_INPUTS" "$TMP/proof_bad" 2>/dev/null; then
  echo -e "${RED}  FAIL: tampered proof was accepted${NC}"; exit 1
else
  echo -e "${GREEN}  PASS: tampered proof rejected${NC}"
fi

echo -e "${BLUE}[3/3] TAMPERED public inputs (wrong total) -> expect REJECT${NC}"
cp "$PUBLIC_INPUTS" "$TMP/pi_bad"
# Flip a byte in the LAST 32-byte field of the public inputs, corrupting the
# last committed value so verification must reject.
python3 - "$TMP/pi_bad" <<'PY'
import sys
d = bytearray(open(sys.argv[1], "rb").read())
assert len(d) >= 32 and len(d) % 32 == 0, f"unexpected public_inputs length {len(d)}"
d[len(d) - 1] ^= 0x01  # perturb the last public-input field
open(sys.argv[1], "wb").write(d)
PY
if invoke "$TMP/pi_bad" "$PROOF" 2>/dev/null; then
  echo -e "${RED}  FAIL: tampered public inputs were accepted${NC}"; exit 1
else
  echo -e "${GREEN}  PASS: tampered public inputs rejected${NC}"
fi

echo -e "\n${GREEN}Checks passed on '$CIRCUIT': valid accepted; tampered proof and tampered public inputs rejected.${NC}"
