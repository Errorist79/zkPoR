/**
 * Every identifier that the stylesheet names must be an identifier that a page
 * renders.
 *
 * A selector that names an identifier no page renders fails in silence. The
 * rule that gives the two answers of this product the same weight named one
 * that no page rendered, so one answer stayed at the weight of a plain section
 * while the comment above the rule said that both carried the same weight. A
 * reader of the source saw the comment and took it for evidence.
 *
 * The constants hold the identifiers that the markup writes, so this case reads
 * both sides from a source and compares them.
 */

import { describe, expect, it } from "vitest";
import {
  ASSET_PARAMETER,
  PACKAGE_PATH_FIELD,
  RUN_FIELDS,
  SECTION_IDS,
} from "../src/constants.js";
import { STYLESHEET } from "../src/style.js";

/** Every identifier that a page puts in the markup. */
const RENDERED: readonly string[] = [
  ...Object.values(SECTION_IDS),
  ...Object.values(RUN_FIELDS),
  ASSET_PARAMETER,
  PACKAGE_PATH_FIELD,
];

/**
 * Every identifier that a selector of the stylesheet names.
 *
 * The scan removes each comment and each block first, because a colour inside a
 * block starts with the same character as an identifier in a selector.
 */
function identifiersNamed(sheet: string): string[] {
  const selectors = sheet.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{[^}]*\}/g, " ");
  const named: string[] = [];
  for (const found of selectors.matchAll(/#([A-Za-z][A-Za-z0-9_-]*)/g)) {
    const [, identifier] = found;
    if (identifier !== undefined) {
      named.push(identifier);
    }
  }
  return named;
}

describe("the identifiers that the stylesheet names", () => {
  it("finds the identifiers that the stylesheet names", () => {
    // Without this the case passes on a scan that reads nothing at all.
    expect(identifiersNamed(STYLESHEET).length).toBeGreaterThan(0);
  });

  it("names no identifier that a page never renders", () => {
    for (const named of identifiersNamed(STYLESHEET)) {
      expect(RENDERED, `the stylesheet names #${named}, which no page renders`).toContain(named);
    }
  });

  it("reads a selector and not a colour", () => {
    const sheet = "#solvency-headline h2 { color: #abcdef; }";
    expect(identifiersNamed(sheet)).toStrictEqual(["solvency-headline"]);
  });
});
