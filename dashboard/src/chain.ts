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
  defaultHistoryStart,
  diagnoseReserves,
  latestLedger,
  observeReserves,
  readAttestationHistory,
} from "@zkpor/sdk";
import type { NetworkConfig, ReadOptions, openServer } from "@zkpor/sdk";
import { attestedReserves, coverageOf, observedReserves, solvencyResult } from "./model.js";
import type { AssetView, HistoryView } from "./model.js";
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
  const located = await locateAsset({
    server: reader.server,
    config: reader.config,
    options: reader.readOptions,
    deploymentsText: reader.deploymentsText,
    asset,
  });
  const asked = located.asked.map((generation) => generation.registry);
  if (located.holder === undefined) {
    return { view: undefined, asked };
  }
  const registry = located.holder.generation.registry;
  const record = located.holder.record;
  const currentLedger = await latestLedger(reader.server);

  let observed;
  let observationFailure;
  let diagnosis;
  try {
    observed = observedReserves(
      await observeReserves(reader.server, reader.config, reader.readOptions, registry, asset),
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
    diagnosis,
    currentLedger,
  };
  return { view, asked };
}

/**
 * The earlier attestations of one asset.
 *
 * The query reaches back over the same ledger count as the command line, so the
 * two views of one asset cover the same range.
 */
export async function readHistoryView(reader: Reader, asset: string): Promise<HistoryView> {
  const from = defaultHistoryStart(await latestLedger(reader.server));
  const generations = generationsNewestFirst(reader.deploymentsText, reader.config.network);
  const blocks = [];
  for (const generation of generations) {
    const history = await readAttestationHistory(
      reader.server,
      generation.registry,
      asset,
      from,
    );
    blocks.push({
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
    });
  }
  return { blocks };
}
