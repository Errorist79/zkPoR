# Gates

This directory holds two on-chain gates. `soundness-gate.sh` attacks the
verifier. `registry-gate.sh` exercises the registry end to end. Each gate
exits non-zero and loud on any failure, including an infrastructure error.

# Soundness gate

`soundness-gate.sh` is the end-to-end on-chain soundness gate for the production
Proof-of-Reserves pipeline. It builds the production artifacts. It deploys the
production verifier to a Protocol-27 Soroban localnet. It then tries to break the
system, to show that the system is sound. It exits non-zero and loud on any
failure, including an infrastructure error.

## What it exercises (production only)

- `circuits/recursion/{inner,agg,common}`: the inner batch circuit with its range
  checks, plus the hardened aggregator (inner-VK pin, shared binding root, slot
  anti-replay).
- `tools/recursion-gen`: the off-circuit fold and witness generator. It reads
  the release configuration from `circuits/recursion/params.toml`, and it
  refuses to write the pin or the manifest for another configuration.
- `contracts/verifier`: the host-accelerated UltraHonk verifier. It vendors
  `contracts/vendor/ultrahonk-soroban-verifier`, which completes the deferred
  pairing-point accumulator on-chain.
- `tools/gate/attacks/` plus `tools/gate/cheats.py`: the adversarial
  scaffolding. This gate is the only user of that scaffolding. It is never part
  of the production path.
- `circuits/recursion/manifest.json`: the generated record of the artifact. It
  holds the batch values, both key hashes, and the public input positions. The
  gate reads the positions from it, and the deploy step stops when the key to
  deploy is not the key that the manifest records.

## Verdict

- `honest`: on-chain ACCEPT.
- `foreigncontext` (the honest proof, with one changed `context_hash` and the
  other three public inputs untouched): on-chain REJECT. This case shows that
  the unconstrained public parameter enters the proof transcript.
- `forged` (a foreign inner proof under the pinned VK array): on-chain REJECT.
- `deflated` (a foreign inner proof without the range check, balance -100):
  on-chain REJECT.

A green run means that the deployed verifier accepts the honest case and rejects
all three attacks.

## Running locally

```sh
bash tools/gate/soundness-gate.sh
```

The gate needs the pinned toolchain on `PATH` and a Protocol-27 localnet (see
below). Useful environment variables:

- `SKIP_WASM_BUILD=1`: reuse a verifier wasm that is already optimized and built.
- `START_LOCALNET=1`: start the quickstart:nightly localnet (Protocol 27 via
  `--protocol-version 27`) if the RPC is down.
- `SOROBAN_RPC`: override the localnet RPC (default `http://localhost:8000/soroban/rpc`).

## Self-hosted CI runner requirement

`.github/workflows/soundness-gate.yml` targets a **self-hosted** runner with the
labels `self-hosted, zkpor`. The gate needs the BN254 host functions and a real
proving toolchain, so it cannot run on a hosted GitHub runner. The host of the
runner must make the pinned toolchain from `scripts/versions.env` available on
`PATH`. `scripts/setup.sh` installs that toolchain, and it is safe to run the
script again. The last step of the script compares each installed version with
the pin, and the script fails when a version does not match:

- Rust 1.96.0 (`cargo`, `rustc`) plus the targets `wasm32v1-none` and
  `wasm32-unknown-unknown`.
- nargo 1.0.0-beta.9 (`~/.nargo/bin`).
- Barretenberg `bb` 0.87.0 (`~/.bb/bin`). The official release needs a newer
  glibc and libstdc++ than some hosts give. `scripts/setup.sh` runs the
  downloaded binary one time. If the run fails, the setup installs a thin
  wrapper at that path, and the wrapper runs the real `bb` in an `ubuntu:24.04`
  container. The image tag holds the pinned `bb` version and a hash of the
  image recipe, so a change to either one builds a new image.
- Stellar CLI 27.0.0 (`~/.local/bin`).
- Docker, for the localnet and, where applicable, for the `bb` wrapper.
  `scripts/setup.sh` does not install Docker, because an install needs root and
  changes the host. The setup stops with an error when Docker is absent or when
  the daemon does not answer.
- A Protocol-27 localnet (`stellar/quickstart:nightly` with
  `--protocol-version 27`) that is reachable at the RPC. As an alternative, run
  the gate with `START_LOCALNET=1` and the gate starts one.

The permanent always-on self-hosted runner is live on the toolchain box. It runs
as a systemd service with the labels `self-hosted, zkpor`. A push to a watched
path triggers the workflow automatically, and the runner runs the gate end to end
on a Protocol 27 localnet. The gate and the workflow need no credentials.

# Registry gate

`registry-gate.sh` is the end-to-end attestation gate for the registry
contract. The unit tests of `contracts/registry` run against a stub verifier
and a stub token, so they cannot show that a real proof passes a real
verifier through the registry, or that a real balance read behaves as the
specification says. This gate shows both on a Protocol-27 localnet.

## What it exercises

- `contracts/registry`: registration of a classic asset under its issuer,
  a real attestation through `scripts/attest.sh`, and the stored record.
- `contracts/verifier`: the production verifier, deployed with the committed
  key, behind a real cross-contract call from the registry.
- The reserve balance read, against a funded reserve address.

The reserve address is a custom account contract that accepts every
signature. That is a localnet convenience: the pinned command line collects
a signer only for a top-level Address argument, and a reserve sits inside a
`Vec<Address>`. A pass of this gate is not evidence for the real consent
path, in which an ordinary account signs its authorization entry. The gate
header states the same limit.

## Verdict

- `honest`: a proof produced for the context that the registry holds is
  accepted on chain, and the registry records the attestation.
- `foreigncontext`: the same proof under another snapshot ledger is
  refused with `ProofRejected`.
- `unregistered`: an attestation for an asset with no registry entry is
  refused with `AssetNotRegistered`.
- `observation`: the read-only reading answers the minted amount.

A green run means the registry accepts the honest case, refuses both
attack cases with the named errors, and serves the record and the
observation.

## Running locally

```sh
bash tools/gate/registry-gate.sh
```

The gate needs the same pinned toolchain and localnet as the soundness
gate, and it accepts the same `SOROBAN_RPC` and `START_LOCALNET`
variables.

## No CI job

No continuous integration job runs this gate. The soundness-gate workflow
does not include it, and no other workflow names it. Until a workflow
covers it, a green run exists only when someone runs the gate by hand.
