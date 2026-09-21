/**
 * What the history read reports when the endpoint stops before the end of the
 * range.
 *
 * The endpoint reads a bounded count of ledgers for one request. It answers a
 * wider range with an empty page and a cursor at the ledger where it stopped,
 * and the caller reaches the rest with that cursor. A read that treats the
 * empty page as the end of the range reports an asset that has attestations as
 * an asset that has none, which is the one answer this file guards against.
 *
 * The pages here carry the shape that the public test endpoint returned. A
 * request that started 17,288 ledgers back answered with no event and a cursor
 * about 10,000 ledgers later, and a second request from that cursor answered
 * with every event of the range.
 */

import { describe, expect, it } from "vitest";
import { Contract, Networks, SorobanDataBuilder, rpc, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  ATTESTATION_EVENT_TOPIC,
  RegistryRefusedError,
  readAttestationHistory,
  readStoredAttestation,
  readStoredAttestationHistory,
} from "../src/registry.js";
import { HISTORY_PAGE_LIMIT, MAX_U64 } from "../src/constants.js";
import { InfrastructureError } from "../src/network.js";
import { balanceCommitment, leafHash } from "../src/hashes.js";
import { rootFromPath } from "../src/tree.js";
import { toHex } from "../src/fr.js";
import { verifyInclusion } from "../src/inclusion.js";

const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const OLDEST = 4_141_385;
const LATEST = 4_262_344;
const NETWORK = {
  network: "testnet",
  rpcUrl: "http://127.0.0.1:1",
  networkPassphrase: Networks.TESTNET,
  allowHttp: true,
};

function storedValue(root: bigint): xdr.ScVal {
  return nativeToScVal(
    {
      context_hash: 3n,
      final_root: root,
      total_liabilities: 900n,
      snapshot_ledger: OLDEST - 100,
      reserve_sum: 1_400n,
      attested_ledger: OLDEST - 50,
    },
    {
      type: {
        context_hash: ["symbol", "u256"],
        final_root: ["symbol", "u256"],
        total_liabilities: ["symbol", "u128"],
        snapshot_ledger: ["symbol", "u32"],
        reserve_sum: ["symbol", "u128"],
        attested_ledger: ["symbol", "u32"],
      },
    },
  );
}

function storedClient(responses: readonly (xdr.ScVal | string | Error)[]): {
  server: rpc.Server;
  requests: { method: string; args: unknown[] }[];
} {
  const server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: true });
  const requests: { method: string; args: unknown[] }[] = [];
  server.getHealth = async () => {
    throw new Error("persistent history must not depend on event retention");
  };
  server.getEvents = async () => {
    throw new Error("persistent history must not query events");
  };
  server.simulateTransaction = async (transaction): Promise<rpc.Api.SimulateTransactionResponse> => {
    const operation = transaction.toEnvelope().v1().tx().operations()[0];
    if (operation === undefined) {
      throw new Error("the read holds no operation");
    }
    const call = operation.body().invokeHostFunctionOp().hostFunction().invokeContract();
    requests.push({
      method: call.functionName().toString(),
      args: call.args().map((value): unknown => scValToNative(value)),
    });
    const response = responses[requests.length - 1];
    if (response === undefined) {
      throw new Error("the test holds no response for this read");
    }
    if (response instanceof Error) {
      throw response;
    }
    const base = { id: "1", latestLedger: LATEST, events: [], _parsed: true };
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
  return { server, requests };
}

/** The cursor that names one ledger, in the form the endpoint returns. */
function cursorAt(ledger: number): string {
  return `${(BigInt(ledger) << 32n).toString(10)}-4294967295`;
}

/** One attestation event of the asset, as the endpoint returns it. */
function attestationEvent(ledger: number): rpc.Api.EventResponse {
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-08-20T00:00:00Z",
    contractId: new Contract(REGISTRY),
    id: `${ledger}-0`,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: "b".repeat(64),
    topic: [
      xdr.ScVal.scvSymbol(ATTESTATION_EVENT_TOPIC),
      nativeToScVal(ASSET, { type: "address" }),
    ],
    value: nativeToScVal(
      {
        final_root: 7n,
        total_liabilities: 900n,
        snapshot_ledger: ledger - 40,
        reserve_sum: 1_400n,
        attested_ledger: ledger,
      },
      {
        type: {
          final_root: ["symbol", "u256"],
          total_liabilities: ["symbol", "i128"],
          snapshot_ledger: ["symbol", "u32"],
          reserve_sum: ["symbol", "i128"],
          attested_ledger: ["symbol", "u32"],
        },
      },
    ),
  };
}

/**
 * A client that answers with the given pages and records what it was asked.
 *
 * The test replaces the two methods of a real client rather than building an
 * object of its type, so the answers keep the shape the library declares.
 */
function clientOf(pages: readonly rpc.Api.GetEventsResponse[]): {
  server: rpc.Server;
  requests: unknown[];
} {
  const server = new rpc.Server("http://127.0.0.1:1", { allowHttp: true });
  const requests: unknown[] = [];
  server.getHealth = async (): Promise<rpc.Api.GetHealthResponse> => ({
    status: "healthy",
    latestLedger: LATEST,
    oldestLedger: OLDEST,
    ledgerRetentionWindow: 120_960,
  });
  server.getEvents = async (request: rpc.Server.GetEventsRequest) => {
    requests.push(request);
    const page = pages[requests.length - 1];
    if (page === undefined) {
      throw new Error(`the read asked for page ${requests.length}, and the test holds no such page`);
    }
    return page;
  };
  return { server, requests };
}

/** One page of the endpoint. */
function page(
  events: readonly rpc.Api.EventResponse[],
  stoppedAt: number,
): rpc.Api.GetEventsResponse {
  return {
    latestLedger: LATEST,
    oldestLedger: OLDEST,
    events: [...events],
    cursor: cursorAt(stoppedAt),
    latestLedgerCloseTime: "0",
    oldestLedgerCloseTime: "0",
  };
}

describe("a history read of a range that one request cannot cover", () => {
  it("follows the cursor and finds the attestations that the first page missed", async () => {
    const found = attestationEvent(LATEST - 200);
    const { server, requests } = clientOf([
      page([], LATEST - 7_289),
      page([found], LATEST),
    ]);

    const history = await readAttestationHistory(server, REGISTRY, ASSET, LATEST - 17_288);

    expect(history.attestations).toHaveLength(1);
    expect(history.attestations[0]?.ledger).toBe(LATEST - 200);
    expect(history.coversTheWholeRange).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("reports that it did not cover the range when the cursor stops short", async () => {
    // The endpoint stops and the caller stops with it, because the test offers
    // no second page. The result must not read as an absence.
    const { server } = clientOf([page([], LATEST - 7_289), page([], LATEST - 7_289)]);

    const history = await readAttestationHistory(server, REGISTRY, ASSET, LATEST - 17_288);

    expect(history.attestations).toHaveLength(0);
    expect(history.coversTheWholeRange).toBe(false);
  });

  it("covers the range when one page reaches the latest ledger", async () => {
    const { server, requests } = clientOf([page([attestationEvent(LATEST - 10)], LATEST)]);

    const history = await readAttestationHistory(server, REGISTRY, ASSET, LATEST - 7_160);

    expect(history.attestations).toHaveLength(1);
    expect(history.coversTheWholeRange).toBe(true);
    expect(requests).toHaveLength(1);
  });
});

describe("the range that a read covers when the caller names no ledger", () => {
  it("starts at the oldest ledger that the endpoint keeps", async () => {
    // The default was a count of ledgers that this project chose, and a reader
    // who did not choose it read one day of a seven day record as the record.
    const { server, requests } = clientOf([page([attestationEvent(OLDEST + 10)], LATEST)]);

    const history = await readAttestationHistory(server, REGISTRY, ASSET);

    expect(requests[0]).toMatchObject({ startLedger: OLDEST });
    expect(history.oldestLedgerCovered).toBe(OLDEST);
    expect(history.reachesTheRetentionLimit).toBe(true);
    expect(history.attestations).toHaveLength(1);
  });

  it("starts where a caller names, when that ledger is inside the window", async () => {
    const { server, requests } = clientOf([page([], LATEST)]);

    const history = await readAttestationHistory(server, REGISTRY, ASSET, LATEST - 7_160);

    expect(requests[0]).toMatchObject({ startLedger: LATEST - 7_160 });
    expect(history.reachesTheRetentionLimit).toBe(false);
  });

  it("starts at the boundary when a caller names a ledger before it", async () => {
    // The endpoint refuses a start before the window it keeps, so the read
    // clamps rather than sending a request that the endpoint rejects.
    const { server, requests } = clientOf([page([], LATEST)]);

    await readAttestationHistory(server, REGISTRY, ASSET, OLDEST - 50_000);

    expect(requests[0]).toMatchObject({ startLedger: OLDEST });
  });
});

describe("persistent attestation history", () => {
  it("verifies an old package without consulting the current asset entry", async () => {
    const commitment = balanceCommitment({ balance: 900n, salt: 2n });
    const siblings = [9n];
    const root = rootFromPath({
      leaf: leafHash({ id: 7n, commitment }), leafIndex: 0, siblings, depth: 1,
    });
    const { server, requests } = storedClient([storedValue(root)]);
    server.getHealth = async () => ({
      status: "healthy", latestLedger: LATEST, oldestLedger: OLDEST,
      ledgerRetentionWindow: LATEST - OLDEST + 1,
    });
    const verdict = await verifyInclusion({
      packageText: JSON.stringify({
        format: "zkpor-inclusion/2", network: NETWORK.network,
        registry: REGISTRY, asset: ASSET, snapshot_ledger: OLDEST - 100,
        context_hash: toHex(3n), attestation_id: "4", leaf_index: 0,
        id: toHex(7n), commitment: toHex(commitment), balance: "900", salt: toHex(2n),
        siblings: siblings.map(toHex),
      }),
      deploymentsText: JSON.stringify([{
        network: NETWORK.network, registry: REGISTRY, verifier: REGISTRY,
        aggregator_key_sha256: "aa", tree_depth: 1,
        registry_wasm_sha256: "a1", verifier_wasm_sha256: "b2",
      }]),
      server, config: NETWORK, readOptions: {},
    });
    expect(verdict).toMatchObject({ kind: "included", snapshotLedger: OLDEST - 100 });
    expect(requests).toEqual([{ method: "get_attestation", args: [ASSET, 4n] }]);
  });

  it("reads the fixed identifier even after its event leaves the retained window", async () => {
    const { server, requests } = storedClient([storedValue(17n)]);
    const record = await readStoredAttestation(NETWORK, REGISTRY, ASSET, 4n, { server });
    expect(record).toMatchObject({
      attestationId: 4n,
      contextHash: 3n,
      finalRoot: 17n,
      attestedLedger: OLDEST - 50,
    });
    expect(requests).toEqual([{ method: "get_attestation", args: [ASSET, 4n] }]);
  });

  it.each([7, 21])("reports verified missing contract code %s as no record", async (code) => {
    const { server } = storedClient([`Error(Contract, #${code})`]);
    await expect(readStoredAttestation(NETWORK, REGISTRY, ASSET, 1n, { server })).resolves.toBeUndefined();
  });

  it.each([
    "Error(Contract, #16)",
    "Error(WasmVm, MissingValue)",
    new Error("the endpoint is unreachable"),
  ])("preserves a refusal or infrastructure failure", async (response) => {
    const { server } = storedClient([response]);
    const expected = response === "Error(Contract, #16)" ? RegistryRefusedError : InfrastructureError;
    await expect(readStoredAttestation(NETWORK, REGISTRY, ASSET, 1n, { server })).rejects.toBeInstanceOf(expected);
  });

  it("rejects a legacy attestation without the historical context", async () => {
    const { server } = storedClient([attestationEvent(LATEST).value]);
    await expect(readStoredAttestation(NETWORK, REGISTRY, ASSET, 1n, { server })).rejects.toThrow("context_hash");
  });

  it.each([0n, -1n, MAX_U64 + 1n])("rejects an invalid identifier %s before a call", async (id) => {
    const { server, requests } = storedClient([]);
    await expect(readStoredAttestation(NETWORK, REGISTRY, ASSET, id, { server })).rejects.toBeInstanceOf(RangeError);
    expect(requests).toHaveLength(0);
  });

  it("keeps records from one ledger separate and fixes the count before the reads", async () => {
    const { server, requests } = storedClient([
      nativeToScVal(3n, { type: "u64" }),
      storedValue(17n),
      storedValue(19n),
    ]);
    const history = await readStoredAttestationHistory(NETWORK, REGISTRY, ASSET, {
      startId: 2n, count: 5, server,
    });
    expect(history.attestations.map((entry) => entry.attestationId)).toEqual([2n, 3n]);
    expect(history.attestations.map((entry) => entry.finalRoot)).toEqual([17n, 19n]);
    expect(history.totalCount).toBe(3n);
    expect(history.nextId).toBeUndefined();
    expect(requests.map((entry) => entry.method)).toEqual([
      "attestation_count", "get_attestation", "get_attestation",
    ]);
  });

  it("returns the next identifier after a bounded page", async () => {
    const { server } = storedClient([nativeToScVal(5n, { type: "u64" }), storedValue(17n)]);
    const history = await readStoredAttestationHistory(NETWORK, REGISTRY, ASSET, {
      startId: 2n, count: 1, server,
    });
    expect(history.nextId).toBe(3n);
    expect(history.totalCount).toBe(5n);
  });

  it("returns an empty page beyond the stored count", async () => {
    const { server, requests } = storedClient([nativeToScVal(1n, { type: "u64" })]);
    const history = await readStoredAttestationHistory(NETWORK, REGISTRY, ASSET, {
      startId: 2n, count: 1, server,
    });
    expect(history.attestations).toEqual([]);
    expect(history.nextId).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("does not silently skip a missing record inside the stored count", async () => {
    const { server } = storedClient([nativeToScVal(1n, { type: "u64" }), "Error(Contract, #21)"]);
    await expect(readStoredAttestationHistory(NETWORK, REGISTRY, ASSET, {
      startId: 1n, count: 1, server,
    })).rejects.toThrow("missing record 1");
  });

  it.each([0, -1, 1.5, HISTORY_PAGE_LIMIT + 1])("rejects unbounded page count %s", async (count) => {
    const { server, requests } = storedClient([]);
    await expect(readStoredAttestationHistory(NETWORK, REGISTRY, ASSET, {
      startId: 1n, count, server,
    })).rejects.toBeInstanceOf(RangeError);
    expect(requests).toHaveLength(0);
  });
});
