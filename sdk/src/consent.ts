/**
 * Reserve consent: the signing of one Soroban authorization entry.
 *
 * Every reserve address must authorize the registration with the full argument
 * list of the invocation. The pinned command line collects a signer for a
 * top-level address argument only, and a reserve address sits inside a list,
 * so this library is the one signer of a reserve consent.
 *
 * A real reserve holder does not give a secret key to the authority machine,
 * so the steps below are separable: simulate, export one entry, sign it on the
 * holder's own machine, import it, and submit. Each entry carries an
 * expiration ledger, and every step surfaces that deadline.
 */

import { Address, authorizeEntry, inspectAuthEntry, xdr } from "@stellar/stellar-sdk";
import { CONSENT_EXPIRY_WARNING_LEDGERS, CONSENT_VALIDITY_LEDGERS } from "./constants.js";
import { messageOf } from "./guards.js";

/**
 * A signer of one authorization entry: a key pair, or a callback that a wallet
 * drives. The callback shape is the one that the Stellar library defines.
 */
export type ConsentSigner = Parameters<typeof authorizeEntry>[1];

/** One authorization entry that a reserve address must sign. */
export interface ConsentEntry {
  /** The address whose consent the entry carries. */
  readonly address: string;
  /** The entry itself, as base64 XDR, so it travels as text. */
  readonly entryXdr: string;
  /** The ledger at which the signature of the entry expires. */
  readonly expirationLedger: number;
  /** True when the entry already carries a signature. */
  readonly signed: boolean;
}

/** A consent step that cannot proceed. */
export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentError";
  }
}

/** The expiration ledger that a new consent entry receives. */
export function consentExpiration(currentLedger: number): number {
  return currentLedger + CONSENT_VALIDITY_LEDGERS;
}

/** Reads one entry out of its base64 XDR text. */
function decode(entryXdr: string): xdr.SorobanAuthorizationEntry {
  try {
    return xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
  } catch (cause) {
    throw new ConsentError(
      `the text is not a Soroban authorization entry: ${messageOf(cause)}`,
    );
  }
}

/** Describes one entry, so a step can name its address and its deadline. */
export function describeEntry(entry: xdr.SorobanAuthorizationEntry): ConsentEntry {
  const information = inspectAuthEntry(entry);
  if (information.address === null) {
    throw new ConsentError(
      "the entry carries source account credentials, so no separate address signs it",
    );
  }
  return {
    address: information.address,
    entryXdr: entry.toXDR("base64"),
    expirationLedger: information.signatureExpirationLedger ?? 0,
    signed: information.signed,
  };
}

/**
 * The entries of a simulated call that need the consent of an address other
 * than the transaction source.
 *
 * The list comes from the simulation, so it names the exact invocation that
 * each address consents to. A caller must not build an entry by hand.
 */
export function consentEntriesOf(
  entries: readonly xdr.SorobanAuthorizationEntry[],
): ConsentEntry[] {
  return entries
    .filter((entry) => inspectAuthEntry(entry).address !== null)
    .map((entry) => describeEntry(entry));
}

/**
 * Exports the entry of one address, so the holder of that address signs it on
 * another machine.
 *
 * The function refuses when the address has no entry, because a silent empty
 * export would look like a completed step.
 */
export function exportConsentEntry(
  entries: readonly ConsentEntry[],
  address: string,
): ConsentEntry {
  const wanted = Address.fromString(address).toString();
  const found = entries.find((entry) => entry.address === wanted);
  if (found === undefined) {
    throw new ConsentError(`the simulated call carries no authorization entry for ${wanted}`);
  }
  return found;
}

/**
 * Signs one exported entry.
 *
 * The signature commits to this registry contract, this function, the exact
 * argument list, this network, a single-use nonce, and the expiration ledger.
 * A captured entry therefore cannot be replayed into a later call.
 */
export async function signConsentEntry(input: {
  entryXdr: string;
  signer: ConsentSigner;
  expirationLedger: number;
  networkPassphrase: string;
  expectedAddress?: string;
}): Promise<ConsentEntry> {
  const entry = decode(input.entryXdr);
  const described = describeEntry(entry);
  if (input.expectedAddress !== undefined) {
    const wanted = Address.fromString(input.expectedAddress).toString();
    if (described.address !== wanted) {
      throw new ConsentError(
        `the entry asks for the consent of ${described.address}, and the signer names ${wanted}`,
      );
    }
  }
  const signed = await authorizeEntry(
    entry,
    input.signer,
    input.expirationLedger,
    input.networkPassphrase,
  );
  return describeEntry(signed);
}

/**
 * Signs the entry of one address inside a whole transaction envelope.
 *
 * A pipeline that passes one envelope from step to step needs this shape: the
 * envelope arrives, one address signs its own entry, and the envelope leaves
 * with every other entry untouched. The function refuses when the envelope
 * holds no entry for the address, and it refuses when it holds more than one,
 * because either case means the caller signed the wrong call.
 */
export async function signEntryInEnvelope(input: {
  envelopeXdr: string;
  address: string;
  signer: ConsentSigner;
  expirationLedger: number;
  networkPassphrase: string;
}): Promise<string> {
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(input.envelopeXdr, "base64");
  } catch (cause) {
    throw new ConsentError(`the text is not a transaction envelope: ${messageOf(cause)}`);
  }
  if (envelope.switch().name !== "envelopeTypeTx") {
    throw new ConsentError("the envelope is not a version one transaction envelope");
  }
  const operations = envelope.v1().tx().operations();
  if (operations.length !== 1) {
    throw new ConsentError(
      `a registration carries one operation, and this envelope carries ${operations.length}`,
    );
  }
  const operation = operations[0];
  if (operation === undefined) {
    throw new ConsentError("the envelope carries no operation");
  }
  const body = operation.body();
  if (body.switch().name !== "invokeHostFunction") {
    throw new ConsentError("the operation is not a contract invocation");
  }
  const hostFunction = body.invokeHostFunctionOp();
  const wanted = Address.fromString(input.address).toString();

  const signedEntries: xdr.SorobanAuthorizationEntry[] = [];
  let count = 0;
  for (const entry of hostFunction.auth()) {
    if (inspectAuthEntry(entry).address !== wanted) {
      signedEntries.push(entry);
      continue;
    }
    count += 1;
    signedEntries.push(
      await authorizeEntry(entry, input.signer, input.expirationLedger, input.networkPassphrase),
    );
  }
  if (count !== 1) {
    throw new ConsentError(
      `the envelope holds ${count} authorization entries for ${wanted}, and this step signs exactly one`,
    );
  }
  hostFunction.auth(signedEntries);
  return envelope.toXDR("base64");
}

/** The state of one address in a consent collection. */
export interface ConsentState {
  readonly address: string;
  readonly signed: boolean;
  readonly expired: boolean;
  readonly expirationLedger: number;
  /** True when the deadline is close enough that a submission may miss it. */
  readonly closeToTheDeadline: boolean;
}

/**
 * Reports which addresses still have to sign, and which signatures are close
 * to their deadline.
 *
 * The current ledger comes from the network, never from a caller's record, so
 * a stale value cannot hide an expired entry.
 */
export function consentState(
  entries: readonly ConsentEntry[],
  currentLedger: number,
): ConsentState[] {
  return entries.map((entry) => ({
    address: entry.address,
    signed: entry.signed,
    // The expiration is exclusive, and an unsigned entry carries no deadline
    // of its own, so only a signed entry can expire.
    expired: entry.signed && currentLedger >= entry.expirationLedger,
    expirationLedger: entry.expirationLedger,
    closeToTheDeadline:
      entry.signed && entry.expirationLedger - currentLedger <= CONSENT_EXPIRY_WARNING_LEDGERS,
  }));
}

/**
 * Puts the collected entries back into the transaction, in place of the
 * unsigned entries that the simulation produced.
 *
 * The function refuses when an address of the simulation has no signed entry,
 * so an incomplete collection fails here and not on the network.
 */
export function assembleConsent(
  simulated: readonly xdr.SorobanAuthorizationEntry[],
  collected: readonly ConsentEntry[],
): xdr.SorobanAuthorizationEntry[] {
  const byAddress = new Map<string, xdr.SorobanAuthorizationEntry>();
  for (const entry of collected) {
    byAddress.set(entry.address, decode(entry.entryXdr));
  }
  return simulated.map((entry) => {
    const address = inspectAuthEntry(entry).address;
    if (address === null) {
      return entry;
    }
    const signed = byAddress.get(address);
    if (signed === undefined) {
      throw new ConsentError(`the address ${address} did not sign its authorization entry`);
    }
    return signed;
  });
}
