/**
 * The stylesheet, as text that this process serves.
 *
 * It names no font file, no image, and no other resource, so the browser makes
 * no request for it beyond the one that fetches this text. It also carries no
 * rule that hides an element, because a reader must see every statement that
 * the markup makes.
 */

export const STYLESHEET = `
/* Two colours carry a meaning, and each carries one meaning. The accent marks
   the place where the reader can act: a link, the entry of the current page,
   the focus ring, and the button. The warning marks a failure statement. A
   result that the registry supports takes neither, so a shortfall reads in the
   colour of every other result. */
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

header {
  border-bottom: 1px solid var(--edge);
  margin-bottom: 2rem;
  padding-bottom: 1rem;
}

header .mark {
  color: var(--ink-soft);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  margin: 0 0 0.75rem;
  text-transform: uppercase;
}

nav {
  border-bottom: 1px solid var(--edge);
  display: flex;
  gap: 1.5rem;
  margin-bottom: 0.85rem;
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
  font-size: 0.85rem;
  margin-bottom: 0.25rem;
}

.deployment strong {
  color: var(--ink);
}

.local,
.limit {
  color: var(--ink-soft);
  font-size: 0.85rem;
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

/* This colour marks a failure of the client or of the network. A shortfall is
   a result that the registry supports, so a shortfall does not take it. */
.failure {
  color: var(--warn);
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
