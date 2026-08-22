/**
 * Which generation a page answers about.
 *
 * The client library has a case that can see this, because a fake endpoint
 * records the contract each read asked about. This package had none, so a
 * resolver that found the right record and then named the newest generation as
 * its holder passed every case here. The page would then label a record with a
 * registry that did not answer it, and every read below the label would go to
 * that registry too.
 *
 * These cases drive the real read against an endpoint of their own. They assert
 * the generation the page names, which is the fact the rest of this package
 * cannot observe.
 */

import { describe, expect, it } from "vitest";
import { openServer } from "@zkpor/sdk";
import { readAssetView } from "../src/chain.js";
import type { Reader } from "../src/chain.js";
import { assetRecordXdr, fakeEndpoint } from "../../sdk/replay/endpoint.js";

/** Three generations of one network, in the shape the file records. */
const OLDEST = "CC4MA6FWDBG3Y4YXYGDHYEZ36O3YSP7DREGOLBWKP6ZTQQ6IYFFX3KQK";
const MIDDLE = "CCHUTDKUPWXVUIX6D26SE5NZ5STP74VV4DY2CNVCMNJYOU5PTROLA7MY";
const NEWEST = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";

/** An asset and an account. The values are test data. */
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const DEPLOYMENTS = JSON.stringify(
  [OLDEST, MIDDLE, NEWEST].map((registry) => ({
    network: "testnet",
    registry,
    verifier: NEWEST,
    aggregator_key_sha256: "a".repeat(64),
    registry_wasm_sha256: "b".repeat(64),
    verifier_wasm_sha256: "c".repeat(64),
    tree_depth: 12,
  })),
);

/** A reader that reaches one endpoint. */
function readerAt(url: string): Reader {
  const config = {
    network: "testnet",
    rpcUrl: url,
    networkPassphrase: "Test SDF Network ; September 2015",
    allowHttp: true,
  };
  return { server: openServer(config), config, readOptions: {}, deploymentsText: DEPLOYMENTS };
}

describe("the generation that an asset page answers about", () => {
  const record = assetRecordXdr({ authority: ACCOUNT, reserves: [ACCOUNT] });

  it("names the generation that holds the asset, and not the newest", async () => {
    // The asset lives on the middle generation. A page that named the newest
    // would be labelling this record with a registry that answered nothing.
    const endpoint = await fakeEndpoint({ holds: { [MIDDLE]: record }, fallback: 7 });
    try {
      const read = await readAssetView(readerAt(endpoint.url), ASSET);
      expect(read.view?.registry).toBe(MIDDLE);
      // The walk asks the newest first and stops at the holder. Every read
      // after that goes to the holder, so the oldest is never contacted.
      expect(endpoint.asked[0]).toBe(NEWEST);
      expect(endpoint.asked).not.toContain(OLDEST);
    } finally {
      await endpoint.close();
    }
  }, 30_000);

  it("names the newest when the newest holds the asset", async () => {
    const endpoint = await fakeEndpoint({ holds: { [NEWEST]: record }, fallback: 7 });
    try {
      const read = await readAssetView(readerAt(endpoint.url), ASSET);
      expect(read.view?.registry).toBe(NEWEST);
      expect(endpoint.asked).not.toContain(MIDDLE);
      expect(endpoint.asked).not.toContain(OLDEST);
    } finally {
      await endpoint.close();
    }
  }, 30_000);

  it("answers nothing when no generation holds the asset", async () => {
    const endpoint = await fakeEndpoint({ fallback: 7 });
    try {
      const read = await readAssetView(readerAt(endpoint.url), ASSET);
      expect(read.view).toBeUndefined();
      // The page states this list rather than reading the file a second time.
      expect(read.asked).toEqual([NEWEST, MIDDLE, OLDEST]);
      expect(endpoint.asked).toEqual([NEWEST, MIDDLE, OLDEST]);
    } finally {
      await endpoint.close();
    }
  }, 30_000);

  it("stops when a generation fails, rather than reading the failure as an absence", async () => {
    const endpoint = await fakeEndpoint({
      refuseWith: { [NEWEST]: 1 },
      holds: { [MIDDLE]: record },
      fallback: 7,
    });
    try {
      await expect(readAssetView(readerAt(endpoint.url), ASSET)).rejects.toThrow("did not answer");
      expect(endpoint.asked).toEqual([NEWEST]);
    } finally {
      await endpoint.close();
    }
  }, 30_000);

  it("walks no generation of another network", async () => {
    // Every fixture in both packages uses one network, so nothing here would
    // notice a walk that ignored the network of a record.
    const mixed = JSON.stringify([
      { network: "mainnet", registry: OLDEST, verifier: NEWEST, aggregator_key_sha256: "a".repeat(64), registry_wasm_sha256: "b".repeat(64), verifier_wasm_sha256: "c".repeat(64), tree_depth: 12 },
      { network: "testnet", registry: NEWEST, verifier: NEWEST, aggregator_key_sha256: "a".repeat(64), registry_wasm_sha256: "b".repeat(64), verifier_wasm_sha256: "c".repeat(64), tree_depth: 12 },
    ]);
    const endpoint = await fakeEndpoint({ fallback: 7 });
    try {
      const reader = { ...readerAt(endpoint.url), deploymentsText: mixed };
      await readAssetView(reader, ASSET);
      expect(endpoint.asked).toEqual([NEWEST]);
      expect(endpoint.asked).not.toContain(OLDEST);
    } finally {
      await endpoint.close();
    }
  }, 30_000);
});
