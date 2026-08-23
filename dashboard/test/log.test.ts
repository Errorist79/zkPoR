/**
 * What the record of this process may carry, and what it may never carry.
 *
 * A log outlives the process that wrote it and it travels. The promise of this
 * product is that the data of a customer stays on the machine of the issuer,
 * and a log is the way that promise breaks without anybody deciding to break
 * it. So the rule is held by the types first: an event is one member of a
 * declared union, every field of it is named, and there is no function that
 * takes a message or an object of the caller's choosing. To record a balance
 * somebody must add a field to that union.
 *
 * These cases hold the three guards that stand on top of that one. The first
 * reads the names of the fields. The second drives the routes and a whole run
 * with the log captured, and reads every line for a secret, a balance and a
 * salt. The third holds the address of the endpoint to its origin, because an
 * endpoint that carries a key in its path is how an address becomes a secret.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupedDigits } from "@zkpor/sdk";
import { afterTheProof } from "../src/attestation.js";
import { ROUTES } from "../src/constants.js";
import { LEVEL_OF_EVENT, endpointOrigin, openLog } from "../src/log.js";
import type { LogEvent } from "../src/log.js";
import { route } from "../src/routes.js";
import { RunStore } from "../src/runs.js";
import { ASSET, PACKAGE_ROOT, REPOSITORY_ROOT, capturingLog, dashboard, request } from "./support.js";

/** The values that a case looks for. Each one is data that a log may never carry. */
const MASTER_SECRET = "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
const AUTHORITY_SECRET = "SBTESTAUTHORITYKEYVALUETESTAUTHORITYKEYVALUETESTAUTHOR";

/** The committed example package. Its balance and its salt are in the file. */
const EXAMPLE_PACKAGE = join(REPOSITORY_ROOT, "fixtures", "example_package.zkpor.json");

/** The names of every field of the event union, without the name of the event. */
function fieldNames(): string[] {
  const source = readFileSync(join(PACKAGE_ROOT, "src", "log.ts"), "utf8");
  const opening = source.indexOf("export type LogEvent =");
  const closing = source.indexOf("export type LogEventName");
  const union = source.slice(opening, closing);
  // Every name that a value follows, wherever it sits. A pattern anchored to the
  // start of a line read the first field of each member and missed every field
  // that shares a line with another one, which is most of them.
  const found = new Set<string>();
  for (const declared of union.matchAll(/([a-z_][a-z0-9_]*)\??\s*:/g)) {
    const name = declared[1];
    if (name !== undefined && name !== "event") {
      found.add(name);
    }
  }
  return [...found];
}

describe("the names of the fields that an event may carry", () => {
  const names = fieldNames();

  it("reads the fields of the union, so this case is not empty", () => {
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain("final_root");
  });

  it("names no subject that a log may never carry", () => {
    // Two names are allowed to hold a forbidden word. A field that ends with
    // `_present` carries a boolean, so it states that a secret exists and never
    // what it is. A field that ends with `_file` carries a path that the issuer
    // typed, and a path is on the page already.
    for (const name of names) {
      expect(/balance|salt|leaf|row/.test(name), `the field ${name} names a forbidden subject`).toBe(
        false,
      );
      if (/secret|key/.test(name)) {
        expect(name.endsWith("_present"), `the field ${name} may carry a secret`).toBe(true);
      }
      if (/customer/.test(name)) {
        expect(name.endsWith("_file"), `the field ${name} may carry the data of a customer`).toBe(
          true,
        );
      }
    }
  });
});

describe("what a whole session writes to the log", () => {
  /** Every line that the routes and one run wrote, as one text. */
  async function linesOfASession(): Promise<string> {
    const captured = capturingLog();
    const store = new RunStore(captured.log);
    const client = dashboard({
      deploymentsText: "[]",
      environment: {
        ZKPOR_MASTER_SECRET: MASTER_SECRET,
        ZKPOR_AUTHORITY_SECRET: AUTHORITY_SECRET,
      },
      store,
      log: captured.log,
    });

    for (const target of [ROUTES.home, `${ROUTES.asset}?asset=${ASSET}`, ROUTES.attestation]) {
      await route(request({ target }), client);
    }
    // The inclusion check reads a package that carries the balance and the salt
    // of one customer, and it prints both on the page. The log must carry
    // neither, and this is the case that would catch it.
    await route(
      request({
        method: "POST",
        target: ROUTES.inclusion,
        body: `package-path=${encodeURIComponent(EXAMPLE_PACKAGE)}`,
      }),
      client,
    );

    const finished = new Promise<void>((resolve) => {
      store.startOrJoin({
        action: "attest",
        asset: ASSET,
        snapshotLedger: 5_000,
        work: async (report, recordProof, recordWindow, recordSubmission) => {
          const outcome = await afterTheProof({
            action: "attest",
            snapshotLedger: 5_000,
            currentLedger: 5_010,
            proof: {
              proofBytes: 14_720,
              finalRoot: 0x2ban,
              totalLiabilities: 7_777n,
              contextHash: 0x77n,
            },
            report,
            recordProof,
            recordWindow,
            recordSubmission,
            submit: async () =>
              await Promise.resolve({
                ledger: 5_010,
                transactionHash: "a".repeat(64),
                registry: "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG",
              }),
            writePackages: async () => await Promise.resolve("/somewhere/packages"),
          });
          resolve();
          return outcome;
        },
      });
    });
    await finished;
    // The store records the end of a run after the work returns, so the case
    // waits for the microtasks that follow it before it reads the lines.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return captured.lines.join("");
  }

  it("writes lines at all, so the cases below are not empty", async () => {
    const written = await linesOfASession();
    expect(written).toContain("run.step");
    expect(written).toContain("proof.finished");
    expect(written).toContain("request.answered");
  });

  it("carries no secret of the environment", async () => {
    const written = await linesOfASession();
    expect(written).not.toContain(MASTER_SECRET);
    expect(written).not.toContain(AUTHORITY_SECRET);
  });

  it("carries no balance and no salt of a customer", async () => {
    const packaged: unknown = JSON.parse(readFileSync(EXAMPLE_PACKAGE, "utf8"));
    if (
      typeof packaged !== "object" ||
      packaged === null ||
      !("balance" in packaged) ||
      !("salt" in packaged)
    ) {
      throw new Error("the example package names no balance and no salt");
    }
    const balance = String(packaged["balance"]);
    const salt = String(packaged["salt"]);
    const written = await linesOfASession();
    // The session read that package, so a case that found nothing would pass
    // for the wrong reason. The answer of that route is the anchor.
    expect(written).toContain(`"route":"${ROUTES.inclusion}"`);
    expect(written).not.toContain(salt);
    expect(written).not.toContain(balance);
    expect(written).not.toContain(groupedDigits(BigInt(balance)));
  });
});

describe("the address of the endpoint", () => {
  it("keeps the origin and drops what follows it", () => {
    // Some endpoints carry a key in the path. An operator who logged "the
    // endpoint" would publish it to every reader of the file.
    expect(endpointOrigin("https://rpc.example.org/v1/aSecretToken?key=another")).toBe(
      "https://rpc.example.org",
    );
    expect(endpointOrigin("https://user:password@rpc.example.org/path")).toBe(
      "https://rpc.example.org",
    );
  });

  it("states that it cannot read an address rather than repeating it", () => {
    expect(endpointOrigin("not an address/aSecretToken")).not.toContain("aSecretToken");
  });
});

describe("one line of the log", () => {
  /** The lines that one setting writes, for the events a case names. */
  function linesOf(setting: "info" | "debug", events: readonly LogEvent[]): string[] {
    const lines: string[] = [];
    const log = openLog({
      setting,
      write: (line) => {
        lines.push(line);
      },
    });
    for (const event of events) {
      log(event);
    }
    return lines;
  }

  const READ: LogEvent = { event: "chain.read", call: "latest_ledger", ms: 4 };
  const REFUSED: LogEvent = { event: "run.refused", reason: "a reason" };

  it("carries the time, the level and the name, and it is one line of JSON", () => {
    const [line] = linesOf("info", [REFUSED]);
    expect(line?.endsWith("\n")).toBe(true);
    expect(line?.trimEnd().includes("\n")).toBe(false);
    const parsed: unknown = JSON.parse(line ?? "");
    expect(parsed).toMatchObject({ level: "warn", event: "run.refused", reason: "a reason" });
    if (typeof parsed !== "object" || parsed === null || !("time" in parsed)) {
      throw new Error("the line carries no time");
    }
    expect(String(parsed["time"])).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("keeps the lines that repeat for the setting that asks for them", () => {
    expect(linesOf("info", [READ, REFUSED])).toHaveLength(1);
    expect(linesOf("debug", [READ, REFUSED])).toHaveLength(2);
  });

  it("gives every event a level, and gives the failures the levels that name them", () => {
    expect(LEVEL_OF_EVENT["run.failed"]).toBe("error");
    expect(LEVEL_OF_EVENT["process.refused"]).toBe("error");
    expect(LEVEL_OF_EVENT["chain.failed"]).toBe("warn");
    expect(LEVEL_OF_EVENT["run.step"]).toBe("info");
  });
});
