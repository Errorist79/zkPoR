/**
 * The built package, in a directory that the tests own.
 *
 * Two tests need the shipped artifact rather than the source: one spawns the
 * command line and reads its exit code, and one starts a tool through the
 * driver's own helper. Both used to reach into `dist`, and that made their
 * verdicts depend on a build they did not control.
 *
 * That dependency failed in both directions, and each direction produced a
 * confident wrong answer about the exit code contract.
 *
 * The build config sets `clean`, so every build removes `dist` and writes it
 * again. A test that spawned into that window reported the command line
 * missing, which arrives at an assertion as a wrong exit code.
 *
 * A run of `vitest` on its own skips the build that the test script performs
 * first, so the test measured an artifact older than the source. That direction
 * is worse, because it reports the contract as broken when the source is right,
 * or as sound when the source is wrong.
 *
 * Building here removes both. The directory belongs to the test run, nothing
 * else writes it, and it is built from the source that the test is checking.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package that holds this test. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The signals that end a test run, beside the exit hook. */
const GUARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Removes one directory when this process ends, however it ends.
 *
 * The removal runs without waiting, because an exit hook runs nothing else.
 *
 * Each run removes its own directory and never another. The test runner gives
 * each test file a process of its own, and they build at the same time, so a
 * sweep of the parent directory would remove a build that another file is
 * running from. A kill that cannot be caught therefore leaves one directory
 * behind, which git ignores.
 */
function removeWhenThisRunEnds(directory: string): void {
  let removed = false;
  const remove = (): void => {
    if (removed) {
      return;
    }
    removed = true;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A directory that will not go is a leftover and not a failure of a test.
    }
  };
  process.on("exit", remove);
  for (const signal of GUARDED_SIGNALS) {
    process.on(signal, () => {
      remove();
      process.exit(1);
    });
  }
}

/** The directory of one build, once for each test file that asks. */
let built: string | undefined;

/**
 * Builds the package into a directory that this test run owns.
 *
 * The declaration files are skipped, because a test runs the code and reads no
 * type from the artifact.
 */
export function buildPackage(): string {
  if (built !== undefined) {
    return built;
  }
  // The build stays inside the package. The bundle keeps its dependencies
  // external, so it has to sit where the resolver still finds `node_modules`.
  // It is not `dist`, because the point is a directory that nothing else
  // writes while a test reads it.
  const owned = join(PACKAGE_ROOT, ".test-build");
  mkdirSync(owned, { recursive: true });
  const directory = mkdtempSync(join(owned, "run-"));
  execFileSync("npx", ["tsup", "--out-dir", directory, "--no-dts"], {
    cwd: PACKAGE_ROOT,
    stdio: "pipe",
    timeout: 180_000,
  });
  built = directory;
  // The directory belongs to this run and to nothing after it. Removing it on
  // every ending that lets this process run something keeps a machine that
  // runs the suite often from accumulating one build for each run. The endings
  // are the ones a run of a test process has: a return, a failure, a signal,
  // and any other exit.
  removeWhenThisRunEnds(directory);
  return directory;
}

/** The built command line. */
export function builtCli(): string {
  return join(buildPackage(), "cli.js");
}

/** The built library, as a module specifier that another process can import. */
export function builtLibrary(): string {
  return join(buildPackage(), "index.js");
}
