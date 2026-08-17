/**
 * Registration, and the change of a reserve set.
 *
 * The flow is four separable steps, because a reserve holder signs on its own
 * machine and the consent collection is therefore not immediate:
 *
 * 1. Simulate the call and obtain one authorization entry per reserve address.
 * 2. Export the entry of one reserve address.
 * 3. Sign the exported entry on the holder's machine.
 * 4. Import the signed entries, reassemble the call, sign the envelope, and
 *    submit.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";
import { InfrastructureError } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { ConsentError, assembleConsent, consentEntriesOf, consentExpiration } from "./consent.js";
import { isRecord, messageOf } from "./guards.js";
import type { ConsentEntry } from "./consent.js";
import { registryErrorCode } from "./registry-errors.js";
import { RegistryRefusedError } from "./registry.js";
import { addressParts } from "./address.js";

/** The authenticity argument of a registration, one tier per variant. */
export type AssetAuthenticity =
  | { readonly tier: "classic"; readonly serializedAsset: Uint8Array }
  | { readonly tier: "contract" };

/** The result of the simulation step of a registration. */
export interface PreparedCall {
  /** The unsigned transaction, as base64 XDR. */
  readonly transactionXdr: string;
  /** One entry per address whose consent the call needs. */
  readonly entries: readonly ConsentEntry[];
  /** The ledger at which every signature of this call expires. */
  readonly expirationLedger: number;
  /** The minimum resource fee that the simulation reported. */
  readonly minResourceFee: string;
}

/**
 * Reads a prepared call that an earlier step wrote.
 *
 * The consent collection is not immediate, so the prepared call travels through
 * a file and comes back later. The reader inspects every field, because a file
 * that another process wrote is an input like any other.
 */
export function readPreparedCall(text: string): PreparedCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConsentError(`the prepared call is not valid JSON: ${messageOf(cause)}`);
  }
  if (!isRecord(parsed)) {
    throw new ConsentError("the prepared call is a JSON object");
  }
  const transactionXdr = parsed["transactionXdr"];
  const minResourceFee = parsed["minResourceFee"];
  const expirationLedger = parsed["expirationLedger"];
  const entries = parsed["entries"];
  if (typeof transactionXdr !== "string" || transactionXdr.length === 0) {
    throw new ConsentError("the prepared call carries no transaction");
  }
  if (typeof minResourceFee !== "string") {
    throw new ConsentError("the prepared call carries no resource fee");
  }
  if (typeof expirationLedger !== "number" || !Number.isInteger(expirationLedger)) {
    throw new ConsentError("the prepared call carries no expiration ledger");
  }
  if (!Array.isArray(entries)) {
    throw new ConsentError("the prepared call carries no list of authorization entries");
  }
  return {
    transactionXdr,
    minResourceFee,
    expirationLedger,
    entries: entries.map((entry: unknown) => {
      if (!isRecord(entry)) {
        throw new ConsentError("an authorization entry of the prepared call is not an object");
      }
      const address = entry["address"];
      const entryXdr = entry["entryXdr"];
      const entryExpiration = entry["expirationLedger"];
      const signed = entry["signed"];
      if (typeof address !== "string" || typeof entryXdr !== "string") {
        throw new ConsentError("an authorization entry names no address or carries no value");
      }
      if (typeof entryExpiration !== "number" || !Number.isInteger(entryExpiration)) {
        throw new ConsentError(`the authorization entry of ${address} carries no deadline`);
      }
      if (typeof signed !== "boolean") {
        throw new ConsentError(`the authorization entry of ${address} states no signature`);
      }
      return { address, entryXdr, expirationLedger: entryExpiration, signed };
    }),
  };
}

function authenticityValue(authenticity: AssetAuthenticity): xdr.ScVal {
  if (authenticity.tier === "classic") {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Classic"),
      xdr.ScVal.scvBytes(Buffer.from(authenticity.serializedAsset)),
    ]);
  }
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Contract")]);
}

function addressVector(addresses: readonly string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    addresses.map((address) => nativeToScVal(Address.fromString(address))),
  );
}

/**
 * Checks every address of a call before the call reaches the network.
 *
 * The registry refuses a rejected address type with one error code and no
 * address, so the check runs here, where it can name the address.
 */
function requireAcceptedAddresses(addresses: readonly string[]): void {
  for (const address of addresses) {
    addressParts(address);
  }
}

async function prepare(
  server: rpc.Server,
  config: NetworkConfig,
  sourceAccount: Account,
  operation: xdr.Operation,
  currentLedger: number,
): Promise<PreparedCall> {
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();

  let answer: rpc.Api.SimulateTransactionResponse;
  try {
    answer = await server.simulateTransaction(transaction);
  } catch (cause) {
    throw new InfrastructureError("the client cannot simulate the call", { cause });
  }
  if (rpc.Api.isSimulationError(answer)) {
    const code = registryErrorCode(answer.error);
    if (code !== undefined) {
      throw new RegistryRefusedError(code);
    }
    throw new InfrastructureError(`the simulation of the call failed: ${answer.error}`);
  }
  // The assembled transaction carries the resource footprint, the fee, and the
  // unsigned authorization entries of the simulation. The signatures commit to
  // the invocation, the nonce, and the expiration ledger, so the entries stay
  // valid while the holders sign, and no second simulation is needed.
  // The assembly clones the transaction, so the clone already carries the time
  // bounds that the builder above set. A second setTimeout call refuses to
  // overwrite them, so the assembled call takes none.
  const assembled = rpc.assembleTransaction(transaction, answer).build();
  const operationOf = assembled.operations[0];
  if (operationOf === undefined || operationOf.type !== "invokeHostFunction") {
    throw new InfrastructureError("the assembled call carries no contract invocation");
  }
  const expirationLedger = consentExpiration(currentLedger);
  return {
    transactionXdr: assembled.toXDR(),
    entries: consentEntriesOf(operationOf.auth ?? []).map((entry) => ({
      ...entry,
      expirationLedger,
    })),
    expirationLedger,
    minResourceFee: answer.minResourceFee,
  };
}

/** Simulates `register_asset` and returns the entries that need a consent. */
export async function prepareRegistration(
  server: rpc.Server,
  config: NetworkConfig,
  input: {
    sourceAccount: Account;
    registry: string;
    asset: string;
    authority: string;
    authenticity: AssetAuthenticity;
    reserves: readonly string[];
    currentLedger: number;
  },
): Promise<PreparedCall> {
  requireAcceptedAddresses([input.asset, input.authority, ...input.reserves]);
  const contract = new Contract(input.registry);
  const operation = contract.call(
    "register_asset",
    nativeToScVal(Address.fromString(input.asset)),
    nativeToScVal(Address.fromString(input.authority)),
    authenticityValue(input.authenticity),
    addressVector(input.reserves),
  );
  return prepare(server, config, input.sourceAccount, operation, input.currentLedger);
}

/** Simulates `set_reserves` and returns the entries that need a consent. */
export async function prepareReserveChange(
  server: rpc.Server,
  config: NetworkConfig,
  input: {
    sourceAccount: Account;
    registry: string;
    asset: string;
    reserves: readonly string[];
    currentLedger: number;
  },
): Promise<PreparedCall> {
  requireAcceptedAddresses([input.asset, ...input.reserves]);
  const contract = new Contract(input.registry);
  const operation = contract.call(
    "set_reserves",
    nativeToScVal(Address.fromString(input.asset)),
    addressVector(input.reserves),
  );
  return prepare(server, config, input.sourceAccount, operation, input.currentLedger);
}

/** The outcome of a submitted call. */
export interface SubmitResult {
  readonly transactionHash: string;
  readonly ledger: number;
}

/**
 * Reassembles a prepared call with the collected consents, signs the envelope,
 * and submits it.
 *
 * The reassembly refuses when an address of the simulation carries no signed
 * entry, so an incomplete collection fails before the network sees it.
 */
export async function submitPreparedCall(
  server: rpc.Server,
  config: NetworkConfig,
  input: {
    prepared: PreparedCall;
    collected: readonly ConsentEntry[];
    envelopeSigner: Keypair;
  },
): Promise<SubmitResult> {
  // The signed entries replace the unsigned ones inside the envelope, so the
  // resource footprint, the fee, the sequence number, and the nonces stay
  // exactly as the assembled call fixed them.
  const envelope = xdr.TransactionEnvelope.fromXDR(input.prepared.transactionXdr, "base64");
  const operations = envelope.v1().tx().operations();
  const body = operations[0]?.body();
  if (body === undefined || body.switch().name !== "invokeHostFunction") {
    throw new InfrastructureError("the prepared call carries no contract invocation");
  }
  const hostFunction = body.invokeHostFunctionOp();
  hostFunction.auth(assembleConsent(hostFunction.auth(), input.collected));

  const ready = new Transaction(envelope.toXDR("base64"), config.networkPassphrase);
  ready.sign(input.envelopeSigner);
  return sendAndSettle(server, ready);
}

/** Sends a signed transaction and waits for the network to settle it. */
export async function sendAndSettle(
  server: rpc.Server,
  ready: Transaction,
): Promise<SubmitResult> {
  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await server.sendTransaction(ready);
  } catch (cause) {
    throw new InfrastructureError("the client cannot send the call", { cause });
  }
  if (sent.status === "ERROR") {
    const code = registryErrorCode(JSON.stringify(sent));
    if (code !== undefined) {
      throw new RegistryRefusedError(code);
    }
    throw new InfrastructureError(`the network refused the call: ${sent.status}`);
  }
  let settled: rpc.Api.GetTransactionResponse;
  try {
    settled = await server.pollTransaction(sent.hash);
  } catch (cause) {
    throw new InfrastructureError(
      `the client cannot read the outcome of the transaction ${sent.hash}`,
      { cause },
    );
  }
  if (settled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    const code = registryErrorCode(JSON.stringify(settled));
    if (code !== undefined) {
      throw new RegistryRefusedError(code);
    }
    throw new InfrastructureError(
      `the transaction ${sent.hash} did not succeed: ${settled.status}`,
    );
  }
  return { transactionHash: sent.hash, ledger: settled.ledger };
}
