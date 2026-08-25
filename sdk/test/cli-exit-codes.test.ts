/**
 * The exit code of the command line, read from the built command line.
 *
 * The package publishes a contract: the code 2 means the command line is
 * wrong, and the code 8 means a failure of the client or of the network, which
 * is not a verdict. A value that an operator can correct is the first kind. A
 * refactor that moves a case from one kind to the other breaks the contract
 * without breaking a type, so the test runs the real command line and reads the
 * real code.
 *
 * Every case here spawns the built entry point. A test that called the
 * functions directly would pass while the shipped command line failed, which is
 * the failure this file exists to prevent.
 *
 * Nothing here imports from the command line module itself, and that rule is
 * worth stating because breaking it once cost this project a green suite that
 * failed. The command line is an entry point: its last statement runs it. An
 * import of one function from it started the command line inside the process
 * running these tests, which called `process.exit` with the very codes this
 * file exists to pin. Every test still passed and the suite still returned a
 * failure, so a reader of the counts saw nothing wrong.
 *
 * Anything this file needs from the command line lives in a module that is not
 * an entry point.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_CODES, EXIT_NO_VERDICT, EXIT_USAGE } from "../src/inclusion.js";
import { parsePackage } from "../src/inclusion-package.js";
import { RegistryRefusedError } from "../src/registry.js";
import { InfrastructureError } from "../src/network.js";
import { attestAndReport, completeCommand, failureNote, runReport } from "../src/report.js";
import { ATTESTATION_MAX_AGE_LEDGERS } from "../src/constants.js";
import { builtCli } from "./built.js";
import { assetRecordXdr, fakeEndpoint } from "../replay/endpoint.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The deployments file of this repository, which the client trusts. */
const DEPLOYMENTS = join(HERE, "..", "..", "scripts", "deployments.json");

/** A registry address that the committed deployments file records. */
const REGISTRY = "CC4MA6FWDBG3Y4YXYGDHYEZ36O3YSP7DREGOLBWKP6ZTQQ6IYFFX3KQK";

/** An account address. The value is test data. */
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * The built command line, in a directory this test run owns.
 *
 * Reaching into `dist` made the verdict depend on a build the test does not
 * control, and that failed in both directions: a build in progress removed the
 * file, and a run that skipped the build measured an older artifact. Both
 * arrive at an assertion looking like the command line returning a wrong code,
 * which is a false report about the one contract this file guards.
 */
let CLI = "";

/** A context file with the fields that a run reads. */
function contextFile(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "zkpor-cli-"));
  const path = join(directory, "context.toml");
  writeFileSync(path, body);
  return path;
}

/**
 * Runs the built command line and returns what it did.
 *
 * A machine that cannot start a process right now, because it is out of
 * descriptors or out of process slots, makes `spawnSync` report a failure of
 * its own with no exit status. An earlier form of this function turned that
 * into the code -1, which arrived at an assertion looking exactly like the
 * command line returning the wrong code. That reads as a defect in the contract
 * this file guards, which is the worst thing a flake can imitate.
 *
 * A failure to start is therefore never an outcome. It is retried, and it is
 * reported as itself if it persists.
 *
 * This runner stops the event loop of this process until the child ends. A test
 * that serves the child from inside this process therefore cannot use it: the
 * server never reaches its turn, and the call ends at the timeout with nothing
 * to show for it. Those tests use `runCliServed` below.
 */
function runCli(
  args: readonly string[],
  environment: Record<string, string> = {},
): { code: number; stderr: string; stdout: string } {
  let lastFailure = "the process reported no failure";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        ZKPOR_NETWORK: "testnet",
        ZKPOR_RPC_URL: "http://127.0.0.1:1/",
        ...environment,
      },
    });
    if (answer.error === undefined && answer.status !== null) {
      // A build that vanished mid-run is not a verdict about the contract.
      // The command line is executed out of a directory that this run made,
      // and another process removing it makes the module loader exit 1, which
      // is a code this file also reads as an answer. So a non-zero code with no
      // artifact on disk is reported as what it is, and never as a result.
      if (answer.status !== 0 && !existsSync(CLI)) {
        throw new Error(
          `the built command line at ${CLI} disappeared while this case ran, so its exit code ${String(answer.status)} says nothing about the contract`,
        );
      }
      return { code: answer.status, stderr: answer.stderr, stdout: answer.stdout };
    }
    lastFailure =
      answer.error instanceof Error
        ? answer.error.message
        : `the command line ended with the signal ${String(answer.signal)}`;
  }
  throw new Error(`this machine could not run the command line: ${lastFailure}`);
}

beforeAll(() => {
  CLI = builtCli();
  if (!existsSync(CLI)) {
    throw new Error(`the build wrote no command line at ${CLI}`);
  }
}, 180_000);

describe("the two kinds of failure", () => {
  it("keeps them apart in the published contract", () => {
    // The two codes must stay different, because every case below sorts one
    // failure into one of them.
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_NO_VERDICT).toBe(8);
  });
});

/**
 * Runs the built command line without blocking this process.
 *
 * The synchronous runner above stops the event loop until the child ends, so a
 * server inside this process can never answer it. A test that needs an endpoint
 * of its own uses this one instead.
 */
async function runCliServed(
  args: readonly string[],
  environment: Record<string, string>,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        ZKPOR_NETWORK: "testnet",
        ...environment,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stderr, stdout });
    });
  });
}

describe("which generation a read answers about", () => {
  /** The three registries of the committed file, oldest first. */
  const OLDEST = "CC4MA6FWDBG3Y4YXYGDHYEZ36O3YSP7DREGOLBWKP6ZTQQ6IYFFX3KQK";
  const MIDDLE = "CCHUTDKUPWXVUIX6D26SE5NZ5STP74VV4DY2CNVCMNJYOU5PTROLA7MY";
  const NEWEST = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";

  /** An asset address. The value is test data. */
  const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";

  /** One record, for whichever registry a case says holds the asset. */
  const RECORD = assetRecordXdr({ authority: ACCOUNT, reserves: [ACCOUNT] });

  const environment = (url: string): Record<string, string> => ({
    ZKPOR_DEPLOYMENTS: DEPLOYMENTS,
    ZKPOR_RPC_URL: url,
  });

  it("asks the newest generation first", async () => {
    const endpoint = await fakeEndpoint({ fallback: 7 });
    try {
      await runCliServed(["entry", ASSET], environment(endpoint.url));
      expect(endpoint.asked[0]).toBe(NEWEST);
    } finally {
      await endpoint.close();
    }
  }, 60_000);

  it("stops at the generation that holds the asset", async () => {
    // The walk ends at the first record. An older generation is not asked,
    // because the answer is already known and asking costs a round trip.
    const endpoint = await fakeEndpoint({ holds: { [NEWEST]: RECORD }, fallback: 7 });
    try {
      const answer = await runCliServed(["entry", ASSET], environment(endpoint.url));
      expect(answer.stdout).toContain(NEWEST);
      expect(endpoint.asked).toEqual([NEWEST]);
    } finally {
      await endpoint.close();
    }
  }, 60_000);

  it("reaches an earlier generation when the newest holds nothing", async () => {
    // This is the asset the client could not reach at all before. The newest
    // generation holds no record of it and it can be attested nowhere else.
    const endpoint = await fakeEndpoint({ holds: { [MIDDLE]: RECORD }, fallback: 7 });
    try {
      const answer = await runCliServed(["entry", ASSET], environment(endpoint.url));
      expect(answer.stdout).toContain(MIDDLE);
      expect(endpoint.asked).toEqual([NEWEST, MIDDLE]);
    } finally {
      await endpoint.close();
    }
  }, 60_000);

  it("answers about the newest of two generations that hold the asset", async () => {
    // Nothing on the network produces this state, and the documented
    // registration path produces it the moment an issuer on an earlier
    // generation registers again. The newest holder wins, because that path
    // writes on the newest, so the newest holder is where the most recent act
    // put the asset.
    const endpoint = await fakeEndpoint({
      holds: { [NEWEST]: RECORD, [MIDDLE]: RECORD },
      fallback: 7,
    });
    try {
      const answer = await runCliServed(["entry", ASSET], environment(endpoint.url));
      expect(answer.stdout).toContain(NEWEST);
      expect(answer.stdout).not.toContain(MIDDLE);
      expect(endpoint.asked).toEqual([NEWEST]);
    } finally {
      await endpoint.close();
    }
  }, 60_000);

  it("stops the command when a generation fails, rather than reading the failure as an absence", async () => {
    // Code 1 is not AssetNotRegistered. A walk that stepped past it could
    // answer from an older generation while the failed one also held a record,
    // and the reader would get an older record than the truth with nothing to
    // say so.
    const endpoint = await fakeEndpoint({
      refuseWith: { [NEWEST]: 1 },
      holds: { [MIDDLE]: RECORD },
      fallback: 7,
    });
    try {
      const answer = await runCliServed(["entry", ASSET], environment(endpoint.url));
      expect(answer.code).toBe(EXIT_NO_VERDICT);
      expect(answer.stderr).toContain(NEWEST);
      expect(answer.stderr).toContain("did not answer");
      expect(endpoint.asked).toEqual([NEWEST]);
    } finally {
      await endpoint.close();
    }
  }, 60_000);

  it("names every generation it asked when none holds the asset", async () => {
    const endpoint = await fakeEndpoint({ fallback: 7 });
    try {
      const answer = await runCliServed(["entry", ASSET], environment(endpoint.url));
      expect(answer.code).toBe(0);
      for (const registry of [NEWEST, MIDDLE, OLDEST]) {
        expect(answer.stdout).toContain(registry);
      }
    } finally {
      await endpoint.close();
    }
  }, 60_000);

  it("contacts no address that the deployments file does not record", async () => {
    const endpoint = await fakeEndpoint({ fallback: 7 });
    try {
      await runCliServed(["entry", ASSET], environment(endpoint.url));
      for (const contract of endpoint.asked) {
        expect([OLDEST, MIDDLE, NEWEST], `the client asked ${contract}`).toContain(contract);
      }
      expect(endpoint.asked.length).toBeGreaterThan(0);
    } finally {
      await endpoint.close();
    }
  }, 60_000);
});


describe("a context file that an operator can correct", () => {
  it("names no asset, and the command line reports a wrong command line", () => {
    const path = contextFile("snapshot_ledger = 100\n");
    const answer = runCli(["prove", path, "customers.csv"]);
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("names no asset");
    // The line below belongs to the other kind of failure. A correctable value
    // must never carry it.
    expect(answer.stderr).not.toContain("It is not a verdict.");
  });

  it("states no snapshot ledger, and the command line reports a wrong command line", () => {
    const path = contextFile('asset = "CBBB"\n');
    const answer = runCli(["prove", path, "customers.csv"]);
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("states no snapshot_ledger");
    expect(answer.stderr).not.toContain("It is not a verdict.");
  });

  it("does not exist, and the command line reports a wrong command line", () => {
    const answer = runCli(["prove", "/no/such/context.toml", "customers.csv"]);
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("cannot read the context file");
    expect(answer.stderr).not.toContain("It is not a verdict.");
  });

  it("reports the same code for attest as for prove, and for the same reason", () => {
    // The code alone is not enough here. The attest command checks several
    // things that all report the usage code, so a case that asserted only the
    // code would pass on a missing authority key if a later edit checked the
    // key before it read the context. The message names which one it was.
    const path = contextFile("snapshot_ledger = 100\n");
    const answer = runCli(["attest", path, "customers.csv"]);
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("names no asset");
    expect(answer.stderr).not.toContain("It is not a verdict.");
  });
});

describe("a configuration that the environment does not carry", () => {
  it("reports a wrong command line and names the variable", () => {
    const answer = runCli(["entry", REGISTRY], { ZKPOR_NETWORK: "" });
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("ZKPOR_NETWORK");
  });

  it("reports a wrong command line when the endpoint is missing", () => {
    const answer = runCli(["entry", REGISTRY], { ZKPOR_RPC_URL: "" });
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("ZKPOR_RPC_URL");
  });

  it("reports a wrong command line when the network has no known passphrase", () => {
    const answer = runCli(["entry", REGISTRY], { ZKPOR_NETWORK: "a-network-nobody-knows" });
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("ZKPOR_NETWORK_PASSPHRASE");
  });
});

describe("a failure of the client or of the network", () => {
  it("keeps its own code, and says it is not a verdict", () => {
    // Every part of this case is load-bearing, and an earlier form of it had
    // none of them. It used an address that does not parse, so the client
    // refused the value before it opened a connection, and the case tested
    // malformed-address handling while its comment described a network
    // failure. It then carried no deployments file, so a well-formed address
    // failed on the file rather than on the endpoint. Both gave the code 8,
    // which is why it passed, and neither reached the network.
    //
    // The address is well formed, the deployments file is the committed one,
    // and the endpoint is a port that nothing listens on, so the run reaches
    // the network and fails there.
    const answer = runCli(["entry", REGISTRY], { ZKPOR_DEPLOYMENTS: DEPLOYMENTS });
    expect(answer.code).toBe(EXIT_NO_VERDICT);
    expect(answer.stderr).toContain("It is not a verdict.");
    // The message names the call that could not reach the endpoint. Without
    // this the case passes again on any failure that happens to give 8.
    expect(answer.stderr).toContain("cannot simulate the call entry");
  });
});

describe("an address that this protocol does not accept", () => {
  // A value an operator typed wrong is a wrong command line, and it belongs to
  // the same code as a context file that omits a field. Reaching the client
  // library with it produced a message about an unsupported address type and
  // the code of a failure that is not a verdict, which is the same category
  // error on a different input.
  const MALFORMED = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  it.each([
    ["entry", ["entry", MALFORMED]],
    ["observe-reserves", ["observe-reserves", MALFORMED]],
    ["history", ["history", MALFORMED]],
    ["diagnose-reserves", ["diagnose-reserves", MALFORMED]],
    ["sign-entry", ["sign-entry", MALFORMED]],
  ])("reports a wrong command line for %s", (_name, args) => {
    const answer = runCli(args, { ZKPOR_DEPLOYMENTS: DEPLOYMENTS });
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("not a Stellar account address");
    expect(answer.stderr).not.toContain("It is not a verdict.");
  });

  it("names the value, so an operator sees what to correct", () => {
    expect(runCli(["entry", MALFORMED]).stderr).toContain(MALFORMED);
  });

  it("checks every address of a registration, and not only the first", () => {
    const answer = runCli([
      "prepare-registration",
      REGISTRY,
      ACCOUNT,
      `${ACCOUNT},${MALFORMED}`,
    ]);
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("a reserve address");
  });
});

describe("what the command line writes to its output", () => {
  it("writes the answer through the printer that every command uses", () => {
    // Nothing else in this file reads standard output, so the shipped binary
    // could stop writing anything and every case would still pass on its exit
    // code.
    //
    // The command matters. An earlier form of this used the one command that
    // writes to the output directly, so breaking the printer left it passing.
    // A malformed package reaches a verdict without a network and without the
    // toolchain, and it states that verdict through the printer, so this is the
    // path that exercises it.
    const directory = mkdtempSync(join(tmpdir(), "zkpor-cli-"));
    const path = join(directory, "customer.zkpor.json");
    writeFileSync(path, '{"format":"zkpor-inclusion/1"}\n');
    const answer = runCli(["verify-inclusion", path], { ZKPOR_DEPLOYMENTS: DEPLOYMENTS });
    expect(answer.code).toBe(4);
    expect(answer.stdout).toContain("The package is malformed.");
  });

  it("writes a refusal to standard error, and keeps it out of standard output", () => {
    // An operator that pipes the answer somewhere must not receive a refusal
    // in that pipe.
    const answer = runCli(["entry", "not-an-address"]);
    expect(answer.stderr).toContain("not a Stellar account address");
    expect(answer.stdout).toBe("");
  });
});

describe("no command and no argument", () => {
  it("prints the usage and reports a wrong command line", () => {
    expect(runCli([]).code).toBe(EXIT_USAGE);
    expect(runCli(["prove"]).code).toBe(EXIT_USAGE);
    expect(runCli(["verify-inclusion"]).code).toBe(EXIT_USAGE);
  });
});

describe("what a proving run reports", () => {
  // These read the value that the report returns. The earlier form asserted
  // that the source held the calls, and a call kept exactly where the
  // assertion looked and never reached passed it, on the two paths that matter
  // most: a submission that fails after a correct proof, and a run that says
  // whether its snapshot can still land.

  /** One proof. Every value is test data. */
  const PROOF = {
    proof: new Uint8Array(14_592),
    publicInputs: new Uint8Array(128),
    values: { final_root: 0x2ban, L: 1_000n, context_hash: 0x3can, inner_key_hash: 0x4dn },
  };

  /** One context. The snapshot is the ledger every case below counts from. */
  const CONTEXT = { asset: "CBBB", snapshotLedger: 5_000 };

  /** The last ledger at which the snapshot can still be attested. */
  const INSIDE = 5_000 + ATTESTATION_MAX_AGE_LEDGERS;

  function report(changes: { currentLedger?: number; submission?: { ledger: number; transactionHash: string } } = {}) {
    return runReport({
      context: CONTEXT,
      proof: PROOF,
      currentLedger: changes.currentLedger ?? INSIDE,
      ...(changes.submission === undefined ? {} : { submission: changes.submission }),
    });
  }

  it("states what the proof commits to", () => {
    const lines = report().join("\n");
    expect(lines).toContain("The proof holds 14 592 bytes.");
    expect(lines).toContain("The snapshot ledger is 5000.");
    expect(lines).toContain("The root is ");
    expect(lines).toContain("The total liabilities are 1000.");
    expect(lines).toContain("The context hash is ");
  });

  it("states the same values whether the run submitted or not", () => {
    // A submission that fails must not take the root away, and the witness
    // files are gone by then, so these lines are the only copy of it.
    const withoutSubmission = report();
    const withSubmission = report({
      submission: { ledger: 5_100, transactionHash: "a".repeat(64) },
    });
    for (const line of withoutSubmission.slice(0, 5)) {
      expect(withSubmission).toContain(line);
    }
  });

  it("says the snapshot can still be attested, at the ledger it read", () => {
    expect(report({ currentLedger: INSIDE }).join("\n")).toContain(
      `At ledger ${String(INSIDE)} the snapshot can still be attested.`,
    );
  });

  it("says plainly when the snapshot has left its window", () => {
    const lines = report({ currentLedger: INSIDE + 1 }).join("\n");
    expect(lines).toContain("has already left its window");
    expect(lines).toContain("Take a fresh snapshot and prove again.");
    expect(lines).not.toContain("can still be attested");
  });

  it("says nothing about the window once the registry accepted the root", () => {
    // The window is a question about whether a root can still land. It has
    // landed, so the question is answered.
    const lines = report({
      currentLedger: INSIDE + 1,
      submission: { ledger: 5_100, transactionHash: "b".repeat(64) },
    }).join("\n");
    expect(lines).toContain("The registry accepted the attestation at ledger 5100.");
    expect(lines).not.toContain("left its window");
  });

  it("is defined outside the command line, which is an entry point", () => {
    const report = readFileSync(join(HERE, "..", "src", "report.ts"), "utf8");
    expect([...report.matchAll(/export function runReport\(/g)]).toHaveLength(1);
    const cli = readFileSync(join(HERE, "..", "src", "cli.ts"), "utf8");
    expect(cli).not.toContain("function runReport(");
  });
});

describe("no test imports the command line", () => {
  /**
   * The specifier that no test may name, assembled rather than written.
   *
   * A scan that held the specifier as a literal would find it in its own
   * source and refuse itself.
   */
  const ENTRY = ["/src/", "cli", ".js"].join("");

  /** Every test source of this package. */
  function testSources(): string[] {
    return readdirSync(HERE).filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
  }

  it("scans a plausible number of files, because a scan of none reads as clean", () => {
    // This repository codified that once already, in the scan that refuses a
    // type assertion: a scan reaching no file passes without checking anything
    // and reads as a clean result. The count is part of the check.
    expect(testSources().length).toBeGreaterThanOrEqual(5);
    expect(testSources()).toContain("cli-exit-codes.test.ts");
  });

  it("because reaching an entry point runs it inside the test process", () => {
    // This is the general form of a defect that cost this project a suite
    // which passed every test and returned a failure. The command line runs
    // itself at the end of its own module, so reaching it from a test starts a
    // command line inside the process running the tests, against the runner's
    // arguments, and it calls process.exit. Every test still passes and the
    // suite still fails.
    //
    // The scan looks for the specifier anywhere rather than only after `from`.
    // A dynamic import names it too, and an earlier form of this check saw
    // only the static spelling, so an awaited import passed it while
    // reproducing the defect exactly.
    for (const name of testSources()) {
      const source = readFileSync(join(HERE, name), "utf8");
      expect(source, `${name} reaches the command line module`).not.toContain(ENTRY);
    }
  });

  it("and the command line offers nothing worth importing", () => {
    // The scan reads text, so it cannot see a specifier assembled at run time,
    // which is what this file itself does two definitions above. This closes
    // the motive rather than the spelling: the entry point exports nothing, so
    // no test has a reason to name it. The backstop for both is the exit
    // status of the suite, which is what the agreement job reads, and which is
    // non-zero the moment this module runs in a worker.
    const cli = readFileSync(join(HERE, "..", "src", "cli.ts"), "utf8");
    expect(cli).not.toMatch(/^export /m);
  });

  it("and the command line is still the entry point it claims to be", () => {
    // The rules above are worth nothing if the file stops running itself.
    const cli = readFileSync(join(HERE, "..", "src", "cli.ts"), "utf8");
    expect(cli).toContain("main().catch(");
  });
});

describe("what an attestation reports when the submission fails", () => {
  // This is the path the whole day began on, and the one nothing can enter: it
  // needs a real proving run and therefore the pinned toolchain. Counting the
  // occurrences of a call in the source stood in for it, and a call kept where
  // the count looks for it and never reached passed that.
  //
  // The decision of whether to report is a value now, so it can be read.

  /** One proof. Every value is test data. */
  const PROOF = {
    proof: new Uint8Array(14_592),
    publicInputs: new Uint8Array(128),
    values: { final_root: 0x2ban, L: 1_000n, context_hash: 0x3can, inner_key_hash: 0x4dn },
  };

  /** One context, and a ledger inside the window of its snapshot. */
  const CONTEXT = { asset: "CBBB", snapshotLedger: 5_000 };
  const LEDGER = 5_000 + 10;

  it("states what the proof commits to, even though nothing landed", async () => {
    const outcome = await attestAndReport({
      context: CONTEXT,
      proof: PROOF,
      readCurrentLedger: () => Promise.resolve(LEDGER),
      submit: () => Promise.reject(new Error("the network refused the attestation")),
    });
    const lines = outcome.lines.join("\n");
    // The witness files are swept by now, so these lines are the only copy of
    // the root that an issuer has.
    expect(lines).toContain("The root is ");
    expect(lines).toContain("The total liabilities are 1000.");
    expect(lines).toContain("The context hash is ");
    expect(lines).toContain("The proof holds 14 592 bytes.");
  });

  it("gives back the reason, so the command still fails as it did", async () => {
    const outcome = await attestAndReport({
      context: CONTEXT,
      proof: PROOF,
      readCurrentLedger: () => Promise.resolve(LEDGER),
      submit: () => Promise.reject(new Error("the network refused the attestation")),
    });
    expect(outcome.failure).toBeInstanceOf(Error);
    expect(String(outcome.failure)).toContain("the network refused");
  });

  it("says whether the snapshot can still land, when nothing landed", async () => {
    const closed = await attestAndReport({
      context: CONTEXT,
      proof: PROOF,
      readCurrentLedger: () => Promise.resolve(5_000 + ATTESTATION_MAX_AGE_LEDGERS + 1),
      submit: () => Promise.reject(new Error("no")),
    });
    expect(closed.lines.join("\n")).toContain("has already left its window");
  });

  it("states the accepted attestation when the submission lands", async () => {
    const outcome = await attestAndReport({
      context: CONTEXT,
      proof: PROOF,
      readCurrentLedger: () => Promise.resolve(LEDGER),
      submit: () => Promise.resolve({ ledger: 5_100, transactionHash: "a".repeat(64) }),
    });
    expect(outcome.failure).toBeUndefined();
    expect(outcome.lines.join("\n")).toContain("The registry accepted the attestation at ledger 5100.");
  });

  it("reports the same five values whichever way the submission went", async () => {
    const failed = await attestAndReport({
      context: CONTEXT,
      proof: PROOF,
      readCurrentLedger: () => Promise.resolve(LEDGER),
      submit: () => Promise.reject(new Error("no")),
    });
    const landed = await attestAndReport({
      context: CONTEXT,
      proof: PROOF,
      readCurrentLedger: () => Promise.resolve(LEDGER),
      submit: () => Promise.resolve({ ledger: 5_100, transactionHash: "a".repeat(64) }),
    });
    for (const line of failed.lines.slice(0, 5)) {
      expect(landed.lines).toContain(line);
    }
  });

  it("takes no key of its own, so neither reaches a value here", () => {
    // The submission is a callable the caller supplies, and the authority key
    // stays inside it. A signature that took the key would put it in a value
    // that a later line could log.
    const report = readFileSync(join(HERE, "..", "src", "report.ts"), "utf8");
    expect(report).not.toContain("AUTHORITY_SECRET");
    expect(report).not.toContain("readAuthoritySecret");
    // And the command line reads it into the call that signs, never into a name.
    const cli = readFileSync(join(HERE, "..", "src", "cli.ts"), "utf8");
    expect(cli).toContain("readAuthoritySecret(process.env),");
    expect(cli).not.toMatch(/const\s+\w+\s*=\s*readAuthoritySecret\(/);
  });
});

describe("stating what a command produced", () => {
  // The order between stating the lines and raising a failure is the property,
  // and the one command that returns a failure cannot be reached without the
  // pinned toolchain. It lives outside the command line so it can be driven.

  it("states the lines before it raises the failure", () => {
    // An issuer whose submission failed after a correct proof has no other copy
    // of the root: the witness files are swept by then. Raising first would
    // take it away.
    const stated: string[][] = [];
    const failure = new Error("the network refused the attestation");
    expect(() =>
      completeCommand({ lines: ["the root is 0x2b"], failure }, (lines) => {
        stated.push([...lines]);
      }),
    ).toThrow(failure);
    expect(stated, "the failure was raised before anything was stated").toEqual([
      ["the root is 0x2b"],
    ]);
  });

  it("raises exactly what it was given, so the exit code is unchanged", () => {
    const failure = new Error("the network refused the attestation");
    let raised: unknown;
    try {
      completeCommand({ lines: [], failure }, () => {});
    } catch (cause) {
      raised = cause;
    }
    expect(raised).toBe(failure);
  });

  it("returns the exit code a command names, and nothing when it names none", () => {
    expect(completeCommand({ lines: ["a"], code: 4 }, () => {})).toBe(4);
    expect(completeCommand({ lines: ["a"] }, () => {})).toBeUndefined();
    // A code of zero is a code, not an absence.
    expect(completeCommand({ lines: ["a"], code: 0 }, () => {})).toBe(0);
  });

  it("states the lines of every command, including one that names a code", () => {
    const stated: string[][] = [];
    completeCommand({ lines: ["one", "two"], code: 4 }, (lines) => {
      stated.push([...lines]);
    });
    expect(stated).toEqual([["one", "two"]]);
  });
});

describe("no secret is a value of the command line", () => {
  const cliSource = (): string => readFileSync(join(HERE, "..", "src", "cli.ts"), "utf8");

  it("never binds a secret variable of the environment to a name", () => {
    // Three secrets, one rule. The dashboard stopped binding the authority key
    // in the morning and the command line had not, and the key of a reserve
    // holder was bound in two more places. A key in a name is a key a later
    // line can log, render, or put in a message.
    expect(cliSource()).not.toMatch(/const\s+\w+\s*=\s*process\.env\[AUTHORITY_SECRET_ENV\]/);
    expect(cliSource()).not.toMatch(/const\s+\w+\s*=\s*process\.env\[RESERVE_SECRET_ENV\]/);
  });

  it("never binds a secret that a reader returns", () => {
    // The rule is about the secret itself. A signer may be a value here,
    // because a signer is what the operation needs and it exposes no secret
    // that this file then holds. Building one takes the secret for the length
    // of one expression inside the client library, which is the reason the
    // reader returns a signer rather than a string.
    expect(cliSource()).not.toMatch(/const\s+\w+\s*=\s*readAuthoritySecret\(/);
    expect(cliSource()).not.toMatch(/const\s+\w+\s*=\s*await\s+readMasterSecret\(/);
  });

  it("builds no signer of its own, because that needs the secret in a value", () => {
    expect(cliSource()).not.toContain("Keypair.fromSecret(");
  });

  it("holds every reader to one rule, so none drifts from the others", () => {
    const secret = readFileSync(join(HERE, "..", "src", "secret.ts"), "utf8");
    for (const reader of [
      "readMasterSecret",
      "readAuthoritySecret",
      "readAuthorityKeypair",
      "readReserveKeypair",
    ]) {
      expect(secret, `${reader} is missing`).toMatch(
        new RegExp(`export (?:async )?function ${reader}\\(`),
      );
    }
  });
});

describe("the sentence that follows a failure", () => {
  it("says the registry answered, when the registry answered", () => {
    // A refusal is the answer of the contract about the request. Calling it a
    // failure of the client or of the network is false in the one line a
    // reader consults to learn who answered.
    const note = failureNote(new RegistryRefusedError(7));
    expect(note).toContain("The registry answered this");
    expect(note).not.toContain("failure of the client");
  });

  it("says the registry answered even when the walk wrapped the refusal", () => {
    // The walk that finds the generation holding an asset wraps what a registry
    // answered, so its message can name the generation. A check of the
    // outermost value alone would call the answer of a contract a failure of
    // the network, in the one line a reader consults to learn who answered.
    const wrapped = new InfrastructureError("the registry CB6C did not answer", {
      cause: new RegistryRefusedError(7),
    });
    expect(failureNote(wrapped)).toContain("The registry answered this");
    expect(failureNote(wrapped)).not.toContain("failure of the client");
  });

  it("keeps the other sentence for a failure that is not an answer", () => {
    expect(failureNote(new Error("the client cannot reach the endpoint"))).toContain(
      "failure of the client or of the network",
    );
    expect(failureNote("a value that is not an error")).toContain("failure of the client");
  });
});

/**
 * The example of the customer check, run as a reader runs it.
 *
 * An example that nothing runs stops working quietly, and this one is the
 * deliverable a stranger meets first. The case runs the file itself rather than
 * reading it, so a change to the command line, to the recording, or to the
 * committed package fails here.
 */
describe("the example of the customer check", () => {
  /** The committed package that the recording attests. */
  const INCLUDED = join(HERE, "..", "..", "fixtures", "example_package.zkpor.json");

  /** The committed package that the check refuses. */
  const REFUSED = join(HERE, "..", "..", "fixtures", "example_package_wrong_balance.zkpor.json");

  /** Runs one example file and reports what it printed and what code it gave. */
  async function ran(file: string, args: readonly string[] = []) {
    return await new Promise<{ code: number; out: string }>((resolve) => {
      let out = "";
      const child = spawn(
        process.execPath,
        [join(HERE, "..", "examples", file), ...args],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
    });
  }

  it("answers the verdict of an included package, and the code zero", async () => {
    const answer = await ran("check-a-package.mjs");
    expect(answer.out).toContain("The leaf is under the attested root.");
    expect(answer.out).toContain("the exit code 0");
    expect(answer.code).toBe(0);
  }, 120_000);

  it("answers the verdict of a wrong balance, and the code seven", async () => {
    // A check that only accepts proves half of the claim. So the package that
    // the check refuses is committed beside the one it accepts, and this case
    // runs the same example against it.
    const answer = await ran("check-a-package.mjs", [REFUSED]);
    expect(answer.out).toContain("The recomputed root does not equal the attested root.");
    expect(answer.out).toContain(`the exit code ${EXIT_CODES["root-mismatch"]}`);
    expect(answer.code).toBe(EXIT_CODES["root-mismatch"]);
  }, 120_000);

  it("keeps the refused package one field away from the included one", () => {
    // A refusal proves the check works only while the refused file stays a
    // well formed package of the same customer. A file that drifted into
    // another shape would refuse for a reason nobody demonstrates.
    const included = parsePackage(readFileSync(INCLUDED, "utf8"));
    const refused = parsePackage(readFileSync(REFUSED, "utf8"));
    expect(refused.balance).not.toBe(included.balance);
    expect({ ...refused, balance: included.balance }).toEqual(included);
  });

  it("shows a caller the three answers the library can give", async () => {
    // The integration example teaches that a verdict is not a boolean, that a
    // refusal is an answer, and that a failure is not a verdict. A case that
    // read only the first would pass while the other two stopped working.
    const answer = await ran("verify-in-your-program.mjs");
    expect(answer.out).toContain("included: leaf 0 holds 1000");
    expect(answer.out).toContain("root-mismatch");
    expect(answer.out).toContain("which is not a verdict");
    expect(answer.code).toBe(0);
  }, 120_000);

  it("says that the answers came from a recording", async () => {
    // A reader who takes the recording for the chain has learned something
    // false. The file says so, and this reads the file rather than trusting it
    // to stay said.
    for (const name of ["check-a-package.mjs", "verify-in-your-program.mjs"]) {
      const text = readFileSync(join(import.meta.dirname, "..", "examples", name), "utf8");
      expect(text, name).toContain("A recording is not the chain.");
    }
  });
});
