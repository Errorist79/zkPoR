/**
 * The deployments file: the record of every deployment generation.
 *
 * A client obtains its registry addresses from its own copy of this file. A
 * package value may select a record inside data that the client already
 * trusts. It must never select where the trusted data comes from.
 *
 * The specification references this file but does not define its schema. The
 * observed record fields are the schema here, and the parser rejects a record
 * that lacks a field it needs.
 */

import { isRecord, messageOf } from "./guards.js";

/** One deployment generation. */
export interface Generation {
  readonly network: string;
  readonly registry: string;
  readonly verifier: string;
  readonly aggregatorKeySha256: string;
  readonly treeDepth: number;
}

/** A deployments file that this parser cannot read. */
export class UnreadableDeploymentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableDeploymentsError";
  }
}

/**
 * A deployments file that names one pair of a network and a registry twice.
 *
 * The whole file becomes unusable, because the parser cannot tell which record
 * a client should trust.
 */
export class ContradictoryDeploymentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContradictoryDeploymentsError";
  }
}

function stringField(record: Record<string, unknown>, key: string, position: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new UnreadableDeploymentsError(
      `the deployment record at position ${position} carries no ${key}`,
    );
  }
  return value;
}

/** Reads every generation of the file, in the order the file records them. */
export function parseDeployments(text: string): Generation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new UnreadableDeploymentsError(
      `the deployments file is not valid JSON: ${messageOf(cause)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new UnreadableDeploymentsError("the deployments file is a list of records");
  }
  const generations: Generation[] = parsed.map((record: unknown, position) => {
    if (!isRecord(record)) {
      throw new UnreadableDeploymentsError(
        `the deployment record at position ${position} is not an object`,
      );
    }
    const fields = record;
    const treeDepth = fields["tree_depth"];
    if (typeof treeDepth !== "number" || !Number.isInteger(treeDepth) || treeDepth < 1) {
      throw new UnreadableDeploymentsError(
        `the deployment record at position ${position} carries no tree_depth`,
      );
    }
    return {
      network: stringField(fields, "network", position),
      registry: stringField(fields, "registry", position),
      verifier: stringField(fields, "verifier", position),
      aggregatorKeySha256: stringField(fields, "aggregator_key_sha256", position),
      treeDepth,
    };
  });

  // The comparison runs over the values, so no element needs an index and no
  // reader has to claim that an index holds an element.
  const seen = new Set<string>();
  for (const generation of generations) {
    const pair = `${generation.network}\u0000${generation.registry}`;
    if (seen.has(pair)) {
      throw new ContradictoryDeploymentsError(
        `the deployments file names the registry ${generation.registry} on the network ${generation.network} twice`,
      );
    }
    seen.add(pair);
  }
  return generations;
}

/**
 * The current generation of one network: the last record that names it.
 *
 * The file appends one record per generation, so the last record of a network
 * is the generation that a new operation uses.
 */
export function currentGeneration(text: string, network: string): Generation | undefined {
  let current: Generation | undefined;
  for (const generation of parseDeployments(text)) {
    if (generation.network === network) {
      current = generation;
    }
  }
  return current;
}

/**
 * The generation that one pair of a network and a registry names.
 *
 * The lookup accepts a record of any generation, so a package of an earlier
 * generation stays verifiable.
 */
export function findGeneration(
  text: string,
  network: string,
  registry: string,
): Generation | undefined {
  return parseDeployments(text).find(
    (generation) => generation.network === network && generation.registry === registry,
  );
}
