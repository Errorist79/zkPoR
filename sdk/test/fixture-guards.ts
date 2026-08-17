/**
 * The checks that establish the shape of a committed fixture.
 *
 * The shared Rust crate generates each fixture file. A test that read such a
 * file through a claim about its type would report a change of the generator as
 * a failure inside an expectation, or would not report it at all. Each check
 * below reads the file once and states what the file holds, so a change of the
 * shape fails with a message that names the file.
 */

import { isRecord, isStringList } from "../src/guards.js";

/** The element of a list at one position. A missing element fails the test. */
export function elementAt<T>(list: readonly T[], index: number, label: string): T {
  const element = list[index];
  if (element === undefined) {
    throw new Error(`the ${label} holds no element at the position ${index}`);
  }
  return element;
}

/** The value of a map under one key. A missing value fails the test. */
export function valueOf<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`the ${label} gives no value for ${String(key)}`);
  }
  return value;
}

/** The capture group of a match. A missing group fails the test. */
export function captureOf(match: RegExpMatchArray, index: number, label: string): string {
  const group = match[index];
  if (group === undefined) {
    throw new Error(`the match of the ${label} holds no group ${index}`);
  }
  return group;
}

/** True when the value is a list. Each element stays unknown. */
export function isUnknownList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** True when the value is an object and every field of it holds a string. */
export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((field) => typeof field === "string");
}

/** True when the value is an object and every field of it holds a string or a number. */
export function isConstantTable(value: unknown): value is Record<string, string | number> {
  return (
    isRecord(value) &&
    Object.values(value).every((field) => typeof field === "string" || typeof field === "number")
  );
}

function isList<T>(
  value: unknown,
  element: (candidate: unknown) => candidate is T,
): value is T[] {
  return Array.isArray(value) && value.every(element);
}

function isNumberList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((element) => typeof element === "number");
}

function hasStrings(source: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => typeof source[name] === "string");
}

function hasNumbers(source: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => typeof source[name] === "number");
}

export interface AddressVector {
  index: number;
  case: string;
  tag: number;
  payload: string;
  hi: string;
  lo: string;
}

export interface ContextVectors {
  constants: Record<string, string | number>;
  field_reductions: { case: string; input: string; in_range: boolean; reduced: string }[];
  addresses: AddressVector[];
  reserve_sets: { case: string; size: number; addresses: number[]; reserve_set_hash: string }[];
  contexts: {
    case: string;
    authority: number;
    asset: number;
    reserve_set: number;
    snapshot_ledger: number;
    context_hash: string;
  }[];
  nodes: { case: string; left: string; right: string; node: string }[];
  leaves: { case: string; id: string; balance: string; salt: string; leaf: string }[];
  salts: {
    case: string;
    master_secret: string;
    context: number;
    global_index: string;
    salt: string;
  }[];
}

/**
 * One leaf of a tree of the vector file.
 *
 * The listed leaves of a tree carry no sibling list. Only a path carries one,
 * so the sibling list belongs to the path and not to the leaf.
 */
export interface LeafVector {
  case: string;
  leaf_index: number;
  id: string;
  balance: string;
  salt: string;
  leaf: string;
}

export interface PathVector extends LeafVector {
  siblings: string[];
}

export interface PackageVectors {
  constants: Record<string, string | number>;
  leaf_rule: string;
  file_rule: string;
  trees: {
    case: string;
    depth: number;
    root: string;
    leaves?: LeafVector[];
    paths: PathVector[];
  }[];
  packages: { case: string; tree: number; filename: string; lines: string[] }[];
}

function isAddressVector(value: unknown): value is AddressVector {
  return (
    isRecord(value) &&
    hasNumbers(value, ["index", "tag"]) &&
    hasStrings(value, ["case", "payload", "hi", "lo"])
  );
}

function isFieldReduction(value: unknown): value is ContextVectors["field_reductions"][number] {
  return (
    isRecord(value) &&
    hasStrings(value, ["case", "input", "reduced"]) &&
    typeof value["in_range"] === "boolean"
  );
}

function isReserveSet(value: unknown): value is ContextVectors["reserve_sets"][number] {
  return (
    isRecord(value) &&
    hasStrings(value, ["case", "reserve_set_hash"]) &&
    hasNumbers(value, ["size"]) &&
    isNumberList(value["addresses"])
  );
}

function isContext(value: unknown): value is ContextVectors["contexts"][number] {
  return (
    isRecord(value) &&
    hasStrings(value, ["case", "context_hash"]) &&
    hasNumbers(value, ["authority", "asset", "reserve_set", "snapshot_ledger"])
  );
}

function isNode(value: unknown): value is ContextVectors["nodes"][number] {
  return isRecord(value) && hasStrings(value, ["case", "left", "right", "node"]);
}

function isLeaf(value: unknown): value is ContextVectors["leaves"][number] {
  return isRecord(value) && hasStrings(value, ["case", "id", "balance", "salt", "leaf"]);
}

function isSalt(value: unknown): value is ContextVectors["salts"][number] {
  return (
    isRecord(value) &&
    hasStrings(value, ["case", "master_secret", "global_index", "salt"]) &&
    hasNumbers(value, ["context"])
  );
}

function isContextVectors(value: unknown): value is ContextVectors {
  return (
    isRecord(value) &&
    isConstantTable(value["constants"]) &&
    isList(value["field_reductions"], isFieldReduction) &&
    isList(value["addresses"], isAddressVector) &&
    isList(value["reserve_sets"], isReserveSet) &&
    isList(value["contexts"], isContext) &&
    isList(value["nodes"], isNode) &&
    isList(value["leaves"], isLeaf) &&
    isList(value["salts"], isSalt)
  );
}

function isLeafVector(value: unknown): value is LeafVector {
  return (
    isRecord(value) &&
    hasStrings(value, ["case", "id", "balance", "salt", "leaf"]) &&
    hasNumbers(value, ["leaf_index"])
  );
}

function isPathVector(value: unknown): value is PathVector {
  return isRecord(value) && isLeafVector(value) && isStringList(value["siblings"]);
}

function isTree(value: unknown): value is PackageVectors["trees"][number] {
  if (!isRecord(value)) {
    return false;
  }
  const listed = value["leaves"];
  return (
    hasStrings(value, ["case", "root"]) &&
    hasNumbers(value, ["depth"]) &&
    isList(value["paths"], isPathVector) &&
    (listed === undefined || isList(listed, isLeafVector))
  );
}

function isPackage(value: unknown): value is PackageVectors["packages"][number] {
  return (
    isRecord(value) &&
    hasStrings(value, ["case", "filename"]) &&
    hasNumbers(value, ["tree"]) &&
    isStringList(value["lines"])
  );
}

function isPackageVectors(value: unknown): value is PackageVectors {
  return (
    isRecord(value) &&
    isConstantTable(value["constants"]) &&
    hasStrings(value, ["leaf_rule", "file_rule"]) &&
    isList(value["trees"], isTree) &&
    isList(value["packages"], isPackage)
  );
}

export interface AttestationExpectation {
  final_root: string;
  total_liabilities: string;
  snapshot_ledger: number;
  reserve_sum: string;
  attested_ledger: number;
}

export interface Expected {
  authority?: string;
  tier?: string;
  reserves?: string[];
  reserve_set_hash?: string;
  attestation?: AttestationExpectation | null;
  observed_sum?: string;
  observed_ledger?: number;
}

export interface Returns {
  constants: { attestation_event_topic: string };
  returns: { case: string; call: string; scval: string; expected: Expected }[];
  events: { case: string; topics: string[]; data: string }[];
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isAttestationExpectation(value: unknown): value is AttestationExpectation {
  return (
    isRecord(value) &&
    hasStrings(value, ["final_root", "total_liabilities", "reserve_sum"]) &&
    hasNumbers(value, ["snapshot_ledger", "attested_ledger"])
  );
}

function isExpected(value: unknown): value is Expected {
  if (!isRecord(value)) {
    return false;
  }
  const reserves = value["reserves"];
  const attestation = value["attestation"];
  const ledger = value["observed_ledger"];
  return (
    ["authority", "tier", "reserve_set_hash", "observed_sum"].every((name) =>
      isOptionalString(value[name]),
    ) &&
    (reserves === undefined || isStringList(reserves)) &&
    (ledger === undefined || typeof ledger === "number") &&
    (attestation === undefined ||
      attestation === null ||
      isAttestationExpectation(attestation))
  );
}

function isReturn(value: unknown): value is Returns["returns"][number] {
  return (
    isRecord(value) && hasStrings(value, ["case", "call", "scval"]) && isExpected(value["expected"])
  );
}

function isEvent(value: unknown): value is Returns["events"][number] {
  return isRecord(value) && hasStrings(value, ["case", "data"]) && isStringList(value["topics"]);
}

function isReturns(value: unknown): value is Returns {
  if (!isRecord(value)) {
    return false;
  }
  const constants = value["constants"];
  return (
    isRecord(constants) &&
    typeof constants["attestation_event_topic"] === "string" &&
    isList(value["returns"], isReturn) &&
    isList(value["events"], isEvent)
  );
}

/** The context vector file, after one check of its whole shape. */
export function contextVectors(text: string): ContextVectors {
  const value: unknown = JSON.parse(text);
  if (!isContextVectors(value)) {
    throw new Error("the context vector file does not hold the shape that these tests read");
  }
  return value;
}

/** The package vector file, after one check of its whole shape. */
export function packageVectors(text: string): PackageVectors {
  const value: unknown = JSON.parse(text);
  if (!isPackageVectors(value)) {
    throw new Error("the package vector file does not hold the shape that these tests read");
  }
  return value;
}

/** The registry return file, after one check of its whole shape. */
export function registryReturns(text: string): Returns {
  const value: unknown = JSON.parse(text);
  if (!isReturns(value)) {
    throw new Error("the registry return file does not hold the shape that these tests read");
  }
  return value;
}

/** The decoded value, when it is an object. Another shape fails the test. */
export function decodedRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`the decoded value is no object, and its value is ${String(value)}`);
  }
  return value;
}
