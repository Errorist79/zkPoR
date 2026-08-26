#!/usr/bin/env bash
# Generate and fund the source account. Adapted from the yugocabrio reference.
set -e
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

if [[ "$ZKPOR_NETWORK" != "local" ]]; then
  stellar network add "$ZKPOR_NETWORK" \
    --rpc-url "$STELLAR_RPC_URL" \
    --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" 2>/dev/null || true
fi

echo -e "${BLUE}Ensuring identity '$STELLAR_SOURCE_ACCOUNT'...${NC}"
stellar keys generate "$STELLAR_SOURCE_ACCOUNT" 2>/dev/null || true

echo -e "${BLUE}Funding '$STELLAR_SOURCE_ACCOUNT' on '$ZKPOR_NETWORK'...${NC}"
FUNDED=0
for i in $(seq 1 "$STELLAR_HEALTH_RETRIES"); do
  OUT=$(stellar keys fund "$STELLAR_SOURCE_ACCOUNT" --network "$ZKPOR_NETWORK" 2>&1) && { FUNDED=1; break; }
  # Already-funded accounts return a friendbot error; treat as success.
  if echo "$OUT" | grep -qiE "already funded|op_already_exists|createAccountAlreadyExist"; then
    echo -e "${GREEN}  account already funded${NC}"; FUNDED=1; break
  fi
  echo -e "${RED}  funding failed (attempt $i), retrying...${NC}"; sleep "$STELLAR_HEALTH_RETRY_INTERVAL"
done
[ "$FUNDED" -eq 1 ] || { echo -e "${RED}Failed to fund account.${NC}"; exit 1; }

stellar keys address "$STELLAR_SOURCE_ACCOUNT"
