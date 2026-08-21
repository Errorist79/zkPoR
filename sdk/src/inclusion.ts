/**
 * The customer inclusion check.
 *
 * One rule governs every package field that names a place. A package value may
 * select a record inside data that the verifier already trusts. It must never
 * select where the trusted data comes from. The verifier therefore takes its
 * registry addresses from its own copy of the deployments file and its endpoint
 * from its own configuration, and it treats the `network` and `registry` fields
 * of the package as claims to check against that data.
 *
 * Each failure class stays distinct in the result. An infrastructure failure is
 * not a verdict, so it never arrives as one.
 */

import type { rpc } from "@stellar/stellar-sdk";
import {
  ContradictoryDeploymentsError,
  UnreadableDeploymentsError,
  findGeneration,
} from "./deployments.js";
import {
  MalformedPackageError,
  UnsupportedFormatError,
  checkDepth,
  parsePackage,
} from "./inclusion-package.js";
import type { InclusionPackage } from "./inclusion-package.js";
import { leafHash } from "./hashes.js";
import { rootFromPath } from "./tree.js";
import { toHex } from "./fr.js";
import { InfrastructureError, latestLedger } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { readAssetRecord, solvencyLapsed } from "./registry.js";
import type { Attestation, ReadOptions } from "./registry.js";

/** The name of each outcome of the check. Each name is one failure class. */
export type VerdictKind =
  | "included"
  | "unsupported-format"
  | "malformed"
  | "untrusted-deployment"
  | "invalid-deployments"
  | "no-matching-attestation"
  | "root-mismatch";

/** The outcome of the check on one package. */
export type Verdict =
  | {
      readonly kind: "included";
      readonly asset: string;
      readonly registry: string;
      readonly leafIndex: number;
      readonly balance: bigint;
      readonly snapshotLedger: number;
      readonly attestedLedger: number;
      readonly totalLiabilities: bigint;
      readonly reserveSum: bigint;
      readonly currentLedger: number;
      readonly solvencyLapsed: boolean;
    }
  | { readonly kind: "unsupported-format"; readonly reason: string }
  | { readonly kind: "malformed"; readonly reason: string }
  | {
      readonly kind: "untrusted-deployment";
      readonly reason: string;
      readonly network: string;
      readonly registry: string;
    }
  | { readonly kind: "invalid-deployments"; readonly reason: string }
  | { readonly kind: "no-matching-attestation"; readonly reason: string }
  | {
      readonly kind: "root-mismatch";
      readonly recomputed: bigint;
      readonly attested: bigint;
    };

/**
 * The exit code of each outcome.
 *
 * The codes equal the codes of the Rust reference of the same checks, so the
 * two implementations report one outcome with one number. An infrastructure
 * failure has its own code, because it is not a verdict.
 */
export const EXIT_CODES: Readonly<Record<VerdictKind, number>> = {
  included: 0,
  "unsupported-format": 3,
  malformed: 4,
  "untrusted-deployment": 5,
  "no-matching-attestation": 6,
  "root-mismatch": 7,
  "invalid-deployments": 9,
};

/** The exit code of a failure that gives no verdict. */
export const EXIT_NO_VERDICT = 8;

/** The exit code of a wrong command line. */
export const EXIT_USAGE = 2;

/** The exit code of one verdict. */
export function exitCode(verdict: Verdict): number {
  return EXIT_CODES[verdict.kind];
}

/**
 * Checks one package against the chain.
 *
 * The steps run in the order the specification fixes: parse and validate,
 * check the deployment claim, read the attested root, compare the snapshot,
 * then rebuild the leaf and walk the path.
 */
export async function verifyInclusion(input: {
  packageText: string;
  deploymentsText: string;
  server: rpc.Server;
  config: NetworkConfig;
  readOptions: ReadOptions;
}): Promise<Verdict> {
  let entry: InclusionPackage;
  try {
    entry = parsePackage(input.packageText);
  } catch (cause) {
    if (cause instanceof UnsupportedFormatError) {
      return { kind: "unsupported-format", reason: cause.message };
    }
    if (cause instanceof MalformedPackageError) {
      return { kind: "malformed", reason: cause.message };
    }
    throw cause;
  }

  let generation;
  try {
    generation = findGeneration(input.deploymentsText, entry.network, entry.registry);
  } catch (cause) {
    if (cause instanceof ContradictoryDeploymentsError) {
      return { kind: "invalid-deployments", reason: cause.message };
    }
    if (cause instanceof UnreadableDeploymentsError) {
      throw new InfrastructureError(cause.message, { cause });
    }
    throw cause;
  }
  if (generation === undefined) {
    return {
      kind: "untrusted-deployment",
      reason: `the deployments file of this verifier names no registry ${entry.registry} on the network ${entry.network}, so the package points somewhere this verifier does not trust`,
      network: entry.network,
      registry: entry.registry,
    };
  }

  try {
    checkDepth(entry, generation.treeDepth);
  } catch (cause) {
    if (cause instanceof MalformedPackageError) {
      return { kind: "malformed", reason: cause.message };
    }
    throw cause;
  }

  const record = await readAssetRecord(
    input.server,
    input.config,
    input.readOptions,
    generation.registry,
    entry.asset,
  );
  if (record === undefined) {
    return {
      kind: "no-matching-attestation",
      reason: `the registry ${generation.registry} holds no record of the asset ${entry.asset}`,
    };
  }
  const attestation: Attestation | undefined = record.attestation;
  if (attestation === undefined) {
    return {
      kind: "no-matching-attestation",
      reason: `the registry ${generation.registry} holds a record of the asset ${entry.asset} and no attestation`,
    };
  }
  if (attestation.snapshotLedger !== entry.snapshotLedger) {
    return {
      kind: "no-matching-attestation",
      reason: `the package names the snapshot ledger ${entry.snapshotLedger}, and the registry attests the snapshot ledger ${attestation.snapshotLedger}`,
    };
  }

  const recomputed = rootFromPath({
    leaf: leafHash({ id: entry.id, balance: entry.balance, salt: entry.salt }),
    leafIndex: entry.leafIndex,
    siblings: entry.siblings,
    depth: generation.treeDepth,
  });
  if (recomputed !== attestation.finalRoot) {
    return { kind: "root-mismatch", recomputed, attested: attestation.finalRoot };
  }

  const currentLedger = await latestLedger(input.server);
  return {
    kind: "included",
    asset: entry.asset,
    registry: generation.registry,
    leafIndex: entry.leafIndex,
    balance: entry.balance,
    snapshotLedger: attestation.snapshotLedger,
    attestedLedger: attestation.attestedLedger,
    totalLiabilities: attestation.totalLiabilities,
    reserveSum: attestation.reserveSum,
    currentLedger,
    solvencyLapsed: solvencyLapsed(attestation.snapshotLedger, currentLedger),
  };
}

/**
 * The report of one verdict, in lines.
 *
 * Inclusion and the currency of the solvency claim are different claims, so an
 * included package with a lapsed window gives two separate statements.
 */
export function verdictLines(verdict: Verdict): string[] {
  switch (verdict.kind) {
    case "included": {
      const lines = [
        "The leaf is under the attested root.",
        `The asset is ${verdict.asset}.`,
        `The package names the registry ${verdict.registry}, and this check read that registry.`,
        `The leaf index is ${verdict.leafIndex}, and the balance is ${verdict.balance.toString(10)}.`,
        `The snapshot ledger is ${verdict.snapshotLedger}, and the registry read the reserves at ledger ${verdict.attestedLedger}.`,
        `The total liabilities under the root are ${verdict.totalLiabilities.toString(10)}.`,
        `The reserves at the attestation, at ledger ${verdict.attestedLedger}, were ${verdict.reserveSum.toString(10)}.`,
      ];
      if (verdict.solvencyLapsed) {
        lines.push(
          "The inclusion is valid.",
          `The solvency claim has lapsed: the current ledger is ${verdict.currentLedger}, and the snapshot is older than the window.`,
        );
      } else {
        lines.push(`The solvency claim is current at ledger ${verdict.currentLedger}.`);
      }
      return lines;
    }
    case "unsupported-format":
      return ["The package format is not supported.", verdict.reason];
    case "malformed":
      return ["The package is malformed.", verdict.reason];
    case "untrusted-deployment":
      return ["The package points at a registry this verifier does not trust.", verdict.reason];
    case "invalid-deployments":
      return ["The deployments file of this verifier contradicts itself.", verdict.reason];
    case "no-matching-attestation":
      return ["The registry holds no attestation that matches the package.", verdict.reason];
    case "root-mismatch":
      return [
        "The recomputed root does not equal the attested root.",
        `The recomputed root is ${toHex(verdict.recomputed)}.`,
        `The attested root is ${toHex(verdict.attested)}.`,
        "A wrong balance, a wrong salt, and a tampered path are the same result from here.",
        "Obtain the package again from the authority before you conclude anything.",
      ];
  }
}
