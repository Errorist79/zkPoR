/**
 * What a proving run reports.
 *
 * This returns the lines instead of printing them, and that shape is the point
 * rather than a style. A proving run cannot be entered without the pinned
 * toolchain, so nothing can drive the commands end to end and observe what they
 * printed. While the reporting was a series of print calls, a call could be
 * left in place and never reached with every test still passing: the values an
 * issuer needs would silently stop appearing, on the path where a run fails
 * after a correct proof and the witness files are already gone.
 *
 * A value can be read. So when a path cannot be entered, the decision moves
 * into something that returns one.
 *
 * It lives here and not in the command line for a second reason. The command
 * line is an entry point: its last statement runs it. A test that imported a
 * function from there would start the command line inside the process running
 * the tests.
 */

import { snapshotInsideWindow } from "./attest.js";
import { RegistryRefusedError } from "./registry.js";
import { toHex } from "./fr.js";
import type { Proof, RunContext } from "./proving.js";

/** The record that the network accepted one attestation. */
export interface AcceptedAttestation {
  readonly ledger: number;
  readonly transactionHash: string;
}

/** The lines that one proving run reports. */
export function runReport(input: {
  context: RunContext;
  proof: Proof;
  currentLedger: number;
  submission?: AcceptedAttestation;
}): string[] {
  const lines = [
    `The proof holds ${input.proof.proof.length} bytes.`,
    `The snapshot ledger is ${input.context.snapshotLedger}.`,
    `The root is ${toHex(input.proof.values.final_root)}.`,
    `The total liabilities are ${input.proof.values.L.toString(10)}.`,
    `The context hash is ${toHex(input.proof.values.context_hash)}.`,
  ];
  if (input.submission !== undefined) {
    lines.push(
      `The registry accepted the attestation at ledger ${input.submission.ledger}.`,
      `The transaction is ${input.submission.transactionHash}.`,
      "Generate the customer packages with the generator, which reads the",
      "attested root from the registry before it writes any file.",
    );
    return lines;
  }
  // The proof took minutes and the window is finite, so a run can end with a
  // snapshot that can no longer land. The statement names the ledger it read,
  // because it is true at that ledger and at no other.
  lines.push(
    snapshotInsideWindow(input.context.snapshotLedger, input.currentLedger)
      ? `At ledger ${input.currentLedger} the snapshot can still be attested.`
      : `At ledger ${input.currentLedger} the snapshot has already left its window, so the registry refuses this root. Take a fresh snapshot and prove again.`,
  );
  return lines;
}

/** What one attestation attempt produced. */
export interface AttestOutcome {
  /** The lines to state, whether the submission landed or not. */
  readonly lines: readonly string[];
  /** The reason the submission failed, when it failed. */
  readonly failure: unknown;
}

/**
 * Submits one attestation and says what to report, on both outcomes.
 *
 * The lines are a value and so is the failure, and that is the point rather
 * than a style. What to say was already a value. Whether to say it was not: it
 * lived in a catch inside a command that nothing can enter without the pinned
 * toolchain, so a call there could be kept in place and never reached with the
 * whole suite passing. An issuer whose submission failed after a correct proof
 * would then see nothing at all, with the witness files already swept and no
 * other copy of the root anywhere.
 *
 * The caller states the lines and then raises the failure, so the exit code of
 * a failed submission is unchanged.
 *
 * The submission is a callable the caller supplies. The authority key stays
 * inside it and reaches no value here, exactly as the master secret reaches no
 * value in the driver.
 */
export async function attestAndReport(input: {
  context: RunContext;
  proof: Proof;
  readCurrentLedger: () => Promise<number>;
  submit: () => Promise<AcceptedAttestation>;
}): Promise<AttestOutcome> {
  let submission: AcceptedAttestation;
  try {
    submission = await input.submit();
  } catch (failure) {
    // The proof is correct and the submission is not. The report still states
    // what the proof commits to.
    return {
      lines: runReport({
        context: input.context,
        proof: input.proof,
        currentLedger: await input.readCurrentLedger(),
      }),
      failure,
    };
  }
  return {
    lines: runReport({
      context: input.context,
      proof: input.proof,
      currentLedger: await input.readCurrentLedger(),
      submission,
    }),
    failure: undefined,
  };
}

/**
 * What one command produced.
 *
 * A command states nothing itself. It returns what to say, and one place says
 * it. While each command printed for itself, its statement sat on a path that
 * only that command reached, and the two commands that need the pinned
 * toolchain reach nothing a test can drive, so a call could be kept exactly
 * where a reader looks for it and never run with the whole suite passing.
 */
export interface CommandResult {
  /** What to state. */
  readonly lines: readonly string[];
  /** The exit code that this command names, when it names one. */
  readonly code?: number;
  /** A failure to raise after the lines are stated. */
  readonly failure?: unknown;
}

/**
 * States what a command produced, and returns the exit code it names.
 *
 * The order is the property. The lines go out before a failure is raised,
 * because a submission that fails after a correct proof must not take the root
 * away from an issuer: the witness files are swept by then and no other copy of
 * it exists. This lives outside the command line so that order can be driven,
 * since the one command that returns a failure cannot be reached without the
 * toolchain.
 */
export function completeCommand(
  result: CommandResult,
  state: (lines: readonly string[]) => void,
): number | undefined {
  state(result.lines);
  if (result.failure !== undefined) {
    throw result.failure;
  }
  return result.code;
}

/**
 * The sentence that follows a failure of a command.
 *
 * A refusal of the registry is the answer of the registry about the request.
 * Calling it a failure of the client or of the network is false, and it is
 * false in the one place a reader looks to learn who answered. It also inverts
 * the rule that this package publishes: the exit codes separate a verdict from
 * a failure, and a line that misnames the source of an answer undoes that
 * separation in prose.
 *
 * The exit code does not change. A refusal still produces no verdict of the
 * inclusion check, and the codes of that check belong to it alone.
 */
export function failureNote(cause: unknown): string {
  if (cause instanceof RegistryRefusedError) {
    return "The registry answered this. It is the answer of the contract about the request, and not a verdict of the inclusion check.";
  }
  return "This is a failure of the client or of the network. It is not a verdict.";
}
