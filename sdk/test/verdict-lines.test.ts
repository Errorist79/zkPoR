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
 * A comment cannot satisfy them.
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
  it("says the package chose the registry, in the answer itself", () => {
    // The asset page names a registry too, and finds it by asking which
    // generation holds the asset. The two coincide today and diverge for a
    // package of an earlier generation, so each answer says who chose.
    const lines = verdictLines(INCLUDED).join("\n");
    expect(lines).toContain("The package names the registry");
    expect(lines).toContain("this check read that registry");
  });

  it("says a package cannot choose the file that the client trusts", () => {
    // Stating only that the package named the registry advertises the
    // obedience and hides the guard. A reader would be right to wonder whether
    // a package can point this client anywhere, and the answer is no.
    const lines = verdictLines(INCLUDED).join("\n");
    expect(lines).toContain("reads only the registries its own deployments file records");
    expect(lines).toContain("is refused");
  });

  it("names the asset on a line of its own", () => {
    // The asset and the registry were one sentence, which made two claims read
    // as one fact.
    expect(verdictLines(INCLUDED)).toContain(`The asset is ${ASSET}.`);
  });
});
