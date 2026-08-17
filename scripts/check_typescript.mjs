// Refuses a type assertion and the `any` type anywhere in the TypeScript of
// this repository.
//
// An assertion tells the compiler what a value is, and a check establishes it.
// Where the two differ, the assertion is a claim that the compiler stops
// questioning, and the claim surfaces later, in the data of a caller, instead of
// at the boundary that produced it. A customer facing reader is the worst place
// for that, so the rule is mechanical rather than a matter of review.
//
// The scan walks the syntax tree that the TypeScript compiler builds, so it
// reports the real nodes and not a pattern in the text. A comment that contains
// the word `any`, or a string that contains ` as `, therefore never fails here.
//
// `as const` stays allowed. It states that a literal keeps its narrow type and
// it makes no claim about a value of unknown shape.
//
// usage: node scripts/check_typescript.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** The kinds this scan refuses, with the reason each one is refused. */
const REFUSED = {
  asAssertion: "a type assertion; write a check that inspects the value",
  angleAssertion: "a type assertion; write a check that inspects the value",
  nonNull: "a non-null assertion; check for undefined and say what is wrong",
  any: "the any type; name the real type, or take unknown and check it",
};

/**
 * The extensions that hold TypeScript. The dashboard uses React, so a component
 * file carries `.tsx`, and a scan that read only `.ts` would skip every one of
 * them and still report success.
 */
const EXTENSIONS = [".ts", ".mts", ".cts", ".tsx"];

/** The declaration files, which state types and hold no code of ours. */
const DECLARATIONS = [".d.ts", ".d.mts", ".d.cts"];

/**
 * The directories that hold no source of ours: an installed dependency, a build
 * output, and the reference clones.
 */
const SKIPPED = new Set(["node_modules", "dist", "target", "spikes", "spike-refs", ".git"]);

/**
 * Every TypeScript source of this repository.
 *
 * The scan reads the file system rather than the git index, because the rule
 * binds the code that exists. A source that nobody has committed yet is still
 * code that a reader will run.
 */
function sources(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    if (SKIPPED.has(name)) {
      continue;
    }
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...sources(path));
    } else if (
      EXTENSIONS.some((extension) => name.endsWith(extension)) &&
      !DECLARATIONS.some((extension) => name.endsWith(extension))
    ) {
      found.push(path);
    }
  }
  return found;
}

/** True when the node is `value as const`, which stays allowed. */
function isAsConst(node) {
  return (
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === "const"
  );
}

function findings(path) {
  const text = readFileSync(path, "utf8");
  // A JSX element and an angle-bracket type assertion share a syntax. The kind
  // decides which one the parser sees, so a `.tsx` file must parse as TSX and
  // every other file must not.
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, kind);
  const found = [];

  const record = (node, kind) => {
    const at = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({
      line: at.line + 1,
      column: at.character + 1,
      kind,
      text: node.getText(source).split("\n")[0].slice(0, 90),
    });
  };

  const walk = (node) => {
    if (ts.isAsExpression(node) && !isAsConst(node)) {
      record(node, "asAssertion");
    } else if (ts.isTypeAssertionExpression(node)) {
      record(node, "angleAssertion");
    } else if (ts.isNonNullExpression(node)) {
      record(node, "nonNull");
    } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
      record(node, "any");
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

const paths = sources(process.argv[2] ?? ".");

// A scan that reaches no file passes without checking anything, which reads as
// a clean result. The count is therefore part of the check.
if (paths.length === 0) {
  process.stdout.write("this scan found no TypeScript source, so it checked nothing\n");
  process.exit(1);
}

let total = 0;
for (const path of paths) {
  for (const finding of findings(path)) {
    total += 1;
    process.stdout.write(
      `${path}:${finding.line}:${finding.column} ${REFUSED[finding.kind]}\n    ${finding.text}\n`,
    );
  }
}

const files = `${paths.length} ${paths.length === 1 ? "file" : "files"}`;
if (total > 0) {
  const refused = total === 1 ? "1 place refuses a check" : `${total} places refuse a check`;
  process.stdout.write(`\n${refused}, in ${files}.\n`);
  process.exit(1);
}
process.stdout.write(`no type assertion and no use of any, in ${files}.\n`);
