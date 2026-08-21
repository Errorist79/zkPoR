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
  currentGeneration,
  defaultHistoryStart,
  diagnoseReserves,
  latestLedger,
  observeReserves,
  readAssetRecord,
  readAttestationHistory,
} from "@zkpor/sdk";
import type { NetworkConfig, ReadOptions, openServer } from "@zkpor/sdk";
import { attestedReserves, coverageOf, observedReserves, solvencyResult } from "./model.js";
import type { AssetView, HistoryView } from "./model.js";

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
  readonly registry: string;
  /** The text of the deployments file that this process trusts. */
  readonly deploymentsText: string;
}

/** The registry of the current generation of the configured network. */
export function registryOfGeneration(deploymentsText: string, network: string): string {
  const generation = currentGeneration(deploymentsText, network);
  if (generation === undefined) {
    throw new InfrastructureError(
      `the deployments file records no generation on the network ${network}`,
    );
  }
  return generation.registry;
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
): Promise<AssetView | undefined> {
  const record = await readAssetRecord(
    reader.server,
    reader.config,
    reader.readOptions,
    reader.registry,
    asset,
  );
  if (record === undefined) {
    return undefined;
  }
  const currentLedger = await latestLedger(reader.server);

  let observed;
  let observationFailure;
  let diagnosis;
  try {
    observed = observedReserves(
      await observeReserves(
        reader.server,
        reader.config,
        reader.readOptions,
        reader.registry,
        asset,
      ),
    );
  } catch (cause) {
    if (!(cause instanceof RegistryRefusedError) && !(cause instanceof InfrastructureError)) {
      throw cause;
    }
    observationFailure = cause.message;
    diagnosis = await diagnoseReserves(reader.server, reader.config, reader.readOptions, {
      asset,
      reserves: record.reserves,
    });
  }

  return {
    asset,
    network: reader.config.network,
    registry: reader.registry,
    record,
    solvency:
      record.attestation === undefined
        ? undefined
        : solvencyResult(record.attestation, currentLedger),
    observed,
    observationFailure,
    diagnosis,
    currentLedger,
  };
}

/**
 * The earlier attestations of one asset.
 *
 * The query reaches back over the same ledger count as the command line, so the
 * two views of one asset cover the same range.
 */
export async function readHistoryView(reader: Reader, asset: string): Promise<HistoryView> {
  const history = await readAttestationHistory(
    reader.server,
    reader.registry,
    asset,
    defaultHistoryStart(await latestLedger(reader.server)),
  );
  return {
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
}
