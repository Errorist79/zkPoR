/**
 * An endpoint that answers a read and records which contract it was asked
 * about.
 *
 * No test could see which generation a read resolves to. The suite ran against
 * an address that answers nothing, so every resolution reached the same
 * failure and the failure named no registry. A resolver that picked the oldest
 * recorded generation instead of the newest passed the whole suite.
 *
 * This endpoint closes that. It speaks the two calls a read makes, it decodes
 * the contract address out of the simulated transaction, and it keeps the
 * addresses in the order it was asked. A test then states which registry the
 * client reached, which is the fact the suite could not observe.
 *
 * It answers a refusal rather than a record. The question here is which
 * contract the client asks, and a refusal carries that answer without this file
 * having to build a registry entry of its own.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/**
 * The entry of one asset, as the registry answers it.
 *
 * A record carries the authority, the tier, the reserve addresses, the hash of
 * that set, and the attestation slot. This builds the smallest record a client
 * accepts, with an empty attestation slot, because the tests here ask which
 * registry answered rather than what it attested.
 */
export function assetRecordXdr(input: {
  authority: string;
  reserves: readonly string[];
}): string {
  const record = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("attestation"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Empty")]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("authority"),
      val: nativeToScVal(Address.fromString(input.authority)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("reserve_set_hash"),
      val: nativeToScVal(1n, { type: "u256" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("reserves"),
      val: xdr.ScVal.scvVec(
        input.reserves.map((address) => nativeToScVal(Address.fromString(address))),
      ),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("tier"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("ClassicIssuer")]),
    }),
  ]);
  return record.toXDR("base64");
}

/** One endpoint, and what it was asked. */
export interface FakeEndpoint {
  /** The address to put in the environment of a run. */
  readonly url: string;
  /** The contract of each simulated call, in the order the endpoint saw them. */
  readonly asked: readonly string[];
  /** The methods the endpoint answered, in order. */
  readonly methods: readonly string[];
  close: () => Promise<void>;
}

/** The ledger that this endpoint reports. The value is test data. */
const LATEST_LEDGER = 4_263_000;

/** The window that this endpoint reports, in ledgers. The value is test data. */
const RETAINED = 120_960;

/**
 * The contract that one simulated transaction invokes.
 *
 * The client sends a transaction envelope as base64. The invocation sits in the
 * first operation, and the address of a contract invocation is a contract
 * address. A value of any other shape is not a call this endpoint can answer,
 * and it returns `undefined` rather than guessing.
 */
function contractOf(envelopeXdr: string): string | undefined {
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  } catch {
    return undefined;
  }
  const operations = envelope.v1().tx().operations();
  const first = operations[0];
  if (first === undefined) {
    return undefined;
  }
  const body = first.body();
  if (body.switch().name !== "invokeHostFunction") {
    return undefined;
  }
  const host = body.invokeHostFunctionOp().hostFunction();
  if (host.switch().name !== "hostFunctionTypeInvokeContract") {
    return undefined;
  }
  return Address.fromScAddress(host.invokeContract().contractAddress()).toString();
}

/**
 * Starts an endpoint on the loopback address, on a port the operating system
 * chooses.
 *
 * `refuseWith` gives the contract error number that a simulated call answers
 * for one contract. A contract that the map does not name answers the fallback,
 * so a test states which generations answer and which do not.
 */
export async function fakeEndpoint(input: {
  /** The contracts that answer with a record, and the record each one holds. */
  holds?: Readonly<Record<string, string>>;
  refuseWith?: Readonly<Record<string, number>>;
  fallback: number;
}): Promise<FakeEndpoint> {
  const asked: string[] = [];
  const methods: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const answer = (result: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (typeof parsed !== "object" || parsed === null || !("method" in parsed)) {
        response.writeHead(400);
        response.end();
        return;
      }
      const method = parsed["method"];
      methods.push(typeof method === "string" ? method : "unknown");
      if (method === "getHealth") {
        answer({
          status: "healthy",
          latestLedger: LATEST_LEDGER,
          oldestLedger: LATEST_LEDGER - RETAINED,
          ledgerRetentionWindow: RETAINED,
        });
        return;
      }
      if (method === "getLatestLedger") {
        answer({ id: "test", protocolVersion: 23, sequence: LATEST_LEDGER });
        return;
      }
      if (method === "getAccount" || method === "getLedgerEntries") {
        answer({ entries: [], latestLedger: LATEST_LEDGER });
        return;
      }
      if (method === "simulateTransaction") {
        const params = "params" in parsed ? parsed["params"] : undefined;
        const envelope =
          typeof params === "object" && params !== null && "transaction" in params
            ? params["transaction"]
            : undefined;
        const contract = typeof envelope === "string" ? contractOf(envelope) : undefined;
        if (contract !== undefined) {
          asked.push(contract);
        }
        const holds = input.holds ?? {};
        const held = contract !== undefined ? holds[contract] : undefined;
        if (held !== undefined) {
          answer({
            latestLedger: LATEST_LEDGER,
            results: [{ xdr: held, auth: [] }],
            transactionData: "",
            minResourceFee: "0",
            events: [],
          });
          return;
        }
        const refusals = input.refuseWith ?? {};
        const code =
          contract !== undefined && contract in refusals ? refusals[contract] : input.fallback;
        answer({
          latestLedger: LATEST_LEDGER,
          error: `HostError: Error(Contract, #${String(code)})`,
          events: [],
        });
        return;
      }
      answer({ latestLedger: LATEST_LEDGER });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the endpoint bound no port");
  }
  return {
    url: `http://127.0.0.1:${String(bound.port)}/`,
    asked,
    methods,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((cause) => {
          if (cause === undefined) {
            resolve();
          } else {
            reject(cause);
          }
        });
      }),
  };
}
