/**
 * The files of a run that carry a salt or a witness, and the sweeps that
 * remove them.
 *
 * The prover inputs hold the identifier, the balance, and the salt of every
 * customer in the snapshot. A run that leaves them on disk leaves every salt
 * readable, so the sweep must run in every way a run can end.
 *
 * A run ends in one of these ways.
 *
 * - It produces a proof. The caller sweeps.
 * - A step fails and throws. The caller sweeps on the failing path.
 * - The process receives an interrupt, a termination, or a hang-up signal. The
 *   guard below sweeps, then lets the signal take its normal course.
 * - The process exits for another reason, which covers an uncaught exception
 *   and a call that ends the process. The guard sweeps on the exit hook.
 * - The process stops without running anything at all. A kill that cannot be
 *   caught, a power loss, and a kernel that reclaims memory all do this. No
 *   code inside the process can sweep here.
 *
 * The last case is the reason a run sweeps before it writes. A tool removes
 * what an earlier run left behind before it writes anything of its own, so the
 * files of a process that died without warning do not outlive the next start.
 * That narrows the exposure. It does not remove it, and the window lasts until
 * a tool runs again.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/** The directory of the inner circuit, against the repository. */
const INNER = "circuits/recursion/inner";

/** The directory of the aggregator, against the repository. */
const AGGREGATOR = "circuits/recursion/agg";

/** The pattern of the prover input that the generator writes for one batch. */
const BATCH_INPUT = /^Prover_\d+\.toml$/;

/** The signals that a sweep answers before it lets the signal take its course. */
const GUARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Every path that a run writes and that carries a salt or a witness.
 *
 * The generator writes one prover input for each batch, so the list reads the
 * directory instead of guessing how many there are. Every sweep takes its paths
 * from here, so no caller holds a second copy of the list.
 */
export function witnessPaths(repository: string): string[] {
  const inner = join(repository, INNER);
  const aggregator = join(repository, AGGREGATOR);
  const paths = [
    join(inner, "Prover.toml"),
    join(inner, "target"),
    join(inner, "out"),
    join(aggregator, "Prover.toml"),
    join(aggregator, "target"),
  ];
  let names: string[] = [];
  try {
    names = readdirSync(inner);
  } catch {
    // A directory that does not exist holds no prover input of a batch.
    names = [];
  }
  for (const name of names) {
    if (BATCH_INPUT.test(name)) {
      paths.push(join(inner, name));
    }
  }
  return paths;
}

/** The paths of the list that exist on disk now. */
export function witnessesOnDisk(repository: string): string[] {
  return witnessPaths(repository).filter((path) => existsSync(path));
}

/**
 * Removes every file of a run that carries a salt or a witness.
 *
 * The step runs on the failing path too, and it runs again before the next run
 * writes anything.
 */
export async function clearWitnesses(repository: string): Promise<void> {
  for (const path of witnessPaths(repository)) {
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * The same sweep, without waiting.
 *
 * An exit hook runs synchronous work only, so the guard needs this form. A
 * failure to remove one path must not stop the sweep of the rest, because a
 * path that this call skips is a salt that stays readable.
 */
export function clearWitnessesSync(repository: string): void {
  for (const path of witnessPaths(repository)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // The next path may still come off, and a throw here would leave it.
    }
  }
}

/**
 * Installs the sweep on every ending that gives the process a chance to run it.
 *
 * The signal handler sweeps, removes itself, and raises the same signal again,
 * so the process ends with the status that the signal names rather than with a
 * status that this guard invented.
 *
 * The caller removes the guard when the run ends, so a process that is not
 * proving keeps its own behaviour on an interrupt.
 */
export function guardWitnesses(repository: string, alsoOnEnd?: () => void): () => void {
  let swept = false;
  const sweepOnce = (): void => {
    if (swept) {
      return;
    }
    swept = true;
    clearWitnessesSync(repository);
    // The run lock is released here as well, so an interrupted run leaves no
    // lock file for the next one to reason about.
    try {
      alsoOnEnd?.();
    } catch {
      // The sweep above already ran, which is the part that must not be lost.
    }
  };
  const onExit = (): void => {
    sweepOnce();
  };
  const handlers: { signal: NodeJS.Signals; handler: () => void }[] = [];

  const remove = (): void => {
    process.removeListener("exit", onExit);
    for (const each of handlers) {
      process.removeListener(each.signal, each.handler);
    }
  };

  for (const signal of GUARDED_SIGNALS) {
    handlers.push({
      signal,
      handler: () => {
        sweepOnce();
        remove();
        process.kill(process.pid, signal);
      },
    });
  }

  process.on("exit", onExit);
  for (const each of handlers) {
    process.on(each.signal, each.handler);
  }
  return remove;
}
