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
  the real Protocol 27 testnet with a byte-identical verifier. A future protocol
  change to the host functions or to the proof format needs a new validation.

## On-chain validation

The project validated the sound recursive path end to end on the real Stellar
testnet (Protocol 27). The validation ran under the real limit of 400,000,000
instructions for each transaction, on the verifier contract
`CCADPDEROE6OXGODBMAC7SU3Q3VOUZQAKYAQL67YNBMSTROJSSK7ATZ7`. Two attacks pass
`nargo execute` and all the in-circuit checks: a forged inner proof under the
pinned VK, and a no-range inner proof with a balance of -100. Only the completed
pairing rejects them. The same contract accepts the honest proofs. All four cases
are real confirmed transactions:

| Case | Tx hash | Ledger | Result |
|---|---|---|---|
| honest | `50fab606cb87205a44045049ce12727aaf1d4c9ee1865f908a5ee4e8e75c8238` | 3312849 | SUCCESS |
| forged | `1a59d5ca1c94969e5d3b9887643e0d8db5bf69a9793eab8a1a7a8fba2090c374` | 3312942 | FAILED, Error(Contract, #4) |
| deflated | `5d06ca66a324db4b4d8f362f5133ec25ae166175798e59464df06c76efddbb01` | 3312958 | FAILED, Error(Contract, #4) |
| honest (post-attacks) | `b88c7c2b5fb8fa0a20d7b436c3b4657f8109279ab1a75f7d398bc9ddfd93c1a7` | 3313107 | SUCCESS |

The honest verify used 106,670,237 instructions, about 26.7 percent of the cap.
The two honest accepts bracket the two rejects in ledger order on the same
contract. This order shows a real gate, and not a deployment that rejects
everything. The on-chain XDR carries the structured form
`{error: {contract: 4}}`.

`tools/gate/soundness-gate.sh` reproduces this result. The gate builds the
production artifacts, deploys them to a Protocol 27 localnet, and gates on the
on-chain verdict: honest ACCEPT, forged REJECT, deflated REJECT. It fails loud on
any other outcome, so an infrastructure failure never reads as a soundness
REJECT. It runs in CI (`.github/workflows/soundness-gate.yml`) on a self-hosted
runner. The gate is a regression guard and a demonstration. It is not a proof and
it is not an audit.

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
