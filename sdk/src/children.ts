import type { ChildProcess } from "node:child_process";

/**
 * The tools that a proving run starts, and the certainty that none outlives it.
 *
 * A sweep that removes the prover inputs is worth nothing while a tool that
 * writes them is still running. The tool writes the salts back after the sweep,
 * and no process is left that will ever remove them. That turns a bounded
 * exposure into an unbounded one, and the sweep running is what creates it.
 *
 * Two properties make the guarantee real.
 *
 * A tool runs in a process group of its own. `cargo run` starts the generator
 * as a further process, and `nargo` and `bb` start work of their own, so a
 * signal sent to the tool alone leaves the process that actually writes the
 * files. The group holds the whole tree, and one signal reaches all of it.
 *
 * The tools stop before the sweep, and the stop is certain rather than
 * requested. `SIGKILL` cannot be caught or ignored, so a tool that receives it
 * runs no further instruction of its own.
 *
 * A signal goes to a tool this process still owns, and never to a number that
 * once named one. The runtime states the hazard: a signal sent to a child that
 * has already exited reaches whatever now holds that identifier, because the
 * operating system is free to reassign it (`subprocess.kill` in the child
 * process documentation of Node 22). An uncatchable signal aimed at a whole
 * group makes that worse than the usual case, because it would end a group of
 * processes belonging to somebody else on the machine.
 *
 * The record therefore holds the child object that the runtime returns, and a
 * signal goes out only while the runtime reports the tool as neither exited nor
 * signalled. A terminated child stays a zombie until its parent reaps it, so
 * the identifier cannot be reassigned before those fields are set, and the
 * moment between termination and reaping reports the tool as still ours, which
 * is true, because our own zombie holds the identifier. The check therefore
 * errs toward signalling a group of ours that is already dead, and never toward
 * a stranger.
 *
 * The same reassignment hazard decides the run lock of this client, and there
 * it costs a refused run, which is safe. Here it would cost processes that
 * belong to somebody else. Same hazard, opposite consequence, so the two take
 * opposite defaults.
 *
 * One case is left open by that default and it is a decision rather than a
 * gap. A tool that exits while a process it started is still running takes its
 * group out of the record, so those processes are left running. Leaving a
 * process of ours alive is bounded and a reader can see it. Ending a group this
 * process may no longer own is neither.
 *
 * A process group of its own also means the terminal no longer signals a tool
 * directly. That is the point. Before, an interrupt in a terminal reached the
 * tools because they shared the group, and the same interrupt from a service
 * manager reached the parent alone and left them running. The two cases now end
 * the same way, because this process ends them itself.
 */

/**
 * The tools that run now, as the runtime's own objects.
 *
 * A bare identifier would be a fact this module maintains. The object is a fact
 * the runtime maintains, and it is the one that says whether the identifier
 * still belongs to this process.
 */
const running = new Set<ChildProcess>();

/** The signals that stop a run, beside the exit hook. */
const GUARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * The longest that the stop waits after it signals, in milliseconds.
 *
 * The wait is short on purpose, and the reason is worth stating because a
 * longer one looks safer and is not. `SIGKILL` cannot be caught, blocked, or
 * ignored, so a process that receives it runs no further instruction of its
 * own. The wait covers delivery and nothing else.
 *
 * Waiting for the group to disappear does not work and must not be attempted.
 * A tool this process started becomes its own child, a killed child becomes a
 * zombie until its parent reaps it, and this function holds the event loop so
 * no reaping can happen while it runs. A wait for the group to vanish would
 * therefore always run to its deadline. A zombie writes nothing, so it is
 * already as stopped as the sweep needs.
 *
 * The poll below still earns its place for the further processes a tool starts.
 * Those are reparented when the tool dies, the operating system reaps them, and
 * their group does disappear.
 */
export const STOP_DEADLINE = 250;

/** Records a tool that runs now. The tool leads a process group of its own. */
export function watchChild(child: ChildProcess): void {
  running.add(child);
}

/** Forgets a tool that has already ended. */
export function forgetChild(child: ChildProcess): void {
  running.delete(child);
}

/** The identifiers of the tools that this module believes are running. */
export function watchedChildren(): readonly number[] {
  return [...running].map((child) => child.pid ?? 0);
}

/**
 * True when a signal may still go to the group of this tool.
 *
 * The runtime reports an exit code of `null` while a child runs, and a signal
 * code of `null` unless a signal ended it. While both are null the identifier
 * has not been released, so it still names this tool.
 */
function stillOurs(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/** True when a process group still has a member. */
function groupIsAlive(pid: number): boolean {
  try {
    // The signal 0 sends nothing and reports whether the group still exists.
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    // A group whose members belong to another user answers with a permission
    // failure, which still means it exists.
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

/** Waits without running anything, so an exit hook can use it. */
function pause(milliseconds: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

/** What a stop saw when it finished. */
export interface StopReport {
  /** The groups that had gone by the time the wait ended. */
  readonly gone: readonly number[];
  /** The groups that were still alive when the deadline expired. */
  readonly stillRunning: readonly number[];
  /**
   * The deadline that the wait was given, in milliseconds.
   *
   * The report states it so a caller can read back which value a stop used. No
   * test can observe the duration itself, for the reason the constant gives,
   * but a call site that stopped passing the constant is a different question
   * and this answers it.
   */
  readonly deadline: number;
}

/**
 * Waits for each group to disappear, and reports what it saw.
 *
 * The wait exists for the processes a tool starts in turn. Those are
 * reparented when the tool dies and the operating system reaps them, so their
 * group does disappear and the wait ends. A tool of this process cannot be
 * waited for, because it becomes a zombie until this process reaps it and this
 * function holds the loop that would do the reaping.
 *
 * The report is a value rather than nothing, so a caller can say that a
 * deadline expired with something still alive instead of continuing quietly.
 */
export function waitForGroupsToEnd(
  pids: readonly number[],
  deadlineMilliseconds: number,
): StopReport {
  const gone: number[] = [];
  const stillRunning: number[] = [];
  const until = Date.now() + deadlineMilliseconds;
  for (const pid of pids) {
    while (groupIsAlive(pid) && Date.now() < until) {
      pause(10);
    }
    if (groupIsAlive(pid)) {
      stillRunning.push(pid);
    } else {
      gone.push(pid);
    }
  }
  return { gone, stillRunning, deadline: deadlineMilliseconds };
}

/**
 * Stops every tool of this run and returns what it saw.
 *
 * The caller sweeps after this returns, never before. The function is
 * synchronous because an exit hook runs nothing else.
 */
export function stopChildrenSync(deadline: number = STOP_DEADLINE): StopReport {
  const signalled: number[] = [];
  for (const child of running) {
    if (!stillOurs(child) || child.pid === undefined) {
      // The runtime has already reaped this one, so the identifier may name
      // another process now. Signalling it is the one thing this must not do.
      continue;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
      signalled.push(child.pid);
    } catch {
      // A group that has already ended needs no signal.
    }
  }
  running.clear();
  return waitForGroupsToEnd(signalled, deadline);
}

/**
 * Installs the stop on every ending that lets this process run anything.
 *
 * The caller installs this before the sweep guard, so the listeners of both run
 * in that order on one event and the tools are gone before a file is removed.
 * The handler re-raises the signal, so the process ends with the status that
 * the signal names.
 */
export function guardChildren(): () => void {
  let stopped = false;
  const stopOnce = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    stopChildrenSync();
  };
  const onExit = (): void => {
    stopOnce();
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
        stopOnce();
        // This handler removes itself here, and that is load-bearing rather
        // than tidy. The sweep guard runs next and raises the signal again so
        // the process ends with the status the signal names. A raise ends the
        // process only when no listener remains for that signal, so a listener
        // left here would swallow it and the process would keep running with
        // its tools already stopped.
        remove();
      },
    });
  }

  process.on("exit", onExit);
  for (const each of handlers) {
    process.on(each.signal, each.handler);
  }
  return remove;
}
