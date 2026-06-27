# Vendored crate provenance

Upstream: https://github.com/NethermindEth/rs-soroban-ultrahonk
Origin: yugocabrio wrote the crate as a host-accelerated port of the indextree
pure-Wasm UltraHonk verifier. Nethermind maintains it. MIT, Copyright 2025
yugocabrio & indextree.
Rev: 661db07200f890b1bd9a7349ed787c70a706dd12 (also recorded in scripts/versions.env)
Crate: `crates/ultrahonk-soroban-verifier` (package `ultrahonk_soroban_verifier`)

This directory is a verbatim copy of that crate at the rev above, with one
change:

- `src/verifier.rs` carries the **completed-pairing patch**. `verify()` calls
  `complete_pairing_point_accumulator`, which runs `crate::ec::pairing_check` on
  the 16-limb pairing-point accumulator after Shplemini. This is the **naive
  separate `pairing_check`** form, not the batched-into-Shplemini optimization.
  It closes the deferred-pairing soundness gap that the upstream verifier and the
  reference verifier leave open.

Three test items of the upstream crate are not vendored:

- the `tests/` directory (`verifier_test.rs`, `negative_tests.rs`);
- the `#[cfg(test)] mod tests` block in `src/transcript.rs`;
- the sibling `test-utils` crate.

They load the demo circuits of the reference repository (`simple_circuit` and
`fib_chain`) through `Fixture::load`, and those circuits are not part of this
system. The self-contained unit tests stay: field, sumcheck, relations, utils,
and debug. The assembly gate covers the end-to-end soundness.

`Cargo.toml` changes as a result: the `ultrahonk-test-utils` path dependency is
absent, and a comment records why. This is the only other file that differs
from upstream. Every other file in this directory is byte for byte the upstream
file.

## About VERIFIER_PROVENANCE.md

`VERIFIER_PROVENANCE.md` in this directory is an upstream file. It is kept byte
for byte as upstream wrote it, and this project makes no claim in it.

Read it with these limits in mind:

- Upstream wrote it against Barretenberg tag v0.82.2. This project pins `bb`
  0.87.0, so the constants and the module map in that file describe an earlier
  Barretenberg version than the one that produces the proofs here.
- It describes the test fixtures and the scripts of the upstream repository.
  Those fixtures and scripts do not exist here.
- Upstream names a tool run as the auditor of that review. It is a
  correspondence record between the Rust code and the Barretenberg source. It
  is not an independent security audit, and this project does not present it as
  one.

The file is useful for one purpose: it maps each Rust module to the
Barretenberg component that it mirrors. That map helps a reviewer who compares
the two code bases. Treat every other statement in it as upstream history.
