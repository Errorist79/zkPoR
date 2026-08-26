/**
 * The decoding of every value that the registry returns.
 *
 * The registry crate encodes these values with the real host and writes the
 * committed file, and a test on that side asserts the file equals what the
 * crate produces. This test decodes the same file with the reader that this
 * package uses against a live network. A change of the interface therefore
 * fails on both sides instead of leaving a paragraph out of date.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  ATTESTATION_EVENT_TOPIC,
  decodeAssetRecord,
  decodeAttestationEvent,
  decodeReserveObservation,
} from "../src/registry.js";
import { InfrastructureError } from "../src/network.js";
import { toHex } from "../src/fr.js";
import {
  decodedRecord,
  elementAt,
  isUnknownList,
  registryReturns,
} from "./fixture-guards.js";

const ROOT = join(import.meta.dirname, "..", "..");

const fixture = registryReturns(
  readFileSync(join(ROOT, "fixtures", "registry_returns.json"), "utf8"),
);

/**
 * The value that a live read produces from one encoded return.
 *
 * A live read decodes the XDR and then hands the value to the same decoder that
 * the tests below call, so the tests exercise the code that runs.
 */
function decode(base64: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(base64, "base64"));
}

describe("the encoded values of the registry", () => {
  it("carries the topic symbol that this client filters on", () => {
    expect(fixture.constants.attestation_event_topic).toBe(ATTESTATION_EVENT_TOPIC);
  });

  it("covers both tiers and both states of the attestation slot", () => {
    const tiers = new Set(fixture.returns.map((entry) => entry.expected.tier).filter(Boolean));
    expect(tiers).toEqual(new Set(["ContractAdministrator", "ClassicIssuer"]));
    const records = fixture.returns.filter((entry) => entry.call === "entry");
    expect(records.some((entry) => entry.expected.attestation === null)).toBe(true);
    expect(records.some((entry) => entry.expected.attestation !== null)).toBe(true);
  });
});

describe("the record of one asset", () => {
  const records = fixture.returns.filter((entry) => entry.call === "entry");

  it.each(records)("the client decoder reads the case $case", (entry) => {
    // The decoder is the one that a live read calls, so a wrong key name in it
    // fails here instead of passing beside a second reader.
    const record = decodeAssetRecord(decode(entry.scval));

    expect(record.authority).toBe(entry.expected.authority);
    expect(record.reserves).toEqual(entry.expected.reserves);
    expect(toHex(record.reserveSetHash)).toBe(entry.expected.reserve_set_hash);
    expect(record.tier).toBe(entry.expected.tier);

    const wanted = entry.expected.attestation;
    if (wanted === null || wanted === undefined) {
      expect(record.attestation).toBeUndefined();
      return;
    }
    const attestation = record.attestation;
    if (attestation === undefined) {
      throw new Error("the decoder read no attestation, and the file states one");
    }
    expect(toHex(attestation.finalRoot)).toBe(wanted.final_root);
    expect(attestation.totalLiabilities.toString(10)).toBe(wanted.total_liabilities);
    expect(attestation.snapshotLedger).toBe(wanted.snapshot_ledger);
    expect(attestation.reserveSum.toString(10)).toBe(wanted.reserve_sum);
    expect(attestation.attestedLedger).toBe(wanted.attested_ledger);
  });

  it("gives the five keys of the record and no other", () => {
    for (const entry of records) {
      expect(Object.keys(decodedRecord(decode(entry.scval))).sort()).toEqual([
        "attestation",
        "authority",
        "reserve_set_hash",
        "reserves",
        "tier",
      ]);
    }
  });
});

describe("the reserve observation", () => {
  const observations = fixture.returns.filter((entry) => entry.call === "observe_reserves");

  it("covers the reading", () => {
    expect(observations.length).toBeGreaterThan(0);
  });

  it.each(observations)("the client decoder reads the case $case", (entry) => {
    const decoded = decodedRecord(decode(entry.scval));
    expect(Object.keys(decoded).sort()).toEqual(["observed_ledger", "observed_sum"]);
    const observation = decodeReserveObservation(decode(entry.scval));
    expect(observation.observedSum.toString(10)).toBe(entry.expected.observed_sum);
    expect(observation.observedLedger).toBe(entry.expected.observed_ledger);
  });
});

describe("the attestation event", () => {
  it.each(fixture.events)("the client decoder reads the case $case", (event) => {
    const topics = event.topics.map((topic) => decode(topic));
    expect(topics).toHaveLength(2);
    const decoded = decodeAttestationEvent(topics, decode(event.data));
    expect(decoded.asset).toMatch(/^C[A-Z2-7]{55}$/);
    expect(typeof decoded.attestation.finalRoot).toBe("bigint");
    expect(Number.isInteger(decoded.attestation.snapshotLedger)).toBe(true);
  });

  it.each(fixture.events)("refuses the case $case under another topic symbol", (event) => {
    const topics = event.topics.map((topic) => decode(topic));
    expect(() => decodeAttestationEvent(["another_event", topics[1]], decode(event.data))).toThrow(
      InfrastructureError,
    );
  });

  it.each(fixture.events)("decodes the data of the case $case by name", (event) => {
    const data = decodedRecord(decode(event.data));
    // The data is a map, not a list, so no consumer reads a value by a
    // position. The five names are the names of the attestation record.
    expect(Object.keys(data).sort()).toEqual([
      "attested_ledger",
      "final_root",
      "reserve_sum",
      "snapshot_ledger",
      "total_liabilities",
    ]);
    expect(typeof data["final_root"]).toBe("bigint");
    expect(typeof data["total_liabilities"]).toBe("bigint");
    expect(typeof data["reserve_sum"]).toBe("bigint");
    expect(Number.isInteger(data["snapshot_ledger"])).toBe(true);
    expect(Number.isInteger(data["attested_ledger"])).toBe(true);
  });

  /**
   * The event and the record carry the same five fields under the same names,
   * so one reader serves both. This states that property, because the client
   * relies on it.
   */
  it("carries the same field names as the attestation of the record", () => {
    const filled = fixture.returns.find(
      (entry) => entry.call === "entry" && entry.expected.attestation !== null,
    );
    if (filled === undefined) {
      throw new Error("the return file holds no record whose attestation slot is filled");
    }
    const slot = decodedRecord(decode(filled.scval))["attestation"];
    if (!isUnknownList(slot)) {
      throw new Error("the attestation slot holds no variant list");
    }
    const fromRecord = Object.keys(decodedRecord(slot[1])).sort();
    const first = elementAt(fixture.events, 0, "event list of the return file");
    const fromEvent = Object.keys(decodedRecord(decode(first.data))).sort();
    expect(fromEvent).toEqual(fromRecord);
  });
});

/**
 * The rejection of a case that this client does not name.
 *
 * A later registry can add a tier or a state of the attestation slot. A client
 * that guessed at an unknown case would report a value the registry does not
 * hold, so both sites refuse. The committed file cannot carry an unknown case,
 * so these tests build the decoded value instead.
 */
describe("a case that this client does not name", () => {
  /** The decoded shape of a record, which each test below changes at one field. */
  function record(changes: Record<string, unknown>): Record<string, unknown> {
    return {
      authority: "GAAAAAAAACGC6",
      tier: ["ClassicIssuer"],
      reserves: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM"],
      reserve_set_hash: 7n,
      attestation: ["Empty"],
      ...changes,
    };
  }

  it("reads the record that every field of this shape describes", () => {
    expect(decodeAssetRecord(record({})).tier).toBe("ClassicIssuer");
  });

  it("refuses a tier that a later registry adds", () => {
    expect(() => decodeAssetRecord(record({ tier: ["DelegatedAdministrator"] }))).toThrow(
      InfrastructureError,
    );
  });

  it("refuses a state of the attestation slot that a later registry adds", () => {
    expect(() => decodeAssetRecord(record({ attestation: ["Revoked"] }))).toThrow(
      InfrastructureError,
    );
  });

  it("names the case it refused, so a reader sees which value was new", () => {
    try {
      decodeAssetRecord(record({ tier: ["DelegatedAdministrator"] }));
      expect.unreachable("an unknown tier must not pass");
    } catch (cause) {
      if (!(cause instanceof InfrastructureError)) {
        throw cause;
      }
      expect(cause.message).toContain("DelegatedAdministrator");
    }
  });

  it("refuses a tier that carries no case at all", () => {
    expect(() => decodeAssetRecord(record({ tier: [] }))).toThrow(InfrastructureError);
    expect(() => decodeAssetRecord(record({ tier: "ClassicIssuer" }))).toThrow(InfrastructureError);
  });

  /**
   * A filled slot must still decode its payload. A refusal of every unknown case
   * would be worthless if it also refused the case the registry does hold.
   */
  it("reads a filled slot, so the refusal is about the unknown case alone", () => {
    const filled = record({
      attestation: [
        "Filled",
        {
          final_root: 42n,
          total_liabilities: 500n,
          snapshot_ledger: 9999,
          reserve_sum: 2000n,
          attested_ledger: 10000,
        },
      ],
    });
    expect(decodeAssetRecord(filled).attestation?.snapshotLedger).toBe(9999);
  });
});
