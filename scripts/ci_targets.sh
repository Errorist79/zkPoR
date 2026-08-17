#!/usr/bin/env bash
# The test targets of this repository, and the check that the list is complete.
#
# The root Cargo workspace holds the contract crates only. Every other Rust
# crate declares its own workspace, so `cargo test --workspace` does not reach
# it. A job that trusted the workspace would run none of those crates, and the
# cross-language agreement of the test vectors rests on one of them.
#
# This file therefore names each target. A named list can go stale, so `check`
# compares the list against every crate that git tracks. A new crate that
# nobody adds here fails the check instead of going unrun.
#
# `check` needs a git work tree, because the git index is what tells a committed
# crate from a scratch directory that somebody left in the tree. It therefore
# runs against a clone, and it stops with a message of its own against an
# exported copy of the sources. The other commands read no index and run
# anywhere. This is a property of the check and not a defect of it.
#
# usage:
#   ci_targets.sh check                 compare the lists with what git tracks
#                                       (needs a git work tree)
#   ci_targets.sh workspace-packages    the root members, without the vendored crate
#   ci_targets.sh standalone-crates     the crates outside the root workspace
#   ci_targets.sh noir-packages         the Noir packages
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# The vendored verifier crate. It stays byte for byte as its author wrote it,
# so the format check and the lint check skip it. Its tests still run, because
# it is a member of the root workspace.
VENDORED_CRATE="contracts/vendor/ultrahonk-soroban-verifier"

# The Rust crates that stand outside the root workspace. Each one declares its
# own workspace, so each one needs its own test run.
STANDALONE_CRATES=(
  tools/package
  tools/inclusion-verify
  tools/recursion-gen
  tools/gate/reserve-account
)

# The Noir packages. A package without a test still compiles here, which
# catches a source that no longer builds at the pinned compiler.
NOIR_PACKAGES=(
  circuits/recursion/common
  circuits/recursion/inner
  circuits/recursion/agg
  circuits/simple_circuit
  tools/gate/attacks/inner_evil
  tools/gate/attacks/inner_stale_leaf
)

# The directories of the members of the root workspace, from the root manifest.
# The value is derived, so a member that joins the workspace needs no edit here.
root_member_dirs() {
  sed -n '/^members = \[/,/^]/p' Cargo.toml \
    | sed -nE 's/^[[:space:]]*"([^"]+)",?[[:space:]]*$/\1/p'
}

# The package name that one manifest declares.
package_name() {
  sed -nE 's/^name = "([^"]+)"$/\1/p' "$1/Cargo.toml" | head -1
}

# The names of the root members, without the vendored crate.
workspace_packages() {
  local dir
  for dir in $(root_member_dirs); do
    [ "$dir" = "$VENDORED_CRATE" ] && continue
    package_name "$dir"
  done
}

standalone_crates() { printf '%s\n' "${STANDALONE_CRATES[@]}"; }
noir_packages() { printf '%s\n' "${NOIR_PACKAGES[@]}"; }

# The directories of every manifest of one kind that git tracks. The discovery
# reads the index, so an untracked scratch directory never enters the check and
# a committed crate always does.
#
# The rule needs the index, so the check runs against a clone and not against an
# exported copy of the sources.
tracked_dirs() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ci_targets.sh reads the git index to find every committed crate, and this directory is not a git work tree" >&2
    exit 1
  fi
  git ls-files "*$1" | sed 's|/*'"$1"'$||' | sed 's|^$|.|' | sort -u
}

# Reports the entries of one set that the other set does not hold.
missing_from() {
  comm -23 <(printf '%s\n' "$1" | sort -u) <(printf '%s\n' "$2" | sort -u)
}

check() {
  local failed=0

  # Every tracked Rust crate is either a member of the root workspace or a
  # named standalone crate. The root manifest itself holds no package.
  local tracked expected unlisted absent
  tracked=$(tracked_dirs Cargo.toml | grep -v '^\.$')
  expected=$(printf '%s\n%s\n' "$(root_member_dirs)" "$(standalone_crates)")

  unlisted=$(missing_from "$tracked" "$expected")
  if [ -n "$unlisted" ]; then
    echo "these Rust crates run nowhere; add each one to STANDALONE_CRATES or to the root workspace:" >&2
    echo "$unlisted" >&2
    failed=1
  fi
  absent=$(missing_from "$expected" "$tracked")
  if [ -n "$absent" ]; then
    echo "these Rust crates are named here and git tracks no manifest for them:" >&2
    echo "$absent" >&2
    failed=1
  fi

  # The same rule for the Noir packages.
  tracked=$(tracked_dirs Nargo.toml)
  unlisted=$(missing_from "$tracked" "$(noir_packages)")
  if [ -n "$unlisted" ]; then
    echo "these Noir packages run nowhere; add each one to NOIR_PACKAGES:" >&2
    echo "$unlisted" >&2
    failed=1
  fi
  absent=$(missing_from "$(noir_packages)" "$tracked")
  if [ -n "$absent" ]; then
    echo "these Noir packages are named here and git tracks no manifest for them:" >&2
    echo "$absent" >&2
    failed=1
  fi

  # A standalone crate must really stand alone. A crate that joins the root
  # workspace and stays on this list would run twice, and the second run would
  # fail on a manifest that names no workspace.
  local dir
  for dir in "${STANDALONE_CRATES[@]}"; do
    # A manifest that git does not track already failed above, and this loop
    # must not report the same entry a second time as a missing file.
    [ -f "$dir/Cargo.toml" ] || continue
    if ! grep -q '^\[workspace\]' "$dir/Cargo.toml"; then
      echo "$dir is a standalone target and its manifest declares no workspace" >&2
      failed=1
    fi
  done

  [ "$failed" -eq 0 ] || exit 1
  echo "every crate that git tracks has a test run: $(printf '%s\n' "$tracked" | wc -l | tr -d ' ') Noir packages, $(tracked_dirs Cargo.toml | grep -vc '^\.$') Rust crates"
}

case "${1:-}" in
  check) check ;;
  workspace-packages) workspace_packages ;;
  standalone-crates) standalone_crates ;;
  noir-packages) noir_packages ;;
  vendored-crate) echo "$VENDORED_CRATE" ;;
  *)
    echo "usage: ci_targets.sh check|workspace-packages|standalone-crates|noir-packages|vendored-crate" >&2
    exit 2
    ;;
esac
