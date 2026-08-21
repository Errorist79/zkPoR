#!/usr/bin/env bash
# Build and deploy the registry contract, and show that the wasm on chain is
# the wasm this command produced.
#
# The registry had no deploy path. A contract deployed by hand carries whatever
# the hand that deployed it built, and generation 2 shows what that costs: its
# registry is 65,185 bytes where this command produces 33,364, because it was
# built without the release profile of this workspace, so nobody can rebuild
# what the network runs.
#
# The order is not free. The registry constructor asks the verifier for its
# verification key and refuses unless the key hashes to the value that the
# registry build expects, so a verifier that already carries the release key
# must exist before a registry can be deployed against it.
#
# Two checks run before anything is deployed, and both name which side is
# wrong. The contract makes the same refusal afterwards and names neither.
#
# Usage:
#   bash scripts/deploy_registry.sh [verifier-contract-id]
#
# The verifier comes from the argument, then from ZKPOR_VERIFIER, then from the
# file that scripts/deploy.sh writes.
set -e
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

# An argument that was given and is empty is a caller who meant to name a
# verifier and named none. Falling back to a recorded one would deploy against a
# contract that the caller did not choose, so it stops instead.
if [ "$#" -gt 0 ]; then
  VERIFIER="$1"
  [ -n "$VERIFIER" ] || {
    echo -e "${RED}the verifier argument is empty${NC}"; exit 1; }
else
  VERIFIER="${ZKPOR_VERIFIER:-}"
  [ -n "$VERIFIER" ] || VERIFIER=$(cat "$CONTRACT_ID_FILE" 2>/dev/null || true)
  [ -n "$VERIFIER" ] || {
    echo -e "${RED}no verifier contract. Give one as an argument, set ZKPOR_VERIFIER, or deploy one with scripts/deploy.sh.${NC}"
    exit 1
  }
fi

echo -e "${BLUE}1. Checking the registry source against the manifest...${NC}"
[ -f "$MANIFEST_FILE" ] || {
  echo -e "${RED}no manifest at $MANIFEST_FILE: this tree holds no release artifact${NC}"; exit 1; }
MANIFEST_KEY=$(manifest_field aggregator_key_sha256)
SOURCE_KEY=$(registry_expected_key)
[ "$SOURCE_KEY" = "$MANIFEST_KEY" ] || {
  echo -e "${RED}the registry expects the key $SOURCE_KEY and the manifest records $MANIFEST_KEY${NC}"
  echo -e "${RED}the generated params of the registry are stale; regenerate them before deploying${NC}"
  exit 1; }
echo "  the registry expects the key that the manifest records: $MANIFEST_KEY"

echo -e "${BLUE}2. Checking the verifier $VERIFIER against the manifest...${NC}"
# The key comes from the deployed verifier rather than from a file, because the
# question is what that contract will answer to the constructor.
# The call is not piped. A pipeline reports the status of its last command, so
# piping this through a filter reported success when the call had failed, and
# the run then hashed an empty answer and refused for a reason that named the
# wrong thing.
INVOKE_LOG=$(mktemp)
if ! VERIFIER_KEY_QUOTED=$(stellar contract invoke \
  --id "$VERIFIER" \
  --network "$STELLAR_NETWORK_NAME" \
  --source "$STELLAR_SOURCE_ACCOUNT" \
  --send=no \
  -- vk_bytes 2>"$INVOKE_LOG"); then
  echo -e "${RED}the contract $VERIFIER did not answer vk_bytes, so it is not a verifier${NC}"
  sed 's/^/    /' "$INVOKE_LOG" | head -3
  rm -f "$INVOKE_LOG"
  exit 1
fi
rm -f "$INVOKE_LOG"
VERIFIER_KEY_HEX=${VERIFIER_KEY_QUOTED//\"/}
[ -n "$VERIFIER_KEY_HEX" ] || {
  echo -e "${RED}the contract $VERIFIER answered vk_bytes with nothing${NC}"; exit 1; }
VERIFIER_KEY=$(python3 -c "import hashlib,sys;print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())" "$VERIFIER_KEY_HEX")
[ "$VERIFIER_KEY" = "$MANIFEST_KEY" ] || {
  echo -e "${RED}the verifier holds a key that hashes to $VERIFIER_KEY${NC}"
  echo -e "${RED}the manifest records $MANIFEST_KEY, so this registry cannot be deployed against that verifier${NC}"
  exit 1; }
echo "  the verifier holds the key that the manifest records"

echo -e "${BLUE}3. Ensuring $STELLAR_SOURCE_ACCOUNT is funded...${NC}"
"$ROOT_DIR/scripts/fund_account.sh"

echo -e "${BLUE}4. Building the registry (wasm)...${NC}"
stellar contract build --optimize --package zkpor-registry
BUILT_SHA=$(file_sha256 "$REGISTRY_WASM")
echo "  built $(wc -c < "$REGISTRY_WASM") bytes, sha256 $BUILT_SHA"

echo -e "${BLUE}5. Deploying to $STELLAR_NETWORK_NAME...${NC}"
DEPLOY_OK=0
for attempt in $(seq 1 "$STELLAR_DEPLOY_RETRIES"); do
  echo "  deploy attempt $attempt/$STELLAR_DEPLOY_RETRIES..."
  if REGISTRY_ID=$(stellar contract deploy \
    --wasm "$REGISTRY_WASM" \
    --source "$STELLAR_SOURCE_ACCOUNT" \
    --network "$STELLAR_NETWORK_NAME" \
    -- \
    --verifier "$VERIFIER"); then
    DEPLOY_OK=1; break
  fi
  echo -e "${RED}  deploy failed, retrying in ${STELLAR_DEPLOY_RETRY_INTERVAL}s...${NC}"
  sleep "$STELLAR_DEPLOY_RETRY_INTERVAL"
done
[ "$DEPLOY_OK" -eq 1 ] || { echo -e "${RED}Deploy failed after $STELLAR_DEPLOY_RETRIES attempts.${NC}"; exit 1; }

echo -e "${BLUE}6. Reading back the wasm that the network now runs...${NC}"
# The bytes come from the network. A record written by this script would only
# say what this script believed, and that is the claim under test.
CHAIN_SHA=$(deployed_wasm_sha256 "$REGISTRY_ID") || {
  echo -e "${RED}the network returned no wasm for $REGISTRY_ID${NC}"; exit 1; }
[ "$CHAIN_SHA" = "$BUILT_SHA" ] || {
  echo -e "${RED}the network runs $CHAIN_SHA and this command built $BUILT_SHA${NC}"
  echo -e "${RED}the deployed contract is not the one this command produced${NC}"
  exit 1; }
echo "  the network runs the wasm this command built"

echo "$REGISTRY_ID" > "$REGISTRY_ID_FILE"
echo "$CHAIN_SHA" > "$REGISTRY_SHA_FILE"

echo -e "\n${GREEN}Deployed: $REGISTRY_ID${NC} (saved to $(basename "$REGISTRY_ID_FILE"))"
echo -e "${GREEN}Wasm: $CHAIN_SHA${NC} (saved to $(basename "$REGISTRY_SHA_FILE"))"
echo
echo "Add this record to $(basename "$DEPLOYMENTS_FILE"), so a later reader checks it without asking:"
python3 - "$STELLAR_NETWORK_NAME" "$REGISTRY_ID" "$VERIFIER" "$MANIFEST_KEY" "$CHAIN_SHA" "$MANIFEST_FILE" <<'PYTHON'
import json, math, sys

network, registry, verifier, key, wasm, manifest_path = sys.argv[1:7]
manifest = json.load(open(manifest_path))
depth = int(math.log2(manifest["batch_b"] * manifest["num_batches_k"]))
record = {
    "network": network,
    "registry": registry,
    "verifier": verifier,
    "aggregator_key_sha256": key,
    "tree_depth": depth,
    "registry_wasm_sha256": wasm,
}
print(json.dumps(record, indent=2))
PYTHON
