/**
 * The mirror test.
 *
 * The shared Rust crate is the definition of every algorithm of the protocol,
 * and it generates the vector files. This test reproduces every value in them.
 * A mismatch here means this implementation computes another function than the
 * registry and the circuits, so the test fails on any difference.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  ADDRESS_LIMB_BYTES,
  ADDRESS_PAYLOAD_BYTES,
  ADDRESS_TAG_ACCOUNT,
  ADDRESS_TAG_CONTRACT,
  ATTESTATION_MAX_AGE_LEDGERS,
  FR_BYTES,
  FR_MODULUS,
  MAX_RESERVE_ADDRESSES,
  PACKAGE_EXTENSION,
  PACKAGE_FORMAT,
  PACKAGE_INDEX_DIGITS,
  PADDING_LEAF_BALANCE,
  PADDING_LEAF_ID,
  POSEIDON2_STATE_WIDTH,
  JSON_INDENT,
} from "../src/constants.js";
import { bytesFromHex, inRange, reduce, toHex, toHex32 } from "../src/fr.js";
import { addressParts, encodeAddress, reserveSetHash } from "../src/address.js";
import {
  CTX_DOMAIN_TAG,
  SALT_DOMAIN_TAG,
  contextHash,
  deriveSalt,
  leafHash,
  nodeHash,
} from "../src/hashes.js";
import { rootFromPath, treeRoot } from "../src/tree.js";
import { packageFilename, parsePackage, serializePackage } from "../src/inclusion-package.js";
import type { AddressVector } from "./fixture-guards.js";
import { contextVectors, elementAt, packageVectors } from "./fixture-guards.js";

const ROOT = join(import.meta.dirname, "..", "..");

const context = contextVectors(readFileSync(join(ROOT, "fixtures", "context_vectors.json"), "utf8"));
const packages = packageVectors(readFileSync(join(ROOT, "fixtures", "package_vectors.json"), "utf8"));

/**
 * The strkey of one address of the table.
 *
 * The vector file carries the tag and the payload, so the test rebuilds the
 * strkey of each entry and then runs the same public functions that a caller
 * of this package runs. A test that rebuilt the limbs itself would prove the
 * arithmetic of the file and leave the encoder of this package uncovered.
 */
function strkeyOf(vector: AddressVector): string {
  const payload = Buffer.from(bytesFromHex(vector.payload));
  expect(payload.length).toBe(ADDRESS_PAYLOAD_BYTES);
  return vector.tag === ADDRESS_TAG_ACCOUNT
    ? StrKey.encodeEd25519PublicKey(payload)
    : StrKey.encodeContract(payload);
}

function addressOf(index: number): string {
  return strkeyOf(elementAt(context.addresses, index, "address table of the vector file"));
}

describe("the constants equal the constants of the shared crate", () => {
  it("carries the same value for every named constant", () => {
    // The modulus is not a field element, so it needs the writer that takes
    // any value which 32 bytes hold.
    expect(toHex32(FR_MODULUS)).toBe(context.constants["fr_modulus"]);
    expect(FR_BYTES).toBe(context.constants["fr_bytes"]);
    expect(toHex(CTX_DOMAIN_TAG)).toBe(context.constants["ctx_domain_tag"]);
    expect(toHex(SALT_DOMAIN_TAG)).toBe(context.constants["salt_domain_tag"]);
    expect(POSEIDON2_STATE_WIDTH).toBe(context.constants["poseidon2_state_width"]);
    expect(MAX_RESERVE_ADDRESSES).toBe(context.constants["max_reserve_addresses"]);
    expect(ATTESTATION_MAX_AGE_LEDGERS).toBe(context.constants["attestation_max_age_ledgers"]);
    expect(ADDRESS_PAYLOAD_BYTES).toBe(context.constants["address_payload_bytes"]);
    expect(ADDRESS_LIMB_BYTES).toBe(context.constants["address_limb_bytes"]);
    expect(ADDRESS_TAG_ACCOUNT).toBe(context.constants["address_tag_account"]);
    expect(ADDRESS_TAG_CONTRACT).toBe(context.constants["address_tag_contract"]);
    expect(Number(PADDING_LEAF_ID)).toBe(context.constants["padding_leaf_id"]);
    expect(PADDING_LEAF_BALANCE.toString(10)).toBe(context.constants["padding_leaf_balance"]);
  });

  it("carries the same value for every constant of the package schema", () => {
    expect(PACKAGE_FORMAT).toBe(packages.constants["package_format"]);
    expect(PACKAGE_EXTENSION).toBe(packages.constants["package_extension"]);
    expect(JSON_INDENT).toBe(packages.constants["json_indent"]);
    expect(PACKAGE_INDEX_DIGITS).toBe(packages.constants["package_index_digits"]);
  });
});

describe("the field element reduction", () => {
  it.each(context.field_reductions)("reduces the case $case", (vector) => {
    const bytes = bytesFromHex(vector.input);
    let value = 0n;
    for (const byte of bytes) {
      value = (value << 8n) | BigInt(byte);
    }
    expect(inRange(value)).toBe(vector.in_range);
    expect(toHex(reduce(bytes))).toBe(vector.reduced);
  });
});

describe("the address encoding", () => {
  it.each(context.addresses)("encodes the case $case", (vector) => {
    const parts = addressParts(strkeyOf(vector));
    expect(parts.tag).toBe(vector.tag);
    const limbs = encodeAddress(strkeyOf(vector));
    expect(toHex(limbs.hi)).toBe(vector.hi);
    expect(toHex(limbs.lo)).toBe(vector.lo);
  });
});

describe("the reserve set hash", () => {
  it.each(context.reserve_sets)("hashes the case $case", (vector) => {
    const members = vector.addresses.map((index) => addressOf(index));
    expect(toHex(reserveSetHash(members))).toBe(vector.reserve_set_hash);
  });
});

describe("the context hash", () => {
  it.each(context.contexts)("hashes the case $case", (vector) => {
    const value = contextHash({
      authority: addressOf(vector.authority),
      asset: addressOf(vector.asset),
      reserveSetHash: BigInt(
        elementAt(context.reserve_sets, vector.reserve_set, "reserve set table").reserve_set_hash,
      ),
      snapshotLedger: vector.snapshot_ledger,
    });
    expect(toHex(value)).toBe(vector.context_hash);
  });
});

/**
 * The domain tags. Each tag is an ASCII string that this package pads, so the
 * padding rule needs the same check as the hashes.
 */
describe("the domain tags", () => {
  it("builds the same two tags as the shared crate", () => {
    expect(toHex(CTX_DOMAIN_TAG)).toBe(context.constants["ctx_domain_tag"]);
    expect(toHex(SALT_DOMAIN_TAG)).toBe(context.constants["salt_domain_tag"]);
  });
});

describe("the tree node", () => {
  it.each(context.nodes)("hashes the case $case", (vector) => {
    expect(toHex(nodeHash(BigInt(vector.left), BigInt(vector.right)))).toBe(vector.node);
  });
});

describe("the leaf", () => {
  it.each(context.leaves)("hashes the case $case", (vector) => {
    const value = leafHash({
      id: BigInt(vector.id),
      balance: BigInt(vector.balance),
      salt: BigInt(vector.salt),
    });
    expect(toHex(value)).toBe(vector.leaf);
  });
});

describe("the salt derivation", () => {
  it.each(context.salts)("derives the case $case", (vector) => {
    const value = deriveSalt({
      masterSecret: BigInt(vector.master_secret),
      contextHash: BigInt(elementAt(context.contexts, vector.context, "context table").context_hash),
      globalIndex: BigInt(vector.global_index),
    });
    expect(toHex(value)).toBe(vector.salt);
  });
});

/**
 * The path walk. Nothing in the primitive vectors reaches it: a walk with an
 * inverted direction rule or a reversed level order gives the same answer on a
 * tree of one node and another answer on a real tree.
 */
describe("the authentication path walk", () => {
  for (const [treeIndex, tree] of packages.trees.entries()) {
    describe(`the tree ${treeIndex}, ${tree.case}`, () => {
      it.each(tree.paths)("walks from the leaf $leaf_index to the root", (path) => {
        const leaf = leafHash({
          id: BigInt(path.id),
          balance: BigInt(path.balance),
          salt: BigInt(path.salt),
        });
        expect(toHex(leaf)).toBe(path.leaf);
        const root = rootFromPath({
          leaf,
          leafIndex: path.leaf_index,
          siblings: path.siblings.map((sibling) => BigInt(sibling)),
          depth: tree.depth,
        });
        expect(toHex(root)).toBe(tree.root);
      });

      const listed = tree.leaves;
      if (listed !== undefined) {
        it("folds the listed leaves into the same root", () => {
          const leaves = listed.map((entry) =>
            leafHash({
              id: BigInt(entry.id),
              balance: BigInt(entry.balance),
              salt: BigInt(entry.salt),
            }),
          );
          expect(toHex(treeRoot(leaves))).toBe(tree.root);
        });

        it("gives another root under a wrong leaf index", () => {
          const path = elementAt(tree.paths, tree.paths.length - 1, "path list of the tree");
          const leaf = BigInt(path.leaf);
          const siblings = path.siblings.map((sibling) => BigInt(sibling));
          const wrong = path.leaf_index === 0 ? 1 : path.leaf_index - 1;
          const value = rootFromPath({
            leaf,
            leafIndex: wrong,
            siblings,
            depth: tree.depth,
          });
          expect(toHex(value)).not.toBe(tree.root);
        });
      }
    });
  }
});

/**
 * The package layout. The specification fixes the bytes so that two
 * implementations write byte-identical files, and a golden literal on the Rust
 * side alone does not establish that this implementation reaches them.
 */
describe("the package layout", () => {
  it.each(packages.packages)("writes the same bytes for the case $case", (vector) => {
    const text = `${vector.lines.join("\n")}\n`;
    const entry = parsePackage(text);
    expect(serializePackage(entry)).toBe(text);
    expect(packageFilename(entry.leafIndex)).toBe(vector.filename);
  });

  it.each(packages.packages)("walks the case $case to the attested root", (vector) => {
    const entry = parsePackage(`${vector.lines.join("\n")}\n`);
    const root = rootFromPath({
      leaf: leafHash({ id: entry.id, balance: entry.balance, salt: entry.salt }),
      leafIndex: entry.leafIndex,
      siblings: entry.siblings,
      depth: entry.siblings.length,
    });
    expect(toHex(root)).toBe(elementAt(packages.trees, vector.tree, "tree table").root);
  });
});
