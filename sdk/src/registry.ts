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
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  ATTESTATION_MAX_AGE_LEDGERS,
  HISTORY_DEFAULT_LEDGERS,
  HISTORY_PAGE_LIMIT,
} from "./constants.js";
import { InfrastructureError, retainedLedgers } from "./network.js";
import { isRecord, isStringList } from "./guards.js";
import type { NetworkConfig } from "./network.js";
import {
  ASSET_NOT_REGISTERED,
  describeRegistryError,
  registryErrorCode,
} from "./registry-errors.js";

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

/** The record of one registered asset. */
export interface AssetRecord {
  readonly authority: string;
  readonly tier: AssetTier;
  readonly reserves: readonly string[];
  readonly reserveSetHash: bigint;
  readonly attestation: Attestation | undefined;
}

/** The current reserve sum, and the ledger at which the registry read it. */
export interface ReserveObservation {
  readonly observedSum: bigint;
  readonly observedLedger: number;
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
 * A simulation moves no funds and pays no fee. A run against the Stellar test
 * network endpoint confirmed that a read simulates the same way as an account
 * that the network does not hold and as a funded account: both returned the
 * same answer. The address therefore only has to be well formed.
 *
 * The field stays open so a caller can name its own address, because another
 * endpoint may apply a rule of its own.
 */
export interface ReadOptions {
  readonly readSourceAccount?: string;
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
 * The registry gives the same five fields to the asset record and to the
 * attestation event, keyed by name in both, so one reader serves both. The
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
  return {
    observedSum: requireBigint(
      mapField(returned, "observed_sum", "observe_reserves"),
      "the observed sum",
    ),
    observedLedger: requireNumber(
      mapField(returned, "observed_ledger", "observe_reserves"),
      "the observed ledger",
    ),
  };
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
): { asset: string; attestation: Attestation } {
  const [name, asset] = topics;
  if (name !== ATTESTATION_EVENT_TOPIC) {
    throw new InfrastructureError(
      `the event names the topic ${String(name)}, and this client reads ${ATTESTATION_EVENT_TOPIC}`,
    );
  }
  if (typeof asset !== "string") {
    throw new InfrastructureError("the event carries no asset address as its second topic");
  }
  return { asset, attestation: decodeAttestation(data, ATTESTATION_EVENT_TOPIC) };
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

/**
 * The ledger that a history query reaches back to, from the latest one.
 *
 * The command line and the dashboard cover the same range for one asset, so the
 * range has one definition. A ledger sequence never goes below zero.
 */
export function defaultHistoryStart(latestLedger: number): number {
  return Math.max(latestLedger - HISTORY_DEFAULT_LEDGERS, 0);
}

/** True when the solvency claim of a snapshot has lapsed at the current ledger. */
export function solvencyLapsed(snapshotLedger: number, currentLedger: number): boolean {
  return currentLedger > snapshotLedger + ATTESTATION_MAX_AGE_LEDGERS;
}

/** One attestation that the event stream records, with the ledger of its event. */
export interface AttestationEvent extends Attestation {
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
}

/**
 * Reads the attestation history of one asset from the event stream.
 *
 * The asset entry holds the latest attestation only, so the events are the one
 * record of the earlier attestations. The query starts at the requested ledger
 * or at the oldest retained ledger, whichever is later.
 */
export async function readAttestationHistory(
  server: rpc.Server,
  registry: string,
  asset: string,
  fromLedger: number,
): Promise<AttestationHistory> {
  const retained = await retainedLedgers(server);
  const startLedger = Math.max(fromLedger, retained.oldestLedger);
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
    if (page.events.length < HISTORY_PAGE_LIMIT) {
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
