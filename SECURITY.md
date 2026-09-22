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
- Identity and mailbox control. An inclusion check alone proves that a leaf belongs to an attested root.
  It does not establish who owns that leaf.
  Version 2 packages carry an opaque identifier and require an external customer mapping.
  Version 3 states the `zkpor-email-code/1` identifier rule.
  With a private identity file, the verifier also checks the identifier against the customer's email and persistent code.
  A successful combined check requires both identifier agreement and inclusion.

  The customer must use their own email and retained code.
  Accepting an unfamiliar identity file together with a package does not establish that the package belongs to that customer.
  Matching an email and code does not prove mailbox control, email delivery, or a person's identity.
  The draft helper creates no email signature and sends no email.
  The balance and the completeness of the liability set remain separate claims.
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

The email and persistent code stay outside the customer package and public dispute evidence.
The private identity draft contains both inputs and a body that repeats the code.
Retain that file privately for future package checks.
Changing the code changes the identifier and breaks continuity with the previous identifier.
A leaked code can expose the link between an email address and its public identifier.
The code does not derive package salts and is not the issuer's master secret.

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

## Recorded reserve limits

A recorded observation compares current reserves with the referenced attestation's reserve sum, not with its liabilities.
The first-low marker remains after reserves recover, another attestation succeeds, or the reserve set changes.
That marker is a historical decrease, not a current insolvency verdict.
An observation without a baseline makes no comparison.
The absence of a low marker does not establish continuous coverage between observations.

The dashboard's live simulation stores no observation.
Stored status reads remain subject to storage lifetime and restoration requirements.
A failed read must not appear as an empty history or a clean status.

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
