/**
 * The two reserve numbers, in two sections that never merge.
 *
 * The registry produces a sum that an attestation covers and a sum that nothing
 * covers. There is deliberately no component here that takes "a reserve sum".
 * Each component takes one of the two types, and each writes its own name, its
 * own ledger, and its own statement about what covers the number. A future
 * edit that wants to show one number therefore has to choose which one it
 * means.
 */

import type { ReserveDiagnosis } from "@zkpor/sdk";
import { SECTION_IDS } from "../constants.js";
import type { ObservedReserves, SolvencyResult } from "../model.js";

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
        <dd className="figure">{solvency.attested.sum.toString(10)}</dd>
        <dt>Total liabilities under the attested root</dt>
        <dd className="figure">{solvency.totalLiabilities.toString(10)}</dd>
      </dl>
      <p>
        {solvency.coverage === "reserves-reach-liabilities"
          ? "The reserves reach the liabilities at that ledger."
          : "The reserves fall short of the liabilities at that ledger."}
      </p>
      <p className="limit">
        The registry records the two numbers and compares neither against the other. This dashboard
        makes the comparison, over one attestation record.
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
        No attestation covers this reading. It is a reading at the ledger it names, and it is not
        part of any solvency claim on this page.
      </p>
      {input.observed === undefined ? (
        <ObservationFailure failure={input.failure} diagnosis={input.diagnosis} />
      ) : (
        <dl>
          <dt>Ledger of the observation</dt>
          <dd>{input.observed.observedLedger}</dd>
          <dt>Reserves observed now</dt>
          <dd className="figure">{input.observed.sum.toString(10)}</dd>
        </dl>
      )}
    </section>
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
                      reading.balance.toString(10)
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
