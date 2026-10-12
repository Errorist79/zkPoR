import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Networks, SorobanDataBuilder, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePriorGeneration } from "../src/prior-generation.js";
import { writeCustomerPackages } from "../src/proving.js";
import { toHex } from "../src/fr.js";

const calls = vi.hoisted(() => {
  const commands: { command: string; args: readonly string[] }[] = [];
  return { commands };
});

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { writeFileSync: write } = await import("node:fs");
  return {
    ...real,
    spawn: (command: string, args: readonly string[], options: unknown) => {
      calls.commands.push({ command, args });
      const reportFlag = args.indexOf("--report-file");
      const reportPath = args[reportFlag + 1];
      if (reportPath === undefined) {
        throw new Error("the packages call has no report file");
      }
      write(reportPath, "/private/packages/testnet/registry/asset/3\n");
      return real.spawn(process.execPath, ["-e", ""], Object(options));
    },
  };
});

const NETWORK = {
  network: "testnet", rpcUrl: "http://127.0.0.1:1", networkPassphrase: Networks.TESTNET, allowHttp: true,
};
const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";

function stored(root: bigint, context: bigint): xdr.ScVal {
  return nativeToScVal({
    final_root: nativeToScVal(root, { type: "u256" }),
    context_hash: nativeToScVal(context, { type: "u256" }),
    snapshot_ledger: nativeToScVal(100, { type: "u32" }),
    attested_ledger: nativeToScVal(101, { type: "u32" }),
    total_liabilities: nativeToScVal(100n, { type: "u128" }),
    reserve_sum: nativeToScVal(200n, { type: "u128" }),
  });
}

function serverWithHistory(): rpc.Server {
  const server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: true });
  const answers = [nativeToScVal(2n, { type: "u64" }), stored(10n, 11n), stored(20n, 21n)];
  server.simulateTransaction = async (): Promise<rpc.Api.SimulateTransactionResponse> => {
    const retval = answers.shift();
    if (retval === undefined) {
      throw new Error("the test has no stored response");
    }
    return {
      id: "1", latestLedger: 200, events: [], _parsed: true,
      transactionData: new SorobanDataBuilder(), minResourceFee: "0",
      result: { auth: [], retval },
    };
  };
  return server;
}

let directory = "";

afterEach(() => {
  calls.commands.length = 0;
  if (directory.length > 0) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("fixed package generation", () => {
  it("reads the last fixed record and requires its retained manifest before a new proof", async () => {
    directory = mkdtempSync(join(tmpdir(), "zkpor-prior-test-"));
    const manifest = join(directory, "packages", "testnet", REGISTRY, ASSET, "2", "generation.json");
    mkdirSync(join(directory, "packages", "testnet", REGISTRY, ASSET, "2"), { recursive: true });
    writeFileSync(manifest, "{}\n");
    await expect(preparePriorGeneration({
      server: serverWithHistory(), network: NETWORK, readOptions: {},
      registry: REGISTRY, asset: ASSET, outputDirectory: directory,
    })).resolves.toEqual({ attestationId: 2n, root: 20n, contextHash: 21n, manifestFile: manifest });
    rmSync(manifest);
    await expect(preparePriorGeneration({
      server: serverWithHistory(), network: NETWORK, readOptions: {},
      registry: REGISTRY, asset: ASSET, outputDirectory: directory,
    })).rejects.toThrow("prior generation manifest is missing");
  });

  it("passes the fixed ID, context, and prior tree to the actual generator command", async () => {
    directory = mkdtempSync(join(tmpdir(), "zkpor-packages-test-"));
    mkdirSync(join(directory, "tools", "recursion-gen"), { recursive: true });
    const priorManifest = join(directory, "packages", "testnet", REGISTRY, ASSET, "2", "generation.json");
    mkdirSync(join(directory, "packages", "testnet", REGISTRY, ASSET, "2"), { recursive: true });
    writeFileSync(priorManifest, "{}\n");
    const result = await writeCustomerPackages({
      repository: directory,
      contextFile: join(directory, "context.toml"),
      customersFile: join(directory, "customers.csv"),
      outputDirectory: directory,
      masterSecret: 1n,
      network: NETWORK.network,
      registry: REGISTRY,
      attestedRoot: 30n,
      attestedContext: 31n,
      attestedSnapshot: 100,
      attestationId: 3n,
      prior: { attestationId: 2n, root: 20n, contextHash: 21n, manifestFile: priorManifest },
      transactionHash: "a".repeat(64),
      deploymentsFile: join(directory, "deployments.json"),
    });
    expect(result).toBe("/private/packages/testnet/registry/asset/3");
    expect(calls.commands).toHaveLength(1);
    const args = calls.commands[0]?.args;
    if (args === undefined) {
      throw new Error("the generator was not called");
    }
    const flag = (name: string): string | undefined => args[args.indexOf(name) + 1];
    expect(flag("--network")).toBe("testnet");
    expect(flag("--registry")).toBe(REGISTRY);
    expect(flag("--attestation-id")).toBe("3");
    expect(flag("--attested-root")).toBe(toHex(30n));
    expect(flag("--attested-context")).toBe(toHex(31n));
    expect(flag("--prior-manifest")).toBe(priorManifest);
    expect(flag("--prior-attestation-id")).toBe("2");
    expect(flag("--prior-root")).toBe(toHex(20n));
    expect(flag("--prior-context")).toBe(toHex(21n));
    expect(flag("--transaction")).toBe("a".repeat(64));
  });
});
