/**
 * The reads that fill a page.
 *
 * Every value comes from the kit. This module computes no hash, no root, and no
 * encoding of its own, because the shared Rust crate is the definition and the
 * kit is the mirror that the committed vectors pin. A third reader of the chain
 * would be a fourth implementation that nobody checks.
 */

import {
  InfrastructureError,
  RegistryRefusedError,
  diagnoseReserves,
  latestLedger,
  observeReserves,
  readAttestationHistory,
  readObservationStatus,
  readStoredObservation,
} from "@zkpor/sdk";
import type { NetworkConfig, ReadOptions, openServer } from "@zkpor/sdk";
import { attestedReserves, coverageOf, observedReserves, solvencyResult } from "./model.js";
import type { AssetView, HistoryView, RecordedObservationView } from "./model.js";
import type { Log } from "./log.js";
import { generationsNewestFirst, locateAsset } from "@zkpor/sdk";

/**
 * The client of the endpoint, as the kit builds it.
 *
 * The type follows the return of the kit rather than a second import of the
 * Stellar library, so this package cannot end up on a different version of it.
 */
export type Server = ReturnType<typeof openServer>;

/** Everything one dashboard process needs to read the chain. */
export interface Reader {
  readonly server: Server;
  readonly config: NetworkConfig;
  readonly readOptions: ReadOptions;
  /** The text of the deployments file that this process trusts. */
  readonly deploymentsText: string;
  /** The record of what each read cost, and of the reads that failed. */
  readonly log: Log;
}


/** The message of a failure, from a value that a caller raised. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "a failure that names no reason";
}

/**
 * One read of the chain, with what it cost.
 *
 * The duration is how an operator separates a slow endpoint from a stuck one,
 * and the failure line is the only record of a read that reached no page.
 */
async function timed<T>(
  reader: Reader,
  call: string,
  registry: string | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const answer = await read();
    reader.log({ event: "chain.read", call, registry, ms: Date.now() - started });
    return answer;
  } catch (cause) {
    reader.log({
      event: "chain.failed",
      call,
      registry,
      error: messageOf(cause),
      ms: Date.now() - started,
    });
    throw cause;
  }
}

/**
 * The view of one asset, or nothing when the registry holds no record of it.
 *
 * The observation runs on its own path. A failed balance read fails the whole
 * observation and names no address, so the diagnosis runs after that failure
 * and names the address that the registry cannot read.
 */
export async function readAssetView(
  reader: Reader,
  asset: string,
): Promise<{ view: AssetView | undefined; asked: readonly string[] }> {
  // One resolution for this request. Every read below uses the generation it
  // found, so a page cannot answer about two of them and say nothing about it.
  const located = await timed(reader, "locate_asset", undefined, () =>
    locateAsset({
      server: reader.server,
      config: reader.config,
      options: reader.readOptions,
      deploymentsText: reader.deploymentsText,
      asset,
    }),
  );
  const asked = located.asked.map((generation) => generation.registry);
  if (located.holder === undefined) {
    return { view: undefined, asked };
  }
  const registry = located.holder.generation.registry;
  const record = located.holder.record;
  const currentLedger = await timed(reader, "latest_ledger", undefined, () =>
    latestLedger(reader.server),
  );

  let observed;
  let supportsRecordedObservations;
  let observationFailure;
  let diagnosis;
  try {
    const live = await timed(reader, "observe_reserves", registry, () =>
      observeReserves(reader.server, reader.config, reader.readOptions, registry, asset),
    );
    observed = observedReserves(live);
    supportsRecordedObservations = live.supportsRecordedObservations;
  } catch (cause) {
    if (!(cause instanceof RegistryRefusedError) && !(cause instanceof InfrastructureError)) {
      throw cause;
    }
    observationFailure = cause.message;
    diagnosis = await timed(reader, "diagnose_reserves", registry, () =>
      diagnoseReserves(reader.server, reader.config, reader.readOptions, {
        asset,
        reserves: record.reserves,
      }),
    );
  }

  const view: AssetView = {
    asset,
    asked,
    network: reader.config.network,
    registry,
    record,
    solvency:
      record.attestation === undefined
        ? undefined
        : solvencyResult(record.attestation, currentLedger),
    observed,
    observationFailure,
    recordedObservations: supportsRecordedObservations === false
      ? { kind: "unsupported" }
      : await readRecordedObservations(reader, registry, asset),
    diagnosis,
    currentLedger,
  };
  return { view, asked };
}

async function readRecordedObservations(
  reader: Reader,
  registry: string,
  asset: string,
): Promise<RecordedObservationView> {
  const options = { ...reader.readOptions, server: reader.server };
  let firstLowId: bigint | undefined;
  try {
    const status = await timed(reader, "observation_status", registry, () =>
      readObservationStatus(reader.config, registry, asset, options),
    );
    if (status === undefined) {
      throw new InfrastructureError("the asset disappeared before its observation status read");
    }
    firstLowId = status.firstLowObservation;
    const read = async (id: bigint) => {
      const observation = await timed(reader, "get_observation", registry, () =>
        readStoredObservation(reader.config, registry, asset, id, options),
      );
      if (observation === undefined) {
        throw new InfrastructureError(`the observation status names the missing record ${id}`);
      }
      return observation;
    };
    const latest = status.observationCount === 0n ? undefined : await read(status.observationCount);
    const firstLow = status.firstLowObservation === undefined
      ? undefined
      : status.firstLowObservation === latest?.observationId
        ? latest
        : await read(status.firstLowObservation);
    if (firstLow !== undefined && !firstLow.belowAttested) {
      throw new InfrastructureError("the first-low marker names an observation that is not low");
    }
    return { kind: "available", status, latest, firstLow };
  } catch (cause) {
    if (!(cause instanceof RegistryRefusedError) && !(cause instanceof InfrastructureError)) {
      throw cause;
    }
    return { kind: "failed", reason: cause.message, firstLowId };
  }
}

/**
 * The earlier attestations of one asset.
 *
 * The query names no ledger, so it reads the whole window that the endpoint
 * keeps, which is the same range the command line reads.
 *
 * The generations are read concurrently because their reads are independent.
 */
export async function readHistoryView(reader: Reader, asset: string): Promise<HistoryView> {
  const generations = generationsNewestFirst(reader.deploymentsText, reader.config.network);
  const blocks = await Promise.all(
    generations.map(async (generation) => {
      const history = await timed(reader, "attestation_history", generation.registry, () =>
        readAttestationHistory(reader.server, generation.registry, asset),
      );
      return {
        registry: generation.registry,
        entries: history.attestations.map((event) => ({
          snapshotLedger: event.snapshotLedger,
          totalLiabilities: event.totalLiabilities,
          attested: attestedReserves(event),
          coverage: coverageOf(event),
          transactionHash: event.transactionHash,
        })),
        oldestLedgerCovered: history.oldestLedgerCovered,
        oldestLedgerRetained: history.oldestLedgerRetained,
        latestLedger: history.latestLedger,
        reachesTheRetentionLimit: history.reachesTheRetentionLimit,
        coversTheWholeRange: history.coversTheWholeRange,
      };
    }),
  );
  return { blocks };
}
