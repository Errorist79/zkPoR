/**
 * The lifecycle of one proving run: the lock, the guards, and the sweeps.
 *
 * These steps used to sit inline in the driver, where nothing reached them. A
 * proving run needs the pinned toolchain, so no test could enter the driver on
 * a machine without it, and every one of these calls could be deleted with the
 * whole suite still green. The order is the guarantee, and an order that only a
 * reader checks is an order that a rename breaks.
 *
 * They live here so the order is one function that a test drives with any body
 * at all, and so the driver has one call rather than six.
 *
 * The order, and why each step sits where it does:
 *
 * 1. Take the lock. A run that does not own the lock must never sweep, because
 *    the files it would remove belong to the run that does.
 * 2. Guard the tools, then guard the files. Node calls the listeners of one
 *    event in the order they were added, so the tools stop before a file is
 *    removed. A sweep that ran first would remove files that a surviving tool
 *    writes again, and nothing would remove them after that.
 * 3. Sweep before the body writes. This is the one sweep that reaches the files
 *    of a run that stopped without running any code of its own.
 * 4. On the way out, in this order: stop the tools, sweep, drop the guards,
 *    release the lock.
 */

import { stopChildrenSync, guardChildren } from "./children.js";
import { takeRunLock } from "./runlock.js";
import { clearWitnesses, guardWitnesses } from "./witnesses.js";

/** A report of progress, so a caller can show which step runs. */
export type LifecycleReporter = (step: string) => void;

/**
 * Runs one body inside the lifecycle of a proving run.
 *
 * The body owns the working tree for as long as it runs. Every ending returns
 * the tree to a state that holds no salt and no witness, and releases the lock.
 */
export async function withRunLifecycle<T>(
  repository: string,
  report: LifecycleReporter,
  body: () => Promise<T>,
): Promise<T> {
  const releaseLock = takeRunLock(repository);
  const removeChildGuard = guardChildren();
  const removeFileGuard = guardWitnesses(repository, releaseLock);
  try {
    await clearWitnesses(repository);
    return await body();
  } finally {
    // The tools stop before the sweep on this path too. A body that threw
    // leaves no tool running today, and an order that depended on that would
    // break the moment a body starts one and returns.
    const stopped = stopChildrenSync();
    if (stopped.stillRunning.length > 0) {
      // The deadline expired with a group still alive, so the sweep below runs
      // against something that has not finished ending. Saying so is the point:
      // a deadline that expires quietly leaves a reader believing the tools
      // are gone.
      report(
        `these process groups had not ended when the stop gave up: ${stopped.stillRunning.join(", ")}`,
      );
    }
    report("removing the witness files");
    // A path that cannot be removed must not replace the real failure, and must
    // not strand the lock or the guards. The sweep already reports what it
    // could not remove by leaving it on disk.
    try {
      await clearWitnesses(repository);
    } catch {
      // The steps below release what this process holds, and they matter more
      // than a second report of a file that will not go.
    }
    removeFileGuard();
    removeChildGuard();
    releaseLock();
  }
}
