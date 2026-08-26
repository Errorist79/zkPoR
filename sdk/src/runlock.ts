/**
 * The lock that lets one proving run at a time use the working tree.
 *
 * A proving run writes its witness files at fixed paths inside the repository.
 * Those paths are a resource of the machine and not of a process, so a rule
 * that one process keeps for itself does not protect them. Two runs on one
 * repository overwrite each other's inputs, and a sweep by one of them removes
 * the inputs of the other while it still reads them.
 *
 * The lock is a file that a process creates exclusively. The file holds the
 * identifier of the process that owns it, so a reader of a refusal learns which
 * process to look at.
 *
 * A lock whose owner no longer runs is stale, and a stale lock must not stop
 * the machine forever. The check asks the operating system whether the owner is
 * alive. That check has one limit worth stating: an operating system reuses a
 * process identifier, so a lock whose owner died can look alive when an
 * unrelated process took its number. The failure is the safe one, because it
 * refuses a run rather than allowing a second one.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The lock file, against the repository. */
const LOCK = "circuits/recursion/.run.lock";

/** A run that cannot take the lock, because another run holds it. */
export class RunLockedError extends Error {
  /** The process that holds the lock, as the lock file names it. */
  readonly ownerPid: number;

  constructor(ownerPid: number) {
    super(
      `another proving run holds the lock on this repository, under the process ${String(ownerPid)}; wait for it or stop it`,
    );
    this.name = "RunLockedError";
    this.ownerPid = ownerPid;
  }
}

/** The path of the lock file of one repository. */
export function lockPath(repository: string): string {
  return join(repository, LOCK);
}

/** True when a process with this identifier runs now. */
function isAlive(pid: number): boolean {
  try {
    // The signal 0 sends nothing. It reports whether the process exists and
    // whether this user may signal it.
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // A process that exists but belongs to another user answers with a
    // permission failure, which still means it is alive.
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

/** The owner that a lock file names, or nothing when it names none. */
function ownerOf(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Takes the lock of one repository, and returns the release.
 *
 * A lock file whose owner no longer runs is removed and taken again. The retry
 * happens once, because a second process that wins the race in between holds a
 * live lock, and this run then refuses rather than joins.
 */
export function takeRunLock(repository: string): () => void {
  const path = lockPath(repository);
  const claim = (): boolean => {
    try {
      // The exclusive flag makes the creation fail when the file exists, so
      // the check and the creation are one step for the operating system.
      const handle = openSync(path, "wx");
      try {
        // The identifier goes through the handle that the creation returned,
        // before it closes. Creating the file and then writing it in a second
        // call leaves a moment where the lock exists and names nobody, and a
        // reader that treats a file naming nobody as a lock nobody holds then
        // takes a lock that another run is in the middle of taking. Two runs
        // then believe they hold one lock.
        writeSync(handle, `${String(process.pid)}\n`);
      } finally {
        closeSync(handle);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!claim()) {
    const owner = ownerOf(path);
    if (owner !== undefined && isAlive(owner)) {
      throw new RunLockedError(owner);
    }
    // The owner is gone, or the file names nobody. Either way no run holds it.
    try {
      unlinkSync(path);
    } catch {
      // Another process may have removed it first, which is the same outcome.
    }
    if (!claim()) {
      throw new RunLockedError(ownerOf(path) ?? 0);
    }
  }

  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    // The release removes the file only while this process still owns it, so a
    // late release never takes the lock away from the run that followed.
    if (ownerOf(path) === process.pid) {
      try {
        unlinkSync(path);
      } catch {
        // A lock file that is already gone needs no removal.
      }
    }
  };
}
