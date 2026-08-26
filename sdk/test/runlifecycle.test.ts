/**
 * The lifecycle of one proving run.
 *
 * Every step here used to sit inline in the driver, where no test reached it: a
 * proving run needs the pinned toolchain, so on a machine without it the driver
 * cannot be entered at all. Any one of the calls could be deleted and the whole
 * suite stayed green. The order is the guarantee, and an order that only a
 * reader checks is an order that a rename breaks.
 *
 * These tests drive the lifecycle with a body of their own, so each step is
 * load-bearing: delete the lock, either guard, or either sweep, and something
 * below fails.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { withRunLifecycle } from "../src/runlifecycle.js";
import { prove } from "../src/proving.js";
import { FIXTURE_MASTER_SECRET } from "../src/constants.js";
import { RunLockedError, lockPath } from "../src/runlock.js";
import { clearWitnesses, witnessesOnDisk } from "../src/witnesses.js";
import { watchChild } from "../src/children.js";
import { builtLibrary } from "./built.js";

/** The prover input of one batch, which carries the salts. */
const BATCH_INPUT = "circuits/recursion/inner/Prover_0.toml";

/** A repository, with prover inputs on disk when a test asks for them. */
function repository(withWitnesses: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "zkpor-lifecycle-"));
  mkdirSync(join(root, "circuits/recursion/inner"), { recursive: true });
  mkdirSync(join(root, "circuits/recursion/agg"), { recursive: true });
  if (withWitnesses) {
    writeFileSync(join(root, BATCH_INPUT), "salt = 1\n");
    writeFileSync(join(root, "circuits/recursion/inner/Prover.toml"), "salt = 2\n");
  }
  return root;
}

/** A reporter that keeps what the lifecycle said. */
function reporter(): { steps: string[]; report: (step: string) => void } {
  const steps: string[] = [];
  return { steps, report: (step) => steps.push(step) };
}

describe("the lock of a run", () => {
  it("is held while the body runs, and given back when it ends", async () => {
    const root = repository(false);
    let heldDuringTheBody = false;
    await withRunLifecycle(root, reporter().report, async () => {
      heldDuringTheBody = existsSync(lockPath(root));
      return await Promise.resolve(0);
    });
    expect(heldDuringTheBody, "the lock was not held while the body ran").toBe(true);
    expect(existsSync(lockPath(root)), "the lock outlived the run").toBe(false);
  });

  it("is given back when the body throws", async () => {
    const root = repository(false);
    await expect(
      withRunLifecycle(root, reporter().report, () => Promise.reject(new Error("the prover failed"))),
    ).rejects.toThrow("the prover failed");
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it("refuses a second run on the same working tree", async () => {
    const root = repository(false);
    await withRunLifecycle(root, reporter().report, async () => {
      // A second run inside the first is the shape of two tools on one machine.
      await expect(
        withRunLifecycle(root, reporter().report, () => Promise.resolve(0)),
      ).rejects.toThrow(RunLockedError);
      return await Promise.resolve(0);
    });
  });

  it("refuses a second run before it sweeps anything the first one wrote", async () => {
    // A run that does not own the lock must never sweep, because the files it
    // would remove belong to the run that does.
    const root = repository(false);
    await withRunLifecycle(root, reporter().report, async () => {
      writeFileSync(join(root, BATCH_INPUT), "salt of the first run\n");
      await withRunLifecycle(root, reporter().report, () => Promise.resolve(0)).catch(
        () => undefined,
      );
      expect(readFileSync(join(root, BATCH_INPUT), "utf8")).toContain("the first run");
      return await Promise.resolve(0);
    });
  });
});

describe("the sweep before the body", () => {
  it("removes what an earlier run left, before this run writes anything", async () => {
    // This is the one sweep that reaches the files of a run that stopped
    // without running any code of its own.
    const root = repository(true);
    expect(witnessesOnDisk(root).length).toBeGreaterThan(0);
    let sawAtTheStart: string[] = [];
    await withRunLifecycle(root, reporter().report, async () => {
      sawAtTheStart = witnessesOnDisk(root);
      return await Promise.resolve(0);
    });
    expect(sawAtTheStart, "the body started on a tree that still held salts").toEqual([]);
  });
});

describe("the sweep after the body", () => {
  it("removes what the body wrote", async () => {
    const root = repository(false);
    await withRunLifecycle(root, reporter().report, async () => {
      writeFileSync(join(root, BATCH_INPUT), "salt = 1\n");
      return await Promise.resolve(0);
    });
    expect(witnessesOnDisk(root)).toEqual([]);
  });

  it("removes what the body wrote when the body throws", async () => {
    const root = repository(false);
    await expect(
      withRunLifecycle(root, reporter().report, () => {
        writeFileSync(join(root, BATCH_INPUT), "salt = 1\n");
        return Promise.reject(new Error("the prover failed"));
      }),
    ).rejects.toThrow("the prover failed");
    expect(witnessesOnDisk(root), "a failed run left the salts on disk").toEqual([]);
  });

  it("says what it did, so a reader of a run sees the step", async () => {
    const root = repository(false);
    const kept = reporter();
    await withRunLifecycle(root, kept.report, () => Promise.resolve(0));
    expect(kept.steps).toContain("removing the witness files");
  });
});

describe("the guards of a run", () => {
  it("are installed while the body runs, and removed when it ends", async () => {
    const root = repository(false);
    const before = process.listenerCount("SIGTERM");
    let during = 0;
    await withRunLifecycle(root, reporter().report, async () => {
      during = process.listenerCount("SIGTERM");
      return await Promise.resolve(0);
    });
    // Two guards: one stops the tools, one sweeps the files.
    expect(during, "a run installed no guard").toBe(before + 2);
    expect(process.listenerCount("SIGTERM"), "a guard outlived the run").toBe(before);
  });

  it("are removed when the body throws, so the process keeps its own behaviour", async () => {
    const root = repository(false);
    const before = process.listenerCount("SIGINT");
    await expect(
      withRunLifecycle(root, reporter().report, () => Promise.reject(new Error("no"))),
    ).rejects.toThrow();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("installs the guard that stops the tools before the guard that sweeps", async () => {
    // The order is the guarantee, and this asserts it at run time rather than
    // in the text of the file. A refactor can hold the two calls in the same
    // written order and still install them the other way round, through a
    // factory or a table of builders, and a reader of the source cannot tell.
    //
    // The two are told apart by what calling one does. The guard that stops the
    // tools returns. The guard that sweeps raises the signal again, so it never
    // returns, and it removes the witness files on the way. Calling the first
    // installed handler therefore answers the question, and it is answered
    // inside a process of its own, because one of the two answers ends that
    // process.
    const root = repository(false);
    const script = join(root, "order.ts");
    // The built package, because the source imports its siblings through
    // specifiers that only the bundler resolves.
    const lifecycle = builtLibrary();
    writeFileSync(
      script,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import { withRunLifecycle } from ${JSON.stringify(lifecycle)};`,
        `const before = process.listeners("SIGTERM");`,
        `void withRunLifecycle(${JSON.stringify(root)}, () => {}, async () => {`,
        `  writeFileSync(${JSON.stringify(join(root, BATCH_INPUT))}, "salt = 1");`,
        `  const added = process.listeners("SIGTERM").filter((each) => !before.includes(each));`,
        `  console.log("guards " + added.length);`,
        `  added[0]();`,
        `  console.log("first handler returned");`,
        `  console.log("witness kept " + existsSync(${JSON.stringify(join(root, BATCH_INPUT))}));`,
        `  return await new Promise(() => {});`,
        `});`,
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    child.kill("SIGKILL");

    expect(seen, "the lifecycle installed no guards").toContain("guards 2");
    expect(
      seen,
      "the first installed guard never returned, so the sweeping guard was installed first",
    ).toContain("first handler returned");
    // The sweeping guard removes the witness file on its way out, so the file
    // still being there is the second, independent sign of which one ran.
    expect(
      seen,
      "the first installed guard swept, so it was the file guard",
    ).toContain("witness kept true");
  }, 30_000);

  it("stops the tools before it sweeps when a run ends normally", () => {
    // This one is a source assertion and it is the weaker of the two, so it
    // says so rather than sitting beside the test above looking equal.
    //
    // On this path the body has already returned, and the difference between
    // the two orders is the microseconds between an uncatchable signal and the
    // removal of a file. Nothing can observe that without racing it, and a test
    // that raced it would fail at random, which is worse than a weaker
    // assertion that says what it is.
    const source = readFileSync(new URL("../src/runlifecycle.ts", import.meta.url), "utf8");
    const stop = source.indexOf("stopChildrenSync(");
    const sweep = source.indexOf("await clearWitnesses(repository);", stop);
    expect(stop).toBeGreaterThan(0);
    expect(sweep).toBeGreaterThan(stop);
  });
});

describe("a sweep that cannot remove a path", () => {
  /**
   * A body that leaves the working tree in a state the sweep cannot clear.
   *
   * It puts a regular file where the inner circuit directory belongs, so every
   * removal through it answers `ENOTDIR`. The `force` option ignores a path
   * that does not exist and nothing else, so it does not swallow this. No
   * permission is involved, so it behaves the same for an ordinary user and a
   * privileged one, and nothing here is skipped on any machine.
   *
   * The body creates the state rather than the set-up, because the sweep under
   * test is the one that runs when a run ends. A tree that is already broken
   * fails on the sweep that runs before a body writes, which is a different
   * step and a failure the operator should see.
   */
  function breakTheTree(root: string): void {
    const inner = join(root, "circuits/recursion/inner");
    rmSync(inner, { recursive: true, force: true });
    writeFileSync(inner, "a file where a directory belongs\n");
  }

  it("fails the way this test needs, on every machine", async () => {
    // The set-up is the whole test, so it is asserted rather than assumed.
    const root = repository(false);
    breakTheTree(root);
    await expect(clearWitnesses(root)).rejects.toThrow(/ENOTDIR/);
  });

  it("keeps the real failure rather than replacing it", async () => {
    const root = repository(false);
    await expect(
      withRunLifecycle(root, reporter().report, () => {
        breakTheTree(root);
        return Promise.reject(new Error("the real reason"));
      }),
    ).rejects.toThrow("the real reason");
  });

  it("still gives the lock back", async () => {
    const root = repository(false);
    await withRunLifecycle(root, reporter().report, () => {
      breakTheTree(root);
      return Promise.resolve(0);
    }).catch(() => undefined);
    expect(existsSync(lockPath(root)), "a failed sweep stranded the lock").toBe(false);
  });

  it("still drops both guards, so the process keeps its own behaviour", async () => {
    const root = repository(false);
    const before = process.listenerCount("SIGTERM");
    await withRunLifecycle(root, reporter().report, () => {
      breakTheTree(root);
      return Promise.resolve(0);
    }).catch(() => undefined);
    expect(process.listenerCount("SIGTERM"), "a failed sweep stranded the guards").toBe(before);
  });

  it("does not turn a run that succeeded into one that failed", async () => {
    // The sweep is housekeeping. A path that will not go is not a reason to
    // fail a run that produced a proof.
    const root = repository(false);
    await expect(
      withRunLifecycle(root, reporter().report, () => {
        breakTheTree(root);
        return Promise.resolve("the proof");
      }),
    ).resolves.toBe("the proof");
  });
});

describe("the driver, which is the only caller that matters", () => {
  /**
   * A repository that a run can enter and cannot finish.
   *
   * It holds the prover inputs of an earlier run and no versions file, so the
   * run stops on the pins. Reading the pins fails on a missing file, which is
   * the same failure on every machine, rather than on a tool missing from the
   * path, which is not.
   */
  function repositoryThatCannotProve(): string {
    const root = repository(true);
    // The generator directory has to exist for the paths to resolve, and the
    // versions file deliberately does not.
    mkdirSync(join(root, "tools/recursion-gen"), { recursive: true });
    return root;
  }

  /** A run of the real driver against that repository. */
  async function driveProve(root: string): Promise<unknown> {
    return await prove({
      repository: root,
      // Neither path is a fixture of this repository, so the run is not
      // refused before it starts.
      contextFile: join(root, "context.toml"),
      customersFile: join(root, "customers.csv"),
      masterSecret: 0x1234n,
      report: () => {},
    }).catch((cause: unknown) => cause);
  }

  it("stops on the pins, which is how a machine without the tools fails", async () => {
    const root = repositoryThatCannotProve();
    const refused = await driveProve(root);
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toContain("versions file");
  });

  it("takes the lifecycle, so a run that fails still sweeps what it found", async () => {
    // This is the assertion that the driver uses the lifecycle at all. The
    // call to it is one line, and deleting that line leaves every test of the
    // lifecycle itself passing, because they drive the lifecycle directly.
    // Only the swept tree shows that the driver went through it.
    const root = repositoryThatCannotProve();
    expect(witnessesOnDisk(root).length).toBeGreaterThan(0);
    await driveProve(root);
    expect(witnessesOnDisk(root), "the driver did not sweep, so it skipped the lifecycle").toEqual(
      [],
    );
  });

  it("gives the lock back when a run stops on the pins", async () => {
    const root = repositoryThatCannotProve();
    await driveProve(root);
    expect(existsSync(lockPath(root)), "a failed run left the lock behind").toBe(false);
  });

  it("installs no guard that outlives the run", async () => {
    const root = repositoryThatCannotProve();
    const before = process.listenerCount("SIGTERM");
    await driveProve(root);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("refuses a public secret without touching the working tree", async () => {
    // This refusal is about the run rather than the repository, so it must not
    // take the lock or sweep. A run that is legitimately using the tree would
    // otherwise lose its inputs to somebody else's mistake.
    const root = repositoryThatCannotProve();
    const before = witnessesOnDisk(root).length;
    expect(before).toBeGreaterThan(0);
    const refused = await prove({
      repository: root,
      contextFile: join(root, "context.toml"),
      customersFile: join(root, "customers.csv"),
      masterSecret: FIXTURE_MASTER_SECRET,
      report: () => {},
    }).catch((cause: unknown) => cause);
    expect(String(refused)).toContain("anybody could recompute");
    expect(witnessesOnDisk(root).length, "a refused run swept another run's inputs").toBe(before);
  });
});

describe("a stop whose deadline expires with a group still alive", () => {
  it("says so, rather than sweeping quietly against something still dying", async () => {
    // The sweep runs after the stop. When the stop gives up with a group still
    // alive, the sweep runs against a process that has not finished ending, and
    // a reader who is told nothing believes the tools are gone.
    //
    // The signal is watched and swallowed for the length of this test, because
    // no tool can be made to survive a signal that cannot be caught. Swallowing
    // it is the only way to reach the state the report exists for.
    const root = repository(false);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const real = process.kill.bind(process);
    const kept = reporter();
    try {
      watchChild(child);
      process.kill = (pid: number, signal?: string | number): true => {
        // A probe carrying the signal 0 asks whether a group exists, and the
        // wait needs a truthful answer. Anything else is swallowed, so the
        // group outlives the deadline.
        if (signal === 0) {
          return real(pid, signal);
        }
        return true;
      };
      await withRunLifecycle(root, kept.report, () => Promise.resolve(0));
    } finally {
      process.kill = real;
      real(-(child.pid ?? 0), "SIGKILL");
      await new Promise((resolve) => child.on("exit", resolve));
    }
    expect(
      kept.steps.join("\n"),
      "the lifecycle swept without saying a group was still alive",
    ).toContain("had not ended when the stop gave up");
    expect(kept.steps.join("\n")).toContain(String(child.pid));
  }, 30_000);

  it("says nothing of the kind when every group ended", async () => {
    const root = repository(false);
    const kept = reporter();
    await withRunLifecycle(root, kept.report, () => Promise.resolve(0));
    expect(kept.steps.join("\n")).not.toContain("had not ended");
    expect(kept.steps.join("\n")).toContain("removing the witness files");
  });
});
