# @zkpor/sdk

The client library and the `zkpor` command line for the zkPoR registry.

The package covers six capabilities.

- Registration with account reserves, and a change of a reserve set. Every
  reserve address must authorize the call. A reserve address sits inside a list
  argument, and the pinned command line collects a signer only for a top-level
  address argument, so this library is the one signer of a reserve consent.
- Per-reserve diagnosis. A reverted attestation carries a contract error code
  and no address, so only a client that reads each reserve balance on its own
  can name the address that failed.
- The proving driver, which runs the pinned native binaries.
- Attestation submission.
- Registry queries, including persistent attestation history and legacy event history.
- The customer inclusion check.

The package does not hold the cryptographic definitions. The shared Rust crate
`contracts/context` is the definition, and the code here is a mirror that the
tests compare against the committed vectors. The package also writes no
customer file: the generation gate lives in the generator, and a second writer
of per-customer files would double the surface that touches sensitive data.

## Fixed attestation records

Version 2 customer packages carry a positive decimal `attestation_id` and a balance commitment.
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

## Run the customer check

The examples use `fixtures/synthetic_package_v2.zkpor.json` and a synthetic RPC response.
The fixture describes no real customer, liability, or accepted network attestation.

### Check the synthetic package

```bash
npm install
npm run example
```

The example runs `zkpor verify-inclusion` against a local synthetic endpoint.
It prints the verdict and exit code.
It needs no key, funds, proving toolchain, or network access.

### Check your package against a network

```bash
ZKPOR_NETWORK=testnet ZKPOR_RPC_URL=https://soroban-testnet.stellar.org \
  npx zkpor verify-inclusion /absolute/path/to/customer.zkpor.json \
  /absolute/path/to/deployments.json
```

Use your own version 2 package and trusted deployment configuration.
The registry must support persistent history and retain the selected attestation.
A testnet reset can remove its contracts and records.
A later attestation does not change the fixed record that a version 2 package selects.

### Check a package with an incorrect path

```bash
npm install
npm run build
node examples/check-a-package.mjs ../fixtures/synthetic_package_v2_wrong_path.zkpor.json
```

The second synthetic package has a changed sibling hash.
The example reports a root mismatch, with exit code 7.
The example accepts a package path and uses the valid synthetic package when no path is supplied.

## Call the check from your own program

```
npm install && npm run example:library
```

The example above runs the command line. This one calls the library, which is
what a team integrating the flow does. It shows the three things a caller has to
get right and nothing else.

- **A verdict is not a boolean.** The check answers one of seven kinds, and six
  of them are refusals that each mean something different.
- **A refusal is an answer.** A package that is not under the attested root is
  the check working. The verdict carries the recomputed root and the attested
  one, so a caller shows a customer what happened.
- **A failure is not a verdict.** When the network cannot be read, the call
  raises `InfrastructureError`. A caller that turned that into "not included"
  would tell a customer their balance is missing because a request timed out.

It uses the same synthetic endpoint as the command example.
For a network check, configure a trusted endpoint and use your own accepted package.

The example leaves out proving, attestation, registration, and the signing of a
reserve consent. Those belong to the issuer, who runs them from the command line
of this package, and no integrating team performs them.

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
zkpor verify-inclusion <package.zkpor.json> [deployments.json]
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
