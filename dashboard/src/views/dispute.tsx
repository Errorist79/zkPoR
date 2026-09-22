import { toHex } from "@zkpor/sdk";
import type { Generation } from "@zkpor/sdk";
import { DISPUTE_ADDRESS_PREVIEW_LENGTH, DISPUTE_DEPOSIT_LABEL, DISPUTE_FIELDS, ROUTES, SECTION_IDS } from "../constants.js";
import { disputePath } from "../dispute.js";
import type { DisputeSelection, DisputeView } from "../dispute.js";
import { Layout } from "./layout.js";

function registryLabel(entry: Generation, index: number): string {
  const start = entry.registry.slice(0, DISPUTE_ADDRESS_PREVIEW_LENGTH);
  const end = entry.registry.slice(-DISPUTE_ADDRESS_PREVIEW_LENGTH);
  return `Registry ${index + 1}: ${start}…${end}`;
}

function DisputeInput(input: {
  name: string;
  label: string;
  help: string;
  value?: string;
  inputMode?: "numeric";
}) {
  const helpId = `${input.name}-help`;
  return <div className="dispute-field">
    <label htmlFor={input.name}>{input.label}</label>
    <input id={input.name} name={input.name} defaultValue={input.value}
      inputMode={input.inputMode} aria-describedby={helpId} autoComplete="off" spellCheck={false} required />
    <p id={helpId} className="dispute-help">{input.help}</p>
  </div>;
}

export function DisputeForm(input: {
  generations: readonly Generation[];
  reason?: string;
  fields?: URLSearchParams;
}) {
  return <Layout title="Find a dispute">
    <div className="dispute-page">
      <h1>Find a dispute</h1>
      <p className="dispute-intro">Check one customer's dispute against one fixed attestation, then see its outcome and next steps.</p>
      <section className="dispute-lookup" aria-labelledby="dispute-lookup-heading">
        <h2 id="dispute-lookup-heading">Dispute details</h2>
        <p>Use the values supplied when the dispute opened. This lookup does not open a dispute or move funds.</p>
        {input.reason === undefined ? null : <p className="failure" role="alert">{input.reason}</p>}
        <form method="get" action={ROUTES.dispute}>
          <div className="dispute-field">
            <label htmlFor={DISPUTE_FIELDS.registry}>Registry</label>
            <select id={DISPUTE_FIELDS.registry} name={DISPUTE_FIELDS.registry}
              defaultValue={input.fields?.get(DISPUTE_FIELDS.registry) ?? ""} aria-describedby="registry-help" required>
              <option value="" disabled>Select the dispute's registry</option>
              {input.generations.map((entry, index) => <option key={entry.registry} value={entry.registry}>
                {registryLabel(entry, index)}
              </option>)}
            </select>
            <p id="registry-help" className="dispute-help">Use the registry that received the dispute. For package evidence, copy the package's registry field.</p>
            <details className="dispute-registry-details">
              <summary>Compare full registry addresses</summary>
              {input.generations.length === 0 ? <p>No trusted registry is configured for this network.</p> : <dl>
                {input.generations.map((entry, index) => <div key={entry.registry}>
                  <dt>{registryLabel(entry, index)}</dt><dd className="address">{entry.registry}</dd>
                </div>)}
              </dl>}
            </details>
          </div>
          <DisputeInput name={DISPUTE_FIELDS.asset} label="Asset address"
            value={input.fields?.get(DISPUTE_FIELDS.asset) ?? ""}
            help="Use the asset address supplied when the dispute opened. A customer package stores it as asset. Do not enter a wallet address." />
          <div className="dispute-field-pair">
            <DisputeInput name={DISPUTE_FIELDS.targetId} label="Target attestation ID" inputMode="numeric"
              value={input.fields?.get(DISPUTE_FIELDS.targetId) ?? ""}
              help="Use the target ID from the watchdog output or opening request. The older evidence package can name a different attestation." />
            <DisputeInput name={DISPUTE_FIELDS.identifier} label="Customer identifier"
              value={input.fields?.get(DISPUTE_FIELDS.identifier) ?? ""}
              help="Use the package's id field, or the hexadecimal identifier supplied for an email dispute. Keep the 0x prefix. Do not enter email or code." />
          </div>
          <button type="submit" disabled={input.generations.length === 0}>Check dispute status</button>
        </form>
      </section>
      <p className="limit">A failed read is not proof that no dispute exists.</p>
    </div>
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

function outcome(view: DisputeView): {
  title: string;
  explanation: string;
  deposit: string;
  next: readonly string[];
  limit: string;
  bond?: string;
} {
  const { dispute } = view;
  if (dispute === undefined) {
    return {
      title: "No dispute found for these details",
      explanation: "The registry holds no dispute for this exact target and customer identifier.",
      deposit: "This lookup found no dispute. It does not report a deposit payment or refund.",
      next: ["Check the registry, asset, target attestation ID, and identifier against the values used to open the dispute.",
        "If you expected a dispute, confirm that its opening transaction succeeded."],
      limit: "A missing dispute does not confirm customer inclusion or reserve coverage.",
    };
  }
  switch (dispute.status) {
    case "Open": {
      const expired = view.currentLedger > dispute.deadline;
      return {
        title: expired ? "The answer window closed. Resolution is pending." : "Waiting for the issuer's answer",
        explanation: expired
          ? "The dispute remains open until a resolution transaction settles. The issuer can no longer submit an answer."
          : view.currentLedger === dispute.deadline
            ? "The current ledger is the last ledger that permits an answer. Check the status again before you submit."
            : "The dispute is open. The issuer can still submit an inclusion answer for this fixed target.",
        deposit: `The registry holds the ${DISPUTE_DEPOSIT_LABEL} deposit while the dispute is open. No settlement is recorded yet.`,
        next: expired
          ? ["Anyone can submit a resolution transaction for this exact dispute through the SDK.",
            "Refresh this status after the transaction settles. This page does not submit a resolution."]
          : ["Issuer: use the retained tree for this target in the answer form below.",
            "Customer: keep your package and check this status again."],
        limit: "An accepted answer confirms inclusion in this target attestation. It does not confirm that the customer's balance is correct.",
      };
    }
    case "Answered":
      return {
        title: "Inclusion confirmed for this customer",
        explanation: "The registry accepted the issuer's answer under the fixed target root. This dispute is closed.",
        deposit: `The registry paid the ${DISPUTE_DEPOSIT_LABEL} deposit to the issuer when it accepted the answer.`,
        next: ["Customer: obtain the package for this target from the issuer and check it against your own records.",
          "Issuer: provide that package to the customer. This dispute needs no further answer."],
        limit: "The answer proves inclusion of this identifier under this target. It does not confirm that the customer's balance is correct.",
      };
    case "OmissionProven":
      return {
        title: "Dispute resolved after no accepted answer",
        explanation: "The registry settled the dispute after the answer deadline. This dispute is closed.",
        deposit: `The registry returned the ${DISPUTE_DEPOSIT_LABEL} deposit to the disputer. The disputer received no bounty.`,
        bond: dispute.burnedBond === 0n
          ? "No bond was available to burn for this dispute."
          : "The available bond is permanently locked and recorded as burned.",
        next: ["Keep the dispute outcome with your records. This dispute cannot reopen or settle again."],
        limit: "This outcome follows the lack of an accepted answer. It is not a cryptographic proof that the customer was absent.",
      };
  }
}

export function DisputePage({ view }: { view: DisputeView }) {
  const { selection, dispute, target } = view;
  const canAnswer = dispute?.status === "Open" && view.currentLedger <= dispute.deadline;
  const result = outcome(view);
  return <Layout title="Dispute status">
    <div className="dispute-page">
      <h1>Dispute status</h1>
      <p className="dispute-intro">Target attestation {selection.targetId.toString()}. This result applies only to the selected customer and registry.</p>
      <section id={SECTION_IDS.dispute} className={`dispute-outcome${dispute?.status === "Answered" ? " dispute-answered" : ""}`}
        aria-labelledby="dispute-outcome-heading">
        <h2 id="dispute-outcome-heading">{result.title}</h2>
        <p>{result.explanation}</p>
        <div className="dispute-guidance">
          <div>
            <h3>The {DISPUTE_DEPOSIT_LABEL} deposit</h3>
            <p>{result.deposit}</p>
            {result.bond === undefined ? null : <p>{result.bond}</p>}
          </div>
          <div>
            <h3>What to do next</h3>
            <ul>{result.next.map((step) => <li key={step}>{step}</li>)}</ul>
          </div>
        </div>
        <p className="limit">{result.limit}</p>
      </section>
      {canAnswer ? <section className="dispute-answer" aria-labelledby="dispute-answer-heading">
        <h2 id="dispute-answer-heading">Issuer: answer this dispute</h2>
        <p>Use the retained tree for target attestation {selection.targetId.toString()}. The process checks it against the fixed target before it signs.</p>
        <form method="post" action={ROUTES.answer}>
          <SelectionFields selection={selection} />
          <DisputeInput name={DISPUTE_FIELDS.manifestPath} label="Retained generation.json path"
            help="Enter the absolute path on this machine to the retained generation.json for this target. Do not use a customer package." />
          <p className="dispute-signing">This action signs and sends a transaction with the configured issuer key on this machine.</p>
          <button type="submit">Build and submit answer</button>
        </form>
        <p className="limit">The answer reveals the identifier, commitment, position, and path. It does not reveal the balance or salt.</p>
      </section> : null}
      <details className="dispute-technical">
        <summary>Technical details and full identifiers</summary>
        <dl>
          <dt>Registry</dt><dd className="address"><code>{selection.registry}</code></dd>
          <dt>Asset</dt><dd className="address"><code>{selection.asset}</code></dd>
          <dt>Target attestation ID</dt><dd>{selection.targetId.toString()}</dd>
          <dt>Customer identifier</dt><dd className="address"><code>{toHex(selection.identifier)}</code></dd>
          <dt>Ledger at this check</dt><dd>{view.currentLedger}</dd>
          {dispute === undefined ? null : <>
            <dt>Contract status</dt><dd><code>{dispute.status}</code></dd>
            <dt>Disputer</dt><dd className="address"><code>{dispute.disputer}</code></dd>
            <dt>Evidence origin</dt><dd>{dispute.origin.kind === "inclusion"
              ? `Inclusion at attestation ${dispute.origin.attestationId}` : `Email under registered key ${dispute.origin.keyId}`}</dd>
            <dt>Opened ledger</dt><dd>{dispute.openedLedger}</dd>
            <dt>Answer deadline, inclusive</dt><dd>{dispute.deadline}</dd>
            <dt>First resolution ledger</dt><dd>{dispute.deadline + 1}</dd>
            <dt>Closed ledger</dt><dd>{dispute.status === "Open" ? "Not closed" : dispute.closedLedger}</dd>
            <dt>Burned bond, stroops</dt><dd>{dispute.burnedBond.toString()}</dd>
          </>}
          {target === undefined ? null : <><dt>Target root</dt><dd className="address"><code>{toHex(target.finalRoot)}</code></dd></>}
        </dl>
      </details>
      <p className="dispute-links"><a href={disputePath(selection)}>Refresh status</a><a href={ROUTES.dispute}>Find another dispute</a></p>
    </div>
  </Layout>;
}
