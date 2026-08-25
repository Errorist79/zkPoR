/**
 * The stylesheet, as text that this process serves.
 *
 * It names no font file, no image, and no other resource, so the browser makes
 * no request for it beyond the one that fetches this text. It also carries no
 * rule that hides an element, because a reader must see every statement that
 * the markup makes.
 */

import { createHash } from "node:crypto";

export const STYLESHEET = `
/* Four colours carry a meaning. The accent marks the place where the reader can
   act: a link, the entry of the current page, the focus ring, and the button.
   The warning marks a failure statement.

   The other two mark the result of an attestation. The reserves reach the
   liabilities, or they fall short. A reader had to read a sentence to find that
   result, and in the history table the result was a word in the fifth column of
   six, so a reader had to search the page for it.

   The colour of a shortfall is near the colour of a failure. That is deliberate
   and it is a cost that this dashboard accepts. The two appear in different
   places, and the sentence beside each one says which it is. */
:root {
  color-scheme: light dark;
  --page: #fcfcfb;
  --panel: #ffffff;
  --ink: #16181c;
  --ink-soft: #55595f;
  --edge: #d7d5d0;
  --edge-strong: #8d8a84;
  --accent: #14555f;
  --warn: #9b2226;
  --reach: #14663a;
  --short: #a32226;
}

@media (prefers-color-scheme: dark) {
  :root {
    --page: #131416;
    --panel: #191b1e;
    --ink: #e8e6e3;
    --ink-soft: #a0a4aa;
    --edge: #33363b;
    --edge-strong: #6a6f76;
    --accent: #7ec9d3;
    --warn: #e2807f;
    --reach: #6fcf95;
    --short: #e6908f;
  }
}

body {
  background: var(--page);
  color: var(--ink);
  font-family: system-ui, sans-serif;
  line-height: 1.55;
  margin: 0 auto;
  max-width: 54rem;
  padding: 2rem 1.5rem 4rem;
}

p {
  margin: 0 0 0.85rem;
}

p:last-child {
  margin-bottom: 0;
}

a {
  color: var(--accent);
  text-underline-offset: 0.15em;
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

h1 {
  font-size: 1.35rem;
  font-weight: 600;
  line-height: 1.25;
  margin: 0 0 1rem;
}

/* A page that names an asset puts the address in the heading. The address is
   an identifier and not an answer, so it takes less weight than the answer
   below it. */
h1.address {
  font-size: 1.15rem;
}

h2 {
  font-size: 1.15rem;
  font-weight: 600;
  line-height: 1.3;
  margin: 2rem 0 0.75rem;
}

h3 {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 1.5rem 0 0.5rem;
}

/* The frame stands above every page, so each row that the frame takes is a row
   that the page below it loses. A reader who opens an asset page must meet the
   asset and not four rows of frame.

   The frame holds four statements and it now takes three rows. The mark and the
   network share the first row, because both name where the reader is rather than
   what the page says. The navigation takes the second row. The statement about
   this machine takes the third.

   The navigation carries no rule of its own. The rule under the frame already
   closes the block, and two rules that sit twelve pixels apart read as an error.
   The entry of the current page keeps its own underline, which is the mark that
   states the entry. */
header {
  align-items: baseline;
  border-bottom: 1px solid var(--edge);
  column-gap: 1.5rem;
  display: grid;
  grid-template-columns: 1fr auto;
  margin-bottom: 1.25rem;
  padding-bottom: 0.6rem;
  row-gap: 0.5rem;
}

header .mark {
  color: var(--ink-soft);
  font-size: 0.78rem;
  font-weight: 700;
  grid-area: 1 / 1;
  letter-spacing: 0.14em;
  margin: 0;
  text-transform: uppercase;
}

nav {
  display: flex;
  gap: 1.5rem;
  grid-area: 2 / 1 / auto / -1;
}

nav a {
  border-bottom: 2px solid transparent;
  color: var(--ink-soft);
  padding-bottom: 0.5rem;
  text-decoration: none;
}

nav a:hover {
  color: var(--ink);
}

nav a[aria-current="page"] {
  border-bottom-color: var(--accent);
  color: var(--ink);
  font-weight: 600;
}

.deployment {
  color: var(--ink-soft);
  font-size: 0.78rem;
  grid-area: 1 / 2;
  margin: 0;
  text-align: right;
}

.deployment strong {
  color: var(--ink);
}

.local,
.limit {
  color: var(--ink-soft);
  font-size: 0.85rem;
}

/* The statement that this dashboard sends nothing anywhere stands on every page,
   and a reader reads it once. It keeps every word and it stays in the reading
   order, so it is still there and a reader can still find it. It gives up the
   size of body text, which is what it costs the page under it. */
header .local {
  font-size: 0.78rem;
  grid-area: 3 / 1 / auto / -1;
  line-height: 1.45;
  margin: 0;
}

/* A narrow screen cannot carry two columns in one row, so the frame returns to
   one column and each statement takes a row of its own.

   This block sits after every rule that places a part of the frame. The
   placements above carry the same weight as these, so a placement that came
   later in the text would win inside this width as well, and the frame would
   keep two columns on a screen that cannot hold them. */
@media (max-width: 34rem) {
  header {
    grid-template-columns: 1fr;
  }

  header .mark,
  nav,
  .deployment,
  header .local {
    grid-area: auto;
  }

  .deployment {
    text-align: left;
  }
}

/* A limit statement says what the claim beside it does not cover. The rule at
   its edge separates it from the claim without moving it out of the reading
   order and without making it smaller than a reader can read. */
.limit {
  border-left: 2px solid var(--edge);
  margin-top: 0.6rem;
  padding-left: 0.8rem;
}

section {
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: 2px;
  margin-bottom: 1.75rem;
  padding: 1.25rem 1.5rem 1.5rem;
}

section h2 {
  font-size: 1.05rem;
  margin: 0 0 0.85rem;
}

/* The two answers of this product carry the same weight. One says whether the
   reserves reach the liabilities, the other says whether a leaf is under the
   attested root, and both answer a question the reader came with. Each
   identifier below is the identifier that the markup writes. */
#solvency-headline,
#inclusion-verdict {
  border-color: var(--edge-strong);
  padding: 1.5rem;
}

#solvency-headline h2,
#inclusion-verdict h2 {
  font-size: 1.5rem;
  line-height: 1.3;
  margin-bottom: 1rem;
}

.figure,
.address {
  font-family: ui-monospace, monospace;
}

/* An address has no groups, so it may break anywhere rather than leave the
   page. A figure must not, which the rule below states again. */
.address {
  overflow-wrap: anywhere;
}

.figure {
  font-size: 1rem;
  font-weight: 600;
  /* Every digit takes one width, so two figures above one another compare by
     their length. The reserves against the liabilities is the comparison this
     product exists to show. The figures keep that shared left edge, so do not
     move a column of figures to the right. */
  font-variant-numeric: tabular-nums;
  /* The groups of a figure are separated by a space, so a line break inside one
     would split a number across two lines and read as two numbers. */
  white-space: nowrap;
}

/* The name sits above the value rather than beside it. A root is 66 characters
   and it must not wrap, so a name in the same row pushed it past the edge of
   the section and the last characters left the page. With the name above, the
   value takes the whole width, and two figures still start at one left edge. */
dl {
  margin: 1.25rem 0;
}

dt {
  color: var(--ink-soft);
  font-size: 0.85rem;
  margin-top: 1rem;
}

dl > dt:first-of-type {
  margin-top: 0;
}

dd {
  margin: 0;
}

ul,
ol {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}

li {
  margin-bottom: 0.3rem;
}

code {
  font-family: ui-monospace, monospace;
  font-size: 0.95em;
}

table {
  border-collapse: collapse;
  margin: 1rem 0;
  width: 100%;
}

th,
td {
  border-bottom: 1px solid var(--edge);
  padding: 0.5rem 0.75rem;
  text-align: left;
  vertical-align: top;
}

/* The first column starts at the edge of the section, so a table and the lines
   above it share one left edge. */
th:first-child,
td:first-child {
  padding-left: 0;
}

thead th {
  border-bottom-color: var(--edge-strong);
  color: var(--ink-soft);
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* This colour marks a failure of the client or of the network. It is near the
   colour of a shortfall, and the sentence beside each one says which it is. */
.failure {
  color: var(--warn);
}

/* The verdict of an attestation takes the colour of its result. The headline
   states the verdict of the current attestation, and a row of the history table
   states the verdict of one earlier attestation.

   The colours hold 7.0 to 1 and 7.5 to 1 on the light panel, and 9.1 to 1 and
   7.2 to 1 on the dark panel. The words state the result as well, so a reader
   who cannot separate the two colours still reads the answer. */
#solvency-headline.coverage-reserves-reach-liabilities h2,
tr.coverage-reserves-reach-liabilities td.verdict {
  color: var(--reach);
}

#solvency-headline.coverage-reserves-fall-short h2,
tr.coverage-reserves-fall-short td.verdict {
  color: var(--short);
}

/* The verdict is the answer that a reader came for, so it takes the first
   column of the row and the weight of a name. */
td.verdict {
  font-weight: 600;
}

form {
  margin: 1.5rem 0;
}

label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.35rem;
}

/* The space above a name separates one field from the field before it. Without
   it the name of the second field sat against the first field and read as a
   note about it. */
form label {
  margin-top: 1.5rem;
}

form > label:first-child {
  margin-top: 0;
}

/* The label of a choice names the option rather than the field above it, so it
   carries the weight of running text and not the weight of a field name. */
label.choice {
  font-size: 1rem;
  font-weight: 400;
  margin: 0 0 0.5rem;
}

input {
  font-family: ui-monospace, monospace;
  font-size: 1rem;
}

/* The width and the padding belong to a field that takes typing. A radio takes
   none, and the pair stretched it across the line and pushed its own text onto
   the next one, so the two options read as headings. */
input:not([type="radio"]) {
  background: var(--panel);
  border: 1px solid var(--edge-strong);
  border-radius: 2px;
  color: var(--ink);
  padding: 0.5rem 0.6rem;
  width: 100%;
}

label.choice input {
  margin-right: 0.4rem;
}

fieldset {
  border: 1px solid var(--edge);
  border-radius: 2px;
  margin: 1.5rem 0 0;
  padding: 1rem 1.25rem;
}

legend {
  color: var(--ink-soft);
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0 0.4rem;
}

button {
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 2px;
  color: var(--page);
  font: inherit;
  font-weight: 600;
  margin-top: 1.5rem;
  padding: 0.55rem 1.1rem;
}
`;

/**
 * The version of the stylesheet, which is a digest of its own text.
 *
 * The address of the stylesheet carries this value. A build that changes one
 * character of the text above changes the address, so a browser that kept the
 * old text never serves it for the new build. This is what lets a browser keep
 * the text and never ask for it twice.
 *
 * The digest is of the text this process serves, and not of a file on disk, so
 * it cannot disagree with what the reader receives.
 */
export const STYLESHEET_VERSION = createHash("sha256").update(STYLESHEET).digest("hex").slice(0, 16);
