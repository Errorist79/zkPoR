import { Account, Keypair, Networks, SorobanDataBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitAttestation } from "../src/attest.js";
import { InfrastructureError } from "../src/network.js";
import * as registration from "../src/registration.js";

const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const SIGNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 15));
const NETWORK = {
  network: "testnet", rpcUrl: "http://127.0.0.1:1", networkPassphrase: Networks.TESTNET, allowHttp: true,
};

function server(): rpc.Server {
  const client = new rpc.Server(NETWORK.rpcUrl, { allowHttp: true });
  client.getHealth = async () => ({
    status: "healthy", latestLedger: 100, oldestLedger: 1, ledgerRetentionWindow: 100,
  });
  client.simulateTransaction = async (): Promise<rpc.Api.SimulateTransactionResponse> => ({
    id: "1", latestLedger: 100, events: [], _parsed: true,
    transactionData: new SorobanDataBuilder(), minResourceFee: "0",
    result: { auth: [], retval: nativeToScVal(3n, { type: "u64" }) },
  });
  return client;
}

function input() {
  return {
    sourceAccount: new Account(SIGNER.publicKey(), "4"), authoritySigner: SIGNER,
    registry: REGISTRY, asset: ASSET, snapshotLedger: 90, finalRoot: 1n,
    totalLiabilities: 2n, proof: new Uint8Array([1]),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("accepted attestation identifier", () => {
  it("uses the successful contract return rather than a mutable latest slot", async () => {
    vi.spyOn(registration, "sendAndSettle").mockResolvedValue({
      transactionHash: "a".repeat(64), ledger: 101,
      returnValue: nativeToScVal(3n, { type: "u64" }),
    });
    await expect(submitAttestation(server(), NETWORK, input())).resolves.toMatchObject({
      attestationId: 3n, ledger: 101,
    });
  });

  it("does not guess an identifier when the settled return is missing", async () => {
    vi.spyOn(registration, "sendAndSettle").mockResolvedValue({ transactionHash: "a".repeat(64), ledger: 101 });
    await expect(submitAttestation(server(), NETWORK, input())).rejects.toThrow(InfrastructureError);
  });
});
