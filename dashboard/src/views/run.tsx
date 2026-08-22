/**
 * The attestation form and the page of one run.
 *
 * A run takes minutes. The page of an open run carries a pragma directive that
 * reloads it, so the reader watches progress without any script. The directive
 * is present while the run is open and absent once it ends, so a finished page
 * stops reloading itself.
 *
 * The form takes two paths on this machine. It takes no key, no balance, and no
 * file content, so nothing sensitive travels in a request body.
 */

import { groupedDigits, ATTESTATION_MAX_AGE_LEDGERS, toHex } from "@zkpor/sdk";
import {
  RUN_FIELDS,
  RUN_REFRESH_SECONDS,
  ROUTES,
  SECTION_IDS,
} from "../constants.js";
import type { Run } from "../runs.js";
import { Layout } from "./layout.js";

/** The path of the page of one run. */
export function runPath(id: string): string {
  return `${ROUTES.run}/${id}`;
}

/** The form that starts a run. */
export function AttestationForm(input: { open: Run | undefined; reason?: string }) {
  return (
    <Layout title="zkPoR attestation">
      <h1>Prove and attest</h1>
      <p>
        The proof runs on this machine, with the pinned prover. The balance file and the context
        file stay on this machine, and this process reads them from the paths you give.
      </p>
      {input.reason === undefined ? null : <p className="failure">{input.reason}</p>}
      {input.open === undefined ? null : (
        <p className="limit">
          A run is open. A second run cannot start while it runs, so this form will take you to the
          open run. <a href={runPath(input.open.id)}>Open the run</a>.
        </p>
      )}
      <form method="post" action={ROUTES.run}>
        <label htmlFor={RUN_FIELDS.contextPath}>The path of the context file</label>
        <input id={RUN_FIELDS.contextPath} name={RUN_FIELDS.contextPath} required autoComplete="off" />
        <label htmlFor={RUN_FIELDS.customersPath}>The path of the customer balance file</label>
        <input
          id={RUN_FIELDS.customersPath}
          name={RUN_FIELDS.customersPath}
          required
          autoComplete="off"
        />
        <fieldset>
          <legend>What this run does</legend>
          <label className="choice">
            <input type="radio" name={RUN_FIELDS.action} value="prove" defaultChecked />
            Prove only. The run stops at the proof and submits nothing.
          </label>
          <label className="choice">
            <input type="radio" name={RUN_FIELDS.action} value="attest" />
            Prove and attest. The run sends the attestation to the generation that holds this
            asset.
          </label>
        </fieldset>
        <button type="submit">Start the run</button>
      </form>
      <h2>What this process needs before a run</h2>
      <p>
        The master secret and the authority key come from the environment of this process. No field
        above carries either one, and no page shows either one.
      </p>
    </Layout>
  );
}

/** The steps that a run has reported, newest last. */
function Steps(input: { run: Run }) {
  if (input.run.steps.length === 0) {
    return <p>The run has reported no step yet.</p>;
  }
  return (
    <ol>
      {input.run.steps.map((step, position) => (
        <li key={`${String(position)}-${step}`}>{step}</li>
      ))}
    </ol>
  );
}

/**
 * What one run produced.
 *
 * A failed run reaches this too, whenever the proof already existed. A run that
 * proved correctly and then missed the window by one ledger must still show the
 * root, the total, and the context hash, because a reader cannot get them back
 * any other way once the witness files are removed.
 */
function Produced(input: { run: Run }) {
  const { proof, submission, window, stage } = input.run;
  if (proof === undefined) {
    return null;
  }
  return (
    <>
      {stage === "failed" ? (
        <p className="limit">
          The proof finished and the run failed after it. The values below are the values that this
          proof commits to.
        </p>
      ) : null}
      <dl>
        <dt>Root</dt>
        <dd className="figure">{toHex(proof.finalRoot)}</dd>
        <dt>Total liabilities</dt>
        <dd className="figure">{groupedDigits(proof.totalLiabilities)}</dd>
        <dt>Context hash</dt>
        <dd className="figure">{toHex(proof.contextHash)}</dd>
        <dt>Proof size in bytes</dt>
        <dd>{groupedDigits(BigInt(proof.proofBytes))}</dd>
        {input.run.packages === undefined ? null : (
          <>
            <dt>The packages of the customers</dt>
            <dd className="address">{input.run.packages}</dd>
          </>
        )}
      </dl>
      {input.run.packages === undefined ? null : (
        <p>
          Each file in that directory holds the balance of one customer. Take one file and{" "}
          <a href={ROUTES.inclusion}>check it against the chain</a>. The check asks for the path of
          a file, so add a file name to the directory above. This page does not put the directory
          in that field, because a page that chose a file would choose whose balance to show.
        </p>
      )}
      {submission === undefined ? (
        <>
          <p>This run proved and submitted nothing.</p>
          {window === undefined ? null : window.stillOpen ? (
            <p>
              At ledger {window.currentLedger} the snapshot could still be attested. Start a run
              that attests to put this root on the registry, and start it soon, because the window
              closes at ledger {input.run.snapshotLedger + ATTESTATION_MAX_AGE_LEDGERS}.
            </p>
          ) : (
            <p className="failure">
              At ledger {window.currentLedger} the snapshot had already left its window, which
              closed at ledger {input.run.snapshotLedger + ATTESTATION_MAX_AGE_LEDGERS}. The
              registry refuses this root now. Take a fresh snapshot and prove again.
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            The registry <span className="address">{submission.registry}</span> accepted the
            attestation at ledger {submission.ledger}. The transaction is{" "}
            <span className="address">{submission.transactionHash}</span>.
          </p>
          <p>
            <a href={`${ROUTES.asset}?asset=${encodeURIComponent(input.run.asset)}`}>
              Open the solvency page of this asset
            </a>
          </p>
        </>
      )}
    </>
  );
}

/** The page of one run. */
export function RunPage(input: { run: Run; joined: boolean }) {
  const { run } = input;
  const running = run.stage === "running";
  return (
    <Layout
      title="zkPoR run"
      // The reader watches an open run without a script. A finished run carries
      // no directive, so the page stops reloading itself.
      refreshSeconds={running ? RUN_REFRESH_SECONDS : undefined}
    >
      <h1>{run.action === "attest" ? "Prove and attest" : "Prove only"}</h1>
      {input.joined ? (
        <p className="limit">
          A run was already open, so your submission started nothing. This page shows the run that
          was already open.
        </p>
      ) : null}
      <section id={SECTION_IDS.run} className={`run-${run.stage}`}>
        <h2>
          {running
            ? "The run is open."
            : run.stage === "finished"
              ? "The run finished."
              : "The run failed."}
        </h2>
        <dl>
          <dt>Asset</dt>
          <dd className="address">{run.asset}</dd>
          <dt>Snapshot ledger</dt>
          <dd>{run.snapshotLedger}</dd>
        </dl>
        {running ? (
          <p className="limit">
            The proof takes minutes. This page reloads itself every {RUN_REFRESH_SECONDS} seconds.
            Leave it open, or come back to this address.
          </p>
        ) : null}
        <h3>Steps</h3>
        <Steps run={run} />
        {run.failure === undefined ? null : (
          <>
            <h3>Why the run failed</h3>
            <p className="failure">{run.failure}</p>
          </>
        )}
        {run.proof === undefined ? null : (
          <>
            <h3>What the run produced</h3>
            <Produced run={run} />
          </>
        )}
      </section>
      <p>
        <a href={ROUTES.attestation}>Back to the form</a>
      </p>
    </Layout>
  );
}

/** The page for a run identity that this process no longer holds. */
export function ForgottenRunPage() {
  return (
    <Layout title="zkPoR run">
      <h1>This process holds no such run</h1>
      <p>
        A process remembers a bounded number of runs and it forgets the oldest one first. A restart
        forgets every run. The record of an accepted attestation is the registry, and not this page.
      </p>
      <p>
        <a href={ROUTES.attestation}>Back to the form</a>
      </p>
    </Layout>
  );
}
