#!/usr/bin/env bash
# Submit a durable reserve observation or read its stored history.
#
# Usage:
#   observe_reserves.sh submit <asset>
#   observe_reserves.sh status <asset>
#   observe_reserves.sh get <asset> <observation-id>
#
# ZKPOR_REGISTRY selects the registry. The deployment file is the fallback.
# STELLAR_SOURCE_ACCOUNT selects any funded account that pays the transaction fee.
# A submission prints the stored observation after the transaction succeeds.
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"
set -euo pipefail

die() { printf 'observe: %s\n' "$*" >&2; exit 1; }
[[ $# -ge 2 && $# -le 3 ]] || die "use submit, status, or get with an asset"
MODE=$1
ASSET=$2
REGISTRY=${ZKPOR_REGISTRY:-}
if [[ -z "$REGISTRY" && -r "$REGISTRY_ID_FILE" ]]; then
  REGISTRY=$(cat "$REGISTRY_ID_FILE")
fi
[[ -n "$REGISTRY" ]] || die "set ZKPOR_REGISTRY to the registry contract"

invoke() {
  local send=$1
  shift
  stellar contract invoke --id "$REGISTRY" --source "$STELLAR_SOURCE_ACCOUNT" \
    --network "$ZKPOR_NETWORK" --send="$send" -- "$@"
}

case "$MODE" in
  submit)
    [[ $# == 2 ]] || die "submit takes one asset"
    RESULT=$(invoke yes observe_reserves --asset "$ASSET")
    ID=$(printf '%s\n' "$RESULT" | python3 -c \
      'import json,sys;print(int(json.load(sys.stdin)["observation_id"]))')
    invoke no get_observation --asset "$ASSET" --id "$ID"
    ;;
  status)
    [[ $# == 2 ]] || die "status takes one asset"
    invoke no observation_status --asset "$ASSET"
    ;;
  get)
    [[ $# == 3 ]] || die "get needs an asset and an observation identifier"
    invoke no get_observation --asset "$ASSET" --id "$3"
    ;;
  *) die "unknown command: $MODE" ;;
esac
