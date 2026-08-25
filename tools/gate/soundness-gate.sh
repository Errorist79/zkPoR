#!/usr/bin/env bash
# =============================================================================
# soundness-gate.sh: end-to-end soundness gate for the PRODUCTION
# recursive-aggregation Proof-of-Reserves pipeline.
#
# Exercises the production artifacts only:
#   - inner batch circuit + hardened aggregator: circuits/recursion/{inner,agg}
#     (vk pin + shared binding root + slot anti-replay, range-checking inner)
#   - off-circuit fold/witness generator:        tools/recursion-gen
#   - host-accelerated UltraHonk verifier:        contracts/verifier
#     (vendors contracts/vendor/ultrahonk-soroban-verifier, which COMPLETES the
#      deferred pairing-point accumulator on-chain)
#   - adversarial scaffolding (this gate only):   tools/gate/attacks + cheats.py
#
# It then PROVES soundness by breaking it, GATED ON THE VERDICT OF THE DEPLOYED
# VERIFIER. The honest case lands a transaction. Each refusal is the verdict that
# the contract returns under simulation, because the command line refuses to
# submit a call whose simulation fails:
#   honest   -> ACCEPT
#   forged   -> foreign inner proof under the PINNED vk array (passes the
#               in-circuit key_hash assert + folds; nargo execute succeeds),
#               caught ONLY by the completed pairing at the verifier -> REJECT
#   deflated -> foreign no-range-check inner, balance -100, under the pinned vk;
#               nargo execute succeeds -> REJECT
#   staleleaf-> a batch proven by a circuit that keeps the old two-input leaf and
#               ignores the salt. Its total is honest, so only the pinned inner
#               key hash rejects it -> REJECT
#   foreign  -> the honest proof, submitted with one changed context_hash and
#      context   the other three public inputs untouched -> REJECT. This is the
#                test that shows the unconstrained public parameter really
#                enters the proof transcript.
#
# It runs at the release configuration only. The generator writes the manifest
# for that configuration alone, and the deploy step needs the manifest, so a
# development artifact cannot reach a contract.
#
# Exits 0 only if honest ACCEPTs and ALL FOUR attacks REJECT at the verifier.
# Any other outcome (including an infrastructure error) FAILS LOUDLY.
#
# Requires the pinned toolchain on PATH (nargo 1.0.0-beta.9, bb 0.87.0, stellar
# 27.0.0, cargo/rustc 1.96.0) and a Protocol-27 localnet. See tools/gate/README.md.
#
# Environment (all optional):
#   SOROBAN_RPC      localnet RPC (default http://localhost:8000/soroban/rpc)
#   SKIP_WASM_BUILD  =1 to reuse an already-built optimized verifier wasm
#   START_LOCALNET   =1 to start the localnet container if the RPC is unreachable
# =============================================================================
set -uo pipefail
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$GATE_DIR/../.." && pwd)"
NET="${SOROBAN_NET:-local}"
PP="${SOROBAN_PASSPHRASE:-Standalone Network ; February 2017}"
RPC="${SOROBAN_RPC:-http://localhost:8000/soroban/rpc}"

REC="$REPO_ROOT/circuits/recursion"
INNER="$REC/inner"; AGG="$REC/agg"
EVIL="$GATE_DIR/attacks/inner_evil"
STALE="$GATE_DIR/attacks/inner_stale_leaf"
GEN="$REPO_ROOT/tools/recursion-gen"
MANIFEST="$REC/manifest.json"
CONTEXT_FILE="$REPO_ROOT/fixtures/test_only_context.toml"
CUSTOMERS_FILE="$INNER/fixtures/customers_below_capacity.csv"
PY="$GATE_DIR/cheats.py"
VERIFIER="$REPO_ROOT/contracts/verifier"
OUT="$INNER/out"
ATGT="$AGG/target"

die() { echo; echo "########## SOUNDNESS-GATE FAIL: $* ##########" >&2; exit 1; }
note() { echo "[soundness-gate] $*"; }

[ -d "$REC" ]      || die "production circuits not found at $REC"
[ -d "$VERIFIER" ] || die "production verifier crate not found at $VERIFIER"
[ -f "$PY" ]       || die "harness not found at $PY"
[ -d "$EVIL" ]     || die "adversarial circuit not found at $EVIL"
[ -d "$STALE" ]    || die "adversarial circuit not found at $STALE"
for bin in nargo bb stellar cargo; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool on PATH: $bin"
done

K=$(sed -nE "s/^num_batches_k *= *([0-9]+).*/\\1/p" "$REC/params.toml")
B=$(sed -nE "s/^batch_b *= *([0-9]+).*/\\1/p" "$REC/params.toml")
[ -n "$K" ] && [ -n "$B" ] || die "cannot read batch_b and num_batches_k from params.toml"

# The proof scheme and both oracle hashes are format-determining, so they come
# from the pinned file and not from this script.
# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/versions.env"

# The generator needs the master secret in the environment. A real authority
# keeps its own secret; the gate must be deterministic, so it reads the fixture.
# shellcheck source=/dev/null
. "$REPO_ROOT/fixtures/test_only_master_secret.env"
export ZKPOR_MASTER_SECRET="$TEST_ONLY_MASTER_SECRET"

manifest_field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$MANIFEST" "$1"; }
manifest_position() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['public_input_positions'][sys.argv[2]])" "$MANIFEST" "$1"; }

# The localnet check and one inner proof live next to this file, because the
# registry gate runs the same two steps.
# shellcheck source=/dev/null
. "$GATE_DIR/lib.sh"

echo "=== SOUNDNESS-GATE START $(date -u) (B=$B K=$K) ==="
echo "REPO_ROOT=$REPO_ROOT"
ensure_localnet

# -----------------------------------------------------------------------------
# 1. Small fold + honest inner batch proofs (pinned, range-checking, poseidon2)
# -----------------------------------------------------------------------------
( cd "$GEN" && cargo run --release --quiet -- witness "$CONTEXT_FILE" "$CUSTOMERS_FILE" ) \
  || die "recursion-gen witness"
enter "$INNER"; rm -rf target out; nargo compile || die "inner compile"
for k in $(seq 0 $((K - 1))); do
  cp "Prover_${k}.toml" Prover.toml
  nargo execute "wit${k}" >/dev/null 2>&1 || die "inner execute $k"
  mkdir -p "$OUT/batch_${k}"
  started=$SECONDS
  prove_inner target/recursion_inner.json "target/wit${k}.gz" "$OUT/batch_${k}" \
    >/dev/null 2>&1 || die "inner prove $k"
  note "inner batch $k proved in $((SECONDS - started))s"
done
bb write_vk --scheme "$PROOF_SCHEME" --oracle_hash "$INNER_ORACLE_HASH" --honk_recursion 1 \
  --verifier_type standalone --bytecode_path target/recursion_inner.json \
  --output_path "$OUT" --output_format bytes_and_fields >/dev/null 2>&1 || die "inner write_vk"

# -----------------------------------------------------------------------------
# 2. Assemble the hardened aggregator params + honest Prover.toml (pins inner vk)
# -----------------------------------------------------------------------------
( cd "$GEN" && cargo run --release --quiet -- assemble "$CONTEXT_FILE" "$OUT" ) \
  || die "recursion-gen assemble"
# The cheat harness needs the context of the honest run, and the shell
# truncates the aggregator Prover.toml before the harness runs.
ZKPOR_CONTEXT_HASH=$(sed -nE 's/^context_hash = "([0-9]+)".*/\1/p' "$AGG/Prover.toml")
[ -n "$ZKPOR_CONTEXT_HASH" ] || die "assemble did not write context_hash"
export ZKPOR_CONTEXT_HASH

echo "--- pinned inner-vk hash + layout (all three constraints live) ---"
grep -E 'PINNED_INNER_VK_HASH|SLOT_IDX|SUBROOT_IDX|SUBTOTAL_IDX|INNER_PUB_LEN|NUM_BATCHES_K' \
  "$AGG/src/params.nr" | sed 's/^/    /'

# -----------------------------------------------------------------------------
# 3. Adversarial inner_evil proofs (foreign circuit, NO range check):
#    batch_0 (honest values) for the forged fold, deflate (-100) for the
#    deflated-total fold. Both pass nargo execute; caught only at the verifier.
# -----------------------------------------------------------------------------
enter "$EVIL"; rm -rf target out; nargo compile || die "inner_evil compile"
# Only slot 0 carries an adversarial batch in either attack, so only batch 0 and
# the deflated batch are proven here.
python3 "$PY" evil-prover 0 plain > Prover.toml || die "evil-prover 0"
nargo execute ewit0 >/dev/null 2>&1 || die "evil execute 0"
mkdir -p out/batch_0
prove_inner target/recursion_inner_evil.json target/ewit0.gz out/batch_0 \
  >/dev/null 2>&1 || die "evil prove 0"
python3 "$PY" evil-prover 0 deflate > Prover.toml || die "evil-prover deflate"
nargo execute ewitd >/dev/null 2>&1 || die "evil deflate execute"
mkdir -p out/deflate
prove_inner target/recursion_inner_evil.json target/ewitd.gz out/deflate \
  >/dev/null 2>&1 || die "evil deflate prove"
bb write_vk --scheme "$PROOF_SCHEME" --oracle_hash "$INNER_ORACLE_HASH" --honk_recursion 1 \
  --verifier_type standalone --bytecode_path target/recursion_inner_evil.json \
  --output_path out --output_format bytes_and_fields >/dev/null 2>&1 || die "evil write_vk"

# -----------------------------------------------------------------------------
# 3b. Adversarial inner_stale_leaf proof: the old two-input leaf, the salt
#     ignored, and an honest total. Only the pinned inner key rejects it.
# -----------------------------------------------------------------------------
enter "$STALE"; rm -rf target out; nargo compile || die "inner_stale_leaf compile"
python3 "$PY" evil-prover 0 plain > Prover.toml || die "stale-prover 0"
nargo execute swit0 >/dev/null 2>&1 || die "stale execute 0"
mkdir -p out/batch_0
prove_inner target/recursion_inner_stale_leaf.json target/swit0.gz out/batch_0 \
  >/dev/null 2>&1 || die "stale prove 0"

# -----------------------------------------------------------------------------
# 4. Compile the aggregator + write its (circuit-constant) keccak vk for deploy
# -----------------------------------------------------------------------------
enter "$AGG"; rm -rf target; nargo compile || die "agg compile"
bb write_vk --scheme "$PROOF_SCHEME" --oracle_hash "$TERMINAL_ORACLE_HASH" \
  --bytecode_path "$ATGT/recursion_agg.json" --output_path "$ATGT" \
  --output_format bytes_and_fields >/dev/null 2>&1 || die "agg write_vk"
[ -f "$ATGT/vk" ] || die "agg vk bytes not written"
echo "AGG_VK_BYTES=$(wc -c < "$ATGT/vk")"

# The manifest records what this artifact is. The generator writes it for the
# release configuration only, and the deploy step below needs it.
rm -f "$MANIFEST"
( cd "$GEN" && cargo run --release --quiet -- manifest "$OUT" "$ATGT" ) \
  || die "recursion-gen manifest (is this the release configuration?)"
echo "--- artifact manifest ---"
sed "s/^/    /" "$MANIFEST"

# -----------------------------------------------------------------------------
# 5. Build + optimize the PRODUCTION verifier (contracts/verifier) to wasm
# -----------------------------------------------------------------------------
RAW="$REPO_ROOT/target/wasm32v1-none/release/ultrahonk_verifier.wasm"
OPT="${RAW%.wasm}.optimized.wasm"
if [ "${SKIP_WASM_BUILD:-0}" != "1" ]; then
  note "building production verifier wasm (stellar contract build)"
  ( cd "$VERIFIER" && stellar contract build 2>&1 | tail -3 ) || die "stellar contract build"
  ( cd "$VERIFIER" && stellar contract optimize --wasm "$RAW" 2>&1 | tail -1 ) || die "wasm optimize"
fi
[ -f "$OPT" ] || die "optimized wasm not found: $OPT"
echo "OPT_WASM_BYTES=$(wc -c < "$OPT")"

# -----------------------------------------------------------------------------
# 6. Deploy the production verifier with the aggregator keccak vk (one contract)
# -----------------------------------------------------------------------------
# The deploy path refuses anything the manifest does not describe.
[ -f "$MANIFEST" ] || die "no manifest: this artifact is not a release artifact"
[ "$(manifest_field batch_b)" = "$B" ] || die "manifest batch_b does not match params.toml"
[ "$(manifest_field num_batches_k)" = "$K" ] || die "manifest num_batches_k does not match params.toml"
[ "$(manifest_field aggregator_key_sha256)" = "$(sha256sum "$ATGT/vk" | cut -d" " -f1)" ] \
  || die "the key to deploy is not the key the manifest records"

stellar network add "$NET" --rpc-url "$RPC" --network-passphrase "$PP" >/dev/null 2>&1 || true
stellar keys generate alice --network "$NET" --fund >/dev/null 2>&1 \
  || stellar keys fund alice --network "$NET" >/dev/null 2>&1 || true
CID=$(stellar contract deploy --wasm "$OPT" --source alice --network "$NET" \
  -- --vk_bytes-file-path "$ATGT/vk" 2>/dev/null | tail -1 | tr -d "[:space:]")
[ -n "$CID" ] || die "deploy failed (vk rejected by verifier?)"
echo "CONTRACT_ID=$CID"

# -----------------------------------------------------------------------------
# 7. Build each terminal aggregator proof + read the verdict of the deployed
#    verifier for it
# -----------------------------------------------------------------------------
build_terminal() { # kind  -> writes $ATGT/proof + $ATGT/public_inputs
  python3 "$PY" agg-prover "$1" > "$AGG/Prover.toml" || return 1
  ( cd "$AGG" && nargo execute aggw >/dev/null 2>&1 ) || return 1
  local started=$SECONDS
  bb prove --scheme "$PROOF_SCHEME" --oracle_hash "$TERMINAL_ORACLE_HASH" \
    --bytecode_path "$ATGT/recursion_agg.json" --witness_path "$ATGT/aggw.gz" \
    --output_path "$ATGT" --output_format bytes_and_fields >/dev/null 2>&1 || return 1
  note "terminal proof ($1) built in $((SECONDS - started))s"
}

onchain_verify() { # public_inputs_file proof_file -> ACCEPT | REJECT:<r> | INFRA:<r>
  local out rc
  out=$(stellar contract invoke --id "$CID" --source alice --network "$NET" --send yes \
    -- verify_proof --public_inputs-file-path "$1" \
    --proof_bytes-file-path "$2" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    echo "ACCEPT"
  elif echo "$out" | grep -qiE 'Error\(Contract|HostError|InvokeHostFunction|#[0-9]'; then
    echo "REJECT:$(echo "$out" | grep -ioE 'Error\(Contract, #[0-9]+\)|HostError[^\"]*' | head -1)"
  else
    echo "INFRA:$(echo "$out" | tail -1 | cut -c1-120)"
  fi
}

L_IDX=$(manifest_position L) || die "the manifest does not carry the position of L"
CTX_IDX=$(manifest_position context_hash) || die "the manifest does not carry the position of context_hash"
PI_BYTES=$(manifest_field public_input_bytes) || die "the manifest does not carry the public input length"
PI_COUNT=$(manifest_field public_input_count) || die "the manifest does not carry the public input count"

declare -A GOT
record() { # label result expected extra
  GOT["$1"]="$2"
  echo ">>> CASE $1 ($4): verdict=$2 ; expected=$3"
  case "$2" in INFRA:*) die "$1 hit an infrastructure error, not a verifier verdict: $2" ;; esac
}

run_case() { # label kind expected
  note "building terminal proof: $2"
  build_terminal "$2" || die "could not build terminal proof for $2 (should pass nargo execute)"
  local L; L="L=$(python3 -c "import json,sys;print(int(json.load(open(sys.argv[1]))[int(sys.argv[2])],16))" "$ATGT/public_inputs_fields.json" "$L_IDX" 2>/dev/null || echo '?')"
  record "$1" "$(onchain_verify "$ATGT/public_inputs" "$ATGT/proof")" "$3" "kind=$2, reported $L"
}

# The honest proof, submitted with one changed context_hash and nothing else
# changed. The circuit does not constrain that public input, so only its place
# in the proof transcript can reject this.
run_foreign_context_case() {
  python3 "$REPO_ROOT/scripts/tamper_public_input.py" \
    "$ATGT/public_inputs" "$ATGT/public_inputs.foreign" \
    "$CTX_IDX" "$PI_BYTES" "$PI_COUNT" || die "cannot build the foreign context input"
  record foreigncontext "$(onchain_verify "$ATGT/public_inputs.foreign" "$ATGT/proof")" \
    REJECT "the honest proof, context_hash at index $CTX_IDX changed by one bit"
}

echo "--- SOUNDNESS GATE (verdict of the deployed production verifier) ---"
run_case honest       honest       ACCEPT
# The honest artifacts must survive the later cases, which overwrite them.
run_foreign_context_case
run_case forged       foreignproof REJECT
run_case deflated     deflate      REJECT
run_case staleleaf    staleleaf    REJECT

# -----------------------------------------------------------------------------
# 8. Verdict
# -----------------------------------------------------------------------------
echo "=== SOUNDNESS-GATE RESULTS ==="
printf '  honest         : %s\n' "${GOT[honest]}"
printf '  forged         : %s\n' "${GOT[forged]}"
printf '  deflated       : %s\n' "${GOT[deflated]}"
printf '  foreigncontext : %s\n' "${GOT[foreigncontext]}"
printf '  staleleaf      : %s\n' "${GOT[staleleaf]}"

FAIL=0
[[ "${GOT[honest]}"   == ACCEPT* ]] || { echo "EXPECTATION UNMET: honest must ACCEPT";   FAIL=1; }
[[ "${GOT[forged]}"   == REJECT* ]] || { echo "EXPECTATION UNMET: forged must REJECT";   FAIL=1; }
[[ "${GOT[deflated]}" == REJECT* ]] || { echo "EXPECTATION UNMET: deflated must REJECT"; FAIL=1; }
[[ "${GOT[foreigncontext]}" == REJECT* ]] || { echo "EXPECTATION UNMET: foreigncontext must REJECT"; FAIL=1; }
[[ "${GOT[staleleaf]}" == REJECT* ]] || { echo "EXPECTATION UNMET: staleleaf must REJECT"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  die "the deployed artifact is NOT sound (see expectations above)"
fi
echo "=== SOUNDNESS-GATE PASS at B=$B K=$K: honest ACCEPT, forged REJECT, \
deflated REJECT, foreigncontext REJECT, staleleaf REJECT $(date -u) ==="
