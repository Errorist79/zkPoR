/**
 * The one place that turns a page into bytes.
 *
 * Every page renders on this machine and the result carries no script, so the
 * browser runs nothing and starts no request of its own.
 *
 * Every page also carries two facts that belong to the frame rather than to the
 * page: which network and which registry this process writes to, and which
 * entry of the navigation the reader is inside. A page that took those as its
 * own props would carry them only while somebody remembered to pass them, and
 * the page where they matter most is the one that submits an attestation. They
 * arrive here instead, once, and the frame reads them.
 */

import { createContext } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** The document type declaration, which the markup renderer does not write. */
const DOCTYPE = "<!doctype html>\n";

/** What the frame of a page states, whatever the page holds. */
export interface Frame {
  /**
   * The network that this process reads and writes.
   *
   * The frame names no registry. This process holds none: a page about an
   * asset reads the generation that holds that asset and names it there, and a
   * page with no asset has no registry to name. A frame that named one would
   * state a registry above a page answering about another.
   */
  readonly network: string;
  /** The navigation entry that the reader is inside. */
  readonly current: string;
}

/**
 * The frame of the page that renders now.
 *
 * The default is nothing, and the frame refuses to render without one. A page
 * rendered outside this function is a page that states no network and no
 * registry, and that must fail where somebody sees it rather than produce a
 * page which quietly says less than every other page.
 */
export const FrameContext = createContext<Frame | undefined>(undefined);

/** The bytes of one page. */
export function renderPage(page: ReactElement, frame: Frame): string {
  const framed = <FrameContext.Provider value={frame}>{page}</FrameContext.Provider>;
  return `${DOCTYPE}${renderToStaticMarkup(framed)}\n`;
}
