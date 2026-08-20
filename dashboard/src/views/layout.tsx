/**
 * The frame of every page.
 *
 * The page carries no script and no remote resource. The stylesheet is the one
 * resource it loads, and it comes from this process. Every address in the
 * markup is a path, so the document names no host at all, and a saved copy of
 * it reaches nothing.
 */

import type { ReactNode } from "react";
import { ROUTES } from "../constants.js";

/**
 * The heading and the navigation that every page carries.
 *
 * A page that watches an open run names a refresh interval. The directive
 * reloads this same address, which is a navigation and not a fetch, so the
 * policy that blocks every script and every remote resource still holds.
 */
export function Layout(input: {
  title: string;
  children: ReactNode;
  refreshSeconds?: number | undefined;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {input.refreshSeconds === undefined ? null : (
          <meta httpEquiv="refresh" content={String(input.refreshSeconds)} />
        )}
        <title>{input.title}</title>
        <link rel="stylesheet" href={ROUTES.style} />
      </head>
      <body>
        <header>
          <p className="mark">zkPoR</p>
          <nav>
            <a href={ROUTES.home}>Asset</a>
            <a href={ROUTES.attestation}>Prove and attest</a>
            <a href={ROUTES.inclusion}>Inclusion check</a>
          </nav>
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
export function Failure(input: { title: string; reason: string }) {
  return (
    <Layout title={input.title}>
      <h1>{input.title}</h1>
      <p className="failure">{input.reason}</p>
      <p>This is a failure of the client or of the network. It is not a result.</p>
    </Layout>
  );
}
