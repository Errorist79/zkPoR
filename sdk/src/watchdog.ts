/** An operator runs this check again after each new attestation. */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Account, Keypair, rpc } from "@stellar/stellar-sdk";
import {
  DISPUTE_TARGET_MAX_AGE_LEDGERS,
  MAX_U64,
  SECRET_FILE_MODE,
  WATCHDOG_DELIVERY_GRACE_LEDGERS,
} from "./constants.js";
import { findGeneration } from "./deployments.js";
import { DisputeInputError, inclusionEvidenceFromPackage, openDispute, readStoredDispute } from "./disputes.js";
import { toHex } from "./fr.js";
import { isRecord } from "./guards.js";
import { verifyInclusion } from "./inclusion.js";
import { parsePackage } from "./inclusion-package.js";
import { checkOwnIdentifier } from "./identity.js";
import { InfrastructureError, latestLedger } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { readStoredAttestation, readStoredAttestationHistory } from "./registry.js";
import type { ReadOptions } from "./registry.js";

const WATCHDOG_STATE_FORMAT = "zkpor-watchdog/1";
const PRIVATE_DIRECTORY_MODE = 0o700;

type WatchdogCoreOutcome =
  | { readonly kind: "no-new-attestation" }
  | { readonly kind: "waiting"; readonly targetId: bigint; readonly deliveryDeadline: number; readonly currentLedger: number }
  | { readonly kind: "delivered"; readonly targetId: bigint }
  | { readonly kind: "opened"; readonly targetId: bigint; readonly transactionHash: string }
  | { readonly kind: "existing"; readonly targetId: bigint }
  | { readonly kind: "pending"; readonly targetId: bigint; readonly transactionHash: string; readonly transactionStatus: string }
  | { readonly kind: "expired"; readonly targetId: bigint; readonly currentLedger: number };

export type WatchdogOutcome = WatchdogCoreOutcome & { readonly skippedExpiredTargetId?: bigint };

export interface WatchdogInput {
  readonly server: rpc.Server;
  readonly network: NetworkConfig;
  readonly readOptions: ReadOptions;
  readonly deploymentsText: string;
  readonly oldPackageText: string;
  readonly identityText: string;
  readonly packagesDirectory: string;
  readonly stateDirectory: string;
  readonly disputerSigner: Keypair;
  readonly deliveryGraceLedgers?: number;
}

type StateStatus = "delivered" | "disputed" | "pending" | "expired";

interface StateRecord {
  readonly format: typeof WATCHDOG_STATE_FORMAT;
  readonly network: string;
  readonly registry: string;
  readonly asset: string;
  readonly identifier: string;
  readonly oldAttestationId: string;
  readonly graceLedgers: number;
  readonly targetId: string;
  readonly status: StateStatus;
  readonly transactionHash?: string;
  readonly maxTime?: number;
}

function codeOf(cause: unknown): string | undefined {
  if (!isRecord(cause)) {
    return undefined;
  }
  return typeof cause["code"] === "string" ? cause["code"] : undefined;
}

function graceOf(value: number | undefined): number {
  const grace = value ?? WATCHDOG_DELIVERY_GRACE_LEDGERS;
  if (!Number.isInteger(grace) || grace < 1 || grace >= DISPUTE_TARGET_MAX_AGE_LEDGERS) {
    throw new RangeError(
      `the package delivery grace must be 1 through ${DISPUTE_TARGET_MAX_AGE_LEDGERS - 1} ledgers`,
    );
  }
  return grace;
}

function stateNamespace(input: WatchdogInput, old: ReturnType<typeof parsePackage>): string {
  const key = [input.network.network, old.registry, old.asset, toHex(old.id), old.attestationId.toString()].join("\u0000");
  return join(resolve(input.stateDirectory), createHash("sha256").update(key).digest("hex"));
}

async function stateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const details = await stat(path);
  if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new InfrastructureError("the watchdog state directory must be private to its owner");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createState(path: string, record: StateRecord): Promise<boolean> {
  const handle = await open(path, "wx", SECRET_FILE_MODE).catch((cause: unknown) => {
    if (codeOf(cause) === "EEXIST") {
      return undefined;
    }
    throw new InfrastructureError("the watchdog cannot create its state", { cause });
  });
  if (handle === undefined) {
    return false;
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path);
  return true;
}

async function replaceState(path: string, record: StateRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", SECRET_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(path);
}

function recordOf(
  input: WatchdogInput,
  old: ReturnType<typeof parsePackage>,
  grace: number,
  targetId: bigint,
  status: StateStatus,
  transactionHash?: string,
  maxTime?: number,
): StateRecord {
  return {
    format: WATCHDOG_STATE_FORMAT,
    network: input.network.network,
    registry: old.registry,
    asset: old.asset,
    identifier: toHex(old.id),
    oldAttestationId: old.attestationId.toString(),
    graceLedgers: grace,
    targetId: targetId.toString(),
    status,
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(maxTime === undefined ? {} : { maxTime }),
  };
}

async function readState(path: string, expected: StateRecord): Promise<StateRecord | undefined> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || (details.mode & 0o077) !== 0) {
      throw new InfrastructureError("the watchdog state file must be private to its owner");
    }
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") {
      return undefined;
    }
    if (cause instanceof InfrastructureError) {
      throw cause;
    }
    throw new InfrastructureError("the watchdog cannot inspect its state", { cause });
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") {
      return undefined;
    }
    throw new InfrastructureError("the watchdog cannot read its state", { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InfrastructureError("the watchdog state is not JSON");
  }
  if (!isRecord(value) ||
      value["format"] !== expected.format ||
      value["network"] !== expected.network ||
      value["registry"] !== expected.registry ||
      value["asset"] !== expected.asset ||
      value["identifier"] !== expected.identifier ||
      value["oldAttestationId"] !== expected.oldAttestationId ||
      value["graceLedgers"] !== expected.graceLedgers ||
      value["targetId"] !== expected.targetId) {
    throw new InfrastructureError("the watchdog state belongs to a different check");
  }
  const status = value["status"];
  if (status !== "delivered" && status !== "disputed" && status !== "pending" && status !== "expired") {
    throw new InfrastructureError("the watchdog state has an unsupported status");
  }
  const transactionHash = value["transactionHash"];
  const maxTime = value["maxTime"];
  if (status === "pending" && (typeof transactionHash !== "string" || !/^[0-9a-f]{64}$/.test(transactionHash))) {
    throw new InfrastructureError("the pending watchdog state has no transaction hash");
  }
  if (status === "pending" && (typeof maxTime !== "number" || !Number.isSafeInteger(maxTime) || maxTime < 1)) {
    throw new InfrastructureError("the pending watchdog state has no bounded expiry");
  }
  if (transactionHash !== undefined && typeof transactionHash !== "string") {
    throw new InfrastructureError("the watchdog transaction hash is invalid");
  }
  return {
    ...expected,
    status,
    ...(typeof transactionHash === "string" ? { transactionHash } : {}),
    ...(typeof maxTime === "number" ? { maxTime } : {}),
  };
}

async function packageText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") {
      return undefined;
    }
    throw new InfrastructureError("the watchdog cannot read a delivered package", { cause });
  }
}

async function ownPackageForTarget(input: WatchdogInput, old: ReturnType<typeof parsePackage>, targetId: bigint): Promise<boolean> {
  const text = await packageText(join(input.packagesDirectory, `${targetId}.zkpor.json`));
  if (text === undefined) {
    return false;
  }
  const verdict = await verifyInclusion({
    packageText: text,
    deploymentsText: input.deploymentsText,
    server: input.server,
    config: input.network,
    readOptions: input.readOptions,
    identityText: input.identityText,
  });
  if (verdict.kind !== "included" || verdict.identityConfirmed !== true) {
    return false;
  }
  const entry = parsePackage(text);
  return entry.network === old.network &&
    entry.registry === old.registry &&
    entry.asset === old.asset &&
    entry.attestationId === targetId &&
    entry.id === old.id;
}

async function pendingOutcome(
  input: WatchdogInput,
  old: ReturnType<typeof parsePackage>,
  targetId: bigint,
  path: string,
  record: StateRecord,
): Promise<WatchdogOutcome | { readonly kind: "retry" }> {
  const dispute = await readStoredDispute(input.network, old.registry, old.asset, targetId, old.id, {
    ...input.readOptions,
    server: input.server,
  });
  if (dispute !== undefined) {
    await replaceState(path, { ...record, status: "disputed" });
    return { kind: "existing", targetId };
  }
  const hash = record.transactionHash;
  const maxTime = record.maxTime;
  if (hash === undefined || maxTime === undefined) {
    throw new InfrastructureError("the pending watchdog state has no transaction identity");
  }
  let transaction: rpc.Api.GetTransactionResponse;
  try {
    transaction = await input.server.getTransaction(hash);
  } catch (cause) {
    throw new InfrastructureError("the watchdog cannot read its pending transaction", { cause });
  }
  if (transaction.status === rpc.Api.GetTransactionStatus.FAILED) {
    return { kind: "retry" };
  }
  if (transaction.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
      transaction.latestLedgerCloseTime > maxTime) {
    return { kind: "retry" };
  }
  if (transaction.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new InfrastructureError("the settled dispute transaction has no fixed dispute record");
  }
  return { kind: "pending", targetId, transactionHash: hash, transactionStatus: transaction.status };
}

function withExpired(outcome: WatchdogCoreOutcome, expiredTargetId: bigint | undefined): WatchdogOutcome {
  return expiredTargetId === undefined ? outcome : { ...outcome, skippedExpiredTargetId: expiredTargetId };
}

/** Processes each accepted target in order and sends at most one deposit transaction. */
export async function runWatchdog(input: WatchdogInput): Promise<WatchdogOutcome> {
  const grace = graceOf(input.deliveryGraceLedgers);
  const old = parsePackage(input.oldPackageText);
  if (old.network !== input.network.network || findGeneration(input.deploymentsText, old.network, old.registry) === undefined) {
    throw new InfrastructureError("the old package does not name a trusted registry on this network");
  }
  if (checkOwnIdentifier(old, input.identityText).kind !== "own") {
    throw new DisputeInputError("the old package does not match the private identity");
  }
  const oldVerdict = await verifyInclusion({
    packageText: input.oldPackageText,
    deploymentsText: input.deploymentsText,
    server: input.server,
    config: input.network,
    readOptions: input.readOptions,
    identityText: input.identityText,
  });
  if (oldVerdict.kind !== "included" || oldVerdict.identityConfirmed !== true) {
    throw new InfrastructureError(`the old package did not pass inclusion: ${oldVerdict.kind}`);
  }
  if (old.attestationId >= MAX_U64) {
    throw new RangeError("the old attestation ID has no following u64 ID");
  }
  const namespace = stateNamespace(input, old);
  await stateDirectory(namespace);
  const history = await readStoredAttestationHistory(input.network, old.registry, old.asset, {
    ...input.readOptions,
    server: input.server,
    startId: old.attestationId + 1n,
    count: 1,
  });
  if (history.totalCount <= old.attestationId) {
    return { kind: "no-new-attestation" };
  }
  const currentLedger = await latestLedger(input.server);
  let lastDelivered: bigint | undefined;
  let firstExpired: bigint | undefined;
  for (let targetId = old.attestationId + 1n; targetId <= history.totalCount; targetId += 1n) {
    const path = join(namespace, `${targetId}.json`);
    const base = recordOf(input, old, grace, targetId, "delivered");
    const state = await readState(path, base);
    if (state?.status === "delivered") {
      lastDelivered = targetId;
      continue;
    }
    if (state?.status === "disputed") {
      continue;
    }
    if (state?.status === "expired") {
      firstExpired ??= targetId;
      continue;
    }
    let retry = false;
    if (state?.status === "pending") {
      const pending = await pendingOutcome(input, old, targetId, path, state);
      if (pending.kind !== "retry") {
        return withExpired(pending, firstExpired);
      }
      retry = true;
    }
    const target = await readStoredAttestation(input.network, old.registry, old.asset, targetId, {
      ...input.readOptions,
      server: input.server,
    });
    if (target === undefined) {
      throw new InfrastructureError("the attestation count includes a missing target");
    }
    if (await ownPackageForTarget(input, old, targetId)) {
      const delivered = recordOf(input, old, grace, targetId, "delivered");
      if (retry) {
        await replaceState(path, delivered);
      } else if (!await createState(path, delivered)) {
        throw new InfrastructureError("another watchdog run changed the target state");
      }
      lastDelivered = targetId;
      continue;
    }
    const deliveryDeadline = target.attestedLedger + grace;
    if (currentLedger < deliveryDeadline) {
      return withExpired({ kind: "waiting", targetId, deliveryDeadline, currentLedger }, firstExpired);
    }
    if (currentLedger - target.attestedLedger > DISPUTE_TARGET_MAX_AGE_LEDGERS) {
      const expired = recordOf(input, old, grace, targetId, "expired");
      if (retry) {
        await replaceState(path, expired);
      } else if (!await createState(path, expired)) {
        throw new InfrastructureError("another watchdog run changed the target state");
      }
      firstExpired ??= targetId;
      continue;
    }
    const existing = await readStoredDispute(input.network, old.registry, old.asset, targetId, old.id, {
      ...input.readOptions,
      server: input.server,
    });
    if (existing !== undefined) {
      const disputed = recordOf(input, old, grace, targetId, "disputed");
      if (retry) {
        await replaceState(path, disputed);
      } else if (!await createState(path, disputed)) {
        throw new InfrastructureError("another watchdog run changed the target state");
      }
      return withExpired({ kind: "existing", targetId }, firstExpired);
    }
    const account = await input.server.getAccount(input.disputerSigner.publicKey()).catch((cause: unknown) => {
      throw new InfrastructureError("the watchdog cannot read the disputer account", { cause });
    });
    const result = await openDispute(input.server, input.network, {
      sourceAccount: new Account(account.accountId(), account.sequenceNumber()),
      sourceSigner: input.disputerSigner,
      registry: old.registry,
      asset: old.asset,
      targetId,
      opening: {
        kind: "inclusion",
        attestationId: old.attestationId,
        inclusion: inclusionEvidenceFromPackage(old),
      },
      beforeSend: async (transactionHash, maxTime) => {
        const pending = recordOf(input, old, grace, targetId, "pending", transactionHash, maxTime);
        if (retry) {
          await replaceState(path, pending);
        } else if (!await createState(path, pending)) {
          throw new InfrastructureError("another watchdog run changed the target state");
        }
      },
    });
    const dispute = await readStoredDispute(input.network, old.registry, old.asset, targetId, old.id, {
      ...input.readOptions,
      server: input.server,
    });
    if (dispute === undefined) {
      throw new InfrastructureError("the settled dispute transaction has no fixed dispute record");
    }
    await replaceState(path, recordOf(input, old, grace, targetId, "disputed", result.transactionHash));
    return withExpired({ kind: "opened", targetId, transactionHash: result.transactionHash }, firstExpired);
  }
  if (firstExpired !== undefined) {
    return { kind: "expired", targetId: firstExpired, currentLedger };
  }
  return lastDelivered === undefined ? { kind: "no-new-attestation" } : { kind: "delivered", targetId: lastDelivered };
}
