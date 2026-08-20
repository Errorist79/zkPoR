/**
 * The one place that turns a page into bytes.
 *
 * Every page renders on this machine and the result carries no script, so the
 * browser runs nothing and starts no request of its own.
 */

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** The document type declaration, which the markup renderer does not write. */
const DOCTYPE = "<!doctype html>\n";

/** The bytes of one page. */
export function renderPage(page: ReactElement): string {
  return `${DOCTYPE}${renderToStaticMarkup(page)}\n`;
}
