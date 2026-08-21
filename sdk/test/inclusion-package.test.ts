/**
 * The package reader.
 *
 * The reader is the gate of the customer flow, so every rejection of the schema
 * has a test, and every test has a control that differs only in its cause.
 */

import { describe, expect, it } from "vitest";
import {
  MalformedPackageError,
  UnsupportedFormatError,
  checkDepth,
  packageFilename,
  parsePackage,
  serializePackage,
} from "../src/inclusion-package.js";
import {
  ContradictoryDeploymentsError,
  UnreadableDeploymentsError,
  currentGeneration,
  findGeneration,
  parseDeployments,
} from "../src/deployments.js";
import { EXIT_CODES, EXIT_NO_VERDICT, EXIT_USAGE } from "../src/inclusion.js";

/** A registry address. The value is test data. */
const REGISTRY = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
/** An asset address. The value is test data. */
const ASSET = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function fields(): Record<string, unknown> {
  return {
    format: "zkpor-inclusion/1",
    network: "testnet",
    registry: REGISTRY,
    asset: ASSET,
    snapshot_ledger: 720,
    leaf_index: 5,
    id: `0x${"0".repeat(63)}7`,
    balance: "100",
    salt: `0x${"0".repeat(63)}2`,
    siblings: [`0x${"0".repeat(63)}3`, `0x${"0".repeat(63)}4`, `0x${"0".repeat(63)}5`],
  };
}

function text(changes: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ...fields(), ...changes }, null, 2)}\n`;
}

describe("a package that follows the schema", () => {
  it("reads every field", () => {
    const entry = parsePackage(text());
    expect(entry.network).toBe("testnet");
    expect(entry.snapshotLedger).toBe(720);
    expect(entry.leafIndex).toBe(5);
    expect(entry.balance).toBe(100n);
    expect(entry.siblings).toHaveLength(3);
  });

  it("writes back the same bytes", () => {
    expect(serializePackage(parsePackage(text()))).toBe(text());
  });

  it("reads a file that another layout wrote", () => {
    const compact = `${JSON.stringify(fields())}\n`;
    expect(parsePackage(compact)).toEqual(parsePackage(text()));
  });

  it("pads the leaf index of the filename to six digits", () => {
    expect(packageFilename(5)).toBe("package-000005.zkpor.json");
    expect(packageFilename(4095)).toBe("package-004095.zkpor.json");
  });
});

describe("the format gate", () => {
  it("refuses an unknown format as its own class, not as a malformed package", () => {
    const cause = (() => {
      try {
        parsePackage(text({ format: "zkpor-inclusion/2" }));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(cause).toBeInstanceOf(UnsupportedFormatError);
    expect(cause).not.toBeInstanceOf(MalformedPackageError);
  });

  it("refuses an unknown format before it reads a field that breaks a rule", () => {
    expect(() =>
      parsePackage(text({ format: "zkpor-inclusion/2", balance: "not a number" })),
    ).toThrow(UnsupportedFormatError);
  });

  it("calls a package without a format malformed", () => {
    const without = fields();
    delete without["format"];
    expect(() => parsePackage(`${JSON.stringify(without)}\n`)).toThrow(MalformedPackageError);
  });
});

describe("the rejections of the schema", () => {
  it("refuses a field that the format does not name", () => {
    expect(() => parsePackage(text({ final_root: "0x00" }))).toThrow(MalformedPackageError);
  });

  it("refuses a missing field", () => {
    const without = fields();
    delete without["salt"];
    expect(() => parsePackage(`${JSON.stringify(without)}\n`)).toThrow(MalformedPackageError);
  });

  it("refuses the padding identifier", () => {
    expect(() => parsePackage(text({ id: `0x${"0".repeat(64)}` }))).toThrow(MalformedPackageError);
  });

  it.each([
    ["an uppercase digit", `0x${"0".repeat(63)}A`],
    ["a missing prefix", "0".repeat(64)],
    ["a short value", `0x${"0".repeat(63)}`],
    ["a long value", `0x${"0".repeat(65)}`],
    ["a value at the modulus", "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001"],
  ])("refuses a field element of the form %s", (_name, value) => {
    expect(() => parsePackage(text({ salt: value }))).toThrow(MalformedPackageError);
  });

  it.each([
    ["a leading zero", "0100"],
    ["a sign", "-1"],
    ["a fraction", "1.5"],
    ["a value above the largest u64", "18446744073709551616"],
    ["an empty string", ""],
  ])("refuses a balance of the form %s", (_name, value) => {
    expect(() => parsePackage(text({ balance: value }))).toThrow(MalformedPackageError);
  });

  it("accepts the balance zero as the single digit zero", () => {
    expect(parsePackage(text({ balance: "0" })).balance).toBe(0n);
  });

  it.each([
    ["a fraction", 1.5],
    ["a negative number", -1],
    ["a value above the largest u32", 4294967296],
    ["a string", "720"],
  ])("refuses a snapshot ledger of the form %s", (_name, value) => {
    expect(() => parsePackage(text({ snapshot_ledger: value }))).toThrow(MalformedPackageError);
  });

  it("refuses a leaf index that is not an integer, which JSON parsing accepts", () => {
    expect(() => parsePackage(text({ leaf_index: 2.5 }))).toThrow(MalformedPackageError);
  });
});

describe("the depth of the generation", () => {
  it("refuses a sibling count that does not equal the depth", () => {
    expect(() => checkDepth(parsePackage(text()), 12)).toThrow(MalformedPackageError);
  });

  it("accepts a sibling count that equals the depth", () => {
    expect(() => checkDepth(parsePackage(text()), 3)).not.toThrow();
  });

  it("refuses a leaf index at the capacity of the depth", () => {
    expect(() => checkDepth(parsePackage(text({ leaf_index: 8 })), 3)).toThrow(
      MalformedPackageError,
    );
    expect(() => checkDepth(parsePackage(text({ leaf_index: 7 })), 3)).not.toThrow();
  });
});

describe("the deployments file", () => {
  const record = (registry: string, depth = 12) =>
    JSON.stringify({
      network: "testnet",
      registry,
      verifier: "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      aggregator_key_sha256: "e0",
      tree_depth: depth,
      registry_wasm_sha256: "a1",
      verifier_wasm_sha256: "b2",
    });

  it("reads every record", () => {
    const text = `[${record(REGISTRY)},${record(ASSET)}]`;
    expect(parseDeployments(text)).toHaveLength(2);
  });

  it("gives the last record of a network as the current generation", () => {
    const text = `[${record(REGISTRY)},${record(ASSET)}]`;
    expect(currentGeneration(text, "testnet")?.registry).toBe(ASSET);
  });

  it("keeps an earlier generation findable", () => {
    const text = `[${record(REGISTRY)},${record(ASSET)}]`;
    expect(findGeneration(text, "testnet", REGISTRY)?.registry).toBe(REGISTRY);
  });

  it("finds no record for a pair that the file does not name", () => {
    expect(findGeneration(`[${record(REGISTRY)}]`, "testnet", ASSET)).toBeUndefined();
  });

  it("refuses the whole file when one pair appears twice", () => {
    expect(() => parseDeployments(`[${record(REGISTRY)},${record(REGISTRY)}]`)).toThrow(
      ContradictoryDeploymentsError,
    );
  });

  it("refuses a record without a tree depth", () => {
    expect(() =>
      parseDeployments('[{"network":"testnet","registry":"C","verifier":"C","aggregator_key_sha256":"e0"}]'),
    ).toThrow(UnreadableDeploymentsError);
  });

  it("refuses a record that states no wasm for what it names", () => {
    // A record with an address and no hash leaves a reader unable to ask what
    // runs at that address, which is the state every record was in before.
    const without = JSON.stringify({
      network: "testnet",
      registry: REGISTRY,
      verifier: "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      aggregator_key_sha256: "e0",
      tree_depth: 12,
    });
    expect(() => parseDeployments(`[${without}]`)).toThrow(UnreadableDeploymentsError);
  });

  it("refuses a file that is not a list", () => {
    expect(() => parseDeployments("{}")).toThrow(UnreadableDeploymentsError);
  });
});

/**
 * Each failure class must stay distinct in the result, and an infrastructure
 * failure is not a verdict, so it must not share a code with one.
 */
describe("the exit codes", () => {
  it("gives one code to each class, and zero only to an included package", () => {
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(EXIT_CODES.included).toBe(0);
    for (const [kind, code] of Object.entries(EXIT_CODES)) {
      if (kind !== "included") {
        expect(code).not.toBe(0);
      }
    }
  });

  it("keeps a failure without a verdict apart from every verdict", () => {
    expect(Object.values(EXIT_CODES)).not.toContain(EXIT_NO_VERDICT);
    expect(Object.values(EXIT_CODES)).not.toContain(EXIT_USAGE);
    expect(EXIT_NO_VERDICT).not.toBe(EXIT_USAGE);
  });
});
