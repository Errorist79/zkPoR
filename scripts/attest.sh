#!/usr/bin/env bash
# The issuer flow: a customer file becomes an accepted attestation.
#
# usage: attest.sh <context.toml> <customers.csv>
#
# Everything runs on the machine that the issuer controls. This script takes
# no address for any intermediate value, and the project runs no service that
# could receive one, so no setting can send them anywhere. What leaves the
# machine is one transaction: the four public inputs, which are two hashes,
# one root and one total, and the proof bytes.
#
# Every run removes the balances, the salts, and the witnesses when it ends,
# and every ending does it: a return, a failure, and an interrupt, a
# termination, or a hang-up signal. The tools of the run stop first, because a
# sweep is worth nothing while a tool that writes those files is still running.
#
# A kill that cannot be caught and a power loss run nothing at all, so they
# reach neither the stop nor the sweep. The sweep at the start of the next run
# covers what they leave, and until a run starts, it stays on disk. A tool that
# outlives such a kill also keeps writing, and nothing here reaches it.
#
# Nothing is kept on disk for a diagnosis, because the files hold the salt of
# every customer in the snapshot.
#
# The context file describes the attestation:
#
#   authority       = "G..."     the issuer account or the administrator
#   asset           = "C..."     the asset contract
#   reserves        = ["G...", "C..."]
#   snapshot_ledger = 12345      the ledger at which the liabilities freeze
#
# The values must equal the entry that the registry holds, because the
# registry derives the context hash from its own state, and a proof of another
# context does not verify.
#
# The master secret arrives as a file that the issuer keeps, and never in a
# file of this repository. It never enters a witness. A run without it fails,
# and a run with the test fixture secret fails, because those salts are public.
# The run writes the package of every customer before it removes the salts, so
# a secret that this shell alone holds stops the run instead of stranding the
# customers.
#
# This script is one step of the work. The issuer still does these by hand:
#
#   - deploy the verifier and the registry, and record the registry address.
#     Registration runs in scripts/register_asset.sh;
#   - produce the customer file from its own records, and freeze the liability
#     set at the ledger that the context names;
#   - generate the master secret from a random source, keep it, and rotate it;
#   - fund the account that pays the fee, and read the result of the
#     transaction;
#   - deliver the inclusion package of each customer to that customer.
#
# Environment:
#   ZKPOR_MASTER_SECRET_FILE  required. A file of mode 600 that holds 32
#                             random bytes as hexadecimal.
#   ZKPOR_REGISTRY       the registry contract, or .contract_id.registry
#   STELLAR_SOURCE_ACCOUNT  the identity of the authority
#   STELLAR_NETWORK_NAME    local (default), testnet, or mainnet
#   ZKPOR_WORK           where the run keeps its files
#   ZKPOR_PACKAGES_OUT   where the packages of the customers land
#   ZKPOR_DEPLOYMENTS    the deployment records, or scripts/deployments.json
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"
# The shared configuration turns on exit-on-error. This script reports every
# failure with its own reason instead, so it turns that off again.
set +e -uo pipefail
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

REC="$ROOT_DIR/circuits/recursion"
INNER="$REC/inner"; AGG="$REC/agg"; ATGT="$AGG/target"; OUT="$INNER/out"
GEN="$ROOT_DIR/tools/recursion-gen"
WORK="${ZKPOR_WORK:-$REC/.attest}"
PACKAGES_OUT="${ZKPOR_PACKAGES_OUT:-$WORK}"
# The package points every customer at a registry, and this file is where that
# address comes from. A localnet harness deploys its own registry, so it names
# its own file.
DEPLOYMENTS="${ZKPOR_DEPLOYMENTS:-$ROOT_DIR/scripts/deployments.json}"
FIXTURE_SECRET_FILE="$ROOT_DIR/fixtures/test_only_master_secret.env"
# The public secret of the gates. The value stands here, and not only in the
# file, because a guard that a deleted file switches off is no guard. The
# check below compares the file with this copy, so the two cannot drift.
FIXTURE_SECRET="0x7a6b706f722d746573742d6f6e6c792d6d61737465722d736563726574212121"
# The proof of the release configuration takes minutes, and a network closes a
# ledger every few seconds. A run that starts with less than this much window
# left would prove a snapshot that expires before the transaction arrives, so
# it stops instead.
PROVING_MARGIN_LEDGERS=120

die() { echo -e "\n${RED}attest: $*${NC}" >&2; exit 1; }
note() { echo -e "${BLUE}[attest]${NC} $*"; }

# The tools of a run are started and stopped by one shared file, which a test
# sources and drives with a tool of its own. The guarantees live there with the
# reasoning behind them.
source "$(dirname "${BASH_SOURCE[0]}")/run_tools.sh"

# The prover inputs hold the identifier, the balance, and the salt of every
# customer in the snapshot. The sweep therefore runs on every ending that lets
# this script run anything: a return, a failure through die, and an interrupt,
# a termination, or a hang-up signal. A kill that cannot be caught and a power
# loss run nothing, and the sweep at the start of the next run covers those.
#
# The proof and the public inputs stay in the work directory, because a
# resubmission needs them and neither one carries a salt.
clear_witnesses() {
  rm -f "$INNER"/Prover.toml "$INNER"/Prover_*.toml "$AGG/Prover.toml"
  rm -rf "$OUT" "$INNER/target" "$ATGT"
}

# The witness paths belong to the machine and not to one process, so the lock
# does too. The client library takes the same lock, in the same file and in the
# same format, so the two tools refuse to run over each other.
LOCK="$REC/.run.lock"
lock_owner() { tr -d '[:space:]' < "$LOCK" 2>/dev/null; }
take_lock() {
  # noclobber makes the redirection fail when the file exists, so the check and
  # the creation are one step.
  if ! (set -o noclobber; echo "$$" > "$LOCK") 2>/dev/null; then
    owner=$(lock_owner)
    # A lock file that names nobody is not evidence that nobody holds it. The
    # creation and the write are two steps for the operating system, so a run
    # that is taking the lock right now leaves it empty for a moment. Treating
    # that moment as a stale lock lets two runs believe they hold one lock. The
    # read therefore repeats before it concludes anything.
    if [ -z "$owner" ]; then
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        sleep 0.05
        owner=$(lock_owner)
        [ -n "$owner" ] && break
      done
    fi
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      die "another proving run holds the lock on this repository, under the process $owner; wait for it or stop it"
    fi
    # The owner is gone, or no run ever named itself, so the lock is stale.
    rm -f "$LOCK"
    (set -o noclobber; echo "$$" > "$LOCK") 2>/dev/null \
      || die "the run cannot take the lock $LOCK"
  fi
}
release_lock() { [ "$(lock_owner)" = "$$" ] && rm -f "$LOCK"; return 0; }

[ $# -eq 2 ] || die "usage: attest.sh <context.toml> <customers.csv>"

# The order of the three steps below matters. The lock comes first, because a
# run that does not own the lock must never sweep: the files it would remove
# belong to the run that does own it. The trap comes next, so every later
# ending sweeps and releases. The sweep comes last, and it reaches the files of
# a run that stopped without running anything.
#
# A signal that arrives between the lock and the trap leaves the lock file
# behind. The next run reads the identifier, finds no such process, and clears
# it, so that window costs a stale file and not a blocked machine.
take_lock
# The handler for a signal ends the run. Bash resumes the script after a
# handler returns, so a handler that only swept would leave the run going with
# its lock released, still writing the paths that the lock protects. The exit
# trap sweeps again, and both sweeps are safe to repeat.
on_signal() { stop_tools; clear_witnesses; release_lock; exit 130; }
trap 'stop_tools; clear_witnesses; release_lock' EXIT
trap on_signal INT TERM HUP
clear_witnesses

# Each step runs from its own directory, so a relative path would resolve
# somewhere else.
absolute() {
  [ -f "$1" ] || die "no file at $1"
  echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
}
CONTEXT_FILE=$(absolute "$1") || exit 1
CUSTOMERS_FILE=$(absolute "$2") || exit 1

for bin in nargo bb cargo stellar python3; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool on PATH: $bin"
done

# -----------------------------------------------------------------------------
# 1. Refuse a run that would produce salts anybody can recompute
# -----------------------------------------------------------------------------
# The secret arrives as a file, and never as a value. Every salt comes from it,
# the packages of every customer come from the salts, and the flow writes those
# packages after the attestation lands. A secret that lives only in the
# environment of one shell disappears with that shell, and the customers then
# have no packages and no way to make them.
[ -n "${ZKPOR_MASTER_SECRET_FILE:-}" ] \
  || die "ZKPOR_MASTER_SECRET_FILE is not set. Name the file that holds the secret, so the packages of the customers survive this shell."
[ -r "$ZKPOR_MASTER_SECRET_FILE" ] \
  || die "cannot read the master secret at $ZKPOR_MASTER_SECRET_FILE"
SECRET_MODE=$(stat -c '%a' "$ZKPOR_MASTER_SECRET_FILE" 2>/dev/null \
  || stat -f '%OLp' "$ZKPOR_MASTER_SECRET_FILE" 2>/dev/null)
[ "$SECRET_MODE" = "600" ] || [ "$SECRET_MODE" = "400" ] \
  || die "the master secret at $ZKPOR_MASTER_SECRET_FILE carries the mode $SECRET_MODE. Give it 600, because it derives every salt."
ZKPOR_MASTER_SECRET=$(tr -d ' \n' < "$ZKPOR_MASTER_SECRET_FILE")
export ZKPOR_MASTER_SECRET
[ -n "$ZKPOR_MASTER_SECRET" ] \
  || die "the file $ZKPOR_MASTER_SECRET_FILE holds no secret"
[ "$ZKPOR_MASTER_SECRET" != "$FIXTURE_SECRET" ] \
  || die "the file $ZKPOR_MASTER_SECRET_FILE holds the test fixture secret. Its salts are in this repository, so anybody can recompute every leaf."
if [ -f "$FIXTURE_SECRET_FILE" ]; then
  # shellcheck source=/dev/null
  . "$FIXTURE_SECRET_FILE"
  [ "$TEST_ONLY_MASTER_SECRET" = "$FIXTURE_SECRET" ] \
    || die "the fixture secret changed, and the value that this script refuses did not. Update it."
fi

# Repository fixtures describe no real asset and carry no real balance. A run
# that names one would attest data that this repository publishes.
for path in "$CONTEXT_FILE" "$CUSTOMERS_FILE"; do
  case "$path" in
    */fixtures/*) die "$path is a fixture of this repository. Write your own context and your own customer file." ;;
  esac
done

REGISTRY="${ZKPOR_REGISTRY:-}"
[ -n "$REGISTRY" ] || REGISTRY=$(cat "$REGISTRY_ID_FILE" 2>/dev/null)
[ -n "$REGISTRY" ] || die "no registry contract. Set ZKPOR_REGISTRY, or deploy one and record it in $REGISTRY_ID_FILE."

# -----------------------------------------------------------------------------
# 2. The customer list must fit the tree, and the snapshot must still be open
# -----------------------------------------------------------------------------
K=$(sed -nE "s/^num_batches_k *= *([0-9]+).*/\1/p" "$REC/params.toml")
B=$(sed -nE "s/^batch_b *= *([0-9]+).*/\1/p" "$REC/params.toml")
[ -n "$K" ] && [ -n "$B" ] || die "cannot read batch_b and num_batches_k from params.toml"
CAPACITY=$((B * K))
ROWS=$(grep -cvE '^\s*(#|id,|$)' "$CUSTOMERS_FILE")
[ "$ROWS" -le "$CAPACITY" ] \
  || die "the customer file holds $ROWS rows and the tree holds $CAPACITY. The flow does not cut the list, because a cut removes liabilities from the total."

SNAPSHOT=$(sed -nE "s/^snapshot_ledger *= *([0-9]+).*/\1/p" "$CONTEXT_FILE")
[ -n "$SNAPSHOT" ] || die "the context file states no snapshot_ledger"
# The window lives in the contract that enforces it, so this reads it there.
WINDOW=$(sed -nE "s/^pub const ATTESTATION_MAX_AGE_LEDGERS: u32 = ([0-9]+);.*/\1/p" \
  "$ROOT_DIR/contracts/context/src/lib.rs")
[ -n "$WINDOW" ] || die "cannot read the age window from the context crate"
LEDGER=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' "$STELLAR_RPC_URL" \
  | sed -nE 's/.*"sequence":([0-9]+).*/\1/p')
[ -n "$LEDGER" ] || die "cannot read the current ledger from $STELLAR_RPC_URL"
[ "$SNAPSHOT" -le "$LEDGER" ] \
  || die "the snapshot ledger $SNAPSHOT is later than the current ledger $LEDGER"
REMAINING=$((SNAPSHOT + WINDOW - LEDGER))
[ "$REMAINING" -gt 0 ] \
  || die "the snapshot ledger $SNAPSHOT expired at $((SNAPSHOT + WINDOW)), and the network is at $LEDGER"
[ "$REMAINING" -ge "$PROVING_MARGIN_LEDGERS" ] \
  || die "only $REMAINING ledgers of the window are left, and the proof needs more. Take a fresh snapshot."

mkdir -p "$WORK"

# -----------------------------------------------------------------------------
# 3. The context must equal the entry that the registry holds
# -----------------------------------------------------------------------------
# The registry derives the context hash from its own state, so a context that
# differs anywhere produces a proof that the registry refuses. The comparison
# runs before the proof, which takes minutes. It needs the network, and so does
# the window check above, so an unreachable chain already stopped this run.
ASSET=$(sed -nE 's/^asset *= *"(.*)".*/\1/p' "$CONTEXT_FILE")
[ -n "$ASSET" ] || die "the context file names no asset"
# The answer of the registry arrives on the output, and the notes of the
# command line arrive on the error stream, so the two do not mix.
ENTRY=$(stellar contract invoke --id "$REGISTRY" --source "$STELLAR_SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK_NAME" -- entry --asset "$ASSET" 2>"$WORK/entry.error") \
  || die "the registry holds no entry for $ASSET:\n$(cat "$WORK/entry.error")"
# The comparison stops the run when it finds a difference and when it cannot
# read either side, so a silent answer never passes for agreement.
DIFFERENCE=$(echo "$ENTRY" | python3 "$ROOT_DIR/scripts/compare_context.py" "$CONTEXT_FILE" 2>&1) \
  || die "the context does not match the entry that the registry holds:\n$DIFFERENCE"

note "context=$CONTEXT_FILE customers=$ROWS of $CAPACITY snapshot=$SNAPSHOT window left=$REMAINING"

# -----------------------------------------------------------------------------
# 3. Salts, witnesses, and one proof per batch
# -----------------------------------------------------------------------------
run_tool env -C "$GEN" cargo run --release --quiet -- witness "$CONTEXT_FILE" "$CUSTOMERS_FILE" \
  || die "the generator did not write the witnesses"
cd "$INNER" || die "no inner circuit directory"
rm -rf target out; run_tool nargo compile || die "the inner circuit did not compile"
for k in $(seq 0 $((K - 1))); do
  cp "Prover_${k}.toml" Prover.toml
  run_tool nargo execute "wit${k}" >/dev/null 2>&1 || die "batch $k did not execute"
  mkdir -p "$OUT/batch_${k}"
  run_tool bb prove --scheme "$PROOF_SCHEME" --oracle_hash "$INNER_ORACLE_HASH" --honk_recursion 1 \
    --bytecode_path target/recursion_inner.json --witness_path "target/wit${k}.gz" \
    --output_path "$OUT/batch_${k}" --output_format bytes_and_fields >/dev/null 2>&1 \
    || die "batch $k did not prove"
  note "batch $k of $K proved"
done
run_tool bb write_vk --scheme "$PROOF_SCHEME" --oracle_hash "$INNER_ORACLE_HASH" --honk_recursion 1 \
  --verifier_type standalone --bytecode_path target/recursion_inner.json \
  --output_path "$OUT" --output_format bytes_and_fields >/dev/null 2>&1 \
  || die "the inner key did not write"

# -----------------------------------------------------------------------------
# 4. Fold the batches and produce the terminal proof
# -----------------------------------------------------------------------------
run_tool env -C "$GEN" cargo run --release --quiet -- assemble "$CONTEXT_FILE" "$OUT" \
  || die "the generator did not assemble the aggregator input"
cd "$AGG" || die "no aggregator directory"
rm -rf target; run_tool nargo compile || die "the aggregator did not compile"
run_tool nargo execute aggwit >/dev/null 2>&1 || die "the aggregator did not execute"
run_tool bb prove --scheme "$PROOF_SCHEME" --oracle_hash "$TERMINAL_ORACLE_HASH" \
  --bytecode_path "$ATGT/recursion_agg.json" --witness_path "$ATGT/aggwit.gz" \
  --output_path "$ATGT" --output_format bytes_and_fields >/dev/null 2>&1 \
  || die "the terminal proof did not prove"
cp "$ATGT/proof" "$WORK/proof" || die "the proof did not reach $WORK"
cp "$ATGT/public_inputs" "$WORK/public_inputs" \
  || die "the public inputs did not reach $WORK"
note "terminal proof written to $WORK/proof"

# The root and the total come out of the public input string that the prover
# wrote, so this script states neither of them itself.
read -r FINAL_ROOT TOTAL < <(python3 "$ROOT_DIR/scripts/public_input_fields.py" \
  "$WORK/public_inputs" "$MANIFEST_FILE") || die "cannot read the public inputs"
note "final_root=$FINAL_ROOT total_liabilities=$TOTAL"

# -----------------------------------------------------------------------------
# 5. Submit. The registry builds the public inputs from its own state.
# -----------------------------------------------------------------------------
note "submitting to $REGISTRY as $STELLAR_SOURCE_ACCOUNT on $STELLAR_NETWORK_NAME"
SUBMISSION=$(stellar contract invoke --id "$REGISTRY" --source "$STELLAR_SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK_NAME" --send yes -- submit_attestation \
  --asset "$(sed -nE 's/^asset *= *"(.*)".*/\1/p' "$CONTEXT_FILE")" \
  --snapshot_ledger "$SNAPSHOT" --final_root "$FINAL_ROOT" \
  --total_liabilities "$TOTAL" --proof-file-path "$WORK/proof" 2>&1) \
  || die "the registry refused the attestation:\n$SUBMISSION"
echo "$SUBMISSION"
TRANSACTION=$(echo "$SUBMISSION" | sed -nE 's/.*Signing transaction: ([0-9a-f]{64}).*/\1/p' | tail -1)
[ -n "$TRANSACTION" ] || die "the submission names no transaction hash, so the record of the packages would carry none"

# -----------------------------------------------------------------------------
# 6. Write the packages of the customers, then remove the secrets of the run
# -----------------------------------------------------------------------------
# The generator recomputes every salt from the master secret file and refuses to
# write a package unless the recomputed root equals the root that the chain
# holds. The round trip therefore proves that the declared file reproduces this
# attestation. The deletion below waits for that proof, because the salts are
# the only other way to reach the packages.
ATTESTED=$(stellar contract invoke --id "$REGISTRY" --source "$STELLAR_SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK_NAME" -- entry --asset "$ASSET" 2>"$WORK/entry.error") \
  || die "the registry holds no entry after the attestation:\n$(cat "$WORK/entry.error")"
ATTESTED_ROOT=$(echo "$ATTESTED" | python3 -c "
import json,sys
print('%064x' % int(json.load(sys.stdin)['attestation']['Filled']['final_root']))") \
  || die "the registry entry carries no attested root:\n$ATTESTED"

# The output goes through a file rather than a command substitution. A
# substitution runs in a subshell, and a tool started there would leave no
# record in this shell for the stop to reach.
run_tool env -C "$GEN" cargo run --release --quiet -- packages \
  "$CONTEXT_FILE" "$CUSTOMERS_FILE" "$PACKAGES_OUT" \
  --network "$STELLAR_NETWORK_NAME" --registry "$REGISTRY" \
  --attested-root "$ATTESTED_ROOT" --attested-snapshot "$SNAPSHOT" \
  --transaction "$TRANSACTION" --deployments "$DEPLOYMENTS" \
  > "$WORK/packages.out" 2>&1 \
  || die "the packages of the customers did not reach $PACKAGES_OUT, so the salts stay on disk:\n$(cat "$WORK/packages.out")"
PACKAGES=$(cat "$WORK/packages.out")
echo "$PACKAGES"

# The balances, the salts, and the witnesses have no use after the packages
# exist. The trap above removes them on every ending, and the call here removes
# them now, so they do not sit on disk for the rest of a long run.
clear_witnesses
note "the balances, the salts, and the witnesses are removed"

echo -e "\n${GREEN}The registry accepted the attestation of snapshot $SNAPSHOT.${NC}"
