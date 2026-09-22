#!/usr/bin/env bash
# Exercise the dispute contract with accepted inclusion packages on testnet.
#
# Usage:
#   dispute_example.sh open <old-package.json> [target-id]
#   dispute_example.sh answer <target-package.json>
#   dispute_example.sh resolve <old-package.json> <target-id>
#   dispute_example.sh bond <package.json> <stroops>
#
# Set ZKPOR_NETWORK=testnet and STELLAR_SOURCE_ACCOUNT to a funded identity.
# Open uses the disputer identity. Answer and bond use the registered issuer.
# Resolve accepts any fee payer after the deadline that the open call returns.
# An absent target selects the newest attestation. Each target and identifier
# permit one dispute, including after settlement.
#
# The package stays on this machine. The contract receives only public evidence.
# A bond has no withdrawal path, including before a dispute.
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"
set -euo pipefail

die() { printf 'dispute: %s\n' "$*" >&2; exit 1; }

[[ "$ZKPOR_NETWORK" == testnet ]] || die "set ZKPOR_NETWORK=testnet"
[[ $# -ge 2 && $# -le 3 ]] || die "use open, answer, resolve, or bond with a package file"
MODE=$1
PACKAGE=$2
VALUE=${3:-}
case "$MODE" in
  open) ;;
  answer) [[ $# == 2 ]] || die "answer takes one target package" ;;
  resolve|bond) [[ $# == 3 ]] || die "$MODE needs a package and a target identifier or amount" ;;
  *) die "unknown command: $MODE" ;;
esac
for binary in stellar node; do
  command -v "$binary" >/dev/null || die "missing tool: $binary"
done
[[ -f "$ROOT_DIR/sdk/dist/index.js" ]] || die "run npm run build --workspace sdk first"

PUBLIC_INPUT=$(mktemp)
NOTES=$(mktemp)
trap 'rm -f "$PUBLIC_INPUT" "$NOTES"' EXIT

# The package reader checks the commitment before this code extracts evidence.
node --input-type=module - "$ROOT_DIR/sdk/dist/index.js" "$PACKAGE" >"$PUBLIC_INPUT" <<'JAVASCRIPT'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { parsePackage, passphraseOfNetwork } = await import(pathToFileURL(process.argv[2]).href);
const packageValue = parsePackage(readFileSync(process.argv[3], "utf8"));
if (packageValue.network !== "testnet") {
  throw new Error("the package must name testnet");
}
if (process.env.STELLAR_NETWORK_PASSPHRASE !== passphraseOfNetwork("testnet")) {
  throw new Error("the configured passphrase must name testnet");
}
const evidence = {
  id: packageValue.id.toString(),
  commitment: packageValue.commitment.toString(),
  path: packageValue.siblings.map((sibling) => sibling.toString()),
  position: packageValue.leafIndex,
};
console.log(packageValue.registry);
console.log(packageValue.asset);
console.log(packageValue.attestationId.toString());
console.log(packageValue.id.toString());
console.log(JSON.stringify(evidence));
console.log(JSON.stringify({ Inclusion: {
  attestation_id: packageValue.attestationId.toString(), inclusion: evidence,
} }));
JAVASCRIPT

{
  IFS= read -r REGISTRY
  IFS= read -r ASSET
  IFS= read -r ATTESTATION_ID
  IFS= read -r IDENTIFIER
  IFS= read -r EVIDENCE
  IFS= read -r OPENING
} <"$PUBLIC_INPUT"

invoke() {
  local send=$1 result
  shift
  if ! result=$(stellar contract invoke --id "$REGISTRY" \
    --source "$STELLAR_SOURCE_ACCOUNT" --network "$ZKPOR_NETWORK" \
    --send="$send" -- "$@" 2>"$NOTES"); then
    cat "$NOTES" >&2
    die "the contract call failed"
  fi
  cat "$NOTES" >&2
  printf '%s\n' "$result"
}

case "$MODE" in
  open)
    DISPUTER=$(stellar keys address "$STELLAR_SOURCE_ACCOUNT")
    invoke yes open_dispute --asset "$ASSET" --disputer "$DISPUTER" \
      --target "${VALUE:-null}" --evidence "$OPENING"
    ;;
  answer)
    invoke yes answer_dispute --asset "$ASSET" --target_id "$ATTESTATION_ID" \
      --evidence "$EVIDENCE"
    invoke no get_dispute --asset "$ASSET" --target_id "$ATTESTATION_ID" --id "$IDENTIFIER"
    ;;
  resolve)
    invoke yes resolve_dispute --asset "$ASSET" --target_id "$VALUE" --id "$IDENTIFIER"
    invoke no get_dispute --asset "$ASSET" --target_id "$VALUE" --id "$IDENTIFIER"
    invoke no get_bond --asset "$ASSET"
    ;;
  bond)
    invoke yes fund_bond --asset "$ASSET" --amount "$VALUE"
    invoke no get_bond --asset "$ASSET"
    ;;
esac
