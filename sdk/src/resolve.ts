/**
 * Which recorded generation holds one asset.
 *
 * A registry holds the record of an asset, and a network carries more than one
 * registry over time. An earlier generation keeps the assets that registered
 * under it, and the newest generation holds no record of them, so a client that
 * always read the newest told a reader that a registered asset does not exist.
 *
 * The asset decides the answer. It is an explicit input, and the context hash
 * of an attestation already binds it, so the client asks the deployments file
 * which generations exist and asks each one whether it holds the asset. No
 * setting steers this, because the thing being asked about already names the
 * answer.
 */

import { findGeneration, parseDeployments } from "./deployments.js";
import type { Generation } from "./deployments.js";
import { InfrastructureError } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { readAssetRecord } from "./registry.js";
import type { AssetRecord, ReadOptions } from "./registry.js";
import type { rpc } from "@stellar/stellar-sdk";

/** One generation and the record it holds. */
export interface AssetHolder {
  readonly generation: Generation;
  readonly record: AssetRecord;
}

/** Where an asset lives, and every generation the walk asked. */
export interface AssetLocation {
  /** The generation that holds the asset, or nothing when none holds it. */
  readonly holder: AssetHolder | undefined;
  /** Every generation the walk asked, in the order it asked them. */
  readonly asked: readonly Generation[];
}

/**
 * The generations of one network, newest first.
 *
 * The file states the order and nothing else decides it, so two runs against
 * one file walk the same way. Newest first, because a registration writes on
 * the newest generation, so the newest generation that holds an asset is where
 * the most recent act put it.
 */
export function generationsNewestFirst(
  deploymentsText: string,
  network: string,
): readonly Generation[] {
  return parseDeployments(deploymentsText)
    .filter((generation) => generation.network === network)
    .reverse();
}

/**
 * Finds the generation that holds one asset.
 *
 * The walk stops at the first generation that answers with a record. A
 * generation that answers `AssetNotRegistered` does not hold the asset, and the
 * walk goes on.
 *
 * Any other answer stops the whole call, and that is stricter than it looks.
 * A generation that fails to answer cannot be told from one that holds nothing.
 * If the walk stepped past it, an older generation could answer while the
 * failed one also held a record, and the caller would get an older record than
 * the truth with nothing to say it was older. A stopped call costs a reader one
 * message. A wrong record in the shape of a right one costs them the answer
 * they came for and tells them nothing.
 *
 * The walk asks only the generations that the deployments file records. It
 * never follows an address out of an answer, so a registry that nobody vouched
 * for is never contacted.
 */
export async function locateAsset(input: {
  server: rpc.Server;
  config: NetworkConfig;
  options: ReadOptions;
  deploymentsText: string;
  asset: string;
}): Promise<AssetLocation> {
  const generations = generationsNewestFirst(input.deploymentsText, input.config.network);
  if (generations.length === 0) {
    throw new InfrastructureError(
      `the deployments file records no generation on the network ${input.config.network}`,
    );
  }
  const asked: Generation[] = [];
  for (const generation of generations) {
    asked.push(generation);
    let record: AssetRecord | undefined;
    try {
      record = await readAssetRecord(
        input.server,
        input.config,
        input.options,
        generation.registry,
        input.asset,
      );
    } catch (cause) {
      throw new InfrastructureError(
        `the registry ${generation.registry} did not answer whether it holds the asset ${input.asset}. ` +
          `This client asked ${asked.map((each) => each.registry).join(", ")} and stopped there, because it cannot tell a registry that holds nothing from one that failed. ` +
          `The record of this asset is unknown rather than absent, and a later attempt may answer. ` +
          `The registry said: ${messageOf(cause)}`,
        { cause },
      );
    }
    if (record !== undefined) {
      return { holder: { generation, record }, asked };
    }
  }
  return { holder: undefined, asked };
}

/**
 * The generation that a registration writes on, which is the newest.
 *
 * A registration creates the record, so no generation holds the asset yet and
 * there is nothing to derive from. It writes on the newest generation, and that
 * is what puts an asset on two generations when its issuer registers again
 * after a migration. The read walk answers that state rather than refusing it,
 * because this path is what produces it and no call removes a record.
 */
export function generationForRegistration(
  deploymentsText: string,
  network: string,
): Generation {
  const newest = generationsNewestFirst(deploymentsText, network)[0];
  if (newest === undefined) {
    throw new InfrastructureError(
      `the deployments file records no generation on the network ${network}`,
    );
  }
  return newest;
}

/** The generation of one registry address, or nothing when the file records none. */
export function generationOfRegistry(
  deploymentsText: string,
  network: string,
  registry: string,
): Generation | undefined {
  return findGeneration(deploymentsText, network, registry);
}

/** The message of a caught value, which is not always an error. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
