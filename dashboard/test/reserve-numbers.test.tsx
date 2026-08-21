/**
 * The two reserve numbers, and the rule that they never share a name, a row, or
 * a headline.
 *
 * Every test here renders the confusing case on purpose: the attested sum and
 * the observed sum hold the same digits. A page that let the two run together
 * would still look correct with different numbers, and it would mislead exactly
 * when the two agree.
 */

import { describe, expect, it } from "vitest";
import { SECTION_IDS } from "../src/constants.js";
import { coverageOf } from "../src/model.js";
import { AssetPage } from "../src/views/asset.js";
import {
  assetView,
  attestation,
  assetRecord,
  diagnosis,
  historyView,
  sectionOf,
  framed,
  textOf,
} from "./support.js";

/** The same digits in both places, which is the case a reader can confuse. */
const SAME = 4_242_424_242n;

function pageWithEqualSums(): string {
  return framed(
    <AssetPage
      view={assetView({
        record: assetRecord({ attestation: attestation({ reserveSum: SAME, totalLiabilities: 100n }) }),
        observedSum: SAME,
        observedLedger: 5_200,
      })}
      history={undefined}
    />,
  );
}

describe("the attested sum and the observed sum", () => {
  it("appear in two sections that neither contains", () => {
    const markup = pageWithEqualSums();
    const attested = sectionOf(markup, SECTION_IDS.attestedReserves);
    const observed = sectionOf(markup, SECTION_IDS.observedReserves);
    expect(attested).not.toContain(observed);
    expect(observed).not.toContain(attested);
    expect(attested).not.toContain(`id="${SECTION_IDS.observedReserves}"`);
    expect(observed).not.toContain(`id="${SECTION_IDS.attestedReserves}"`);
  });

  it("appear once each, inside their own section and nowhere else", () => {
    const markup = pageWithEqualSums();
    const digits = SAME.toString(10);
    const everywhere = markup.split(digits).length - 1;
    const inAttested = sectionOf(markup, SECTION_IDS.attestedReserves).split(digits).length - 1;
    const inObserved = sectionOf(markup, SECTION_IDS.observedReserves).split(digits).length - 1;
    expect(inAttested).toBe(1);
    expect(inObserved).toBe(1);
    // The two occurrences inside the two sections are the only two on the page.
    expect(everywhere).toBe(2);
  });

  it("each carry a name that the other does not use", () => {
    const markup = pageWithEqualSums();
    const attested = textOf(sectionOf(markup, SECTION_IDS.attestedReserves));
    const observed = textOf(sectionOf(markup, SECTION_IDS.observedReserves));
    expect(attested).toContain("Reserves at the attestation");
    expect(observed).toContain("Reserves observed now");
    expect(attested).not.toContain("Reserves observed now");
    expect(observed).not.toContain("Reserves at the attestation");
  });

  it("each name the ledger that produced it", () => {
    const markup = pageWithEqualSums();
    expect(textOf(sectionOf(markup, SECTION_IDS.attestedReserves))).toContain("ledger 5100");
    expect(textOf(sectionOf(markup, SECTION_IDS.observedReserves))).toContain("5200");
  });

  it("state what covers each of them", () => {
    const markup = pageWithEqualSums();
    expect(textOf(sectionOf(markup, SECTION_IDS.attestedReserves))).toContain(
      "An accepted attestation covers this number",
    );
    expect(textOf(sectionOf(markup, SECTION_IDS.observedReserves))).toContain(
      "No attestation covers this reading",
    );
  });
});

describe("the headline", () => {
  it("carries neither sum", () => {
    const headline = sectionOf(pageWithEqualSums(), SECTION_IDS.headline);
    expect(headline).not.toContain(SAME.toString(10));
  });

  it("states the result of the comparison and not a number", () => {
    const headline = textOf(sectionOf(pageWithEqualSums(), SECTION_IDS.headline));
    expect(headline).toContain("The attested reserves reach the attested liabilities.");
    // A digit in the headline is a ledger, and never a sum. The ledgers below
    // are the only numbers the headline may name.
    const numbers = headline.match(/\d+/g) ?? [];
    expect(new Set(numbers)).toEqual(new Set(["5000", "5200", "5100"]));
  });
});

describe("the comparison", () => {
  it("never takes the observed sum, even when the attested sum falls short", () => {
    // The attested reserves fall short and the observation is large. A page
    // that compared the observation would call this covered.
    const markup = framed(
      <AssetPage
        view={assetView({
          record: assetRecord({
            attestation: attestation({ reserveSum: 10n, totalLiabilities: 1_000n }),
          }),
          observedSum: 9_999_999n,
        })}
        history={undefined}
      />,
    );
    const headline = textOf(sectionOf(markup, SECTION_IDS.headline));
    expect(headline).toContain("The attested reserves fall short of the attested liabilities.");
    expect(headline).not.toContain("9999999");
  });
});

describe("the boundary of the comparison", () => {
  // Reserves exactly equal to liabilities is the case the headline turns on.
  // Nothing else pins it, so a comparison that changed to a strict one would
  // report a solvent issuer as short by nothing.
  it("counts reserves that exactly equal the liabilities as reaching them", () => {
    expect(coverageOf(attestation({ reserveSum: 1_000n, totalLiabilities: 1_000n }))).toBe(
      "reserves-reach-liabilities",
    );
  });

  it("counts one unit less as falling short", () => {
    expect(coverageOf(attestation({ reserveSum: 999n, totalLiabilities: 1_000n }))).toBe(
      "reserves-fall-short",
    );
  });

  it("counts one unit more as reaching them", () => {
    expect(coverageOf(attestation({ reserveSum: 1_001n, totalLiabilities: 1_000n }))).toBe(
      "reserves-reach-liabilities",
    );
  });

  it("says so on the page at the exact boundary", () => {
    const markup = framed(
      <AssetPage
        view={assetView({
          record: assetRecord({
            attestation: attestation({ reserveSum: 1_000n, totalLiabilities: 1_000n }),
          }),
        })}
        history={undefined}
      />,
    );
    expect(textOf(sectionOf(markup, SECTION_IDS.headline))).toContain(
      "The attested reserves reach the attested liabilities.",
    );
  });

  it("compares integers of any size, and never a converted number", () => {
    // A reserve sum is a signed integer on the chain and a liability total is
    // an unsigned one. Both exceed what a double holds exactly, so a
    // comparison that converted them would call these two equal.
    const beyondADouble = 2n ** 60n;
    expect(
      coverageOf(
        attestation({ reserveSum: beyondADouble, totalLiabilities: beyondADouble + 1n }),
      ),
    ).toBe("reserves-fall-short");
  });

  it("counts a negative reserve sum as falling short of any liability", () => {
    // The chain records the reserve sum as a signed integer, so the type
    // admits a negative value even though a balance is not negative.
    expect(coverageOf(attestation({ reserveSum: -1n, totalLiabilities: 0n }))).toBe(
      "reserves-fall-short",
    );
  });
});

describe("the history, which is a third place that shows a reserve number", () => {
  it("shows attested sums only, under the name of the attested sum", () => {
    // Every earlier attestation carries the same digits as the observation.
    // The history states attested numbers, so it must use the attested name
    // and must never let a reader take one of its rows for the observation.
    const markup = framed(
      <AssetPage
        view={assetView({ observedSum: SAME, observedLedger: 5_200 })}
        history={{
          entries: [
            {
              snapshotLedger: 4_300,
              totalLiabilities: 900n,
              attested: { sum: SAME, attestedLedger: 4_390 },
              coverage: "reserves-reach-liabilities",
              transactionHash: "a".repeat(64),
            },
          ],
          oldestLedgerCovered: 4_000,
          oldestLedgerRetained: 4_000,
          latestLedger: 5_200,
          reachesTheRetentionLimit: false,
          coversTheWholeRange: true,
        }}
      />,
    );
    const history = textOf(sectionOf(markup, SECTION_IDS.history));
    expect(history).toContain("Reserves at the attestation");
    expect(history).not.toContain("Reserves observed now");
    // The observed sum still lives in its own section only.
    const observed = sectionOf(markup, SECTION_IDS.observedReserves);
    expect(observed.split(SAME.toString(10)).length - 1).toBe(1);
    expect(sectionOf(markup, SECTION_IDS.history)).not.toContain(
      `id="${SECTION_IDS.observedReserves}"`,
    );
  });

  it("states that it is not the complete record when it reached the retention limit", () => {
    const markup = framed(
      <AssetPage view={assetView({ observedSum: 1n })} history={historyView()} />,
    );
    expect(textOf(sectionOf(markup, SECTION_IDS.history))).toContain(
      "this is not the complete record",
    );
  });
});

describe("an observation that gave no sum", () => {
  it("names the address that the registry cannot read, and states no sum", () => {
    const markup = framed(
      <AssetPage
        view={assetView({
          observationFailure: "the registry cannot read one reserve balance",
          diagnosis: diagnosis(),
        })}
        history={undefined}
      />,
    );
    const observed = textOf(sectionOf(markup, SECTION_IDS.observedReserves));
    expect(observed).toContain("The registry gave no observed sum");
    expect(observed).toContain("the address holds no trustline");
    expect(observed).not.toContain("Reserves observed now 0");
  });
});
