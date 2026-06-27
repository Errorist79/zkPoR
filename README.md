# zkPoR

ZK Proof of Reserves on Stellar (Soroban). An issuer proves that its reserves
cover the customer liabilities. The proof does not reveal the individual
balances. The proof is an UltraHonk zero-knowledge proof. A Soroban contract
verifies the proof on-chain with the CAP-0080 BN254 host functions. The project
validates the recursive path on the real Stellar testnet at Protocol 27.

See [`docs/architecture.md`](docs/architecture.md) for the design. See
[`SECURITY.md`](SECURITY.md) for the security model and the on-chain validation.

## How it works

A liabilities proof must cover every customer. The on-chain verification is the
binding cost. This cost is fixed for each proof, and the network limits the
instructions for each transaction. The system therefore proves the customers in
batches. It then folds the batch proofs into one terminal proof with recursive
aggregation. One on-chain verification then covers the full set.

Each batch hashes its `(id, balance)` leaves into a subroot. Each batch also adds
its balances into a subtotal. The aggregator verifies every batch proof
in-circuit. It composes the subroots into one final root. It adds the subtotals
into the published total.

Recursion adds one subtlety. The in-circuit recursive verify does not run its
final pairing. It defers that pairing into the pairing-point accumulator of the
proof. The on-chain verifier completes that pairing. The completed pairing binds
the folded proofs to the pinned circuit, and it makes the recursive path sound.
See [`SECURITY.md`](SECURITY.md).

## Layout

```
contracts/verifier/   host-accelerated UltraHonk verifier contract
contracts/vendor/     vendored verifier crate, completed-pairing patch (see VENDOR.md)
circuits/recursion/   inner batch circuit, hardened aggregator, shared lib
circuits/simple_circuit/ reference circuit for a known-good verify check
tools/recursion-gen/  off-circuit fold and witness generator
tools/gate/           end-to-end soundness gate and adversarial harness
scripts/              toolchain setup, localnet, deploy, verify
docs/architecture.md  system design
```

## Pinned versions

Single source of truth: [`scripts/versions.env`](scripts/versions.env) and
[`rust-toolchain.toml`](rust-toolchain.toml).

| Component | Version | Notes |
|---|---|---|
| Nargo (Noir) | `1.0.0-beta.9` | proof and VK generation |
| Barretenberg (`bb`) | `0.87.0` | `--scheme ultra_honk --oracle_hash keccak` |
| `bb_proof_verification` | `v0.87.0` | in-circuit recursive verify; 456-field proof, 112-field vk |
| noir-lang/poseidon | `v0.2.0` | in-circuit Poseidon2 |
| soroban-poseidon | `26.0.0` | host-side Poseidon2 in the witness generator |
| Rust | `1.96.0` | target `wasm32v1-none` |
| soroban-sdk | `26.0.1` | workspace dependency; builds unchanged and runs on P27 |
| Stellar CLI | `27.0.0` | must match the network protocol; testnet is P27 |
| Quickstart image | `nightly` (Protocol `27` via `--protocol-version 27`) | moving tag, so the flag is the real pin; `future` stops at P26 |
| Verifier crate | vendored in `contracts/vendor/ultrahonk-soroban-verifier` | completed-pairing patch; provenance in VENDOR.md |

## Build and run

The build needs Linux with Docker. It also needs the BN254 host functions and the
real proving toolchain.

```bash
# 0. One-time: install the exact pinned toolchain
bash scripts/setup.sh
export PATH="$HOME/.local/bin:$HOME/.nargo/bin:$HOME/.bb/bin:$HOME/.cargo/bin:$PATH"

# 1. Start a Protocol 27 localnet (quickstart "nightly" image, core v27.1.0).
#    The --protocol-version flag is the real protocol pin; nightly is a moving tag.
stellar container start local --limits unlimited --image-tag-override nightly --protocol-version 27

# 2. Run the end-to-end soundness gate (builds the production verifier, deploys
#    it, and proves the recursive path is sound: honest ACCEPT, forged/deflated REJECT)
bash tools/gate/soundness-gate.sh
```

A green run prints `SOUNDNESS-GATE PASS`. The gate also runs in CI on a
self-hosted runner. See [`tools/gate/README.md`](tools/gate/README.md).

## Attribution

The verifier crate is `NethermindEth/rs-soroban-ultrahonk` (MIT, Copyright 2025
yugocabrio & indextree). yugocabrio wrote it as a host-accelerated port of the
indextree pure-Wasm UltraHonk verifier. Nethermind maintains it. This project
vendors the crate in `contracts/vendor/ultrahonk-soroban-verifier` with the
completed-pairing patch. The `VENDOR.md` file of that directory records what
this project changed and what it left alone. The `VERIFIER_PROVENANCE.md` file
beside it is an upstream document that is kept unchanged, and `VENDOR.md`
states its limits. The source rev is in `scripts/versions.env`.
