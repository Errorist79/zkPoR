#!/usr/bin/env bash
# Compile the production circuits with the pinned Noir + Barretenberg toolchain.
#
# The recursion circuits (common lib + inner/agg bins) form a multi-stage
# pipeline: generate params/witnesses, prove each inner batch with the poseidon2
# oracle, recursively fold them in the aggregator, then emit the terminal keccak
# proof. That full pipeline and its soundness checks are driven by the
# end-to-end gate, NOT here. This script is a fast BUILD CHECK: it regenerates
# the inner params/witnesses from the single-source params.toml and compiles the
# circuits. It also still builds any standalone single circuit (e.g.
# simple_circuit) via the generic prove path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIRCUITS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CIRCUITS_DIR}/.." && pwd)"
source "${REPO_ROOT}/scripts/versions.env"

export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"

install_nargo() {
  command -v nargo >/dev/null 2>&1 && return
  echo "• installing nargo ${NARGO_VERSION}"
  curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | \
    NOIR_VERSION="${NARGO_VERSION}" bash
  export PATH="$HOME/.nargo/bin:$PATH"
  noirup -v "${NARGO_VERSION}"
}

install_bb() {
  command -v bb >/dev/null 2>&1 && return
  echo "• installing bb ${BB_VERSION}"
  mkdir -p "$HOME/.bb/bin"
  uname_s=$(uname -s | tr '[:upper:]' '[:lower:]')
  uname_m=$(uname -m)
  case "${uname_s}_${uname_m}" in
    linux_x86_64)  file="barretenberg-amd64-linux.tar.gz" ;;
    darwin_arm64)  file="barretenberg-arm64-darwin.tar.gz" ;;
    darwin_x86_64) file="barretenberg-amd64-darwin.tar.gz" ;;
    *) echo "unsupported platform ${uname_s}_${uname_m}"; exit 1 ;;
  esac
  curl -L "https://github.com/AztecProtocol/aztec-packages/releases/download/${BB_VERSION}/${file}" -o /tmp/bb.tar.gz
  tar -xzf /tmp/bb.tar.gz -C "$HOME/.bb/bin"
  chmod +x "$HOME/.bb/bin/bb"
  export PATH="$HOME/.bb/bin:$PATH"
}

# Compile the recursion circuit set. Full proving + recursive folding + VK
# pinning + the terminal keccak proof are produced by the soundness gate, not
# here; this is a build check off the single-source params.toml.
build_recursion() {
  local rec="${CIRCUITS_DIR}/recursion"
  [[ -d "$rec" ]] || { echo "skip recursion (no ${rec})"; return; }
  echo "=== Building recursion circuits (common, inner, agg) ==="

  # Regenerate common/src/params.nr + inner/Prover_<k>.toml from params.toml +
  # fixtures using the same off-circuit generator the gate uses. This is a build
  # check, so it reads the test-only context and the test-only master secret. A
  # real attestation supplies its own context file and its own secret.
  if command -v cargo >/dev/null 2>&1; then
    (
      . "${REPO_ROOT}/fixtures/test_only_master_secret.env"
      export ZKPOR_MASTER_SECRET="$TEST_ONLY_MASTER_SECRET"
      cd "${REPO_ROOT}/tools/recursion-gen" && cargo run --release --quiet -- witness \
        "${REPO_ROOT}/fixtures/test_only_context.toml" \
        "${REPO_ROOT}/circuits/recursion/inner/fixtures/customers_below_capacity.csv"
    )
  else
    echo "  (cargo not found. Compiles the committed params, skips the witness regen.)"
  fi

  for c in common inner agg; do
    echo "--- nargo compile ${c} ---"
    ( cd "${rec}/${c}" && nargo compile )
  done
  echo "Recursion circuits compiled. Proof generation, the aggregation fold, the"
  echo "inner-VK pin, and the terminal keccak proof are produced by the gate."
}

# Generic build for a standalone single circuit (compile + prove with keccak).
build_circuit() {
  local name="$1"
  local dir="${CIRCUITS_DIR}/${name}"
  [[ -f "${dir}/Nargo.toml" ]] || { echo "skip ${name} (no Nargo.toml)"; return; }

  echo "=== Building ${name} ==="
  pushd "${dir}" >/dev/null

  # Optional per-circuit witness generation before nargo runs.
  [[ -f pregen.sh ]] && bash pregen.sh

  [[ -f Prover.toml ]] || nargo check --overwrite
  nargo compile
  nargo execute

  local project_name json gz
  project_name=$(grep -E '^name\s*=\s*"' Nargo.toml | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')
  json="target/${project_name}.json"
  gz="target/${project_name}.gz"
  [[ -f "${json}" && -f "${gz}" ]] || { echo "missing ACIR or witness"; popd >/dev/null; exit 1; }

  # keccak oracle: required for the on-chain/EVM-style transcript the verifier expects.
  bb prove --scheme ultra_honk --oracle_hash keccak \
    --bytecode_path "${json}" --witness_path "${gz}" \
    --output_path target --output_format bytes_and_fields
  bb write_vk --scheme ultra_honk --oracle_hash keccak \
    --bytecode_path "${json}" \
    --output_path target --output_format bytes_and_fields

  # bb may emit some outputs as directories; flatten to files.
  if [[ -d target/vk && -f target/vk/vk ]]; then
    mv target/vk/vk target/vk.tmp; rmdir target/vk; mv target/vk.tmp target/vk
  fi
  if [[ -d target/vk_fields.json && -f target/vk_fields.json/vk_fields.json ]]; then
    mv target/vk_fields.json/vk_fields.json target/vk_fields.json.tmp
    rmdir target/vk_fields.json; mv target/vk_fields.json.tmp target/vk_fields.json
  fi

  popd >/dev/null
}

install_nargo
install_bb

# Default: build the recursion circuits. Pass circuit names to build specific
# ones; "recursion" routes to the recursion build, any other name to the generic
# single-circuit path (e.g. `build_all.sh simple_circuit`).
if [[ "$#" -gt 0 ]]; then
  for name in "$@"; do
    if [[ "$name" == "recursion" ]]; then build_recursion; else build_circuit "$name"; fi
  done
else
  build_recursion
fi
