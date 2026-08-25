/**
 * The proving run and the attestation, through the kit.
 *
 * The dashboard adds no step of its own. It reads the context file with the
 * kit, checks the window with the kit, proves with the kit, and submits with
 * the kit, in the order the command line uses. Every refusal that the kit makes
 * reaches the reader as it is: a toolchain that differs from the pins, a master
 * secret that anybody can recompute the salts from, and a snapshot that can no
 * longer land are all refusals of the kit, and nothing here bypasses one.
 *
 * Neither secret becomes a value of this package. The master secret and the
 * authority key are each read into the call that needs them, in one expression,
 * so no field, no log line, no progress message, and no page of the dashboard
 * can hold either one. The two are held to the same rule, because both are
 * secrets: one derives every salt, and the other signs the attestation.
 */

import {
  AUTHORITY_SECRET_ENV,
  MASTER_SECRET_ENV,
  MASTER_SECRET_FILE_ENV,
  attestWithAuthority,
  carriesAuthoritySecret,
  carriesMasterSecret,
  latestLedger,
  prove,
  snapshotInsideWindow,
  readAuthoritySecret,
  readContext,
  readMasterSecret,
  windowAllowsProving,
  InfrastructureError,
  deploymentsPath,
  packagesDirectory,
  locateAsset,
  readAssetRecord,
  writeCustomerPackages,
} from "@zkpor/sdk";
import { readdir } from "node:fs/promises";
import type { Environment, ProgressReporter } from "@zkpor/sdk";
import type { Reader } from "./chain.js";
import type { Log } from "./log.js";
import type {
  ProofSummary,
  RunAction,
  RunOutcome,
  RunStore,
  RunWork,
  StartResult,
  Submission,
  WindowAtEnd,
} from "./runs.js";

/**
 * What one run does once the proof exists.
 *
 * The proof needs the pinned toolchain, so no test on a machine without it can
 * enter the work of a run. Everything after the proof is the part that decides
 * what the issuer sees, and it lives here so a test drives it with a proof and
 * a ledger of its own.
 */
export async function afterTheProof(input: {
  action: RunAction;
  snapshotLedger: number;
  currentLedger: number;
  proof: ProofSummary;
  report: ProgressReporter;
  recordProof: (proof: ProofSummary) => void;
  recordWindow: (window: WindowAtEnd) => void;
  recordSubmission: (submission: Submission) => void;
  submit: () => Promise<Submission>;
  writePackages: (accepted: Submission) => Promise<string>;
}): Promise<RunOutcome> {
  // The proof is recorded before anything that can fail after it. A submission
  // that fails must not take the root away, because the witness files are gone
  // and no other copy of it exists.
  input.recordProof(input.proof);

  // The proof took about a minute and the window is finite, so the reading says
  // whether the snapshot could still land, at the ledger it names. It is
  // recorded for the same reason the proof is.
  const window = {
    currentLedger: input.currentLedger,
    stillOpen: snapshotInsideWindow(input.snapshotLedger, input.currentLedger),
  };
  input.recordWindow(window);

  if (input.action === "prove") {
    input.report(
      window.stillOpen
        ? "the proof is ready, and this run submits nothing"
        : "the proof is ready, and its snapshot already left the window",
    );
    return { proof: input.proof, submission: undefined, window, packages: undefined };
  }
  if (!window.stillOpen) {
    // The registry refuses a root whose snapshot left the window, so the run
    // says so here rather than spending a round trip to hear the same answer.
    throw new RunRefusedError(
      `the snapshot ledger ${input.snapshotLedger} left its window before the proof finished, and at ledger ${input.currentLedger} the registry refuses this root; take a fresh snapshot and prove again`,
    );
  }
  input.report("submitting the attestation and waiting for the network");
  const accepted = await input.submit();
  // The transaction is recorded before the step that follows it, for the reason
  // the proof is. The attestation stands on the chain from this moment, and a
  // failure of the packages after it must not make the page say that this run
  // submitted nothing.
  input.recordSubmission(accepted);
  input.report("the registry accepted the attestation");
  // The packages come after the acceptance, because each one names the
  // transaction that carries it and no such transaction exists before this
  // point. A customer cannot check inclusion without one, so a run that
  // attested and wrote none would leave the issuer holding a claim that their
  // customers have no way to check.
  input.report("writing the package of every customer");
  const packages = await input.writePackages(accepted);
  input.report(`the packages of the customers are under ${packages}`);
  return {
    proof: input.proof,
    submission: accepted,
    window,
    packages,
    packageFilesCounted: await countPackageFiles(packages),
  };
}

/** A submission that the dashboard refuses before a run starts. */
export class RunRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRefusedError";
  }
}

/** What one submission of the attestation form states. */
export interface RunSubmission {
  readonly action: RunAction;
  readonly contextPath: string;
  readonly customersPath: string;
}

/**
 * Starts one run, or joins the run that is already open.
 *
 * The checks before the run are the cheap ones, and each answers a question the
 * issuer would otherwise wait a minute for: does the context file parse, can the
 * snapshot still land, and does this process hold the keys the run needs.
 */
export async function submitRun(input: {
  store: RunStore;
  reader: Reader;
  environment: Environment;
  repository: string;
  log: Log;
  submission: RunSubmission;
}): Promise<StartResult> {
  const already = input.store.open();
  if (already !== undefined) {
    return { run: already, started: false };
  }

  const { action, contextPath, customersPath } = input.submission;
  const context = await readContext(contextPath);

  // The presence of a key is checked here and its value is not read here. The
  // check runs before the network read, because it costs nothing and because a
  // run that fails on a missing key after a minute of proving wastes the window.
  if (!carriesMasterSecret(input.environment)) {
    throw new RunRefusedError(
      `set ${MASTER_SECRET_ENV} or ${MASTER_SECRET_FILE_ENV} in the environment of this process; no form carries the master secret`,
    );
  }
  if (action === "attest" && !carriesAuthoritySecret(input.environment)) {
    throw new RunRefusedError(
      `set ${AUTHORITY_SECRET_ENV} in the environment of this process; no form carries the authority key`,
    );
  }

  windowAllowsProving(context.snapshotLedger, await latestLedger(input.reader.server));

  // The attestation goes where the asset is registered. This resolves once,
  // before the proof, so a run that could reach no registry stops in a second
  // rather than after a minute of proving.
  const located = await locateAsset({
    server: input.reader.server,
    config: input.reader.config,
    options: input.reader.readOptions,
    deploymentsText: input.reader.deploymentsText,
    asset: context.asset,
  });
  if (located.holder === undefined) {
    throw new RunRefusedError(
      `no recorded generation holds the asset ${context.asset}, so there is no registry to attest to`,
    );
  }
  const registry = located.holder.generation.registry;

  const work: RunWork = async (report, recordProof, recordWindow, recordSubmission) => {
    const proof = await prove({
      repository: input.repository,
      contextFile: contextPath,
      customersFile: customersPath,
      // The secret is read here and passed on in the same expression. It
      // reaches no variable of this package.
      masterSecret: await readMasterSecret(input.environment),
      report,
    });
    const summary = {
      proofBytes: proof.proof.length,
      finalRoot: proof.values.final_root,
      totalLiabilities: proof.values.L,
      contextHash: proof.values.context_hash,
    };
    return await afterTheProof({
      action,
      snapshotLedger: context.snapshotLedger,
      currentLedger: await latestLedger(input.reader.server),
      proof: summary,
      report,
      recordProof,
      recordWindow,
      recordSubmission,
      submit: async () => {
        const accepted = await attestWithAuthority(
          input.reader.server,
          input.reader.config,
          // The key is read here and passed on in the same expression, exactly
          // as the master secret is. It reaches no variable of this package.
          readAuthoritySecret(input.environment),
          {
            registry,
            asset: context.asset,
            snapshotLedger: context.snapshotLedger,
            finalRoot: summary.finalRoot,
            totalLiabilities: summary.totalLiabilities,
            proof: proof.proof,
          },
        );
        return {
          ledger: accepted.ledger,
          transactionHash: accepted.transactionHash,
          registry,
        };
      },
      writePackages: async (accepted) => {
        // The root comes back from the registry rather than from the proof this
        // process just made. The generator refuses to write unless the root it
        // recomputes from the balance file equals the root declared here, so
        // reading it from the chain turns that refusal into a round trip: it
        // proves that this balance file reproduces the attestation the registry
        // holds, and not merely the one this process believes it sent.
        const record = await readAssetRecord(
          input.reader.server,
          input.reader.config,
          input.reader.readOptions,
          registry,
          context.asset,
        );
        if (record === undefined || record.attestation === undefined) {
          throw new InfrastructureError(
            "the registry accepted the attestation and holds no record of it, so the packages of the customers cannot name a root",
          );
        }
        const directory = packagesDirectory(input.environment, customersPath);
        // The generator answers with the directory it filled. That directory
        // carries the asset and the snapshot below the one this process asked
        // for, and the layout of those levels belongs to the generator.
        return await writeCustomerPackages({
          repository: input.repository,
          contextFile: contextPath,
          customersFile: customersPath,
          outputDirectory: directory,
          // The secret is read here and passed on in the same expression, as it
          // is for the proof. It reaches no variable of this package.
          masterSecret: await readMasterSecret(input.environment),
          network: input.reader.config.network,
          registry,
          attestedRoot: record.attestation.finalRoot,
          attestedSnapshot: record.attestation.snapshotLedger,
          transactionHash: accepted.transactionHash,
          deploymentsFile: deploymentsPath(input.environment),
        });
      },
    });
  };

  const result = input.store.startOrJoin({
    action,
    asset: context.asset,
    snapshotLedger: context.snapshotLedger,
    work,
  });
  if (result.started) {
    input.log({
      event: "run.started",
      run: result.run.id,
      action,
      asset: context.asset,
      snapshot_ledger: context.snapshotLedger,
      registry,
      context_file: contextPath,
      customers_file: customersPath,
    });
  }
  return result;
}

/**
 * How many files this process finds in the directory that a run wrote.
 *
 * The generator answers with the directory and with no count. A count that this
 * process reads is a count of what is there, and the log names it that way. A
 * directory that cannot be read gives no count, because a wrong count would
 * read as a statement about the run.
 */
async function countPackageFiles(directory: string): Promise<number | undefined> {
  try {
    return (await readdir(directory)).length;
  } catch {
    return undefined;
  }
}
