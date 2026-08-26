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
import { isRecord } from "../src/guards.js";
import { captureOf, isStringRecord, valueOf } from "./fixture-guards.js";

const ROOT = join(import.meta.dirname, "..", "..");

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

  it("reads the value of the environment variable and reduces it", async () => {
    const value = await readMasterSecret({ [MASTER_SECRET_ENV]: `0x${"ff".repeat(FR_BYTES)}` });
    expect(value).toBeLessThan(FR_MODULUS);
  });

  it("refuses a value that is not thirty-two bytes", async () => {
    await expect(readMasterSecret({ [MASTER_SECRET_ENV]: "0x01" })).rejects.toThrow(SecretError);
  });

  it("refuses a file that another user can read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zkpor-secret-"));
    const path = join(directory, "secret");
    writeFileSync(path, `0x${"22".repeat(FR_BYTES)}\n`);
    chmodSync(path, 0o644);
    await expect(readMasterSecret({ [MASTER_SECRET_FILE_ENV]: path })).rejects.toThrow(
      SecretError,
    );
    chmodSync(path, 0o600);
    await expect(readMasterSecret({ [MASTER_SECRET_FILE_ENV]: path })).resolves.toBeTypeOf(
      "bigint",
    );
  });
});
