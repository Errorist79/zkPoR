/**
 * The solvency page of one asset.
 *
 * The headline states the status and carries neither reserve number. The two
 * numbers live in two sibling sections below it, each with its own name and its
 * own ledger. Inclusion and the currency of the solvency claim are different
 * claims, so a lapsed window is its own outcome here and never a failure.
 */

import { groupedDigits, toHex } from "@zkpor/sdk";
import { ASSET_PARAMETER, ROUTES, SECTION_IDS } from "../constants.js";
import type {
  AssetView,
  HistoryBlock,
  HistoryEntry,
  HistoryView,
  SolvencyResult,
} from "../model.js";
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
        Give the address of an asset that somebody registered. A registry answers about one asset
        at a time and keeps no list, so this page cannot offer one.
      </p>
      <p className="limit">
        A generation is one deployment of the registry and its verifier. A network carries several
        over time, and each keeps the assets that registered under it, so an asset lives on the
        generation it registered with rather than on the newest. An issuer may register the same
        asset again on a newer generation, and both records then stand. This dashboard asks each
        recorded generation, newest first, and answers from the one that holds the asset you name.
      </p>
      {input.reason === undefined ? null : <p className="failure">{input.reason}</p>}
      <form method="get" action={ROUTES.asset}>
        <label htmlFor={ASSET_PARAMETER}>The address of a registered asset</label>
        <input id={ASSET_PARAMETER} name={ASSET_PARAMETER} required autoComplete="off" />
        <p className="limit">
          An account address or a contract address, which starts with G or with C. A registry
          address is not one of these.
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

/**
 * The record of the earlier attestations, one block for each generation.
 *
 * An issuer who registered again after a migration holds attestations on two
 * registries. A page that showed one of them would be true and would read as
 * the whole record, so every recorded generation gets a block and each block
 * names the registry that answered it.
 */
function History(input: { history: HistoryView | undefined }) {
  if (input.history === undefined) {
    return null;
  }
  return (
    <section id={SECTION_IDS.history}>
      <h2>Earlier attestations</h2>
      <p className="limit">
        This section covers the {input.history.blocks.length} recorded generations of this network,
        over the ledgers that each query names below. Each query starts at the oldest ledger that
        the endpoint keeps, and the endpoint holds nothing before that ledger. So this section shows
        every attestation that the endpoint can still serve. It does not show the whole history of
        this asset, because the asset can carry earlier attestations that no query reaches.
      </p>
      {input.history.blocks.filter(answered).map((block) => (
        <HistoryOfRegistry key={block.registry} block={block} />
      ))}
      <SilentRegistries blocks={input.history.blocks.filter((block) => !answered(block))} />
      <p className="limit">
        Weigh the record of repeated attestations over any single one. A single attestation proves
        the balances at one ledger that the authority chose.
      </p>
    </section>
  );
}


/**
 * True when a block earns its own place on the page.
 *
 * A block with an attestation does. So does an empty block whose emptiness is
 * not established, because a query that could not cover its range reports that
 * it does not know rather than that there is nothing, and the two must not look
 * alike.
 *
 * An empty block that read its whole range holds a settled nothing. It goes to
 * one line with the others, because a heading naming a registry gives an empty
 * answer the weight of a real one, and a reader can take it for evidence of
 * some relation between that registry and this asset.
 *
 * Reaching the oldest retained ledger no longer keeps a block. Every query
 * starts there now, so that test kept every empty block and gave each one a
 * heading. The statement it protected did not disappear: the line above the
 * blocks says once that the asset can carry earlier attestations that no query
 * reaches.
 */
function answered(block: HistoryBlock): boolean {
  return block.entries.length > 0 || !block.coversTheWholeRange;
}

/**
 * The generations that were asked and held nothing.
 *
 * The line names every one of them, so a reader counts the generations here
 * against the count in the scope statement above and finds them all.
 */
function SilentRegistries(input: { blocks: readonly HistoryBlock[] }) {
  if (input.blocks.length === 0) {
    return null;
  }
  return (
    <p>
      These registries were asked and hold no attestation of this asset in that range:{" "}
      {input.blocks.map((block, position) => (
        <span key={block.registry}>
          {position > 0 ? ", " : ""}
          <span className="address">{block.registry}</span>
        </span>
      ))}
      .
    </p>
  );
}

/** One generation's answer about one asset. */
function HistoryOfRegistry(input: { block: HistoryBlock }) {
  const { block } = input;
  return (
    <div className="generation">
      <h3>
        The registry <span className="address">{block.registry}</span>
      </h3>
      <p>
        The query covered the ledgers from {block.oldestLedgerCovered} to {block.latestLedger}. The
        endpoint retains the ledgers from {block.oldestLedgerRetained}.
      </p>
      {block.reachesTheRetentionLimit ? (
        <p className="limit">
          The query started at the oldest retained ledger. An earlier attestation can exist that this
          result does not name, so this is not the complete record.
        </p>
      ) : null}
      {!block.coversTheWholeRange ? (
        <p className="limit">
          The endpoint stopped before the end of the range, so this page cannot say whether the
          range holds an attestation that the table does not name.
        </p>
      ) : null}
      {block.entries.length === 0 ? (
        <p>
          {block.coversTheWholeRange
            ? "This registry holds no attestation of this asset in that range."
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
            {block.entries.map((entry: HistoryEntry) => (
              <tr key={entry.transactionHash}>
                <td>{entry.snapshotLedger}</td>
                <td>{entry.attested.attestedLedger}</td>
                <td className="figure">{groupedDigits(entry.totalLiabilities)}</td>
                <td className="figure">{groupedDigits(entry.attested.sum)}</td>
                <td>
                  {entry.coverage === "reserves-reach-liabilities"
                    ? "Reserves reach"
                    : "Reserves fall short"}
                </td>
                <td className="address">{entry.transactionHash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The whole page of one asset. */
export function AssetPage(input: { view: AssetView; history: HistoryView | undefined }) {
  const { view } = input;
  return (
    <Layout title={`zkPoR: ${view.asset}`}>
      <h1 className="address">{view.asset}</h1>
      <p>
        The network is {view.network}. This record comes from the registry{" "}
        <span className="address">{view.registry}</span>, which is the generation that holds this
        asset.
      </p>
      <AskedRegistries asked={view.asked} answered={view.registry} />
      <Headline solvency={view.solvency} />
      <p className="limit">
        Every figure on this page is a balance in the smallest unit that the asset uses, exactly as
        the registry holds it. This dashboard applies no decimal place of its own, so a classic
        Stellar asset reads here in stroops, which are ten million to the unit.
      </p>
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

/**
 * The generations this dashboard asked before one answered.
 *
 * Without it a reader learns how this client works only when it fails, because
 * the dead end explains the walk and the success page did not. The line is
 * silent when the first generation answered, since naming one registry twice
 * teaches nothing.
 */
function AskedRegistries(input: { asked: readonly string[]; answered: string }) {
  const others = input.asked.filter((registry) => registry !== input.answered);
  if (others.length === 0) {
    return null;
  }
  return (
    <p className="limit">
      This dashboard asked{" "}
      {others.map((registry, position) => (
        <span key={registry}>
          {position > 0 ? ", " : ""}
          <span className="address">{registry}</span>
        </span>
      ))}{" "}
      first, and {others.length === 1 ? "it holds" : "they hold"} no record of this asset.
    </p>
  );
}

/** The page for an address that no recorded generation holds. */
export function UnregisteredAssetPage(input: { asset: string; asked: readonly string[] }) {
  return (
    <Layout title={`zkPoR: ${input.asset}`}>
      <h1 className="address">{input.asset}</h1>
      <p>
        No recorded generation holds this asset. That is an answer from the registries, and not a
        failure of this dashboard.
      </p>
      <p>
        This dashboard asked{" "}
        {input.asked.map((registry, position) => (
          <span key={registry}>
            {position > 0 ? ", " : ""}
            <span className="address">{registry}</span>
          </span>
        ))}
        .
      </p>
      <p>
        <a href={ROUTES.home}>Choose another asset</a>
      </p>
    </Layout>
  );
}
