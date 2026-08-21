/**
 * The customer inclusion page.
 *
 * The page states no outcome of its own. It calls the kit, which is the same
 * function that the command line calls, and it prints the lines that the kit
 * writes. It also prints the exit code of the outcome, so a reader can match a
 * page against a command line run over the same package.
 *
 * The form takes the path of a package on this machine. The dashboard reads the
 * file with the kit, so the package never travels in a request body, and the
 * one process that reads it is the process the customer started.
 */

import { exitCode, verdictLines } from "@zkpor/sdk";
import type { Verdict } from "@zkpor/sdk";
import { PACKAGE_PATH_FIELD, ROUTES, SECTION_IDS } from "../constants.js";
import { Layout } from "./layout.js";

/** The statement that a package reveals a balance. Every page of this flow carries it. */
function BalanceWarning() {
  return (
    <p className="limit">
      An inclusion package carries the balance of one customer in clear text. Share the file only
      with a party that may see that balance.
    </p>
  );
}

/** The form that asks for the path of a package. */
export function InclusionForm(input: { reason?: string }) {
  return (
    <Layout title="zkPoR inclusion check">
      <h1>Check an inclusion package</h1>
      <p>
        The check rebuilds your leaf, walks the path to the root, and compares that root against the
        root that the registry attests.
      </p>
      {input.reason === undefined ? null : <p className="failure">{input.reason}</p>}
      <form method="post" action={ROUTES.inclusion}>
        <label htmlFor={PACKAGE_PATH_FIELD}>The path of your package file on this machine</label>
        <input id={PACKAGE_PATH_FIELD} name={PACKAGE_PATH_FIELD} required autoComplete="off" />
        <p className="limit">
          One file, and not the directory that a run reports. A run writes one file for each
          customer into that directory, named <code>package-000000.zkpor.json</code> upward, so a
          path here ends with a file name of that shape.
        </p>
        <button type="submit">Check the package</button>
      </form>
      <BalanceWarning />
    </Layout>
  );
}

/**
 * The outcome of one check.
 *
 * The first line that the kit writes names the outcome, and the rest explain
 * it. The page keeps that order, so the page and the command line say the same
 * words in the same order.
 */
export function InclusionVerdictPage(input: { verdict: Verdict }) {
  const lines = verdictLines(input.verdict);
  const [outcome, ...rest] = lines;
  return (
    <Layout title="zkPoR inclusion check">
      <h1>The result of the check</h1>
      <section id={SECTION_IDS.verdict} className={`verdict-${input.verdict.kind}`}>
        <h2>{outcome}</h2>
        {rest.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p className="limit">
          The command line reports this outcome as the exit code {exitCode(input.verdict)}.
        </p>
      </section>
      <p>
        <a href={ROUTES.inclusion}>Check another package</a>
      </p>
      <BalanceWarning />
    </Layout>
  );
}
