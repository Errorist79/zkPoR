/**
 * Attestation submission.
 *
 * The call carries the snapshot ledger, the root, the total liabilities, and
 * the proof. The authority is the only signer, because no reserve address
 * consents to an attestation. A reserve address consents to the registration
 * and to a change of the reserve set only.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";
import { ATTESTATION_MAX_AGE_LEDGERS, MAX_U32 } from "./constants.js";
import { InfrastructureError, latestLedger } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { registryErrorCode } from "./registry-errors.js";
import { RegistryRefusedError } from "./registry.js";
import { sendAndSettle } from "./registration.js";
import type { SubmitResult } from "./registration.js";
import { inRange } from "./fr.js";

/** A submission that the client refuses before the network sees it. */
export class AttestationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationInputError";
  }
}

/**
 * Checks the window of the snapshot before the call leaves the client.
 *
 * The registry accepts the call only when the snapshot ledger is at most the
 * execution ledger and at least the execution ledger minus the window. The
 * execution ledger is the chain's, so this check is an early warning and not a
 * guarantee.
 */
export function snapshotInsideWindow(snapshotLedger: number, currentLedger: number): boolean {
  return (
    snapshotLedger <= currentLedger && currentLedger <= snapshotLedger + ATTESTATION_MAX_AGE_LEDGERS
  );
}

/** Submits one attestation and waits for the network to settle it. */
export async function submitAttestation(
  server: rpc.Server,
  config: NetworkConfig,
  input: {
    sourceAccount: Account;
    authoritySigner: Keypair;
    registry: string;
    asset: string;
    snapshotLedger: number;
    finalRoot: bigint;
    totalLiabilities: bigint;
    proof: Uint8Array;
  },
): Promise<SubmitResult> {
  if (!Number.isInteger(input.snapshotLedger) || input.snapshotLedger < 0 || input.snapshotLedger > MAX_U32) {
    throw new AttestationInputError("the snapshot ledger must be a sequence that a u32 holds");
  }
  if (!inRange(input.finalRoot)) {
    throw new AttestationInputError("the root is not a field element");
  }
  if (input.totalLiabilities < 0n || input.totalLiabilities >= 2n ** 128n) {
    throw new AttestationInputError("the total liabilities must be a value that a u128 holds");
  }
  if (input.proof.length === 0) {
    throw new AttestationInputError("the proof carries no bytes");
  }

  // The registry refuses a snapshot outside the window with one error code and
  // no numbers. The check runs here first, so the run stops with the two
  // ledgers named. The chain assigns the execution ledger, so this is an early
  // warning and not a guarantee.
  const currentLedger = await latestLedger(server);
  if (!snapshotInsideWindow(input.snapshotLedger, currentLedger)) {
    throw new AttestationInputError(
      `the snapshot ledger ${input.snapshotLedger} is outside the window at the current ledger ${currentLedger}; the window is ${ATTESTATION_MAX_AGE_LEDGERS} ledgers`,
    );
  }

  const contract = new Contract(input.registry);
  const transaction = new TransactionBuilder(input.sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "submit_attestation",
        nativeToScVal(Address.fromString(input.asset)),
        nativeToScVal(input.snapshotLedger, { type: "u32" }),
        nativeToScVal(input.finalRoot, { type: "u256" }),
        nativeToScVal(input.totalLiabilities, { type: "u128" }),
        nativeToScVal(Buffer.from(input.proof), { type: "bytes" }),
      ),
    )
    .setTimeout(300)
    .build();

  let answer: rpc.Api.SimulateTransactionResponse;
  try {
    answer = await server.simulateTransaction(transaction);
  } catch (cause) {
    throw new InfrastructureError("the client cannot simulate the attestation", { cause });
  }
  if (rpc.Api.isSimulationError(answer)) {
    const code = registryErrorCode(answer.error);
    if (code !== undefined) {
      throw new RegistryRefusedError(code);
    }
    throw new InfrastructureError(`the simulation of the attestation failed: ${answer.error}`);
  }
  // The assembly clones the transaction with its time bounds already set, and a
  // second setTimeout call refuses to overwrite them.
  const ready = rpc.assembleTransaction(transaction, answer).build();
  ready.sign(input.authoritySigner);
  return sendAndSettle(server, ready);
}
