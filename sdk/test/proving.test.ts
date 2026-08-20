/**
 * The proving driver, in the parts that need no prover.
 *
 * The pipeline itself needs the pinned native binaries and multiple gigabytes
 * of memory, so it runs on the toolchain machine. What runs here is every
 * refusal and every reading that stands before or after the prover, because
 * each of those decides whether a run can land at all.
 */

import { existsSync, readFileSync } from "node:fs";
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
import { BUILT_INS, namedModulesOf } from "./sources.js";
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

/**
 * What a proving run can reach, which is nothing outside this package.
 *
 * A run reads the customer file and it derives every salt from the master
 * secret. It needs no network for any step: it reads the pins, it starts the
 * pinned tools, and it reads what the tools write. The rule for the modules of
 * a run is therefore the strict one. They name no module outside this package,
 * not even the library that the client uses to talk to the registry.
 *
 * That is stronger than the rule that holds over the whole package, which
 * allows the declared dependency that reaches the registry and is checked over
 * every module in another file. Both are kept, and the reason is measurable
 * rather than tidy: the wider rule passes for a driver that imports the
 * library, and a driver that imports the library holds the master secret and a
 * way out at the same moment.
 *
 * The scope here comes from the property. This set is the modules that a run
 * loads, because the property is about what a run holds. The wider property is
 * about what this package ships, and it names every module.
 *
 * The rule is written as the specifiers that are allowed, in the same shape as
 * the wider one: a local module, or a built-in that this package uses. A list
 * of network modules to refuse would be one entry behind the runtime. The forms
 * come from the parser of the language, so the rule holds every form that names
 * a module rather than the forms somebody wrote a pattern for.
 *
 * The instrument reads source, which is weaker than an observation, so this
 * states the limit rather than letting the name of the test carry more than it
 * earns. Two things it cannot see: code that the source does not carry, which
 * means a string that the runtime evaluates, and a connection that a dependency
 * opens inside itself. A name that reaches past an import is read by the wider
 * rule, over every module of this package, so it is not read again here.
 */
describe("the modules a proving run loads", () => {
  /** Every local module the driver reaches, through every local import. */
  function loadedByProving(): string[] {
    const directory = join(import.meta.dirname, "..", "src");
    const seen = new Set<string>();
    const queue = ["proving.ts"];
    while (queue.length > 0) {
      const name = queue.pop();
      if (name === undefined || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const path = join(directory, name);
      if (!existsSync(path)) {
        continue;
      }
      for (const found of readFileSync(path, "utf8").matchAll(/from\s+"\.\/([^"]+)"/g)) {
        const specifier = found[1];
        if (specifier !== undefined) {
          queue.push(specifier.replace(/\.js$/, ".ts"));
        }
      }
    }
    return [...seen];
  }

  it("reaches a plausible set, because a walk that reached none checks nothing", () => {
    const loaded = loadedByProving();
    expect(loaded.length).toBeGreaterThanOrEqual(8);
    // The driver itself and the sweep must be in any correct walk. A walk that
    // returned only its starting point would satisfy a count alone.
    expect(loaded).toContain("proving.ts");
    expect(loaded).toContain("witnesses.ts");
    expect(loaded).toContain("runlifecycle.ts");
  });

  it("names no module outside this package, so a run reaches no network at all", () => {
    let counted = 0;
    for (const name of loadedByProving()) {
      if (!existsSync(join(import.meta.dirname, "..", "src", name))) {
        continue;
      }
      for (const named of namedModulesOf(name)) {
        counted += 1;
        if (named.specifier === undefined) {
          throw new Error(`${name} names a module with a value rather than with a literal`);
        }
        if (named.specifier.startsWith(".")) {
          continue;
        }
        // No dependency at all, which is what makes this stricter than the
        // rule that holds over the whole package.
        expect(BUILT_INS.includes(named.specifier), `${name} names ${named.specifier}`).toBe(true);
      }
    }
    // A read that found no module at all would pass the loop above without
    // looking at anything.
    expect(counted, "the read found almost no import, so it read almost nothing").toBeGreaterThan(
      15,
    );
  });
});
