/**
 * How much room an answer takes, and why that is a claim.
 *
 * The history reads every recorded generation, so most of the blocks on a page
 * belong to registries that never held the asset. A block carries a heading
 * naming its registry, which gives an empty answer the weight of a real one,
 * and a reader can take it for evidence of some relation between that registry
 * and this asset.
 *
 * A settled emptiness therefore goes to one line. An emptiness that is not
 * established keeps its block, because a query that could not cover its range
 * reports that it does not know rather than that there is nothing, and those
 * two answers must not look alike.
 *
 * The last cases hold the range that the page asks for, because the room an
 * answer takes and the range it covers are the same subject: a block reports
 * what one query reached.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssetPage } from "../src/views/asset.js";
import { assetView, framed, historyBlock } from "./support.js";

/** Three registries. The values are test data. */
const HOLDER = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const SETTLED = "CCHUTDKUPWXVUIX6D26SE5NZ5STP74VV4DY2CNVCMNJYOU5PTROLA7MY";
const UNSURE = "CC4MA6FWDBG3Y4YXYGDHYEZ36O3YSP7DREGOLBWKP6ZTQQ6IYFFX3KQK";

/** The markup of one asset page, with the blocks a case names. */
function pageOf(blocks: readonly ReturnType<typeof historyBlock>[]): string {
  return framed(<AssetPage view={assetView()} history={{ blocks: [...blocks] }} />);
}

/** The heading that a block of its own carries. */
function hasBlock(markup: string, registry: string): boolean {
  return markup.includes(`<h3>The registry <span class="address">${registry}</span></h3>`);
}

describe("who chose the registry that an answer names", () => {
  it("says the asset page reads the generation that holds the asset", () => {
    // The inclusion answer names a registry too, and it gets there another way:
    // the package names it. Identical wording on the two pages would tell a
    // reader there is nothing to ask, and the two addresses differ exactly when
    // a package of an earlier generation is checked while the asset has moved.
    const markup = framed(<AssetPage view={assetView()} history={undefined} />);
    expect(markup).toContain("This record comes from the registry");
    expect(markup).toContain("the generation that holds this");
  });
});

describe("the room that an empty answer takes", () => {
  it("gives a block to the generation that holds the asset", () => {
    const markup = pageOf([historyBlock({ registry: HOLDER })]);
    expect(hasBlock(markup, HOLDER)).toBe(true);
  });

  it("collapses a generation that read its whole range and holds nothing", () => {
    const markup = pageOf([
      historyBlock({ registry: HOLDER }),
      historyBlock({
        registry: SETTLED,
        entries: [],
        coversTheWholeRange: true,
        reachesTheRetentionLimit: false,
      }),
    ]);
    expect(hasBlock(markup, SETTLED)).toBe(false);
    expect(markup).toContain("were asked and hold no attestation");
    expect(markup).toContain(SETTLED);
  });

  it("keeps the block of a generation whose emptiness is not established", () => {
    // The query stopped before the end of its range, so this registry did not
    // report an absence. Collapsing it with a settled one would make the two
    // answers look alike, which is the defect this page exists to avoid.
    const markup = pageOf([
      historyBlock({ registry: HOLDER }),
      historyBlock({ registry: UNSURE, entries: [], coversTheWholeRange: false }),
    ]);
    expect(hasBlock(markup, UNSURE)).toBe(true);
    expect(markup).not.toContain("were asked and hold no attestation");
  });

  it("collapses a generation that read everything the endpoint can serve", () => {
    // Every query starts at the oldest retained ledger now, so that flag no
    // longer separates one answer from another. Keeping a block for it gave a
    // heading to every empty generation. The statement it carried is above the
    // blocks, once, in the line that says an earlier attestation can exist that
    // no query reaches.
    const markup = pageOf([
      historyBlock({ registry: HOLDER }),
      historyBlock({
        registry: SETTLED,
        entries: [],
        coversTheWholeRange: true,
        reachesTheRetentionLimit: true,
      }),
    ]);
    expect(hasBlock(markup, SETTLED)).toBe(false);
    expect(markup).toContain("were asked and hold no attestation");
  });

  it("says once that an earlier attestation can exist beyond the boundary", () => {
    const markup = pageOf([historyBlock({ registry: HOLDER })]);
    expect(markup).toContain("Each query starts at the oldest ledger that the endpoint keeps");
    expect(markup).toContain("earlier attestations that no query reaches");
  });

  it("names the oldest ledger the endpoint still holds", () => {
    // Without the boundary a reader cannot tell a history that is empty from
    // one that is out of reach, which is the distinction the whole answer rests
    // on.
    const markup = pageOf([historyBlock({ registry: HOLDER, oldestLedgerRetained: 4_144_112 })]);
    expect(markup).toContain("retains the ledgers from 4144112");
  });

  it("names every collapsed generation, so the count still adds up", () => {
    // The scope line above states how many generations the section covers. A
    // reader counts the blocks and this line together and finds all of them.
    const markup = pageOf([
      historyBlock({ registry: HOLDER }),
      historyBlock({ registry: SETTLED, entries: [], coversTheWholeRange: true }),
      historyBlock({ registry: UNSURE, entries: [], coversTheWholeRange: true }),
    ]);
    expect(markup).toContain("covers the 3 recorded generations");
    expect(markup).toContain(SETTLED);
    expect(markup).toContain(UNSURE);
  });
});

describe("the range that the page asks for", () => {
  /** The source of the reads that fill a page. */
  const chain = readFileSync(new URL("../src/chain.ts", import.meta.url), "utf8");

  it("names no start ledger, so the endpoint sets the range", () => {
    // A front end that computed a start of its own is how the command line and
    // this page came to cover different ranges. The read takes the window of
    // the endpoint when the caller names nothing.
    expect(chain).toContain("readAttestationHistory(reader.server, generation.registry, asset)");
  });

  it("reads the generations at the same time", () => {
    // The reads are independent. One after another, the page waited for the sum
    // of them, which was 5.2 seconds against 1.7 over the same request count.
    expect(chain).toContain("await Promise.all(");
  });
});
