/**
 * The record of an attestation run, which takes about a minute.
 *
 * Three properties decide the shape here.
 *
 * A run is a resource with an identity. A submission starts the run and then
 * redirects to that resource, so the page that shows progress is a plain read.
 * A reload of it repeats a read and starts nothing, and the browser needs no
 * script to follow a run.
 *
 * One process holds at most one open run. Two runs cannot proceed together for
 * three separate reasons: the prover needs more memory than two copies of it
 * fit in, the proving driver writes the witness files of a run at fixed paths
 * that a second run would overwrite, and two attestations of one asset race for
 * the same window. A second submission therefore starts nothing and joins the
 * open run.
 *
 * The store holds no secret. The master secret and the authority key stay in
 * the environment of the process, and the work function reads each one at the
 * moment it needs it.
 */

import { randomUUID } from "node:crypto";
import { toHex } from "@zkpor/sdk";
import type { ProgressReporter } from "@zkpor/sdk";
import { MAX_REMEMBERED_RUNS } from "./constants.js";
import { SILENT_LOG } from "./log.js";
import type { Log } from "./log.js";

/** What a run does. A proof stops at the proof, and an attestation submits it. */
export type RunAction = "prove" | "attest";

/** Where a run stands. */
export type RunStage = "running" | "finished" | "failed";

/** What one proving run produced. The proof bytes stay out, because no page shows them. */
export interface ProofSummary {
  readonly proofBytes: number;
  readonly finalRoot: bigint;
  readonly totalLiabilities: bigint;
  readonly contextHash: bigint;
}

/** The record that the network accepted one attestation. */
export interface Submission {
  readonly ledger: number;
  readonly transactionHash: string;
  /**
   * The registry that accepted it.
   *
   * The client sends an attestation to the generation that holds the asset,
   * which is not always the newest. This page is where that happens, so it is
   * where a reader must be able to see which registry received it.
   */
  readonly registry: string;
}

/**
 * Whether the snapshot of a run could still be attested when the run ended.
 *
 * A proof takes about a minute and the window is finite, so a run that proves
 * correctly can finish with a snapshot that can no longer land. The statement
 * names the ledger it read, because it is true at that ledger and at no other.
 */
export interface WindowAtEnd {
  readonly currentLedger: number;
  readonly stillOpen: boolean;
}

/** What the work of a run produced. */
export interface RunOutcome {
  readonly proof: ProofSummary;
  readonly submission: Submission | undefined;
  readonly window: WindowAtEnd | undefined;
  /**
   * The directory that holds the package of every customer, for a run that
   * attested. A run that only proved writes none, because a package names the
   * transaction of an attestation.
   */
  readonly packages: string | undefined;
  /**
   * How many files this process found in that directory, for the record only.
   *
   * No page shows it. The generator answers with the directory and with no
   * count, so a run counts what it finds there and the log says who counted.
   */
  readonly packageFilesCounted?: number | undefined;
}

/**
 * The work of one run.
 *
 * The work reports its steps, and it records the proof and the reading of the
 * window as soon as each one exists. The records matter because the submission
 * can fail after a correct proof, and the issuer must still see what that proof
 * committed to and whether the snapshot could still land.
 */
export type RunWork = (
  report: ProgressReporter,
  recordProof: (proof: ProofSummary) => void,
  recordWindow: (window: WindowAtEnd) => void,
  recordSubmission: (submission: Submission) => void,
) => Promise<RunOutcome>;

/** One run, as a page shows it. */
export interface Run {
  readonly id: string;
  readonly action: RunAction;
  readonly asset: string;
  readonly snapshotLedger: number;
  readonly stage: RunStage;
  readonly steps: readonly string[];
  /**
   * What the proof committed to, once the proof exists.
   *
   * A failed run keeps this. A run that proved correctly and then missed the
   * window must still show the root, the total, and the context hash.
   */
  readonly proof: ProofSummary | undefined;
  readonly submission: Submission | undefined;
  readonly window: WindowAtEnd | undefined;
  /**
   * Where the packages of the customers went, once a run wrote them.
   *
   * A reader looking for what a run produced looks under that heading. The
   * directory was only in the last line of the steps, inside a sentence, which
   * is not where anybody goes for it.
   */
  readonly packages: string | undefined;
  /** The reason the run failed. It never carries a secret, because no message here holds one. */
  readonly failure: string | undefined;
}

/** What one submission did. */
export interface StartResult {
  readonly run: Run;
  /** False when a run was already open, so this submission started nothing. */
  readonly started: boolean;
}

/** What a caller states about a run before the work begins. */
export interface RunRequest {
  readonly action: RunAction;
  readonly asset: string;
  readonly snapshotLedger: number;
  readonly work: RunWork;
}

/**
 * The runs of one process.
 *
 * The store holds the identity of a run, the values that the work records, and
 * the stage, so it is where the record of a run belongs. A work function knows
 * no identity, and a log line without one cannot be matched to a page.
 */
export class RunStore {
  private readonly runs = new Map<string, Run>();
  private readonly started = new Map<string, number>();
  private openRunId: string | undefined;
  private readonly log: Log;

  constructor(log: Log = SILENT_LOG) {
    this.log = log;
  }

  /** The open run, when one is open. */
  open(): Run | undefined {
    if (this.openRunId === undefined) {
      return undefined;
    }
    return this.runs.get(this.openRunId);
  }

  /** One run by its identity. */
  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  /**
   * Starts a run, or joins the run that is already open.
   *
   * The check of the open run and the record of the new one both happen before
   * this function awaits anything, so a second submission that arrives while
   * the first one is in flight sees the run that the first one recorded. The
   * work begins after that, and the caller does not wait for it.
   */
  startOrJoin(request: RunRequest): StartResult {
    if (this.openRunId !== undefined) {
      const already = this.runs.get(this.openRunId);
      if (already === undefined) {
        // The store forgets no open run and the work always clears the
        // identity, so this state is a defect of this module. Starting a
        // second prover on that guess is the one outcome to avoid, so the
        // submission stops instead.
        throw new Error("this process lost the record of the run that is open");
      }
      return { run: already, started: false };
    }
    const run: Run = {
      id: randomUUID(),
      action: request.action,
      asset: request.asset,
      snapshotLedger: request.snapshotLedger,
      stage: "running",
      packages: undefined,
      steps: [],
      proof: undefined,
      submission: undefined,
      window: undefined,
      failure: undefined,
    };
    this.forget();
    this.runs.set(run.id, run);
    this.started.set(run.id, Date.now());
    this.openRunId = run.id;
    void this.perform(run.id, request.work, request.action);
    return { run, started: true };
  }

  private async perform(id: string, work: RunWork, action: RunAction): Promise<void> {
    try {
      const outcome = await work(
        (step) => {
          // The step text is the text the page shows. It travels whole, so the
          // log and the page never word one event two ways.
          this.log({ event: "run.step", run: id, step, ms: this.elapsed(id) });
          this.change(id, (run) => ({ ...run, steps: [...run.steps, step] }));
        },
        (proof) => {
          this.log({
            event: "proof.finished",
            run: id,
            proof_bytes: proof.proofBytes,
            final_root: toHex(proof.finalRoot),
            total_liabilities: proof.totalLiabilities.toString(10),
            context_hash: toHex(proof.contextHash),
            ms: this.elapsed(id),
          });
          this.change(id, (run) => ({ ...run, proof }));
        },
        (window) => {
          this.log({
            event: "window.read",
            run: id,
            current_ledger: window.currentLedger,
            still_open: window.stillOpen,
          });
          this.change(id, (run) => ({ ...run, window }));
        },
        (submission) => {
          this.log({
            event: "attestation.submitted",
            run: id,
            registry: submission.registry,
            ledger: submission.ledger,
            transaction: submission.transactionHash,
            ms: this.elapsed(id),
          });
          this.change(id, (run) => ({ ...run, submission }));
        },
      );
      if (outcome.packages !== undefined) {
        this.log({
          event: "packages.written",
          run: id,
          directory: outcome.packages,
          files_counted_here: outcome.packageFilesCounted,
          ms: this.elapsed(id),
        });
      }
      this.change(id, (run) => ({
        ...run,
        stage: "finished",
        proof: outcome.proof,
        submission: outcome.submission,
        window: outcome.window,
        packages: outcome.packages,
      }));
      this.log({ event: "run.finished", run: id, action, stage: "finished", ms: this.elapsed(id) });
    } catch (cause) {
      const failure =
        cause instanceof Error ? cause.message : "the run failed for a reason it cannot describe";
      // The spread keeps the proof and the submission that the work already
      // recorded. A submission that failed after a correct proof must not take
      // the root away, and a step that failed after the network accepted the
      // attestation must not take the transaction away: the attestation stands
      // on the chain whatever happens in this process after it.
      this.change(id, (run) => ({ ...run, stage: "failed", failure }));
      this.log({ event: "run.failed", run: id, error: failure, ms: this.elapsed(id) });
    } finally {
      if (this.openRunId === id) {
        this.openRunId = undefined;
      }
    }
  }

  /** The milliseconds since this run began. */
  private elapsed(id: string): number {
    const started = this.started.get(id);
    return started === undefined ? 0 : Date.now() - started;
  }

  private change(id: string, next: (run: Run) => Run): void {
    const run = this.runs.get(id);
    if (run === undefined) {
      return;
    }
    this.runs.set(id, next(run));
  }

  /**
   * Drops the oldest run that is no longer open, when the store is full.
   *
   * A map keeps the order in which it received its keys, so the first entry
   * that is not the open run is the oldest one.
   */
  private forget(): void {
    while (this.runs.size >= MAX_REMEMBERED_RUNS) {
      const oldest = [...this.runs.keys()].find((id) => id !== this.openRunId);
      if (oldest === undefined) {
        return;
      }
      this.runs.delete(oldest);
      this.started.delete(oldest);
    }
  }
}
