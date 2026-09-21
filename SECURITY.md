# Security

zkPoR proves that the reserves of an issuer cover its customer liabilities. It
does not reveal the individual balances. It uses a recursive UltraHonk proof. A
Soroban contract verifies the proof on-chain with the CAP-0080 BN254 host
functions. This document states the security model, the trust assumptions, and the known limits.
No independent party audited the verifier.
See Audit status and scope.

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
the folded inner proofs to the pinned inner verification key.

## What is and is not guaranteed

The guarantee holds if the verifier and its assumptions hold. A terminal proof
verifies on-chain only under two conditions:

- the aggregator circuit is satisfied (sumcheck and Shplemini);
- the completed pairing on the accumulator holds.

Together these two conditions bind the batch proofs to the pinned inner VK. The
committed total is therefore the sum of range-checked u64 balances under that VK.

The system does not guarantee the following:

- Completeness, that the tree contains all real customers and no other leaf.
  An earlier inclusion permits a dispute against a later stored attestation.
  Nonresponse records a protocol outcome. It is not a cryptographic proof of absence.
  This path does not cover a customer who never appeared in an attestation.
- That the balances belong to the ledger the attestation names. The context hash
  covers the authority, the asset, the reserve set and the snapshot ledger. It
  does not cover the customer balances, which reach the chain as the root and
  the total. So the snapshot ledger is a label on a balance set, and no part of
  this system checks that the set belongs to that ledger. An issuer who labels
  an old balance set with a fresh ledger passes every check the registry makes.
  The same social mitigation applies as for completeness: a customer whose
  balance changed sees the old figure when they check their own leaf.
- That the leaf a customer checks belongs to that customer. An inclusion package
  proves that one leaf sits under the attested root. It does not prove whose
  leaf it is. The identifier inside the package is opaque, and the mapping from
  an identifier to a person lives outside this protocol, so nothing on chain
  binds a package to the person who holds it. An issuer who gives one package to
  two customers satisfies both checks with one leaf, and the total under the
  root counts that liability once. The protocol forbids a repeated identifier
  inside one liability set, which stops one liability being split across two
  leaves. That rule does not reach the handing out of the files. This limit
  reaches the mitigation that the two limits above rest on. Those state that a
  customer who checks their own leaf makes an omission visible. A customer who
  receives the package of another customer runs the same check, reads a true
  answer, and sees nothing wrong. So the check passes and tells that customer
  nothing about their own balance. A customer who cannot confirm that the
  identifier is theirs trusts the issuer for that step, and trusts it also when
  the check passes. The client states the identifier for that comparison, and it
  cannot tell whose identifier it is. A customer who receives the leaf of
  another customer usually sees a balance that is not their own, and that
  comparison is the one signal available today. It fails when two customers hold
  the same balance, which is common at a large issuer for a small round amount.
  This closes when the identifier commits to something that only the customer
  can produce. A secret that the customer chooses at enrolment is the cheapest
  form. The customer recomputes the identifier and compares it with the one the
  client states, and no key infrastructure is needed. A signing key is the
  strongest form. A derivation from data that the issuer assigns, such as an
  account number, does not close it, because the issuer can give two customers
  one input and a single leaf then answers to both. Such an input must also
  carry enough entropy, because the package states the identifier in clear, and
  a guessable input would let whoever holds a package name the customer. This
  project does none of these.
- The real existence of the off-chain reserves. This is out of scope. It needs an
  auditor attestation or an oracle attestation. The system commits the
  liabilities and leaves an attestation interface.

The two sides of the comparison are not bound in the same way, and the
difference is worth stating. The registry reads the reserves on chain inside the
attestation transaction, so the reserve figure belongs to a ledger. The issuer
asserts the liabilities for a ledger, and nothing binds them to it.

## Dispute privacy and retention

The circuit first hashes a domain tag, balance, and salt into a balance commitment.
It then hashes a different domain tag, customer identifier, and commitment into the leaf.
Public dispute evidence contains the identifier, commitment, position, and path.
It contains no balance or salt.
A customer package still contains its recipient's balance and salt and must remain private.

Each attestation has an asset-specific identifier and a persistent record.
Package checks select that record, so a later attestation does not change the expected root.
Persistent records still require storage lifetime management and restoration when the network requires it.
The event window is not the history boundary.

The target window is 518,400 ledgers. The answer window is 51,840 ledgers.
The issuer retains redacted manifests through those windows and any open dispute deadline.
The next attestation also requires the latest manifest and every previous customer identifier.
Closed accounts remain as zero-balance rows.
An issuer who loses a manifest can lose its ability to answer or produce the next attestation.

A valid answer transfers the 10 XLM deposit to the issuer.
An unanswered dispute returns that deposit to the disputer and permanently locks the available optional bond.
The bond has no withdrawal path, even before a dispute.
The protocol pays no bounty and does not reduce the native asset supply.
Service failure can cause the same nonresponse outcome as an omitted customer.

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
- Protocol. A change to the host functions or the proof format requires a new soundness check.

## Audit status and scope

No independent party audited this system. This project invites an independent
review of the verifier crate, with priority on:

- the completed-pairing patch (`complete_pairing_point_accumulator`,
  `src/verifier.rs`), which is the newest and least-reviewed code;
- `src/ec.rs::pairing_check` and its two fixed G2 constants, which are
  load-bearing for the main KZG pairing and for the completed pairing;
- the binding of the folded inner proofs to the pinned inner VK.

A reviewer must check the implementation against the pinned Barretenberg version.
The review must include the recursive accumulator and the completed pairing.
A reviewer must also confirm both G2 constants against the proving setup and the pairing convention.

The verifier completes the deferred pairing in a separate `pairing_check` call.
A future batched form requires the same soundness gate and independent review.

## Reporting a vulnerability

Report a suspected security issue privately to yakup@node101.io. Do not open a
public issue for a suspected vulnerability before the project fixes it.
