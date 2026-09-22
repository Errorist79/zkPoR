import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../src/guards.js";
import { toHex } from "../src/fr.js";
import { runWatchdog } from "../src/watchdog.js";
import { InfrastructureError } from "../src/network.js";
import { openDispute, readStoredDispute } from "../src/disputes.js";
import { verifyInclusion } from "../src/inclusion.js";
import { readStoredAttestation, readStoredAttestationHistory } from "../src/registry.js";
import { latestLedger } from "../src/network.js";

vi.mock("../src/inclusion.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/inclusion.js")>();
  return { ...real, verifyInclusion: vi.fn() };
});
vi.mock("../src/disputes.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/disputes.js")>();
  return { ...real, openDispute: vi.fn(), readStoredDispute: vi.fn() };
});
vi.mock("../src/registry.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/registry.js")>();
  return { ...real, readStoredAttestation: vi.fn(), readStoredAttestationHistory: vi.fn() };
});
vi.mock("../src/network.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/network.js")>();
  return { ...real, latestLedger: vi.fn() };
});

const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const NETWORK = { network: "testnet", rpcUrl: "http://127.0.0.1:1", networkPassphrase: Networks.TESTNET, allowHttp: true };
const SIGNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 14));
const DEPLOYMENTS = JSON.stringify([{
  network: "testnet", registry: REGISTRY, verifier: REGISTRY,
  aggregator_key_sha256: "aa", tree_depth: 1,
  registry_wasm_sha256: "bb", verifier_wasm_sha256: "cc",
}]);

function privateFixture(): { old: string; target: string; identity: string } {
  const vector: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "identity_vectors.json"), "utf8"));
  if (!isRecord(vector) || !Array.isArray(vector["cases"])) {
    throw new Error("the shared identity vectors are invalid");
  }
  const first: unknown = vector["cases"][0];
  if (!isRecord(first) || typeof first["email"] !== "string" ||
      typeof first["code"] !== "string" || typeof first["id_decimal"] !== "string") {
    throw new Error("the shared identity vector is invalid");
  }
  const template: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "synthetic_package_v2.zkpor.json"), "utf8"));
  if (!isRecord(template)) {
    throw new Error("the synthetic package is invalid");
  }
  const common = {
    ...template,
    format: "zkpor-inclusion/3",
    identifier_rule: "zkpor-email-code/1",
    network: "testnet",
    registry: REGISTRY,
    asset: ASSET,
    id: toHex(BigInt(first["id_decimal"])),
  };
  return {
    old: JSON.stringify({ ...common, attestation_id: "1" }),
    target: JSON.stringify({ ...common, attestation_id: "2" }),
    identity: JSON.stringify({ email: first["email"], code: first["code"] }),
  };
}

function missingTransaction(hash: string, closeTime: number): rpc.Api.GetMissingTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    txHash: hash,
    latestLedger: 200,
    latestLedgerCloseTime: closeTime,
    oldestLedger: 100,
    oldestLedgerCloseTime: closeTime - 100,
  };
}

let directory = "";
let server: rpc.Server;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "zkpor-watchdog-test-"));
  server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: true });
  server.getAccount = async () => new Account(SIGNER.publicKey(), "4");
  vi.mocked(verifyInclusion).mockResolvedValue({
    kind: "included", identityConfirmed: true, asset: ASSET, registry: REGISTRY,
    id: 7n, leafIndex: 0, balance: 1n, snapshotLedger: 90, attestedLedger: 100,
    totalLiabilities: 1n, reserveSum: 2n, currentLedger: 200, solvencyLapsed: false,
  });
  vi.mocked(readStoredAttestationHistory).mockResolvedValue({ attestations: [], totalCount: 2n, nextId: undefined });
  vi.mocked(readStoredAttestation).mockResolvedValue({
    attestationId: 2n, finalRoot: 2n, contextHash: 3n,
    snapshotLedger: 90, attestedLedger: 100, totalLiabilities: 1n, reserveSum: 2n,
  });
  vi.mocked(readStoredDispute).mockResolvedValue(undefined);
  vi.mocked(latestLedger).mockResolvedValue(200);
});

afterEach(() => {
  vi.resetAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function input() {
  const fixture = privateFixture();
  return {
    server,
    network: NETWORK,
    readOptions: {},
    deploymentsText: DEPLOYMENTS,
    oldPackageText: fixture.old,
    identityText: fixture.identity,
    packagesDirectory: directory,
    stateDirectory: join(directory, "state"),
    disputerSigner: SIGNER,
    deliveryGraceLedgers: 5,
  };
}

describe("operator watchdog", () => {
  it("waits for the configured package deadline and accepts a valid own package", async () => {
    vi.mocked(latestLedger).mockResolvedValueOnce(104);
    await expect(runWatchdog(input())).resolves.toMatchObject({
      kind: "waiting", targetId: 2n, deliveryDeadline: 105,
    });
    expect(openDispute).not.toHaveBeenCalled();
    writeFileSync(join(directory, "2.zkpor.json"), privateFixture().target);
    await expect(runWatchdog(input())).resolves.toMatchObject({ kind: "delivered", targetId: 2n });
    expect(openDispute).not.toHaveBeenCalled();
  });

  it("journals an uncertain send and does not send another deposit before expiry", async () => {
    const hash = "a".repeat(64);
    vi.mocked(openDispute).mockImplementationOnce(async (_server, _network, opening) => {
      await opening.beforeSend?.(hash, 1_000);
      throw new InfrastructureError("the submission outcome is unknown");
    });
    await expect(runWatchdog(input())).rejects.toThrow("unknown");
    server.getTransaction = async () => missingTransaction(hash, 999);
    await expect(runWatchdog(input())).resolves.toMatchObject({
      kind: "pending", targetId: 2n, transactionHash: hash, transactionStatus: "NOT_FOUND",
    });
    expect(openDispute).toHaveBeenCalledTimes(1);
  });

  it("retries one bounded transaction after its expiry and verified dispute absence", async () => {
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    vi.mocked(openDispute).mockImplementationOnce(async (_server, _network, opening) => {
      await opening.beforeSend?.(firstHash, 1_000);
      throw new InfrastructureError("the submission outcome is unknown");
    });
    await expect(runWatchdog(input())).rejects.toThrow("unknown");
    server.getTransaction = async () => missingTransaction(firstHash, 1_001);
    vi.mocked(openDispute).mockImplementationOnce(async (_server, _network, opening) => {
      await opening.beforeSend?.(secondHash, 1_300);
      throw new InfrastructureError("the next submission outcome is unknown");
    });
    await expect(runWatchdog(input())).rejects.toThrow("unknown");
    server.getTransaction = async () => missingTransaction(secondHash, 1_100);
    await expect(runWatchdog(input())).resolves.toMatchObject({
      kind: "pending", targetId: 2n, transactionHash: secondHash,
    });
    expect(openDispute).toHaveBeenCalledTimes(2);
  });

  it("does not treat an archive failure as a missing dispute", async () => {
    vi.mocked(readStoredDispute).mockRejectedValueOnce(new InfrastructureError("archived entry"));
    await expect(runWatchdog(input())).rejects.toThrow("archived entry");
    expect(openDispute).not.toHaveBeenCalled();
  });

  it("records an expired target and still opens for a later eligible target after restart", async () => {
    const hash = "c".repeat(64);
    vi.mocked(readStoredAttestationHistory).mockResolvedValue({ attestations: [], totalCount: 3n, nextId: undefined });
    vi.mocked(readStoredAttestation).mockImplementation(async (_network, _registry, _asset, id) => ({
      attestationId: id,
      finalRoot: 2n,
      contextHash: 3n,
      snapshotLedger: 1,
      attestedLedger: id === 2n ? 1 : 599_995,
      totalLiabilities: 1n,
      reserveSum: 2n,
    }));
    vi.mocked(latestLedger).mockResolvedValue(600_000);
    vi.mocked(readStoredDispute)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        disputer: SIGNER.publicKey(),
        origin: { kind: "inclusion", attestationId: 1n },
        targetId: 3n,
        identifier: 7n,
        openedLedger: 600_000,
        deadline: 651_840,
        status: "Open",
        closedLedger: 0,
        burnedBond: 0n,
      });
    vi.mocked(openDispute).mockImplementation(async (_server, _network, opening) => {
      await opening.beforeSend?.(hash, 1_000);
      return { transactionHash: hash, ledger: 600_000 };
    });
    await expect(runWatchdog(input())).resolves.toMatchObject({
      kind: "opened", targetId: 3n, skippedExpiredTargetId: 2n,
    });
    await expect(runWatchdog(input())).resolves.toMatchObject({
      kind: "expired", targetId: 2n,
    });
    expect(openDispute).toHaveBeenCalledTimes(1);
  });
});
