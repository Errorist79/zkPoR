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
- Registry queries, including the attestation history. A history result states
  the oldest ledger that the query covered.
- The customer inclusion check.

The package does not hold the cryptographic definitions. The shared Rust crate
`contracts/context` is the definition, and the code here is a mirror that the
tests compare against the committed vectors. The package also writes no
customer file: the generation gate lives in the generator, and a second writer
of per-customer files would double the surface that touches sensitive data.

## Run the customer check

The check tells one customer whether their balance sits under the root that the
registry accepted. Two commands run it, and they differ only in where the
answers come from. A third command runs it against a package that the check
refuses.

### Against a recording, which always works

```
npm install && npm run example
```

The example runs `zkpor verify-inclusion` against a recorded answer of the
registry, and prints the verdict and the exit code. It needs no key, no funding,
no proving toolchain, and no network.

**A recording is not the chain.** Every answer is one this repository wrote
down, so a check that passes against it proves that the client reads and refuses
correctly. It proves nothing about what any network holds now.

### Against the test network, while the record stands

```
ZKPOR_NETWORK=testnet ZKPOR_RPC_URL=https://soroban-testnet.stellar.org \
  npx zkpor verify-inclusion ../fixtures/example_package.zkpor.json \
  ../scripts/deployments.json
```

This reads the chain. It answers a verdict while the registry still holds the
attestation that the committed package rests on.

**It will stop working, and here is how to read it when it does.** The test
network is cleared two to four times a year, and a clearing removes every
contract. After one, the command answers that the registry holds no record of
the asset. If somebody attests this asset again, the command answers that the
package names one snapshot ledger and the registry attests another. Neither is a
defect in the client. Both mean the record moved, and the recording above still
runs.

The package that both commands read is committed, and the run that produced it
is not reproducible from this repository: it read a master secret that this
repository does not hold. The balance in it is fictional and already committed,
in the list of test customers.

### The package the check refuses

```
npm install && npm run build
node examples/check-a-package.mjs ../fixtures/example_package_wrong_balance.zkpor.json
```

A check that only accepts proves half of the claim. So the repository commits a
second package, and the command above runs the same example against it. The
answer is that the recomputed root does not equal the attested root, and the
exit code 7. The example takes any package path, and it reads the included
package when it gets none.

The two files differ in the balance and in nothing else. The refused one reads
1001 where the attested balance reads 1000, so the check refuses a package that
is well formed and plausible, and not a file that is broken.

**The one unit is the point.** It is the smallest change a person can make to
that field, and no reader of the two files finds it by eye. The root binds the
exact balance, so the check has no tolerance, and a larger edit would teach the
weaker lesson that the check catches only a crude one.

Both files describe the same customer of the committed list of test customers,
`fixtures/test_only_customers.csv`, which describes no real person and no real
liability. The balance 1001 belongs to no row of that list. Neither file states
this inside itself, because the format permits no field that it does not name.

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

It runs against a recording, and the same sentence applies: a recording is not
the chain. Give the configuration the address of a network endpoint to read one.

The example leaves out proving, attestation, registration, and the signing of a
reserve consent. Those belong to the issuer, who runs them from the command line
of this package, and no integrating team performs them.

## The Poseidon2 dependency

The protocol names the Poseidon2 instance of `noir-lang/poseidon` v0.2.0, file
`src/poseidon2.nr`, over the BN254 scalar field, with state width 4, rate 3, and
a sponge capacity that starts at the input count times 2^64. This package uses
`@zkpassport/poseidon2`, pinned to one exact version. The mirror test reproduces
every committed vector with it, which is the acceptance check that the
specification names.

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

## What a live network has exercised

The tests of this package run without a network. A test cannot reach the two
calls that send a transaction and wait for its outcome, so those ran against the
Stellar test network on August 17, 2026.

**This run is not evidence for the validated artifact.** It provisioned its own
issuer, its own asset, and its own reserve accounts, and the asset code says
`THROWAWAY`. The record it left on the registry
`CCHUTDKUPWXVUIX6D26SE5NZ5STP74VV4DY2CNVCMNJYOU5PTROLA7MY` is a record of a
disposable asset, `CC3APVB2TJEKJYMS2NBFYLPT23JPCFXGNIRTWCNQKK7TCONBBHXS456D`.
The soundness evidence of this project stands in `SECURITY.md`, and it names two
other assets. Do not read this run as part of it.

The run covered every path of this package that needs a network:

- the registration, with the consent of two reserve addresses that each signed
  its own authorization entry, accepted at ledger 4187501;
- the record of the asset, the reserve observation, and the diagnosis of each
  reserve balance on its own;
- the proving driver, which produced a proof of 14,592 bytes with the pinned
  prover;
- the attestation, accepted at ledger 4187508, whose attested root equals the
  root that the proof carries;
- the attestation history from the event stream, which found the attestation
  inside the retained window;
- the customer check, which accepted three packages that the generator wrote and
  which reported a root mismatch for a package with a changed balance.

The run found one defect that no test without a network could find. The assembly
of a simulated call already carries its time bounds, and a second call that set a
timeout threw. That stopped the registration and the attestation before either
one reached the network. Every test passed before that run.

## An inclusion package reveals a balance

A package carries the balance of one customer in clear text. The customer shares
the file only with a party that may see that balance.
