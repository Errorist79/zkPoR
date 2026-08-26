/**
 * A stale attestation, which is an outcome and not a failure.
 *
 * Inclusion and the currency of the solvency claim are different claims. A
 * lapsed window takes the solvency claim away and leaves the attestation
 * standing for the ledger it names, so the page says both things and calls
 * neither one a failure.
 *
 * The window itself belongs to the kit. The tests below take the boundary from
 * the constant that the kit publishes, so a change of the window moves the
 * tests with it rather than leaving them on a copied number.
 */

import { describe, expect, it } from "vitest";
import { ATTESTATION_MAX_AGE_LEDGERS, solvencyLapsed } from "@zkpor/sdk";
import { SECTION_IDS } from "../src/constants.js";
import { solvencyResult } from "../src/model.js";
import { AssetPage } from "../src/views/asset.js";
import { assetView, attestation, assetRecord, framed, sectionOf, textOf } from "./support.js";

/** The snapshot of every case below. */
const SNAPSHOT = 5_000;

/** The last ledger at which the claim still stands. */
const LAST_CURRENT = SNAPSHOT + ATTESTATION_MAX_AGE_LEDGERS;

function headlineAt(currentLedger: number): string {
  const markup = framed(
    <AssetPage
      view={assetView({
        record: assetRecord({ attestation: attestation({ snapshotLedger: SNAPSHOT }) }),
        currentLedger,
        observedSum: 42n,
      })}
      history={undefined}
    />,
  );
  return textOf(sectionOf(markup, SECTION_IDS.headline));
}

describe("the boundary of the window", () => {
  it("counts from the snapshot ledger and not from the attested ledger", () => {
    // The attested ledger sits after the snapshot. An origin at the attested
    // ledger would let the claim rest on older liabilities and still read as
    // current, so the model must take the snapshot.
    const attested = SNAPSHOT + 700;
    const result = solvencyResult(
      attestation({ snapshotLedger: SNAPSHOT, attestedLedger: attested }),
      LAST_CURRENT + 1,
    );
    expect(result.currency).toBe("lapsed");
    expect(solvencyLapsed(attested, LAST_CURRENT + 1)).toBe(false);
  });

  it("still stands at the last ledger of the window", () => {
    expect(solvencyResult(attestation({ snapshotLedger: SNAPSHOT }), LAST_CURRENT).currency).toBe(
      "current",
    );
  });

  it("has lapsed one ledger later", () => {
    expect(
      solvencyResult(attestation({ snapshotLedger: SNAPSHOT }), LAST_CURRENT + 1).currency,
    ).toBe("lapsed");
  });
});

describe("a page whose window has lapsed", () => {
  it("says the claim has lapsed", () => {
    const headline = headlineAt(LAST_CURRENT + 1);
    expect(headline).toContain("The solvency claim has lapsed.");
    expect(headline).not.toContain("The solvency claim is current");
  });

  it("says a lapse is not a failure", () => {
    expect(headlineAt(LAST_CURRENT + 1)).toContain("A lapsed claim is not a failure.");
  });

  it("keeps the attestation standing for the ledger it names", () => {
    const headline = headlineAt(LAST_CURRENT + 1);
    expect(headline).toContain("The attestation still stands for the ledger it names");
    expect(headline).toContain("The attested reserves reach the attested liabilities.");
  });

  it("marks the section, so a reader sees the state and not only the words", () => {
    const markup = framed(
      <AssetPage
        view={assetView({
          record: assetRecord({ attestation: attestation({ snapshotLedger: SNAPSHOT }) }),
          currentLedger: LAST_CURRENT + 1,
        })}
        history={undefined}
      />,
    );
    expect(sectionOf(markup, SECTION_IDS.headline)).toContain("claim-lapsed");
  });
});

describe("a page whose window still stands", () => {
  it("says the claim is current, and says nothing about a lapse", () => {
    const headline = headlineAt(LAST_CURRENT);
    expect(headline).toContain("The solvency claim is current.");
    expect(headline).not.toContain("lapsed");
  });
});

describe("an asset with no attestation", () => {
  it("is a third outcome, and not a lapse and not a failure", () => {
    const markup = framed(
      <AssetPage
        view={assetView({ record: assetRecord({ attestation: undefined }), observedSum: 42n })}
        history={undefined}
      />,
    );
    const headline = textOf(sectionOf(markup, SECTION_IDS.headline));
    expect(headline).toContain("no attestation");
    expect(headline).not.toContain("lapsed");
    expect(headline).not.toContain("fall short");
    // The observation still renders, and it still says that nothing covers it.
    expect(textOf(sectionOf(markup, SECTION_IDS.observedReserves))).toContain(
      "No attestation covers this reading",
    );
  });
});
