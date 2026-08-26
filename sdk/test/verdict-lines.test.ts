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
import { groupedDigits } from "../src/report.js";
import type { Verdict } from "../src/inclusion.js";

/** One asset, one registry and one account. The values are test data. */
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";

/** A verdict that the leaf is under the attested root. */
const INCLUDED: Verdict = {
  kind: "included",
  asset: ASSET,
  registry: REGISTRY,
  id: 0x2an,
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

/**
 * Whether the answer binds the leaf to a person.
 *
 * A package proves that one leaf is under the root. It does not prove that the
 * leaf is the reader's. An issuer who gave the same package to two customers
 * would satisfy both checks with one leaf, and the total under the root would
 * count that liability once.
 *
 * The identifier is the only field that names the customer, and the answer used
 * to leave it in the file. So the reader saw a balance, and the balance is a
 * poor substitute: at a large issuer many customers hold the same small round
 * figure, and there the substitution is invisible.
 */
describe("the identifier in the answer", () => {
  it("states the identifier that the package carries", () => {
    expect(verdictLines(INCLUDED).join("\n")).toContain(
      "0x000000000000000000000000000000000000000000000000000000000000002a",
    );
  });

  it("says that the check cannot tell whose identifier it is", () => {
    // Without this, a reader takes the identifier on screen as a verdict about
    // themselves, which is the belief that makes the substitution work.
    const answer = verdictLines(INCLUDED).join("\n");
    expect(answer).toContain("cannot tell whose identifier it is");
    expect(answer).toContain("Compare it with the identifier that your issuer gave you");
  });

  it("says what another identifier would mean", () => {
    expect(verdictLines(INCLUDED).join("\n")).toContain(
      "proves the balance of another customer",
    );
  });
});

/**
 * Whether a figure can be read.
 *
 * A twenty-digit run cannot be counted by eye, and two of them cannot be
 * compared. The separator is a space and not a point or a comma, because both
 * of those mark the decimal somewhere: a point in English, a comma across most
 * of Europe. A reader who takes the group mark for a decimal mark reads the
 * figure wrong by orders of magnitude, and the pages state on the same screen
 * that no decimal of this project's own is applied.
 *
 * These read the answer as a reader meets it rather than the function alone.
 */
describe("the figures in the answer", () => {
  it("groups the digits of a long figure in threes", () => {
    const answer = verdictLines(INCLUDED).join("\n");
    expect(answer).toContain("100 000 000 000");
    expect(answer).toContain("150 000 000 000");
  });

  it("carries no point and no comma inside a figure", () => {
    // The failure this guards is a reader in another locale taking the mark for
    // a decimal point, not an untidy line.
    for (const line of verdictLines(INCLUDED)) {
      expect(line, line).not.toMatch(/\d[.,]\d/);
    }
  });

  it("leaves a short figure whole", () => {
    // A group of one digit standing apart reads as a separate number.
    expect(groupedDigits(1000n)).toBe("1000");
    expect(groupedDigits(10_000n)).toBe("10 000");
  });
});
