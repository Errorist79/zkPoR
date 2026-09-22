import { toHex } from "@zkpor/sdk";
import type { Generation } from "@zkpor/sdk";
import { DISPUTE_FIELDS, ROUTES, SECTION_IDS } from "../constants.js";
import type { DisputeSelection, DisputeView } from "../dispute.js";
import { Layout } from "./layout.js";

export function DisputeForm(input: { generations: readonly Generation[]; reason?: string }) {
  return <Layout title="Dispute">
    <h1>Read a dispute</h1>
    <p>Use the fixed target attestation and customer identifier from the dispute.</p>
    {input.reason === undefined ? null : <p className="failure">{input.reason}</p>}
    <form method="get" action={ROUTES.dispute}>
      <label>Registry <select name={DISPUTE_FIELDS.registry} required>
        {input.generations.map((entry) => <option key={entry.registry} value={entry.registry}>{entry.registry}</option>)}
      </select></label>
      <label>Asset address <input name={DISPUTE_FIELDS.asset} required /></label>
      <label>Target attestation ID <input name={DISPUTE_FIELDS.targetId} inputMode="numeric" required /></label>
      <label>Customer identifier, canonical hexadecimal <input name={DISPUTE_FIELDS.identifier} required /></label>
      <button type="submit">Read dispute</button>
    </form>
    <p>A failed read is not proof that no dispute exists.</p>
  </Layout>;
}

function SelectionFields({ selection }: { selection: DisputeSelection }) {
  return <>
    <input type="hidden" name={DISPUTE_FIELDS.registry} value={selection.registry} />
    <input type="hidden" name={DISPUTE_FIELDS.asset} value={selection.asset} />
    <input type="hidden" name={DISPUTE_FIELDS.targetId} value={selection.targetId.toString()} />
    <input type="hidden" name={DISPUTE_FIELDS.identifier} value={toHex(selection.identifier)} />
  </>;
}

export function DisputePage({ view }: { view: DisputeView }) {
  const { selection, dispute, target } = view;
  const canAnswer = dispute?.status === "Open" && view.currentLedger <= dispute.deadline;
  return <Layout title="Dispute status">
    <h1>Dispute status</h1>
    <section id={SECTION_IDS.dispute}>
      <dl>
        <dt>Registry</dt><dd><code>{selection.registry}</code></dd>
        <dt>Asset</dt><dd><code>{selection.asset}</code></dd>
        <dt>Target attestation ID</dt><dd>{selection.targetId.toString()}</dd>
        <dt>Customer identifier</dt><dd><code>{toHex(selection.identifier)}</code></dd>
        <dt>Current ledger</dt><dd>{view.currentLedger}</dd>
      </dl>
      {dispute === undefined ? <p>The registry holds no dispute for this exact target and identifier.</p> : <>
        <h2>{dispute.status}</h2>
        <dl>
          <dt>Disputer</dt><dd><code>{dispute.disputer}</code></dd>
          <dt>Evidence origin</dt><dd>{dispute.origin.kind === "inclusion"
            ? `Inclusion at attestation ${dispute.origin.attestationId}` : `Email under registered key ${dispute.origin.keyId}`}</dd>
          <dt>Opened ledger</dt><dd>{dispute.openedLedger}</dd>
          <dt>Answer deadline, inclusive</dt><dd>{dispute.deadline}</dd>
          <dt>First resolution ledger</dt><dd>{dispute.deadline + 1}</dd>
          <dt>Closed ledger</dt><dd>{dispute.status === "Open" ? "Not closed" : dispute.closedLedger}</dd>
          <dt>Burned bond, stroops</dt><dd>{dispute.burnedBond.toString()}</dd>
          <dt>Target root</dt><dd><code>{target === undefined ? "Unavailable" : toHex(target.finalRoot)}</code></dd>
        </dl>
        {dispute.status === "Answered" ? <p>The registry accepted an inclusion answer for this fixed target.</p> : null}
        {dispute.status === "OmissionProven" ? <p>The answer deadline passed without an accepted answer. This is a protocol outcome, not a cryptographic proof of omission.</p> : null}
        {dispute.status === "Open" && !canAnswer ? <p>The answer deadline passed. The dispute remains open until a resolution transaction settles.</p> : null}
      </>}
    </section>
    {canAnswer ? <section>
      <h2>Answer from the retained tree</h2>
      <p>This action signs a transaction with the configured issuer key.</p>
      <p>The answer reveals the identifier, commitment, position, and path. It does not reveal the balance or salt.</p>
      <form method="post" action={ROUTES.answer}>
        <SelectionFields selection={selection} />
        <label>Retained generation.json path <input name={DISPUTE_FIELDS.manifestPath} required /></label>
        <button type="submit">Build and submit answer</button>
      </form>
    </section> : null}
    <p><a href={ROUTES.dispute}>Read another dispute</a></p>
  </Layout>;
}
