#!/usr/bin/env bash
# Build circuits, build + optimize the verifier contract, deploy it with the
# circuit VK set at construction.
#
# NOTE: On Stellar CLI 27.0.0, `stellar contract build --optimize` optimizes the
# wasm in place (the standalone `stellar contract optimize` is deprecated here).
set -e
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

echo -e "${BLUE}1. Ensuring $STELLAR_SOURCE_ACCOUNT is funded...${NC}"
"$ROOT_DIR/scripts/fund_account.sh"

echo -e "${BLUE}2. Building circuit '$CIRCUIT' (proof / vk / public_inputs)...${NC}"
bash "$BUILD_CIRCUITS_SCRIPT" "$CIRCUIT"

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
    --vk_bytes-file-path "$DATASET_DIR/vk"); then
    DEPLOY_OK=1; break
  fi
  echo -e "${RED}  deploy failed, retrying in ${STELLAR_DEPLOY_RETRY_INTERVAL}s...${NC}"
  sleep "$STELLAR_DEPLOY_RETRY_INTERVAL"
done
[ "$DEPLOY_OK" -eq 1 ] || { echo -e "${RED}Deploy failed after $STELLAR_DEPLOY_RETRIES attempts.${NC}"; exit 1; }

echo "$CONTRACT_ID" > "$CONTRACT_ID_FILE"
echo -e "\n${GREEN}Deployed: $CONTRACT_ID${NC} (saved to $(basename "$CONTRACT_ID_FILE"))"
