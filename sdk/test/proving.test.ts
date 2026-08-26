/**
 * The proving driver, in the parts that need no prover.
 *
 * The pipeline itself needs the pinned native binaries and multiple gigabytes
 * of memory, so it runs on the toolchain machine. What runs here is every
 * refusal and every reading that stands before or after the prover, because
 * each of those decides whether a run can land at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureOf, valueOf } from "./fixture-guards.js";
import {
  ATTESTATION_MAX_AGE_LEDGERS,
  PROVING_MARGIN_LEDGERS,
  PUBLIC_INPUT_BYTES,
} from "../src/constants.js";
import {
  ProvingError,
  inputsAreNotFixtures,
  parseShape,
  windowAllowsProving,
} from "../src/proving.js";
import { FIXTURE_MASTER_SECRET } from "../src/constants.js";
import {
  PUBLIC_INPUT_NAMES,
  ManifestError,
  parseManifest,
  readPublicInputs,
  serializePublicInputs,
} from "../src/manifest.js";
import { parseVersions } from "../src/versions.js";
import { toBytes } from "../src/fr.js";

const ROOT = join(import.meta.dirname, "..", "..");
const shapeText = readFileSync(join(ROOT, "circuits", "recursion", "params.toml"), "utf8");
const manifest = parseManifest(
  readFileSync(join(ROOT, "circuits", "recursion", "manifest.json"), "utf8"),
);
const pins = parseVersions(readFileSync(join(ROOT, "scripts", "versions.env"), "utf8"));

describe("the shape of the tree", () => {
  it("reads the committed configuration file", () => {
    const shape = parseShape(shapeText);
    expect(shape.batchB).toBeGreaterThan(1);
    expect(shape.numBatchesK).toBeGreaterThan(1);
    expect(shape.capacity).toBe(shape.batchB * shape.numBatchesK);
  });

  /**
   * The configuration file is the one place that fixes the shape. The manifest
   * is generated from it, so a difference means one of the two is stale, and
   * every key of a run would then be wrong.
   */
  it("agrees with the generated manifest", () => {
    const shape = parseShape(shapeText);
    expect(manifest.batchB).toBe(shape.batchB);
    expect(manifest.numBatchesK).toBe(shape.numBatchesK);
    expect(manifest.treeDepth).toBe(Math.log2(shape.capacity));
  });

  it("refuses a file that states no batch size", () => {
    expect(() => parseShape("num_batches_k = 4\n")).toThrow(ProvingError);
  });

  it("refuses a value that is not a power of two", () => {
    expect(() => parseShape("batch_b = 1000\nnum_batches_k = 4\n")).toThrow(ProvingError);
  });

  it("refuses a batch count of one, because a fold needs two", () => {
    expect(() => parseShape("batch_b = 1024\nnum_batches_k = 1\n")).toThrow(ProvingError);
  });
});

describe("the manifest agrees with the pinned prover", () => {
  it("names the pinned scheme and both oracle hashes", () => {
    expect(manifest.proofScheme).toBe(pins.get("PROOF_SCHEME"));
    expect(manifest.terminalOracleHash).toBe(pins.get("TERMINAL_ORACLE_HASH"));
    expect(manifest.innerOracleHash).toBe(pins.get("INNER_ORACLE_HASH"));
  });

  it("names two different oracle hashes, because the inner proof is recursive", () => {
    expect(manifest.innerOracleHash).not.toBe(manifest.terminalOracleHash);
  });
});

/**
 * The window check. The registry compares the snapshot against the ledger that
 * executes the attestation, and proving takes minutes, so a run must refuse a
 * snapshot that cannot still land when the proof is ready.
 */
describe("the window that a proving run needs", () => {
  const snapshot = 1_000_000;

  it("accepts a fresh snapshot", () => {
    expect(() => windowAllowsProving(snapshot, snapshot)).not.toThrow();
  });

  it("refuses a snapshot later than the current ledger", () => {
    expect(() => windowAllowsProving(snapshot, snapshot - 1)).toThrow(ProvingError);
  });

  it("refuses a snapshot that already left the window", () => {
    expect(() =>
      windowAllowsProving(snapshot, snapshot + ATTESTATION_MAX_AGE_LEDGERS + 1),
    ).toThrow(ProvingError);
  });

  it("refuses a snapshot with less of the window left than the proof needs", () => {
    const tooLate = snapshot + ATTESTATION_MAX_AGE_LEDGERS - PROVING_MARGIN_LEDGERS + 1;
    expect(() => windowAllowsProving(snapshot, tooLate)).toThrow(ProvingError);
    const justEnough = snapshot + ATTESTATION_MAX_AGE_LEDGERS - PROVING_MARGIN_LEDGERS;
    expect(() => windowAllowsProving(snapshot, justEnough)).not.toThrow();
  });
});

/**
 * The reading of the public input string that the prover writes.
 *
 * The reader takes each position from the manifest. It must not search the
 * string for a value, because two elements can hold the same value and a search
 * would then find the wrong position.
 */
describe("the public input string", () => {
  const values = {
    context_hash: 11n,
    inner_key_hash: manifest.innerKeyHash,
    final_root: 11n,
    L: 500n,
  };

  it("reads back every element that the writer wrote", () => {
    const bytes = serializePublicInputs(manifest, values);
    expect(bytes).toHaveLength(PUBLIC_INPUT_BYTES);
    expect(readPublicInputs(manifest, bytes)).toEqual(values);
  });

  it("keeps two elements of the same value apart by their position", () => {
    // The context hash and the root hold the same value here. A reader that
    // searched by value could not tell which position it found.
    const read = readPublicInputs(manifest, serializePublicInputs(manifest, values));
    expect(read.context_hash).toBe(read.final_root);
    expect(manifest.publicInputPositions.get("context_hash")).not.toBe(
      manifest.publicInputPositions.get("final_root"),
    );
  });

  it("refuses a string of another length", () => {
    expect(() => readPublicInputs(manifest, new Uint8Array(PUBLIC_INPUT_BYTES - 1))).toThrow(
      ManifestError,
    );
  });

  it("refuses an element at or above the field modulus", () => {
    const bytes = serializePublicInputs(manifest, values);
    const position = valueOf(manifest.publicInputPositions, "L", "manifest position table");
    bytes.set(new Uint8Array(32).fill(0xff), position * 32);
    expect(() => readPublicInputs(manifest, bytes)).toThrow(ManifestError);
  });

  it("places each named element at the position the manifest gives", () => {
    const bytes = serializePublicInputs(manifest, values);
    for (const name of PUBLIC_INPUT_NAMES) {
      const position = valueOf(manifest.publicInputPositions, name, "manifest position table");
      const element = bytes.subarray(position * 32, (position + 1) * 32);
      expect(Buffer.from(element).equals(Buffer.from(toBytes(values[name])))).toBe(true);
    }
  });
});

/**
 * The refusals that keep a real run away from public test material. A run that
 * used either one would write customer packages that protect nothing, and they
 * would look exactly like real ones.
 */
describe("the refusal of the test material", () => {
  const real = { contextFile: "/srv/zkpor/context.toml", customersFile: "/srv/zkpor/rows.csv" };

  it("accepts a secret and paths of an operator", () => {
    expect(() => inputsAreNotFixtures({ masterSecret: 12345n, ...real })).not.toThrow();
  });

  it("refuses the fixture secret of this repository", () => {
    expect(() =>
      inputsAreNotFixtures({ masterSecret: FIXTURE_MASTER_SECRET, ...real }),
    ).toThrow(ProvingError);
  });

  it("refuses a context file inside a fixtures directory", () => {
    expect(() =>
      inputsAreNotFixtures({
        masterSecret: 12345n,
        contextFile: "fixtures/test_only_context.toml",
        customersFile: real.customersFile,
      }),
    ).toThrow(ProvingError);
  });

  it("refuses a customer file inside a fixtures directory", () => {
    expect(() =>
      inputsAreNotFixtures({
        masterSecret: 12345n,
        contextFile: real.contextFile,
        customersFile: "circuits/recursion/inner/fixtures/customers_below_capacity.csv",
      }),
    ).toThrow(ProvingError);
  });

  /**
   * The refused value must stay the value the repository actually ships. A
   * fixture that changed while the refusal did not would leave the run open.
   */
  it("names the secret that the fixture file holds", () => {
    const text = readFileSync(join(ROOT, "fixtures", "test_only_master_secret.env"), "utf8");
    const found = /0x[0-9a-fA-F]+/.exec(text);
    if (found === null) {
      throw new Error("the fixture file states no secret");
    }
    expect(BigInt(captureOf(found, 0, "secret of the fixture file"))).toBe(FIXTURE_MASTER_SECRET);
  });
});
