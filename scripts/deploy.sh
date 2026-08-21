#!/usr/bin/env bash
# Build + optimize the verifier contract and deploy it with the release
# aggregator verification key set at construction.
#
# It deploys the key that the generated manifest records, and nothing else. A
# development artifact has no manifest, so it cannot reach a contract here.
#
# NOTE: On Stellar CLI 27.0.0, `stellar contract build --optimize` optimizes the
# wasm in place (the standalone `stellar contract optimize` is deprecated here).
set -e
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

echo -e "${BLUE}1. Checking the release artifact against the manifest...${NC}"
[ -f "$MANIFEST_FILE" ] || {
  echo -e "${RED}no manifest at $MANIFEST_FILE: this tree holds no release artifact${NC}"; exit 1; }
[ -f "$RELEASE_KEY" ] || {
  echo -e "${RED}no verification key at $RELEASE_KEY${NC}"; exit 1; }
KEY_SHA256=$(file_sha256 "$RELEASE_KEY")
[ "$KEY_SHA256" = "$(manifest_field aggregator_key_sha256)" ] || {
  echo -e "${RED}the key to deploy is not the key the manifest records${NC}"; exit 1; }
[ "$(wc -c < "$RELEASE_KEY")" -eq "$(manifest_field aggregator_key_bytes)" ] || {
  echo -e "${RED}the key length does not match the manifest${NC}"; exit 1; }
echo "  batch_b=$(manifest_field batch_b) num_batches_k=$(manifest_field num_batches_k)"
echo "  bb=$(manifest_field bb_version) nargo=$(manifest_field nargo_version)"
echo "  aggregator key sha256=$KEY_SHA256"

echo -e "${BLUE}2. Ensuring $STELLAR_SOURCE_ACCOUNT is funded...${NC}"
"$ROOT_DIR/scripts/fund_account.sh"

echo -e "${BLUE}3. Building + optimizing the verifier contract (wasm)...${NC}"
stellar contract build --optimize

echo -e "${BLUE}4. Deploying to $STELLAR_NETWORK_NAME...${NC}"
DEPLOY_OK=0
for attempt in $(seq 1 "$STELLAR_DEPLOY_RETRIES"); do
  echo "  deploy attempt $attempt/$STELLAR_DEPLOY_RETRIES..."
  if CONTRACT_ID=$(stellar contract deploy \
    --wasm "$CONTRACT_WASM" \
    --source "$STELLAR_SOURCE_ACCOUNT" \
    --network "$STELLAR_NETWORK_NAME" \
    -- \
    --vk_bytes-file-path "$RELEASE_KEY"); then
    DEPLOY_OK=1; break
  fi
  echo -e "${RED}  deploy failed, retrying in ${STELLAR_DEPLOY_RETRY_INTERVAL}s...${NC}"
  sleep "$STELLAR_DEPLOY_RETRY_INTERVAL"
done
[ "$DEPLOY_OK" -eq 1 ] || { echo -e "${RED}Deploy failed after $STELLAR_DEPLOY_RETRIES attempts.${NC}"; exit 1; }

echo "$CONTRACT_ID" > "$CONTRACT_ID_FILE"
echo -e "\n${GREEN}Deployed: $CONTRACT_ID${NC} (saved to $(basename "$CONTRACT_ID_FILE"))"
