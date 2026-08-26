#!/usr/bin/env bash
# Checks a deployed verifier against the release artifact.
#
# Three questions, in order:
#   1. Does the contract hold the key that the manifest records? The contract
#      stores its key at deployment and has no upgrade path, so this answers
#      which circuit the address verifies for. A contract address alone proves
#      nothing.
#   2. Does it accept the terminal proof? (the positive case)
#   3. Does it reject the same proof when one public input changes? (the
#      negative case)
#
# The proof and the public input byte string come from the aggregator target
# directory, where the prover writes them.
#
# Reads CONTRACT_ID from $1 or from the file that deploy.sh writes.
set -e
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

if [ -n "${1:-}" ]; then
  CONTRACT_ID="$1"
elif [ -f "$CONTRACT_ID_FILE" ]; then
  CONTRACT_ID=$(cat "$CONTRACT_ID_FILE")
else
  echo -e "${RED}Usage: $0 <CONTRACT_ID>  (or run deploy.sh first)${NC}"; exit 1
fi

[ -f "$MANIFEST_FILE" ] || {
  echo -e "${RED}no manifest at $MANIFEST_FILE: this tree holds no release artifact${NC}"; exit 1; }

PUBLIC_INPUTS="$AGG_TARGET/public_inputs"
PROOF="$AGG_TARGET/proof"
[ -f "$PUBLIC_INPUTS" ] && [ -f "$PROOF" ] || {
  echo -e "${RED}no proof in $AGG_TARGET. Prove the aggregator first.${NC}"; exit 1; }

invoke() { # $1 = public_inputs file, $2 = proof file
  stellar contract invoke \
    --id "$CONTRACT_ID" --source "$STELLAR_SOURCE_ACCOUNT" \
    --network "$ZKPOR_NETWORK" --send yes \
    -- verify_proof \
    --public_inputs-file-path "$1" \
    --proof_bytes-file-path "$2"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo -e "${BLUE}[1/3] The stored key must be the key the manifest records${NC}"
stellar contract invoke --id "$CONTRACT_ID" --source "$STELLAR_SOURCE_ACCOUNT" \
  --network "$ZKPOR_NETWORK" -- vk_bytes > "$TMP/vk.json"
STORED_SHA256=$(python3 -c "
import hashlib, json, sys
print(hashlib.sha256(bytes.fromhex(json.load(open(sys.argv[1])))).hexdigest())
" "$TMP/vk.json")
if [ "$STORED_SHA256" = "$(manifest_field aggregator_key_sha256)" ]; then
  echo -e "${GREEN}  PASS: the contract holds the release key ($STORED_SHA256)${NC}"
else
  echo -e "${RED}  FAIL: the contract holds another key ($STORED_SHA256)${NC}"; exit 1
fi

echo -e "${BLUE}[2/3] VALID proof -> expect ACCEPT${NC}"
if invoke "$PUBLIC_INPUTS" "$PROOF"; then
  echo -e "${GREEN}  PASS: valid proof accepted${NC}"
else
  echo -e "${RED}  FAIL: valid proof was rejected${NC}"; exit 1
fi

echo -e "${BLUE}[3/3] The same proof with a changed context_hash -> expect REJECT${NC}"
# The circuit does not constrain context_hash. Only its place in the proof
# transcript rejects this, which is the binding this case exists to check.
python3 "$TAMPER_SCRIPT" "$PUBLIC_INPUTS" "$TMP/pi_foreign" \
  "$(manifest_position context_hash)" \
  "$(manifest_field public_input_bytes)" \
  "$(manifest_field public_input_count)"
if invoke "$TMP/pi_foreign" "$PROOF" 2>/dev/null; then
  echo -e "${RED}  FAIL: a foreign context was accepted${NC}"; exit 1
else
  echo -e "${GREEN}  PASS: a foreign context rejected${NC}"
fi

echo -e "\n${GREEN}Checks passed on $CONTRACT_ID: the stored key matches the manifest, the proof is accepted, and a foreign context is rejected.${NC}"
