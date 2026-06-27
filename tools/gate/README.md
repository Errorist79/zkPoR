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
- `tools/recursion-gen`: the off-circuit fold and witness generator (K=2 for
  speed).
- `contracts/verifier`: the host-accelerated UltraHonk verifier. It vendors
  `contracts/vendor/ultrahonk-soroban-verifier`, which completes the deferred
  pairing-point accumulator on-chain.
- `tools/gate/attacks/inner_evil` plus `tools/gate/cheats.py`: the adversarial
  scaffolding. This gate is the only user of that scaffolding. It is never part
  of the production path.

## Verdict

- `honest`: on-chain ACCEPT.
- `forged` (a foreign inner proof under the pinned VK array): on-chain REJECT.
- `deflated` (a foreign inner proof without the range check, balance -100):
  on-chain REJECT.

A green run means that the deployed verifier accepts the honest cases and rejects
both attacks.

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
`PATH`:

- Rust 1.96.0 (`cargo`, `rustc`) plus the targets `wasm32v1-none` and
  `wasm32-unknown-unknown`.
- nargo 1.0.0-beta.9 (`~/.nargo/bin`).
- Barretenberg `bb` 0.87.0 (`~/.bb/bin`). On a host with GLIBC < 2.38 this is a
  thin wrapper that runs the real `bb` inside an `ubuntu:24.04` container.
- Stellar CLI 27.0.0 (`~/.local/bin`).
- Docker, for the localnet and, where applicable, for the `bb` wrapper.
- A Protocol-27 localnet (`stellar/quickstart:nightly` with
  `--protocol-version 27`) that is reachable at the RPC. As an alternative, run
  the gate with `START_LOCALNET=1` and the gate starts one.

The permanent always-on self-hosted runner is live on the toolchain box. It runs
as a systemd service with the labels `self-hosted, zkpor`. A push to a watched
path triggers the workflow automatically, and the runner runs the gate end to end
on a Protocol 27 localnet. The gate and the workflow need no credentials.
