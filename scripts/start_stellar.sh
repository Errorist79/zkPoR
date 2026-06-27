#!/usr/bin/env bash
# Start a Protocol 26 localnet (quickstart "future" image) and register the
# network profile. Adapted from the yugocabrio reference.
set -e
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

echo -e "${BLUE}Starting Stellar localnet container ($STELLAR_CONTAINER_NAME, Protocol $PROTOCOL_VERSION)...${NC}"
stellar container start -t "$QUICKSTART_IMAGE_TAG" --name "$STELLAR_CONTAINER_NAME" --limits unlimited "$@"

echo -e "${BLUE}Configuring network profile ($STELLAR_NETWORK_NAME)...${NC}"
stellar network add "$STELLAR_NETWORK_NAME" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" 2>/dev/null || true
stellar network use "$STELLAR_NETWORK_NAME"

echo -e "${BLUE}Waiting for local network to become healthy...${NC}"
for i in $(seq 1 "$STELLAR_HEALTH_RETRIES"); do
  OUT=$(stellar network health 2>&1 || true)
  [[ "$OUT" == *"Unhealthy"* ]] && { sleep "$STELLAR_HEALTH_RETRY_INTERVAL"; continue; }
  break
done
stellar network health --output json

# Friendbot becomes ready AFTER the RPC reports healthy; fund calls fail with a
# JSON parse error until it is up. Wait for it explicitly (reference behavior).
echo -e "${BLUE}Waiting for friendbot...${NC}"
for i in $(seq 1 "$STELLAR_HEALTH_RETRIES"); do
  FB=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:8000/friendbot?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHG" 2>/dev/null || echo "000")
  if [ "$FB" != "502" ] && [ "$FB" != "000" ]; then
    echo -e "${GREEN}✓ Friendbot ready (HTTP $FB)${NC}"; break
  fi
  sleep "$STELLAR_HEALTH_RETRY_INTERVAL"
done

echo -e "${GREEN}Stellar localnet is running.${NC}"
