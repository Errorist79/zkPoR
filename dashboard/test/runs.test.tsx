/**
 * The run that takes about a minute, and the two things that gap creates.
 *
 * The first is concurrency. A second submission, from a second tab or from a
 * second click, must not start a second prover: the prover needs more memory
 * than two copies fit in, the proving driver writes its witness files at fixed
 * paths, and two attestations of one asset race for the same window. The tests
 * below hold a run open and check that nothing starts a second one.
 *
 * The second is the secret. A run holds the master secret for minutes, and the
 * page of a run is a browser surface. The tests check that no page and no run
 * record carries a value from the environment, and that the code never binds
 * the secret to a name of its own.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTESTATION_MAX_AGE_LEDGERS, MASTER_SECRET_ENV, AUTHORITY_SECRET_ENV } from "@zkpor/sdk";
import { MAX_REMEMBERED_RUNS, ROUTES } from "../src/constants.js";
import {
  RunRefusedError,
  afterTheProof,
  submitRun,
} from "../src/attestation.js";
import { route } from "../src/routes.js";
import { SILENT_LOG } from "../src/log.js";
import { RunStore } from "../src/runs.js";
import type { ProofSummary, Run, RunOutcome, Submission, WindowAtEnd } from "../src/runs.js";
import { RunPage } from "../src/views/run.js";
import {
  ASSET,
  PACKAGE_ROOT,
  REPOSITORY_ROOT,
  dashboard,
  reader,
  request,
  framed,
  sources,
} from "./support.js";

/** A promise that a test settles when it chooses. */
function deferred() {
  let settle: (outcome: RunOutcome) => void = () => {};
  let fail: (cause: Error) => void = () => {};
  const promise = new Promise<RunOutcome>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

/** One proof summary. The values are test data. */
const PROOF = {
  proofBytes: 14_592,
  finalRoot: 0x2ban,
  totalLiabilities: 1_000n,
  contextHash: 0x3can,
};

/** A run request whose work a test controls, and a count of the times it ran. */
function controlled() {
  const gate = deferred();
  const calls = { count: 0 };
  return {
    gate,
    calls,
    request: {
      action: "attest" as const,
      asset: ASSET,
      snapshotLedger: 5_000,
      work: async () => {
        calls.count += 1;
        return await gate.promise;
      },
    },
  };
}

/** Lets every settled promise run its handlers. */
async function settleEverything(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("a second submission while a run is open", () => {
  it("starts nothing and joins the open run", () => {
    const store = new RunStore();
    const first = controlled();
    const second = controlled();
    const started = store.startOrJoin(first.request);
    const joined = store.startOrJoin(second.request);

    expect(started.started).toBe(true);
    expect(joined.started).toBe(false);
    expect(joined.run.id).toBe(started.run.id);
    expect(first.calls.count).toBe(1);
    expect(second.calls.count).toBe(0);
  });

  it("frees the store once the run ends, so a later submission starts a run", async () => {
    const store = new RunStore();
    const first = controlled();
    const started = store.startOrJoin(first.request);
    first.gate.settle({ proof: PROOF, submission: undefined, window: undefined, packages: undefined });
    await settleEverything();

    expect(store.open()).toBeUndefined();
    const second = controlled();
    const later = store.startOrJoin(second.request);
    expect(later.started).toBe(true);
    expect(later.run.id).not.toBe(started.run.id);
    expect(second.calls.count).toBe(1);
  });

  it("frees the store when the run fails", async () => {
    const store = new RunStore();
    const first = controlled();
    const started = store.startOrJoin(first.request);
    first.gate.fail(new Error("the prover does not match the pins"));
    await settleEverything();

    expect(store.open()).toBeUndefined();
    expect(store.get(started.run.id)?.stage).toBe("failed");
    // A failed run frees the store, so the issuer can correct the cause and
    // start again without a restart of the process.
    expect(store.startOrJoin(controlled().request).started).toBe(true);
  });
});

describe("the record of a run", () => {
  it("keeps the steps that the work reported, in order", async () => {
    const store = new RunStore();
    const gate = deferred();
    const started = store.startOrJoin({
      action: "prove",
      asset: ASSET,
      snapshotLedger: 5_000,
      work: async (report) => {
        report("checking the prover against the pins");
        report("proving the aggregation, which is the slowest step");
        return await gate.promise;
      },
    });
    await settleEverything();
    expect(store.get(started.run.id)?.steps).toEqual([
      "checking the prover against the pins",
      "proving the aggregation, which is the slowest step",
    ]);
    gate.settle({ proof: PROOF, submission: undefined, window: undefined, packages: undefined });
    await settleEverything();
    const finished = store.get(started.run.id);
    expect(finished?.stage).toBe("finished");
    expect(finished?.proof).toEqual(PROOF);
  });

  it("records a failure as a stage of its own, with the reason", async () => {
    const store = new RunStore();
    const first = controlled();
    const started = store.startOrJoin(first.request);
    first.gate.fail(new Error("the prover does not match the pins"));
    await settleEverything();
    const run = store.get(started.run.id);
    expect(run?.stage).toBe("failed");
    expect(run?.failure).toBe("the prover does not match the pins");
    expect(run?.proof).toBeUndefined();
  });

  it("carries no field for a key", () => {
    const store = new RunStore();
    const started = store.startOrJoin(controlled().request);
    expect(new Set(Object.keys(started.run))).toEqual(
      new Set([
        "id",
        "action",
        "asset",
        "snapshotLedger",
        "stage",
        "steps",
        "proof",
        "submission",
        "window",
        // The directory the packages went to. It names an asset and a snapshot
        // and no customer, and it holds no key.
        "packages",
        "failure",
      ]),
    );
  });

  it("forgets the oldest run and never the open one", async () => {
    const store = new RunStore();
    const ids: string[] = [];
    for (let made = 0; made < MAX_REMEMBERED_RUNS + 3; made += 1) {
      const each = controlled();
      ids.push(store.startOrJoin(each.request).run.id);
      each.gate.settle({ proof: PROOF, submission: undefined, window: undefined, packages: undefined });
      await settleEverything();
    }
    const first = ids[0];
    const last = ids[ids.length - 1];
    if (first === undefined || last === undefined) {
      throw new Error("the loop recorded no run");
    }
    expect(store.get(first)).toBeUndefined();
    expect(store.get(last)).toBeDefined();
  });
});

describe("reading the page of a run", () => {
  it("starts nothing, however many times a browser reloads it", async () => {
    const store = new RunStore();
    const first = controlled();
    const started = store.startOrJoin(first.request);
    const context = dashboard({ deploymentsText: "[]", store });
    for (let read = 0; read < 5; read += 1) {
      const answered = await route(
        request({ target: `${ROUTES.run}/${started.run.id}` }),
        context,
      );
      expect(answered.status).toBe(200);
    }
    expect(first.calls.count).toBe(1);
  });

  it("answers a run that this process no longer holds", async () => {
    const answered = await route(
      request({ target: `${ROUTES.run}/0a1b2c3d-0000-4000-8000-000000000000` }),
      dashboard({ deploymentsText: "[]" }),
    );
    expect(answered.status).toBe(404);
    expect(answered.body).toContain("This process holds no such run");
  });
});

/** One run in one stage. */
function runIn(stage: Run["stage"]): Run {
  return {
    id: "0a1b2c3d-0000-4000-8000-000000000000",
    action: "attest",
    asset: ASSET,
    snapshotLedger: 5_000,
    stage,
    steps: ["proving the aggregation, which is the slowest step"],
    proof: stage === "finished" ? PROOF : undefined,
    submission: undefined,
    window: undefined,
    packages: undefined,
    failure: stage === "failed" ? "the prover does not match the pins" : undefined,
  };
}

describe("the page of an open run", () => {
  it("reloads itself, and needs no script to do it", () => {
    const markup = framed(<RunPage run={runIn("running")} joined={false} />);
    expect(markup).toContain('http-equiv="refresh"');
    expect(markup).not.toMatch(/<script/i);
  });

  it("stops reloading itself once the run ends", () => {
    for (const stage of ["finished", "failed"] as const) {
      expect(framed(<RunPage run={runIn(stage)} joined={false} />)).not.toContain(
        'http-equiv="refresh"',
      );
    }
  });

  it("says plainly when a submission started nothing", () => {
    const markup = framed(<RunPage run={runIn("running")} joined={true} />);
    expect(markup).toContain("your submission started nothing");
  });
});

/**
 * A value that only the environment holds.
 *
 * The test puts it in the real environment of this process and in the
 * environment that the dashboard carries, so a page that read either one would
 * render it. An earlier version of this test invented two literals and asserted
 * that pages did not contain them. Nothing ever put those literals anywhere, so
 * the test passed against a page that rendered the real secret. This one fails
 * against that page.
 */
const SENTINEL = "0xSECRETVALUEfromTHEenvironment0000000000000000000000000000000000";

/** The second value, so a page that reads the authority key fails here too. */
const AUTHORITY_SENTINEL = "SAUTHORITYKEYfromTHEenvironment00000000000000000000000000";

/** Runs the body with both keys in the real environment of this process. */
function withSecretsInTheEnvironment(body: () => void): void {
  const before = {
    master: process.env[MASTER_SECRET_ENV],
    authority: process.env[AUTHORITY_SECRET_ENV],
  };
  process.env[MASTER_SECRET_ENV] = SENTINEL;
  process.env[AUTHORITY_SECRET_ENV] = AUTHORITY_SENTINEL;
  try {
    body();
  } finally {
    if (before.master === undefined) {
      delete process.env[MASTER_SECRET_ENV];
    } else {
      process.env[MASTER_SECRET_ENV] = before.master;
    }
    if (before.authority === undefined) {
      delete process.env[AUTHORITY_SECRET_ENV];
    } else {
      process.env[AUTHORITY_SECRET_ENV] = before.authority;
    }
  }
}

describe("the pages of a run and the environment", () => {
  it("render no value that the environment holds", () => {
    withSecretsInTheEnvironment(() => {
      for (const stage of ["running", "finished", "failed"] as const) {
        for (const joined of [false, true]) {
          const markup = framed(<RunPage run={runIn(stage)} joined={joined} />);
          expect(markup).not.toContain(SENTINEL);
          expect(markup).not.toContain(AUTHORITY_SENTINEL);
        }
      }
      const withProof = framed(
        <RunPage run={{ ...runIn("finished"), proof: PROOF }} joined={false} />,
      );
      expect(withProof).not.toContain(SENTINEL);
      expect(withProof).not.toContain(AUTHORITY_SENTINEL);
    });
  });

  it("render no value that the dashboard carries in its environment", async () => {
    const store = new RunStore();
    const first = controlled();
    const started = store.startOrJoin(first.request);
    const context = dashboard({
      deploymentsText: "[]",
      store,
      environment: {
        [MASTER_SECRET_ENV]: SENTINEL,
        [AUTHORITY_SECRET_ENV]: AUTHORITY_SENTINEL,
      },
    });
    for (const target of [
      `${ROUTES.run}/${started.run.id}`,
      ROUTES.attestation,
      ROUTES.home,
      ROUTES.inclusion,
    ]) {
      const answered = await route(request({ target }), context);
      expect(answered.body, target).not.toContain(SENTINEL);
      expect(answered.body, target).not.toContain(AUTHORITY_SENTINEL);
    }
  });

  it("keeps no value of the environment in the record of a run", async () => {
    const store = new RunStore();
    const gate = deferred();
    const started = store.startOrJoin({
      action: "attest",
      asset: ASSET,
      snapshotLedger: 5_000,
      work: async () => await gate.promise,
    });
    gate.fail(new Error("the prover does not match the pins"));
    await settleEverything();
    // The whole record, serialized, is the surface a page can render from.
    const record = JSON.stringify(store.get(started.run.id), (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString(10) : value,
    );
    expect(record).not.toContain(SENTINEL);
    expect(record).not.toContain(AUTHORITY_SENTINEL);
    expect(record).not.toContain("SECRET");
  });
});

describe("a submission that this process cannot run", () => {
  const context = join(REPOSITORY_ROOT, "fixtures", "test_only_context.toml");

  it("refuses when the environment carries no master secret", async () => {
    await expect(
      submitRun({
        store: new RunStore(),
        reader: reader("[]"),
        environment: {},
        repository: PACKAGE_ROOT,
        log: SILENT_LOG,
        submission: { action: "prove", contextPath: context, customersPath: "customers.csv" },
      }),
    ).rejects.toThrow(RunRefusedError);
  });

  it("refuses an attestation when the environment carries no authority key", async () => {
    await expect(
      submitRun({
        store: new RunStore(),
        reader: reader("[]"),
        environment: { [MASTER_SECRET_ENV]: `0x${"11".repeat(32)}` },
        repository: PACKAGE_ROOT,
        log: SILENT_LOG,
        submission: { action: "attest", contextPath: context, customersPath: "customers.csv" },
      }),
    ).rejects.toThrow(RunRefusedError);
  });

  it("names the variable and never a value", async () => {
    const refused = await submitRun({
      store: new RunStore(),
      reader: reader("[]"),
      environment: { [MASTER_SECRET_ENV]: `0x${"11".repeat(32)}` },
      repository: PACKAGE_ROOT,
      log: SILENT_LOG,
      submission: { action: "attest", contextPath: context, customersPath: "customers.csv" },
    }).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(Error);
    if (refused instanceof Error) {
      expect(refused.message).toContain(AUTHORITY_SECRET_ENV);
      expect(refused.message).not.toContain("11".repeat(32));
    }
  });
});

describe("both secrets in the source", () => {
  /**
   * The two readers of the client library, and every form a call of one may
   * take.
   *
   * The list states the allowed forms rather than a count of the call sites. A
   * count refused a second call site, which made it refuse the legitimate one
   * that writes the packages of the customers as loudly as it would refuse a
   * leak, and the number said nothing about why. The property is that a read
   * passes straight into the call that needs it. A new call site is allowed
   * here by writing its form, which is a line a reviewer can weigh.
   */
  const READERS = [
    {
      reader: "readMasterSecret",
      forms: [
        // The proof, and the packages of the customers after the attestation.
        /^\s*masterSecret: await readMasterSecret\(input\.environment\),$/,
      ],
    },
    {
      reader: "readAuthoritySecret",
      forms: [
        // The submission of the attestation.
        /^\s*readAuthoritySecret\(input\.environment\),$/,
      ],
    },
  ] as const;

  const text = (): string =>
    sources()
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

  it.each(READERS)(
    "reads $reader into the call that needs it, and never into a name of this package",
    ({ reader, forms }) => {
      const source = text();
      const calls = source
        .split("\n")
        .filter((line) => line.includes(`${reader}(`))
        .map((line) => line.trimEnd());
      // Every call site takes one of the forms above. A call in any other
      // shape fails here and names itself.
      expect(calls.length).toBeGreaterThan(0);
      for (const line of calls) {
        expect(
          forms.some((form) => form.test(line)),
          `${reader} is called as: ${line.trim()}`,
        ).toBe(true);
      }
      // A binding would put the value in a name of this package, where a later
      // line could log it, render it, or put it in a progress message.
      expect(source).not.toMatch(
        new RegExp(`(?:const|let|var)\\s+\\w+\\s*=\\s*(?:await\\s+)?${reader}\\(`),
      );
    },
  );

  it.each(READERS)("never puts $reader inside a progress message", ({ reader }) => {
    // The steps of a run are rendered on the run page. A secret interpolated
    // into one would reach a browser, and only a real proving run fires those
    // steps, so no other test can reach that channel.
    for (const path of sources()) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.includes("report(")) {
          expect(line, `${path}: ${line.trim()}`).not.toContain(reader);
        }
      }
    }
  });

  it("holds the two secrets to one rule, so neither can drift from the other", () => {
    // The rule above is a list, and the list is the thing that must not shrink.
    // An authority key protected by nothing while the master secret is
    // protected by a rule is the state this test exists to refuse.
    expect(READERS.map((each) => each.reader).sort()).toEqual([
      "readAuthoritySecret",
      "readMasterSecret",
    ]);
  });
});

describe("a submission that fails after a correct proof", () => {
  it("keeps what the proof committed to", async () => {
    const store = new RunStore();
    const gate = deferred();
    const started = store.startOrJoin({
      action: "attest",
      asset: ASSET,
      snapshotLedger: 5_000,
      work: async (report, recordProof) => {
        recordProof(PROOF);
        report("submitting the attestation and waiting for the network");
        return await gate.promise;
      },
    });
    await settleEverything();
    gate.fail(
      new Error("the snapshot ledger 5000 is outside the window at the current ledger 5800"),
    );
    await settleEverything();

    const run = store.get(started.run.id);
    expect(run?.stage).toBe("failed");
    // The window closed, so the attestation never landed. The root must survive
    // that, because the witness files are gone and no other copy of it exists.
    expect(run?.proof).toEqual(PROOF);
    expect(run?.submission).toBeUndefined();
    expect(run?.failure).toContain("outside the window");
  });

  it("shows the root on the page of the failed run", () => {
    const run: Run = {
      ...runIn("failed"),
      proof: PROOF,
      failure: "the snapshot ledger 5000 is outside the window at the current ledger 5800",
    };
    const markup = framed(<RunPage run={run} joined={false} />);
    expect(markup).toContain("The run failed.");
    expect(markup).toContain("The proof finished and the run failed after it.");
    expect(markup).toContain(PROOF.totalLiabilities.toString(10));
    expect(markup).toContain("outside the window");
  });
});

describe("a submission that fails after the window closed", () => {
  it("keeps the reading of the window, not only the proof", async () => {
    const store = new RunStore();
    const gate = deferred();
    const started = store.startOrJoin({
      action: "attest",
      asset: ASSET,
      snapshotLedger: 5_000,
      work: async (_report, recordProof, recordWindow) => {
        recordProof(PROOF);
        recordWindow({ currentLedger: 5_900, stillOpen: false });
        return await gate.promise;
      },
    });
    await settleEverything();
    gate.fail(new Error("the snapshot left its window before the proof finished"));
    await settleEverything();

    const run = store.get(started.run.id);
    expect(run?.stage).toBe("failed");
    expect(run?.proof).toEqual(PROOF);
    // The window reading is the reason the run failed. Losing it leaves the
    // issuer with a root and no statement of why it did not land.
    expect(run?.window).toEqual({ currentLedger: 5_900, stillOpen: false });
  });
});

describe("a prove-only run and the window", () => {
  it("says the snapshot can still be attested, and names the ledger it read", () => {
    const run: Run = {
      ...runIn("finished"),
      action: "prove",
      proof: PROOF,
      window: { currentLedger: 5_100, stillOpen: true },
    };
    const markup = framed(<RunPage run={run} joined={false} />);
    expect(markup).toContain("At ledger 5100 the snapshot could still be attested.");
    // The window closes at the snapshot plus the constant of the kit.
    expect(markup).toContain(String(5_000 + ATTESTATION_MAX_AGE_LEDGERS));
  });

  it("says plainly when the snapshot already left the window", () => {
    const run: Run = {
      ...runIn("finished"),
      action: "prove",
      proof: PROOF,
      window: { currentLedger: 9_999, stillOpen: false },
    };
    const markup = framed(<RunPage run={run} joined={false} />);
    expect(markup).toContain("had already left its window");
    expect(markup).toContain("The registry refuses this root now.");
    expect(markup).not.toContain("could still be attested");
  });
});


describe("what one run does once the proof exists", () => {
  /** What one call recorded and did. */
  function watcher(failPackages = false) {
    const proofs: ProofSummary[] = [];
    const windows: WindowAtEnd[] = [];
    const steps: string[] = [];
    const written: Submission[] = [];
    const recorded: Submission[] = [];
    let submissions = 0;
    return {
      proofs,
      windows,
      steps,
      written,
      recorded,
      submitted: () => submissions,
      call: async (action: "prove" | "attest", currentLedger: number) =>
        await afterTheProof({
          action,
          snapshotLedger: 5_000,
          currentLedger,
          proof: PROOF,
          report: (step) => steps.push(step),
          recordProof: (proof) => proofs.push(proof),
          recordWindow: (window) => windows.push(window),
          recordSubmission: (submission) => recorded.push(submission),
          submit: async () => {
            submissions += 1;
            return await Promise.resolve({
              ledger: 5_100,
              transactionHash: "a".repeat(64),
              registry: "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG",
            });
          },
          writePackages: async (accepted) => {
            written.push(accepted);
            if (failPackages) {
              throw new Error("the generator refused");
            }
            return await Promise.resolve("/somewhere/packages");
          },
        }),
    };
  }

  /** A ledger inside the window of the snapshot, and one past it. */
  const INSIDE = 5_000 + ATTESTATION_MAX_AGE_LEDGERS;
  const PAST = INSIDE + 1;

  it("writes the packages of the customers after an attestation, and names where", async () => {
    // An issuer who attests through this page must leave their customers able
    // to check inclusion. A run that attested and wrote no package would make
    // the customer check impossible for that snapshot, because a package binds
    // to the snapshot that the registry attests.
    const seen = watcher();
    const outcome = await seen.call("attest", INSIDE);
    expect(seen.written).toEqual([
      {
        ledger: 5_100,
        transactionHash: "a".repeat(64),
        registry: "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG",
      },
    ]);
    expect(outcome.packages).toBe("/somewhere/packages");
    expect(seen.steps).toContain("the packages of the customers are under /somewhere/packages");
  });

  it("records the transaction before the packages, so a later failure cannot hide it", async () => {
    // The attestation stands on the chain the moment the registry accepts it.
    // A page that said this run submitted nothing, because a step after the
    // network failed, would send the issuer to attest a second time.
    const seen = watcher(true);
    await expect(seen.call("attest", INSIDE)).rejects.toThrow("the generator refused");
    expect(seen.recorded).toEqual([
      {
        ledger: 5_100,
        transactionHash: "a".repeat(64),
        registry: "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG",
      },
    ]);
  });

  it("writes no package for a run that only proved", async () => {
    // A package names the transaction that carries the attestation, and a run
    // that proved has no such transaction.
    const seen = watcher();
    const outcome = await seen.call("prove", INSIDE);
    expect(seen.written).toEqual([]);
    expect(outcome.packages).toBeUndefined();
  });

  it("writes no package when the window closed before the submission", async () => {
    const seen = watcher();
    await expect(seen.call("attest", PAST)).rejects.toThrow(RunRefusedError);
    expect(seen.written).toEqual([]);
  });

  it("records the proof before anything that can fail after it", async () => {
    const seen = watcher();
    await seen.call("attest", INSIDE);
    expect(seen.proofs).toEqual([PROOF]);
  });

  it("records the proof even when the submission fails", async () => {
    const seen = watcher();
    // The window closed, so this run never reaches the network. The root must
    // survive that, because the witness files are already gone.
    await expect(seen.call("attest", PAST)).rejects.toThrow(RunRefusedError);
    expect(seen.proofs).toEqual([PROOF]);
  });

  it("records the reading of the window, on every path", async () => {
    for (const [action, ledger, stillOpen] of [
      ["prove", INSIDE, true],
      ["prove", PAST, false],
      ["attest", INSIDE, true],
    ] as const) {
      const seen = watcher();
      await seen.call(action, ledger);
      expect(seen.windows, `${action} at ${String(ledger)}`).toEqual([
        { currentLedger: ledger, stillOpen },
      ]);
    }
    const refused = watcher();
    await expect(refused.call("attest", PAST)).rejects.toThrow(RunRefusedError);
    expect(refused.windows).toEqual([{ currentLedger: PAST, stillOpen: false }]);
  });

  it("reads the window from the snapshot and the current ledger, at the boundary", async () => {
    const open = watcher();
    await open.call("prove", INSIDE);
    expect(open.windows[0]?.stillOpen).toBe(true);
    const closed = watcher();
    await closed.call("prove", PAST);
    expect(closed.windows[0]?.stillOpen).toBe(false);
  });

  it("submits when the window still stands", async () => {
    const seen = watcher();
    const outcome = await seen.call("attest", INSIDE);
    expect(seen.submitted()).toBe(1);
    expect(outcome.submission?.ledger).toBe(5_100);
  });

  it("submits nothing when the window has closed, and says why", async () => {
    const seen = watcher();
    await expect(seen.call("attest", PAST)).rejects.toThrow("left its window before the proof");
    // A run that already knows the answer must not spend a round trip on the
    // network to hear it again.
    expect(seen.submitted()).toBe(0);
  });

  it("submits nothing on a run that only proves", async () => {
    const seen = watcher();
    const outcome = await seen.call("prove", INSIDE);
    expect(seen.submitted()).toBe(0);
    expect(outcome.submission).toBeUndefined();
    expect(outcome.window).toEqual({ currentLedger: INSIDE, stillOpen: true });
  });
});

describe("the finished run and the check that follows it", () => {
  const finished = (packages: string | undefined) =>
    framed(<RunPage run={{ ...runIn("finished"), proof: PROOF, packages }} joined={false} />);

  // Every page carries the check in its navigation, so the presence of that
  // link proves nothing here. What these read is the sentence beside the
  // packages, which is the one that tells a reader what to do next.
  const INVITATION = "check it against the chain";

  it("sends a reader from the packages of a run to the check", () => {
    // A reader who has the packages and no sentence about them has to work out
    // that the check exists, and the check is the step that makes a run mean
    // anything to a customer.
    const markup = finished("/run/out/packages/CBSQ/4263061");
    expect(markup).toContain(INVITATION);
    expect(markup).toContain(`href="${ROUTES.inclusion}"`);
  });

  it("says nothing about a check on a run that wrote no packages", () => {
    expect(finished(undefined)).not.toContain(INVITATION);
  });

  it("carries no directory into the field of the check", () => {
    // The field takes one file. A page that put the directory there would
    // either be refused on arrival or would choose whose balance to show.
    const markup = finished("/run/out/packages/CBSQ/4263061");
    expect(markup).not.toContain(`${ROUTES.inclusion}?`);
  });
});
