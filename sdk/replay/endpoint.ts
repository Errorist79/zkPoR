/**
 * An endpoint that answers a read from test data, and never from a chain.
 *
 * Synthetic answers test how the client accepts and refuses a package.
 * They do not report what a network holds.
 *
 * The client library reaches this file through no import of its own. It is a
 * separate entry point, `@zkpor/sdk/replay`, so a program gets it only when the
 * program asks for it by that name.
 *
 * Two callers use it, and a third runs the example of the customer check. The
 * endpoint speaks the calls a read makes, it decodes the contract address out
 * of the simulated transaction, and it keeps the addresses in the order it was
 * asked. A reader of a test then states which registry the client reached.
 *
 * That last point is why it exists. No test could see which generation a read
 * resolves to: the suite ran against an address that answers nothing, so every
 * resolution reached the same failure and the failure named no registry. A
 * resolver that picked the oldest test generation instead of the newest
 * passed the whole suite.
 *
 * One rule for every caller. This endpoint answers from the process that
 * started it, so a caller that starts the command line must not wait for it
 * synchronously. A synchronous child stops the event loop, and the answer it
 * waits for cannot come until it ends.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * The entry of one asset, as the registry answers it.
 *
 * A record carries the authority, the tier, the reserve addresses, the hash of
 * that set, and the current attestation slot. A caller that leaves the
 * attestation out gets an empty slot.
 */
/** One entry of a map, which the record and the attestation both build. */
function entry(name: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
}

export function assetRecordXdr(input: {
  authority: string;
  reserves: readonly string[];
  attestation?: {
    finalRoot: bigint;
    totalLiabilities: bigint;
    snapshotLedger: number;
    reserveSum: bigint;
    attestedLedger: number;
  };
}): string {
  const slot =
    input.attestation === undefined
      ? xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Empty")])
      : xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol("Filled"),
          xdr.ScVal.scvMap([
            entry("attested_ledger", nativeToScVal(input.attestation.attestedLedger, { type: "u32" })),
            entry("final_root", nativeToScVal(input.attestation.finalRoot, { type: "u256" })),
            entry("reserve_sum", nativeToScVal(input.attestation.reserveSum, { type: "u128" })),
            entry("snapshot_ledger", nativeToScVal(input.attestation.snapshotLedger, { type: "u32" })),
            entry(
              "total_liabilities",
              nativeToScVal(input.attestation.totalLiabilities, { type: "u128" }),
            ),
          ]),
        ]);
  const record = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("attestation"),
      val: slot,
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

/** One stored attestation, as the registry answers its historical getter. */
export function storedAttestationXdr(input: {
  contextHash: bigint;
  finalRoot: bigint;
  totalLiabilities: bigint;
  snapshotLedger: number;
  reserveSum: bigint;
  attestedLedger: number;
}): string {
  return xdr.ScVal.scvMap([
    entry("attested_ledger", nativeToScVal(input.attestedLedger, { type: "u32" })),
    entry("context_hash", nativeToScVal(input.contextHash, { type: "u256" })),
    entry("final_root", nativeToScVal(input.finalRoot, { type: "u256" })),
    entry("reserve_sum", nativeToScVal(input.reserveSum, { type: "u128" })),
    entry("snapshot_ledger", nativeToScVal(input.snapshotLedger, { type: "u32" })),
    entry("total_liabilities", nativeToScVal(input.totalLiabilities, { type: "u128" })),
  ]).toXDR("base64");
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

/**
 * The ledger that this endpoint reports when a caller names none.
 *
 * A caller that also supplies an attestation should name one, because a current
 * ledger older than the snapshot of that attestation describes a chain that
 * cannot exist, and a reader of the answer sees it.
 */
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
function invocationOf(envelopeXdr: string): {
  contract: string;
  method: string;
  args: readonly unknown[];
} | undefined {
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
  const invocation = host.invokeContract();
  return {
    contract: Address.fromScAddress(invocation.contractAddress()).toString(),
    method: invocation.functionName().toString(),
    args: invocation.args().map((value): unknown => scValToNative(value)),
  };
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
  /** The contracts that answer one exact historical getter call. */
  attestations?: Readonly<Record<string, { asset: string; id: bigint; xdr: string }>>;
  refuseWith?: Readonly<Record<string, number>>;
  fallback: number;
  /** The ledger this endpoint reports as the latest one. */
  latestLedger?: number;
}): Promise<FakeEndpoint> {
  const latestLedger = input.latestLedger ?? LATEST_LEDGER;
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
          latestLedger,
          oldestLedger: latestLedger - RETAINED,
          ledgerRetentionWindow: RETAINED,
        });
        return;
      }
      if (method === "getLatestLedger") {
        answer({ id: "test", protocolVersion: 23, sequence: latestLedger });
        return;
      }
      if (method === "getAccount" || method === "getLedgerEntries") {
        answer({ entries: [], latestLedger });
        return;
      }
      if (method === "simulateTransaction") {
        const params = "params" in parsed ? parsed["params"] : undefined;
        const envelope =
          typeof params === "object" && params !== null && "transaction" in params
            ? params["transaction"]
            : undefined;
        const invocation = typeof envelope === "string" ? invocationOf(envelope) : undefined;
        if (invocation !== undefined) {
          asked.push(invocation.contract);
        }
        let held: string | undefined;
        if (invocation?.method === "get_attestation") {
          const attestation = input.attestations?.[invocation.contract];
          if (
            attestation !== undefined &&
            attestation.asset === invocation.args[0] &&
            attestation.id === invocation.args[1]
          ) {
            held = attestation.xdr;
          }
        } else if (invocation !== undefined) {
          held = input.holds?.[invocation.contract];
        }
        if (held !== undefined) {
          answer({
            latestLedger,
            results: [{ xdr: held, auth: [] }],
            transactionData: "",
            minResourceFee: "0",
            events: [],
          });
          return;
        }
        const refusals = input.refuseWith ?? {};
        const code =
          invocation !== undefined && invocation.contract in refusals
            ? refusals[invocation.contract]
            : input.fallback;
        answer({
          latestLedger,
          error: `HostError: Error(Contract, #${String(code)})`,
          events: [],
        });
        return;
      }
      answer({ latestLedger });
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
