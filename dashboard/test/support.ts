/**
 * The values and the readers that the tests build pages from.
 *
 * Every value here is test data. The addresses name nobody and the balances are
 * chosen to make a confusion visible rather than to look plausible.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openServer } from "@zkpor/sdk";
import type { AssetRecord, Attestation, ReserveDiagnosis } from "@zkpor/sdk";
import type { Reader } from "../src/chain.js";
import type { AssetView, HistoryView } from "../src/model.js";
import { observedReserves, solvencyResult } from "../src/model.js";
import type { Dashboard } from "../src/routes.js";
import { RunStore } from "../src/runs.js";

/**
 * The directory of this package, and the directory of the repository.
 *
 * The paths come from the location of this file and never from the working
 * directory, so a run from the repository root and a run from this package find
 * the same files.
 */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The directory of the repository that holds this package. */
export const REPOSITORY_ROOT = dirname(PACKAGE_ROOT);

/** A registry address. The value is test data. */
export const REGISTRY = "CC4MA6FWDBG3Y4YXYGDHYEZ36O3YSP7DREGOLBWKP6ZTQQ6IYFFX3KQK";

/** An asset address. The value is test data. */
export const ASSET = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** An authority address. The value is test data. */
export const AUTHORITY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** A reserve address. The value is test data. */
export const RESERVE = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAK";

/** The network that the committed deployments file records. */
export const NETWORK = "testnet";

/** One attestation, with every field overridable. */
export function attestation(changes: Partial<Attestation> = {}): Attestation {
  return {
    finalRoot: 0x2ban,
    totalLiabilities: 1_000n,
    snapshotLedger: 5_000,
    reserveSum: 1_500n,
    attestedLedger: 5_100,
    ...changes,
  };
}

/** One asset record, with every field overridable. */
export function assetRecord(changes: Partial<AssetRecord> = {}): AssetRecord {
  return {
    authority: AUTHORITY,
    tier: "ClassicIssuer",
    reserves: [RESERVE],
    reserveSetHash: 0x99n,
    attestation: attestation(),
    ...changes,
  };
}

/** One diagnosis in which one address cannot hold the asset. */
export function diagnosis(): ReserveDiagnosis {
  return {
    readings: [{ address: RESERVE, balance: undefined, failure: "the address holds no trustline" }],
    failed: [RESERVE],
    sumOfTheReadings: 0n,
  };
}

/** The parts of an asset view that a test chooses. */
export interface ViewChoices {
  readonly record?: AssetRecord;
  readonly currentLedger?: number;
  readonly observedSum?: bigint;
  readonly observedLedger?: number;
  readonly observationFailure?: string;
  readonly diagnosis?: ReserveDiagnosis;
}

/** One asset view. */
export function assetView(choices: ViewChoices = {}): AssetView {
  const record = choices.record ?? assetRecord();
  const currentLedger = choices.currentLedger ?? 5_200;
  return {
    asset: ASSET,
    network: NETWORK,
    registry: REGISTRY,
    record,
    solvency:
      record.attestation === undefined
        ? undefined
        : solvencyResult(record.attestation, currentLedger),
    observed:
      choices.observedSum === undefined
        ? undefined
        : observedReserves({
            observedSum: choices.observedSum,
            observedLedger: choices.observedLedger ?? 5_200,
          }),
    observationFailure: choices.observationFailure,
    diagnosis: choices.diagnosis,
    currentLedger,
  };
}

/** One history view with a single earlier attestation. */
export function historyView(changes: Partial<HistoryView> = {}): HistoryView {
  return {
    entries: [
      {
        snapshotLedger: 4_300,
        totalLiabilities: 900n,
        attested: { sum: 1_400n, attestedLedger: 4_390 },
        coverage: "reserves-reach-liabilities",
        transactionHash: "a".repeat(64),
      },
    ],
    oldestLedgerCovered: 4_000,
    oldestLedgerRetained: 4_000,
    latestLedger: 5_200,
    reachesTheRetentionLimit: true,
    ...changes,
  };
}

/**
 * A client of an endpoint that no test reaches.
 *
 * The address is a loopback port that nothing listens on, so a test that
 * reached the network would fail rather than pass on a value from elsewhere.
 */
export function unreachableServer() {
  return openServer({
    network: NETWORK,
    rpcUrl: "http://127.0.0.1:1/",
    networkPassphrase: "Test SDF Network ; September 2015",
    allowHttp: true,
  });
}

/** One reader against the committed deployments file. */
export function reader(deploymentsText: string): Reader {
  return {
    server: unreachableServer(),
    config: {
      network: NETWORK,
      rpcUrl: "http://127.0.0.1:1/",
      networkPassphrase: "Test SDF Network ; September 2015",
      allowHttp: true,
    },
    readOptions: {},
    registry: REGISTRY,
    deploymentsText,
  };
}

/** One dashboard against the committed deployments file. */
export function dashboard(input: {
  deploymentsText: string;
  environment?: Record<string, string>;
  store?: RunStore;
}): Dashboard {
  return {
    reader: reader(input.deploymentsText),
    store: input.store ?? new RunStore(),
    environment: input.environment ?? {},
    repository: PACKAGE_ROOT,
  };
}

/** A request that names this machine and comes from a page of this process. */
export function request(changes: {
  method?: string;
  target: string;
  host?: string;
  fetchSite?: string;
  body?: string;
}) {
  return {
    method: changes.method ?? "GET",
    target: changes.target,
    host: changes.host ?? "127.0.0.1:7878",
    fetchSite: changes.fetchSite ?? "same-origin",
    body: changes.body ?? "",
  };
}

/**
 * The markup of one section, from its opening tag to the tag that closes it.
 *
 * The scan counts the sections it opens and closes, so a section inside another
 * one does not end the outer one early. A test uses this to state that a value
 * appears inside one section and nowhere else.
 */
export function sectionOf(markup: string, id: string): string {
  const opening = markup.indexOf(`<section id="${id}"`);
  if (opening < 0) {
    throw new Error(`the markup carries no section ${id}`);
  }
  let depth = 0;
  let at = opening;
  for (;;) {
    const nextOpen = markup.indexOf("<section", at + 1);
    const nextClose = markup.indexOf("</section>", at + 1);
    if (nextClose < 0) {
      throw new Error(`the section ${id} never closes`);
    }
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      at = nextOpen;
      continue;
    }
    if (depth === 0) {
      return markup.slice(opening, nextClose + "</section>".length);
    }
    depth -= 1;
    at = nextClose;
  }
}

/**
 * Every TypeScript source of this package.
 *
 * Two test files scan the sources for a rule that the types cannot state, and
 * both walk the tree the same way, so the walk has one definition.
 */
export function sources(directory: string = join(PACKAGE_ROOT, "src")): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...sources(path));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

/** The text of the markup, with every tag removed. */
export function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
