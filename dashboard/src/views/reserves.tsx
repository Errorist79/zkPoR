/**
 * Attested reserves, live simulations, and recorded observations remain separate.
 *
 * The registry produces a sum that an attestation covers and a sum that nothing
 * covers. There is deliberately no component here that takes "a reserve sum".
 * Each component takes a specific type and writes its own name,
 * ledger, and statement about what covers the number. A future
 * edit that wants to show one number therefore has to choose which one it
 * means.
 */

import { groupedDigits, toHex } from "@zkpor/sdk";
import type { ReserveDiagnosis, StoredReserveObservation } from "@zkpor/sdk";
import { SECTION_IDS } from "../constants.js";
import type { ObservedReserves, RecordedObservationView, SolvencyResult } from "../model.js";

/** The attested pair: the liabilities the proof commits to, and the reserves the registry read. */
export function AttestedReservesSection(input: { solvency: SolvencyResult }) {
  const { solvency } = input;
  return (
    <section id={SECTION_IDS.attestedReserves}>
      <h2>Reserves at the attestation, at ledger {solvency.attested.attestedLedger}</h2>
      <p>
        The registry read the reserve balances inside the attestation transaction. An accepted
        attestation covers this number and the liabilities beside it.
      </p>
      <dl>
        <dt>Reserves at the attestation</dt>
        <dd className="figure">{groupedDigits(solvency.attested.sum)}</dd>
        <dt>Total liabilities under the attested root</dt>
        <dd className="figure">{groupedDigits(solvency.totalLiabilities)}</dd>
      </dl>
      <p>
        {solvency.coverage === "reserves-reach-liabilities"
          ? "The reserves reach the liabilities at that ledger."
          : "The reserves fall short of the liabilities at that ledger."}
      </p>
      <p className="limit">
        The registry records the two numbers and compares neither against the other. This dashboard
        makes the comparison, over one attestation record. The two are not bound to their ledger in
        the same way: the registry read the reserves on chain inside the attestation, and the issuer
        asserted the liabilities for that ledger with nothing on chain checking that the balances
        belong to it.
      </p>
    </section>
  );
}

/** The observation: a current reading that no attestation covers. */
export function ObservedReservesSection(input: {
  observed: ObservedReserves | undefined;
  failure: string | undefined;
  diagnosis: ReserveDiagnosis | undefined;
}) {
  return (
    <section id={SECTION_IDS.observedReserves}>
      <h2>Reserves observed now</h2>
      <p>
        This live simulation creates no stored observation. No attestation covers this reading.
        It is not part of any solvency claim on this page.
      </p>
      {input.observed === undefined ? (
        <ObservationFailure failure={input.failure} diagnosis={input.diagnosis} />
      ) : (
        <dl>
          <dt>Ledger of the observation</dt>
          <dd>{input.observed.observedLedger}</dd>
          <dt>Reserves observed now</dt>
          <dd className="figure">{groupedDigits(input.observed.sum)}</dd>
        </dl>
      )}
    </section>
  );
}

/** Recorded transactions and the permanent first-low marker, separate from live reserves. */
export function RecordedObservationsSection(input: { observations: RecordedObservationView }) {
  const { observations } = input;
  return (
    <section id={SECTION_IDS.recordedObservations}>
      <h2>Recorded reserve observations</h2>
      <p>These observations come from accepted transactions. The live simulation above does not add to them.</p>
      {observations.kind === "unsupported" ? (
        <p className="limit">This registry does not support recorded observations. Its history and first-low status are unavailable.</p>
      ) : observations.kind === "failed" ? (
        <div className="failure">
          {observations.firstLowId === undefined ? null : (
            <p>Permanent first-low marker: observation {observations.firstLowId.toString()}. Its record details are unavailable.</p>
          )}
          <p>The recorded status could not be read completely. {observations.reason}</p>
        </div>
      ) : (
        <>
          <p>Stored observations: {observations.status.observationCount.toString()}.</p>
          {observations.firstLow === undefined ? (
            <p>No stored observation has set the first-low marker. This does not establish continuous reserve coverage.</p>
          ) : (
            <div className="failure">
              <h3>Permanent first-low observation</h3>
              <p>This observation fell below the referenced attested reserve sum. Later observations, attestations, or reserve changes do not clear this marker.</p>
              <p>A lower reserve sum does not establish insolvency.</p>
              <StoredObservationDetails observation={observations.firstLow} />
            </div>
          )}
          {observations.latest === undefined ? (
            <p>No observation transaction is recorded.</p>
          ) : (
            <>
              <h3>Latest recorded observation</h3>
              <StoredObservationDetails observation={observations.latest} />
            </>
          )}
        </>
      )}
    </section>
  );
}

function StoredObservationDetails(input: { observation: StoredReserveObservation }) {
  const { observation } = input;
  return (
    <>
      <dl>
        <dt>Observation identifier</dt>
        <dd>{observation.observationId.toString()}</dd>
        <dt>Ledger of the recorded observation</dt>
        <dd>{observation.observedLedger}</dd>
        <dt>Recorded reserves</dt>
        <dd className="figure">{groupedDigits(observation.observedSum)}</dd>
        <dt>Reserve set hash</dt>
        <dd className="address">{toHex(observation.reserveSetHash)}</dd>
        <dt>Baseline attestation identifier</dt>
        <dd>{observation.attestationId?.toString() ?? "None"}</dd>
      </dl>
      <p>{observation.attestationId === undefined
        ? "This observation had no baseline attestation. No comparison with attested reserves was made."
        : observation.belowAttested
          ? "The recorded reserves fell below the referenced attested reserve sum."
          : "The recorded reserves did not fall below the referenced attested reserve sum."}</p>
    </>
  );
}

/**
 * The failure of an observation, with the address that broke the rule.
 *
 * The registry fails the whole call when one balance read fails, and it names
 * no address. The dashboard reads each address on its own after that failure,
 * because that read is the only one that can name the address.
 */
function ObservationFailure(input: {
  failure: string | undefined;
  diagnosis: ReserveDiagnosis | undefined;
}) {
  return (
    <>
      <p className="failure">
        The registry gave no observed sum.
        {input.failure === undefined ? "" : ` ${input.failure}`}
      </p>
      {input.diagnosis === undefined ? null : (
        <>
          <p>
            The dashboard read each reserve balance on its own. A failure below names the address
            that the registry cannot read.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Reserve address</th>
                <th scope="col">Balance now</th>
              </tr>
            </thead>
            <tbody>
              {input.diagnosis.readings.map((reading) => (
                <tr key={reading.address}>
                  <td className="address">{reading.address}</td>
                  <td>
                    {reading.balance === undefined ? (
                      <span className="failure">{reading.failure ?? "the read gave no balance"}</span>
                    ) : (
                      groupedDigits(reading.balance)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            The authority repairs a reserve set with <code>set_reserves</code>, which collects the
            consent of every address again.
          </p>
        </>
      )}
    </>
  );
}
