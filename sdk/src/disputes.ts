/** Reads and submits disputes against fixed attestations. */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { MAX_U32, MAX_U64, PADDING_LEAF_ID, SUBMISSION_TIMEOUT_SECONDS } from "./constants.js";
import { inRange, parseHex, parseU32 } from "./fr.js";
import { isRecord } from "./guards.js";
import type { InclusionPackage } from "./inclusion-package.js";
import { InfrastructureError, openServer } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { DISPUTE_NOT_FOUND, registryErrorCode } from "./registry-errors.js";
import { RegistryRefusedError, simulateRead } from "./registry.js";
import type { StoredReadOptions } from "./registry.js";
import { sendAndSettle } from "./registration.js";
import type { SubmitResult } from "./registration.js";

export interface InclusionEvidence {
  readonly id: bigint;
  readonly commitment: bigint;
  readonly path: readonly bigint[];
  readonly position: number;
}

export type DisputeOrigin =
  | { readonly kind: "inclusion"; readonly attestationId: bigint }
  | { readonly kind: "email"; readonly keyId: bigint };

export type DisputeStatus = "Open" | "Answered" | "OmissionProven";

export interface DisputeRecord {
  readonly disputer: string;
  readonly origin: DisputeOrigin;
  readonly targetId: bigint;
  readonly identifier: bigint;
  readonly openedLedger: number;
  readonly deadline: number;
  readonly status: DisputeStatus;
  readonly closedLedger: number;
  readonly burnedBond: bigint;
}

export type DisputeOpening =
  | { readonly kind: "inclusion"; readonly attestationId: bigint; readonly inclusion: InclusionEvidence }
  | { readonly kind: "email"; readonly keyId: bigint; readonly id: bigint; readonly proof: Uint8Array };

export class DisputeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisputeInputError";
  }
}

function positiveU64(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 1n || value > MAX_U64) {
    throw new DisputeInputError(`${name} must be a positive u64`);
  }
}

function validIdentifier(id: bigint): void {
  if (typeof id !== "bigint" || id === PADDING_LEAF_ID || !inRange(id)) {
    throw new DisputeInputError("the identifier must be a nonzero field element");
  }
}

export function validateInclusionEvidence(evidence: InclusionEvidence): void {
  validIdentifier(evidence.id);
  if (typeof evidence.commitment !== "bigint" || !inRange(evidence.commitment)) {
    throw new DisputeInputError("the commitment is not a field element");
  }
  if (!Number.isInteger(evidence.position) || evidence.position < 0 || evidence.position > MAX_U32) {
    throw new DisputeInputError("the leaf position must be a u32");
  }
  if (!Array.isArray(evidence.path) || evidence.path.some((sibling) =>
    typeof sibling !== "bigint" || !inRange(sibling))) {
    throw new DisputeInputError("the path must contain field elements");
  }
}

/** Reads the public answer artifact. It carries no balance or salt. */
export function parseInclusionEvidence(text: string): InclusionEvidence {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DisputeInputError("the answer artifact is not JSON");
  }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "commitment,id,path,position") {
    throw new DisputeInputError("the answer artifact has incorrect fields");
  }
  if (typeof value["id"] !== "string" || typeof value["commitment"] !== "string") {
    throw new DisputeInputError("the answer artifact needs an identifier and a commitment");
  }
  if (!Array.isArray(value["path"]) || value["path"].some((entry: unknown) => typeof entry !== "string")) {
    throw new DisputeInputError("the answer artifact needs a path of field elements");
  }
  const entries: unknown[] = value["path"];
  const evidence = {
    id: parseHex(value["id"], "the identifier"),
    commitment: parseHex(value["commitment"], "the commitment"),
    path: entries.map((entry: unknown, index) => {
      if (typeof entry !== "string") {
        throw new DisputeInputError(`the path at level ${index} is not a field element`);
      }
      return parseHex(entry, `the path at level ${index}`);
    }),
    position: parseU32(value["position"], "the position"),
  };
  validateInclusionEvidence(evidence);
  return evidence;
}

export function inclusionEvidenceFromPackage(entry: InclusionPackage): InclusionEvidence {
  const evidence = {
    id: entry.id,
    commitment: entry.commitment,
    path: entry.siblings,
    position: entry.leafIndex,
  };
  validateInclusionEvidence(evidence);
  return evidence;
}

function field(record: unknown, key: string): unknown {
  if (!isRecord(record) || record[key] === undefined) {
    throw new InfrastructureError(`the dispute carries no ${key}`);
  }
  return record[key];
}

function u64(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    throw new InfrastructureError(`${name} is not a u64`);
  }
  return value;
}

function positiveRecordU64(value: unknown, name: string): bigint {
  const parsed = u64(value, name);
  if (parsed === 0n) {
    throw new InfrastructureError(`${name} is not positive`);
  }
  return parsed;
}

function u32(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new InfrastructureError(`${name} is not a u32`);
  }
  return value;
}

function originOf(record: unknown): DisputeOrigin {
  if (!isRecord(record)) {
    throw new InfrastructureError("the dispute is not a record");
  }
  const origin = record["origin"];
  if (origin === undefined) {
    return { kind: "inclusion", attestationId: positiveRecordU64(field(record, "evidence_id"), "the evidence ID") };
  }
  if (!Array.isArray(origin) || origin.length !== 2 || typeof origin[0] !== "string") {
    throw new InfrastructureError("the dispute origin is not a variant");
  }
  const value: unknown = origin[1];
  if (origin[0] === "Inclusion") {
    return { kind: "inclusion", attestationId: positiveRecordU64(value, "the evidence ID") };
  }
  if (origin[0] === "Email") {
    return { kind: "email", keyId: positiveRecordU64(value, "the email key ID") };
  }
  throw new InfrastructureError("the dispute origin is not supported");
}

/** Reads both the historical inclusion record and the current origin variant. */
export function decodeDispute(value: unknown): DisputeRecord {
  const disputer = field(value, "disputer");
  const status = field(value, "status");
  const identifier = field(value, "identifier");
  const burnedBond = field(value, "burned_bond");
  if (typeof disputer !== "string") {
    throw new InfrastructureError("the dispute disputer is not an address");
  }
  if (!Array.isArray(status) || status.length !== 1 ||
      (status[0] !== "Open" && status[0] !== "Answered" && status[0] !== "OmissionProven")) {
    throw new InfrastructureError("the dispute status is not supported");
  }
  if (typeof identifier !== "bigint" || identifier === PADDING_LEAF_ID || !inRange(identifier)) {
    throw new InfrastructureError("the dispute identifier is not a field element");
  }
  if (typeof burnedBond !== "bigint" || burnedBond < 0n) {
    throw new InfrastructureError("the burned bond is not an amount");
  }
  return {
    disputer,
    origin: originOf(value),
    targetId: positiveRecordU64(field(value, "target_id"), "the target ID"),
    identifier,
    openedLedger: u32(field(value, "opened_ledger"), "the open ledger"),
    deadline: u32(field(value, "deadline"), "the deadline"),
    status: status[0],
    closedLedger: u32(field(value, "closed_ledger"), "the close ledger"),
    burnedBond,
  };
}

/** Returns absence only when the registry confirms that this dispute does not exist. */
export async function readStoredDispute(
  network: NetworkConfig,
  registry: string,
  asset: string,
  targetId: bigint,
  identifier: bigint,
  options: StoredReadOptions = {},
): Promise<DisputeRecord | undefined> {
  positiveU64(targetId, "the target ID");
  validIdentifier(identifier);
  const server = options.server ?? openServer(network);
  let returned: unknown;
  try {
    returned = await simulateRead(server, network, options, registry, "get_dispute", [
      nativeToScVal(Address.fromString(asset)),
      nativeToScVal(targetId, { type: "u64" }),
      nativeToScVal(identifier, { type: "u256" }),
    ]);
  } catch (cause) {
    if (cause instanceof RegistryRefusedError && cause.code === DISPUTE_NOT_FOUND) {
      return undefined;
    }
    throw cause;
  }
  const dispute = decodeDispute(returned);
  if (dispute.targetId !== targetId || dispute.identifier !== identifier) {
    throw new InfrastructureError("the dispute does not match the requested target and identifier");
  }
  return dispute;
}

function structValue(fields: ReadonlyArray<readonly [string, xdr.ScVal]>): xdr.ScVal {
  // Soroban contract structs encode field names as symbols.
  const entries = new Map<xdr.ScVal, xdr.ScVal>();
  for (const [name, value] of fields) {
    entries.set(nativeToScVal(name, { type: "symbol" }), value);
  }
  return nativeToScVal(entries);
}

function inclusionValue(evidence: InclusionEvidence): xdr.ScVal {
  validateInclusionEvidence(evidence);
  return structValue([
    ["id", nativeToScVal(evidence.id, { type: "u256" })],
    ["commitment", nativeToScVal(evidence.commitment, { type: "u256" })],
    ["path", nativeToScVal(evidence.path.map((sibling) => nativeToScVal(sibling, { type: "u256" })))],
    ["position", nativeToScVal(evidence.position, { type: "u32" })],
  ]);
}

function openingValue(opening: DisputeOpening): xdr.ScVal {
  if (opening.kind === "inclusion") {
    positiveU64(opening.attestationId, "the evidence ID");
    return nativeToScVal([
      nativeToScVal("Inclusion", { type: "symbol" }),
      structValue([
        ["attestation_id", nativeToScVal(opening.attestationId, { type: "u64" })],
        ["inclusion", inclusionValue(opening.inclusion)],
      ]),
    ]);
  }
  positiveU64(opening.keyId, "the email key ID");
  validIdentifier(opening.id);
  if (!(opening.proof instanceof Uint8Array) || opening.proof.length === 0) {
    throw new DisputeInputError("the email proof carries no bytes");
  }
  return nativeToScVal([
    nativeToScVal("Email", { type: "symbol" }),
    structValue([
      ["key_id", nativeToScVal(opening.keyId, { type: "u64" })],
      ["id", nativeToScVal(opening.id, { type: "u256" })],
      ["proof", nativeToScVal(Buffer.from(opening.proof), { type: "bytes" })],
    ]),
  ]);
}

interface WriteInput {
  readonly sourceAccount: Account;
  readonly sourceSigner: Keypair;
  readonly registry: string;
  readonly asset: string;
  /** The callback persists the hash before the client sends the transaction. */
  readonly beforeSend?: (hash: string, maxTime: number) => Promise<void>;
}

async function submit(
  server: rpc.Server,
  network: NetworkConfig,
  input: WriteInput,
  method: string,
  args: readonly xdr.ScVal[],
): Promise<SubmitResult> {
  if (input.sourceAccount.accountId() !== input.sourceSigner.publicKey()) {
    throw new DisputeInputError("the transaction source must match its signer");
  }
  const transaction = new TransactionBuilder(input.sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(new Contract(input.registry).call(method, ...args))
    .setTimeout(SUBMISSION_TIMEOUT_SECONDS)
    .build();
  let answer: rpc.Api.SimulateTransactionResponse;
  try {
    answer = await server.simulateTransaction(transaction);
  } catch (cause) {
    throw new InfrastructureError(`the client cannot simulate ${method}`, { cause });
  }
  if (rpc.Api.isSimulationError(answer)) {
    const code = registryErrorCode(answer.error);
    if (code !== undefined) {
      throw new RegistryRefusedError(code);
    }
    throw new InfrastructureError(`the simulation of ${method} failed: ${answer.error}`);
  }
  const ready = rpc.assembleTransaction(transaction, answer).build();
  ready.sign(input.sourceSigner);
  const maxTime = Number(ready.timeBounds?.maxTime);
  if (!Number.isSafeInteger(maxTime) || maxTime < 1) {
    throw new InfrastructureError("the dispute transaction has no bounded expiry");
  }
  await input.beforeSend?.(ready.hash().toString("hex"), maxTime);
  return sendAndSettle(server, ready);
}

/** Opens a dispute. The disputer is the signer who pays the native-token deposit. */
export async function openDispute(
  server: rpc.Server,
  network: NetworkConfig,
  input: WriteInput & { readonly targetId: bigint; readonly opening: DisputeOpening },
): Promise<SubmitResult> {
  positiveU64(input.targetId, "the target ID");
  if (input.opening.kind === "inclusion" && input.opening.attestationId >= input.targetId) {
    throw new DisputeInputError("the evidence attestation must be older than the target");
  }
  return submit(server, network, input, "open_dispute", [
    nativeToScVal(Address.fromString(input.asset)),
    nativeToScVal(Address.fromString(input.sourceSigner.publicKey())),
    nativeToScVal(input.targetId, { type: "u64" }),
    openingValue(input.opening),
  ]);
}

/** Answers a fixed dispute. The signer must hold authority for the asset. */
export async function answerDispute(
  server: rpc.Server,
  network: NetworkConfig,
  input: WriteInput & { readonly targetId: bigint; readonly evidence: InclusionEvidence },
): Promise<SubmitResult> {
  positiveU64(input.targetId, "the target ID");
  return submit(server, network, input, "answer_dispute", [
    nativeToScVal(Address.fromString(input.asset)),
    nativeToScVal(input.targetId, { type: "u64" }),
    inclusionValue(input.evidence),
  ]);
}

/** Resolves an unanswered dispute after its contract deadline. Any signer can pay the fee. */
export async function resolveDispute(
  server: rpc.Server,
  network: NetworkConfig,
  input: WriteInput & { readonly targetId: bigint; readonly identifier: bigint },
): Promise<SubmitResult> {
  positiveU64(input.targetId, "the target ID");
  validIdentifier(input.identifier);
  return submit(server, network, input, "resolve_dispute", [
    nativeToScVal(Address.fromString(input.asset)),
    nativeToScVal(input.targetId, { type: "u64" }),
    nativeToScVal(input.identifier, { type: "u256" }),
  ]);
}
