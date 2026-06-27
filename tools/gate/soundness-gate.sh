#!/usr/bin/env bash
# =============================================================================
# soundness-gate.sh: end-to-end on-chain soundness gate for the PRODUCTION
# recursive-aggregation Proof-of-Reserves pipeline.
#
# Exercises the production artifacts only:
#   - inner batch circuit + hardened aggregator: circuits/recursion/{inner,agg}
#     (vk pin + shared binding root + slot anti-replay, range-checking inner)
#   - off-circuit fold/witness generator:        tools/recursion-gen (K=2: fast)
#   - host-accelerated UltraHonk verifier:        contracts/verifier
#     (vendors contracts/vendor/ultrahonk-soroban-verifier, which COMPLETES the
#      deferred pairing-point accumulator on-chain)
#   - adversarial scaffolding (this gate only):   tools/gate/attacks + cheats.py
#
# It then PROVES soundness by breaking it, GATED ON THE ON-CHAIN VERIFY RESULT:
#   honest   -> on-chain ACCEPT
#   forged   -> foreign inner proof under the PINNED vk array (passes the
#               in-circuit key_hash assert + folds; nargo execute succeeds),
#               caught ONLY by the completed pairing at the verifier -> REJECT
#   deflated -> foreign no-range-check inner, balance -100, under the pinned vk;
#               nargo execute succeeds -> REJECT
#
# Exits 0 only if honest ACCEPTs and BOTH attacks REJECT at the verifier. Any
# other outcome (including an infrastructure error) FAILS LOUDLY (non-zero exit).
#
# Requires the pinned toolchain on PATH (nargo 1.0.0-beta.9, bb 0.87.0, stellar
# 26.1.0, cargo/rustc 1.96.0) and a Protocol-26 localnet. See tools/gate/README.md.
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
GEN="$REPO_ROOT/tools/recursion-gen"
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
for bin in nargo bb stellar cargo; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool on PATH: $bin"
done

rpc_healthy() {
  curl -s -m 5 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" 2>/dev/null | grep -q '"status":"healthy"'
}

ensure_localnet() {
  rpc_healthy && return 0
  if [ "${START_LOCALNET:-0}" = "1" ]; then
    note "localnet RPC unreachable; starting quickstart:future container"
    stellar container start "$NET" --limits unlimited --image-tag-override future >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do rpc_healthy && { note "localnet RPC healthy"; return 0; }; sleep 5; done
  fi
  die "localnet RPC unreachable at $RPC (infra). Start a Protocol-26 localnet, or set START_LOCALNET=1."
}

prove_poseidon() { # bytecode witness outdir
  bb prove --scheme ultra_honk --oracle_hash poseidon2 --honk_recursion 1 \
    --bytecode_path "$1" --witness_path "$2" --output_path "$3" \
    --output_format bytes_and_fields
}

echo "=== SOUNDNESS-GATE START $(date -u) (K=2 small fold) ==="
echo "REPO_ROOT=$REPO_ROOT"
ensure_localnet

# -----------------------------------------------------------------------------
# 1. Small fold + honest inner batch proofs (pinned, range-checking, poseidon2)
# -----------------------------------------------------------------------------
sed -i -E "s/^num_batches_k = .*/num_batches_k = 2/" "$REC/params.toml"
( cd "$GEN" && cargo run --release --quiet -- witness ) || die "recursion-gen witness"
cd "$INNER"; rm -rf target out; nargo compile || die "inner compile"
for k in 0 1; do
  cp "Prover_${k}.toml" Prover.toml
  nargo execute "wit${k}" >/dev/null 2>&1 || die "inner execute $k"
  mkdir -p "$OUT/batch_${k}"
  prove_poseidon target/recursion_inner.json "target/wit${k}.gz" "$OUT/batch_${k}" \
    >/dev/null 2>&1 || die "inner prove $k"
done
bb write_vk --scheme ultra_honk --oracle_hash poseidon2 --honk_recursion 1 \
  --verifier_type standalone --bytecode_path target/recursion_inner.json \
  --output_path "$OUT" --output_format bytes_and_fields >/dev/null 2>&1 || die "inner write_vk"

# -----------------------------------------------------------------------------
# 2. Assemble the hardened aggregator params + honest Prover.toml (pins inner vk)
# -----------------------------------------------------------------------------
( cd "$GEN" && cargo run --release --quiet -- assemble "$OUT" ) || die "recursion-gen assemble"
echo "--- pinned inner-vk hash + layout (all three constraints live) ---"
grep -E 'PINNED_INNER_VK_HASH|SLOT_IDX|SUBROOT_IDX|SUBTOTAL_IDX|INNER_PUB_LEN|NUM_BATCHES_K' \
  "$AGG/src/params.nr" | sed 's/^/    /'

# -----------------------------------------------------------------------------
# 3. Adversarial inner_evil proofs (foreign circuit, NO range check):
#    batch_0/batch_1 (honest values) for the forged fold, deflate (-100) for the
#    deflated-total fold. Both pass nargo execute; caught only at the verifier.
# -----------------------------------------------------------------------------
cd "$EVIL"; rm -rf target out; nargo compile || die "inner_evil compile"
for k in 0 1; do
  python3 "$PY" evil-prover "$k" plain > Prover.toml || die "evil-prover $k"
  nargo execute "ewit${k}" >/dev/null 2>&1 || die "evil execute $k"
  mkdir -p "out/batch_${k}"
  prove_poseidon target/recursion_inner_evil.json "target/ewit${k}.gz" "out/batch_${k}" \
    >/dev/null 2>&1 || die "evil prove $k"
done
python3 "$PY" evil-prover 0 deflate > Prover.toml || die "evil-prover deflate"
nargo execute ewitd >/dev/null 2>&1 || die "evil deflate execute"
mkdir -p out/deflate
prove_poseidon target/recursion_inner_evil.json target/ewitd.gz out/deflate \
  >/dev/null 2>&1 || die "evil deflate prove"
bb write_vk --scheme ultra_honk --oracle_hash poseidon2 --honk_recursion 1 \
  --verifier_type standalone --bytecode_path target/recursion_inner_evil.json \
  --output_path out --output_format bytes_and_fields >/dev/null 2>&1 || die "evil write_vk"

# -----------------------------------------------------------------------------
# 4. Compile the aggregator + write its (circuit-constant) keccak vk for deploy
# -----------------------------------------------------------------------------
cd "$AGG"; rm -rf target; nargo compile || die "agg compile"
bb write_vk --scheme ultra_honk --oracle_hash keccak \
  --bytecode_path "$ATGT/recursion_agg.json" --output_path "$ATGT" \
  --output_format bytes >/dev/null 2>&1 || die "agg write_vk"
[ -f "$ATGT/vk" ] || die "agg vk bytes not written"
echo "AGG_VK_BYTES=$(wc -c < "$ATGT/vk")"

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
stellar network add "$NET" --rpc-url "$RPC" --network-passphrase "$PP" >/dev/null 2>&1 || true
stellar keys generate alice --network "$NET" --fund >/dev/null 2>&1 \
  || stellar keys fund alice --network "$NET" >/dev/null 2>&1 || true
CID=$(stellar contract deploy --wasm "$OPT" --source alice --network "$NET" \
  -- --vk_bytes-file-path "$ATGT/vk" 2>/dev/null | tail -1 | tr -d "[:space:]")
[ -n "$CID" ] || die "deploy failed (vk rejected by verifier?)"
echo "CONTRACT_ID=$CID"

# -----------------------------------------------------------------------------
# 7. Build each terminal aggregator proof + verify it ON-CHAIN
# -----------------------------------------------------------------------------
build_terminal() { # kind  -> writes $ATGT/proof + $ATGT/public_inputs
  python3 "$PY" agg-prover "$1" > "$AGG/Prover.toml" || return 1
  ( cd "$AGG" && nargo execute aggw >/dev/null 2>&1 ) || return 1
  bb prove --scheme ultra_honk --oracle_hash keccak \
    --bytecode_path "$ATGT/recursion_agg.json" --witness_path "$ATGT/aggw.gz" \
    --output_path "$ATGT" --output_format bytes_and_fields >/dev/null 2>&1 || return 1
}

onchain_verify() { # -> prints ACCEPT | REJECT:<reason> | INFRA:<reason>
  local out rc
  out=$(stellar contract invoke --id "$CID" --source alice --network "$NET" --send yes \
    -- verify_proof --public_inputs-file-path "$ATGT/public_inputs" \
    --proof_bytes-file-path "$ATGT/proof" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    echo "ACCEPT"
  elif echo "$out" | grep -qiE 'Error\(Contract|HostError|InvokeHostFunction|#[0-9]'; then
    echo "REJECT:$(echo "$out" | grep -ioE 'Error\(Contract, #[0-9]+\)|HostError[^\"]*' | head -1)"
  else
    echo "INFRA:$(echo "$out" | tail -1 | cut -c1-120)"
  fi
}

declare -A GOT
run_case() { # label kind expected
  note "building terminal proof: $2"
  build_terminal "$2" || die "could not build terminal proof for $2 (should pass nargo execute)"
  local L="L=$(python3 -c "import json,sys;print(int(json.load(open('$ATGT/public_inputs_fields.json'))[2],16))" 2>/dev/null || echo '?')"
  local res; res=$(onchain_verify)
  GOT["$1"]="$res"
  echo ">>> CASE $1 (kind=$2, reported $L): on-chain=$res ; expected=$3"
  case "$res" in INFRA:*) die "$1 hit an infrastructure error, not a verifier verdict: $res" ;; esac
}

echo "--- ON-CHAIN SOUNDNESS GATE (deployed production verifier) ---"
run_case honest       honest       ACCEPT
run_case forged       foreignproof REJECT
run_case deflated     deflate      REJECT

# -----------------------------------------------------------------------------
# 8. Verdict
# -----------------------------------------------------------------------------
echo "=== SOUNDNESS-GATE RESULTS ==="
printf '  honest   : %s\n' "${GOT[honest]}"
printf '  forged   : %s\n' "${GOT[forged]}"
printf '  deflated : %s\n' "${GOT[deflated]}"

FAIL=0
[[ "${GOT[honest]}"   == ACCEPT* ]] || { echo "EXPECTATION UNMET: honest must ACCEPT";   FAIL=1; }
[[ "${GOT[forged]}"   == REJECT* ]] || { echo "EXPECTATION UNMET: forged must REJECT";   FAIL=1; }
[[ "${GOT[deflated]}" == REJECT* ]] || { echo "EXPECTATION UNMET: deflated must REJECT"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  die "the production artifact is NOT sound on-chain (see expectations above)"
fi
echo "=== SOUNDNESS-GATE PASS: honest ACCEPT, forged REJECT, deflated REJECT $(date -u) ==="
