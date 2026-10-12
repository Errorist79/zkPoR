import { beforeEach, expect, it, vi } from "vitest";
import * as sdk from "@zkpor/sdk";
import type { Generation } from "@zkpor/sdk";
import { submitRun } from "../src/attestation.js";
import { SILENT_LOG } from "../src/log.js";
import { RunStore } from "../src/runs.js";
import { ASSET, REGISTRY, REPOSITORY_ROOT, assetRecord, reader } from "./support.js";

vi.mock("@zkpor/sdk", async (original) => ({
  ...await original<typeof import("@zkpor/sdk")>(),
  latestLedger: vi.fn(), readContext: vi.fn(), readMasterSecret: vi.fn(), locateAsset: vi.fn(),
  preparePriorGeneration: vi.fn(), prove: vi.fn(), attestWithAuthority: vi.fn(),
  readStoredAttestation: vi.fn(), writeCustomerPackages: vi.fn(),
}));

const GENERATION: Generation = {
  network: "testnet", registry: REGISTRY, verifier: REGISTRY, treeDepth: 12,
  aggregatorKeySha256: "a".repeat(64), registryWasmSha256: "b".repeat(64), verifierWasmSha256: "c".repeat(64),
};
const PRIOR: sdk.PriorGeneration = {
  attestationId: 4n, root: 40n, contextHash: 41n, manifestFile: "/private/packages/4/generation.json",
};
const STORED: sdk.StoredAttestation = {
  attestationId: 5n, contextHash: 51n, finalRoot: 50n, snapshotLedger: 5_000,
  totalLiabilities: 100n, reserveSum: 120n, attestedLedger: 5_100,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sdk.latestLedger).mockResolvedValue(5_100);
  vi.mocked(sdk.readContext).mockResolvedValue({ asset: ASSET, snapshotLedger: 5_000 });
  vi.mocked(sdk.readMasterSecret).mockResolvedValue(7n);
  vi.mocked(sdk.locateAsset).mockResolvedValue({
    holder: { generation: GENERATION, record: assetRecord({ attestation: { ...STORED, finalRoot: 999n } }) },
    asked: [GENERATION],
  });
  vi.mocked(sdk.preparePriorGeneration).mockResolvedValue(PRIOR);
  vi.mocked(sdk.prove).mockResolvedValue({
    proof: new Uint8Array(), publicInputs: new Uint8Array(),
    values: { context_hash: 51n, inner_key_hash: 0n, final_root: 50n, L: 100n },
  });
  vi.mocked(sdk.attestWithAuthority).mockResolvedValue({
    attestationId: 5n, transactionHash: "d".repeat(64), ledger: 5_100,
  });
  vi.mocked(sdk.readStoredAttestation).mockResolvedValue(STORED);
  vi.mocked(sdk.writeCustomerPackages).mockResolvedValue("/private/packages/5");
});

async function run() {
  const store = new RunStore();
  const started = await submitRun({
    store, reader: reader("[]"), repository: REPOSITORY_ROOT, log: SILENT_LOG,
    environment: { [sdk.MASTER_SECRET_ENV]: "private", [sdk.AUTHORITY_SECRET_ENV]: "private",
      [sdk.PACKAGES_OUT_ENV]: "/private/packages" },
    submission: { action: "attest", contextPath: "/private/context.toml", customersPath: "/private/customers.csv" },
  });
  await vi.waitFor(() => expect(store.get(started.run.id)?.stage).not.toBe("running"));
  return store.get(started.run.id);
}

it("passes continuity into proof and packages and reads the returned immutable attestation", async () => {
  const result = await run();
  expect(result?.stage).toBe("finished");
  expect(result?.submission?.attestationId).toBe(5n);
  expect(sdk.preparePriorGeneration).toHaveBeenCalledWith(expect.objectContaining({
    registry: REGISTRY, asset: ASSET, outputDirectory: "/private/packages",
  }));
  expect(sdk.prove).toHaveBeenCalledWith(expect.objectContaining({ network: "testnet", registry: REGISTRY, prior: PRIOR }));
  expect(sdk.readStoredAttestation).toHaveBeenCalledWith(expect.anything(), REGISTRY, ASSET, 5n, expect.anything());
  expect(sdk.writeCustomerPackages).toHaveBeenCalledWith(expect.objectContaining({
    attestationId: 5n, attestedContext: 51n, attestedRoot: 50n, attestedSnapshot: 5_000, prior: PRIOR,
  }));
});

it("stops before proof or transaction when the prior retained tree is unavailable", async () => {
  vi.mocked(sdk.preparePriorGeneration).mockRejectedValue(new Error("the prior tree is unavailable"));
  expect((await run())?.stage).toBe("failed");
  expect(sdk.prove).not.toHaveBeenCalled();
  expect(sdk.attestWithAuthority).not.toHaveBeenCalled();
  expect(sdk.writeCustomerPackages).not.toHaveBeenCalled();
});
