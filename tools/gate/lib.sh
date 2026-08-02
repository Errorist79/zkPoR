#!/usr/bin/env bash
# Pieces that both gates use: the localnet check and one inner proof.
#
# A gate sources this file after it sets REPO_ROOT, RPC, NET, and the pinned
# proof scheme and oracle hashes.

# Changes directory, or stops the run.
#
# A gate runs without exit-on-error, so a failed change would leave the shell
# in the directory it started from, and the next command would act there. Some
# of those commands remove a directory tree.
enter() {
  cd "$1" || die "cannot enter $1"
}

rpc_healthy() {
  curl -s -m 5 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" 2>/dev/null | grep -q '"status":"healthy"'
}

# The image tag moves, so the protocol comes from the explicit flag and not
# from the tag.
ensure_localnet() {
  rpc_healthy && return 0
  if [ "${START_LOCALNET:-0}" = "1" ]; then
    note "localnet RPC unreachable; starting quickstart:$QUICKSTART_IMAGE_TAG (P$PROTOCOL_VERSION) container"
    stellar container start "$NET" --limits unlimited \
      --image-tag-override "$QUICKSTART_IMAGE_TAG" \
      --protocol-version "$PROTOCOL_VERSION" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do rpc_healthy && { note "localnet RPC healthy"; return 0; }; sleep 5; done
  fi
  die "localnet RPC unreachable at $RPC (infra). Start a Protocol-$PROTOCOL_VERSION localnet, or set START_LOCALNET=1."
}

# bytecode witness outdir
prove_inner() {
  bb prove --scheme "$PROOF_SCHEME" --oracle_hash "$INNER_ORACLE_HASH" --honk_recursion 1 \
    --bytecode_path "$1" --witness_path "$2" --output_path "$3" \
    --output_format bytes_and_fields
}
