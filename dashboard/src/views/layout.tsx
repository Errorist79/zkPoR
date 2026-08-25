/**
 * The frame of every page.
 *
 * The page carries no script and no remote resource. The stylesheet is the one
 * resource it loads, and it comes from this process. Every address in the
 * markup is a path, so the document names no host at all, and a saved copy of
 * it reaches nothing.
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
 * A page that watches an open run names a refresh interval and an address. The
 * directive reloads that address, which is a navigation and not a fetch, so the
 * policy that blocks every script and every remote resource still holds. The
 * address is a path of this process, and it may carry a fragment that names an
 * element of the same page.
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
  /** The address that the refresh reads. The page reloads its own address without one. */
  refreshTarget?: string | undefined;
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
          <meta
            httpEquiv="refresh"
            content={
              input.refreshTarget === undefined
                ? String(input.refreshSeconds)
                : `${String(input.refreshSeconds)}; url=${input.refreshTarget}`
            }
          />
        )}
        <title>{input.title}</title>
        <link rel="stylesheet" href={`${ROUTES.style}?v=${STYLESHEET_VERSION}`} />
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
