#!/usr/bin/env bash
# The registration flow: one asset, one authority, and the consent of every
# reserve address.
#
# usage:
#   register_asset.sh --classic <CODE:ISSUER> <asset-contract> <reserve>...
#   register_asset.sh --contract <asset-contract> <reserve>...
#
# Tier 1 registers a classic Stellar asset. The registry derives the canonical
# asset contract address from the serialized asset and compares it with the
# address that this script passes, so a wrong pair fails on-chain. Tier 2
# registers a contract token, and the registry asks the token for its
# administrator.
#
# Every reserve address must authorize the call. The address sits inside a
# vector argument, and the command line collects a signer only for a top-level
# address argument, so the command line cannot produce that signature. This
# script builds the transaction, simulates it, and then signs the entry of each
# reserve address with the client library command line. The authority signs the
# transaction at the end.
#
# A reserve argument is the name of an identity of the command line keystore.
# The script reads the secret with `stellar keys show` at the moment it signs,
# and passes it in one environment variable. No secret reaches a file, the
# output, or the history of the shell. Never write a secret on the command
# line, because the history keeps it.
#
# A reserve address that another party holds does not need this machine. Build
# and simulate here, send that party the envelope, let them run the signer
# against their own key, and take the envelope back. The signature covers the
# invocation, so a returned envelope needs no trust.
#
# Environment:
#   ZKPOR_REGISTRY          the registry contract, or .contract_id.registry
#   STELLAR_SOURCE_ACCOUNT  the identity of the authority
#   ZKPOR_NETWORK    local (default), testnet, or mainnet
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"
# The shared configuration turns on exit-on-error. This script reports every
# failure with its own reason instead, so it turns that off again.
set +e -uo pipefail

ZKPOR_CLI="$ROOT_DIR/sdk/dist/cli.js"

die() { echo -e "\n${RED}register: $*${NC}" >&2; exit 1; }
note() { echo -e "${BLUE}[register]${NC} $*"; }

case "${1:-}" in
  --classic)
    [ $# -ge 4 ] || die "usage: register_asset.sh --classic <CODE:ISSUER> <asset-contract> <reserve>..."
    CLASSIC="$2"; ASSET="$3"; shift 3
    CODE="${CLASSIC%%:*}"; ISSUER_KEY="${CLASSIC##*:}"
    [ "$CODE" != "$CLASSIC" ] || die "the classic asset reads CODE:ISSUER"
    SERIALIZED=$(python3 "$ROOT_DIR/scripts/classic_asset.py" "$CODE" "$ISSUER_KEY") \
      || die "cannot serialize the asset $CLASSIC"
    AUTHENTICITY="{\"Classic\":\"$SERIALIZED\"}"
    ;;
  --contract)
    [ $# -ge 3 ] || die "usage: register_asset.sh --contract <asset-contract> <reserve>..."
    ASSET="$2"; shift 2
    AUTHENTICITY='"Contract"'
    ;;
  *) die "the first argument is --classic <CODE:ISSUER> or --contract" ;;
esac
RESERVES=("$@")

REGISTRY="${ZKPOR_REGISTRY:-}"
[ -n "$REGISTRY" ] || REGISTRY=$(cat "$REGISTRY_ID_FILE" 2>/dev/null)
[ -n "$REGISTRY" ] || die "set ZKPOR_REGISTRY to the registry contract"
for bin in stellar node python3; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool on PATH: $bin"
done
[ -f "$ZKPOR_CLI" ] || die "no built command line at $ZKPOR_CLI; run npm run build --workspace sdk"

# The authority is the account that the chain authenticates. The registry
# records it, and it must equal the issuer of a classic asset.
AUTHORITY=$(stellar keys address "$STELLAR_SOURCE_ACCOUNT" 2>/dev/null) \
  || die "cannot read the address of $STELLAR_SOURCE_ACCOUNT"

# The addresses of the reserve identities, in the order of the arguments. The
# registry sorts the set itself, so this order carries no meaning on-chain.
RESERVE_ADDRESSES=()
for name in "${RESERVES[@]}"; do
  address=$(stellar keys address "$name" 2>/dev/null) \
    || die "cannot read the address of the reserve identity $name"
  RESERVE_ADDRESSES+=("$address")
done
LIST=$(printf '"%s",' "${RESERVE_ADDRESSES[@]}")
LIST="[${LIST%,}]"

LEDGER=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' "$STELLAR_RPC_URL" \
  | sed -nE 's/.*"sequence":([0-9]+).*/\1/p')
[ -n "$LEDGER" ] || die "cannot read the current ledger from $STELLAR_RPC_URL"
# How long the consent of a reserve address stays valid. The client library
# holds the one definition of that margin, so this script reads it instead of
# repeating the number.
MARGIN=$(node "$ZKPOR_CLI" consent-validity-ledgers) \
  || die "cannot read the validity margin of a reserve consent"
VALID_UNTIL=$((LEDGER + MARGIN))

note "registry=$REGISTRY asset=$ASSET authority=$AUTHORITY reserves=${#RESERVE_ADDRESSES[@]}"

# The transaction passes from step to step as one base64 string, and every step
# writes its notes on the error stream. The notes stay in this file, because a
# note that reaches the standard output would enter the string and break the
# next decoding.
NOTES=$(mktemp) || die "cannot open a file for the notes of the command line"
trap 'rm -f "$NOTES"' EXIT

# The simulation fills the resources and writes one authorization entry for each
# address that the call needs. The entry of the authority uses source-account
# credentials, and the entry of a reserve address waits for a signature.
TX=$(stellar contract invoke --id "$REGISTRY" --source "$STELLAR_SOURCE_ACCOUNT" \
  --network "$ZKPOR_NETWORK" --build-only -- register_asset \
  --asset "$ASSET" --authority "$AUTHORITY" --authenticity "$AUTHENTICITY" \
  --reserves "$LIST" 2>"$NOTES") || die "cannot build the registration:\n$(cat "$NOTES")"
TX=$(echo "$TX" | stellar tx simulate --source-account "$STELLAR_SOURCE_ACCOUNT" \
  --network "$ZKPOR_NETWORK" 2>"$NOTES") || die "the simulation failed:\n$(cat "$NOTES")"

for index in "${!RESERVE_ADDRESSES[@]}"; do
  address="${RESERVE_ADDRESSES[$index]}"
  name="${RESERVES[$index]}"
  secret=$(stellar keys show "$name" 2>"$NOTES") \
    || die "cannot read the secret key of $name:\n$(cat "$NOTES")"
  TX=$(echo "$TX" | ZKPOR_RESERVE_SECRET="$secret" node "$ZKPOR_CLI" \
    sign-entry-in-transaction "$address" "$VALID_UNTIL" "$STELLAR_NETWORK_PASSPHRASE" \
    2>"$NOTES") || die "the reserve $address did not sign:\n$(cat "$NOTES")"
  unset secret
  note "reserve $address signed its entry, valid until ledger $VALID_UNTIL"
done

TX=$(echo "$TX" | stellar tx sign --sign-with-key "$STELLAR_SOURCE_ACCOUNT" \
  --network "$ZKPOR_NETWORK" 2>"$NOTES") \
  || die "the authority did not sign:\n$(cat "$NOTES")"
# The signature covers the transaction, so the hash that the signing step
# reports is the hash of the submitted transaction. A reader of this run needs
# it to find that transaction on the chain.
TRANSACTION=$(sed -nE 's/.*Signing transaction: ([0-9a-f]{64}).*/\1/p' "$NOTES" | tail -1)

RESULT=$(echo "$TX" | stellar tx send --network "$ZKPOR_NETWORK" 2>"$NOTES") \
  || die "the registration failed:\n$(cat "$NOTES")\n$RESULT"
if [ -n "$TRANSACTION" ]; then
  note "transaction $TRANSACTION"
else
  # The hash is a convenience for a reader and no input to the
  # registration, so a parse that finds none must not stop a run that the
  # chain accepted. It must also not look like a run that printed nothing.
  note "the signing step named no transaction hash, so this run reports none"
fi

# The registry answers with its own record, so this reads the result from the
# chain and never from the output of the submission.
ENTRY=$(stellar contract invoke --id "$REGISTRY" --source "$STELLAR_SOURCE_ACCOUNT" \
  --network "$ZKPOR_NETWORK" -- entry --asset "$ASSET" 2>/dev/null) \
  || die "the registry holds no entry for $ASSET after the registration"
echo "$ENTRY"
echo -e "\n${GREEN}The registry holds the entry of $ASSET.${NC}"
