/**
 * What the frame of every page states.
 *
 * Two of these are properties of appearance and no test here holds them. A test
 * reads markup, so it can say that a page states the network and that one
 * navigation entry is marked, and it cannot say that the reader sees either
 * one. What it can hold is the part that a later page would otherwise lose in
 * silence: a page added next carries these because the frame carries them, and
 * this fails if one stops doing so.
 *
 * The cases drive the routes rather than the components, because a page reaches
 * a reader through a route. A component rendered on its own would pass while
 * the route that serves it rendered something else.
 */

import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/constants.js";
import { route } from "../src/routes.js";
import { NETWORK, REGISTRY, dashboard, request } from "./support.js";

/** Every route that answers with a page, with the entry it sits under. */
const PAGES: readonly { name: string; target: string; entry: string }[] = [
  { name: "the asset form", target: ROUTES.home, entry: ROUTES.home },
  { name: "an asset", target: `${ROUTES.asset}?asset=${"C".repeat(56)}`, entry: ROUTES.home },
  { name: "the inclusion form", target: ROUTES.inclusion, entry: ROUTES.inclusion },
  { name: "the attestation form", target: ROUTES.attestation, entry: ROUTES.attestation },
  {
    name: "a forgotten run",
    target: `${ROUTES.run}/0a1b2c3d-0000-4000-8000-000000000000`,
    entry: ROUTES.attestation,
  },
];

/** The answer of one route, as markup. */
async function markupOf(target: string): Promise<string> {
  const answer = await route(request({ target }), dashboard({ deploymentsText: "[]" }));
  return answer.body;
}

describe("the frame of every page", () => {
  it("reaches a page on every route below, or it reads nothing", async () => {
    for (const each of PAGES) {
      const markup = await markupOf(each.target);
      expect(markup, `${each.name} answered with no page`).toContain("<html");
    }
  });

  it("states the network and the registry, whatever the page holds", async () => {
    // The page that submits an attestation is the one where this matters, and
    // it is not the asset page. Before the frame carried them, the asset page
    // was the only page that did.
    for (const each of PAGES) {
      const markup = await markupOf(each.target);
      expect(markup, `${each.name} names no network`).toContain(NETWORK);
      expect(markup, `${each.name} names no registry`).toContain(REGISTRY);
    }
  });

  it("marks the entry that the reader is inside, and marks one", async () => {
    for (const each of PAGES) {
      const markup = await markupOf(each.target);
      const marked = [...markup.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map(
        (found) => found[1],
      );
      expect(marked, `${each.name} marks more than one entry, or none`).toHaveLength(1);
      expect(marked[0], `${each.name} marks the wrong entry`).toBe(each.entry);
    }
  });
});
