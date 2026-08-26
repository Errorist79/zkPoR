// Signs the authorization entry of one reserve account.
//
// A reserve address must authorize its own registration. The reserve sits
// inside a vector argument, and the command line collects a signer only for a
// top-level address argument, so no command line invocation signs this entry.
// This program signs it with the JavaScript SDK.
//
// The program reads one simulated transaction envelope on the standard input
// and writes the same envelope with the signed entry on the standard output.
// It signs no envelope: the source account signs the transaction afterwards.
//
// usage:
//   sign-entry.mjs <reserve-address> <valid-until-ledger> <network-passphrase>
//
// The secret key of the reserve account arrives in ZKPOR_RESERVE_SECRET. It
// never arrives in a file and never appears on the output.
//
// The program needs the module @stellar/stellar-sdk at the version that
// scripts/versions.env pins.

import { readFileSync } from "node:fs";
import { Address, Keypair, authorizeEntry, xdr } from "@stellar/stellar-sdk";

const [reserve, validUntil, passphrase] = process.argv.slice(2);
if (!reserve || !validUntil || !passphrase) {
  console.error(
    "usage: sign-entry.mjs <reserve-address> <valid-until-ledger> <network-passphrase>",
  );
  process.exit(2);
}

const secret = process.env.ZKPOR_RESERVE_SECRET;
if (!secret) {
  console.error("set ZKPOR_RESERVE_SECRET to the secret key of the reserve account");
  process.exit(2);
}
const signer = Keypair.fromSecret(secret);
if (signer.publicKey() !== reserve) {
  console.error(`the secret key belongs to ${signer.publicKey()}, and not to ${reserve}`);
  process.exit(2);
}

const envelope = xdr.TransactionEnvelope.fromXDR(
  readFileSync(0, "utf8").trim(),
  "base64",
);
if (envelope.switch().name !== "envelopeTypeTx") {
  console.error(`the input holds a ${envelope.switch().name} envelope, and this program reads envelopeTypeTx`);
  process.exit(3);
}
const operations = envelope.v1().tx().operations();
if (operations.length !== 1) {
  console.error(`the transaction holds ${operations.length} operations, and this program signs one`);
  process.exit(3);
}
const operation = operations[0].body().invokeHostFunctionOp();

// A recorded entry carries the expiration zero and no signature. The signature
// covers the network, this contract, this function, the argument list, the
// nonce, and the expiration, so a captured entry has no second use.
let signedCount = 0;
const entries = [];
for (const entry of operation.auth()) {
  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    entries.push(entry);
    continue;
  }
  const address = Address.fromScAddress(credentials.address().address()).toString();
  if (address !== reserve) {
    entries.push(entry);
    continue;
  }
  entries.push(await authorizeEntry(entry, signer, Number(validUntil), passphrase));
  signedCount += 1;
}
if (signedCount !== 1) {
  console.error(`the transaction holds ${signedCount} entries of ${reserve}, and this program signs one`);
  process.exit(3);
}
operation.auth(entries);

console.log(envelope.toXDR("base64"));
