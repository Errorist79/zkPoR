/**
 * The guard on the hash.
 *
 * The hash library offers a variable-length mode that absorbs one extra element
 * and computes a different function. A call site that reaches it would produce
 * values that the registry and the circuits reject, and it would look like a
 * reasonable call. These tests keep that mode unreachable, so a later extension
 * of this package fails here instead of on a network.
 */

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { poseidon2Hash, poseidon2HashAsync } from "@zkpassport/poseidon2";
import { describe, expect, it } from "vitest";
import { captureOf } from "./fixture-guards.js";
import { hash } from "../src/poseidon.js";
import { POSEIDON2_RATE, POSEIDON2_STATE_WIDTH } from "../src/constants.js";

const SOURCE = join(import.meta.dirname, "..", "src");

/** The one file that may import the hash library. */
const HASH_MODULE = "poseidon.ts";

function sourceFiles(): string[] {
  return readdirSync(SOURCE).filter((name) => name.endsWith(".ts"));
}

describe("the hash library has one call site", () => {
  it("is imported by one file only", () => {
    const importers = sourceFiles().filter((name) =>
      readFileSync(join(SOURCE, name), "utf8").includes("@zkpassport/poseidon2"),
    );
    expect(importers).toEqual([HASH_MODULE]);
  });

  it("is imported for the fixed-length function alone", () => {
    const text = readFileSync(join(SOURCE, HASH_MODULE), "utf8");
    const found = /import \{([^}]*)\} from "@zkpassport\/poseidon2";/.exec(text);
    if (found === null) {
      throw new Error("the hash module holds no import of the library");
    }
    const imported = captureOf(found, 1, "import statement")
      .split(",")
      .map((name) => name.trim());
    expect(imported).toEqual(["poseidon2Hash"]);
  });

  it("exports one function, so no caller chooses a mode", () => {
    const text = readFileSync(join(SOURCE, HASH_MODULE), "utf8");
    const exported = [...text.matchAll(/^export (?:function|const|class) (\w+)/gm)].map(
      (match) => match[1],
    );
    expect(exported).toEqual(["hash"]);
  });
});

describe("the wrapper uses the fixed-length form", () => {
  /**
   * The variable-length form absorbs an extra element, so it gives another
   * value. This test states the difference, so the two are never confused.
   */
  it("agrees with the fixed-length form and differs from the variable-length form", async () => {
    const inputs = [1n, 2n, 3n];
    expect(hash(inputs)).toBe(poseidon2Hash(inputs));
    expect(hash(inputs)).not.toBe(await poseidon2HashAsync([...inputs, 1n]));
  });

  it("gives another value for another input count, because the capacity carries it", () => {
    expect(hash([1n, 2n])).not.toBe(hash([1n, 2n, 0n]));
  });

  it("uses the state width and the rate that the protocol names", () => {
    expect(POSEIDON2_RATE).toBe(POSEIDON2_STATE_WIDTH - 1);
  });

  it("refuses an input that is not a field element", () => {
    expect(() => hash([-1n])).toThrow();
    expect(() => hash([])).toThrow();
  });
});
