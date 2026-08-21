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
 */

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

  it("keeps the block of a generation that reached the oldest retained ledger", () => {
    const markup = pageOf([
      historyBlock({ registry: HOLDER }),
      historyBlock({
        registry: UNSURE,
        entries: [],
        coversTheWholeRange: true,
        reachesTheRetentionLimit: true,
      }),
    ]);
    expect(hasBlock(markup, UNSURE)).toBe(true);
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
