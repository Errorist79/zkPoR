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
import { Contract, rpc, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ATTESTATION_EVENT_TOPIC, readAttestationHistory } from "../src/registry.js";

const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const OLDEST = 4_141_385;
const LATEST = 4_262_344;

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
