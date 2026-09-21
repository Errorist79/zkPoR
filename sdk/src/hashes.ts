/**
 * The four named hashes of this protocol: the context hash, the salt
 * derivation, the leaf, and the tree node.
 *
 * The shared Rust crate is the definition of every algorithm here. This file
 * is the mirror, and a test compares it against the committed vectors.
 */

import type { Address } from "@stellar/stellar-sdk";
import {
  BALANCE_DOMAIN_TAG_TEXT,
  CTX_DOMAIN_TAG_TEXT,
  LEAF_DOMAIN_TAG_TEXT,
  MAX_U32,
  MAX_U64,
  SALT_DOMAIN_TAG_TEXT,
} from "./constants.js";
import { encodeAddress } from "./address.js";
import { domainTag, inRange } from "./fr.js";
import { hash } from "./poseidon.js";

/** The domain tag that versions the context preimage layout. */
export const CTX_DOMAIN_TAG = domainTag(CTX_DOMAIN_TAG_TEXT);

/** The domain tag that separates the salt derivation from every other hash. */
export const SALT_DOMAIN_TAG = domainTag(SALT_DOMAIN_TAG_TEXT);

/** The domain tag of the balance commitment. */
export const BALANCE_DOMAIN_TAG = domainTag(BALANCE_DOMAIN_TAG_TEXT);

/** The domain tag of the customer leaf. */
export const LEAF_DOMAIN_TAG = domainTag(LEAF_DOMAIN_TAG_TEXT);

function requireLedger(ledger: number, field: string): void {
  if (!Number.isInteger(ledger) || ledger < 0 || ledger > MAX_U32) {
    throw new Error(`${field} must be a ledger sequence that a u32 holds`);
  }
}

/**
 * The value that binds an attestation to one authority, one asset, one reserve
 * address set, and one snapshot ledger.
 */
export function contextHash(input: {
  authority: string | Address;
  asset: string | Address;
  reserveSetHash: bigint;
  snapshotLedger: number;
}): bigint {
  requireLedger(input.snapshotLedger, "the snapshot ledger");
  if (!inRange(input.reserveSetHash)) {
    throw new Error("the reserve set hash is not a field element");
  }
  const authority = encodeAddress(input.authority);
  const asset = encodeAddress(input.asset);
  return hash([
    CTX_DOMAIN_TAG,
    authority.hi,
    authority.lo,
    asset.hi,
    asset.lo,
    input.reserveSetHash,
    BigInt(input.snapshotLedger),
  ]);
}

/**
 * The blinding value of one leaf.
 *
 * The derivation runs outside every circuit. The master secret never enters a
 * witness and never enters a distributed file. A leaked salt exposes exactly
 * one leaf; a leaked master secret exposes every leaf of every context that
 * used it.
 */
export function deriveSalt(input: {
  masterSecret: bigint;
  contextHash: bigint;
  globalIndex: bigint;
}): bigint {
  if (!inRange(input.masterSecret)) {
    throw new Error("the master secret is not a field element");
  }
  if (!inRange(input.contextHash)) {
    throw new Error("the context hash is not a field element");
  }
  if (input.globalIndex < 0n) {
    throw new Error("a global leaf index is not negative");
  }
  return hash([SALT_DOMAIN_TAG, input.masterSecret, input.contextHash, input.globalIndex]);
}

/**
 * The commitment to one customer balance.
 *
 * The salt makes the leaf hash unguessable. Balances have low entropy, so an
 * unsalted sibling hash would fall to a search over plausible pairs of an
 * identifier and a balance.
 */
export function balanceCommitment(input: { balance: bigint; salt: bigint }): bigint {
  if (input.balance < 0n || input.balance > MAX_U64) {
    throw new Error("the balance is not a u64");
  }
  if (!inRange(input.salt)) {
    throw new Error("the salt is not a field element");
  }
  return hash([BALANCE_DOMAIN_TAG, input.balance, input.salt]);
}

/** The leaf that binds one identifier to a balance commitment. */
export function leafHash(input: { id: bigint; commitment: bigint }): bigint {
  if (!inRange(input.id)) {
    throw new Error("the identifier is not a field element");
  }
  if (!inRange(input.commitment)) {
    throw new Error("the commitment is not a field element");
  }
  return hash([LEAF_DOMAIN_TAG, input.id, input.commitment]);
}

/** The parent of two nodes of the liabilities tree. */
export function nodeHash(left: bigint, right: bigint): bigint {
  return hash([left, right]);
}
