/**
 * The registry client: the asset record, the reserve observation, and the
 * attestation history.
 *
 * Every read runs as a simulation of a call, so no read costs a fee and no
 * read needs a signature. The registry returns each record as a map keyed by
 * the field name, so this client reads each field by its name and never by a
 * position.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { ATTESTATION_MAX_AGE_LEDGERS, HISTORY_PAGE_LIMIT, MAX_U64, SUBMISSION_TIMEOUT_SECONDS } from "./constants.js";
import { InfrastructureError, openServer, retainedLedgers } from "./network.js";
import { isRecord, isStringList } from "./guards.js";
import type { NetworkConfig } from "./network.js";
import {
  ASSET_NOT_REGISTERED,
  ATTESTATION_NOT_FOUND,
  OBSERVATION_NOT_FOUND,
  describeRegistryError,
  registryErrorCode,
} from "./registry-errors.js";
import { sendAndSettle } from "./registration.js";
import type { SubmitResult } from "./registration.js";

/** The topic symbol that the registry gives every attestation event. */
export const ATTESTATION_EVENT_TOPIC = "attestation_accepted";

/** The tier under which an asset registered. */
export type AssetTier = "ClassicIssuer" | "ContractAdministrator";

/** One accepted attestation, as the registry records it. */
export interface Attestation {
  readonly finalRoot: bigint;
  readonly totalLiabilities: bigint;
  readonly snapshotLedger: number;
  readonly reserveSum: bigint;
  readonly attestedLedger: number;
}

/** A fixed record from a registry that supports persistent history. */
export interface StoredAttestation extends Attestation {
  readonly attestationId: bigint;
  readonly contextHash: bigint;
}

/** The record of one registered asset. */
export interface AssetRecord {
  readonly authority: string;
  readonly tier: AssetTier;
  readonly reserves: readonly string[];
  readonly reserveSetHash: bigint;
  readonly attestation: Attestation | undefined;
}

/** A live simulation. It does not create an observation record. */
export interface ReserveObservation {
  readonly observedSum: bigint;
  readonly observedLedger: number;
  readonly supportsRecordedObservations: boolean;
}

/** One observation that a transaction stored in the registry. */
export interface StoredReserveObservation {
  readonly observationId: bigint;
  readonly observedSum: bigint;
  readonly observedLedger: number;
  readonly reserveSetHash: bigint;
  readonly attestationId: bigint | undefined;
  readonly belowAttested: boolean;
}

/** The permanent first-low marker and the number of stored observations. */
export interface ObservationStatus {
  readonly observationCount: bigint;
  readonly firstLowObservation: bigint | undefined;
}

/** A bounded range whose count is fixed before the first record read. */
export interface StoredObservationHistory {
  readonly observations: readonly StoredReserveObservation[];
  readonly totalCount: bigint;
  readonly nextId: bigint | undefined;
}

/** A call that the registry refused with a contract error code. */
export class RegistryRefusedError extends Error {
  constructor(readonly code: number) {
    super(describeRegistryError(code));
    this.name = "RegistryRefusedError";
  }
}

/**
 * The account that a read simulates as.
 *
 * A simulation moves no funds and pays no fee.
 *
 * The field stays open so a caller can name its own address, because another
 * endpoint may apply a rule of its own.
 */
export interface ReadOptions {
  readonly readSourceAccount?: string;
}

/** A caller can reuse its configured client for persistent history reads. */
export interface StoredReadOptions extends ReadOptions {
  readonly server?: rpc.Server;
}

/** One bounded range of persistent record identifiers. */
export interface StoredHistoryOptions extends StoredReadOptions {
  readonly startId: bigint;
  readonly count: number;
}

/** The count is fixed before the first record read. Later attestations wait for the next query. */
export interface StoredAttestationHistory {
  readonly attestations: readonly StoredAttestation[];
  readonly totalCount: bigint;
  readonly nextId: bigint | undefined;
}

/**
 * The address that a read simulates as when a caller names none.
 *
 * The value is the account of the all-zero ed25519 key. No party holds the
 * secret key of it, and a read needs no signature, so the address carries no
 * capability. It is test data in the sense that it names nobody.
 */
export const DEFAULT_READ_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0));

function simulationSource(options: ReadOptions): Account {
  return new Account(options.readSourceAccount ?? DEFAULT_READ_SOURCE, "0");
}

/** Builds a call to one registry function, with the arguments in order. */
export function buildCall(
  config: NetworkConfig,
  options: ReadOptions,
  registry: string,
  method: string,
  args: readonly xdr.ScVal[],
) {
  const contract = new Contract(registry);
  return new TransactionBuilder(simulationSource(options), {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
}

/**
 * Simulates a call and returns the value it produced.
 *
 * A contract error becomes a refusal that names the error code. Every other
 * failure is an infrastructure failure, which is not a verdict.
 */
export async function simulateRead(
  server: rpc.Server,
  config: NetworkConfig,
  options: ReadOptions,
  registry: string,
  method: string,
  args: readonly xdr.ScVal[],
): Promise<unknown> {
  const transaction = buildCall(config, options, registry, method, args);
  let answer: rpc.Api.SimulateTransactionResponse;
  try {
    answer = await server.simulateTransaction(transaction);
  } catch (cause) {
    throw new InfrastructureError(`the client cannot simulate the call ${method}`, { cause });
  }
  if (rpc.Api.isSimulationError(answer)) {
    const code = registryErrorCode(answer.error);
    if (code !== undefined) {
      throw new RegistryRefusedError(code);
    }
    throw new InfrastructureError(`the simulation of the call ${method} failed: ${answer.error}`);
  }
  const returned = answer.result?.retval;
  if (returned === undefined) {
    throw new InfrastructureError(`the call ${method} returned no value`);
  }
  const native: unknown = scValToNative(returned);
  return native;
}

function mapField(source: unknown, key: string, method: string): unknown {
  if (!isRecord(source)) {
    throw new InfrastructureError(`the call ${method} returned no record`);
  }
  const value = source[key];
  if (value === undefined) {
    throw new InfrastructureError(`the record of the call ${method} carries no ${key}`);
  }
  return value;
}

function requireBigint(value: unknown, what: string): bigint {
  if (typeof value !== "bigint") {
    throw new InfrastructureError(`${what} is not an integer`);
  }
  return value;
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InfrastructureError(`${what} is not a ledger sequence`);
  }
  return value;
}

/**
 * Reads the name of a variant that the registry returns.
 *
 * A variant without a payload arrives as a list of one symbol, and a variant
 * with a payload arrives as the symbol and the payload.
 */
function variantOf(value: unknown, what: string): { name: string; payload: unknown } {
  if (!Array.isArray(value)) {
    throw new InfrastructureError(`${what} is not a variant`);
  }
  // The narrowing of Array.isArray gives a list of any, so both elements are
  // read as unknown and the check below establishes the name.
  const elements: unknown[] = value;
  const name: unknown = elements[0];
  if (typeof name !== "string") {
    throw new InfrastructureError(`${what} names no case`);
  }
  return { name, payload: elements[1] };
}

/**
 * Reads one attestation out of the value that the host returned.
 *
 * The asset record and attestation event share five public snapshot fields,
 * keyed by name in both, so one reader serves both. The
 * `source` names the place a failure came from.
 *
 * The decoders below take a value and return a record. They reach no network,
 * so a test runs the same code that a live read runs. A test that read the
 * fields itself would check a second implementation and leave this one free to
 * drift.
 */
export function decodeAttestation(payload: unknown, source: string): Attestation {
  return {
    finalRoot: requireBigint(mapField(payload, "final_root", source), "the attested root"),
    totalLiabilities: requireBigint(
      mapField(payload, "total_liabilities", source),
      "the total liabilities",
    ),
    snapshotLedger: requireNumber(
      mapField(payload, "snapshot_ledger", source),
      "the snapshot ledger",
    ),
    reserveSum: requireBigint(mapField(payload, "reserve_sum", source), "the reserve sum"),
    attestedLedger: requireNumber(
      mapField(payload, "attested_ledger", source),
      "the attested ledger",
    ),
  };
}

/** Reads the direct struct that get_attestation returns. */
export function decodeStoredAttestation(payload: unknown, id: bigint): StoredAttestation {
  return {
    ...decodeAttestation(payload, "get_attestation"),
    attestationId: id,
    contextHash: requireBigint(
      mapField(payload, "context_hash", "get_attestation"),
      "the attested context hash",
    ),
  };
}

/**
 * Reads the record of one asset out of the value that the host returned.
 *
 * A case that this client does not name stops the read. A later registry can
 * add a tier or a state of the attestation slot, and a client that guessed at
 * an unknown case would report a value that the registry does not hold.
 */
export function decodeAssetRecord(returned: unknown): AssetRecord {
  const tier = variantOf(mapField(returned, "tier", "entry"), "the tier").name;
  if (tier !== "ClassicIssuer" && tier !== "ContractAdministrator") {
    throw new InfrastructureError(`the record names the tier ${tier}, which this client does not know`);
  }
  const reserves = mapField(returned, "reserves", "entry");
  if (!isStringList(reserves)) {
    throw new InfrastructureError("the record carries no reserve address list");
  }
  const slot = variantOf(mapField(returned, "attestation", "entry"), "the attestation");
  let attestation: Attestation | undefined;
  if (slot.name === "Filled") {
    attestation = decodeAttestation(slot.payload, "entry");
  } else if (slot.name !== "Empty") {
    throw new InfrastructureError(
      `the record names the attestation state ${slot.name}, which this client does not know`,
    );
  }

  const authority = mapField(returned, "authority", "entry");
  if (typeof authority !== "string") {
    throw new InfrastructureError("the record carries no authority address");
  }
  return {
    authority,
    tier,
    reserves,
    reserveSetHash: requireBigint(
      mapField(returned, "reserve_set_hash", "entry"),
      "the reserve set hash",
    ),
    attestation,
  };
}

/** Reads the reserve observation out of the value that the host returned. */
export function decodeReserveObservation(returned: unknown): ReserveObservation {
  const supportsRecordedObservations = isRecord(returned) &&
    ["observation_id", "reserve_set_hash", "attestation_id", "below_attested"].some(
      (key) => key in returned,
    );
  if (supportsRecordedObservations) {
    decodeStoredObservation(returned, "observe_reserves");
  }
  return {
    observedSum: requireBigint(
      mapField(returned, "observed_sum", "observe_reserves"),
      "the observed sum",
    ),
    observedLedger: requireNumber(
      mapField(returned, "observed_ledger", "observe_reserves"),
      "the observed ledger",
    ),
    supportsRecordedObservations,
  };
}

function requireOptionalId(source: unknown, key: string, method: string): bigint | undefined {
  if (!isRecord(source) || !(key in source)) {
    throw new InfrastructureError(`the record of the call ${method} carries no ${key}`);
  }
  const value: unknown = source[key];
  if (value === null) {
    return undefined;
  }
  return requireStoredId(value, key);
}

function requireStoredId(value: unknown, name: string): bigint {
  const id = requireBigint(value, name);
  if (id < 1n || id > MAX_U64) {
    throw new InfrastructureError(`${name} is outside the positive u64 range`);
  }
  return id;
}

/** Decodes a stored observation. A simulated return is not a stored record. */
export function decodeStoredObservation(
  returned: unknown,
  method = "get_observation",
): StoredReserveObservation {
  const belowAttested = mapField(returned, "below_attested", method);
  if (typeof belowAttested !== "boolean") {
    throw new InfrastructureError("the below-attested flag is not a boolean");
  }
  const attestationId = requireOptionalId(returned, "attestation_id", method);
  if (belowAttested && attestationId === undefined) {
    throw new InfrastructureError("a low observation names no baseline attestation");
  }
  return {
    observationId: requireStoredId(mapField(returned, "observation_id", method), "the observation identifier"),
    observedSum: requireBigint(mapField(returned, "observed_sum", method), "the observed sum"),
    observedLedger: requireNumber(mapField(returned, "observed_ledger", method), "the observed ledger"),
    reserveSetHash: requireBigint(mapField(returned, "reserve_set_hash", method), "the reserve set hash"),
    attestationId,
    belowAttested,
  };
}

/** Decodes the observation count and permanent first-low marker. */
export function decodeObservationStatus(returned: unknown): ObservationStatus {
  const observationCount = requireBigint(
    mapField(returned, "observation_count", "observation_status"),
    "the observation count",
  );
  if (observationCount < 0n || observationCount > MAX_U64) {
    throw new InfrastructureError("the observation count is outside the u64 range");
  }
  const firstLowObservation = requireOptionalId(returned, "first_low_observation", "observation_status");
  if (firstLowObservation !== undefined && firstLowObservation > observationCount) {
    throw new InfrastructureError("the first low observation exceeds the observation count");
  }
  return { observationCount, firstLowObservation };
}

/**
 * Reads one attestation event out of its decoded topics and its decoded data.
 *
 * The event carries two topics: the symbol of the event and the asset address.
 * A consumer that read the data by a position would break on a later field, so
 * the reader takes every value by its name.
 */
export function decodeAttestationEvent(
  topics: readonly unknown[],
  data: unknown,
): { asset: string; attestation: Attestation & { readonly attestationId?: bigint } } {
  const [name, asset] = topics;
  if (name !== ATTESTATION_EVENT_TOPIC) {
    throw new InfrastructureError(
      `the event names the topic ${String(name)}, and this client reads ${ATTESTATION_EVENT_TOPIC}`,
    );
  }
  if (typeof asset !== "string") {
    throw new InfrastructureError("the event carries no asset address as its second topic");
  }
  if (isRecord(data) && "attestation_id" in data) {
    const id = requireBigint(data["attestation_id"], "the attestation identifier");
    requireAttestationId(id);
    return { asset, attestation: { ...decodeAttestation(data, ATTESTATION_EVENT_TOPIC), attestationId: id } };
  }
  return { asset, attestation: decodeAttestation(data, ATTESTATION_EVENT_TOPIC) };
}

function requireAttestationId(id: bigint): void {
  if (id < 1n || id > MAX_U64) {
    throw new RangeError("the attestation identifier must be a positive u64");
  }
}

function requireObservationId(id: bigint): void {
  if (id < 1n || id > MAX_U64) {
    throw new RangeError("the observation identifier must be a positive u64");
  }
}

function requireHistoryCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > HISTORY_PAGE_LIMIT) {
    throw new RangeError(`the history count must be between 1 and ${HISTORY_PAGE_LIMIT}`);
  }
}

/** Reads one fixed record. This API requires a registry with persistent history. */
export async function readStoredAttestation(
  network: NetworkConfig,
  registry: string,
  asset: string,
  id: bigint,
  options: StoredReadOptions = {},
): Promise<StoredAttestation | undefined> {
  requireAttestationId(id);
  const server = options.server ?? openServer(network);
  let returned: unknown;
  try {
    returned = await simulateRead(server, network, options, registry, "get_attestation", [
      nativeToScVal(Address.fromString(asset)),
      nativeToScVal(id, { type: "u64" }),
    ]);
  } catch (cause) {
    if (
      cause instanceof RegistryRefusedError &&
      (cause.code === ASSET_NOT_REGISTERED || cause.code === ATTESTATION_NOT_FOUND)
    ) {
      return undefined;
    }
    throw cause;
  }
  return decodeStoredAttestation(returned, id);
}

/** Reads a bounded range from persistent storage without an event query. */
export async function readStoredAttestationHistory(
  network: NetworkConfig,
  registry: string,
  asset: string,
  options: StoredHistoryOptions,
): Promise<StoredAttestationHistory> {
  requireAttestationId(options.startId);
  requireHistoryCount(options.count);
  const server = options.server ?? openServer(network);
  const totalCount = requireBigint(
    await simulateRead(server, network, options, registry, "attestation_count", [
      nativeToScVal(Address.fromString(asset)),
    ]),
    "the attestation count",
  );
  if (totalCount < 0n || totalCount > MAX_U64) {
    throw new InfrastructureError("the attestation count is outside the u64 range");
  }
  const requestedEnd = options.startId + BigInt(options.count) - 1n;
  const endId = requestedEnd < totalCount ? requestedEnd : totalCount;
  const attestations: StoredAttestation[] = [];
  for (let id = options.startId; id <= endId; id += 1n) {
    const record = await readStoredAttestation(network, registry, asset, id, { ...options, server });
    if (record === undefined) {
      throw new InfrastructureError(`the attestation count includes the missing record ${id}`);
    }
    attestations.push(record);
  }
  return {
    attestations,
    totalCount,
    nextId: endId < totalCount ? endId + 1n : undefined,
  };
}

/**
 * The record of one asset, or nothing when the registry holds no record.
 *
 * A missing record is an answer, not a failure, so the caller separates it
 * from an infrastructure failure.
 */
export async function readAssetRecord(
  server: rpc.Server,
  config: NetworkConfig,
  options: ReadOptions,
  registry: string,
  asset: string,
): Promise<AssetRecord | undefined> {
  let returned: unknown;
  try {
    returned = await simulateRead(server, config, options, registry, "entry", [
      nativeToScVal(Address.fromString(asset)),
    ]);
  } catch (cause) {
    if (cause instanceof RegistryRefusedError && cause.code === ASSET_NOT_REGISTERED) {
      return undefined;
    }
    throw cause;
  }
  return decodeAssetRecord(returned);
}

/**
 * The current reserve sum of one asset.
 *
 * No attestation covers this value. It is an observation at the ledger it
 * names, and every interface must present it as such.
 */
export async function observeReserves(
  server: rpc.Server,
  config: NetworkConfig,
  options: ReadOptions,
  registry: string,
  asset: string,
): Promise<ReserveObservation> {
  const returned = await simulateRead(server, config, options, registry, "observe_reserves", [
    nativeToScVal(Address.fromString(asset)),
  ]);
  return decodeReserveObservation(returned);
}

/** Reads persistent status. A missing method or failed restoration remains an error. */
export async function readObservationStatus(
  network: NetworkConfig,
  registry: string,
  asset: string,
  options: StoredReadOptions = {},
): Promise<ObservationStatus | undefined> {
  const server = options.server ?? openServer(network);
  try {
    return decodeObservationStatus(await simulateRead(server, network, options, registry, "observation_status", [
      nativeToScVal(Address.fromString(asset)),
    ]));
  } catch (cause) {
    if (cause instanceof RegistryRefusedError && cause.code === ASSET_NOT_REGISTERED) {
      return undefined;
    }
    throw cause;
  }
}

/** Reads a fixed observation. Only explicit contract not-found errors mean absence. */
export async function readStoredObservation(
  network: NetworkConfig,
  registry: string,
  asset: string,
  id: bigint,
  options: StoredReadOptions = {},
): Promise<StoredReserveObservation | undefined> {
  requireObservationId(id);
  const server = options.server ?? openServer(network);
  let returned: unknown;
  try {
    returned = await simulateRead(server, network, options, registry, "get_observation", [
      nativeToScVal(Address.fromString(asset)),
      nativeToScVal(id, { type: "u64" }),
    ]);
  } catch (cause) {
    if (cause instanceof RegistryRefusedError &&
      (cause.code === ASSET_NOT_REGISTERED || cause.code === OBSERVATION_NOT_FOUND)) {
      return undefined;
    }
    throw cause;
  }
  const record = decodeStoredObservation(returned);
  if (record.observationId !== id) {
    throw new InfrastructureError(`the observation returned a different identifier from ${id}`);
  }
  return record;
}

/** Reads a bounded range from persistent storage, independent of event retention. */
export async function readStoredObservationHistory(
  network: NetworkConfig,
  registry: string,
  asset: string,
  options: StoredHistoryOptions,
): Promise<StoredObservationHistory> {
  requireObservationId(options.startId);
  requireHistoryCount(options.count);
  const server = options.server ?? openServer(network);
  const status = await readObservationStatus(network, registry, asset, { ...options, server });
  if (status === undefined) {
    throw new RegistryRefusedError(ASSET_NOT_REGISTERED);
  }
  const totalCount = status.observationCount;
  const requestedEnd = options.startId + BigInt(options.count) - 1n;
  const endId = requestedEnd < totalCount ? requestedEnd : totalCount;
  const observations: StoredReserveObservation[] = [];
  for (let id = options.startId; id <= endId; id += 1n) {
    const record = await readStoredObservation(network, registry, asset, id, { ...options, server });
    if (record === undefined) {
      throw new InfrastructureError(`the observation count includes the missing record ${id}`);
    }
    observations.push(record);
  }
  return { observations, totalCount, nextId: endId < totalCount ? endId + 1n : undefined };
}

/** Submits a real observation transaction. Its simulated identifier is never returned. */
export async function submitReserveObservation(
  server: rpc.Server,
  config: NetworkConfig,
  input: { sourceAccount: Account; sourceSigner: Keypair; registry: string; asset: string },
): Promise<SubmitResult> {
  const transaction = new TransactionBuilder(input.sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(input.registry).call("observe_reserves", nativeToScVal(Address.fromString(input.asset))))
    .setTimeout(SUBMISSION_TIMEOUT_SECONDS)
    .build();
  let answer: rpc.Api.SimulateTransactionResponse;
  try {
    answer = await server.simulateTransaction(transaction);
  } catch (cause) {
    throw new InfrastructureError("the client cannot simulate the observation transaction", { cause });
  }
  if (rpc.Api.isSimulationError(answer)) {
    const code = registryErrorCode(answer.error);
    if (code !== undefined) {
      throw new RegistryRefusedError(code);
    }
    throw new InfrastructureError(`the observation simulation failed: ${answer.error}`);
  }
  if (answer.result === undefined) {
    throw new InfrastructureError("the observation simulation returned no value");
  }
  const native: unknown = scValToNative(answer.result.retval);
  if (!decodeReserveObservation(native).supportsRecordedObservations) {
    throw new InfrastructureError("the registry does not support recorded observations");
  }
  const ready = rpc.assembleTransaction(transaction, answer).build();
  ready.sign(input.sourceSigner);
  return sendAndSettle(server, ready);
}

/** True when the solvency claim of a snapshot has lapsed at the current ledger. */
export function solvencyLapsed(snapshotLedger: number, currentLedger: number): boolean {
  return currentLedger > snapshotLedger + ATTESTATION_MAX_AGE_LEDGERS;
}

/** One attestation that the event stream records, with the ledger of its event. */
export interface AttestationEvent extends Attestation {
  readonly attestationId?: bigint;
  readonly ledger: number;
  readonly transactionHash: string;
}

/**
 * The result of a history query.
 *
 * The query answers from the retained ledger window of the endpoint only, so
 * the result states the oldest ledger that it covered. A reader must not
 * present a window-bounded result as the complete history.
 */
export interface AttestationHistory {
  readonly attestations: readonly AttestationEvent[];
  /** The oldest ledger that this query covered. */
  readonly oldestLedgerCovered: number;
  /** The oldest ledger that the endpoint still retains. */
  readonly oldestLedgerRetained: number;
  /** The latest ledger of the network at the time of the query. */
  readonly latestLedger: number;
  /** True when the query started at the oldest retained ledger of the endpoint. */
  readonly reachesTheRetentionLimit: boolean;
  /**
   * True when the query read every ledger from the start of the range to the
   * latest ledger.
   *
   * The endpoint reads a bounded count of ledgers for one request, so a page
   * that carries no event can mean that the read stopped before the end of the
   * range. When this is false, the result does not say whether an attestation
   * exists, and a caller must not report it as an absence.
   */
  readonly coversTheWholeRange: boolean;
}

/**
 * The ledger that one event cursor names, or `undefined` for a cursor that this
 * function cannot read.
 *
 * The cursor holds an event identifier and a field number, and the identifier
 * holds the ledger sequence in its high 32 bits. The caller compares the answer
 * with the latest ledger to learn whether the read reached the end of the
 * range.
 */
function ledgerOfEventCursor(cursor: string): number | undefined {
  const identifier = cursor.split("-")[0];
  if (identifier === undefined || !/^[0-9]+$/.test(identifier)) {
    return undefined;
  }
  return Number(BigInt(identifier) >> 32n);
}

/**
 * Reads the attestation history of one asset from the event stream.
 *
 * This reader also supports legacy registries whose earlier attestations exist
 * only in events. Persistent history uses readStoredAttestationHistory.
 *
 * A caller that names no ledger gets the whole window that the endpoint keeps.
 * That boundary is the endpoint's and not ours, which is the reason to take it:
 * every other start ledger is a count that somebody chooses, and a reader who
 * did not choose it reads a part of the record as the record. A caller that
 * names a ledger gets that ledger or the boundary, whichever is later.
 */
export async function readAttestationHistory(
  server: rpc.Server,
  registry: string,
  asset: string,
  fromLedger?: number,
): Promise<AttestationHistory> {
  const retained = await retainedLedgers(server);
  const startLedger =
    fromLedger === undefined ? retained.oldestLedger : Math.max(fromLedger, retained.oldestLedger);
  const topicFilter = [
    xdr.ScVal.scvSymbol(ATTESTATION_EVENT_TOPIC).toXDR("base64"),
    nativeToScVal(Address.fromString(asset)).toXDR("base64"),
  ];
  const filters: rpc.Api.EventFilter[] = [
    { type: "contract", contractIds: [registry], topics: [topicFilter] },
  ];
  const attestations: AttestationEvent[] = [];
  let cursor: string | undefined;
  let oldestLedgerRetained = retained.oldestLedger;
  let latest = retained.latestLedger;
  let coversTheWholeRange = false;
  for (;;) {
    let page: rpc.Api.GetEventsResponse;
    try {
      page = await server.getEvents(
        cursor === undefined
          ? { startLedger, filters, limit: HISTORY_PAGE_LIMIT }
          : { cursor, filters, limit: HISTORY_PAGE_LIMIT },
      );
    } catch (cause) {
      throw new InfrastructureError("the client cannot read the attestation events", { cause });
    }
    oldestLedgerRetained = page.oldestLedger;
    latest = page.latestLedger;
    for (const event of page.events) {
      const topics = event.topic.map((topic): unknown => scValToNative(topic));
      // The filter of the query already names the topic and the asset, so an
      // event of another shape here is a failure and not a value to skip.
      const data: unknown = scValToNative(event.value);
      const decoded = decodeAttestationEvent(topics, data);
      if (decoded.asset !== asset) {
        continue;
      }
      attestations.push({
        ...decoded.attestation,
        ledger: event.ledger,
        transactionHash: event.txHash,
      });
    }
    // The endpoint reads a bounded count of ledgers for one request and returns
    // a cursor at the ledger where it stopped. A page that carries no event
    // therefore means "the read found nothing so far", and not "the range holds
    // nothing". A loop that stops on a short page reports an asset that has six
    // attestations as an asset that has none. On the public test endpoint a
    // request that starts 17,288 ledgers back returns no event, a request that
    // starts 12,160 ledgers back returns no event, and a request that starts
    // 7,160 ledgers back returns all six, because one request reads about
    // 10,000 ledgers. That count is a property of the endpoint, so the loop
    // reads the cursor instead of naming the count.
    const reached = ledgerOfEventCursor(page.cursor);
    if (reached === undefined) {
      // The cursor is unreadable, so the loop cannot establish the coverage.
      // It stops, and the result says that it did not cover the whole range.
      break;
    }
    if (reached >= latest) {
      coversTheWholeRange = true;
      break;
    }
    if (page.cursor === cursor) {
      // The cursor does not advance, so another request repeats this one.
      break;
    }
    cursor = page.cursor;
  }
  attestations.sort((left, right) => left.ledger - right.ledger);
  return {
    attestations,
    oldestLedgerCovered: startLedger,
    oldestLedgerRetained,
    latestLedger: latest,
    reachesTheRetentionLimit: startLedger <= oldestLedgerRetained,
    coversTheWholeRange,
  };
}

/** The network passphrase of a network that the Stellar library names. */
export function passphraseOfNetwork(network: string): string | undefined {
  const known: Record<string, string> = {
    testnet: Networks.TESTNET,
    mainnet: Networks.PUBLIC,
    futurenet: Networks.FUTURENET,
  };
  return known[network];
}
