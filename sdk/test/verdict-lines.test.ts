/**
 * What the inclusion check says, and not what its module contains.
 *
 * A guard on this wording once read the source of the module and passed
 * whenever the phrase appeared anywhere in it, including inside a comment. The
 * old ambiguous line was put back with the phrase moved into a comment above
 * it, and the guard stayed green while the answer stopped saying who chose the
 * registry.
 *
 * These cases call the function that writes the lines and read what it returns.
 * A comment cannot satisfy them. *
 * ## Some cases here assert a sentence, and that is deliberate
 *
 * Where the requirement is that a page or an answer says something, the wording
 * is the property, and a case can only check it by reading the words. Such a
 * case fails whenever somebody improves the sentence, including when the
 * improvement is right.
 *
 * That is not a defect in the case. It is a checkpoint. Each one names the
 * claim it protects, separately from the phrase it asserts. **If one fails
 * after a rewrite, read the claim, confirm the new sentence still carries it,
 * and then update the phrase.** Do not weaken the assertion to make it pass.
 *
 * This is a different thing from a guard that reads a source file, which a
 * comment can satisfy without the program saying anything at all.
 */

import { describe, expect, it } from "vitest";
import { verdictLines } from "../src/inclusion.js";
import type { Verdict } from "../src/inclusion.js";

/** One asset, one registry and one account. The values are test data. */
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";

/** A verdict that the leaf is under the attested root. */
const INCLUDED: Verdict = {
  kind: "included",
  asset: ASSET,
  registry: REGISTRY,
  leafIndex: 0,
  balance: 25_000_000n,
  snapshotLedger: 4_265_529,
  attestedLedger: 4_265_537,
  totalLiabilities: 100_000_000_000n,
  reserveSum: 150_000_000_000n,
  currentLedger: 4_265_544,
  solvencyLapsed: false,
};

describe("the answer of the inclusion check", () => {
  // Claim: the answer says which of the two possible choosers picked this
  // registry, so a reader is never left to work out whether the package or the
  // client decided.
  it("says, in words, that the package chose the registry", () => {
    // The asset page names a registry too, and finds it by asking which
    // generation holds the asset. The two coincide today and diverge for a
    // package of an earlier generation, so each answer says who chose.
    const lines = verdictLines(INCLUDED).join("\n");
    expect(lines).toContain("The package names the registry");
    expect(lines).toContain("this check read that registry");
  });

  // Claim: a package selects within the trusted deployments file and cannot
  // select the file, and one naming an unrecorded registry is refused.
  it("says, in words, that a package cannot choose the trusted file", () => {
    // Stating only that the package named the registry advertises the
    // obedience and hides the guard. A reader would be right to wonder whether
    // a package can point this client anywhere, and the answer is no.
    const lines = verdictLines(INCLUDED).join("\n");
    expect(lines).toContain("reads only the registries its own deployments file records");
    expect(lines).toContain("is refused");
  });

  // Claim: the asset and the registry are two statements, so two facts do not
  // read as one.
  it("names the asset on a line of its own", () => {
    // The asset and the registry were one sentence, which made two claims read
    // as one fact.
    expect(verdictLines(INCLUDED)).toContain(`The asset is ${ASSET}.`);
  });
});
