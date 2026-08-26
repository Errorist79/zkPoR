/**
 * Per-reserve diagnosis.
 *
 * A reverted attestation carries a contract error code and no address. The code
 * `ReserveBalanceUnavailable` therefore says that one balance read failed, and
 * it does not say which address failed. Only a client that reads each reserve
 * balance on its own can name the address.
 *
 * The diagnosis reads the balance of each registered reserve address through
 * the asset contract, one simulation per address, and reports the outcome of
 * each one.
 */

import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { InfrastructureError } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { RegistryRefusedError, simulateRead } from "./registry.js";
import type { ReadOptions } from "./registry.js";

/** The outcome of one reserve balance read. */
export interface ReserveReading {
  readonly address: string;
  /** The balance, when the read answered. */
  readonly balance: bigint | undefined;
  /** The reason the read gave no balance, when it failed. */
  readonly failure: string | undefined;
}

/** The result of a diagnosis of every registered reserve address. */
export interface ReserveDiagnosis {
  readonly readings: readonly ReserveReading[];
  /** The addresses whose balance read failed. */
  readonly failed: readonly string[];
  /** The sum of the balances that answered. */
  readonly sumOfTheReadings: bigint;
}

/**
 * Reads the balance of each reserve address on its own.
 *
 * The registry sums the same balances inside one transaction and fails the
 * whole call when one read fails. This function does not substitute zero for a
 * failed read: it reports the failure against the address.
 */
export async function diagnoseReserves(
  server: rpc.Server,
  config: NetworkConfig,
  options: ReadOptions,
  input: { asset: string; reserves: readonly string[] },
): Promise<ReserveDiagnosis> {
  const readings: ReserveReading[] = [];
  for (const address of input.reserves) {
    try {
      const returned = await simulateRead(server, config, options, input.asset, "balance", [
        nativeToScVal(Address.fromString(address)),
      ]);
      if (typeof returned !== "bigint") {
        readings.push({
          address,
          balance: undefined,
          failure: "the asset contract returned no balance",
        });
        continue;
      }
      readings.push({ address, balance: returned, failure: undefined });
    } catch (cause) {
      if (cause instanceof RegistryRefusedError || cause instanceof InfrastructureError) {
        readings.push({ address, balance: undefined, failure: cause.message });
        continue;
      }
      throw cause;
    }
  }
  let sum = 0n;
  for (const reading of readings) {
    if (reading.balance !== undefined) {
      sum += reading.balance;
    }
  }
  return {
    readings,
    failed: readings
      .filter((reading) => reading.balance === undefined)
      .map((reading) => reading.address),
    sumOfTheReadings: sum,
  };
}
