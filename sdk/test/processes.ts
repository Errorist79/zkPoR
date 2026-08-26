/**
 * Reading the state of a process, for the tests that drive real ones.
 *
 * Two tests here start processes and then assert that they have gone: the one
 * that drives the tools of the client library, and the one that drives the
 * tools of the issuer script. Both need the same two readings, so they live
 * here rather than once in each file.
 */

/** True when a process still exists. */
export function alive(pid: number): boolean {
  try {
    // The signal 0 sends nothing and reports whether the process exists.
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // A process that belongs to another user answers with a permission
    // failure, which still means it is alive.
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

/**
 * Waits for a condition to hold, and reports whether it did.
 *
 * The value is returned rather than thrown, so a caller states which condition
 * failed instead of leaving a reader with a timeout and no subject.
 */
export async function until(holds: () => boolean, milliseconds = 15_000): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (holds()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return holds();
}
