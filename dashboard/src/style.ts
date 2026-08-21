/**
 * The stylesheet, as text that this process serves.
 *
 * It names no font file, no image, and no other resource, so the browser makes
 * no request for it beyond the one that fetches this text. It also carries no
 * rule that hides an element, because a reader must see every statement that
 * the markup makes.
 */

export const STYLESHEET = `
:root {
  color-scheme: light dark;
  --edge: #8a8a8a;
  --warn: #a33;
}

body {
  font-family: system-ui, sans-serif;
  line-height: 1.5;
  margin: 0 auto;
  max-width: 52rem;
  padding: 1.5rem;
}

header {
  border-bottom: 1px solid var(--edge);
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
}

header .mark {
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0;
  text-transform: uppercase;
}

nav a {
  margin-right: 1rem;
}

nav a[aria-current="page"] {
  font-weight: 700;
  text-decoration: none;
}

.deployment {
  font-size: 0.9rem;
  margin-bottom: 0.25rem;
}

.local,
.limit {
  color: var(--edge);
  font-size: 0.9rem;
}

section {
  border: 1px solid var(--edge);
  border-radius: 0.4rem;
  margin-bottom: 1.5rem;
  padding: 0 1rem 1rem;
}

section h2 {
  font-size: 1.15rem;
}

#solvency-headline h2 {
  font-size: 1.4rem;
}

.figure,
.address {
  font-family: ui-monospace, monospace;
  overflow-wrap: anywhere;
}

.figure {
  font-size: 1.05rem;
  font-weight: 700;
}

dl {
  display: grid;
  gap: 0.25rem 1rem;
  grid-template-columns: max-content 1fr;
}

dt {
  color: var(--edge);
}

dd {
  margin: 0;
}

table {
  border-collapse: collapse;
  width: 100%;
}

th,
td {
  border-bottom: 1px solid var(--edge);
  padding: 0.35rem 0.5rem;
  text-align: left;
}

.failure {
  color: var(--warn);
}

label {
  display: block;
  font-weight: 600;
}

/* The label of a choice names the option rather than the field above it, so it
   carries the weight of running text and not the weight of a field name. */
label.choice {
  font-weight: 400;
}

input {
  font-family: ui-monospace, monospace;
}

/* The width and the padding belong to a field that takes typing. A radio takes
   none, and the pair stretched it across the line and pushed its own text onto
   the next one, so the two options read as headings. */
input:not([type="radio"]) {
  padding: 0.4rem;
  width: 100%;
}

label.choice input {
  margin-right: 0.4rem;
}

button {
  margin-top: 0.75rem;
  padding: 0.4rem 1rem;
}
`;
