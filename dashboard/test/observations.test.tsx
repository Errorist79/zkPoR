import { Networks, SorobanDataBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { openServer } from "@zkpor/sdk";
import type { StoredReserveObservation } from "@zkpor/sdk";
import { assetRecordXdr } from "../../sdk/replay/endpoint.js";
import { readAssetView } from "../src/chain.js";
import type { Reader } from "../src/chain.js";
import { SECTION_IDS } from "../src/constants.js";
import { SILENT_LOG } from "../src/log.js";
import { AssetPage } from "../src/views/asset.js";
import { AUTHORITY, REGISTRY, assetView, framed, sectionOf, textOf } from "./support.js";

const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";

const FIRST_LOW: StoredReserveObservation = {
  observationId: 1n, observedSum: 1_200n, observedLedger: 5_100,
  reserveSetHash: 1n, attestationId: 1n, belowAttested: true,
};
const RECOVERED: StoredReserveObservation = {
  observationId: 3n, observedSum: 2_500n, observedLedger: 5_200,
  reserveSetHash: 2n, attestationId: 2n, belowAttested: false,
};

function observationValue(value: StoredReserveObservation): xdr.ScVal {
  return nativeToScVal({
    observation_id: value.observationId, observed_sum: value.observedSum,
    observed_ledger: value.observedLedger, reserve_set_hash: value.reserveSetHash,
    attestation_id: value.attestationId ?? null, below_attested: value.belowAttested,
  }, { type: {
    observation_id: ["symbol", "u64"], observed_sum: ["symbol", "i128"],
    observed_ledger: ["symbol", "u32"], reserve_set_hash: ["symbol", "u256"],
    attestation_id: ["symbol", "u64"], below_attested: ["symbol", null],
  } });
}

function readerFor(input: {
  live?: "legacy" | "failed";
  statusFailure?: string | Error;
  omitFirstLow?: boolean;
} = {}): { reader: Reader; calls: { method: string; args: unknown[] }[] } {
  const config = {
    network: "testnet", rpcUrl: "http://127.0.0.1:1", networkPassphrase: Networks.TESTNET, allowHttp: true,
  };
  const server = openServer(config);
  const calls: { method: string; args: unknown[] }[] = [];
  server.getHealth = async () => ({
    status: "healthy", latestLedger: 5_300, oldestLedger: 1, ledgerRetentionWindow: 5_300,
  });
  server.simulateTransaction = async (transaction): Promise<rpc.Api.SimulateTransactionResponse> => {
    const operation = transaction.toEnvelope().v1().tx().operations()[0];
    if (operation === undefined) {
      throw new Error("the read contains no operation");
    }
    const invocation = operation.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const method = invocation.functionName().toString();
    const args: unknown[] = invocation.args().map((value): unknown => scValToNative(value));
    calls.push({ method, args });
    let value: xdr.ScVal;
    const base = { id: "1", latestLedger: 5_300, events: [], _parsed: true };
    if (method === "entry") {
      value = xdr.ScVal.fromXDR(assetRecordXdr({
        authority: AUTHORITY, reserves: [AUTHORITY],
        attestation: { finalRoot: 2n, totalLiabilities: 1_000n, snapshotLedger: 5_000, reserveSum: 1_500n, attestedLedger: 5_100 },
      }), "base64");
    } else if (method === "observe_reserves") {
      if (input.live === "failed") {
        return { ...base, error: "Error(Contract, #17)" };
      }
      value = input.live === "legacy"
        ? nativeToScVal({ observed_sum: 9_999n, observed_ledger: 5_300 }, {
          type: { observed_sum: ["symbol", "i128"], observed_ledger: ["symbol", "u32"] },
        })
        : observationValue({ ...RECOVERED, observationId: 4n, observedSum: 9_999n, observedLedger: 5_300 });
    } else if (method === "observation_status") {
      if (input.statusFailure instanceof Error) {
        throw input.statusFailure;
      }
      if (input.statusFailure !== undefined) {
        return { ...base, error: input.statusFailure };
      }
      value = nativeToScVal({ observation_count: 3n, first_low_observation: 1n }, { type: {
        observation_count: ["symbol", "u64"], first_low_observation: ["symbol", "u64"],
      } });
    } else if (method === "get_observation") {
      if (args[1] === 1n && input.omitFirstLow) {
        return { ...base, error: "Error(Contract, #34)" };
      }
      value = observationValue(args[1] === 1n ? FIRST_LOW : RECOVERED);
    } else if (method === "balance") {
      value = nativeToScVal(9_999n, { type: "i128" });
    } else {
      throw new Error(`unexpected read ${method}`);
    }
    return { ...base, transactionData: new SorobanDataBuilder(), minResourceFee: "0", result: { auth: [], retval: value } };
  };
  return {
    calls,
    reader: {
      server, config, readOptions: {}, log: SILENT_LOG,
      deploymentsText: JSON.stringify([{
        network: "testnet", registry: REGISTRY, verifier: REGISTRY, tree_depth: 12,
        aggregator_key_sha256: "a".repeat(64), registry_wasm_sha256: "b".repeat(64), verifier_wasm_sha256: "c".repeat(64),
      }]),
    },
  };
}

async function pageFor(input: Parameters<typeof readerFor>[0] = {}) {
  const { reader, calls } = readerFor(input);
  const { view } = await readAssetView(reader, ASSET);
  if (view === undefined) {
    throw new Error("the test asset was not found");
  }
  return { view, calls, markup: framed(<AssetPage view={view} history={undefined} />) };
}

describe("recorded observations on the asset page", () => {
  it("keeps a historic low after recovery and a changed attestation or reserve set", async () => {
    const { view, calls, markup } = await pageFor();
    expect(view.recordedObservations).toEqual({
      kind: "available", status: { observationCount: 3n, firstLowObservation: 1n },
      latest: RECOVERED, firstLow: FIRST_LOW,
    });
    expect(calls.filter((call) => call.method === "get_observation").map((call) => call.args[1])).toEqual([3n, 1n]);
    const recorded = textOf(sectionOf(markup, SECTION_IDS.recordedObservations));
    const live = textOf(sectionOf(markup, SECTION_IDS.observedReserves));
    expect(recorded).toContain("Permanent first-low observation");
    expect(recorded).toContain("below the referenced attested reserve sum");
    expect(recorded).toContain("does not establish insolvency");
    expect(recorded).not.toContain("9,999");
    expect(live).toContain("creates no stored observation");
    expect(live).not.toContain("Permanent first-low");
  });

  it("shows the permanent low even when the live reserve call fails", async () => {
    const { markup } = await pageFor({ live: "failed" });
    expect(textOf(sectionOf(markup, SECTION_IDS.recordedObservations))).toContain("Permanent first-low observation");
    expect(textOf(sectionOf(markup, SECTION_IDS.observedReserves))).toContain("gave no observed sum");
  });

  it("marks a verified legacy ABI as unavailable without calling new methods", async () => {
    const { calls, markup } = await pageFor({ live: "legacy" });
    expect(calls.map((call) => call.method)).toEqual(["entry", "observe_reserves"]);
    const shown = textOf(sectionOf(markup, SECTION_IDS.recordedObservations));
    expect(shown).toContain("does not support recorded observations");
    expect(shown).not.toContain("No stored observation");
  });

  it.each([new Error("RPC disconnected"), "restore archived state", "unknown function observation_status"])(
    "shows a status failure instead of a clean status: %s", async (statusFailure) => {
      const { markup } = await pageFor({ statusFailure });
      const shown = textOf(sectionOf(markup, SECTION_IDS.recordedObservations));
      expect(shown).toContain("recorded status could not be read");
      expect(shown).not.toContain("No stored observation");
      expect(shown).not.toContain("does not support recorded observations");
    },
  );

  it("does not hide a first-low marker whose record could not be read", async () => {
    const { markup } = await pageFor({ omitFirstLow: true });
    const shown = textOf(sectionOf(markup, SECTION_IDS.recordedObservations));
    expect(shown).toContain("missing record 1");
    expect(shown).toContain("Permanent first-low marker: observation 1");
    expect(shown).not.toContain("No stored observation");
  });

  it("states that an observation with no baseline made no comparison", () => {
    const view = assetView({ recordedObservations: {
      kind: "available", status: { observationCount: 1n, firstLowObservation: undefined },
      latest: { ...FIRST_LOW, attestationId: undefined, belowAttested: false }, firstLow: undefined,
    } });
    const markup = framed(<AssetPage view={view} history={undefined} />);
    const shown = textOf(sectionOf(markup, SECTION_IDS.recordedObservations));
    expect(shown).toContain("had no baseline attestation");
    expect(shown).toContain("No comparison with attested reserves was made");
    expect(shown).toContain("does not establish continuous reserve coverage");
  });
});
