# @zkpor/sdk

The client library and the `zkpor` command line for the zkPoR registry.

Install the public package with Node.js 22:

```bash
npm install @zkpor/sdk
```

The npm package contains the library, replay endpoint, command line, and license.
The source checkout contains the Rust generator, circuit tools, and synthetic examples.

The package covers seven capabilities.

- Registration with account reserves, and a change of a reserve set. Every
  reserve address must authorize the call. A reserve address sits inside a list
  argument, and the pinned command line collects a signer only for a top-level
  address argument, so this library is the one signer of a reserve consent.
- Per-reserve diagnosis. A reverted attestation carries a contract error code
  and no address, so only a client that reads each reserve balance on its own
  can name the address that failed.
- The proving driver, which runs the pinned native binaries.
- Attestation and reserve observation submission.
- Registry queries, including persistent attestation and observation history, plus legacy event history.
- The customer inclusion check.
- Fixed disputes, issuer answers, resolution, and an operator watchdog.

The package does not hold the cryptographic definitions. The shared Rust crate
`contracts/context` is the definition, and the code here is a mirror that the
tests compare against the committed vectors. The package also writes no
customer file: the generation gate lives in the generator, and a second writer
of per-customer files would double the surface that touches sensitive data.

## Fixed attestation records

Version 2 and 3 customer packages carry a positive decimal `attestation_id` and a balance commitment.
The verifier reads `get_attestation(asset, id)` and checks that fixed root.
A later attestation does not change the record that the package selects.
The verifier also recomputes the commitment from the private balance and salt.
It refuses version 1 packages because their leaf rule differs.

```typescript
const attestation = await readStoredAttestation(network, registry, asset, 1n);
const history = await readStoredAttestationHistory(network, registry, asset, {
  startId: 1n,
  count: 20,
});
```

These functions require a registry that supports persistent history.
The `network` argument is a `NetworkConfig` from the caller's trusted configuration.
The optional `server` field lets a caller reuse its configured RPC client.
The single-record reader returns `undefined` only for a missing asset or attestation.
An unsupported contract API or failed network request remains an error.
The page count must be between one and `HISTORY_PAGE_LIMIT` (200).
Each page fixes `totalCount` before it reads records and returns `nextId` when more records remain.

`readAttestationHistory` remains the event reader for legacy deployments.
Its result states the ledger window that it covers.
Persistent reads do not depend on that window.
Persistent entries remain subject to the network's storage lifetime and restoration rules.

The issuer reads the prior fixed attestation before proving a new one.
It retains that attestation's redacted `generation.json` file.
The witness and package generator check this file for every old identifier.
The successful attestation call returns its fixed identifier.
The issuer then reads that fixed attestation for the package root and context.

```typescript
const prior = await preparePriorGeneration({
  server, network, readOptions: {}, registry, asset, outputDirectory,
});
const proof = await prove({
  repository, contextFile, customersFile, masterSecret,
  network: network.network, registry, prior,
});
```

The package writer needs the accepted `attestationId`, the fixed root, and the fixed context hash.
It passes the same prior manifest to the generator.

## Recorded reserve observations

`observeReserves` simulates a live reserve read.
It creates no stored observation and returns no observation identifier.
Its `supportsRecordedObservations` flag distinguishes the complete current ABI from the legacy response.

The stored APIs require a registry that supports recorded observations:

```typescript
const status = await readObservationStatus(network, registry, asset);
const observation = await readStoredObservation(network, registry, asset, 1n);
const page = await readStoredObservationHistory(network, registry, asset, {
  startId: 1n,
  count: 20,
});
```

Each page fixes the observation count before it reads the requested identifiers.
The page limit is `HISTORY_PAGE_LIMIT` (200).
A missing method, failed restoration, or failed RPC request remains an error.
Only explicit contract not-found errors mean that an asset or observation is absent.

Each observation names its reserve set and optional baseline attestation.
`belowAttested` compares the observed sum with that attestation's reserve sum, not its liabilities.
An absent baseline means that no comparison occurred.
The first-low marker survives later observations, attestations, and reserve changes.
A lower reserve sum does not establish insolvency.

Submit a transaction to record an observation:

```typescript
const result = await submitReserveObservation(server, network, {
  sourceAccount,
  sourceSigner,
  registry,
  asset,
});
```

The caller pays the transaction fee and needs no issuer authorization.
The result contains the settled transaction hash and ledger.
It does not return the simulated observation identifier.
The function refuses a legacy registry that cannot store observations.

## Disputes and the watchdog

The dispute reader selects one target attestation and one customer identifier.
It returns `undefined` only when the registry confirms `DisputeNotFound`.
An RPC failure or an archived entry gives no absence result.

```typescript
const dispute = await readStoredDispute(network, registry, asset, targetId, identifier);
const evidence = parseInclusionEvidence(answerText);
const answer = await answerDispute(server, network, {
  sourceAccount, sourceSigner: authoritySigner,
  registry, asset, targetId, evidence,
});
```

`openDispute` accepts an inclusion opening or an email-proof opening through the same registry entry point.
The inclusion opening names a fixed older attestation and carries only an identifier, commitment, position, and path.
An email opening carries a proof, an identifier, and a registered key identifier.
The email, code, and individual balance stay local.
`answerDispute` checks the fixed target and needs the asset authority's signature.
`resolveDispute` needs no issuer signature and runs only after the contract answer deadline.
The transaction source signs and pays its transaction fee for each write.
The disputer also pays a 10 XLM deposit when `openDispute` succeeds.

The `watchdog` command checks one customer's new fixed attestations in order.
It requires an older version 3 package that passes inclusion and the local identity check.
Copy each newly delivered package into the chosen directory as `<attestation-id>.zkpor.json`.
The command checks the package against that fixed attestation and the same private identity.
It waits for the package delivery grace before it opens a dispute for a missing or invalid package.
It records an expired target and checks the next target in the same run.
The command reports the first expired target with its next result.

The default grace is 51,840 ledgers after the target attestation.
An operator can set a different grace with `--grace-ledgers`.
The value must be positive and shorter than the 518,400-ledger dispute eligibility window.
This setting changes only when the watchdog opens a dispute.
The contract gives the issuer a separate 51,840-ledger answer window after the dispute opens.
One command run sends at most one deposit transaction.

The command writes private state for each target before it sends a deposit transaction.
The state holds the exact transaction hash and expiry.
After a restart, the command reads the fixed dispute and that transaction before it retries.
It retries only after a confirmed failed transaction or an expired transaction with no fixed dispute.
An unavailable RPC result stops the command without another deposit.
Keep the state directory and the private packages through the dispute eligibility window.

```text
zkpor watchdog \
  <old-package.zkpor.json> <private-identity.json> \
  <delivered-packages-dir> <state-dir> [deployments.json] \
  [--grace-ledgers <count>]
```

The key stays in the environment, not in an argument.
The command never sends an email.
It prints no email address, code, balance, or salt.

## Run the customer check

The source checkout examples use `fixtures/synthetic_package_v2.zkpor.json` and a synthetic RPC response.
The fixture describes no real customer, liability, or accepted network attestation.

### Check the synthetic package

Run these commands in the source checkout:

```bash
npm install
npm run example
```

The example runs `zkpor verify-inclusion` against a local synthetic endpoint.
It prints the verdict and exit code.
It needs no key, funds, proving toolchain, or network access.

### Check your package against a network

Install `@zkpor/sdk` before you run this command in your own project.

```bash
ZKPOR_NETWORK=testnet ZKPOR_RPC_URL=https://soroban-testnet.stellar.org \
  npx zkpor verify-inclusion /absolute/path/to/customer.zkpor.json \
  /absolute/path/to/deployments.json
```

Use your own version 2 or 3 package and trusted deployment configuration.
The registry must support persistent history and retain the selected attestation.
A testnet reset can remove its contracts and records.
A later attestation does not change the fixed record that either package version selects.

### Check a package with an incorrect path

Run these commands in the source checkout:

```bash
npm install
npm run build
node examples/check-a-package.mjs ../fixtures/synthetic_package_v2_wrong_path.zkpor.json
```

The second synthetic package has a changed sibling hash.
The example reports a root mismatch, with exit code 7.
The example accepts a package path and uses the valid synthetic package when no path is supplied.

## Call the check from your own program

Run this synthetic example in the source checkout:

```
npm install && npm run example:library
```

The example above runs the command line. This one calls the library, which is
what a team integrating the flow does. It shows the three things a caller has to
get right and nothing else.

- **A verdict is not a boolean.** Each refusal has a distinct reason.
- **A refusal is an answer.** A package that is not under the attested root is
  the check working. The verdict carries the recomputed root and the attested
  one, so a caller shows a customer what happened.
- **A failure is not a verdict.** When the network cannot be read, the call
  raises `InfrastructureError`. A caller that turned that into "not included"
  would tell a customer their balance is missing because a request timed out.

It uses the same synthetic endpoint as the command example.
For a network check, configure a trusted endpoint and use your own accepted package.

The example leaves out proving, attestation, registration, and the signing of a
reserve consent. The issuer runs those commands with the required tools and keys.
The Rust prover tools require the source checkout.

## Customer identifiers

Version 3 packages carry `identifier_rule: "zkpor-email-code/1"`.
The identifier derives from a canonical email address and a persistent random code.
The package carries neither input.
The [protocol specification](https://github.com/Errorist79/zkPoR/blob/sdk-v0.1.0/docs/protocol.md#45-email-and-code-identifiers) defines the exact bytes and hash.

The supported address has an ASCII dot-atom local part and a DNS domain.
The rule preserves the local part's case and lowercases the domain.
It rejects quoted local parts, non-ASCII addresses, domain literals, and surrounding whitespace.
It does not remove dots or `+` suffixes.

The following Rust generator commands require the source checkout and pinned Rust toolchain.
The npm package does not contain that generator.

Prepare one private draft for a customer:

1. Create a private directory outside the repository.
2. Restrict the directory to mode `0700`.
3. Create a mode `0600` JSON file with the customer's `email` field.
4. Run the generator with file paths only.

```bash
umask 077
cargo run --release --manifest-path tools/recursion-gen/Cargo.toml -- \
  prepare-identifier-email /absolute/private/zkpor/email-input.json \
  /absolute/private/zkpor/identifier-draft.json
```

The generator refuses to overwrite an existing output file.
It creates the draft with mode `0600`.
The draft contains the canonical email, code, decimal identifier, subject, and body.
Its format is `zkpor-identifier-email/1` and its identifier rule is `zkpor-email-code/1`.
The subject contains exactly 43 canonical base64url characters, without padding.
The command creates a local draft; it sends no email and creates no email signature.

Keep the code stable for the customer's lifetime in the liability set.
A new code produces a different identifier.
Do not prepare another draft for each snapshot.
Retain the private identity file for later package checks and closed-account continuity.
The tools do not expire or delete that file.
The code is separate from the issuer's master secret and each package salt.

The generator accepts a mixed customer CSV with this header:

```csv
id,balance,identifier_rule,email,code
```

Use `zkpor-email-code/1` for an email-derived row.
Supply its email and persistent code.
Leave `id` empty or supply the matching decimal identifier.
Use `zkpor-legacy-id/1` for a legacy row, with its identifier and empty email and code fields.
The earlier `id,balance` CSV remains supported.
The generator writes version 3 packages for derived identifiers and version 2 packages for legacy identifiers.
Keep these CSV files private because they contain balances and codes.

Check your own identifier and inclusion with your private file:

```bash
npx zkpor verify-inclusion /absolute/private/zkpor/customer.zkpor.json \
  /absolute/path/to/deployments.json \
  --identity-file /absolute/private/zkpor/identifier-draft.json
```

The Rust command accepts the same arguments:

```bash
cargo run --release --manifest-path tools/inclusion-verify/Cargo.toml -- \
  /absolute/private/zkpor/customer.zkpor.json /absolute/path/to/deployments.json \
  --identity-file /absolute/private/zkpor/identifier-draft.json
```

With `--identity-file`, exit zero requires both the local identifier match and the on-chain inclusion check.
Use your own email and code, not an identity file supplied with an unfamiliar package.
The match does not prove mailbox control, email delivery, or the correctness of the balance.
Without the option, both package versions support inclusion checks without an identity claim.
Version 2 with `--identity-file` is refused because it states no email and code rule.

The library exports these functions:

| Function | Result |
|---|---|
| `deriveCustomerIdentifier(email, code)` | The nonzero field identifier |
| `encodeIdentifierSubject(id)` | The canonical 43-character subject |
| `parseIdentifierSubject(subject)` | The identifier from that exact subject |
| `prepareIdentifierEmail(email)` | A local draft object with a new random code |
| `checkOwnPackage(packageText, identityText)` | Only the local identifier comparison |

`checkOwnPackage` returns `own`, `foreign`, or `unsupported-identifier-rule`.
An `own` result does not establish inclusion.
Pass `identityText` to `verifyInclusion` to require both checks.
The draft object includes `identifierRule`, and its body states that rule.

## The Poseidon2 dependency

The protocol names the Poseidon2 instance of `noir-lang/poseidon` v0.2.0, file
`src/poseidon2.nr`, over the BN254 scalar field, with state width 4, rate 3, and
a sponge capacity that starts at the input count times 2^64. This package uses
`@zkpassport/poseidon2`, pinned to one exact version.
The mirror test compares its output with every committed vector.

The library also offers a variable-length mode, which absorbs one extra element
and computes another function. This package calls the fixed-length hash only,
through one wrapper in `src/poseidon.ts`.

## Commands

From a clone of the repository, run `npm install` at the root once. That install
builds this package and puts `zkpor` on the path of the workspace, so every
command below runs as `npx zkpor ...` from the root. An install of the published
package puts the same command on the path of the machine, and it then runs as
`zkpor ...`.

```
zkpor verify-inclusion <package.zkpor.json> [deployments.json] [--identity-file <private.json>]
zkpor watchdog <old-package.zkpor.json> <private-identity.json> <delivered-packages-dir> <state-dir> [deployments.json] [--grace-ledgers <count>]
zkpor entry <asset>
zkpor observe-reserves <asset>
zkpor history <asset> [from-ledger]
zkpor diagnose-reserves <asset>
zkpor prepare-registration <asset> <authority> <reserve>[,<reserve>...] [asset-xdr]
zkpor sign-entry <reserve-address>
zkpor sign-entry-in-transaction <reserve-address> <valid-until-ledger> <passphrase>
zkpor submit-registration <prepared.json> <signed-entry.txt>[,...]
zkpor prove <context.toml> <customers.csv> [repository]
zkpor attest <context.toml> <customers.csv> [repository]
zkpor consent-validity-ledgers
```

`verify-inclusion` maps each outcome to its own exit code, and those codes equal
the codes of the Rust reference of the same checks.

| exit code | outcome |
|-----------|---------|
| 0 | the leaf is under the attested root |
| 2 | the command line is wrong |
| 3 | the package format is not supported |
| 4 | the package is malformed |
| 5 | the package points at a registry this verifier does not trust |
| 6 | the registry holds no attestation that matches the package |
| 7 | the recomputed root does not equal the attested root |
| 8 | no verdict of this check |
| 9 | the deployments file of this verifier contradicts itself |
| 10 | the package identifier differs from the private email and code |
| 11 | the package does not state the supported identifier rule |
| 12 | the private identity file is invalid |

The code 8 covers two answers, and neither is a verdict of this check. One is a
failure of the client or of the network. The other is an answer of a registry
about the request, such as a refusal to say whether it holds an asset. The last
line of the command says which of the two it met.

## Configuration

The client takes its endpoint and its registry addresses from its own
configuration and from its own copy of the deployments file, never from a
package. A package value may select a record inside data that the client already
trusts. It must never select where the trusted data comes from.

No setting names a registry. A network carries more than one registry over
time, and the asset decides which one answers about it: the client asks the
recorded generations, newest first, and stops at the first that holds the
asset. The inclusion check is the one command that resolves another way,
because a package names its own registry and the check reads that one.

A generation that answers neither a record nor `AssetNotRegistered` stops the
command. The client cannot tell a registry that holds nothing from one that
failed, and stepping past the failure would let an older generation answer
while the newer one also held the asset. **This makes the cost positional.** A
read about an asset succeeds only when every generation newer than the one
holding it answers, so an asset on the oldest of several generations depends on
all the newer registries for every read, and for the attestation, which
resolves before it proves. Adding a generation adds one such dependency for
every asset older than it.

| variable | content |
|----------|---------|
| `ZKPOR_NETWORK` | the network name, as the deployments file records it |
| `ZKPOR_RPC_URL` | the address of the endpoint |
| `ZKPOR_NETWORK_PASSPHRASE` | the network passphrase, when the network is not a well-known one |
| `ZKPOR_READ_SOURCE` | the account address that a read simulates as; optional, because a read needs no signature and no funds |
| `ZKPOR_DEPLOYMENTS` | the path of the deployments file |
| `ZKPOR_RESERVE_SECRET` | the secret key of a reserve holder, for one signing step |
| `ZKPOR_AUTHORITY_SECRET` | the secret key of the transaction source |
| `ZKPOR_DISPUTER_SECRET` | the account key that pays a dispute deposit and its transaction fee |
| `ZKPOR_MASTER_SECRET` | the master secret that derives the salts |
| `ZKPOR_MASTER_SECRET_FILE` | the path of a mode 0600 file that holds it |

The master secret never travels in an argument vector, where the process list of
the machine shows it, and it never reaches a log.

## The multi-party registration flow

A real reserve holder does not give a secret key to the authority machine, so
the flow is four separable steps.

1. `prepare-registration` simulates the call and writes one authorization entry
   per reserve address, with the ledger at which every signature expires.
2. Send one entry to its holder.
3. The holder runs `sign-entry` against its own key, on its own machine.
4. `submit-registration` reassembles the call, refuses an incomplete or expired
   collection, signs the envelope, and submits.

## An inclusion package reveals a balance

A package carries the balance of one customer in clear text. The customer shares
the file only with a party that may see that balance.
