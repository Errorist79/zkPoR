/**
 * The tools of a run, and the guarantee that none of them outlives the sweep.
 *
 * A sweep that removes the prover inputs is worth nothing while a tool that
 * writes them is still running. The tool writes the salts back after the sweep,
 * and no process is left that will ever remove them, so the exposure stops
 * being bounded and the sweep running is what creates it.
 *
 * Every test here uses real processes. A signal reaches a process and not a
 * function, a process group belongs to the operating system, and the defect is
 * a child that survives its parent. None of that can be shown with a stand-in.
 *
 * The case that matters is a signal sent to the parent alone. In a terminal an
 * interrupt reaches the whole foreground group, so the tools die with the
 * parent by accident. A service manager, a supervisor, and a stopped dashboard
 * each signal the parent alone, and that is the normal case for the long-lived
 * front end this work exists for.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alive, until } from "./processes.js";
import {
  STOP_DEADLINE,
  stopChildrenSync,
  waitForGroupsToEnd,
  watchChild,
  watchedChildren,
} from "../src/children.js";
import { runTool } from "../src/proving.js";
import { builtLibrary } from "./built.js";
import { witnessesOnDisk } from "../src/witnesses.js";

/** The prover input that the tool of a run keeps writing. */
const PROVER_INPUT = "circuits/recursion/inner/Prover.toml";

/** The text that the tool writes, which tells a rewrite from the original. */
const REWRITTEN = "salt = written again";

/** A repository with the prover inputs of a run on disk. */
function repositoryWithWitnesses(): string {
  const root = mkdtempSync(join(tmpdir(), "zkpor-children-"));
  mkdirSync(join(root, "circuits/recursion/inner"), { recursive: true });
  mkdirSync(join(root, "circuits/recursion/agg"), { recursive: true });
  writeFileSync(join(root, PROVER_INPUT), "salt = 1\n");
  writeFileSync(join(root, "circuits/recursion/inner/Prover_0.toml"), "salt = 2\n");
  return root;
}

/** True when a process group still has a member. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

/**
 * A tool that behaves like the prover: it starts further work, and it keeps
 * writing the prover input for as long as it runs.
 *
 * `cargo run` starts the generator as a further process, so a signal aimed at
 * the tool alone would leave the process that actually writes the file.
 */
function toolScript(root: string): string {
  return [
    `import { writeFileSync } from "node:fs";`,
    `import { spawn } from "node:child_process";`,
    `const further = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(join(root, "tool.started"))}, String(further.pid));`,
    `setInterval(() => {`,
    `  writeFileSync(${JSON.stringify(join(root, PROVER_INPUT))}, ${JSON.stringify(`${REWRITTEN}\n`)});`,
    `}, 40);`,
  ].join("\n");
}

/**
 * A parent that starts a tool through the driver's own helper.
 *
 * The parent deliberately does not spawn anything itself. An earlier form of
 * this test wrote its own `spawn` with its own `detached: true` and called
 * `watchChild` by hand, so the two lines in the shipped driver that create the
 * process group and record the tool were never under test: either could be
 * deleted with the whole suite green. The parent now calls `runTool`, and it
 * learns the tool's identifier from the driver's own record, so a driver that
 * stopped recording its tools fails here.
 */
function parentScript(root: string, toolPath: string, endsByItself = false): string {
  return [
    // Everything the parent uses comes from the built package, so the test
    // exercises the shipped code rather than a copy of its behaviour.
    `import { runTool, guardChildren, guardWitnesses, watchedChildren } from ${JSON.stringify(builtLibrary())};`,
    // The order under test. The tools stop first and the sweep runs second,
    // because Node calls the listeners of one event in the order they were
    // added.
    `guardChildren();`,
    `guardWitnesses(${JSON.stringify(root)});`,
    // The tool never ends on its own, so this promise never settles.
    `runTool(process.execPath, [${JSON.stringify(toolPath)}], { cwd: ${JSON.stringify(root)} }).catch(() => {});`,
    // The identifier comes from the driver's record and not from the spawn, so
    // a driver that records nothing reports nothing here.
    `setTimeout(() => {`,
    `  console.log("tool " + (watchedChildren()[0] ?? "none"));`,
    `}, 300);`,
    // A parent that ends by itself exercises the exit hook rather than a
    // signal handler. An uncaught exception and a call that ends the process
    // both arrive there, and neither raises a signal.
    endsByItself ? `setTimeout(() => process.exit(0), 700);` : `setInterval(() => {}, 1000);`,
  ].join("\n");
}

/** Every process that a test started, so nothing survives the test either. */
const started: number[] = [];

afterEach(() => {
  for (const pid of started) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process has already ended.
    }
  }
  started.length = 0;
});

/** One run: a parent, its tool, and the further process the tool started. */
interface Run {
  readonly root: string;
  readonly parent: number;
  readonly tool: number;
  readonly further: number;
}

/** Starts a run and waits until its tool is writing the prover input. */
async function startRun(endsByItself = false): Promise<Run> {
  const root = repositoryWithWitnesses();
  const toolPath = join(root, "tool.mjs");
  const parentPath = join(root, "parent.ts");
  writeFileSync(toolPath, toolScript(root));
  writeFileSync(parentPath, parentScript(root, toolPath, endsByItself));

  const child = spawn(process.execPath, ["--experimental-strip-types", parentPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let complaint = "";
  child.stderr.on("data", (chunk: Buffer) => {
    complaint += chunk.toString();
  });
  const tool = await new Promise<number>((resolve, reject) => {
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const found = /tool (\d+|none)/.exec(seen);
      if (found?.[1] === "none") {
        reject(new Error("the driver started a tool and recorded none"));
      } else if (found?.[1] !== undefined) {
        resolve(Number.parseInt(found[1], 10));
      }
    });
    child.on("error", reject);
    child.on("exit", () => {
      reject(new Error(`the parent ended before it started a tool: ${complaint}`));
    });
  });
  if (child.pid === undefined) {
    throw new Error("the parent has no identifier");
  }
  started.push(child.pid, tool);

  // The tool is running and writing, which is the state a real run holds for
  // minutes. Every assertion below rests on that, so it is established here
  // rather than assumed.
  const marker = join(root, "tool.started");
  expect(await until(() => existsSync(marker)), "the tool never started").toBe(true);
  expect(
    await until(() => readFileSync(join(root, PROVER_INPUT), "utf8").includes(REWRITTEN)),
    "the tool never wrote the prover input",
  ).toBe(true);

  return {
    root,
    parent: child.pid,
    tool,
    further: Number.parseInt(readFileSync(marker, "utf8"), 10),
  };
}

describe("a signal that reaches the parent alone", () => {
  it("ends the parent, rather than leaving it running with its tools stopped", async () => {
    // A raise ends a process only when no listener remains for that signal, so
    // a handler that stayed registered would swallow it and leave the process
    // running. That is a defect this test found in the first form of the fix.
    const run = await startRun();
    process.kill(run.parent, "SIGTERM");
    expect(await until(() => !alive(run.parent))).toBe(true);
  }, 60_000);

  it("stops the tool, so nothing writes the salts back after the sweep", async () => {
    const run = await startRun();
    process.kill(run.parent, "SIGTERM");

    expect(await until(() => !alive(run.parent))).toBe(true);
    expect(await until(() => !alive(run.tool)), "the tool outlived its parent").toBe(true);

    // The files must be gone and must stay gone. A surviving tool writes them
    // back within its interval, so this wait is far longer than that interval.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(witnessesOnDisk(run.root), "the salts came back after the sweep").toEqual([]);
  }, 60_000);

  it("stops the further process that the tool started", async () => {
    // A tool leads a process group, so one signal reaches the work it started.
    // A signal aimed at the tool alone would leave this one running.
    const run = await startRun();
    expect(alive(run.further)).toBe(true);
    process.kill(run.parent, "SIGTERM");
    expect(await until(() => !alive(run.further))).toBe(true);
  }, 60_000);
});

describe("a parent that ends without a signal", () => {
  it("stops its tools on the way out", async () => {
    // An exit reaches the exit hook and raises no signal, so a guard that
    // installed handlers for the signals alone would leave every tool of the
    // run behind. That covers an uncaught exception and a call that ends the
    // process, neither of which a test can arrange through a signal.
    const run = await startRun(true);
    expect(await until(() => !alive(run.parent))).toBe(true);
    expect(await until(() => !alive(run.tool)), "the tool outlived a parent that ended").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(witnessesOnDisk(run.root)).toEqual([]);
  }, 60_000);
});

describe("the record of the running tools", () => {
  it("holds nothing when no run is open", () => {
    expect(watchedChildren()).toEqual([]);
  });

  it("forgets a tool that ran to completion", async () => {
    // A record that only grows keeps the identifier of a tool that ended, and
    // the stop signals a whole process group with a signal nothing can catch.
    // The operating system is free to give that identifier to something else,
    // so a record that never forgets points an uncatchable kill at a stranger.
    const root = repositoryWithWitnesses();
    await runTool(process.execPath, ["-e", "process.exit(0)"], { cwd: root });
    expect(watchedChildren(), "the run kept a tool that had ended").toEqual([]);
  });

  it("forgets a tool that failed", async () => {
    const root = repositoryWithWitnesses();
    await runTool(process.execPath, ["-e", "process.exit(3)"], { cwd: root }).catch(
      () => undefined,
    );
    expect(watchedChildren()).toEqual([]);
  });

  it("forgets a tool that could not start at all", async () => {
    const root = repositoryWithWitnesses();
    await runTool("a-command-that-does-not-exist", [], { cwd: root }).catch(() => undefined);
    expect(watchedChildren()).toEqual([]);
  });
});

describe("the signal that a stop sends", () => {
  it("goes to no tool that the runtime has already reaped", async () => {
    // The runtime documents the hazard: a signal to a child that has exited
    // reaches whatever holds that identifier now. The record is asked whether
    // the tool is still ours before anything is signalled.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: "ignore",
    });
    watchChild(child);
    await new Promise((resolve) => child.on("exit", resolve));

    // The runtime now reports it as ended, so the identifier may name another
    // process. A stop must signal nothing at all here.
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
    const stopped = stopChildrenSync();
    expect(stopped.gone, "a reaped tool was signalled").toEqual([]);
    expect(stopped.stillRunning).toEqual([]);
  });

  it("goes to a tool that is still running", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    watchChild(child);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.exitCode === null && child.signalCode === null).toBe(true);
    const stopped = stopChildrenSync();
    expect([...stopped.gone, ...stopped.stillRunning]).toContain(child.pid);
    await new Promise((resolve) => child.on("exit", resolve));
  });
});

describe("the wait that follows a stop", () => {
  /**
   * A process that this one does not own, alive now and gone soon.
   *
   * A tool of this process cannot be the subject: it becomes a zombie until
   * this process reaps it, and the wait holds the loop that would reap it, so
   * its group never disappears while the wait runs. An orphan is reparented and
   * the operating system reaps it, which is exactly the case the wait exists
   * for: the processes a tool starts in turn.
   */
  async function orphanThatEndsSoon(afterMilliseconds: number): Promise<number> {
    const root = mkdtempSync(join(tmpdir(), "zkpor-orphan-"));
    const helper = join(root, "helper.mjs");
    writeFileSync(
      helper,
      [
        `import { spawn } from "node:child_process";`,
        `const further = spawn(process.execPath,`,
        `  ["-e", "setTimeout(() => process.exit(0), ${String(afterMilliseconds)})"],`,
        `  { detached: true, stdio: "ignore" });`,
        `further.unref();`,
        `console.log(further.pid);`,
        `process.exit(0);`,
      ].join("\n"),
    );
    const child = spawn(process.execPath, [helper], { stdio: ["ignore", "pipe", "ignore"] });
    const pid = await new Promise<number>((resolve, reject) => {
      let seen = "";
      child.stdout.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        const found = /(\d+)/.exec(seen);
        if (found?.[1] !== undefined) {
          resolve(Number.parseInt(found[1], 10));
        }
      });
      child.on("error", reject);
    });
    // The helper is gone, so the process it started is an orphan now.
    await new Promise((resolve) => child.on("exit", resolve));
    return pid;
  }

  it("waits for a group to end, rather than returning at once", async () => {
    // The wrong implementation returns immediately and reports the group still
    // running. The right one waits and reports it gone. The set-up is a group
    // that is alive when the call begins and ends well inside the deadline, so
    // the two differ by the lifetime of that group rather than by a race.
    const pid = await orphanThatEndsSoon(300);
    expect(groupAlive(pid), "the orphan was gone before the wait began").toBe(true);
    const report = waitForGroupsToEnd([pid], 8_000);
    expect(report.gone, "the wait returned before the group ended").toEqual([pid]);
    expect(report.stillRunning).toEqual([]);
  }, 30_000);

  it("gives up at its deadline and says which groups it left", async () => {
    // A deadline that expires quietly leaves a reader believing the tools are
    // gone. The report names them instead.
    const pid = await orphanThatEndsSoon(4_000);
    const report = waitForGroupsToEnd([pid], 100);
    expect(report.stillRunning).toEqual([pid]);
    expect(report.gone).toEqual([]);
    process.kill(-pid, "SIGKILL");
  }, 30_000);

  it("returns at once when there is nothing to wait for", () => {
    expect(waitForGroupsToEnd([], 8_000)).toEqual({ gone: [], stillRunning: [], deadline: 8_000 });
  });
});

/**
 * Records every signal that a body sends, without delivering the real ones.
 *
 * The property here is that no signal is sent, and that cannot be observed
 * through its consequence. A reaped tool's group no longer exists, so a signal
 * aimed at it fails and the report is empty whether the guard that refuses to
 * send it is there or not. Watching the call is the only way to tell the two
 * apart.
 *
 * A probe carrying the signal 0 sends nothing and asks whether a group exists,
 * so it is passed through. Anything else is recorded and swallowed.
 */
function watchingSignals<T>(body: () => T): { answer: T; sent: { pid: number; signal: unknown }[] } {
  const sent: { pid: number; signal: unknown }[] = [];
  const real = process.kill.bind(process);
  process.kill = (pid: number, signal?: string | number): true => {
    if (signal === 0) {
      return real(pid, signal);
    }
    sent.push({ pid, signal });
    return true;
  };
  try {
    return { answer: body(), sent };
  } finally {
    process.kill = real;
  }
}

describe("the tool that a stop refuses to signal", () => {
  it("sends nothing at all for a tool the runtime has already reaped", async () => {
    // The runtime documents that a signal to a child which has exited reaches
    // whatever holds that identifier now. An uncatchable signal aimed at a
    // whole group would then end a group of processes belonging to somebody
    // else on this machine.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: "ignore",
    });
    watchChild(child);
    await new Promise((resolve) => child.on("exit", resolve));

    const watched = watchingSignals(() => stopChildrenSync());
    expect(watched.sent, "a reaped tool was signalled").toEqual([]);
    expect(watched.answer.gone).toEqual([]);
    expect(watched.answer.stillRunning).toEqual([]);
  });

  it("does send for a tool that is still running, so the refusal is not blanket", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    watchChild(child);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const watched = watchingSignals(() => stopChildrenSync());
    expect(watched.sent.map((each) => each.signal)).toEqual(["SIGKILL"]);
    // The group of a running tool is signalled through its leader, negated.
    expect(watched.sent[0]?.pid).toBe(-(child.pid ?? 0));
    // The signal was swallowed, so the tool is still there and this ends it.
    process.kill(-(child.pid ?? 0), "SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
  });
});

describe("the deadline that a stop uses", () => {
  it("is the constant of this module, read back from what the stop reports", () => {
    // The duration cannot be observed, for the reason the constant states. Which
    // value a stop passed is a different question, and this answers it: a call
    // site that stopped passing the constant reports a different number.
    expect(stopChildrenSync().deadline).toBe(STOP_DEADLINE);
    expect(stopChildrenSync(17).deadline).toBe(17);
  });

  it("is a real wait, stated independently of the constant itself", () => {
    // Reading the constant back cannot catch the constant becoming zero,
    // because both sides of that comparison move together. This states the
    // value on its own: it covers the delivery of a signal that cannot be
    // caught, so it is short, and it is not nothing.
    expect(STOP_DEADLINE).toBeGreaterThanOrEqual(50);
    expect(STOP_DEADLINE).toBeLessThanOrEqual(1_000);
  });
});
