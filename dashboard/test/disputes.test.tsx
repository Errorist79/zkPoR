import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Account, Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@zkpor/sdk";
import type { DisputeRecord, StoredAttestation } from "@zkpor/sdk";
import { answerFromRetainedTree } from "../src/answer.js";
import { DISPUTE_FIELDS, ROUTES, SECTION_IDS } from "../src/constants.js";
import { disputePath, disputeSelection, readDisputeView } from "../src/dispute.js";
import { route } from "../src/routes.js";
import { DisputeForm, DisputePage } from "../src/views/dispute.js";
import { REPOSITORY_ROOT, dashboard, framed, reader, request, sectionOf, textOf } from "./support.js";

vi.mock("@zkpor/sdk", async (original) => ({
  ...await original<typeof import("@zkpor/sdk")>(),
  latestLedger: vi.fn(), readStoredDispute: vi.fn(), readStoredAttestation: vi.fn(),
  readAssetRecord: vi.fn(), runTool: vi.fn(), answerDispute: vi.fn(),
}));

const packageText = await readFile(join(REPOSITORY_ROOT, "fixtures/synthetic_package_v2.zkpor.json"), "utf8");
const entry = sdk.parsePackage(packageText);
const deploymentsText = await readFile(join(REPOSITORY_ROOT, "fixtures/synthetic_deployments.json"), "utf8");
const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const ROOT = sdk.rootFromPath({
  leaf: sdk.leafHash(entry), leafIndex: entry.leafIndex, siblings: entry.siblings,
  depth: entry.siblings.length,
});
const selection = {
  registry: entry.registry, asset: entry.asset, targetId: 2n, identifier: entry.id,
};
const OPEN: DisputeRecord = {
  disputer: issuer.publicKey(), origin: { kind: "inclusion", attestationId: 1n },
  targetId: selection.targetId, identifier: selection.identifier,
  openedLedger: 100, deadline: 200, status: "Open", closedLedger: 0, burnedBond: 0n,
};
const TARGET: StoredAttestation = {
  attestationId: selection.targetId, contextHash: entry.contextHash,
  finalRoot: ROOT, snapshotLedger: entry.snapshotLedger,
  totalLiabilities: entry.balance, reserveSum: entry.balance, attestedLedger: entry.snapshotLedger,
};
const SETTLED = { ledger: 150, transactionHash: "a".repeat(64) };

function answerInput() {
  const chain = reader(deploymentsText);
  chain.server.getAccount = async () => new Account(issuer.publicKey(), "1");
  return {
    reader: chain, selection, manifestPath: "/private/retained/generation.json",
    repository: REPOSITORY_ROOT, environment: { [sdk.AUTHORITY_SECRET_ENV]: issuer.secret() },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sdk.latestLedger).mockResolvedValue(150);
  vi.mocked(sdk.readStoredDispute).mockResolvedValue(OPEN);
  vi.mocked(sdk.readStoredAttestation).mockResolvedValue(TARGET);
  vi.mocked(sdk.readAssetRecord).mockResolvedValue({
    authority: issuer.publicKey(), tier: "ClassicIssuer", reserves: [], reserveSetHash: 1n,
    attestation: { ...TARGET, finalRoot: 999n },
  });
  vi.mocked(sdk.answerDispute).mockResolvedValue(SETTLED);
  vi.mocked(sdk.runTool).mockImplementation(async (_command, args) => {
    const output = args[7];
    if (output === undefined) { throw new Error("the answer output path is missing"); }
    await writeFile(output, JSON.stringify({
      id: sdk.toHex(entry.id), commitment: sdk.toHex(entry.commitment), position: entry.leafIndex,
      path: entry.siblings.map(sdk.toHex),
    }));
    return "redacted inclusion answer prepared\n";
  });
});

describe("fixed dispute status", () => {
  it("labels each lookup field and keeps full registry values behind short option labels", () => {
    const html = framed(<DisputeForm generations={sdk.generationsNewestFirst(deploymentsText, entry.network)} />);
    for (const name of [DISPUTE_FIELDS.registry, DISPUTE_FIELDS.asset, DISPUTE_FIELDS.targetId, DISPUTE_FIELDS.identifier]) {
      expect(html).toContain(`for="${name}"`);
      expect(html).toContain(`id="${name}"`);
      expect(html).toContain(`aria-describedby="${name}-help"`);
      expect(html).toContain(`id="${name}-help"`);
    }
    expect(html).toContain(`value="${selection.registry}"`);
    const option = html.match(new RegExp(`<option[^>]*value="${selection.registry}"[^>]*>([^<]+)</option>`));
    expect(option?.[1]).toContain("Registry 1:");
    expect(option?.[1]).not.toContain(selection.registry);
    expect(html).toContain("<summary>Compare full registry addresses</summary>");
    expect(html).toContain(`<dd class="address">${selection.registry}</dd>`);
    expect(textOf(html)).toContain("The older evidence package can name a different attestation");
  });

  it("uses an explicit trusted generation and does not read the latest asset entry", async () => {
    const view = await readDisputeView(reader(deploymentsText), selection);
    expect(view.target).toEqual(TARGET);
    expect(sdk.readStoredAttestation).toHaveBeenCalledWith(expect.anything(), selection.registry,
      selection.asset, selection.targetId, expect.anything());
    expect(sdk.readAssetRecord).not.toHaveBeenCalled();
    await expect(readDisputeView(reader("[]"), selection)).rejects.toThrow("trusted deployments");
  });

  it("shows absence only after a successful dispute read and propagates restoration failures", async () => {
    vi.mocked(sdk.readStoredDispute).mockResolvedValueOnce(undefined);
    const view = await readDisputeView(reader(deploymentsText), selection);
    const html = framed(<DisputePage view={view} />);
    expect(textOf(html)).toContain("no dispute for this exact target");
    expect(textOf(html)).toContain("does not confirm customer inclusion or reserve coverage");
    expect(textOf(html)).toContain("does not report a deposit payment or refund");
    expect(html).not.toContain(`action="${ROUTES.answer}"`);
    expect(sdk.readStoredAttestation).not.toHaveBeenCalled();
    vi.mocked(sdk.readStoredDispute).mockRejectedValueOnce(new Error("restore the archived entry"));
    await expect(readDisputeView(reader(deploymentsText), selection)).rejects.toThrow("restore");
  });

  it.each([
    { name: "open before deadline", status: "Open", ledger: 150, answer: true,
      heading: "Waiting for the issuer", deposit: "holds the 10 XLM deposit", next: "Issuer: use the retained tree" },
    { name: "open at deadline", status: "Open", ledger: 200, answer: true,
      heading: "Waiting for the issuer", deposit: "holds the 10 XLM deposit", next: "last ledger that permits an answer" },
    { name: "open after deadline", status: "Open", ledger: 201, answer: false,
      heading: "Resolution is pending", deposit: "No settlement is recorded yet", next: "remains open until a resolution transaction settles" },
    { name: "answered", status: "Answered", ledger: 201, answer: false,
      heading: "Inclusion confirmed for this customer", deposit: "paid the 10 XLM deposit to the issuer", next: "obtain the package for this target" },
    { name: "resolved without a bond", status: "OmissionProven", ledger: 201, answer: false,
      heading: "Dispute resolved after no accepted answer", deposit: "returned the 10 XLM deposit to the disputer", next: "No bond was available to burn" },
  ] as const)("explains the outcome and valid action for $name", async (scenario) => {
    vi.mocked(sdk.latestLedger).mockResolvedValue(scenario.ledger);
    vi.mocked(sdk.readStoredDispute).mockResolvedValue({ ...OPEN, status: scenario.status,
      origin: { kind: "email", keyId: 7n }, closedLedger: scenario.status === "Open" ? 0 : 201 });
    const view = await readDisputeView(reader(deploymentsText), selection);
    const html = framed(<DisputePage view={view} />);
    const text = textOf(sectionOf(html, SECTION_IDS.dispute));
    expect(text).toContain(scenario.heading);
    expect(text).toContain(scenario.deposit);
    expect(text).toContain(scenario.next);
    expect(html.includes(`action="${ROUTES.answer}"`)).toBe(scenario.answer);
    expect(text).not.toContain(selection.registry);
    expect(text).not.toContain(sdk.toHex(selection.identifier));
    expect(html).toContain('<details class="dispute-technical">');
    expect(html).toContain("<summary>Technical details and full identifiers</summary>");
    expect(textOf(html)).toContain("Email under registered key 7");
    expect(html).toContain(`<code>${scenario.status}</code>`);
    if (scenario.status === "OmissionProven") {
      expect(text).toContain("not a cryptographic proof that the customer was absent");
      expect(text).toContain("received no bounty");
    }
    if (scenario.status === "Answered") {
      expect(text).toContain("does not confirm that");
      expect(text).toContain("balance is correct");
    }
    if (scenario.answer) {
      expect(html).toContain(`name="${DISPUTE_FIELDS.registry}" value="${selection.registry}"`);
      expect(html).toContain(`name="${DISPUTE_FIELDS.identifier}" value="${sdk.toHex(selection.identifier)}"`);
      expect(html).toContain(`for="${DISPUTE_FIELDS.manifestPath}"`);
      expect(textOf(html)).toContain("configured issuer key on this machine");
    }
  });

  it("states a nonzero burned bond without claiming a payout or cryptographic absence", async () => {
    vi.mocked(sdk.readStoredDispute).mockResolvedValue({ ...OPEN, status: "OmissionProven", closedLedger: 201, burnedBond: 1_000_000_000n });
    const html = framed(<DisputePage view={await readDisputeView(reader(deploymentsText), selection)} />);
    expect(textOf(html)).toContain("permanently locked and recorded as burned");
    expect(textOf(html)).not.toContain("No bond was available");
    expect(textOf(html)).toContain("not a cryptographic proof that the customer was absent");
    expect(textOf(html)).toContain("received no bounty");
    expect(html).not.toContain(`action="${ROUTES.answer}"`);
  });
});

describe("retained tree answer", () => {
  it("binds the generator to the fixed historical target and confirms settlement", async () => {
    vi.mocked(sdk.readStoredDispute).mockResolvedValueOnce(OPEN)
      .mockResolvedValueOnce({ ...OPEN, status: "Answered", closedLedger: SETTLED.ledger });
    const runner = vi.mocked(sdk.runTool).getMockImplementation();
    let requestValue: unknown;
    vi.mocked(sdk.runTool).mockImplementation(async (command, args, options) => {
      const path = args[6];
      if (path === undefined || runner === undefined) { throw new Error("the generator request is missing"); }
      requestValue = JSON.parse(await readFile(path, "utf8"));
      expect(options.env?.[sdk.AUTHORITY_SECRET_ENV]).toBe("");
      expect(options.env?.[sdk.MASTER_SECRET_ENV]).toBe("");
      expect(options.env?.[sdk.DISPUTER_SECRET_ENV]).toBe("");
      expect(args).not.toContain(issuer.secret());
      return runner(command, args, options);
    });
    const result = await answerFromRetainedTree(answerInput());
    expect(requestValue).toEqual({
      network: entry.network, registry: entry.registry, asset: entry.asset,
      attestation_id: selection.targetId.toString(), context_hash: sdk.toHex(entry.contextHash),
      root: sdk.toHex(ROOT), snapshot_ledger: entry.snapshotLedger,
      tree_depth: entry.siblings.length, identifier: sdk.toHex(entry.id),
    });
    expect(result.submission).toEqual(SETTLED);
    expect(result.dispute?.status).toBe("Answered");
    expect(result.readFailure).toBeUndefined();
    expect(sdk.answerDispute).toHaveBeenCalledOnce();
  });

  it.each(["closed", "expired", "foreign-authority", "invalid-tree"])("sends no answer for %s", async (failure) => {
    if (failure === "closed") { vi.mocked(sdk.readStoredDispute).mockResolvedValue({ ...OPEN, status: "Answered" }); }
    if (failure === "expired") { vi.mocked(sdk.latestLedger).mockResolvedValue(201); }
    if (failure === "foreign-authority") { vi.mocked(sdk.readAssetRecord).mockResolvedValue(undefined); }
    if (failure === "invalid-tree") { vi.mocked(sdk.runTool).mockRejectedValue(new Error("the redacted tree differs from the requested attestation")); }
    await expect(answerFromRetainedTree(answerInput())).rejects.toThrow();
    expect(sdk.answerDispute).not.toHaveBeenCalled();
  });

  it("preserves the settled transaction if the status reread fails", async () => {
    vi.mocked(sdk.readStoredDispute).mockResolvedValueOnce(OPEN).mockRejectedValueOnce(new Error("RPC unavailable"));
    const result = await answerFromRetainedTree(answerInput());
    expect(result.submission).toEqual(SETTLED);
    expect(result.readFailure).toContain("settled");
  });
});

describe("dispute routes", () => {
  it("preserves submitted lookup fields when the target ID needs correction", async () => {
    const fields = new URLSearchParams(disputePath(selection).split("?")[1]);
    fields.set(DISPUTE_FIELDS.targetId, "01");
    const response = await route(request({ target: `${ROUTES.dispute}?${fields}` }), dashboard({ deploymentsText }));
    expect(response.status).toBe(400);
    expect(response.body).toContain('role="alert"');
    expect(response.body).toMatch(new RegExp(`<option(?=[^>]*value="${selection.registry}")(?=[^>]*selected)[^>]*>`));
    for (const [name, value] of fields) {
      if (name === DISPUTE_FIELDS.registry) continue;
      expect(response.body).toMatch(new RegExp(`<input(?=[^>]*name="${name}")(?=[^>]*value="${value}")[^>]*>`));
    }
    expect(sdk.readStoredDispute).not.toHaveBeenCalled();
  });

  it("reads status through GET and rejects foreign-origin answers before any chain call", async () => {
    const app = dashboard({ deploymentsText });
    const page = await route(request({ target: disputePath(selection) }), app);
    expect(page.status).toBe(200);
    expect(page.body).toContain(SECTION_IDS.dispute);
    vi.mocked(sdk.readStoredDispute).mockClear();
    const blocked = await route(request({ target: ROUTES.answer, method: "POST", fetchSite: "cross-site" }), app);
    expect(blocked.status).toBe(403);
    expect(sdk.readStoredDispute).not.toHaveBeenCalled();
    expect(sdk.answerDispute).not.toHaveBeenCalled();
  });

  it("rejects ambiguous target IDs and padding identifiers", () => {
    const fields = new URLSearchParams(disputePath(selection).split("?")[1]);
    fields.set(DISPUTE_FIELDS.targetId, "01");
    expect(() => disputeSelection(fields)).toThrow();
    fields.set(DISPUTE_FIELDS.targetId, "1");
    fields.set(DISPUTE_FIELDS.identifier, sdk.toHex(0n));
    expect(() => disputeSelection(fields)).toThrow("nonzero");
  });
});
