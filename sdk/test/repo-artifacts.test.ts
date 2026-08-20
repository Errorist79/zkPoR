/**
 * The committed artifacts of the repository.
 *
 * The client reads the position of each public input from the generated
 * manifest, and it reads the toolchain pins from the versions file. Both are
 * committed artifacts, so the tests below run against the real files. A change
 * of an artifact that this client cannot read then fails here.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FR_BYTES,
  PUBLIC_INPUT_BYTES,
  PUBLIC_INPUT_COUNT,
  MASTER_SECRET_ENV,
  MASTER_SECRET_FILE_ENV,
} from "../src/constants.js";
import {
  ManifestError,
  PUBLIC_INPUT_NAMES,
  parseManifest,
  serializePublicInputs,
} from "../src/manifest.js";
import { parseVersions } from "../src/versions.js";
import { SecretError, readMasterSecret } from "../src/secret.js";
import { currentGeneration } from "../src/deployments.js";
import { FR_MODULUS } from "../src/constants.js";
import { bytesToBigint, toHex } from "../src/fr.js";
import { deriveSalt } from "../src/hashes.js";
import { isRecord } from "../src/guards.js";
import { captureOf, isStringRecord, valueOf } from "./fixture-guards.js";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * The salt case of the committed table that separates a reduction from a
 * truncation.
 *
 * Most cases carry a small master secret, and a truncation of a small value is
 * the value, so those cases cannot tell the two apart. The case here carries
 * the largest field element in the table.
 */
function saltVector(): { master_secret: string; context: number; global_index: string; salt: string } {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "fixtures", "context_vectors.json"), "utf8"),
  );
  if (!isRecord(parsed)) {
    throw new Error("the context vectors are not an object");
  }
  const salts = parsed["salts"];
  if (!Array.isArray(salts)) {
    throw new Error("the context vectors carry no salt table");
  }
  for (const entry of salts) {
    if (!isRecord(entry)) {
      continue;
    }
    const secret = entry["master_secret"];
    const context = entry["context"];
    const index = entry["global_index"];
    const salt = entry["salt"];
    if (
      typeof secret === "string" &&
      typeof context === "number" &&
      typeof salt === "string" &&
      (typeof index === "string" || typeof index === "number") &&
      BigInt(secret) > 0xffffn
    ) {
      return { master_secret: secret, context, global_index: String(index), salt };
    }
  }
  throw new Error("the salt table carries no case with a master secret a truncation would change");
}

/** The context hash that one salt case names, from the same table. */
function contextHashOf(index: number): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "fixtures", "context_vectors.json"), "utf8"),
  );
  if (!isRecord(parsed)) {
    throw new Error("the context vectors are not an object");
  }
  const contexts = parsed["contexts"];
  if (!Array.isArray(contexts)) {
    throw new Error("the context vectors carry no context table");
  }
  const found: unknown = contexts[index];
  if (!isRecord(found) || typeof found["context_hash"] !== "string") {
    throw new Error(`the context table has no hash at ${String(index)}`);
  }
  return found["context_hash"];
}


const manifestText = readFileSync(join(ROOT, "circuits", "recursion", "manifest.json"), "utf8");
const versionsText = readFileSync(join(ROOT, "scripts", "versions.env"), "utf8");
const deploymentsText = readFileSync(join(ROOT, "scripts", "deployments.json"), "utf8");

/** The circuit manifest, read into a plain object. Two tests change one field. */
function manifestSource(): Record<string, unknown> {
  const source: unknown = JSON.parse(manifestText);
  if (!isRecord(source)) {
    throw new Error("the circuit manifest holds no JSON object");
  }
  return source;
}

/** The dependency maps of the package file of this package. */
function sdkDependencies(): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  const source: unknown = JSON.parse(readFileSync(join(ROOT, "sdk", "package.json"), "utf8"));
  if (!isRecord(source)) {
    throw new Error("the package file holds no JSON object");
  }
  const dependencies = source["dependencies"];
  const devDependencies = source["devDependencies"];
  if (!isStringRecord(dependencies) || !isStringRecord(devDependencies)) {
    throw new Error("the package file holds no pair of dependency maps");
  }
  return { dependencies, devDependencies };
}

describe("the committed circuit manifest", () => {
  const manifest = parseManifest(manifestText);

  it("gives a position to each public input, and no position twice", () => {
    const positions = PUBLIC_INPUT_NAMES.map((name) => manifest.publicInputPositions.get(name));
    expect(positions).not.toContain(undefined);
    expect(new Set(positions).size).toBe(PUBLIC_INPUT_COUNT);
  });

  it("agrees with the tree depth that the deployments file records", () => {
    const generation = currentGeneration(deploymentsText, "testnet");
    if (generation === undefined) {
      throw new Error("the deployments file records no generation for the testnet");
    }
    expect(manifest.treeDepth).toBe(generation.treeDepth);
  });

  it("agrees with the pinned prover versions", () => {
    const pins = parseVersions(versionsText);
    expect(manifest.nargoVersion).toBe(pins.get("NARGO_VERSION"));
    expect(`v${manifest.bbVersion}`).toBe(pins.get("BB_VERSION"));
    expect(manifest.proofScheme).toBe(pins.get("PROOF_SCHEME"));
    expect(manifest.terminalOracleHash).toBe(pins.get("TERMINAL_ORACLE_HASH"));
    expect(manifest.innerOracleHash).toBe(pins.get("INNER_ORACLE_HASH"));
  });

  it("carries an inner key hash that is a field element", () => {
    expect(manifest.innerKeyHash).toBeLessThan(FR_MODULUS);
    expect(manifest.innerKeyHash).toBeGreaterThan(0n);
  });

  /**
   * The registry compiles in the inner key hash and compares every proof
   * against it. The manifest states the same value as a decimal string. The two
   * are generated together, so a difference means one of them is stale, and
   * every proof of a run would then fail on chain for a reason that names no
   * version.
   */
  it("states the inner key hash that the registry compiles in", () => {
    const source = readFileSync(
      join(ROOT, "contracts", "registry", "src", "params.rs"),
      "utf8",
    );
    const block = /INNER_KEY_HASH[^=]*=\s*\[([^\]]*)\]/.exec(source);
    if (block === null) {
      throw new Error("the registry states no inner key hash");
    }
    const listed = captureOf(block, 1, "inner key hash statement");
    const bytes = [...listed.matchAll(/0x([0-9a-fA-F]{2})/g)].map((match) =>
      Number.parseInt(captureOf(match, 1, "byte of the inner key hash"), 16),
    );
    expect(bytes).toHaveLength(FR_BYTES);
    expect(bytesToBigint(Uint8Array.from(bytes))).toBe(manifest.innerKeyHash);
  });

  /**
   * The serialization writes each element at the position the manifest gives.
   * A reader must not locate a public input by its value, so this test gives
   * two elements the same value and still expects each one at its own place.
   */
  it("writes each public input at the position the manifest gives", () => {
    const values = {
      context_hash: 1n,
      inner_key_hash: 2n,
      final_root: 2n,
      L: 4n,
    };
    const bytes = serializePublicInputs(manifest, values);
    expect(bytes).toHaveLength(PUBLIC_INPUT_BYTES);
    for (const name of PUBLIC_INPUT_NAMES) {
      const position = valueOf(manifest.publicInputPositions, name, "manifest position table");
      const element = bytes.subarray(position * FR_BYTES, (position + 1) * FR_BYTES);
      expect(toHex(bytesToBigint(element))).toBe(toHex(values[name]));
    }
  });

  it("refuses a manifest whose public input count this client does not read", () => {
    const changed = JSON.stringify({ ...manifestSource(), public_input_count: 5 });
    expect(() => parseManifest(changed)).toThrow(ManifestError);
  });

  it("refuses a manifest that gives no position for a named public input", () => {
    const source = manifestSource();
    const declared = source["public_input_positions"];
    if (!isRecord(declared)) {
      throw new Error("the circuit manifest holds no position table");
    }
    const positions = { ...declared };
    delete positions["final_root"];
    expect(() =>
      parseManifest(JSON.stringify({ ...source, public_input_positions: positions })),
    ).toThrow(ManifestError);
  });
});

describe("the committed versions file", () => {
  it("carries every pin that this client reads", () => {
    const pins = parseVersions(versionsText);
    for (const name of [
      "NARGO_VERSION",
      "BB_VERSION",
      "PROOF_SCHEME",
      "TERMINAL_ORACLE_HASH",
      "INNER_ORACLE_HASH",
      "STELLAR_JS_SDK_VERSION",
    ]) {
      expect(pins.get(name), `the versions file carries ${name}`).toBeDefined();
    }
  });

  it("pins the exact version of the Stellar library that this package depends on", () => {
    const pins = parseVersions(versionsText);
    const manifest = sdkDependencies();
    expect(manifest.dependencies["@stellar/stellar-sdk"]).toBe(
      pins.get("STELLAR_JS_SDK_VERSION"),
    );
  });

  it("pins every dependency exactly, with no range operator", () => {
    const manifest = sdkDependencies();
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      expect(version, `${name} carries no range operator`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("the master secret channel", () => {
  it("refuses a run with no channel set", async () => {
    await expect(readMasterSecret({})).rejects.toThrow(SecretError);
  });

  it("refuses both channels at once, because two sources can disagree", async () => {
    await expect(
      readMasterSecret({
        [MASTER_SECRET_ENV]: `0x${"11".repeat(FR_BYTES)}`,
        [MASTER_SECRET_FILE_ENV]: "/nowhere",
      }),
    ).rejects.toThrow(SecretError);
  });

  /**
   * A bound is not a transform.
   *
   * The assertion here used to be that the value is below the modulus, and
   * every wrong answer satisfies that. A secret truncated to its lowest
   * sixteen bits is below the modulus, and it leaves sixty five thousand
   * possible secrets, which is a search of no cost at all. Every salt of every
   * leaf comes from this value, so that reader and a correct one are the same
   * to a bound and opposite to a customer.
   *
   * What separates a reduction from a truncation is what each produces for one
   * input, so each case below names the value it expects.
   */
  it("gives back the value it was given, when the value is a field element", async () => {
    const secret = BigInt(saltVector().master_secret);
    // The largest field element of the committed table. A truncation of it
    // differs, which is what makes it the case worth reading.
    expect(secret).toBeGreaterThan(0xffffn);
    const value = await readMasterSecret({
      [MASTER_SECRET_ENV]: `0x${secret.toString(16).padStart(FR_BYTES * 2, "0")}`,
    });
    expect(value).toBe(secret);
  });

  it("reduces a value above the modulus, rather than cutting it to size", async () => {
    const value = await readMasterSecret({ [MASTER_SECRET_ENV]: `0x${"ff".repeat(FR_BYTES)}` });
    // The expectation comes from the modulus and not from the reduction under
    // test, so a wrong reduction cannot agree with itself.
    expect(value).toBe((2n ** BigInt(FR_BYTES * 8) - 1n) % FR_MODULUS);
  });

  it("derives the committed salt through the reader", async () => {
    // The vectors take a master secret as a literal, so nothing held the
    // reader to them. This runs the value through the reader first, which puts
    // the reader on the path that every salt of a real run takes.
    const vector = saltVector();
    const secret = await readMasterSecret({
      [MASTER_SECRET_ENV]: `0x${BigInt(vector.master_secret).toString(16).padStart(FR_BYTES * 2, "0")}`,
    });
    const salt = deriveSalt({
      masterSecret: secret,
      contextHash: BigInt(contextHashOf(vector.context)),
      globalIndex: BigInt(vector.global_index),
    });
    expect(toHex(salt)).toBe(vector.salt);
  });

  it("refuses a value that is not thirty-two bytes", async () => {
    await expect(readMasterSecret({ [MASTER_SECRET_ENV]: "0x01" })).rejects.toThrow(SecretError);
  });

  it("refuses a file that another user can read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zkpor-secret-"));
    const path = join(directory, "secret");
    writeFileSync(path, `0x${"22".repeat(FR_BYTES)}\n`);
    // Every mode that grants a bit beyond the owner, not only the one a fresh
    // file happens to carry. A check that read the last three bits alone would
    // accept 640, which is what a shared machine with a group actually
    // produces, and the group can then read every salt of every customer.
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o606, 0o066, 0o777]) {
      chmodSync(path, mode);
      await expect(
        readMasterSecret({ [MASTER_SECRET_FILE_ENV]: path }),
        `the reader accepted the mode ${mode.toString(8)}`,
      ).rejects.toThrow(SecretError);
    }
    // The owner alone, reading and writing, and the owner alone reading.
    for (const mode of [0o600, 0o400]) {
      chmodSync(path, mode);
      await expect(
        readMasterSecret({ [MASTER_SECRET_FILE_ENV]: path }),
        `the reader refused the mode ${mode.toString(8)}`,
      ).resolves.toBeTypeOf("bigint");
    }
    chmodSync(path, 0o600);
    await expect(readMasterSecret({ [MASTER_SECRET_FILE_ENV]: path })).resolves.toBeTypeOf(
      "bigint",
    );
  });
});
