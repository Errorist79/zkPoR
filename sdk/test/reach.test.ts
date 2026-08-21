/**
 * What every module of this package may reach.
 *
 * This package reads the customer file and it derives every salt from the
 * master secret. Nothing it holds may leave the machine except through the one
 * channel that the system needs.
 *
 * That channel is the Stellar library. The client reads the registry through
 * it, and it submits an attestation through it. The rule that the property
 * implies is therefore not that no module names the network. That sentence is
 * false of this package, and a check that made it would be relaxed the first
 * time somebody ran it. The rule is that a declared dependency is the only way
 * out that a module may name, and that no module reaches a network of its own.
 *
 * The set is every module of this package. An earlier version of this check
 * read the modules that a proving run loads, walked from the driver through the
 * local imports. That set came from the point where the instrument began and
 * not from the property, so it left every module outside a run unread. The
 * registry client is one of those, and a plain beacon inside it passed.
 *
 * The rule is written as the specifiers that are allowed, and not as the ones
 * that are refused. A module names a local module, a declared dependency, or
 * one of the built-in modules that this package uses. A list of network modules
 * to refuse would need a new entry whenever the runtime gains one, and it would
 * be one entry behind on the day that mattered.
 *
 * The forms come from the parser of the language and not from a set of
 * patterns, which matters more than it sounds. A reader built from patterns
 * held three forms and needed a double quote on each side of a specifier, so
 * one character on each side defeated the whole file, and nothing in this
 * repository enforces a quote. The parser holds every form the language has,
 * whatever the quote, and it holds the form the language gains next. A
 * specifier that is not a literal names a module that no reader of a source can
 * follow, and this refuses that rather than skipping it.
 *
 * A name reaches past an import as well. `process.getBuiltinModule` hands over
 * a built-in module with nothing imported, and `fetch` opens a connection with
 * no module named at all. Both are read by the second rule below, which names
 * the members of those globals that this package uses.
 *
 * Two things this cannot see. Code that the source does not carry, which means
 * a string that the runtime evaluates. And a connection that a dependency opens
 * inside itself. The backstop for both is that this package declares its
 * dependencies and that the agreement job builds from them.
 *
 * A run of the prover holds more than the rest of this package holds, so it
 * carries a stricter rule than this one. That rule allows no dependency at all,
 * and it is checked where the driver is checked.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord } from "../src/guards.js";
import {
  BUILT_INS,
  freeGlobalsOf,
  globalUsesOf,
  namedModulesOf,
  sourceFiles,
  sourceOf,
} from "./sources.js";

/** The dependencies that this package declares, from its own manifest. */
function declaredDependencies(): string[] {
  const text = readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("the manifest of this package is not an object");
  }
  const dependencies = parsed["dependencies"];
  if (!isRecord(dependencies)) {
    throw new Error("the manifest of this package declares no dependencies");
  }
  return Object.keys(dependencies);
}

/**
 * The built-in modules that this package may use, and why each one is here.
 *
 * The allowance itself lives with the readings, because two rules take it from
 * one place. That makes it one line that disables both, and a loud failure has
 * a natural repair: add the entry that stops the failure. That single edit
 * turns "no module reaches a network of its own" into "any module may", at both
 * scopes at once.
 *
 * So the entries are stated again here, each with the reason it is allowed, and
 * the case below fails while the two lists disagree. A widening then costs two
 * edits and a written reason, and it reaches a reviewer as a decision about
 * what this package may reach rather than as a one-line repair of a test.
 *
 * This stops an accident and not a determined change, and it is not meant to
 * stop one. The reason is for a reader; nothing here can judge whether it is a
 * good one.
 */
const PERMITTED: readonly { module: string; why: string }[] = [
  { module: "node:child_process", why: "starts the pinned tools of a proving run" },
  { module: "node:fs", why: "reads and removes the files of a run without waiting" },
  { module: "node:fs/promises", why: "reads and writes the files of a run" },
  { module: "node:path", why: "builds the paths of the repository" },
  { module: "node:util", why: "gives the version check a promise to await" },
];

/**
 * The globals that this package may name, what it may take from each, and why.
 *
 * Two rules read this one table, and both are inversions rather than lists of
 * things to refuse.
 *
 * The first asks which names a module uses that no import introduces and no
 * declaration of its own binds, and it passes the intrinsics of the language,
 * which open nothing. Everything else is a global of the runtime and must be a
 * name here. An earlier version watched three names and called that the rule,
 * so `WebSocket` opened a connection beside them in plain sight. A name is
 * refused now because it is absent here, which is also true of the global the
 * runtime adds next.
 *
 * The second asks what a module takes from one of these names. `process` hands
 * over a built-in module through `getBuiltinModule`, so the members are named
 * and every other member fails.
 *
 * Each member carries its own reason, and that is where the cost of a widening
 * belongs. A reason for the global alone would leave `getBuiltinModule` one
 * line away from allowed, and a loud failure invites exactly that line. The
 * list of modules a few lines above is stated twice for the same purpose,
 * because two rules read it from a third file; this table has one reader, so a
 * second copy would check itself rather than tell a reviewer anything.
 *
 * `bare` says whether the name may appear other than as an allowed member. It
 * is false for the two that reach something: an alias of `process` reaches
 * `getBuiltinModule`, and an alias of `globalThis` reaches everything. It is
 * true for the two that reach nothing, where the name appears in a type or
 * under `new`.
 *
 * `globalThis` is an intrinsic of the language, so the first rule passes it.
 * The second rule holds it, with no member allowed at all, because it is the
 * other spelling of every global here.
 *
 * This table is the one place these names are stated. A widening costs an entry
 * and a written reason, and the reason is for a reader; nothing here can judge
 * whether it is a good one.
 */
const PERMITTED_GLOBALS: readonly {
  name: string;
  members: readonly { member: string; why: string }[];
  bare: boolean;
  why: string;
}[] = [
  {
    name: "process",
    members: [
      { member: "argv", why: "reads the command line of this process" },
      { member: "cwd", why: "resolves a path the operator gave against the working directory" },
      { member: "env", why: "reads the configuration of the run and the master secret" },
      { member: "exit", why: "ends the command line with the code that names the outcome" },
      { member: "kill", why: "stops the process group of a tool that a run started" },
      { member: "on", why: "installs the guards that sweep and stop on the way out" },
      { member: "pid", why: "writes the owner into the run lock" },
      { member: "removeListener", why: "removes those guards when the run ends" },
      { member: "stderr", why: "writes the progress of a run" },
      { member: "stdout", why: "writes the answer of a command" },
    ],
    bare: false,
    why: "reads the command line and the environment, and signals the tools of a run",
  },
  {
    name: "Buffer",
    members: [
      { member: "alloc", why: "builds the fixed width bytes of a field element" },
      { member: "from", why: "reads bytes that a tool or the registry returned" },
    ],
    bare: true,
    why: "holds the bytes of a proof and of a public input string",
  },
  {
    name: "TextEncoder",
    members: [],
    bare: true,
    why: "turns an identifier into the bytes that the hash takes",
  },
  {
    name: "globalThis",
    members: [],
    bare: false,
    why: "names every other global, so this package may not name it at all",
  },
];

/** The names that the reading of a use watches. */

/**
 * What this package may take from the file system, and which module may take
 * each one.
 *
 * The generator holds the generation gate, and it is the one writer of
 * per-customer files. That rule is prose in the documents, and this table is
 * what keeps it true: a module of this package that could open a customer file
 * and write to it would make a second writer, whatever the prose says.
 *
 * So the entries that change a file are named one by one, with the module that
 * may take each. Nothing here writes the content of a file the caller names.
 * `writeSync` belongs to the run lock and to nothing else, and the lock holds a
 * process identifier rather than anything of a customer.
 */
const FILE_SYSTEM: readonly { entry: string; modules: readonly string[]; why: string }[] = [
  { entry: "readFile", modules: [], why: "reads a file the caller names" },
  { entry: "readFileSync", modules: [], why: "reads a file the caller names" },
  { entry: "readdirSync", modules: ["witnesses.ts"], why: "lists what the sweep must remove" },
  { entry: "existsSync", modules: ["witnesses.ts"], why: "asks whether the sweep has work" },
  { entry: "stat", modules: ["secret.ts"], why: "reads the mode of the secret file" },
  {
    entry: "copyFile",
    modules: ["proving.ts"],
    why: "puts the prover input of one batch where the prover reads it",
  },
  { entry: "mkdir", modules: ["proving.ts"], why: "makes the output directory of a batch" },
  { entry: "rm", modules: ["proving.ts", "witnesses.ts"], why: "removes what a run leaves" },
  { entry: "rmSync", modules: ["witnesses.ts"], why: "removes what a run leaves, on the way out" },
  { entry: "unlinkSync", modules: ["runlock.ts"], why: "gives the lock back" },
  { entry: "openSync", modules: ["runlock.ts"], why: "takes the lock" },
  { entry: "closeSync", modules: ["runlock.ts"], why: "closes the lock file" },
  {
    entry: "writeSync",
    modules: ["runlock.ts"],
    why: "writes the process identifier into the lock, and no other content anywhere",
  },
];

/** The entries that put content into a file that a caller names. */
const WRITERS = [
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "createWriteStream",
  "open",
] as const;

const WATCHED = PERMITTED_GLOBALS.map((each) => each.name);

/**
 * How long the reading of the globals may take, in milliseconds.
 *
 * That reading resolves every name, so it compiles this package and the library
 * it is entitled to. Every other case here reads text and finishes in
 * milliseconds. The default of the runner is five seconds, which this reading
 * fits on a fast machine and does not fit on a slower one, so the case would
 * pass and fail on the same source and somebody would eventually delete it. The
 * value is generous on purpose: it exists to make a slow machine finish, not to
 * measure anything.
 */
const READING_DEADLINE = 120_000;

describe("what every module of this package may reach", () => {
  it("allows the built-in modules that carry a reason, and no others", () => {
    expect([...BUILT_INS].sort()).toEqual(PERMITTED.map((each) => each.module).sort());
    for (const each of PERMITTED) {
      expect(each.why, `${each.module} carries no reason`).not.toBe("");
    }
  });

  it("reads every module, and the client of the registry is one of them", () => {
    const found = sourceFiles();
    expect(found.length).toBeGreaterThanOrEqual(20);
    // The module that talks to the registry, and the module a customer runs.
    // A set that held the driver alone is the set this check replaced.
    expect(found).toContain("registry.ts");
    expect(found).toContain("cli.ts");
  });

  it("names a local module, a declared dependency, or a built-in, and nothing else", () => {
    const allowed = new Set([...declaredDependencies(), ...BUILT_INS]);
    let counted = 0;
    for (const name of sourceFiles()) {
      for (const named of namedModulesOf(name)) {
        counted += 1;
        // A specifier that is not a literal names a module that no reader of
        // the source can follow, so it is refused rather than skipped.
        if (named.specifier === undefined) {
          throw new Error(`${name} names a module with a value rather than with a literal`);
        }
        if (named.specifier.startsWith(".")) {
          continue;
        }
        expect(allowed.has(named.specifier), `${name} names ${named.specifier}`).toBe(true);
      }
    }
    // A read that found no module at all would pass the loop above without
    // looking at anything.
    expect(counted, "the read found almost no import, so it read almost nothing").toBeGreaterThan(
      100,
    );
  });


  it("takes from the file system only what the table names, in the module it names", () => {
    let counted = 0;
    for (const name of sourceFiles()) {
      for (const named of namedModulesOf(name)) {
        if (named.specifier !== "node:fs" && named.specifier !== "node:fs/promises") {
          continue;
        }
        for (const entry of named.names) {
          counted += 1;
          const allowed = FILE_SYSTEM.find((each) => each.entry === entry);
          expect(allowed !== undefined, `${name} takes ${entry} from ${named.specifier}`).toBe(
            true,
          );
          if (allowed !== undefined && allowed.modules.length > 0) {
            expect(
              allowed.modules.includes(name),
              `${name} takes ${entry}, which belongs to ${allowed.modules.join(" and ")}`,
            ).toBe(true);
          }
        }
      }
    }
    // A read that found no entry would pass the loop without looking at
    // anything.
    expect(counted).toBeGreaterThan(5);
  }, READING_DEADLINE);

  it("names no entry that writes the content of a file, so the generator stays the one writer", () => {
    for (const name of sourceFiles()) {
      for (const named of namedModulesOf(name)) {
        if (named.specifier !== "node:fs" && named.specifier !== "node:fs/promises") {
          continue;
        }
        for (const entry of named.names) {
          expect(
            WRITERS.some((each) => each === entry),
            `${name} takes ${entry}, which writes the content of a file that a caller names`,
          ).toBe(false);
        }
      }
    }
  }, READING_DEADLINE);

  it("says in its answer that the package chose the registry", () => {
    // The asset page names a registry too, and it finds that one by asking
    // which generation holds the asset. The two answers coincide today and
    // diverge for a package of an earlier generation, so each says who chose.
    const source = sourceOf("inclusion.ts");
    expect(source).toContain("The package names the registry");
  });

  it("keeps the inclusion check out of the asset resolution", () => {
    // A customer package names its own registry, and the check resolves from
    // that name through the trusted file. If the asset resolution reached this
    // module, a package of one generation and a resolution landing on another
    // would disagree, and the exit codes of the check would stop meaning what
    // this package publishes.
    const source = sourceOf("inclusion.ts");
    expect(source).not.toContain("locateAsset");
    expect(source).toContain("findGeneration");
  });

  it("names no global of the runtime that this table does not carry", () => {
    const resolved: string[] = [];
    for (const name of sourceFiles()) {
      for (const global of freeGlobalsOf(name)) {
        resolved.push(global);
        expect(WATCHED.includes(global), `${name} names the global ${global}`).toBe(true);
      }
    }
    // A read that resolved nothing would pass the loop above without looking at
    // anything, and a read that resolved the intrinsics of the language as
    // globals of the runtime would fail on the first module. Naming the one
    // that every module of this package uses states which of the two it did.
    expect(resolved, "the read resolved no global of the runtime").toContain("process");
    expect(resolved.length).toBeGreaterThan(5);
  }, READING_DEADLINE);

  it("takes from those globals what the table allows, and nothing else", () => {
    let counted = 0;
    for (const name of sourceFiles()) {
      for (const use of globalUsesOf(name, WATCHED)) {
        counted += 1;
        const allowed = PERMITTED_GLOBALS.find((each) => each.name === use.global);
        const permitted =
          allowed !== undefined &&
          (use.member === undefined
            ? allowed.bare
            : allowed.members.some((each) => each.member === use.member));
        const how = use.member === undefined ? "under no member" : `.${use.member}`;
        expect(permitted, `${name} uses ${use.global} ${how}`).toBe(true);
      }
    }
    expect(counted, "the read found no use of any global").toBeGreaterThan(20);
  });

  it("carries a reason for every global and for every member it allows", () => {
    // The member is where the cost of a widening has to land. A reason for the
    // global alone leaves `getBuiltinModule` one line away from allowed, and
    // that one line is what a loud failure invites somebody to write.
    for (const each of PERMITTED_GLOBALS) {
      expect(each.why, `${each.name} carries no reason`).not.toBe("");
      for (const member of each.members) {
        expect(member.why, `${each.name}.${member.member} carries no reason`).not.toBe("");
      }
    }
  });
});
