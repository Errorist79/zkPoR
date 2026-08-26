/**
 * The generated circuit manifest, and the public input vector it describes.
 *
 * The manifest is the generated artifact that states the position of each
 * public input. A consumer must read the positions from it. A consumer must
 * not locate a public input by its value, and it must not hard-code a
 * position: two public inputs can hold the same field value, so a search by
 * value can find the wrong position.
 */

import { FR_BYTES, PUBLIC_INPUT_BYTES, PUBLIC_INPUT_COUNT } from "./constants.js";
import { bytesToBigint, inRange, toBytes } from "./fr.js";
import { isRecord, messageOf } from "./guards.js";

/** The name of each element of the aggregator public input vector. */
export const PUBLIC_INPUT_NAMES = ["context_hash", "inner_key_hash", "final_root", "L"] as const;

/** A name of one element of the public input vector. */
export type PublicInputName = (typeof PUBLIC_INPUT_NAMES)[number];

/** The values of the manifest that a client reads. */
export interface Manifest {
  readonly batchB: number;
  readonly numBatchesK: number;
  readonly treeDepth: number;
  readonly bbVersion: string;
  readonly nargoVersion: string;
  readonly proofScheme: string;
  readonly terminalOracleHash: string;
  readonly innerOracleHash: string;
  readonly innerKeyHash: bigint;
  readonly aggregatorKeySha256: string;
  readonly publicInputPositions: ReadonlyMap<PublicInputName, number>;
}

/** A manifest that this parser cannot read. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(`the manifest carries no ${key}`);
  }
  return value;
}

function powerOfTwoField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2) {
    throw new ManifestError(`the manifest carries no ${key}`);
  }
  if ((value & (value - 1)) !== 0) {
    throw new ManifestError(`the manifest value ${key} is not a power of two`);
  }
  return value;
}

/** Reads the manifest. */
export function parseManifest(text: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ManifestError(`the manifest is not valid JSON: ${messageOf(cause)}`);
  }
  if (!isRecord(parsed)) {
    throw new ManifestError("the manifest is a JSON object");
  }
  const source = parsed;

  const count = source["public_input_count"];
  if (count !== PUBLIC_INPUT_COUNT) {
    throw new ManifestError(
      `this client reads a public input vector of ${PUBLIC_INPUT_COUNT} elements, and the manifest names ${String(count)}`,
    );
  }
  const bytes = source["public_input_bytes"];
  if (bytes !== PUBLIC_INPUT_BYTES) {
    throw new ManifestError(
      `this client reads a public input string of ${PUBLIC_INPUT_BYTES} bytes, and the manifest names ${String(bytes)}`,
    );
  }

  const positionsValue = source["public_input_positions"];
  if (!isRecord(positionsValue)) {
    throw new ManifestError("the manifest carries no public_input_positions");
  }
  const positionsSource = positionsValue;
  const positions = new Map<PublicInputName, number>();
  for (const name of PUBLIC_INPUT_NAMES) {
    const position = positionsSource[name];
    if (typeof position !== "number" || !Number.isInteger(position)) {
      throw new ManifestError(`the manifest gives no position for the public input ${name}`);
    }
    if (position < 0 || position >= PUBLIC_INPUT_COUNT) {
      throw new ManifestError(`the position of the public input ${name} is outside the vector`);
    }
    positions.set(name, position);
  }
  const taken = new Set(positions.values());
  if (taken.size !== PUBLIC_INPUT_NAMES.length) {
    throw new ManifestError("the manifest gives one position to two public inputs");
  }

  const batchB = powerOfTwoField(source, "batch_b");
  const numBatchesK = powerOfTwoField(source, "num_batches_k");
  const innerKeyHash = source["inner_key_hash"];
  if (typeof innerKeyHash !== "string" || !/^[0-9]+$/.test(innerKeyHash)) {
    throw new ManifestError("the manifest carries no inner_key_hash");
  }

  return {
    batchB,
    numBatchesK,
    treeDepth: Math.log2(batchB) + Math.log2(numBatchesK),
    bbVersion: stringField(source, "bb_version"),
    nargoVersion: stringField(source, "nargo_version"),
    proofScheme: stringField(source, "proof_scheme"),
    terminalOracleHash: stringField(source, "terminal_oracle_hash"),
    innerOracleHash: stringField(source, "inner_oracle_hash"),
    innerKeyHash: BigInt(innerKeyHash),
    aggregatorKeySha256: stringField(source, "aggregator_key_sha256"),
    publicInputPositions: positions,
  };
}

/**
 * The serialized public input vector.
 *
 * The string is the concatenation of the elements in position order, each 32
 * bytes big-endian, with no length prefix, no separator, and no padding. The
 * pairing point accumulator occupies no slot here: it travels inside the proof
 * bytes.
 */
export function serializePublicInputs(
  manifest: Manifest,
  values: Readonly<Record<PublicInputName, bigint>>,
): Uint8Array {
  const output = new Uint8Array(PUBLIC_INPUT_BYTES);
  for (const name of PUBLIC_INPUT_NAMES) {
    output.set(toBytes(values[name]), positionOf(manifest, name) * FR_BYTES);
  }
  return output;
}

function positionOf(manifest: Manifest, name: PublicInputName): number {
  const position = manifest.publicInputPositions.get(name);
  if (position === undefined) {
    throw new ManifestError(`the manifest gives no position for the public input ${name}`);
  }
  return position;
}

/**
 * Reads the serialized public input vector that the prover wrote.
 *
 * The reader takes the position of each element from the manifest. It must not
 * search the string for a value, because two elements can hold the same value
 * and a search would then find the wrong position.
 */
export function readPublicInputs(
  manifest: Manifest,
  bytes: Uint8Array,
): Record<PublicInputName, bigint> {
  if (bytes.length !== PUBLIC_INPUT_BYTES) {
    throw new ManifestError(
      `the public input string holds ${PUBLIC_INPUT_BYTES} bytes, and this one holds ${bytes.length}`,
    );
  }
  const read = (name: PublicInputName): bigint => {
    const position = positionOf(manifest, name);
    const value = bytesToBigint(bytes.subarray(position * FR_BYTES, (position + 1) * FR_BYTES));
    if (!inRange(value)) {
      throw new ManifestError(`the public input ${name} is not a field element`);
    }
    return value;
  };
  // The object names every element of the vector, so the type checker sees a
  // complete record instead of one that a claim declares complete.
  return {
    context_hash: read("context_hash"),
    inner_key_hash: read("inner_key_hash"),
    final_root: read("final_root"),
    L: read("L"),
  };
}
