/**
 * The frame of every page.
 *
 * The page carries no remote resource. The stylesheet is one resource it loads
 * and the page of a run loads a script, and both come from this process. Every
 * address in the markup is a path, so the document names no host at all, and a
 * saved copy of it reaches nothing.
 */

import { useContext } from "react";
import type { ReactNode } from "react";
import { ROUTES } from "../constants.js";
import { FrameContext } from "../render.js";
import { STYLESHEET_VERSION } from "../style.js";

/** One entry of the navigation. */
function Entry(input: { href: string; current: string; children: ReactNode }) {
  // The marking is an attribute that names the state rather than a class that
  // describes a look, so a reader who hears the page hears it too. The page
  // carries no script, so the frame decides this and nothing later changes it.
  const here = input.href === input.current;
  return (
    <a href={input.href} aria-current={here ? "page" : undefined}>
      {input.children}
    </a>
  );
}

/**
 * The heading and the navigation that every page carries.
 *
 * A page that watches an open run names a refresh interval, and it may name a
 * script. The directive reloads this same address, which is a navigation and
 * not a fetch.
 *
 * The directive sits inside a `noscript` element, so only a browser that runs
 * no script ever schedules it. A browser that runs scripts parses the contents
 * of that element as text and builds no element from them, so there is nothing
 * to schedule and nothing to cancel. A browser schedules a refresh when the
 * parser meets the tag, and removing the element afterwards does not cancel the
 * navigation that is already pending, so a page that carried the directive
 * openly reloaded itself under the script that was already updating it.
 *
 * The directive names no address. It named one for a while, so that a reload
 * would land on the steps rather than at the top, and that stopped the reload
 * from happening at all: the address differed from the address of the page by a
 * fragment alone, and a browser treats that as a move inside the same document.
 * The page then sat still and reported nothing.
 *
 * A script, when the page carries one, comes from this process and the policy
 * of that page allows this process alone. Every other page carries the policy
 * that forbids a script of any kind.
 *
 * The frame states the network on every page. A reader who is about to submit
 * an attestation must see which network the submission reaches, and that reader
 * is not on the asset page. The frame names no registry, because this process
 * holds none: a page about an asset names the generation that answered it, and
 * a page with no asset has no registry to name.
 */
export function Layout(input: {
  title: string;
  children: ReactNode;
  refreshSeconds?: number | undefined;
  /** The address of a script that this process serves. Only the page of a run names one. */
  script?: string | undefined;
}) {
  const frame = useContext(FrameContext);
  if (frame === undefined) {
    throw new Error(
      "this page rendered outside the frame, so it states no network",
    );
  }
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {input.refreshSeconds === undefined ? null : (
          <noscript>
            <meta httpEquiv="refresh" content={String(input.refreshSeconds)} />
          </noscript>
        )}
        <title>{input.title}</title>
        <link rel="stylesheet" href={`${ROUTES.style}?v=${STYLESHEET_VERSION}`} />
        {input.script === undefined ? null : <script src={input.script} defer />}
      </head>
      <body>
        <header>
          <p className="mark">zkPoR</p>
          <nav>
            <Entry href={ROUTES.home} current={frame.current}>
              Asset
            </Entry>
            <Entry href={ROUTES.attestation} current={frame.current}>
              Prove and attest
            </Entry>
            <Entry href={ROUTES.inclusion} current={frame.current}>
              Inclusion check
            </Entry>
          </nav>
          <p className="deployment">
            Network <strong>{frame.network}</strong>
          </p>
          <p className="local">
            This dashboard runs on this machine. It sends nothing anywhere except the read calls
            that it makes to the network endpoint you configured.
          </p>
        </header>
        <main>{input.children}</main>
      </body>
    </html>
  );
}

/** A statement that the page could not complete a read. This is not a verdict. */
export function Failure(input: { title: string; reason: string; answered?: boolean }) {
  return (
    <Layout title={input.title}>
      <h1>{input.title}</h1>
      <p className="failure">{input.reason}</p>
      <p>
        {input.answered === true
          ? "The registry answered this. It is the answer of the contract about the request, and not a failure of this dashboard or of the network."
          : "This is a failure of the client or of the network. It is not a result."}
      </p>
    </Layout>
  );
}
