#!/usr/bin/env bash
# =============================================================================
# registry-gate.sh: end-to-end attestation gate for the registry contract.
#
# The unit tests of contracts/registry run against a stub verifier and a stub
# token, so they show what the registry builds and decides. They cannot show
# that a real proof passes a real verifier through the registry, and they
# cannot show that a real balance read behaves as the specification says. This
# gate does both on a localnet.
#
# Cases, all gated on the on-chain result:
#   honest         -> a proof produced for the context that the registry holds
#                     is accepted, and the registry records the attestation
#   foreigncontext -> the same proof, submitted with another snapshot ledger,
#                     is refused. The registry derives the context itself, so
#                     this exercises the binding through the component that
#                     builds the public inputs
#   unregistered   -> an attestation for an asset with no registry entry is
#                     refused with AssetNotRegistered
#   observation    -> the read-only reading answers the minted amount
#
# The failed balance read stays in the unit tests. A reserve address here is a
# custom account contract. The pinned command line can sign an authorization
# entry, but it collects a signer only for a top-level Address argument
# (stellar-cli 27.0.0, cmd/soroban-cli/src/commands/contract/arg_parsing.rs).
# A reserve sits inside a Vec<Address>, so no command line invocation signs
# the entry of a second account. A contract address that holds no balance
# entry answers a true zero rather than a failure, so this gate cannot
# produce a failed read.
#
# The custom account is a convenience for this localnet harness only. It does
# not exercise the path of a real reserve, which is an ordinary account that
# signs its authorization entry. A run on a public network must register an
# ordinary account as the reserve and must sign its entry with the JavaScript
# SDK (authorizeEntry). A pass of this gate is not evidence for that path.
#
# Environment (all optional):
#   SOROBAN_RPC      localnet RPC (default http://localhost:8000/soroban/rpc)
#   START_LOCALNET   =1 to start the localnet container if the RPC is unreachable
# =============================================================================
set -uo pipefail
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$GATE_DIR/../.." && pwd)"
NET="${SOROBAN_NET:-local}"
RPC="${SOROBAN_RPC:-http://localhost:8000/soroban/rpc}"

REC="$REPO_ROOT/circuits/recursion"
REGISTRY_CRATE="$REPO_ROOT/contracts/registry"
CUSTOMERS_FILE="$REC/inner/fixtures/customers_below_capacity.csv"
CONTEXT_FILE="$REPO_ROOT/circuits/recursion/.registry-gate-context.toml"
WORK="$REPO_ROOT/circuits/recursion/.registry-gate"
ASSET_CODE="USDX"
# Stroops of the asset that the issuer mints to the reserve address.
RESERVE_PAYMENT="1000"
# How long a consent of this gate stays valid. One run takes minutes, and a
# localnet closes a ledger every few seconds, so this covers a run.
AUTH_EXPIRATION_LEDGERS=1000

die() { echo; echo "########## REGISTRY-GATE FAIL: $* ##########" >&2; exit 1; }
note() { echo "[registry-gate] $*"; }

current_ledger() {
  curl -s -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' "$RPC" \
    | sed -nE 's/.*"sequence":([0-9]+).*/\1/p'
}

for bin in nargo bb stellar cargo python3; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool on PATH: $bin"
done

# The localnet image tag and the protocol version come from the pinned file.
# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/versions.env"
# shellcheck source=/dev/null
. "$GATE_DIR/lib.sh"

mkdir -p "$WORK"
echo "=== REGISTRY-GATE START $(date -u) ==="
ensure_localnet

# -----------------------------------------------------------------------------
# 1. Identities, the classic asset, and one funded reserve account
# -----------------------------------------------------------------------------
key() { # name -> the address, creating the identity on first use
  stellar keys address "$1" 2>/dev/null || {
    stellar keys generate --fund --network "$NET" "$1" >/dev/null 2>&1
    stellar keys address "$1"
  }
}
ISSUER=$(key registry-gate-issuer) || die "issuer identity"
ASSET_NAME="$ASSET_CODE:$ISSUER"
note "issuer=$ISSUER"

stellar contract asset deploy --asset "$ASSET_NAME" --source registry-gate-issuer \
  --network "$NET" >/dev/null 2>&1 || true
ASSET=$(stellar contract id asset --asset "$ASSET_NAME" --network "$NET") \
  || die "asset contract id"
note "asset contract=$ASSET"

# The reserve address is a custom account, because a reserve address must
# authorize its own registration, and the command line collects no signer for
# an address inside a vector argument. One signer therefore drives the whole
# run. A real reserve is an ordinary account, so this contract stands in for
# it only on a localnet.
cargo build --release --target wasm32v1-none \
  --manifest-path "$GATE_DIR/reserve-account/Cargo.toml" >/dev/null 2>&1 \
  || die "reserve account build"
RESERVE_WASM="$GATE_DIR/reserve-account/target/wasm32v1-none/release/gate_reserve_account.wasm"
[ -f "$RESERVE_WASM" ] || die "no reserve account wasm at $RESERVE_WASM"
RESERVE=$(stellar contract deploy --wasm "$RESERVE_WASM" --source registry-gate-issuer \
  --network "$NET" 2>/dev/null | tail -1) || die "reserve account deploy"
note "reserve=$RESERVE"

# The issuer administers the asset contract of its own classic asset, so it
# mints the balance that the reserve address holds.
stellar contract invoke --id "$ASSET" --source registry-gate-issuer --network "$NET" \
  --send yes -- mint --to "$RESERVE" --amount "$RESERVE_PAYMENT" >/dev/null 2>&1 \
  || die "mint to the reserve address"

# The serialized Asset XDR of the classic asset: the asset type, the code, the
# public key type of the issuer, and the issuer key. The registry derives the
# canonical asset contract address from these bytes.
SERIALIZED=$(python3 "$REPO_ROOT/scripts/classic_asset.py" "$ASSET_CODE" "$ISSUER") \
  || die "serialized asset"

# -----------------------------------------------------------------------------
# 2. Deploy the verifier with the committed key, then the registry
# -----------------------------------------------------------------------------
bash "$REPO_ROOT/scripts/deploy.sh" >/dev/null || die "verifier deploy"
VERIFIER=$(cat "$REPO_ROOT/.contract_id.recursion") || die "verifier id"
note "verifier=$VERIFIER"

cargo build --release --target wasm32v1-none --manifest-path "$REGISTRY_CRATE/Cargo.toml" \
  >/dev/null 2>&1 || die "registry wasm build"
REGISTRY_WASM="$REPO_ROOT/target/wasm32v1-none/release/zkpor_registry.wasm"
[ -f "$REGISTRY_WASM" ] || die "no registry wasm at $REGISTRY_WASM"
REGISTRY=$(stellar contract deploy --wasm "$REGISTRY_WASM" --source registry-gate-issuer \
  --network "$NET" -- --verifier "$VERIFIER" 2>/dev/null | tail -1) \
  || die "registry deploy (the constructor refuses a verifier that holds another key)"
note "registry=$REGISTRY"

# -----------------------------------------------------------------------------
# 3. Register the asset under its issuer, with one reserve address
# -----------------------------------------------------------------------------
# The issuer signs the transaction, and the authorization entry of the reserve
# address carries no signature, because a custom account answers for itself.
# The transaction is built and signed in steps, because the one-step invoke
# looks for a signing key for every entry and finds none for a contract.
registry_invoke() { # args...
  local tx
  tx=$(stellar contract invoke --id "$REGISTRY" --source registry-gate-issuer \
    --network "$NET" --build-only -- "$@") || return 1
  tx=$(echo "$tx" | stellar tx simulate --source-account registry-gate-issuer \
    --network "$NET") || return 1
  # A recorded entry carries the expiration zero, and the host refuses that
  # before it reads any signature. The command line fills the field in only
  # for an entry that it signs, so the entry of the custom account needs this
  # step.
  tx=$(echo "$tx" | stellar tx decode \
    | python3 "$GATE_DIR/set_auth_expiration.py" "$(($(current_ledger) + AUTH_EXPIRATION_LEDGERS))" \
    | stellar tx encode) || return 1
  tx=$(echo "$tx" | stellar tx sign --sign-with-key registry-gate-issuer \
    --network "$NET") || return 1
  echo "$tx" | stellar tx send --network "$NET"
}

REGISTERED=$(registry_invoke register_asset --asset "$ASSET" --authority "$ISSUER" \
  --authenticity "{\"Classic\":\"$SERIALIZED\"}" --reserves "[\"$RESERVE\"]" 2>&1) \
  || die "register_asset: $REGISTERED"
note "asset registered"

# -----------------------------------------------------------------------------
# 4. Prove for the context that the registry now holds
# -----------------------------------------------------------------------------
SNAPSHOT=$(current_ledger)
[ -n "$SNAPSHOT" ] || die "cannot read the current ledger"
note "snapshot ledger=$SNAPSHOT"

cat > "$CONTEXT_FILE" <<EOF
# Written by the registry gate for one run. The addresses are the identities
# that this run created on the localnet.
authority = "$ISSUER"
asset = "$ASSET"
reserves = ["$RESERVE"]
snapshot_ledger = $SNAPSHOT
EOF

# The gate proves and submits through the issuer flow itself, so the honest
# case measures the script that an issuer runs, and not a copy of its steps.
# The flow refuses the fixture secret and every file under a fixtures
# directory, so this run derives its own secret and writes its own copy of the
# customer rows.
GATE_SECRET_FILE="$WORK/master.secret"
( umask 077; printf '0x%s' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  > "$GATE_SECRET_FILE" ) || die "cannot write the master secret of this run"
GATE_CUSTOMERS="$WORK/customers.csv"
cp "$CUSTOMERS_FILE" "$GATE_CUSTOMERS" || die "cannot copy the customer rows"

# The flow writes the package of every customer before it removes the salts,
# and a package names the registry of a deployment record. This run deploys its
# own registry, so it writes its own record and never touches the committed
# file.
CAPACITY=$(python3 -c "
import re,sys
text = open(sys.argv[1]).read()
value = lambda name: int(re.search(rf'^{name} *= *([0-9]+)', text, re.M).group(1))
print(value('batch_b') * value('num_batches_k'))" "$REC/params.toml") \
  || die "cannot read the tree capacity from params.toml"
DEPTH=$(python3 -c "print(int($CAPACITY).bit_length() - 1)")
cat > "$WORK/deployments.json" <<EOF
[
  {
    "network": "$NET",
    "registry": "$REGISTRY",
    "verifier": "$VERIFIER",
    "tree_depth": $DEPTH
  }
]
EOF

HONEST=$(ZKPOR_MASTER_SECRET_FILE="$GATE_SECRET_FILE" ZKPOR_REGISTRY="$REGISTRY" \
  ZKPOR_WORK="$WORK" STELLAR_SOURCE_ACCOUNT=registry-gate-issuer \
  ZKPOR_NETWORK="$NET" ZKPOR_DEPLOYMENTS="$WORK/deployments.json" \
  bash "$REPO_ROOT/scripts/attest.sh" "$CONTEXT_FILE" "$GATE_CUSTOMERS" 2>&1) \
  || die "the issuer flow did not reach an accepted attestation: $HONEST"
note "honest ACCEPT through scripts/attest.sh"
[ -d "$WORK/packages" ] || die "the flow removed the salts without writing the packages"
note "the packages of the customers exist"
[ -f "$WORK/proof" ] || die "the flow left no proof at $WORK/proof"

# The root and the total of the run come from the public input string that the
# prover wrote, so this gate never states them itself.
read -r FINAL_ROOT TOTAL < <(python3 "$REPO_ROOT/scripts/public_input_fields.py" \
  "$WORK/public_inputs" "$REC/manifest.json") || die "read the public inputs"
note "final_root=$FINAL_ROOT L=$TOTAL"

# -----------------------------------------------------------------------------
# 5. The cases
# -----------------------------------------------------------------------------
submit() { # asset snapshot_ledger
  stellar contract invoke --id "$REGISTRY" --source registry-gate-issuer --network "$NET" \
    --send yes -- submit_attestation --asset "$1" --snapshot_ledger "$2" \
    --final_root "$FINAL_ROOT" --total_liabilities "$TOTAL" \
    --proof-file-path "$WORK/proof" 2>&1
}

# The number of each contract error comes from the contract source, so a
# renumbered variant cannot leave a case matching an error that moved.
error_code() { # variant name
  sed -nE "s/^ *$1 = ([0-9]+),.*/\\1/p" "$REGISTRY_CRATE/src/lib.rs"
}
expect_refusal() { # case output variant
  local expected
  expected=$(error_code "$3")
  [ -n "$expected" ] || die "$1: no error number for $3 in the contract source"
  echo "$2" | grep -q "Error(Contract, #$expected)" \
    || die "$1: the call failed, and not with $3 (number $expected): $2"
  note "$1 REJECT with $3"
}

# The same proof under another snapshot ledger. The registry derives the
# context itself, so the verifier sees a public input string it never proved.
FOREIGN=$(submit "$ASSET" "$((SNAPSHOT - 1))") \
  && die "foreigncontext: the registry accepted a proof of another context: $FOREIGN"
expect_refusal foreigncontext "$FOREIGN" ProofRejected

# A case that fails for another reason must not satisfy the matcher above.
UNKNOWN=$(submit "$RESERVE" "$SNAPSHOT") \
  && die "unregistered: the registry attested an asset with no entry: $UNKNOWN"
expect_refusal unregistered "$UNKNOWN" AssetNotRegistered
echo "$UNKNOWN" | grep -q "Error(Contract, #$(error_code ProofRejected))" \
  && die "the matcher does not separate the two refusals"

# The record and the reading are read field by field, because a value can
# appear anywhere inside an output.
field() { # json path
  python3 -c "
import json,sys
value = json.load(sys.stdin)
for step in sys.argv[1].split('.'):
    value = value[step]
print(value)" "$1"
}

ENTRY=$(stellar contract invoke --id "$REGISTRY" --source registry-gate-issuer \
  --network "$NET" -- entry --asset "$ASSET" 2>/dev/null)
RECORDED=$(echo "$ENTRY" | field attestation.Filled.reserve_sum) \
  || die "the record carries no attestation: $ENTRY"
[ "$RECORDED" = "$RESERVE_PAYMENT" ] \
  || die "the record carries the reserve sum $RECORDED, and the reserve holds $RESERVE_PAYMENT"
note "the registry recorded the attestation with the reserve sum"

OBSERVED=$(stellar contract invoke --id "$REGISTRY" --source registry-gate-issuer \
  --network "$NET" -- observe_reserves --asset "$ASSET" 2>/dev/null)
SUM=$(echo "$OBSERVED" | field observed_sum) || die "the observation has no sum: $OBSERVED"
[ "$SUM" = "$RESERVE_PAYMENT" ] \
  || die "the observation carries the sum $SUM, and the reserve holds $RESERVE_PAYMENT"
note "observation carries the current sum"

echo "=== REGISTRY-GATE PASS: honest ACCEPT, foreigncontext REJECT, unregistered REJECT, record and observation read $(date -u) ==="
