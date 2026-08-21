#!/usr/bin/env bash
# Check the wasm hashes that the deployments file records, in one of two ways.
#
# The two modes answer different questions and fail for different reasons.
#
#   --network  For every record, fetch the wasm that the contract runs and
#              compare it with the hash the record states. This catches a record
#              that no longer describes the network, which is what happened: a
#              registry went on chain that nothing in this repository builds.
#
#   --local    Build the contracts at this revision and compare the result with
#              the hashes of the newest record. This catches a source that moved
#              after a deploy, which is the quieter failure of the two, because
#              nobody has to do anything for it to happen. It reaches no network,
#              so the agreement job runs it.
#
# A mismatch in either mode is a reproducibility failure and not a behaviour
# failure. It says that the record and the code no longer agree. It does not say
# that what the network runs is wrong.
#
# Usage:
#   bash scripts/check_deployment.sh --local
#   STELLAR_NETWORK_NAME=testnet bash scripts/check_deployment.sh --network
set -e
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

MODE="${1:---local}"
case "$MODE" in
  --local|--network) ;;
  *) echo -e "${RED}usage: check_deployment.sh [--local|--network]${NC}"; exit 2 ;;
esac

[ -f "$DEPLOYMENTS_FILE" ] || {
  echo -e "${RED}no deployments file at $DEPLOYMENTS_FILE${NC}"; exit 1; }

FAILED=0
state() { # name, expected, found
  if [ "$2" = "$3" ]; then
    echo -e "  ${GREEN}$1 agrees${NC}: $2"
  else
    echo -e "  ${RED}$1 disagrees${NC}"
    echo "    the record states $2"
    echo "    the answer is    $3"
    FAILED=1
  fi
}

if [ "$MODE" = "--local" ]; then
  echo -e "${BLUE}Building both contracts at this revision...${NC}"
  BUILD_LOG=$(mktemp)
  stellar contract build --optimize >"$BUILD_LOG" 2>&1 || {
    echo -e "${RED}the build failed${NC}"; cat "$BUILD_LOG"; rm -f "$BUILD_LOG"; exit 1; }
  rm -f "$BUILD_LOG"

  # The newest record of each network is the one this revision should build. An
  # earlier record describes an earlier source and is not a claim about now.
  while read -r NETWORK REGISTRY_SHA VERIFIER_SHA; do
    echo -e "${BLUE}The newest record of $NETWORK...${NC}"
    state "the registry wasm" "$REGISTRY_SHA" "$(file_sha256 "$REGISTRY_WASM")"
    state "the verifier wasm" "$VERIFIER_SHA" "$(file_sha256 "$CONTRACT_WASM")"
  done < <(python3 - "$DEPLOYMENTS_FILE" <<'PYTHON'
import json, sys

records = json.load(open(sys.argv[1]))
newest = {}
for record in records:
    newest[record["network"]] = record
for network, record in newest.items():
    print(network, record["registry_wasm_sha256"], record["verifier_wasm_sha256"])
PYTHON
  )
else
  echo -e "${BLUE}Reading back every contract that the file records...${NC}"
  while read -r NETWORK REGISTRY REGISTRY_SHA VERIFIER VERIFIER_SHA; do
    [ "$NETWORK" = "$STELLAR_NETWORK_NAME" ] || continue
    echo -e "${BLUE}The record that names $REGISTRY...${NC}"
    state "the registry wasm" "$REGISTRY_SHA" "$(deployed_wasm_sha256 "$REGISTRY" || echo unreadable)"
    state "the verifier wasm" "$VERIFIER_SHA" "$(deployed_wasm_sha256 "$VERIFIER" || echo unreadable)"
  done < <(python3 - "$DEPLOYMENTS_FILE" <<'PYTHON'
import json, sys

for record in json.load(open(sys.argv[1])):
    print(
        record["network"],
        record["registry"],
        record["registry_wasm_sha256"],
        record["verifier"],
        record["verifier_wasm_sha256"],
    )
PYTHON
  )
fi

[ "$FAILED" -eq 0 ] || {
  echo -e "\n${RED}DEPLOYMENT CHECK FAIL${NC}"; exit 1; }
echo -e "\n${GREEN}DEPLOYMENT CHECK PASS${NC}"
