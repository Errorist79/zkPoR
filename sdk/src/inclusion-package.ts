/**
 * The inclusion package: its schema, its deterministic layout, and its reader.
 *
 * One file travels from the authority to one customer. The file reveals that
 * customer's balance to anyone who reads it, so every tool that touches it
 * states that plainly.
 *
 * This package reads and validates a file. It never writes a customer file:
 * the generation gate lives in the generator, and a second writer of
 * per-customer files would double the surface that touches sensitive data.
 * The writer below exists only so a test can prove that this implementation
 * reaches the same bytes as the generator.
 */

import {
  JSON_INDENT,
  PACKAGE_EXTENSION,
  PACKAGE_FIELDS,
  PACKAGE_FORMAT,
  PACKAGE_INDEX_DIGITS,
  PADDING_LEAF_ID,
} from "./constants.js";
import { parseHex, parseU32, parseU64Decimal, toHex } from "./fr.js";
import { isRecord, messageOf } from "./guards.js";

/** The parsed content of one inclusion package. */
export interface InclusionPackage {
  readonly format: string;
  readonly network: string;
  readonly registry: string;
  readonly asset: string;
  readonly snapshotLedger: number;
  readonly leafIndex: number;
  readonly id: bigint;
  readonly balance: bigint;
  readonly salt: bigint;
  readonly siblings: readonly bigint[];
}

/** A package whose `format` string this reader does not recognize. */
export class UnsupportedFormatError extends Error {
  constructor(readonly found: string) {
    super(
      `this reader supports the format ${PACKAGE_FORMAT} only, and the package names ${found}`,
    );
    this.name = "UnsupportedFormatError";
  }
}

/** A package that breaks a rule of the schema. */
export class MalformedPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedPackageError";
  }
}

function malformed(message: string): never {
  throw new MalformedPackageError(message);
}

/**
 * Runs one field check and reports its failure as a malformed package.
 *
 * A field check states the rule it broke. The class of the failure belongs to
 * the reader, because a caller separates a malformed package from a failure
 * that gives no verdict at all.
 */
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof MalformedPackageError) {
      throw cause;
    }
    malformed(messageOf(cause));
  }
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    malformed(`the field ${key} must be a string`);
  }
  return value;
}

/**
 * Reads one package.
 *
 * The `format` string is the version gate, so the reader refuses an unknown
 * value before it reads any other field. A reader that tolerated an unknown
 * field would also tolerate a package that carries a root, which the schema
 * forbids, and a tolerance rule is very hard to tighten later.
 */
export function parsePackage(text: string): InclusionPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    malformed(`the package is not valid JSON: ${messageOf(cause)}`);
  }
  if (!isRecord(parsed)) {
    malformed("the package is a JSON object");
  }
  const source = parsed;

  const format = source["format"];
  if (format === undefined) {
    malformed("the package carries no format field");
  }
  if (typeof format !== "string") {
    malformed("the field format must be a string");
  }
  if (format !== PACKAGE_FORMAT) {
    throw new UnsupportedFormatError(format);
  }

  for (const key of Object.keys(source)) {
    if (!PACKAGE_FIELDS.some((field) => field === key)) {
      malformed(`the format ${PACKAGE_FORMAT} does not name the field ${key}`);
    }
  }
  for (const key of PACKAGE_FIELDS) {
    if (source[key] === undefined) {
      malformed(`the package carries no field ${key}`);
    }
  }

  const siblingsValue = source["siblings"];
  if (!Array.isArray(siblingsValue)) {
    malformed("the field siblings must be an array");
  }
  // The narrowing of Array.isArray gives a list of any, so the element is
  // named unknown here and the check below establishes what it is.
  const siblings = siblingsValue.map((sibling: unknown, level: number) => {
    if (typeof sibling !== "string") {
      malformed(`the sibling hash at level ${level} must be a string`);
    }
    return checked(() => parseHex(sibling, `the sibling hash at level ${level}`));
  });

  const id = checked(() => parseHex(stringField(source, "id"), "the identifier"));
  if (id === PADDING_LEAF_ID) {
    malformed("the identifier zero names a padding leaf, and no customer package names it");
  }

  return {
    format,
    network: stringField(source, "network"),
    registry: stringField(source, "registry"),
    asset: stringField(source, "asset"),
    snapshotLedger: checked(() => parseU32(source["snapshot_ledger"], "the snapshot ledger")),
    leafIndex: checked(() => parseU32(source["leaf_index"], "the leaf index")),
    id,
    balance: checked(() => parseU64Decimal(stringField(source, "balance"), "the balance")),
    salt: checked(() => parseHex(stringField(source, "salt"), "the salt")),
    siblings,
  };
}

/**
 * Checks the package against the tree depth that the deployment records.
 *
 * The sibling count must equal that depth. A leaf index at or above the
 * capacity of that depth is malformed, because the walk reads only the low
 * bits of the index.
 */
export function checkDepth(entry: InclusionPackage, treeDepth: number): void {
  if (entry.siblings.length !== treeDepth) {
    malformed(
      `the deployment records a tree depth of ${treeDepth}, and the package carries ${entry.siblings.length} sibling hashes`,
    );
  }
  if (BigInt(entry.leafIndex) >= 2n ** BigInt(treeDepth)) {
    malformed(
      `the leaf index ${entry.leafIndex} is outside a tree of depth ${treeDepth}`,
    );
  }
}

/**
 * Writes one package in the deterministic layout of the schema, so that two
 * implementations produce byte-identical files.
 *
 * The layout is the keys in the order of the schema, an indentation of two
 * spaces, one element per line, and one line feed at the end.
 */
export function serializePackage(entry: InclusionPackage): string {
  const ordered = {
    format: PACKAGE_FORMAT,
    network: entry.network,
    registry: entry.registry,
    asset: entry.asset,
    snapshot_ledger: entry.snapshotLedger,
    leaf_index: entry.leafIndex,
    id: toHex(entry.id),
    balance: entry.balance.toString(10),
    salt: toHex(entry.salt),
    siblings: entry.siblings.map((sibling) => toHex(sibling)),
  };
  return `${JSON.stringify(ordered, null, JSON_INDENT)}\n`;
}

/** The filename that the authority gives the package of one leaf. */
export function packageFilename(leafIndex: number): string {
  return `package-${String(leafIndex).padStart(PACKAGE_INDEX_DIGITS, "0")}.${PACKAGE_EXTENSION}`;
}
