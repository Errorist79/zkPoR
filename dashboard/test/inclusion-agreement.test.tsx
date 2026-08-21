/**
 * The inclusion page and the command line, on one package.
 *
 * The two must reach one outcome. They do so because they call one function:
 * the page states no verdict of its own, it prints the lines that the kit
 * writes and the exit code that the kit assigns.
 *
 * The tests come in two parts, and the split has a reason. Four outcomes need
 * no network, because the kit reads the package, checks the deployment claim,
 * and checks the depth before it reads the chain. Those four run end to end
 * here, through the real route, against a client whose endpoint nothing
 * listens on, so a test that reached the network would fail rather than pass on
 * a value from elsewhere. The other three outcomes need an attestation from the
 * chain, so the agreement for them is checked on the verdict itself, over every
 * kind that the kit defines.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_CODES, exitCode, verdictLines } from "@zkpor/sdk";
import type { Verdict } from "@zkpor/sdk";
import { PACKAGE_PATH_FIELD, ROUTES, SECTION_IDS } from "../src/constants.js";
import { route } from "../src/routes.js";
import { InclusionVerdictPage } from "../src/views/inclusion.js";
import {
  ASSET,
  REGISTRY,
  REPOSITORY_ROOT,
  dashboard,
  request,
  sectionOf,
  framed,
  textOf,
} from "./support.js";

/** The deployments file of this repository, which the client trusts. */
let deploymentsText: string;

beforeAll(async () => {
  deploymentsText = await readFile(join(REPOSITORY_ROOT, "scripts", "deployments.json"), "utf8");
});

/** A registry address that the committed deployments file does not record. */
const UNTRUSTED_REGISTRY = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** A package that follows the schema of the specification. The values are test data. */
function packageFields(): Record<string, unknown> {
  return {
    format: "zkpor-inclusion/1",
    network: "testnet",
    registry: REGISTRY,
    asset: ASSET,
    snapshot_ledger: 5_000,
    leaf_index: 5,
    id: `0x${"0".repeat(63)}7`,
    balance: "100",
    salt: `0x${"0".repeat(63)}2`,
    siblings: Array.from(
      { length: 12 },
      (_, at) => `0x${(at + 10).toString(16).padStart(64, "0")}`,
    ),
  };
}

/** Writes one package file and returns its path. */
function writePackage(changes: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "zkpor-dashboard-"));
  const path = join(directory, "customer.zkpor.json");
  writeFileSync(path, `${JSON.stringify({ ...packageFields(), ...changes }, null, 2)}\n`);
  return path;
}

/** Asks the dashboard to check one package, through the real route. */
async function check(path: string, deployments = deploymentsText) {
  return await route(
    request({
      method: "POST",
      target: ROUTES.inclusion,
      body: new URLSearchParams({ [PACKAGE_PATH_FIELD]: path }).toString(),
    }),
    dashboard({ deploymentsText: deployments }),
  );
}

/**
 * The outcomes that the kit reaches before it reads the chain.
 *
 * Each case changes one field, and each names the outcome the kit gives it.
 */
const WITHOUT_A_NETWORK: readonly { changes: Record<string, unknown>; expected: Verdict }[] = [
  {
    changes: { format: "zkpor-inclusion/2" },
    expected: { kind: "unsupported-format", reason: "" },
  },
  { changes: { salt: "not a field element" }, expected: { kind: "malformed", reason: "" } },
  {
    changes: { registry: UNTRUSTED_REGISTRY },
    expected: {
      kind: "untrusted-deployment",
      reason: "",
      network: "testnet",
      registry: UNTRUSTED_REGISTRY,
    },
  },
  // The committed file records a depth of twelve, so a path of another length
  // is malformed against the generation the package names.
  {
    changes: { siblings: [`0x${"0".repeat(63)}3`] },
    expected: { kind: "malformed", reason: "" },
  },
];

describe("the page and the command line, on one package", () => {
  it.each(WITHOUT_A_NETWORK)("agree on the outcome $expected.kind", async ({ changes, expected }) => {
    const answered = await check(writePackage(changes));
    expect(answered.status).toBe(200);
    const shown = textOf(sectionOf(answered.body, SECTION_IDS.verdict));
    // The first line the kit writes names the outcome, and the page uses it as
    // the heading, so the page and the command line open with one sentence.
    const outcome = verdictLines(expected)[0];
    if (outcome === undefined) {
      throw new Error("the kit wrote no line for this outcome");
    }
    expect(shown).toContain(outcome);
    expect(shown).toContain(`the exit code ${exitCode(expected)}`);
  });

  it("reports a deployments file that contradicts itself as its own outcome", async () => {
    const twice = JSON.stringify([
      {
        network: "testnet",
        registry: REGISTRY,
        verifier: REGISTRY,
        aggregator_key_sha256: "aa",
        tree_depth: 12,
        registry_wasm_sha256: "a1",
        verifier_wasm_sha256: "b2",
      },
      {
        network: "testnet",
        registry: REGISTRY,
        verifier: REGISTRY,
        aggregator_key_sha256: "bb",
        tree_depth: 12,
        registry_wasm_sha256: "a1",
        verifier_wasm_sha256: "b2",
      },
    ]);
    const answered = await check(writePackage({}), twice);
    const verdict = textOf(sectionOf(answered.body, SECTION_IDS.verdict));
    expect(verdict).toContain("The deployments file of this verifier contradicts itself.");
    expect(verdict).toContain(`the exit code ${EXIT_CODES["invalid-deployments"]}`);
  });

  it("takes the trusted deployments file from the process and never from the package", async () => {
    // The package names a registry that the trusted file does not record. The
    // package must not be able to make the client trust it.
    const answered = await check(writePackage({ registry: UNTRUSTED_REGISTRY }));
    const verdict = textOf(sectionOf(answered.body, SECTION_IDS.verdict));
    expect(verdict).toContain("points at a registry this verifier does not trust");
  });
});

/** One verdict of each kind, so the agreement covers every outcome the kit defines. */
const EVERY_VERDICT: readonly Verdict[] = [
  {
    kind: "included",
    asset: ASSET,
    registry: REGISTRY,
    leafIndex: 5,
    balance: 100n,
    snapshotLedger: 5_000,
    attestedLedger: 5_100,
    totalLiabilities: 1_000n,
    reserveSum: 1_500n,
    currentLedger: 5_200,
    solvencyLapsed: false,
  },
  {
    kind: "included",
    asset: ASSET,
    registry: REGISTRY,
    leafIndex: 5,
    balance: 100n,
    snapshotLedger: 5_000,
    attestedLedger: 5_100,
    totalLiabilities: 1_000n,
    reserveSum: 1_500n,
    currentLedger: 9_000,
    solvencyLapsed: true,
  },
  { kind: "unsupported-format", reason: "another format" },
  { kind: "malformed", reason: "no salt" },
  { kind: "untrusted-deployment", reason: "no such registry", network: "testnet", registry: REGISTRY },
  { kind: "invalid-deployments", reason: "one pair twice" },
  { kind: "no-matching-attestation", reason: "another snapshot" },
  { kind: "root-mismatch", recomputed: 0x11n, attested: 0x22n },
];

describe("the verdict page", () => {
  it.each(EVERY_VERDICT)("states every line the kit writes for $kind", (verdict) => {
    const markup = framed(<InclusionVerdictPage verdict={verdict} />);
    const shown = textOf(sectionOf(markup, SECTION_IDS.verdict));
    for (const line of verdictLines(verdict)) {
      expect(shown).toContain(line);
    }
    expect(shown).toContain(`the exit code ${exitCode(verdict)}`);
  });

  it("covers every outcome that the kit defines", () => {
    const shown = new Set(EVERY_VERDICT.map((verdict) => verdict.kind));
    expect(shown).toEqual(new Set(Object.keys(EXIT_CODES)));
  });

  it("keeps inclusion and the currency of the claim as two statements", () => {
    const lapsed = EVERY_VERDICT[1];
    if (lapsed === undefined) {
      throw new Error("the list of verdicts lost the lapsed case");
    }
    const shown = textOf(sectionOf(framed(<InclusionVerdictPage verdict={lapsed} />), SECTION_IDS.verdict));
    expect(shown).toContain("The leaf is under the attested root.");
    expect(shown).toContain("The inclusion is valid.");
    expect(shown).toContain("The solvency claim has lapsed");
    // The outcome is still inclusion, so the code is still the code of an
    // included package. A lapse is not a failure of the check.
    expect(shown).toContain(`the exit code ${EXIT_CODES.included}`);
  });
});
