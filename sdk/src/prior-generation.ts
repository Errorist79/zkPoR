/** Reads network history before the separate proving driver handles private witnesses. */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { rpc } from "@stellar/stellar-sdk";
import { MAX_U64 } from "./constants.js";
import type { NetworkConfig } from "./network.js";
import { ProvingError } from "./proving.js";
import type { PriorGeneration } from "./proving.js";
import { readStoredAttestation, readStoredAttestationHistory } from "./registry.js";
import type { ReadOptions } from "./registry.js";

/** Reads the fixed prior attestation before a proof can omit an old identifier. */
export async function preparePriorGeneration(input: {
  server: rpc.Server;
  network: NetworkConfig;
  readOptions: ReadOptions;
  registry: string;
  asset: string;
  outputDirectory: string;
}): Promise<PriorGeneration | undefined> {
  const history = await readStoredAttestationHistory(input.network, input.registry, input.asset, {
    ...input.readOptions,
    server: input.server,
    startId: 1n,
    count: 1,
  });
  if (history.totalCount === 0n) {
    return undefined;
  }
  if (history.totalCount >= MAX_U64) {
    throw new ProvingError("the prior attestation has no following u64 identifier");
  }
  const prior = await readStoredAttestation(
    input.network,
    input.registry,
    input.asset,
    history.totalCount,
    { ...input.readOptions, server: input.server },
  );
  if (prior === undefined) {
    throw new ProvingError("the attestation count includes a missing prior attestation");
  }
  const manifestFile = resolve(
    input.outputDirectory,
    "packages",
    input.network.network,
    input.registry,
    input.asset,
    prior.attestationId.toString(),
    "generation.json",
  );
  try {
    await readFile(manifestFile, "utf8");
  } catch {
    throw new ProvingError("the prior generation manifest is missing; restore it before proving");
  }
  return {
    attestationId: prior.attestationId,
    root: prior.finalRoot,
    contextHash: prior.contextHash,
    manifestFile,
  };
}
