/**
 * The configuration that every front end of this client shares.
 *
 * The command line and the dashboard resolve their endpoint, their network, and
 * their deployments file here, so a change in this file changes both at once.
 * Two defaults below are decisions and not accidents, and each has a test that
 * fails when it moves: an empty variable counts as a variable that the
 * environment does not carry, and a read source that the environment omits
 * gives an empty option rather than a failure.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SECRET_ENV,
  ConfigurationError,
  DEFAULT_DEPLOYMENTS,
  DEPLOYMENTS_ENV,
  NETWORK_ENV,
  PASSPHRASE_ENV,
  READ_SOURCE_ENV,
  RESERVE_SECRET_ENV,
  RPC_URL_ENV,
  deploymentsPath,
  readDeployments,
  resolveNetworkConfig,
  resolveReadOptions,
} from "../src/config.js";
import { HISTORY_DEFAULT_LEDGERS } from "../src/constants.js";
import { defaultHistoryStart } from "../src/registry.js";
import { InfrastructureError, openServer } from "../src/network.js";
import { Keypair } from "@stellar/stellar-sdk";
import { AttestationInputError, attestWithAuthority } from "../src/attest.js";
import { ProvingError, parseContext, readContext } from "../src/proving.js";

/** An account address. The value is test data. */
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * The message of the refusal that a call makes.
 *
 * A test that asks only for the type of the failure passes when the resolver
 * refuses for another reason, and a test that matches a substring passes when
 * one variable name is the start of another. `ZKPOR_NETWORK` is the start of
 * `ZKPOR_NETWORK_PASSPHRASE`, so every assertion below reads the whole message.
 */
function refusalOf(call: () => unknown): string {
  try {
    call();
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      return cause.message;
    }
    throw cause;
  }
  throw new Error("the call refused nothing");
}

/** True when the message names this variable and no longer one that starts with it. */
function names(message: string, variable: string): boolean {
  return new RegExp(`${variable}(?![A-Z_])`).test(message);
}

/** An environment that carries what every read needs. */
function environment(changes: Record<string, string> = {}): Record<string, string> {
  return { [NETWORK_ENV]: "testnet", [RPC_URL_ENV]: "https://example.invalid", ...changes };
}

describe("the names of the variables", () => {
  it("are the names that the documents publish", () => {
    // A rename here silently stops reading an operator's environment, and the
    // tool then reports a missing value that the operator did set.
    expect(NETWORK_ENV).toBe("ZKPOR_NETWORK");
    expect(RPC_URL_ENV).toBe("ZKPOR_RPC_URL");
    expect(PASSPHRASE_ENV).toBe("ZKPOR_NETWORK_PASSPHRASE");
    expect(READ_SOURCE_ENV).toBe("ZKPOR_READ_SOURCE");
    expect(DEPLOYMENTS_ENV).toBe("ZKPOR_DEPLOYMENTS");
    expect(RESERVE_SECRET_ENV).toBe("ZKPOR_RESERVE_SECRET");
    expect(AUTHORITY_SECRET_ENV).toBe("ZKPOR_AUTHORITY_SECRET");
    expect(DEFAULT_DEPLOYMENTS).toBe("scripts/deployments.json");
  });
});

describe("the network configuration", () => {
  it("reads the network, the endpoint, and a known passphrase", () => {
    const config = resolveNetworkConfig(environment());
    expect(config.network).toBe("testnet");
    expect(config.rpcUrl).toBe("https://example.invalid");
    expect(config.networkPassphrase).toContain("Test SDF Network");
  });

  it("takes the passphrase of the environment over the one it knows", () => {
    const config = resolveNetworkConfig(environment({ [PASSPHRASE_ENV]: "a passphrase of its own" }));
    expect(config.networkPassphrase).toBe("a passphrase of its own");
  });

  it("allows plain text only for an endpoint that asks for it", () => {
    expect(resolveNetworkConfig(environment()).allowHttp).toBe(false);
    expect(
      resolveNetworkConfig(environment({ [RPC_URL_ENV]: "http://127.0.0.1:8000" })).allowHttp,
    ).toBe(true);
  });

  it("refuses a network that the environment does not carry", () => {
    const message = refusalOf(() =>
      resolveNetworkConfig({ [RPC_URL_ENV]: "https://example.invalid" }),
    );
    expect(names(message, NETWORK_ENV)).toBe(true);
    expect(names(message, PASSPHRASE_ENV)).toBe(false);
  });

  it("refuses an endpoint that the environment does not carry", () => {
    const message = refusalOf(() => resolveNetworkConfig({ [NETWORK_ENV]: "testnet" }));
    expect(names(message, RPC_URL_ENV)).toBe(true);
  });

  it("counts an empty variable as a variable that the environment does not carry", () => {
    // A shell that exports an empty value is the common way an operator gets
    // here. Treating it as present would build a client with no network name.
    //
    // Each assertion names the variable it expects in the message. An empty
    // network name also fails later, when no passphrase matches it, so a test
    // that asked only for the type of the failure would pass against a resolver
    // that had stopped checking for the empty value at all.
    const emptyNetwork = refusalOf(() => resolveNetworkConfig(environment({ [NETWORK_ENV]: "" })));
    expect(names(emptyNetwork, NETWORK_ENV)).toBe(true);
    // An empty network name also fails later, when no passphrase matches it. A
    // refusal that named the passphrase would mean the empty check had gone.
    expect(names(emptyNetwork, PASSPHRASE_ENV)).toBe(false);

    const emptyEndpoint = refusalOf(() => resolveNetworkConfig(environment({ [RPC_URL_ENV]: "" })));
    expect(names(emptyEndpoint, RPC_URL_ENV)).toBe(true);
  });

  it("refuses a network it does not know, when no passphrase names it", () => {
    const message = refusalOf(() =>
      resolveNetworkConfig({ ...environment(), [NETWORK_ENV]: "nowhere" }),
    );
    expect(names(message, PASSPHRASE_ENV)).toBe(true);
    expect(message).toContain("nowhere");
  });
});

describe("the account that a read simulates as", () => {
  it("gives an empty option when the environment names none", () => {
    // A read needs no signature and no funds, so an absent value is a normal
    // configuration and never a failure.
    expect(resolveReadOptions({})).toEqual({});
    expect(resolveReadOptions({ [READ_SOURCE_ENV]: "" })).toEqual({});
  });

  it("reads an address that the environment names", () => {
    expect(resolveReadOptions({ [READ_SOURCE_ENV]: ACCOUNT })).toEqual({
      readSourceAccount: ACCOUNT,
    });
  });

  it("refuses a value that is not an address", () => {
    expect(() => resolveReadOptions({ [READ_SOURCE_ENV]: "not an address" })).toThrow(
      ConfigurationError,
    );
  });
});

describe("the deployments file", () => {
  it("prefers the argument, then the environment, then the default", () => {
    expect(deploymentsPath({}, "given.json")).toBe("given.json");
    expect(deploymentsPath({ [DEPLOYMENTS_ENV]: "named.json" })).toBe("named.json");
    expect(deploymentsPath({ [DEPLOYMENTS_ENV]: "named.json" }, "given.json")).toBe("given.json");
    expect(deploymentsPath({})).toBe(DEFAULT_DEPLOYMENTS);
  });

  it("reads the file that it chose", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zkpor-config-"));
    const path = join(directory, "deployments.json");
    writeFileSync(path, "[]\n");
    expect(await readDeployments({}, path)).toBe("[]\n");
  });

  it("reports a file it cannot read as a failure of the client", async () => {
    await expect(readDeployments({}, "/no/such/deployments.json")).rejects.toThrow(
      InfrastructureError,
    );
  });
});

describe("the context file", () => {
  it("reads the asset and the snapshot ledger", () => {
    const context = parseContext('asset = "CBBB"\nsnapshot_ledger = 4187501\n', "context.toml");
    expect(context.asset).toBe("CBBB");
    expect(context.snapshotLedger).toBe(4187501);
  });

  it("reads the two fields whatever else the file holds, and in any order", () => {
    const context = parseContext(
      '# a comment\nsnapshot_ledger = 12\nother = "value"\nasset = "CAAA"\n',
      "context.toml",
    );
    expect(context.asset).toBe("CAAA");
    expect(context.snapshotLedger).toBe(12);
  });

  it("refuses a file that names no asset", () => {
    expect(() => parseContext("snapshot_ledger = 1\n", "context.toml")).toThrow(ProvingError);
    expect(() => parseContext("snapshot_ledger = 1\n", "context.toml")).toThrow("names no asset");
  });

  it("refuses a file that states no snapshot ledger", () => {
    expect(() => parseContext('asset = "CBBB"\n', "context.toml")).toThrow(ProvingError);
    expect(() => parseContext('asset = "CBBB"\n', "context.toml")).toThrow("snapshot_ledger");
  });

  it("names the path it read, so an operator knows which file to correct", () => {
    expect(() => parseContext("", "the/named/file.toml")).toThrow("the/named/file.toml");
  });

  it("reports a file it cannot read as a value the operator can correct", async () => {
    // The kind matters. The command line maps this to the usage code, and the
    // test of the built command line reads that code.
    await expect(readContext("/no/such/context.toml")).rejects.toThrow(ProvingError);
  });

  it("reads a file from disk", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zkpor-context-"));
    const path = join(directory, "context.toml");
    writeFileSync(path, 'asset = "CCCC"\nsnapshot_ledger = 7\n');
    expect(await readContext(path)).toEqual({ asset: "CCCC", snapshotLedger: 7 });
  });
});

describe("the attestation that takes a secret key", () => {
  /** A client of an endpoint that nothing listens on. */
  function unreachable() {
    const config = {
      network: "testnet",
      rpcUrl: "http://127.0.0.1:1/",
      networkPassphrase: "Test SDF Network ; September 2015",
      allowHttp: true,
    };
    return { server: openServer(config), config };
  }

  /** The values of one attestation. Every value is test data. */
  const VALUES = {
    registry: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    asset: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    snapshotLedger: 100,
    finalRoot: 1n,
    totalLiabilities: 1n,
    proof: new Uint8Array([1]),
  };

  it("refuses a value that is not a Stellar secret key, before it reaches the network", async () => {
    // The refusal comes from the input check and not from the failed read of
    // the endpoint below, which nothing listens on.
    const { server, config } = unreachable();
    await expect(
      attestWithAuthority(server, config, "not a secret key", VALUES),
    ).rejects.toThrow(AttestationInputError);
  });

  it("reports a failure to read the account as a failure of the client", async () => {
    // The key is well formed, so the call gets past the input check and asks
    // the endpoint for the account. That read fails, and a failure of the
    // network is not a refusal of the input.
    const { server, config } = unreachable();
    const refused = await attestWithAuthority(
      server,
      config,
      Keypair.random().secret(),
      VALUES,
    ).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(InfrastructureError);
    expect(refused).not.toBeInstanceOf(AttestationInputError);
  });

  it("names the account it could not read, and never the key", async () => {
    const { server, config } = unreachable();
    const signer = Keypair.random();
    const refused = await attestWithAuthority(server, config, signer.secret(), VALUES).catch(
      (cause: unknown) => cause,
    );
    if (!(refused instanceof Error)) {
      throw new Error("the call refused nothing");
    }
    // The public key names the account an operator must fund or create. The
    // secret key must appear nowhere, because this message reaches a log.
    expect(refused.message).toContain(signer.publicKey());
    expect(refused.message).not.toContain(signer.secret());
  });
});

describe("the range that a history query covers", () => {
  it("is one day at the measured close interval of the network", () => {
    // The duplication that made the command line and the dashboard disagree is
    // gone, so a wrong value here is now wrong identically in both. That is the
    // point of one definition, and it is also why the value itself needs a
    // test: nothing else notices a shift of one ledger.
    const secondsForEachLedger = 5;
    const oneDay = 24 * 60 * 60;
    expect(HISTORY_DEFAULT_LEDGERS * secondsForEachLedger).toBe(oneDay);
  });

  it("counts back from the latest ledger, and never below zero", () => {
    expect(defaultHistoryStart(1_000_000)).toBe(1_000_000 - HISTORY_DEFAULT_LEDGERS);
    // A network younger than the range would otherwise give a negative ledger.
    expect(defaultHistoryStart(100)).toBe(0);
    expect(defaultHistoryStart(0)).toBe(0);
  });

  it("is the range that both front ends use", () => {
    // The comment on the helper claims one definition. These are the two
    // callers that make the claim true.
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cli).toContain("defaultHistoryStart(await latestLedger(server))");
    expect(cli).not.toContain("HISTORY_DEFAULT_LEDGERS");
  });
});
