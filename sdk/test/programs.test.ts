/**
 * Which programs this package starts, observed rather than read.
 *
 * A guard over source text carried this property alone until now. It walked the
 * modules a proving run loads and it refused a spelling, and ordinary code
 * defeated it four times: a call beside an existing one, a call reached through
 * a binding, a second use of a helper that was promisified once and never named
 * again, and a member taken from a module namespace, which no check on the name
 * `spawn` sees because the name follows a dot. Each defeat was answered by a
 * wider pattern, which is a losing shape: the guard grew one rule for each
 * attack and still saw only the spellings somebody thought of.
 *
 * What is observable is a program that actually starts. The module that
 * starts one can be replaced for the duration of a test, so every start is
 * recorded whatever spelling reached it, through a binding, through a
 * promisified helper, through a namespace, or through a name this file has
 * never heard of.
 *
 * A replaced module also answers as the tools answer, so a machine with neither
 * tool runs the whole pipeline. Four entry points are driven here: the tool
 * runner, the reader of the pins, the version check, and one whole proving run.
 * The last one is the point. Before it, the body of a run was the region that
 * only a walk over the source covered, and a program started anywhere in it
 * reached no instrument at all.
 *
 * The replaced tool writes the files that the next step of a run reads. That is
 * what makes a whole run possible: a replacement that wrote nothing stopped the
 * run at its first missing file, and the observation then covered the first
 * tool and nothing after it. The written files decide nothing about the
 * property under test. The list of programs is what the property reads, and the
 * files only keep the run alive long enough for that list to be complete.
 *
 * What this does not observe, stated so a reader does not assume otherwise: a
 * program started on a path that no case here executes. A signal handler of a
 * guard is one, a branch that no run here takes is another, and every module
 * that no run here enters is the general form of both. The second group of
 * cases in this file reads the source of every module of this package for those,
 * and it states its own limits where it is written.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_INPUT_BYTES } from "../src/constants.js";
import type { Shape } from "../src/proving.js";
import { namedModulesOf, sourceFiles, sourceOf, withoutComments } from "./sources.js";

/** What a test run observed, and what the replaced tools write while it runs. */
const programs = vi.hoisted(() => {
  /** Every program started while a case runs, in order. */
  const started: string[] = [];
  /** The files that a replaced tool writes, so the run continues past it. */
  const writes: { path: string; bytes: Uint8Array }[] = [];
  /**
   * The version that the replaced tools report.
   *
   * The fixture repository pins this value, so the check against the pins
   * passes on a machine that has neither tool.
   */
  const version = "0.0.0";
  return { started, writes, version };
});

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { mkdirSync: makeDirectory, writeFileSync: writeFile } = await import("node:fs");
  const { dirname, isAbsolute } = await import("node:path");
  return {
    ...real,
    /** Records the program, writes what it writes, and starts a harmless one. */
    spawn: (command: unknown, args: unknown, options: unknown) => {
      programs.started.push(String(command));
      void args;
      for (const each of programs.writes) {
        // The path is the one the fixture built, and it is absolute. A relative
        // path would write into the working directory of whoever runs the
        // tests, which is the repository itself, so this stops rather than
        // leaves a file behind for somebody to find later.
        if (!isAbsolute(each.path)) {
          throw new Error(`the replaced tool would write ${each.path} outside the fixture`);
        }
        makeDirectory(dirname(each.path), { recursive: true });
        writeFile(each.path, each.bytes);
      }
      return real.spawn(process.execPath, ["-e", ""], Object(options));
    },
    /**
     * Records the program and answers as the tool would.
     *
     * The version check promisifies this function once, at the moment the
     * module loads, and never names it again. A recorder here therefore sees
     * every later use of the promisified helper, which is the case a pattern
     * over the source cannot see at all.
     *
     * The promisified form is provided too. The runtime attaches one to its
     * own function, and a replacement without it resolves to the output alone
     * rather than to the pair the caller destructures, which fails the caller
     * for a reason that has nothing to do with the property under test.
     */
    execFile: Object.assign(
      (
        command: unknown,
        args: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        programs.started.push(String(command));
        void args;
        callback(null, `${String(command)} version ${programs.version}`, "");
      },
      {
        [promisify.custom]: async (command: unknown): Promise<{ stdout: string; stderr: string }> => {
          programs.started.push(String(command));
          return await Promise.resolve({
            stdout: `${String(command)} version ${programs.version}`,
            stderr: "",
          });
        },
      },
    ),
  };
});

/** The repository that a run reads, and the call that removes it. */
interface Fixture {
  readonly repository: string;
  readonly shape: Shape;
  remove(): void;
}

/**
 * A repository outside the working tree, holding the files a run reads.
 *
 * A run takes a lock, sweeps, and removes build directories. It must do all of
 * that to a copy and never to the working tree of the machine that runs the
 * tests, so this builds one and the caller removes it.
 *
 * The manifest and the shape are the real ones of this repository, because a
 * run compares them against each other and against the pins. The two tool
 * versions are the one the replaced module reports, because the machine has
 * neither tool.
 */
async function fixtureRepository(): Promise<Fixture> {
  const { parseShape } = await import("../src/proving.js");
  const source = join(import.meta.dirname, "..", "..");
  const repository = mkdtempSync(join(tmpdir(), "zkpor-programs-"));
  const recursion = join(repository, "circuits", "recursion");
  const inner = join(recursion, "inner");
  const aggregator = join(recursion, "agg");
  const directories = [
    join(repository, "scripts"),
    inner,
    aggregator,
    join(repository, "tools", "recursion-gen"),
  ];
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
  }
  const versions = readFileSync(join(source, "scripts", "versions.env"), "utf8");
  writeFileSync(
    join(repository, "scripts", "versions.env"),
    `${versions}\nNARGO_VERSION="${programs.version}"\nBB_VERSION="${programs.version}"\n`,
  );
  writeFileSync(
    join(recursion, "manifest.json"),
    readFileSync(join(source, "circuits", "recursion", "manifest.json"), "utf8"),
  );
  const shapeText = readFileSync(join(source, "circuits", "recursion", "params.toml"), "utf8");
  writeFileSync(join(recursion, "params.toml"), shapeText);
  const shape = parseShape(shapeText);

  // What the tools write. The generator writes one prover input for each batch,
  // and the last prover run writes the proof and the public input string that
  // the driver reads back. Every start writes all of them, because a run
  // removes the build directory of the aggregator after the earlier steps and
  // the last start has to put those two files back.
  for (let batch = 0; batch < shape.numBatchesK; batch += 1) {
    programs.writes.push({ path: join(inner, `Prover_${batch}.toml`), bytes: new Uint8Array(0) });
  }
  programs.writes.push({ path: join(aggregator, "target", "proof"), bytes: new Uint8Array(1) });
  programs.writes.push({
    path: join(aggregator, "target", "public_inputs"),
    bytes: new Uint8Array(PUBLIC_INPUT_BYTES),
  });

  return {
    repository,
    shape,
    remove(): void {
      rmSync(repository, { recursive: true, force: true });
    },
  };
}

/** Each case starts from an empty record and from tools that write nothing. */
beforeEach(() => {
  programs.started.length = 0;
  programs.writes.length = 0;
});

describe("the programs a run starts", () => {
  it("records one, so the cases below are not vacuous", async () => {
    const { runTool } = await import("../src/proving.js");
    await runTool("cargo", ["--version"], { cwd: process.cwd() });
    expect(programs.started).toEqual(["cargo"]);
  });

  it("starts exactly the tool it was asked for, and nothing beside it", async () => {
    const { runTool } = await import("../src/proving.js");
    await runTool("nargo", ["compile"], { cwd: process.cwd() });
    // One start, and it is the tool named. A second program started here, by
    // any spelling, appears in this list.
    expect(programs.started).toEqual(["nargo"]);
  });

  it("reads the pins and starts no program", async () => {
    // Reading a file needs no tool, so this entry point is drivable on any
    // machine and it is observed here rather than left to a walk over source.
    const { readPins } = await import("../src/versions.js");
    const fixture = await fixtureRepository();
    try {
      const pins = await readPins(join(fixture.repository, "scripts", "versions.env"));
      // The pins were read, so the empty list below is a run that started
      // nothing rather than a call that did nothing.
      expect(pins.nargoVersion).toBe(programs.version);
    } finally {
      fixture.remove();
    }
    expect(programs.started).toEqual([]);
  });

  it("checks the two pinned tools and starts no third program", async () => {
    const { requirePinnedTools } = await import("../src/versions.js");
    // The pins the check compares against. The replaced module answers with a
    // version built from the name, so the comparison is what decides, and the
    // list of programs is what this case reads.
    await requirePinnedTools({
      nargoVersion: programs.version,
      bbVersion: programs.version,
      proofScheme: "ultra_honk",
      terminalOracleHash: "keccak",
      innerOracleHash: "poseidon2",
      stellarJsSdkVersion: "16.2.0",
    }).catch(() => undefined);
    expect(programs.started).toEqual(["nargo", "bb"]);
  });

  it("starts the pinned tools, and nothing else, through a whole run", async () => {
    const { prove } = await import("../src/proving.js");
    const fixture = await fixtureRepository();
    try {
      const proof = await prove({
        repository: fixture.repository,
        contextFile: join(fixture.repository, "context.toml"),
        customersFile: join(fixture.repository, "customers.csv"),
        masterSecret: 1n,
      });
      // The run reached its last step and read what the last tool wrote.
      // Without this, a run that stopped at its first tool would satisfy a
      // list that named that tool alone.
      expect(proof.publicInputs).toHaveLength(PUBLIC_INPUT_BYTES);
    } finally {
      fixture.remove();
    }

    // Every start of a whole run, in order. A program started anywhere in this
    // body, by any spelling, appears in this list and moves everything after
    // it.
    const eachBatch = Array.from({ length: fixture.shape.numBatchesK }, () => [
      // one batch: the witness, then the proof
      "nargo",
      "bb",
    ]).flat();
    expect(programs.started).toEqual([
      // the check against the pins
      "nargo",
      "bb",
      // the witness of each batch
      "cargo",
      // the inner circuit
      "nargo",
      ...eachBatch,
      // the verification key of the inner circuit
      "bb",
      // the aggregation input
      "cargo",
      // the aggregator, its witness, and the terminal proof
      "nargo",
      "nargo",
      "bb",
    ]);
  });
});

/**
 * The same property, read from the source of every module of this package.
 *
 * The cases above observe a driven run, and a driven run reaches the code that
 * it executes. It reaches no module that no case enters, and `cli.ts` is one of
 * those. That module is the shipped entry point of this package, so it is the
 * most exposed module in it, and a program started while it loads reaches no
 * recorder here.
 *
 * The set below is therefore every module of this package, and not the modules
 * that a proving run loads. A set drawn from the point where an instrument
 * begins is a set that the instrument chose. The property names every module:
 * no program starts anywhere except the two places that are meant to start one.
 *
 * This is the weaker of the two instruments, and it is weaker in a way worth
 * stating. It reads text. For the code that a driven run executes, the list of
 * programs above is the evidence, and this only states the shape. For every
 * other module, this is the whole of the evidence.
 *
 * One rule carries most of it, and it is written as the form that is allowed
 * and not as the forms that are refused. A module may name the way to start a
 * program in one form, which is a static import of names. A namespace holds
 * every member behind a dot, where a check on a name reaches none of them, and
 * several spellings produce a namespace: `import * as`, `require`, and
 * `await import` among them. A rule that refused the spellings somebody listed
 * would leave the next one.
 *
 * The forms come from the parser of the language rather than from a set of
 * patterns. A reader built from patterns needed a double quote on each side of
 * the module name, so a namespace import written in single quotes reached the
 * whole capability with nothing here objecting. The parser reports the form of
 * every import, whatever the quote, so this rule holds the forms that nobody
 * has thought of yet.
 *
 * What stays outside is one thing: code that the source does not carry, which
 * means a string that the runtime evaluates. The backstop is that this package
 * declares its dependencies and the agreement job builds from them.
 */
describe("what every module of this package names", () => {
  /**
   * The surface of the starting module that this package may take, module by
   * module. A module that is absent from this list may not name it at all.
   */
  const SURFACE: readonly { module: string; names: readonly string[] }[] = [
    { module: "children.ts", names: ["ChildProcess"] },
    { module: "proving.ts", names: ["spawn"] },
    { module: "versions.ts", names: ["execFile"] },
  ];

  /** The module that starts a program. */
  const STARTER = "node:child_process";

  /**
   * The ways a program is started, and the two places allowed to start one.
   *
   * Refusing these outright would be wrong and would say something false about
   * this system. A proving run starts programs; that is its whole mechanism.
   * The question is therefore not whether a program may be started but whether
   * an unexpected one may be, so the check is that every way of starting one
   * appears only where a tool or a version check is meant to.
   */
  // Each is matched as a call rather than as a substring. A pattern that
  // matched `exec(` anywhere also matches the regular expression calls this
  // package makes, and a check that fails on correct code gets relaxed rather
  // than fixed.
  const STARTS: readonly { name: string; call: RegExp }[] = [
    { name: "spawnSync", call: /(?<![.\w])spawnSync\s*\(/ },
    { name: "execSync", call: /(?<![.\w])execSync\s*\(/ },
    { name: "execFileSync", call: /(?<![.\w])execFileSync\s*\(/ },
    { name: "fork", call: /(?<![.\w])fork\s*\(/ },
    { name: "exec", call: /(?<![.\w])exec\s*\(/ },
  ];

  it("reaches every module of this package, or it checks nothing", () => {
    const found = sourceFiles();
    expect(found.length).toBeGreaterThanOrEqual(20);
    // The shipped entry point and the driver. A list that held the driver alone
    // would satisfy a count, and it would miss the module a customer runs.
    expect(found).toContain("cli.ts");
    expect(found).toContain("proving.ts");
  });

  it("names the module that starts a program in one form, and in three modules", () => {
    const named: string[] = [];
    for (const name of sourceFiles()) {
      const imports = namedModulesOf(name).filter((each) => each.specifier === STARTER);
      if (imports.length === 0) {
        continue;
      }
      named.push(name);
      const allowed = SURFACE.find((each) => each.module === name);
      if (allowed === undefined) {
        throw new Error(
          `${name} names the way to start a program, and it is not one of the modules that may`,
        );
      }
      for (const each of imports) {
        // A namespace holds every member behind a dot, where a check on a name
        // reaches none of them. The parser reports the form, so every form that
        // produces one is refused, and so is the form the language gains next.
        expect(each.form, `${name} names the module in the form ${each.form}`).toBe("import");
      }
      const taken = imports.flatMap((each) => [...each.names]).sort();
      expect(taken, `${name} takes a name from that module that it does not need`).toEqual(
        [...allowed.names].sort(),
      );
    }
    expect([...named].sort(), "a module that may not name it names it").toEqual(
      SURFACE.map((each) => each.module).sort(),
    );
  });

  it("starts a program in the two places that are meant to, and nowhere else", () => {
    // The capability is the reference rather than the call. The version check
    // never writes `execFile(`, because it promisifies the function and calls
    // the result, so a check that read call syntax would report the version
    // check as absent and pass a second one that appeared beside it.
    const namesSpawn: string[] = [];
    const namesExecFile: string[] = [];
    const callsSpawn: string[] = [];
    const mentionsSpawn: string[] = [];
    for (const name of sourceFiles()) {
      const source = withoutComments(sourceOf(name));
      if (/(?<![.\w])spawn(?![\w])/.test(source)) {
        namesSpawn.push(name);
      }
      // Naming the module is not enough. A second call beside the first needs
      // no new import, which is the cheapest way to add a program to a run,
      // so every call site is counted rather than every module.
      for (const found of source.matchAll(/(?<![.\w])spawn\s*\(/g)) {
        callsSpawn.push(`${name}:${String(found.index)}`);
      }
      if (name === "proving.ts") {
        for (const found of source.matchAll(/(?<![.\w])spawn(?![\w])/g)) {
          mentionsSpawn.push(`${name}:${String(found.index)}`);
        }
      }
      if (/(?<![.\w])execFile(?![\w])/.test(source)) {
        namesExecFile.push(name);
      }
      for (const way of STARTS) {
        expect(source, `${name} starts a program with ${way.name}`).not.toMatch(way.call);
      }
    }
    // One tool runner and one version check. A program started anywhere else
    // carries no record, so a run cannot stop it, and it opens whatever
    // connection it likes on behalf of a process that is guarded here.
    expect(namesSpawn, "a module outside the tool runner can start a program").toEqual([
      "proving.ts",
    ]);
    expect(callsSpawn, "a program is started outside the one tool runner").toHaveLength(1);
    expect(callsSpawn[0]).toMatch(/^proving\.ts:/);
    // Counting calls misses a binding, because `const start = spawn` is not a
    // call and `start(...)` names nothing this check knows. Counting the
    // identifier closes that whole class at once rather than one spelling of
    // it: the import and the single call are the only two mentions the driver
    // may carry.
    expect(
      mentionsSpawn,
      "the driver mentions the way to start a program more than the import and its one use",
    ).toHaveLength(2);
    expect(namesExecFile, "a module outside the version check can run one").toEqual([
      "versions.ts",
    ]);
  });
});
