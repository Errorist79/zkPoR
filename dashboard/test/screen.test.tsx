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
import { InclusionForm, InclusionVerdictPage } from "../src/views/inclusion.js";
import { RunPage } from "../src/views/run.js";
import { ASSET, assetView, framed, historyBlock } from "./support.js";
import type { Run } from "../src/runs.js";

const HOLDER = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const OTHER = "CCHUTDKUPWXVUIX6D26SE5NZ5STP74VV4DY2CNVCMNJYOU5PTROLA7MY";

describe("what the page says about the two figures", () => {
  it("says only one of the two is bound to its ledger", () => {
    // The registry read the reserves on chain inside the attestation. The
    // issuer asserted the liabilities for that ledger and nothing checks that
    // the balances belong to it. The page puts them side by side.
    const markup = framed(<AssetPage view={assetView()} history={undefined} />);
    expect(markup).toContain("not bound to their ledger in the same way");
  });
});

describe("a sentence that points at a value the page carries", () => {
  /** Every verdict kind, with the one that names a registry first. */
  const VERDICTS = [
    {
      kind: "included" as const,
      asset: "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3",
      registry: HOLDER,
      leafIndex: 0,
      balance: 1n,
      snapshotLedger: 1,
      attestedLedger: 2,
      totalLiabilities: 1n,
      reserveSum: 2n,
      currentLedger: 3,
      solvencyLapsed: false,
    },
    { kind: "unsupported-format" as const, reason: "a reason" },
    { kind: "malformed" as const, reason: "a reason" },
    {
      kind: "untrusted-deployment" as const,
      reason: "a reason",
      network: "testnet",
      registry: OTHER,
    },
    { kind: "invalid-deployments" as const, reason: "a reason" },
    { kind: "no-matching-attestation" as const, reason: "a reason" },
    { kind: "root-mismatch" as const, recomputed: 1n, attested: 2n },
  ];

  it("explains the two registries only where the page names one", () => {
    // Six of the seven verdicts name no registry, and the paragraph pointed at
    // one on all of them. On the untrusted verdict it was worse than dangling:
    // the page refuses to read an address and the sentence then claimed a
    // relationship with it.
    for (const verdict of VERDICTS) {
      const markup = framed(<InclusionVerdictPage verdict={verdict} />);
      const explains = markup.includes("is the one this package names");
      expect(explains, `${verdict.kind} explains the two registries`).toBe(
        verdict.kind === "included",
      );
    }
  });
});

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
      packages: "/root/sitting/run/packages/packages/CBSQ/4265644",
      failure: undefined,
    };
    const markup = framed(<RunPage run={run} joined={false} />);
    expect(markup).toContain(HOLDER);
    // The directory belongs under the heading a reader goes to for it, and not
    // only in the last line of the steps, inside a sentence.
    expect(markup).toContain("The packages of the customers");
    expect(markup).toContain("/root/sitting/run/packages/packages/CBSQ/4265644");
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
