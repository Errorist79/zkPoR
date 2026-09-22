# zkPoR

ZK Proof of Reserves on Stellar (Soroban). An issuer proves the sum of its committed customer balances without revealing individual balances.
A Soroban registry records that total and reads the reserves for comparison.
It verifies the UltraHonk proof on-chain with the CAP-0080 BN254 host functions.
Acceptance does not imply reserve coverage; the dashboard compares the two recorded amounts.

See [the protocol specification](docs/protocol.md) for the authoritative definitions.
See [the architecture](docs/architecture.md) for the design.
See [the security model](SECURITY.md) for the trust assumptions and limits.

## Capabilities

The registry stores each accepted attestation under a fixed identifier.
Version 2 and 3 customer packages bind that identifier, the context hash, and a tagged balance commitment.
A customer checks the package against the fixed attestation root.

Version 3 also states the email and code identifier rule.
A customer can check their identifier from a private identity file before the inclusion check.
Version 2 remains available for historical inclusion checks.
See [the SDK procedures](sdk/README.md#customer-identifiers) for private draft files and customer checks.

Any transaction caller can record a reserve observation.
The registry preserves the first observation below its referenced attested reserve sum.
The dashboard separates these stored observations from live simulations.
A lower reserve sum does not establish insolvency.

An inclusion dispute uses redacted evidence without a customer balance or salt.
An email proof can open the same dispute without earlier inclusion.
The issuer must authorize the DKIM key, domain, and exact signed From field for the asset.
The proof exposes the identifier but keeps the signed header, recipient, code, and balance private.
The target window is 518,400 ledgers.
The answer window is 51,840 ledgers.
Each dispute requires a 10 XLM deposit.
An issuer can supply an optional, nonwithdrawable bond.

An unanswered dispute refunds the deposit and permanently locks the available bond.
A valid answer proves the same identifier under the fixed target root and pays the deposit to the issuer.
Anyone can resolve an unanswered dispute after its deadline.
It pays no bounty.
Nonresponse is a protocol outcome, not a cryptographic proof of omission.

The issuer retains redacted manifests for disputes and customer continuity.
A closed customer account remains in the next attestation with a zero balance.
The [local dispute page and answer command](dashboard/README.md#disputes-and-issuer-answers) use those manifests to answer a fixed target.

The protocol does not establish every real liability:

- A customer who was never included and never received a qualifying signed identifier email cannot use either dispute path.
- An included balance can be wrong. The customer must compare their private package with their account records.
- A customer can collude with the issuer and accept an understated balance or decline to challenge an omission.
- Reserve observations are samples. A decrease between observations can remain undetected.

History uses persistent records, with storage lifetime and restoration requirements.
Event retention does not limit that history.

## Run the dispute demonstration

Build the SDK and deploy the current verifier and registry before this command.
Use a new absolute output directory outside the repository.

```bash
npm run build --workspace sdk
ZKPOR_NETWORK=testnet \
ZKPOR_REGISTRY="<registry-id>" \
ZKPOR_VERIFIER="<verifier-id>" \
ZKPOR_DEMO_WORK=/absolute/path/to/new-demo-directory \
  bash scripts/dispute_demo.sh
```

The demonstration uses synthetic token balances for reserves and liabilities.
The deposits and optional bond use native testnet XLM.
It answers one dispute and opens another against a tree that omits a previously included customer.
The second dispute remains open until its real deadline.
The command prints the later resolution command for `scripts/dispute_example.sh`.

The `private` directory contains the master secret and customer packages.
Keep that directory outside version control.

## How it works

A liabilities proof must cover every customer. The on-chain verification is the
binding cost. This cost is fixed for each proof, and the network limits the
instructions for each transaction. The system therefore proves the customers in
batches. It then folds the batch proofs into one terminal proof with recursive
aggregation. One on-chain verification then covers the full set.

Each batch creates a tagged commitment from each balance and salt.
It hashes each identifier and commitment into a tagged leaf, then builds the subroot.
Each batch also adds
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
contracts/context/    one definition of the leaf, the node, the salt, the context hash
contracts/registry/   asset registry, attestation record, reserve readings
contracts/verifier/   host-accelerated UltraHonk verifier contract
contracts/vendor/     vendored verifier crate, completed-pairing patch (see VENDOR.md)
circuits/recursion/   inner batch circuit, hardened aggregator, shared lib
circuits/simple_circuit/ reference circuit for a known-good verify check
tools/recursion-gen/  off-circuit fold and witness generator
tools/package/        the inclusion package format, the tree, the deployment records
tools/inclusion-verify/ the customer check of one inclusion package
sdk/                  the client library, the reserve consent flow, the customer check
tools/gate/           end-to-end soundness gate and adversarial harness
scripts/              toolchain setup, localnet, deploy, register, attest, verify
fixtures/             test vectors and test-only inputs, never production data
docs/protocol.md      the specification, which is authoritative
docs/architecture.md  system design
```

## Pinned versions

[`scripts/versions.env`](scripts/versions.env) and
[`rust-toolchain.toml`](rust-toolchain.toml) are the files that
`scripts/setup.sh` and the agreement job read when they install a toolchain.
They are not the only place these numbers live. The Cargo manifests, the Nargo
manifests, and the table below each carry a copy.

The agreement job compares them with `scripts/versions.env`. Three are compared
directly: the Rust compiler, `nargo`, and the JavaScript client library against
`sdk/package.json`. The dependencies of the Rust and Noir manifests are compared
by `scripts/check_pins.py`, which reads the git index rather than the directory,
so a scratch manifest that somebody left in the tree is not read as a rule.

That check carries a list of which manifests may name which dependency. A
manifest that names one it does not list fails, so a crate cannot start
depending on the Soroban library without somebody reading the pinned version.
Absence is not a failure, because most manifests legitimately name most of these
nowhere.

`bb` is compared by neither job and does not need to be. Every proving run
compares the installed `bb` with the pin before it proves, and refuses to prove
on a drift, so the tool is checked wherever it is actually used.

| Component | Version | Notes |
|---|---|---|
| Nargo (Noir), core circuits | `1.0.0-beta.9` | proof and VK generation |
| Nargo (Noir), email circuit | `1.0.0-beta.5` | separate compiler, paired with `bb 0.87.0` |
| Barretenberg (`bb`) | `0.87.0` | `--scheme ultra_honk --oracle_hash keccak` |
| `bb_proof_verification` | `v0.87.0` | in-circuit recursive verify; 456-field proof, 112-field vk |
| noir-lang/poseidon | `v0.2.0` | in-circuit Poseidon2 |
| soroban-poseidon | `26.0.0` | host-side Poseidon2 in the witness generator |
| Rust | `1.96.0` | target `wasm32v1-none` |
| soroban-sdk | `26.0.1` | workspace dependency |
| Stellar CLI | `27.0.0` | command-line client |
| Quickstart image | `nightly` | localnet protocol selected with `--protocol-version 27` |
| Verifier crate | vendored in `contracts/vendor/ultrahonk-soroban-verifier` | completed-pairing patch; provenance in VENDOR.md |

The email circuit uses its separate compiler through `ZKPOR_EMAIL_NARGO`.
Its prover uses `bb 0.87.0`, `ultra_honk`, and `keccak`.
See the [email circuit instructions](circuits/email/README.md).

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
#    it, and checks the verdict of the deployed contract for five cases:
#    one honest ACCEPT, four attack REJECTs)
bash tools/gate/soundness-gate.sh

# 3. Run the registry attestation gate (registers an asset, proves, attests,
#    and checks the verdict of the deployed contract for each of the four cases)
bash tools/gate/registry-gate.sh
```

A green soundness-gate run prints `SOUNDNESS-GATE PASS`. That gate also runs in
CI on a self-hosted runner. The registry gate runs on demand, and no CI job
covers it. See [`tools/gate/README.md`](tools/gate/README.md).

## Deploy, and show what was deployed

Two contracts go on a network, in this order. The registry constructor asks the
verifier for its verification key and refuses unless that key hashes to the
value the registry build expects, so the verifier goes first.

```bash
export ZKPOR_NETWORK=testnet

# 1. The verifier, with the release key that the manifest records.
bash scripts/deploy.sh

# 2. The email verifier, with its separate committed key.
bash scripts/deploy_email_verifier.sh

# 3. The registry, against both verifiers.
bash scripts/deploy_registry.sh

# 4. Later, compare the registry and core verifier with this tree.
bash scripts/check_deployment.sh
```

Each deploy reads back the wasm that the network runs and compares it with the
wasm it just built, so the command states the result rather than assuming it. It
writes the contract id and that hash side by side, and it prints the record to
add to [`scripts/deployments.json`](scripts/deployments.json).

Step 4 needs no argument beyond the network. It reads the current generation
from the deployments file, rebuilds both contracts, and reads back what the
network runs. A mismatch there says that nobody can rebuild what the network
runs. It does not say that what the network runs is wrong.

Each entry in the deployments file states both contract identifiers and their WASM hashes.
The current registry ABI returns an attestation identifier from `submit_attestation`.
It exposes `get_attestation` and `attestation_count`.
Version 2 and 3 customer packages bind the context hash and fixed attestation identifier.

## Continuous integration

Two jobs run, and they prove different things.

The `agreement` job runs on a hosted runner. It checks that the three
implementations agree with each other and with the committed artifacts. It runs
the format check, the lint, and the tests of every Rust crate, the Noir tests at
the pinned compiler, and the tests of the client library, which mirror the
committed vectors. It installs the versions that `scripts/versions.env` pins and
fails on a drift. It proves no soundness.

Most Rust crates of this repository stand outside the root Cargo workspace, so
`cargo test --workspace` does not reach them. The job therefore runs each crate
by name, and `scripts/ci_targets.sh check` compares those names against every
crate that git tracks. A new crate that nobody adds to the list fails that check
instead of going unrun. Run it at any time:

```bash
bash scripts/ci_targets.sh check
```

That check reads the git index, because the index is what tells a committed
crate from a scratch directory that somebody left in the tree. It therefore
needs a clone, and it stops with a message of its own against an exported copy
of the sources.

The job also refuses a type assertion and the `any` type in every TypeScript
source. A type assertion tells the compiler what a value is, and a check
establishes it. Where the two differ, the assertion is a claim that the compiler
stops questioning, and the claim surfaces later in the data of a caller. The
scan walks the syntax tree that the TypeScript compiler builds, so a comment
that holds the word `any` never fails it, and `as const` stays allowed:

```bash
npm run check:typescript
```

A test result is evidence about the build that the run read, and about no other
build. Cargo and npm decide for themselves whether their output is current. The
bundler does not: it builds when a caller asks it, and never on its own. So a
build directory that moves between machines, or that survives a copy of the
sources, can make a run answer from code that the tree no longer holds. That
result looks exactly like a verdict.

The remedy is to remove the built directories and to let the caller build again.
A missing file stops a run, and an old answer does not. The test script of the
dashboard builds the client library before it runs, because the dashboard tests
import that library and nothing else in the dashboard package builds it.

The `soundness-gate` job runs on a self-hosted runner, because it needs the
BN254 host functions, the real proving toolchain, and a Protocol 27 local
network. The hosted job cannot replace it.

## Attribution

The verifier crate is `NethermindEth/rs-soroban-ultrahonk` (MIT, Copyright 2025
yugocabrio & indextree). yugocabrio wrote it as a host-accelerated port of the
indextree pure-Wasm UltraHonk verifier. Nethermind maintains it. This project
vendors the crate in `contracts/vendor/ultrahonk-soroban-verifier` with the
completed-pairing patch. The `VENDOR.md` file of that directory records what
this project changed and what it left alone. The `VERIFIER_PROVENANCE.md` file
beside it is an upstream document that is kept unchanged, and `VENDOR.md`
states its limits. The source rev is in `scripts/versions.env`.
