import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, Keypair, Networks, SorobanDataBuilder, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitReserveObservation, RegistryRefusedError } from "../src/registry.js";
import { InfrastructureError } from "../src/network.js";
import * as registration from "../src/registration.js";
import { registryReturns } from "./fixture-guards.js";

const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const SIGNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const NETWORK = {
  network: "testnet", rpcUrl: "http://127.0.0.1:1", networkPassphrase: Networks.TESTNET, allowHttp: true,
};
const FIXTURE = registryReturns(readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "registry_returns.json"), "utf8"));
const OBSERVATION = FIXTURE.returns.find((entry) => entry.call === "observe_reserves");
if (OBSERVATION === undefined) {
  throw new Error("the return fixture contains no observation");
}
const STORED_RETURN = xdr.ScVal.fromXDR(OBSERVATION.scval, "base64");

function serverFor(response: xdr.ScVal | string | Error): rpc.Server {
  const server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: true });
  server.simulateTransaction = async (): Promise<rpc.Api.SimulateTransactionResponse> => {
    if (response instanceof Error) {
      throw response;
    }
    const base = { id: "1", latestLedger: 500, events: [], _parsed: true };
    if (typeof response === "string") {
      return { ...base, error: response };
    }
    return {
      ...base,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "0",
      result: { auth: [], retval: response },
    };
  };
  return server;
}

function submit(server: rpc.Server) {
  return submitReserveObservation(server, NETWORK, {
    sourceAccount: new Account(SIGNER.publicKey(), "4"), sourceSigner: SIGNER, registry: REGISTRY, asset: ASSET,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("observation transaction submission", () => {
  it("signs a permissionless call and returns only the settled transaction result", async () => {
    const settled = { transactionHash: "c".repeat(64), ledger: 600 };
    const send = vi.spyOn(registration, "sendAndSettle").mockResolvedValue(settled);
    const server = serverFor(STORED_RETURN);
    expect(await submit(server)).toEqual(settled);
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0];
    if (call === undefined) {
      throw new Error("the observation was not submitted");
    }
    expect(call[0]).toBe(server);
    const envelope = call[1].toEnvelope().v1();
    expect(envelope.signatures()).toHaveLength(1);
    const operation = envelope.tx().operations()[0];
    if (operation === undefined) {
      throw new Error("the transaction contains no operation");
    }
    const invocation = operation.body().invokeHostFunctionOp().hostFunction().invokeContract();
    expect(invocation.functionName().toString()).toBe("observe_reserves");
    expect(invocation.args()).toHaveLength(1);
    expect(call[1].source).toBe(SIGNER.publicKey());
    expect(call[1].sequence).toBe("5");
  });

  it("does not submit to a legacy registry that cannot store observations", async () => {
    const send = vi.spyOn(registration, "sendAndSettle");
    const legacy = nativeToScVal({ observed_sum: 1n, observed_ledger: 500 }, {
      type: { observed_sum: ["symbol", "i128"], observed_ledger: ["symbol", "u32"] },
    });
    await expect(submit(serverFor(legacy))).rejects.toThrow("does not support recorded observations");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([new Error("RPC disconnected"), "restore required"])("preserves a simulation failure: %s", async (failure) => {
    const send = vi.spyOn(registration, "sendAndSettle");
    await expect(submit(serverFor(failure))).rejects.toThrow(InfrastructureError);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a contract refusal distinct from an RPC failure", async () => {
    await expect(submit(serverFor("Error(Contract, #17)"))).rejects.toThrow(RegistryRefusedError);
  });

  it("does not return the simulation as success when settlement fails", async () => {
    vi.spyOn(registration, "sendAndSettle").mockRejectedValue(new InfrastructureError("settlement failed"));
    await expect(submit(serverFor(STORED_RETURN))).rejects.toThrow("settlement failed");
  });
});
