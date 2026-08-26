# Security

zkPoR proves that the reserves of an issuer cover its customer liabilities. It
does not reveal the individual balances. It uses a recursive UltraHonk proof. A
Soroban contract verifies the proof on-chain with the CAP-0080 BN254 host
functions. This document states the security model, the trust assumptions, the
on-chain validation evidence, and the known limits. No independent party audited
the verifier. See Audit status and scope.

## Security model

The trust-critical component is the host-accelerated UltraHonk verifier. The
verifier is mostly the vendored crate
`contracts/vendor/ultrahonk-soroban-verifier`. The load-bearing element is the
completed pairing-point accumulator in `src/verifier.rs`
(`complete_pairing_point_accumulator`). It completes the deferred recursive KZG
pairing on-chain. A verifier bug that accepts an invalid proof is a direct
soundness failure. The reserves would then look backed when they are not.

The in-circuit recursive verify in the aggregator does not run its final KZG
pairing inside the circuit. It defers that pairing into a 16-limb pairing-point
accumulator. The terminal proof carries this accumulator in its public inputs. A
verifier that checks sumcheck and Shplemini, but never completes that pairing,
accepts a terminal proof that folded a foreign inner circuit. One example of such
an inner circuit is a circuit without the u64 range check, which deflates a
subtotal. The patch completes that pairing on-chain. The completed pairing binds
the folded inner proofs to the pinned inner verification key. The on-chain
validation below is the evidence that this rejection happens.

## What is and is not guaranteed

The guarantee holds if the verifier and its assumptions hold. A terminal proof
verifies on-chain only under two conditions:

- the aggregator circuit is satisfied (sumcheck and Shplemini);
- the completed pairing on the accumulator holds.

Together these two conditions bind the batch proofs to the pinned inner VK. The
committed total is therefore the sum of range-checked u64 balances under that VK.

The system does not guarantee the following:

- Completeness, that the tree contains all the real customers of the issuer and
  no other leaf. The verifier cannot close this gap. A social mitigation applies:
  each customer checks the inclusion of their own leaf against the published
  root, so an omission becomes visible if enough customers check.
- The real existence of the off-chain reserves. This is out of scope. It needs an
  auditor attestation or an oracle attestation. The system commits the
  liabilities and leaves an attestation interface.

## Trust assumptions

- Verifier correctness. The verifier implements UltraHonk correctly for the
  proofs that the pipeline produces. This is the object of the pending audit.
- Deployment coupling (operational). Soundness assumes that the deployed verifier
  is the patched build. Nothing in the artifacts mechanically binds the
  aggregator VK to a verifier that contains
  `complete_pairing_point_accumulator`. A deployment of that VK against an
  unpatched verifier skips the deferred pairing and silently accepts forged
  proofs. The soundness gate enforces this operationally, because it builds the
  patched verifier from source.
- Universal-setup trust. UltraHonk uses the universal KZG SRS, so there is no
  ceremony for each circuit. The trust anchor is the pair of fixed G2 constants in
  `src/ec.rs`: `RHS_G2_BYTES` (the `[1]_2` generator) and `LHS_G2_BYTES` (the SRS
  `[x]_2` point). The main Shplonk/KZG pairing and the completed pairing both use
  them. A wrong constant breaks soundness silently. The standard KZG assumption
  applies: one contributor of N to the universal ceremony must be honest.
- Pinned toolchain. nargo 1.0.0-beta.9, bb 0.87.0, `oracle_hash keccak`. The
  proof format and the VK format depend on these versions. Any change reopens the
  formats and needs a new validation through the gate.
- Host pairing and MSM. The BN254 pairing and the MSM are the CAP-0080 Soroban
  host functions. Their correctness is the responsibility of the protocol, not of
  this project.
- Protocol. CAP-0080 shipped in Protocol 26. The project validated the path on
  the real Protocol 27 testnet with a byte-identical verifier. That validation
  used the superseded artifact of the section On-chain validation. A future
  protocol change to the host functions or to the proof format needs a new
  validation.

## On-chain validation

### Superseded artifact, testnet evidence

The transactions below verified an earlier artifact, and a later artifact
supersedes it. The earlier circuits used two-input leaves, no context
binding, and three public inputs. The current artifact uses different
circuits, different keys, and a four-element public input vector, so these
transactions are not evidence for it. The repository did not record the
commit or the key hashes of the earlier artifact. The deployed contract
stores its verification key without an upgrade path, so the contract address
identifies that artifact, and its `vk_bytes` function returns its key.

The validation ran end to end on the real Stellar testnet (Protocol 27),
under the real limit of 400,000,000 instructions for each transaction, on
the verifier contract
`CCADPDEROE6OXGODBMAC7SU3Q3VOUZQAKYAQL67YNBMSTROJSSK7ATZ7`. Two attacks pass
`nargo execute` and all the in-circuit checks: a forged inner proof under the
pinned VK of that artifact, and a no-range inner proof with a balance of
-100. Only the completed pairing rejects them. The same contract accepts the
honest proofs. All four cases are real confirmed transactions:

| Case | Tx hash | Ledger | Result |
|---|---|---|---|
| honest | `50fab606cb87205a44045049ce12727aaf1d4c9ee1865f908a5ee4e8e75c8238` | 3312849 | SUCCESS |
| forged | `1a59d5ca1c94969e5d3b9887643e0d8db5bf69a9793eab8a1a7a8fba2090c374` | 3312942 | FAILED, Error(Contract, #4) |
| deflated | `5d06ca66a324db4b4d8f362f5133ec25ae166175798e59464df06c76efddbb01` | 3312958 | FAILED, Error(Contract, #4) |
| honest (post-attacks) | `b88c7c2b5fb8fa0a20d7b436c3b4657f8109279ab1a75f7d398bc9ddfd93c1a7` | 3313107 | SUCCESS |

This document quoted an instruction figure for that verify. The figure is
gone, because a reader can no longer check it. Horizon serves no Soroban
transaction meta, and the retention window of the remote procedure call has
passed, so no public source returns the number today. The four transactions
stay, because they still resolve.

The two honest accepts bracket the two rejects in ledger order on the same
contract. This order shows a real gate, and not a deployment that rejects
everything. The on-chain XDR carries the structured form
`{error: {contract: 4}}`.

### Current artifact, testnet evidence

The current artifact adds the context binding and the salted three-input
leaves, at the release configuration of 1024 leaves for each batch and 4
batches. `circuits/recursion/manifest.json` records its identity: the batch
values, the inner key hash, the SHA-256 of the committed aggregator key
`circuits/recursion/agg/vk`, the public input count and positions, and the
toolchain versions.

The flow ran end to end on the real Stellar testnet (Protocol 27) on
August 8, 2026, under the real limit of 400,000,000 instructions for each
transaction. `scripts/deployments.json` records two deployment generations of
this network, in order. The first generation is the verifier
`CDUEQOM2AQ54ZZ3EZA2Q4D32C7DBVQ5D45TFMBSC2RCE6ZMX32T44JC2` with the registry
`CC4MA6FWDBG3Y4YXYGDHYEZ36O3YSP7DREGOLBWKP6ZTQQ6IYFFX3KQK`. Its registry
enforces a reserve bound of 16, because it was built before the bound became
32. The second generation is the verifier
`CDICJW5B5VYT3GD3VTDWFYCQG6N4ONLUXKHPQSJVAN5QYPGCTOG7PIXE` with the registry
`CCHUTDKUPWXVUIX6D26SE5NZ5STP74VV4DY2CNVCMNJYOU5PTROLA7MY`, built from the
current sources. Each registry holds the aggregator key hash of the manifest,
because its constructor refuses a verifier that stores another key. The steps
are real confirmed transactions:

| Step | Tx hash | Ledger | Result |
|---|---|---|---|
| verifier deploy | `916782a14691515f0339a0be9e9283397c5701c0b17c18c2aed1934c875db386` | 4040247 | SUCCESS |
| registry deploy | `b56572375953ac859e6916b5eb15df5f095d5f873a9f07dd9aba51947e62e326` | 4040255 | SUCCESS |
| register asset | `a65e25c62ef12bac1ca19927df41f0d41e076b543799c82febc2aae1171a5a46` | 4040282 | SUCCESS |
| attestation 1 | `63f909b07a5661d28b7e2df82dd6f36a0e55e11530add1dcc22b41e81baaf18f` | 4040298 | SUCCESS |
| attestation 2 | `314553796a6d084ce01971fe8608f488375b977bc3f97f95d274d9aa425111ec` | 4040321 | SUCCESS |
| register asset through `scripts/register_asset.sh` | `418ed637a5a61420c2477b6d286865cf9608db369a1c457c5d9f93d00bb05f90` | 4042603 | SUCCESS |
| attestation 3, with the packages of the customers | `269d2d4289f504cdfb7f0aa734e767197cc1e9ee26a0f22143cadc8b5b47cafa` | 4042618 | SUCCESS |
| generation 2 verifier deploy | `8580ddd61a45722457ad342975142c8060bd1e08473c16b2fd9b6d09b9654c6f` | 4042930 | SUCCESS |
| generation 2 register asset, 17 reserve addresses | `8698229db26f72964982f5aae84feb512fa3c8a2f55d2ef34d65eba031b4b12a` | 4042992 | SUCCESS |
| generation 2 attestation, 17 reserve reads | `1bd3280f6f91ef1dc768cfec42911db93c96d8fe229c95866ad61b0f297a7acf` | 4043038 | SUCCESS |

The registration names an ordinary account as the reserve address. That
account signed its own authorization entry with the JavaScript software
development kit (`tools/reserve-consent/`), and the issuer signed the
transaction. The consent is a signed entry, and not a source-account
credential. The first registration ran by hand, and `scripts/register_asset.sh`
ran the second one. Both declared 6,745,316 instructions, so the script
reproduces the steps of the hand-driven run.

Attestation 3 followed the third registration. It declared 122,229,204
instructions and consumed 117,486,336, and it wrote the package of every
customer before the flow removed the salts.

The attestation transaction carries the whole cost: the cross-contract call
to the verifier, the reserve balance read, and the hashes that the registry
computes. Two numbers describe that cost, and they mean different things.

The declared instruction resource bounds the headroom. It stands in the
applied transaction, the network enforces the cap against it, and the fee
pays for it. Attestation 2 declared 122,268,806 instructions, about 30.6
percent of the cap.

The consumption measures the work. Attestation 2 consumed 117,524,415
instructions, and attestation 1 consumed 117,493,660. Each number is the
`cpu_insn` core metric that the node reports in the diagnostic events of the
applied transaction, read over the remote procedure call. It is the metered
consumption of the real execution, and not a simulation. The transaction
meta carries no instruction field, so a reader who wants this number reads
the diagnostic events.

The bound of 32 reserve addresses is measured, and not assumed. The second
generation registered one asset with 17 reserve accounts, and each account
signed its own authorization entry. The first generation refuses the same
registration with the contract error `TooManyReserveAddresses`, because it
enforces the earlier bound of 16.

The attestation of that entry read 17 balances. It declared 123,901,586
instructions, about 31.0 percent of the cap, and consumed 118,759,615. The
comparison with the attestation of one reserve address gives the cost of one
added balance read: 0.10M declared instructions for a classic asset. A set of
32 classic addresses therefore declares about 125M instructions, which stays
under the cap.

A package of the first generation stays verifiable after the second
generation exists. The package names its own registry, and
`tools/inclusion-verify` reads that generation from the deployments file. A
package of the first generation and a package of the second generation both
answer INCLUDED against the file that lists both.

The customer path ran on the same data: `tools/recursion-gen` wrote one
inclusion package for each customer of attestation 2, and
`tools/inclusion-verify` read the registry over the network and answered
INCLUDED for one of them. The tool read the registry address from
`scripts/deployments.json`, and not from the package.

`tools/gate/soundness-gate.sh` validates the current artifact. The gate
builds the production artifacts from the committed sources, deploys them to
a Protocol 27 localnet, and gates on the on-chain verdict. It passed at the
release configuration with five verdicts: an honest proof accepted; a
forged proof, a deflated proof, an unsalted-leaf proof, and a foreign
context rejected. It fails loud on any other outcome, so an infrastructure
failure never reads as a soundness REJECT. It runs in CI
(`.github/workflows/soundness-gate.yml`) on a self-hosted runner, and CI
fails when a rebuild changes the manifest, the committed key, or a
generated parameter file. A localnet result is not testnet evidence. The
gate is a regression guard and a demonstration. It is not a proof and it is
not an audit.

## Audit status and scope

No independent party audited this system. This project invites an independent
review of the verifier crate, with priority on:

- the completed-pairing patch (`complete_pairing_point_accumulator`,
  `src/verifier.rs`), which is the newest and least-reviewed code;
- `src/ec.rs::pairing_check` and its two fixed G2 constants, which are
  load-bearing for the main KZG pairing and for the completed pairing;
- the binding of the folded inner proofs to the pinned inner VK.

A reviewer must weigh two provenance notes:

- The module-by-module correspondence between the Rust code and Barretenberg in
  `contracts/vendor/ultrahonk-soroban-verifier/VERIFIER_PROVENANCE.md` holds
  against Barretenberg tag v0.82.2, while the pipeline pins bb 0.87.0. An
  automated tool produced that correspondence, not a human audit, and it covers
  the non-recursive keccak path only. The completed-pairing patch handles the
  accumulator that is specific to recursion, which is outside that
  correspondence.
- The doc comment on `LHS_G2_BYTES` in `src/ec.rs` is inconsistent with itself. It
  labels the constant as the negated generator `-[1]_2` and also as the SRS
  `[x]_2` point. These two are not the same. A reviewer must confirm from the
  bytes which one it is. A reviewer must also confirm that both G2 constants are
  correct for this proving setup and for this pairing convention.

Soundness is empirical today. The system demonstrably rejects two concrete
attacks. That result is evidence. It is not a formal proof that the verifier
accepts exactly the valid proofs. The verifier completes the deferred pairing in
the naive separate `pairing_check` form. A batched-into-Shplemini form is future
work, and it must pass the same gate and the same review.

## Reporting a vulnerability

Report a suspected security issue privately to yakup@node101.io. Do not open a
public issue for a suspected vulnerability before the project fixes it.
