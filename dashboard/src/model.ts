/**
 * The values that a page shows, and the arithmetic over them.
 *
 * The registry produces two reserve numbers and they must never share a name, a
 * row, or a headline. The types here keep them apart: an attested sum and an
 * observed sum are two types with different fields, so no function takes "a
 * reserve number" and no component renders one without its own qualifier.
 *
 * The registry records both the reserve sum and the total liabilities and it
 * compares neither against the other. The comparison therefore belongs to the
 * reader, and this module states it as the reader's arithmetic over one
 * attestation record. The observation never enters it.
 */

import type { Attestation, AssetRecord, ReserveDiagnosis, ReserveObservation } from "@zkpor/sdk";
import { solvencyLapsed } from "@zkpor/sdk";

/**
 * The reserve sum that one attestation covers.
 *
 * The registry read the balances inside the attestation transaction, at the
 * ledger this record names.
 */
export interface AttestedReserves {
  readonly sum: bigint;
  readonly attestedLedger: number;
}

/**
 * The reserve sum of a read that no attestation covers.
 *
 * The value is a reading at the ledger it names, and nothing else.
 */
export interface ObservedReserves {
  readonly sum: bigint;
  readonly observedLedger: number;
}

/** Whether the attested reserves reach the attested liabilities. */
export type Coverage = "reserves-reach-liabilities" | "reserves-fall-short";

/** Whether the solvency claim of an attestation still stands at the current ledger. */
export type Currency = "current" | "lapsed";

/**
 * The solvency result of one attestation.
 *
 * Every field of it comes from the one attestation record, so the comparison
 * holds two numbers that the registry produced in one transaction.
 */
export interface SolvencyResult {
  readonly snapshotLedger: number;
  readonly finalRoot: bigint;
  readonly totalLiabilities: bigint;
  readonly attested: AttestedReserves;
  readonly coverage: Coverage;
  readonly currency: Currency;
  readonly currentLedger: number;
}

/** The attested reserves of one attestation record. */
export function attestedReserves(attestation: Attestation): AttestedReserves {
  return { sum: attestation.reserveSum, attestedLedger: attestation.attestedLedger };
}

/** The observed reserves of one reading. */
export function observedReserves(observation: ReserveObservation): ObservedReserves {
  return { sum: observation.observedSum, observedLedger: observation.observedLedger };
}

/**
 * Whether the attested reserves of one attestation reach its liabilities.
 *
 * The reserve sum is a signed integer on the chain and the liability total is
 * an unsigned one, so the comparison runs over integers of arbitrary size and
 * never over a converted number.
 */
export function coverageOf(attestation: Attestation): Coverage {
  return attestation.reserveSum >= attestation.totalLiabilities
    ? "reserves-reach-liabilities"
    : "reserves-fall-short";
}

/**
 * The solvency result of one attestation at one current ledger.
 *
 * The current ledger arrives from the network that holds the registry. A
 * supplied value could hide a lapse, so no page and no form carries it.
 */
export function solvencyResult(attestation: Attestation, currentLedger: number): SolvencyResult {
  const attested = attestedReserves(attestation);
  return {
    snapshotLedger: attestation.snapshotLedger,
    finalRoot: attestation.finalRoot,
    totalLiabilities: attestation.totalLiabilities,
    attested,
    coverage: coverageOf(attestation),
    currency: solvencyLapsed(attestation.snapshotLedger, currentLedger) ? "lapsed" : "current",
    currentLedger,
  };
}

/** Everything that the asset page shows about one registered asset. */
export interface AssetView {
  readonly asset: string;
  readonly network: string;
  readonly registry: string;
  readonly record: AssetRecord;
  readonly solvency: SolvencyResult | undefined;
  readonly observed: ObservedReserves | undefined;
  /** The reason the observation gave no sum, when the read failed. */
  readonly observationFailure: string | undefined;
  /**
   * The balance of each reserve address on its own.
   *
   * The observation fails as a whole when one balance read fails, and it names
   * no address. The diagnosis therefore runs only after that failure, which is
   * the one case where a reader needs the address that broke the rule.
   */
  readonly diagnosis: ReserveDiagnosis | undefined;
  readonly currentLedger: number;
}

/**
 * One earlier attestation, as the history view shows it.
 *
 * The entry states no ledger of the event. The registry sets the attested
 * ledger from the sequence of the ledger that executes the attestation, and it
 * publishes the event in that same transaction, so the two are one number and
 * the attested reserves already carry it.
 */
export interface HistoryEntry {
  readonly snapshotLedger: number;
  readonly totalLiabilities: bigint;
  readonly attested: AttestedReserves;
  readonly coverage: Coverage;
  readonly transactionHash: string;
}

/**
 * The history that the asset page shows.
 *
 * The event query answers from the retained window of the endpoint only, so the
 * view states the oldest ledger that the query covered and never presents a
 * window-bounded result as the complete record.
 */
export interface HistoryView {
  readonly entries: readonly HistoryEntry[];
  readonly oldestLedgerCovered: number;
  readonly oldestLedgerRetained: number;
  readonly latestLedger: number;
  readonly reachesTheRetentionLimit: boolean;
}
