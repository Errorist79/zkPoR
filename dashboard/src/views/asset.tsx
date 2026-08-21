/**
 * The solvency page of one asset.
 *
 * The headline states the status and carries neither reserve number. The two
 * numbers live in two sibling sections below it, each with its own name and its
 * own ledger. Inclusion and the currency of the solvency claim are different
 * claims, so a lapsed window is its own outcome here and never a failure.
 */

import { toHex } from "@zkpor/sdk";
import { ASSET_PARAMETER, ROUTES, SECTION_IDS } from "../constants.js";
import type { AssetView, HistoryView, SolvencyResult } from "../model.js";
import { Layout } from "./layout.js";
import { AttestedReservesSection, ObservedReservesSection } from "./reserves.js";

/**
 * The form that asks for an asset address.
 *
 * The page offers no list and it states why. The registry answers about one
 * asset at a time: every one of its reads takes an asset address, and it holds
 * no index that a reader could walk. So the address is something the reader
 * brings, and a page that presented an empty field as a choice would ask for
 * something it never had.
 */
export function Home(input: { reason?: string }) {
  return (
    <Layout title="zkPoR dashboard">
      <h1>Open an asset</h1>
      <p>
        Give the address of an asset that somebody registered with this registry. The registry
        answers about one asset at a time and it keeps no list, so this page cannot offer one.
      </p>
      {input.reason === undefined ? null : <p className="failure">{input.reason}</p>}
      <form method="get" action={ROUTES.asset}>
        <label htmlFor={ASSET_PARAMETER}>The address of a registered asset</label>
        <input id={ASSET_PARAMETER} name={ASSET_PARAMETER} required autoComplete="off" />
        <p className="limit">
          An account address or a contract address, which starts with G or with C. The registry
          address in the frame above is not one of these.
        </p>
        <button type="submit">Show the solvency result</button>
      </form>
    </Layout>
  );
}

/**
 * The headline of the solvency result.
 *
 * It names the coverage and the currency, and it holds no sum. A reader who
 * wants a number reads it under the name of the ledger that produced it.
 */
function Headline(input: { solvency: SolvencyResult | undefined }) {
  if (input.solvency === undefined) {
    return (
      <section id={SECTION_IDS.headline}>
        <h2>No attestation</h2>
        <p>The registry holds a record of this asset and no attestation, so it makes no solvency claim.</p>
      </section>
    );
  }
  const { solvency } = input;
  return (
    <section id={SECTION_IDS.headline} className={`coverage-${solvency.coverage} claim-${solvency.currency}`}>
      <h2>
        {solvency.coverage === "reserves-reach-liabilities"
          ? "The attested reserves reach the attested liabilities."
          : "The attested reserves fall short of the attested liabilities."}
      </h2>
      <p>
        {solvency.currency === "current"
          ? `The solvency claim is current. The snapshot ledger is ${solvency.snapshotLedger} and the current ledger is ${solvency.currentLedger}.`
          : `The solvency claim has lapsed. The snapshot ledger is ${solvency.snapshotLedger}, the current ledger is ${solvency.currentLedger}, and the snapshot is older than the window.`}
      </p>
      {solvency.currency === "lapsed" ? (
        <p>
          A lapsed claim is not a failure. The attestation still stands for the ledger it names, and
          a fresher attestation replaces it.
        </p>
      ) : null}
      <p className="limit">
        The claim holds at ledger {solvency.attested.attestedLedger} and at no other ledger. The registry
        read the balances inside that one transaction.
      </p>
    </section>
  );
}

/** The registration record: who may attest, and which addresses hold the reserve. */
function Registration(input: { view: AssetView }) {
  const { record } = input.view;
  return (
    <section id={SECTION_IDS.registration}>
      <h2>The registration</h2>
      <dl>
        <dt>Authority</dt>
        <dd className="address">{record.authority}</dd>
        <dt>Tier</dt>
        <dd>
          {record.tier === "ClassicIssuer"
            ? "The classic issuer tier. The authority is the issuer of the asset."
            : "The contract administrator tier. The authority is the administrator that the token names."}
        </dd>
        <dt>Reserve set hash</dt>
        <dd className="figure">{toHex(record.reserveSetHash)}</dd>
      </dl>
      <h3>Reserve addresses</h3>
      <ul>
        {record.reserves.map((address) => (
          <li key={address} className="address">
            {address}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The record of the earlier attestations, with the bound of the query. */
function History(input: { history: HistoryView | undefined }) {
  if (input.history === undefined) {
    return null;
  }
  const { history } = input;
  return (
    <section id={SECTION_IDS.history}>
      <h2>Earlier attestations</h2>
      <p>
        The query covered the ledgers from {history.oldestLedgerCovered} to {history.latestLedger}.
        The endpoint retains the ledgers from {history.oldestLedgerRetained}.
      </p>
      {history.reachesTheRetentionLimit ? (
        <p className="limit">
          The query started at the oldest retained ledger. An earlier attestation can exist that this
          result does not name, so this is not the complete record.
        </p>
      ) : null}
      {!history.coversTheWholeRange ? (
        <p className="limit">
          The endpoint stopped before the end of the range, so this page cannot say whether the
          range holds an attestation that the table does not name.
        </p>
      ) : null}
      {history.entries.length === 0 ? (
        <p>
          {history.coversTheWholeRange
            ? "The query found no attestation in that range."
            : "The query saw no attestation before the endpoint stopped."}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Snapshot ledger</th>
              <th scope="col">Attested ledger</th>
              <th scope="col">Total liabilities</th>
              <th scope="col">Reserves at the attestation</th>
              <th scope="col">Result</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {history.entries.map((entry) => (
              <tr key={entry.transactionHash}>
                <td>{entry.snapshotLedger}</td>
                <td>{entry.attested.attestedLedger}</td>
                <td className="figure">{entry.totalLiabilities.toString(10)}</td>
                <td className="figure">{entry.attested.sum.toString(10)}</td>
                <td>
                  {entry.coverage === "reserves-reach-liabilities" ? "Reserves reach" : "Reserves fall short"}
                </td>
                <td className="address">{entry.transactionHash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="limit">
        Weigh the record of repeated attestations over any single one. A single attestation proves
        the balances at one ledger that the authority chose.
      </p>
    </section>
  );
}

/** The whole page of one asset. */
export function AssetPage(input: { view: AssetView; history: HistoryView | undefined }) {
  const { view } = input;
  return (
    <Layout title={`zkPoR: ${view.asset}`}>
      <h1 className="address">{view.asset}</h1>
      <p>
        The network is {view.network}. The registry is <span className="address">{view.registry}</span>.
      </p>
      <Headline solvency={view.solvency} />
      {view.solvency === undefined ? null : (
        <>
          <AttestedReservesSection solvency={view.solvency} />
          <p>
            The attested root is <span className="figure">{toHex(view.solvency.finalRoot)}</span>.
          </p>
        </>
      )}
      <ObservedReservesSection
        observed={view.observed}
        failure={view.observationFailure}
        diagnosis={view.diagnosis}
      />
      <Registration view={view} />
      <History history={input.history} />
    </Layout>
  );
}

/** The page for an address that the registry holds no record of. */
export function UnregisteredAssetPage(input: { asset: string; registry: string }) {
  return (
    <Layout title={`zkPoR: ${input.asset}`}>
      <h1 className="address">{input.asset}</h1>
      <p>
        The registry <span className="address">{input.registry}</span> holds no record of this
        asset. That is an answer from the registry, and not a failure of this dashboard.
      </p>
      <p>
        <a href={ROUTES.home}>Choose another asset</a>
      </p>
    </Layout>
  );
}
