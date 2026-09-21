#!/usr/bin/env bash
# Run a dispute demonstration against an existing testnet registry.
#
# Required: ZKPOR_NETWORK=testnet, ZKPOR_REGISTRY, ZKPOR_VERIFIER,
# and ZKPOR_DEMO_WORK, an absolute directory that does not exist yet.
# Optional: ZKPOR_DEMO_PREFIX selects the three identity aliases.
# ZKPOR_DEMO_BOND_STROOPS sets the optional bond amount for this demonstration.
#
# The asset uses the synthetic fund token. Its reserves are demonstration
# balances. Deposits and the bond use native XLM on testnet.
#
# The first tree omits one fixture identifier. The second tree adds it.
# An issuer then replays the first valid proof as a later attestation.
# This deliberate omission uses a direct contract call. The production
# attestation flow keeps its identifier continuity check.
#
# The public directory holds proofs, contract records, and transaction hashes.
# The private directory holds the master secret and customer packages.
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"
set -euo pipefail
umask 077

die() { printf 'dispute demo: %s\n' "$*" >&2; exit 1; }
[[ "$ZKPOR_NETWORK" == testnet ]] || die "set ZKPOR_NETWORK=testnet"
: "${ZKPOR_REGISTRY:?set the deployed registry}"
: "${ZKPOR_VERIFIER:?set the deployed verifier}"
: "${ZKPOR_DEMO_WORK:?set a new absolute output directory}"
[[ "$ZKPOR_DEMO_WORK" == /* ]] || die "the output directory must be absolute"
[[ ! -e "$ZKPOR_DEMO_WORK" ]] || die "use a new output directory for each run"
[[ -f "$ROOT_DIR/sdk/dist/index.js" ]] || die "run npm run build --workspace sdk first"
SECRET_BYTES=$(node --input-type=module - "$ROOT_DIR/sdk/dist/index.js" <<'JAVASCRIPT'
import { pathToFileURL } from "node:url";
const { passphraseOfNetwork, FR_BYTES } = await import(pathToFileURL(process.argv[2]).href);
if (process.env.STELLAR_NETWORK_PASSPHRASE !== passphraseOfNetwork("testnet")) {
  throw new Error("the configured passphrase must name testnet");
}
console.log(FR_BYTES);
JAVASCRIPT
)

WORK=$ZKPOR_DEMO_WORK
PUBLIC="$WORK/public"
PRIVATE="$WORK/private"
PREFIX=${ZKPOR_DEMO_PREFIX:-zkpor-m2-dispute}
ISSUER_ALIAS="$PREFIX-issuer"
RESERVE_ALIAS="$PREFIX-reserve"
DISPUTER_ALIAS="$PREFIX-customer"
BOND_STROOPS=${ZKPOR_DEMO_BOND_STROOPS:-1000000000}
SOURCE_CUSTOMERS="$ROOT_DIR/fixtures/test_only_customers.csv"
TOKEN_CRATE="$ROOT_DIR/tools/gate/fund-token"
TOKEN_WASM="$TOKEN_CRATE/target/wasm32v1-none/release/gate_fund_token.wasm"
mkdir -p "$PUBLIC" "$PRIVATE"

run() {
  local label=$1
  shift
  printf '[dispute demo] %s\n' "$label"
  if ! "$@" >"$PUBLIC/$label.out" 2>"$PUBLIC/$label.log"; then
    cat "$PUBLIC/$label.out" "$PUBLIC/$label.log" >&2
    die "$label failed; the completed steps remain in $WORK"
  fi
}

current_ledger() {
  node --input-type=module - "$ROOT_DIR/sdk/dist/index.js" <<'JAVASCRIPT'
import { pathToFileURL } from "node:url";
const { latestLedger, openServer } = await import(pathToFileURL(process.argv[2]).href);
console.log(await latestLedger(openServer({ rpcUrl: process.env.STELLAR_RPC_URL })));
JAVASCRIPT
}

for alias in "$ISSUER_ALIAS" "$RESERVE_ALIAS" "$DISPUTER_ALIAS"; do
  run "fund-$alias" env STELLAR_SOURCE_ACCOUNT="$alias" bash "$ROOT_DIR/scripts/fund_account.sh"
done
ISSUER=$(stellar keys address "$ISSUER_ALIAS")
RESERVE=$(stellar keys address "$RESERVE_ALIAS")
DISPUTER=$(stellar keys address "$DISPUTER_ALIAS")
run build-token cargo build --release --target wasm32v1-none --manifest-path "$TOKEN_CRATE/Cargo.toml"
run deploy-token stellar contract deploy --wasm "$TOKEN_WASM" --source "$ISSUER_ALIAS" \
  --network testnet -- --admin "$ISSUER"
ASSET=$(tr -d '[:space:]' <"$PUBLIC/deploy-token.out")

# Both proofs keep the release circuit shape. Unused leaves stay padding.
python3 - "$SOURCE_CUSTOMERS" "$PRIVATE" "$ROOT_DIR/circuits/recursion/params.toml" \
  "$ROOT_DIR/circuits/recursion/manifest.json" "$ZKPOR_REGISTRY" "$ZKPOR_VERIFIER" "$SECRET_BYTES" <<'PYTHON'
import csv, json, pathlib, re, secrets, sys
source, directory, params_file, manifest_file, registry, verifier, secret_bytes = sys.argv[1:]
directory = pathlib.Path(directory)
with open(source) as file:
    rows = list(csv.DictReader(line for line in file if line.strip() and not line.startswith("#")))
if len(rows) < 2:
    raise SystemExit("the source fixture needs two identifiers")
with open(params_file) as file:
    params_text = file.read()
params = {}
for key in ("batch_b", "num_batches_k"):
    values = re.findall(rf"^{key}[ \t]*=[ \t]*([0-9]+)[ \t]*(?:#.*)?$", params_text, re.MULTILINE)
    if len(values) != 1:
        raise SystemExit("the circuit parameters need one integer for " + key)
    params[key] = int(values[0])
with open(manifest_file) as file:
    manifest = json.load(file)
for key in ("batch_b", "num_batches_k"):
    if params[key] != manifest[key]:
        raise SystemExit("the circuit shape differs from the release manifest")
capacity = params["batch_b"] * params["num_batches_k"]
if len(rows) > capacity or capacity & (capacity - 1):
    raise SystemExit("the fixture does not fit the binary tree")
for name, selected in (("first.csv", rows[1:]), ("second.csv", rows)):
    with open(directory / name, "w") as file:
        writer = csv.DictWriter(file, fieldnames=["id", "balance"])
        writer.writeheader()
        writer.writerows(selected)
(directory / "master.secret").write_text("0x" + secrets.token_hex(int(secret_bytes)))
(directory / "inputs.json").write_text(json.dumps({
    "omitted_id": rows[0]["id"], "answered_id": rows[1]["id"],
    "reserve_amount": str(sum(int(row["balance"]) for row in rows)),
    "tree_capacity": capacity,
}))
(directory / "deployments.json").write_text(json.dumps([{
    "network": "testnet", "registry": registry, "verifier": verifier,
    "tree_depth": capacity.bit_length() - 1,
}]))
PYTHON
RESERVE_AMOUNT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["reserve_amount"])' "$PRIVATE/inputs.json")
run mint-reserves stellar contract invoke --id "$ASSET" --source "$ISSUER_ALIAS" \
  --network testnet --send yes -- mint --to "$RESERVE" --amount "$RESERVE_AMOUNT"
run register env STELLAR_SOURCE_ACCOUNT="$ISSUER_ALIAS" \
  bash "$ROOT_DIR/scripts/register_asset.sh" --contract "$ASSET" "$RESERVE_ALIAS"

for generation in first second; do
  SNAPSHOT=$(current_ledger)
  if [[ "$generation" == first ]]; then
    FIRST_SNAPSHOT=$SNAPSHOT
  fi
  CONTEXT="$PRIVATE/$generation.toml"
  cat >"$CONTEXT" <<EOF
authority = "$ISSUER"
asset = "$ASSET"
reserves = ["$RESERVE"]
snapshot_ledger = $SNAPSHOT
EOF
  run "attest-$generation" env STELLAR_SOURCE_ACCOUNT="$ISSUER_ALIAS" \
    ZKPOR_MASTER_SECRET_FILE="$PRIVATE/master.secret" ZKPOR_PACKAGES_OUT="$PRIVATE" \
    ZKPOR_WORK="$PRIVATE/$generation" ZKPOR_DEPLOYMENTS="$PRIVATE/deployments.json" \
    bash "$ROOT_DIR/scripts/attest.sh" "$CONTEXT" "$PRIVATE/$generation.csv"
  cp "$PRIVATE/$generation/proof" "$PUBLIC/$generation-proof.bin"
  cp "$PRIVATE/$generation/public_inputs" "$PUBLIC/$generation-public-inputs.bin"
done

# Use the package parser to select evidence. No balance or salt enters output.
node --input-type=module - "$ROOT_DIR/sdk/dist/index.js" "$PRIVATE" >"$PRIVATE/packages.paths" <<'JAVASCRIPT'
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { parsePackage, PACKAGE_EXTENSION } = await import(pathToFileURL(process.argv[2]).href);
const directory = process.argv[3];
const inputs = JSON.parse(readFileSync(join(directory, "inputs.json"), "utf8"));
function find(generation, identifier) {
  const root = readFileSync(join(directory, generation, "packages.path"), "utf8").trim();
  for (const name of readdirSync(root).filter((name) => name.endsWith(`.${PACKAGE_EXTENSION}`))) {
    const file = join(root, name);
    const value = parsePackage(readFileSync(file, "utf8"));
    if (value.id === BigInt(identifier)) return file;
  }
  throw new Error("the expected identifier has no accepted package");
}
console.log(find("first", inputs.answered_id));
console.log(find("second", inputs.answered_id));
console.log(find("second", inputs.omitted_id));
JAVASCRIPT
{
  IFS= read -r ANSWER_OLD
  IFS= read -r ANSWER_NEW
  IFS= read -r OMITTED_PACKAGE
} <"$PRIVATE/packages.paths"
run answered-open env STELLAR_SOURCE_ACCOUNT="$DISPUTER_ALIAS" \
  bash "$ROOT_DIR/scripts/dispute_example.sh" open "$ANSWER_OLD"
run answered-close env STELLAR_SOURCE_ACCOUNT="$ISSUER_ALIAS" \
  bash "$ROOT_DIR/scripts/dispute_example.sh" answer "$ANSWER_NEW"
read -r ANSWER_TARGET ANSWER_ID < <(python3 - "$PUBLIC/answered-open.out" <<'PYTHON'
import json, sys
record = json.load(open(sys.argv[1]))
print(record["target_id"], record["identifier"])
PYTHON
)
run answered-record stellar contract invoke --id "$ZKPOR_REGISTRY" --source "$ISSUER_ALIAS" \
  --network testnet --send no -- get_dispute --asset "$ASSET" \
  --target_id "$ANSWER_TARGET" --id "$ANSWER_ID"
run bond env STELLAR_SOURCE_ACCOUNT="$ISSUER_ALIAS" \
  bash "$ROOT_DIR/scripts/dispute_example.sh" bond "$ANSWER_NEW" "$BOND_STROOPS"

# This replay is the adversarial operation. The original proof must still fit
# the registry's snapshot window. The registry verifies the proof again.
SNAPSHOT=$FIRST_SNAPSHOT
WINDOW=$(node --input-type=module - "$ROOT_DIR/sdk/dist/index.js" <<'JAVASCRIPT'
import { pathToFileURL } from "node:url";
const { ATTESTATION_MAX_AGE_LEDGERS } = await import(pathToFileURL(process.argv[2]).href);
console.log(ATTESTATION_MAX_AGE_LEDGERS);
JAVASCRIPT
)
LEDGER=$(current_ledger)
(( LEDGER >= SNAPSHOT && LEDGER - SNAPSHOT < WINDOW )) || die "the first snapshot expired; start a new demonstration"
read -r PROOF_ROOT TOTAL < <(python3 "$ROOT_DIR/scripts/public_input_fields.py" \
  "$PUBLIC/first-public-inputs.bin" "$MANIFEST_FILE")
run omitted-target stellar contract invoke --id "$ZKPOR_REGISTRY" --source "$ISSUER_ALIAS" \
  --network testnet --send yes -- submit_attestation --asset "$ASSET" \
  --snapshot_ledger "$SNAPSHOT" --final_root "$PROOF_ROOT" --total_liabilities "$TOTAL" \
  --proof-file-path "$PUBLIC/first-proof.bin"
TARGET_ID=$(python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1]))))' "$PUBLIC/omitted-target.out")
run omitted-record stellar contract invoke --id "$ZKPOR_REGISTRY" --source "$ISSUER_ALIAS" \
  --network testnet --send no -- get_attestation --asset "$ASSET" --id "$TARGET_ID"
python3 - "$PUBLIC/omitted-record.out" "$PROOF_ROOT" "$TOTAL" "$SNAPSHOT" <<'PYTHON'
import json, sys
record = json.load(open(sys.argv[1]))
for name, expected in zip(("final_root", "total_liabilities", "snapshot_ledger"), sys.argv[2:]):
    if int(record[name]) != int(expected):
        raise SystemExit("the stored target differs from the replayed proof: " + name)
PYTHON
run pending-open env STELLAR_SOURCE_ACCOUNT="$DISPUTER_ALIAS" \
  bash "$ROOT_DIR/scripts/dispute_example.sh" open "$OMITTED_PACKAGE" "$TARGET_ID"

python3 - "$PUBLIC" "$ZKPOR_REGISTRY" "$ZKPOR_VERIFIER" "$ASSET" \
  "$ISSUER" "$RESERVE" "$DISPUTER" "$BOND_STROOPS" <<'PYTHON'
import hashlib, json, pathlib, re, sys
directory = pathlib.Path(sys.argv[1])
labels = ["register", "attest-first", "attest-second", "answered-open",
          "answered-close", "bond", "omitted-target", "pending-open"]
transactions = {}
for label in labels:
    text = (directory / (label + ".out")).read_text() + (directory / (label + ".log")).read_text()
    hashes = re.findall(r"(?:Signing transaction: |transaction )([0-9a-f]{64})", text)
    if not hashes:
        raise SystemExit("no transaction hash for " + label)
    transactions[label] = list(dict.fromkeys(hashes))
read = lambda name: json.loads((directory / name).read_text())
opened = read("pending-open.out")
answered = read("answered-record.out")
if int(opened["target_id"]) != int(read("omitted-target.out")):
    raise SystemExit("the pending dispute names another target")
report = dict(zip(["registry", "verifier", "asset", "issuer", "reserve", "disputer", "bond_stroops"], sys.argv[2:]))
report.update({
    "network": "testnet", "reserve_kind": "synthetic demonstration token",
    "settlement_asset": "native testnet XLM", "transactions": transactions,
    "answered_dispute": answered, "pending_dispute": opened,
    "omitted_target": read("omitted-record.out"),
    "first_proof_sha256": hashlib.sha256((directory / "first-proof.bin").read_bytes()).hexdigest(),
    "resolution_first_ledger": int(opened["deadline"]) + 1,
})
(directory / "evidence.json").write_text(json.dumps(report, indent=2) + "\n")
print("Public evidence: " + str(directory / "evidence.json"))
print("Resolve after ledger " + str(opened["deadline"]) + ".")
PYTHON
printf 'Resolution command: ZKPOR_NETWORK=testnet STELLAR_SOURCE_ACCOUNT=%q bash %q resolve %q %q\n' \
  "$DISPUTER_ALIAS" "$ROOT_DIR/scripts/dispute_example.sh" "$OMITTED_PACKAGE" "$TARGET_ID"
