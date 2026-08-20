/**
 * The sweep that removes every salt of a snapshot, and the lock that keeps two
 * runs off one working tree.
 *
 * The prover inputs hold the identifier, the balance, and the salt of every
 * customer. A run that leaves them on disk leaves every salt readable, so these
 * tests state which endings the sweep reaches. The test of a signal starts a
 * real child process and kills it, because a sweep on a signal cannot be shown
 * any other way.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clearWitnesses,
  clearWitnessesSync,
  guardWitnesses,
  witnessPaths,
  witnessesOnDisk,
} from "../src/witnesses.js";
import { RunLockedError, lockPath, takeRunLock } from "../src/runlock.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A repository with one prover input of every kind that a run writes. */
function repositoryWithWitnesses(): string {
  const root = mkdtempSync(join(tmpdir(), "zkpor-witness-"));
  const inner = join(root, "circuits/recursion/inner");
  const aggregator = join(root, "circuits/recursion/agg");
  mkdirSync(join(inner, "target"), { recursive: true });
  mkdirSync(join(inner, "out"), { recursive: true });
  mkdirSync(join(aggregator, "target"), { recursive: true });
  writeFileSync(join(inner, "Prover.toml"), "salt = 1\n");
  writeFileSync(join(inner, "Prover_0.toml"), "salt = 2\n");
  writeFileSync(join(inner, "Prover_11.toml"), "salt = 3\n");
  writeFileSync(join(aggregator, "Prover.toml"), "witness = 4\n");
  writeFileSync(join(inner, "out", "aggwit"), "witness\n");
  return root;
}

describe("the list of files that carry a salt", () => {
  it("names the prover input of every batch that the generator wrote", () => {
    const root = repositoryWithWitnesses();
    const paths = witnessPaths(root);
    expect(paths.some((path) => path.endsWith("Prover_0.toml"))).toBe(true);
    expect(paths.some((path) => path.endsWith("Prover_11.toml"))).toBe(true);
    expect(witnessesOnDisk(root).length).toBeGreaterThanOrEqual(6);
  });

  it("names nothing that does not exist, and fails on no repository", () => {
    const empty = mkdtempSync(join(tmpdir(), "zkpor-empty-"));
    expect(witnessesOnDisk(empty)).toEqual([]);
    expect(() => witnessPaths(empty)).not.toThrow();
  });
});

describe("the sweep", () => {
  it("removes every file of the list, waiting", async () => {
    const root = repositoryWithWitnesses();
    await clearWitnesses(root);
    expect(witnessesOnDisk(root)).toEqual([]);
  });

  it("removes every file of the list, without waiting", () => {
    const root = repositoryWithWitnesses();
    clearWitnessesSync(root);
    expect(witnessesOnDisk(root)).toEqual([]);
  });

  it("leaves a file that carries no salt", async () => {
    const root = repositoryWithWitnesses();
    const keep = join(root, "circuits/recursion/agg/vk");
    writeFileSync(keep, "the committed key\n");
    await clearWitnesses(root);
    expect(existsSync(keep)).toBe(true);
  });
});

/**
 * Runs a guarded child, sends it one signal, and waits for it to end.
 *
 * A signal reaches a process and not a function, so the sweep on a signal
 * cannot be shown inside this process. The child holds the guard and nothing
 * else, and Node runs the source of the module directly.
 */
async function guardedChild(root: string, signal: NodeJS.Signals): Promise<number | null> {
  const script = join(root, "child.ts");
  writeFileSync(
    script,
    [
      `import { guardWitnesses } from ${JSON.stringify(join(HERE, "..", "src", "witnesses.ts"))};`,
      `guardWitnesses(${JSON.stringify(root)});`,
      `process.stdout.write("ready\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, ["--experimental-strip-types", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes("ready")) {
        resolve();
      }
    });
    child.on("error", reject);
    child.on("exit", () => {
      reject(new Error("the child ended before it installed the guard"));
    });
  });
  child.kill(signal);
  return await new Promise((resolve) => {
    child.on("exit", (code, ended) => {
      resolve(ended === null ? code : 0);
    });
  });
}

describe("the ending of a run", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "sweeps when the process receives %s",
    async (signal) => {
      const root = repositoryWithWitnesses();
      expect(witnessesOnDisk(root).length).toBeGreaterThan(0);
      await guardedChild(root, signal);
      expect(witnessesOnDisk(root)).toEqual([]);
    },
    30_000,
  );

  it("registers a listener for each ending, and removes every one", () => {
    const root = mkdtempSync(join(tmpdir(), "zkpor-guard-"));
    const before = {
      exit: process.listenerCount("exit"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGHUP: process.listenerCount("SIGHUP"),
    };
    const remove = guardWitnesses(root);
    expect(process.listenerCount("exit")).toBe(before.exit + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
    expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP + 1);
    remove();
    expect(process.listenerCount("exit")).toBe(before.exit);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
  });

  it("gives the lock back on a signal, so the next run is not blocked", async () => {
    const root = repositoryWithWitnesses();
    mkdirSync(join(root, "circuits/recursion"), { recursive: true });
    const script = join(root, "locked.ts");
    writeFileSync(
      script,
      [
        `import { guardWitnesses } from ${JSON.stringify(join(HERE, "..", "src", "witnesses.ts"))};`,
        `import { takeRunLock } from ${JSON.stringify(join(HERE, "..", "src", "runlock.ts"))};`,
        `const release = takeRunLock(${JSON.stringify(root)});`,
        `guardWitnesses(${JSON.stringify(root)}, release);`,
        `process.stdout.write("ready\\n");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
      let seen = "";
      child.stdout.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        if (seen.includes("ready")) {
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", () => {
        reject(new Error("the child ended before it took the lock"));
      });
    });
    expect(existsSync(lockPath(root))).toBe(true);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("exit", resolve));
    expect(existsSync(lockPath(root))).toBe(false);
    expect(witnessesOnDisk(root)).toEqual([]);
  }, 30_000);
});

describe("the lock on one working tree", () => {
  it("lets one run take it and gives it back", () => {
    const root = mkdtempSync(join(tmpdir(), "zkpor-lock-"));
    mkdirSync(join(root, "circuits/recursion"), { recursive: true });
    const release = takeRunLock(root);
    expect(existsSync(lockPath(root))).toBe(true);
    expect(readFileSync(lockPath(root), "utf8").trim()).toBe(String(process.pid));
    release();
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it("refuses a second run while the first one holds it", () => {
    const root = mkdtempSync(join(tmpdir(), "zkpor-lock-"));
    mkdirSync(join(root, "circuits/recursion"), { recursive: true });
    const release = takeRunLock(root);
    expect(() => takeRunLock(root)).toThrow(RunLockedError);
    release();
  });

  it("takes a lock whose owner no longer runs", () => {
    const root = mkdtempSync(join(tmpdir(), "zkpor-lock-"));
    mkdirSync(join(root, "circuits/recursion"), { recursive: true });
    // A process identifier that no process holds. The value is one that the
    // system cannot assign, so the check finds no owner.
    writeFileSync(lockPath(root), "2147483646\n");
    const release = takeRunLock(root);
    expect(readFileSync(lockPath(root), "utf8").trim()).toBe(String(process.pid));
    release();
  });

  it("releases nothing when another run already owns the file", () => {
    const root = mkdtempSync(join(tmpdir(), "zkpor-lock-"));
    mkdirSync(join(root, "circuits/recursion"), { recursive: true });
    const release = takeRunLock(root);
    // A later run replaced the lock. The release of this run must not remove
    // the lock of the run that follows it.
    writeFileSync(lockPath(root), "2147483646\n");
    release();
    expect(existsSync(lockPath(root))).toBe(true);
  });

  it("uses the same file and the same format as the issuer script", () => {
    const script = readFileSync(join(HERE, "..", "..", "scripts", "attest.sh"), "utf8");
    // A second assignment on a later line satisfies a check that only asks
    // whether the first one is present, and the two tools then hold different
    // locks on one working tree, run together, and sweep the files the other
    // is writing. The file may name the lock once.
    const assignments = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^LOCK=/.test(line));
    expect(assignments).toEqual(['LOCK="$REC/.run.lock"']);
    expect(lockPath("root")).toBe(join("root", "circuits/recursion/.run.lock"));
    // The script writes the identifier of its own process, which is what the
    // reader here parses.
    expect(script).toContain('echo "$$" > "$LOCK"');
  });
});

describe("the issuer script", () => {
  const script = readFileSync(join(HERE, "..", "..", "scripts", "attest.sh"), "utf8");

  it("sweeps on every ending that lets it run something", () => {
    // The exit trap covers a return and a failure. The signal trap covers an
    // interrupt, a termination, and a hang-up, and it ends the run rather than
    // letting bash resume the script.
    expect(script).toContain("trap 'stop_tools; clear_witnesses; release_lock' EXIT");
    expect(script).toContain("trap on_signal INT TERM HUP");
  });

  it("takes the lock before it sweeps, so it never sweeps another run", () => {
    // The three statements that start a run must appear in this order and
    // close together. An earlier form of this compared the first four matching
    // statements in file order, so deleting the sweep at the start let the
    // unrelated sweep near the end of the script slide into its place and the
    // check still passed. The sweep that covers a kill nobody can catch would
    // have gone silently.
    const lines = script.split("\n").map((line) => line.trim());
    const lock = lines.indexOf("take_lock");
    const exitTrap = lines.findIndex((line) =>
      line.startsWith("trap 'stop_tools; clear_witnesses; release_lock' EXIT"),
    );
    const signalTrap = lines.findIndex((line) => line.startsWith("trap on_signal INT TERM HUP"));
    const sweep = lines.indexOf("clear_witnesses", signalTrap);
    expect(lock, "the script takes no lock").toBeGreaterThan(0);
    expect(exitTrap, "the exit trap is missing or in the wrong order").toBeGreaterThan(lock);
    expect(signalTrap).toBeGreaterThan(exitTrap);
    expect(sweep, "the sweep at the start of a run is missing").toBeGreaterThan(signalTrap);
    // Close together, so a sweep from later in the script cannot stand in for
    // the one that runs before this run writes anything.
    expect(sweep - signalTrap).toBeLessThanOrEqual(3);
  });

  it("ends the run on a signal, rather than continuing without its lock", () => {
    // Bash resumes the script after a handler returns. A handler that only
    // swept would release the lock and let the run carry on writing the paths
    // the lock protects.
    // The exit code is part of it. An assertion that stopped at "exit " was
    // satisfied by `exit 0`, so an interrupted run would report success to
    // whatever wraps it.
    expect(script).toContain("on_signal() { stop_tools; clear_witnesses; release_lock; exit 130; }");
    expect(script).toContain("trap on_signal INT TERM HUP");
  });

  it("parses", () => {
    expect(() =>
      execFileSync("bash", ["-n", join(HERE, "..", "..", "scripts", "attest.sh")]),
    ).not.toThrow();
  });
});

describe("the one list of files that carry a salt", () => {
  const script = readFileSync(join(HERE, "..", "..", "scripts", "attest.sh"), "utf8");

  /** The paths that the issuer script sweeps, as its own sweep names them. */
  function pathsOfTheScript(): string[] {
    const body = script.slice(
      script.indexOf("clear_witnesses() {"),
      script.indexOf("}", script.indexOf("clear_witnesses() {")),
    );
    const found = new Set<string>();
    // The script writes `"$INNER"/Prover.toml` as well as `"$INNER/target"`,
    // so the closing quote can sit between the variable and the rest.
    for (const match of body.matchAll(/\$\{?(INNER|AGG|OUT|ATGT)\}?"?(\/[A-Za-z_.*]+)?/g)) {
      const directory = match[1] ?? "";
      const rest = match[2] ?? "";
      // The prover input of each batch is a pattern rather than a path. The
      // test below covers it in both tools.
      if (!rest.includes("*")) {
        found.add(`${directory}${rest}`);
      }
    }
    return [...found].sort();
  }

  it("is the same list in the client library and in the issuer script", () => {
    // The two tools sweep the same working tree. A path that one removes and
    // the other does not is a salt that stays on disk after the tool that
    // forgot it runs. The comment in the library claims one list, and this is
    // what makes the claim true.
    //
    // The library names paths against the repository, and the script names
    // them against its own variables, so the comparison maps one onto the
    // other rather than comparing text.
    const library = witnessPaths("ROOT")
      .map((path) => path.slice("ROOT/".length))
      .filter((path) => !/Prover_\d+\.toml$/.test(path));
    const asTheScriptNamesThem = library
      .map((path) =>
        path
          .replace("circuits/recursion/inner/out", "OUT")
          .replace("circuits/recursion/inner/target", "INNER/target")
          .replace("circuits/recursion/inner", "INNER")
          .replace("circuits/recursion/agg/target", "ATGT")
          .replace("circuits/recursion/agg", "AGG"),
      )
      .sort();
    expect(pathsOfTheScript()).toEqual(asTheScriptNamesThem);
  });

  it("covers the prover input of each batch in both tools", () => {
    // The generator writes one input for each batch, so neither tool may name
    // a fixed count. The library reads the directory and the script uses a
    // pattern.
    expect(script).toContain('"$INNER"/Prover_*.toml');
    const root = repositoryWithWitnesses();
    expect(witnessPaths(root).some((path) => path.endsWith("Prover_11.toml"))).toBe(true);
  });
});

describe("the lock file is never empty", () => {
  it("names its owner from the moment it exists", () => {
    // The creation and the write are one step. Two steps leave a moment where
    // the lock exists and names nobody, and a reader that treats that as a
    // stale lock takes one that another run is in the middle of taking. Both
    // runs then believe they hold it.
    const root = mkdtempSync(join(tmpdir(), "zkpor-lock-"));
    mkdirSync(join(root, "circuits/recursion"), { recursive: true });
    const release = takeRunLock(root);
    expect(readFileSync(lockPath(root), "utf8").trim()).toBe(String(process.pid));
    release();
  });

  it("writes the owner through the handle that created the file", () => {
    // The window is too small to observe from this process, so the rule is
    // stated against the source: no create-then-write pair.
    const source = readFileSync(new URL("../src/runlock.ts", import.meta.url), "utf8");
    const created = source.indexOf('openSync(path, "wx")');
    const wrote = source.indexOf("writeSync(handle,", created);
    const closed = source.indexOf("closeSync(handle)", created);
    expect(created).toBeGreaterThan(0);
    expect(wrote, "the identifier is not written through the handle").toBeGreaterThan(created);
    expect(closed, "the handle closes before the identifier is written").toBeGreaterThan(wrote);
    expect(source).not.toContain("writeFileSync(path,");
  });

  it("uses the same one-step creation as the issuer script", () => {
    // The script writes the identifier in the redirection that creates the
    // file, which is the same shape.
    const script = readFileSync(join(HERE, "..", "..", "scripts", "attest.sh"), "utf8");
    expect(script).toContain('(set -o noclobber; echo "$$" > "$LOCK")');
    // And it re-reads a lock that names nobody rather than calling it stale.
    expect(script).toContain('if [ -z "$owner" ]; then');
  });
});

describe("the tools of the issuer script", () => {
  const script = readFileSync(join(HERE, "..", "..", "scripts", "attest.sh"), "utf8");

  it("stops them on every ending, and before it sweeps", () => {
    // A sweep is worth nothing while a tool that writes the prover inputs is
    // still running. This is the same defect the client library carried this
    // morning, in the path that was not re-examined after the library was
    // fixed.
    expect(script).toContain("stop_tools; clear_witnesses; release_lock");
    // Both traps, not only one.
    const exitTrap = /trap 'stop_tools; clear_witnesses; release_lock' EXIT/.test(script);
    const signalTrap = /on_signal\(\) \{ stop_tools; clear_witnesses/.test(script);
    expect(exitTrap, "the exit trap does not stop the tools").toBe(true);
    expect(signalTrap, "the signal handler does not stop the tools").toBe(true);
  });

  it("uses the shared file that holds them, because the tools live there now", () => {
    // The starting and the stopping moved into a file a test can source, so
    // the properties are driven rather than read. What stays here is the one
    // fact about this script: without the source line it has no tools to stop.
    expect(script).toContain('source "$(dirname "${BASH_SOURCE[0]}")/run_tools.sh"');
  });

  it("starts every tool through the one helper", () => {
    // A tool started any other way is a tool the stop cannot reach, and it also
    // runs in the foreground, which defers every trap until it finishes.
    //
    // The scan splits a line on the separators that start a new command,
    // because an earlier form of it only looked at the beginning of a line and
    // a tool after a semicolon passed it. That is how `rm -rf target out;
    // nargo compile` would have slipped through.
    const commands: string[] = [];
    for (const raw of script.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("#") || line.length === 0) {
        continue;
      }
      for (const piece of line.split(/;|&&|\|\|/)) {
        commands.push(piece.trim());
      }
    }
    const tools = commands.filter((command) => /^(nargo|bb|cargo|env -C)\b/.test(command));
    // Vacuity is covered by the count of helped commands below, which cannot
    // be satisfied by a scan that reached nothing.
    expect(tools.length, "a tool is started without the helper").toBe(0);
    const helped = commands.filter((command) => /^run_tool (nargo|bb|cargo|env -C)\b/.test(command));

    // A count with room in it is what let a tool move out of reach unnoticed:
    // wrapping one call in a command substitution dropped the helped count by
    // one and a floor of eight still passed. Every mention of the helper must
    // be a command that starts with it, so a mention that is not one fails
    // here whatever the total happens to be.
    const mentions = commands.filter((command) => /\brun_tool\s/.test(command));
    expect(helped.length, `a mention of the helper does not start a command: ${mentions.join(" | ")}`).toBe(
      mentions.length,
    );
    expect(helped.length, "the scan found no tool started through the helper").toBeGreaterThan(0);

    // The substitution is the specific way this happens, and it is worth its
    // own message: a substitution runs in a subshell, so the job table the
    // stop reads belongs to a shell that has already gone.
    expect(script, "a tool started inside a command substitution cannot be stopped").not.toMatch(
      /\$\(\s*run_tool\b/,
    );
  });
});

describe("the lock of the issuer script", () => {
  const script = readFileSync(join(HERE, "..", "..", "scripts", "attest.sh"), "utf8");

  it("uses the same file in the functions that take and give it back", () => {
    // An assertion that only read the definition passed while the functions
    // used a different path, and the two tools would then no longer share one
    // lock on one working tree.
    // A second assignment on a later line satisfies a check that only asks
    // whether the first one is present, and the two tools then hold different
    // locks on one working tree, run together, and sweep the files the other
    // is writing. The file may name the lock once.
    const assignments = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^LOCK=/.test(line));
    expect(assignments).toEqual(['LOCK="$REC/.run.lock"']);
    const take = script.slice(script.indexOf("take_lock() {"), script.indexOf("release_lock()"));
    expect(take, "take_lock names another file").toContain('"$LOCK"');
    expect(take).not.toMatch(/\.run\.lock/);
    const release = script.slice(script.indexOf("release_lock()"));
    expect(release.split("\n")[0], "release_lock names another file").toContain('"$LOCK"');
  });

  it("gives the lock back only while this run still owns it", () => {
    // A release that removed the file whatever it named would take the lock
    // away from the run that followed. The client library has the same rule and
    // a mutation already killed it there.
    const release = script.slice(script.indexOf("release_lock()")).split("\n")[0];
    expect(release, "release_lock does not check the owner").toContain('[ "$(lock_owner)" = "$$" ]');
  });
});
