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
| 8 | a failure of the client or of the network, which is not a verdict |
| 9 | the deployments file of this verifier contradicts itself |

## Configuration

The client takes its endpoint and its registry addresses from its own
configuration and from its own copy of the deployments file, never from a
package. A package value may select a record inside data that the client already
trusts. It must never select where the trusted data comes from.

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
