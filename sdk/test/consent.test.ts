/**
 * The reserve consent flow.
 *
 * This flow is the reason the library exists: the pinned command line collects
 * a signer only for a top-level address argument, and a reserve address sits
 * inside a list, so nothing else can produce these signatures. The tests build
 * the authorization entries directly, so the whole flow runs without a network.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  inspectAuthEntry,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { elementAt } from "./fixture-guards.js";
import { CONSENT_EXPIRY_WARNING_LEDGERS, CONSENT_VALIDITY_LEDGERS } from "../src/constants.js";
import {
  ConsentError,
  assembleConsent,
  consentEntriesOf,
  consentExpiration,
  consentState,
  describeEntry,
  exportConsentEntry,
  signConsentEntry,
  signEntryInEnvelope,
} from "../src/consent.js";

/** The registry contract of the tests. The value is test data. */
const REGISTRY = "CARCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEVQO";
/** The ledger that the tests use for the current one. The value is test data. */
const CURRENT_LEDGER = 1000;

/** The authorization list of the single operation of a decoded envelope. */
function authOf(operations: xdr.Operation[]): xdr.SorobanAuthorizationEntry[] {
  const operation = elementAt(operations, 0, "operation list of the envelope");
  return operation.body().invokeHostFunctionOp().auth();
}

function keypairOf(fill: number): Keypair {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, fill));
}

function invocation(): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(REGISTRY).toScAddress(),
        functionName: "register_asset",
        args: [],
      }),
    ),
    subInvocations: [],
  });
}

/** One unsigned authorization entry that waits for the consent of an address. */
function unsignedEntry(address: string, nonce: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString(nonce),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation(),
  });
}

/** The entry of the transaction source, which the envelope signature covers. */
function sourceAccountEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation(),
  });
}

function envelopeOf(entries: xdr.SorobanAuthorizationEntry[]): string {
  const source = keypairOf(1);
  const operation = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(REGISTRY).toScAddress(),
        functionName: "register_asset",
        args: [],
      }),
    ),
    auth: entries,
  });
  return new TransactionBuilder(new Account(source.publicKey(), "5"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build()
    .toXDR();
}

describe("the deadline of a consent", () => {
  it("takes the margin from the one definition of it", () => {
    expect(consentExpiration(CURRENT_LEDGER)).toBe(CURRENT_LEDGER + CONSENT_VALIDITY_LEDGERS);
  });
});

describe("the entries that a call needs", () => {
  it("names one entry per address, and leaves out the source account entry", () => {
    const first = keypairOf(2);
    const second = keypairOf(3);
    const entries = consentEntriesOf([
      sourceAccountEntry(),
      unsignedEntry(first.publicKey(), "11"),
      unsignedEntry(second.publicKey(), "12"),
    ]);
    expect(entries.map((entry) => entry.address)).toEqual([
      first.publicKey(),
      second.publicKey(),
    ]);
    expect(entries.every((entry) => !entry.signed)).toBe(true);
  });

  it("refuses to describe an entry that no separate address signs", () => {
    expect(() => describeEntry(sourceAccountEntry())).toThrow(ConsentError);
  });
});

describe("the export of one entry", () => {
  const first = keypairOf(2);
  const second = keypairOf(3);
  const entries = consentEntriesOf([
    unsignedEntry(first.publicKey(), "11"),
    unsignedEntry(second.publicKey(), "12"),
  ]);

  it("gives the entry of the address that the caller names", () => {
    expect(exportConsentEntry(entries, second.publicKey()).address).toBe(second.publicKey());
  });

  it("refuses an address that the call does not need", () => {
    expect(() => exportConsentEntry(entries, keypairOf(9).publicKey())).toThrow(ConsentError);
  });
});

describe("the signature of one exported entry", () => {
  const holder = keypairOf(4);

  it("signs the entry and records the deadline", async () => {
    const entry = describeEntry(unsignedEntry(holder.publicKey(), "11"));
    const signed = await signConsentEntry({
      entryXdr: entry.entryXdr,
      signer: holder,
      expirationLedger: consentExpiration(CURRENT_LEDGER),
      networkPassphrase: Networks.TESTNET,
      expectedAddress: holder.publicKey(),
    });
    expect(signed.signed).toBe(true);
    expect(signed.expirationLedger).toBe(consentExpiration(CURRENT_LEDGER));
    expect(signed.address).toBe(holder.publicKey());
  });

  it("refuses an entry that asks for the consent of another address", async () => {
    const entry = describeEntry(unsignedEntry(keypairOf(5).publicKey(), "11"));
    await expect(
      signConsentEntry({
        entryXdr: entry.entryXdr,
        signer: holder,
        expirationLedger: consentExpiration(CURRENT_LEDGER),
        networkPassphrase: Networks.TESTNET,
        expectedAddress: holder.publicKey(),
      }),
    ).rejects.toThrow(ConsentError);
  });

  it("refuses text that is not an authorization entry", async () => {
    await expect(
      signConsentEntry({
        entryXdr: "not base64 XDR",
        signer: holder,
        expirationLedger: 1,
        networkPassphrase: Networks.TESTNET,
      }),
    ).rejects.toThrow(ConsentError);
  });

  /**
   * The signature commits to the network passphrase, so a signature that one
   * network accepts is a different signature on another network.
   */
  it("gives another signature under another network passphrase", async () => {
    const entry = describeEntry(unsignedEntry(holder.publicKey(), "11"));
    const onTestnet = await signConsentEntry({
      entryXdr: entry.entryXdr,
      signer: holder,
      expirationLedger: 1234,
      networkPassphrase: Networks.TESTNET,
    });
    const onPublic = await signConsentEntry({
      entryXdr: entry.entryXdr,
      signer: holder,
      expirationLedger: 1234,
      networkPassphrase: Networks.PUBLIC,
    });
    expect(onTestnet.entryXdr).not.toBe(onPublic.entryXdr);
  });
});

describe("the state of a collection", () => {
  const holder = keypairOf(6);

  async function signedAt(expiration: number) {
    const entry = describeEntry(unsignedEntry(holder.publicKey(), "11"));
    return signConsentEntry({
      entryXdr: entry.entryXdr,
      signer: holder,
      expirationLedger: expiration,
      networkPassphrase: Networks.TESTNET,
    });
  }

  it("calls an unsigned entry unsigned, and not expired", () => {
    const entries = consentEntriesOf([unsignedEntry(holder.publicKey(), "11")]);
    const state = consentState(entries, CURRENT_LEDGER);
    const first = elementAt(state, 0, "consent state list");
    expect(first.signed).toBe(false);
    expect(first.expired).toBe(false);
  });

  it("calls a signature past its deadline expired", async () => {
    const signed = await signedAt(CURRENT_LEDGER - 1);
    const state = consentState([signed], CURRENT_LEDGER);
    expect(elementAt(state, 0, "consent state list").expired).toBe(true);
  });

  it("calls a signature at its deadline expired, because the deadline is exclusive", async () => {
    const signed = await signedAt(CURRENT_LEDGER);
    const state = consentState([signed], CURRENT_LEDGER);
    expect(elementAt(state, 0, "consent state list").expired).toBe(true);
  });

  it("warns when the deadline is close, and stays quiet when it is far", async () => {
    const close = await signedAt(CURRENT_LEDGER + CONSENT_EXPIRY_WARNING_LEDGERS);
    const far = await signedAt(CURRENT_LEDGER + CONSENT_EXPIRY_WARNING_LEDGERS + 1);
    const nearState = consentState([close], CURRENT_LEDGER);
    const farState = consentState([far], CURRENT_LEDGER);
    expect(elementAt(nearState, 0, "consent state list").closeToTheDeadline).toBe(true);
    expect(elementAt(farState, 0, "consent state list").closeToTheDeadline).toBe(false);
  });
});

describe("the reassembly of a call", () => {
  const first = keypairOf(2);
  const second = keypairOf(3);
  const simulated = [
    sourceAccountEntry(),
    unsignedEntry(first.publicKey(), "11"),
    unsignedEntry(second.publicKey(), "12"),
  ];

  async function signAll() {
    const entries = consentEntriesOf(simulated);
    return Promise.all(
      entries.map(async (entry) =>
        signConsentEntry({
          entryXdr: entry.entryXdr,
          signer: entry.address === first.publicKey() ? first : second,
          expirationLedger: consentExpiration(CURRENT_LEDGER),
          networkPassphrase: Networks.TESTNET,
        }),
      ),
    );
  }

  it("puts every signature in place and keeps the source account entry", async () => {
    const collected = await signAll();
    const assembled = assembleConsent(simulated, collected);
    expect(assembled).toHaveLength(3);
    expect(inspectAuthEntry(elementAt(assembled, 0, "assembled entry list")).address).toBeNull();
    expect(inspectAuthEntry(elementAt(assembled, 1, "assembled entry list")).signed).toBe(true);
    expect(inspectAuthEntry(elementAt(assembled, 2, "assembled entry list")).signed).toBe(true);
  });

  it("refuses an incomplete collection, so it fails here and not on the network", async () => {
    const collected = await signAll();
    expect(() => assembleConsent(simulated, collected.slice(0, 1))).toThrow(ConsentError);
  });
});

describe("the signature of one entry inside a whole envelope", () => {
  const first = keypairOf(2);
  const second = keypairOf(3);

  it("signs the entry of the named address and leaves every other entry alone", async () => {
    const envelope = envelopeOf([
      sourceAccountEntry(),
      unsignedEntry(first.publicKey(), "11"),
      unsignedEntry(second.publicKey(), "12"),
    ]);
    const signed = await signEntryInEnvelope({
      envelopeXdr: envelope,
      address: first.publicKey(),
      signer: first,
      expirationLedger: consentExpiration(CURRENT_LEDGER),
      networkPassphrase: Networks.TESTNET,
    });
    const operations = xdr.TransactionEnvelope.fromXDR(signed, "base64").v1().tx().operations();
    const auth = authOf(operations);
    expect(inspectAuthEntry(elementAt(auth, 0, "authorization list")).address).toBeNull();
    expect(inspectAuthEntry(elementAt(auth, 1, "authorization list")).signed).toBe(true);
    expect(inspectAuthEntry(elementAt(auth, 2, "authorization list")).signed).toBe(false);
  });

  it("carries every earlier signature through a second step", async () => {
    const envelope = envelopeOf([
      unsignedEntry(first.publicKey(), "11"),
      unsignedEntry(second.publicKey(), "12"),
    ]);
    const once = await signEntryInEnvelope({
      envelopeXdr: envelope,
      address: first.publicKey(),
      signer: first,
      expirationLedger: 1234,
      networkPassphrase: Networks.TESTNET,
    });
    const twice = await signEntryInEnvelope({
      envelopeXdr: once,
      address: second.publicKey(),
      signer: second,
      expirationLedger: 1234,
      networkPassphrase: Networks.TESTNET,
    });
    const operations = xdr.TransactionEnvelope.fromXDR(twice, "base64").v1().tx().operations();
    const auth = authOf(operations);
    expect(auth.every((entry) => inspectAuthEntry(entry).signed)).toBe(true);
  });

  it("refuses an envelope that holds no entry for the address", async () => {
    const envelope = envelopeOf([unsignedEntry(second.publicKey(), "12")]);
    await expect(
      signEntryInEnvelope({
        envelopeXdr: envelope,
        address: first.publicKey(),
        signer: first,
        expirationLedger: 1234,
        networkPassphrase: Networks.TESTNET,
      }),
    ).rejects.toThrow(ConsentError);
  });

  it("refuses text that is not a transaction envelope", async () => {
    await expect(
      signEntryInEnvelope({
        envelopeXdr: "not base64 XDR",
        address: first.publicKey(),
        signer: first,
        expirationLedger: 1234,
        networkPassphrase: Networks.TESTNET,
      }),
    ).rejects.toThrow(ConsentError);
  });
});
