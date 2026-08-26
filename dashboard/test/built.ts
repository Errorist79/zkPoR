/**
 * The built dashboard, in a directory that the tests own.
 *
 * One test starts the shipped entry point as a process, so it needs the built
 * artifact rather than the source. Reading `dist` made its verdict depend on a
 * build it does not control, and that fails in two directions.
 *
 * The build config sets `clean`, so every build removes `dist` and writes it
 * again. A test that spawned into that window found no entry point, and that
 * arrives at an assertion as a wrong exit code.
 *
 * A run of `vitest` on its own skips the build that the test script performs
 * first, so the test measures an artifact older than the source. That direction
 * is worse, because it reports the shipped behaviour as sound when the source
 * has changed, or as broken when it has not.
 *
 * Building here removes both. The directory belongs to this test run, nothing
 * else writes it, and it holds the source the test is checking.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./support.js";

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
 * Builds the dashboard into a directory that this test run owns.
 *
 * The bundle keeps the client library external, so the output sits inside the
 * package where the resolver still reaches `node_modules`.
 */
export function builtMain(): string {
  if (built === undefined) {
    const owned = join(PACKAGE_ROOT, ".test-build");
    mkdirSync(owned, { recursive: true });
    const directory = mkdtempSync(join(owned, "run-"));
    execFileSync("npx", ["tsup", "--out-dir", directory], {
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
  }
  return join(built, "main.js");
}
