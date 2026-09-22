import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, Keypair, Networks, SorobanDataBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DisputeInputError,
  answerDispute,
  decodeDispute,
  openDispute,
  parseInclusionEvidence,
  readStoredDispute,
  resolveDispute,
} from "../src/disputes.js";
import { InfrastructureError } from "../src/network.js";
import { RegistryRefusedError } from "../src/registry.js";
import { toHex } from "../src/fr.js";
import { isRecord } from "../src/guards.js";
import * as registration from "../src/registration.js";

const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const SIGNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));
const NETWORK = {
  network: "testnet", rpcUrl: "http://127.0.0.1:1", networkPassphrase: Networks.TESTNET, allowHttp: true,
};
const EVIDENCE = { id: 7n, commitment: 13n, path: [17n, 19n], position: 2 };

function serverFor(response: xdr.ScVal | string | Error): {
  server: rpc.Server;
  calls: { method: string; args: unknown[] }[];
  rawCalls: xdr.ScVal[][];
} {
  const server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: true });
  const calls: { method: string; args: unknown[] }[] = [];
  const rawCalls: xdr.ScVal[][] = [];
  server.simulateTransaction = async (transaction): Promise<rpc.Api.SimulateTransactionResponse> => {
    const operation = transaction.toEnvelope().v1().tx().operations()[0];
    if (operation === undefined) {
      throw new Error("the test transaction has no call");
    }
    const call = operation.body().invokeHostFunctionOp().hostFunction().invokeContract();
    rawCalls.push(call.args());
    calls.push({
      method: call.functionName().toString(),
      args: call.args().map((value): unknown => scValToNative(value)),
    });
    if (response instanceof Error) {
      throw response;
    }
    const base = { id: "1", latestLedger: 500, events: [], _parsed: true };
    if (typeof response === "string") {
      return { ...base, error: response };
    }
    return {
      ...base,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "0",
      result: { auth: [], retval: response },
    };
  };
  return { server, calls, rawCalls };
}

function emailVector(name: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "email_returns.json"), "utf8"));
  if (!isRecord(parsed) || typeof parsed[name] !== "string") {
    throw new Error(`the email ABI vector ${name} is missing`);
  }
  return parsed[name];
}

function decodedEmailVector(name: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(emailVector(name), "base64"));
}

function disputeValue(origin: xdr.ScVal | undefined): xdr.ScVal {
  return nativeToScVal({
    disputer: nativeToScVal(SIGNER.publicKey(), { type: "address" }),
    ...(origin === undefined
      ? { evidence_id: nativeToScVal(1n, { type: "u64" }) }
      : { origin }),
    target_id: nativeToScVal(2n, { type: "u64" }),
    identifier: nativeToScVal(7n, { type: "u256" }),
    opened_ledger: nativeToScVal(500, { type: "u32" }),
    deadline: nativeToScVal(52_340, { type: "u32" }),
    status: nativeToScVal([nativeToScVal("Open", { type: "symbol" })]),
    closed_ledger: nativeToScVal(0, { type: "u32" }),
    burned_bond: nativeToScVal(0n, { type: "i128" }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("fixed dispute reads", () => {
  it("decodes the contract's inclusion and email origins and all dispute statuses", () => {
    const largeId = BigInt(emailVector("large_id"));
    for (const [name, origin, status, closedLedger, burnedBond] of [
      ["inclusion_open", "inclusion", "Open", 0, 0n],
      ["email_open", "email", "Open", 0, 0n],
      ["email_answered", "email", "Answered", 51_941, 0n],
      ["email_omission", "email", "OmissionProven", 51_941, 100_000_000n],
    ] as const) {
      const dispute = decodeDispute(decodedEmailVector(name));
      expect(dispute).toMatchObject({
        targetId: largeId + 1n, identifier: 7n, status, closedLedger, burnedBond,
        origin: origin === "inclusion"
          ? { kind: "inclusion", attestationId: largeId }
          : { kind: "email", keyId: largeId },
      });
    }
    const key = decodedEmailVector("dkim_key");
    if (!isRecord(key) || !isRecord(key["key"])) {
      throw new Error("the DKIM key vector is not a record");
    }
    expect(key["context_hash"]).toBe(79n);
    expect(key["registered_ledger"]).toBe(100);
    expect(key["key"]["modulus_hash"]).toBe(71n);
    expect(key["key"]["redc_hash"]).toBe(73n);
  });
  it("decodes the new origin and the historical inclusion shape", async () => {
    const origin = nativeToScVal([
      nativeToScVal("Inclusion", { type: "symbol" }),
      nativeToScVal(1n, { type: "u64" }),
    ]);
    expect(decodeDispute(scValToNative(disputeValue(origin)))).toMatchObject({
      origin: { kind: "inclusion", attestationId: 1n }, targetId: 2n, identifier: 7n, status: "Open",
    });
    expect(decodeDispute(scValToNative(disputeValue(undefined)))).toMatchObject({
      origin: { kind: "inclusion", attestationId: 1n },
    });
    const { server, calls } = serverFor(disputeValue(origin));
    await expect(readStoredDispute(NETWORK, REGISTRY, ASSET, 2n, 7n, { server })).resolves.toMatchObject({
      targetId: 2n, identifier: 7n,
    });
    expect(calls).toEqual([{ method: "get_dispute", args: [ASSET, 2n, 7n] }]);
  });

  it("returns absence only for the fixed missing-dispute code", async () => {
    await expect(readStoredDispute(NETWORK, REGISTRY, ASSET, 2n, 7n, {
      server: serverFor("Error(Contract, #27)").server,
    })).resolves.toBeUndefined();
    await expect(readStoredDispute(NETWORK, REGISTRY, ASSET, 2n, 7n, {
      server: serverFor("Error(Contract, #21)").server,
    })).rejects.toThrow(RegistryRefusedError);
    await expect(readStoredDispute(NETWORK, REGISTRY, ASSET, 2n, 7n, {
      server: serverFor(new Error("archive unavailable")).server,
    })).rejects.toThrow(InfrastructureError);
  });

  it("rejects an unknown origin instead of treating it as inclusion", () => {
    const origin = nativeToScVal([
      nativeToScVal("Future", { type: "symbol" }),
      nativeToScVal(1n, { type: "u64" }),
    ]);
    expect(() => decodeDispute(scValToNative(disputeValue(origin)))).toThrow("not supported");
  });
});

describe("dispute submissions", () => {
  const input = {
    sourceAccount: new Account(SIGNER.publicKey(), "4"),
    sourceSigner: SIGNER,
    registry: REGISTRY,
    asset: ASSET,
  };

  it("encodes both opening variants exactly as the contract does", async () => {
    const largeId = BigInt(emailVector("large_id"));
    vi.spyOn(registration, "sendAndSettle").mockResolvedValue({ transactionHash: "a".repeat(64), ledger: 501 });
    const { server, rawCalls } = serverFor(nativeToScVal(null));
    await openDispute(server, NETWORK, {
      ...input,
      targetId: largeId + 1n,
      opening: {
        kind: "inclusion", attestationId: largeId,
        inclusion: { id: 7n, commitment: 11n, path: [13n], position: 0 },
      },
    });
    await openDispute(server, NETWORK, {
      ...input,
      targetId: largeId + 1n,
      opening: { kind: "email", keyId: largeId, id: 7n, proof: Uint8Array.from([1, 2, 3]) },
    });
    expect(rawCalls[0]?.[3]?.toXDR("base64")).toBe(emailVector("inclusion_argument"));
    expect(rawCalls[1]?.[3]?.toXDR("base64")).toBe(emailVector("email_argument"));
  });

  it("encodes a fixed inclusion opening and persists the hash before send", async () => {
    const steps: string[] = [];
    const send = vi.spyOn(registration, "sendAndSettle").mockImplementation(async () => {
      steps.push("send");
      return { transactionHash: "a".repeat(64), ledger: 501 };
    });
    const { server, calls } = serverFor(nativeToScVal(0n, { type: "u64" }));
    await openDispute(server, NETWORK, {
      ...input,
      targetId: 2n,
      opening: { kind: "inclusion", attestationId: 1n, inclusion: EVIDENCE },
      beforeSend: async (hash) => {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        steps.push("journal");
      },
    });
    expect(steps).toEqual(["journal", "send"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{
      method: "open_dispute",
      args: [ASSET, SIGNER.publicKey(), 2n, ["Inclusion", {
        attestation_id: 1n, inclusion: { id: 7n, commitment: 13n, path: [17n, 19n], position: 2 },
      }]],
    }]);
  });

  it("keeps the answer and permissionless resolution on their fixed targets", async () => {
    vi.spyOn(registration, "sendAndSettle").mockResolvedValue({ transactionHash: "b".repeat(64), ledger: 502 });
    const { server, calls } = serverFor(nativeToScVal(null));
    await answerDispute(server, NETWORK, { ...input, targetId: 2n, evidence: EVIDENCE });
    await resolveDispute(server, NETWORK, { ...input, targetId: 2n, identifier: 7n });
    expect(calls).toEqual([
      { method: "answer_dispute", args: [ASSET, 2n, { id: 7n, commitment: 13n, path: [17n, 19n], position: 2 }] },
      { method: "resolve_dispute", args: [ASSET, 2n, 7n] },
    ]);
  });

  it("refuses a different source signer before simulation", async () => {
    const { server, calls } = serverFor(nativeToScVal(null));
    await expect(resolveDispute(server, NETWORK, {
      ...input,
      sourceAccount: new Account(Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12)).publicKey(), "4"),
      targetId: 2n,
      identifier: 7n,
    })).rejects.toThrow(DisputeInputError);
    expect(calls).toHaveLength(0);
  });

  it("parses only public answer evidence", () => {
    const artifact = JSON.stringify({ id: toHex(7n), commitment: toHex(13n), position: 2, path: [toHex(17n)] });
    expect(parseInclusionEvidence(artifact)).toEqual({ id: 7n, commitment: 13n, position: 2, path: [17n] });
    expect(() => parseInclusionEvidence(JSON.stringify({
      id: toHex(7n), commitment: toHex(13n), position: 2, path: [toHex(17n)], balance: "2",
    }))).toThrow(DisputeInputError);
  });
});
