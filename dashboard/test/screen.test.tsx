/**
 * What a reader can act on from a page alone.
 *
 * These are not questions about correctness. Each one is a place where a page
 * told a reader to do something they could not do, or gave them a number they
 * could not read. A page that is right and unusable fails the person in front
 * of it.
 */

import { describe, expect, it } from "vitest";
import { AssetPage, Home } from "../src/views/asset.js";
import { InclusionForm } from "../src/views/inclusion.js";
import { RunPage } from "../src/views/run.js";
import { ASSET, assetView, framed, historyBlock } from "./support.js";
import type { Run } from "../src/runs.js";

const HOLDER = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const OTHER = "CCHUTDKUPWXVUIX6D26SE5NZ5STP74VV4DY2CNVCMNJYOU5PTROLA7MY";

describe("what a page tells a reader to do", () => {
  it("does not send the reader to a registry address in the frame", () => {
    // The frame stopped naming a registry, and this page still pointed at it.
    const markup = framed(<Home />);
    expect(markup).not.toContain("in the frame above");
    expect(markup).not.toContain("registered with this registry");
  });

  it("defines a generation before a page uses the word", () => {
    // The word carries the whole point of the release and appeared first on the
    // page that answers, with no page defining it.
    const markup = framed(<Home />);
    expect(markup).toContain("A generation is one deployment of the registry");
  });

  it("says why the inclusion field will not take a directory", () => {
    // The refusal is a rule and not a limitation: each file holds one
    // customer's balance, so choosing one would be the page deciding whose.
    const markup = framed(<InclusionForm />);
    expect(markup).toContain("deciding whose balance to show");
  });

  it("says the inclusion field wants a file, and names the shape of the name", () => {
    // A run reports a directory. A reader who pastes it reaches a directory and
    // is told the file is unreadable, with nothing on either page naming the
    // file inside it.
    const markup = framed(<InclusionForm />);
    expect(markup).toContain("not the directory that a run reports");
    expect(markup).toContain("package-000000.zkpor.json");
  });

  it("says what unit its figures are in", () => {
    // A reader who does not know Stellar reads 150000000000 as an amount.
    const markup = framed(<AssetPage view={assetView()} history={undefined} />);
    expect(markup).toContain("smallest unit");
    expect(markup).toContain("stroops");
  });

  it("names the registry that accepted an attestation", () => {
    // This is the page where the resolution takes effect, and it could not say
    // which generation received the attestation.
    const run: Run = {
      id: "0a1b2c3d-0000-4000-8000-000000000000",
      action: "attest",
      asset: ASSET,
      snapshotLedger: 5_000,
      stage: "finished",
      steps: [],
      proof: { proofBytes: 14_592, finalRoot: 1n, totalLiabilities: 2n, contextHash: 3n },
      submission: { ledger: 5_100, transactionHash: "a".repeat(64), registry: HOLDER },
      window: { currentLedger: 5_100, stillOpen: true },
      failure: undefined,
    };
    const markup = framed(<RunPage run={run} joined={false} />);
    expect(markup).toContain(HOLDER);
  });

  it("says which generations it asked before one answered", () => {
    // A reader learned how this client finds a record only when it failed.
    const markup = framed(
      <AssetPage
        view={assetView({ asked: [OTHER, HOLDER], registry: HOLDER })}
        history={{ blocks: [historyBlock({ registry: HOLDER })] }}
      />,
    );
    expect(markup).toContain("asked");
    expect(markup).toContain(OTHER);
  });
});
