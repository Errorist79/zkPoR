/**
 * The source of this package, as the guards over it read it.
 *
 * More than one guard reads this source: the one on the hash library, the one
 * on the way to start a program, and the two on what a module may reach. Each
 * needs the same set of modules and the same readings, and a set that two files
 * build separately is a set that drifts apart. A module that one of the two
 * lists misses is a module that a guard does not read, and nothing reports it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import * as ts from "typescript";
import { join, relative } from "node:path";

/** The directory that holds the modules of this package. */
const SOURCE = join(import.meta.dirname, "..", "src");

/**
 * Every module of this package, named against the source directory.
 *
 * The walk enters a directory, because a module inside one is still a module of
 * this package. A list that read the top directory alone would skip it, and a
 * guard that read that list would pass on it.
 */
export function sourceFiles(directory: string = SOURCE): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      // A module that carries markup is still a module of this package. A list
      // that took one extension would leave the other read by no rule at all.
      found.push(relative(SOURCE, path));
    }
  }
  return found;
}

/** The text of one module. */
export function sourceOf(name: string): string {
  return readFileSync(join(SOURCE, name), "utf8");
}

/**
 * One source with its comments removed.
 *
 * A comment that names a module imports none, and counting it makes a correct
 * file fail, which is the pressure that gets a check relaxed rather than fixed.
 * Only whole comment lines and block comments are removed, so a string holding
 * two slashes is left alone.
 */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

/**
 * The built-in modules of the runtime that this package uses.
 *
 * The two checks on what a module may reach take their allowance from this
 * list, and not from a list of the modules they refuse. A list of network
 * modules to refuse needs a new entry whenever the runtime gains one, and it
 * would be one entry behind on the day that mattered.
 *
 * Because both checks read this list, one line added here disables both of
 * them, and that is the natural repair for somebody who meets a loud failure
 * and wants it to stop. The list is therefore stated a second time, with a
 * reason for each entry, where the wider check consumes it, and the two must
 * agree. Nothing here should be edited on its own.
 */
export const BUILT_INS: readonly string[] = [
  "node:child_process",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:util",
];

/** One module that a source names, and the form that names it. */
export interface NamedModule {
  /** The module, or nothing when the source names it with a value. */
  readonly specifier: string | undefined;
  /** The form that names it. One form takes names, and the rest take none. */
  readonly form: "import" | "namespace" | "default" | "bare" | "export" | "dynamic" | "require";
  /** The names taken from the module, for the one form that takes names. */
  readonly names: readonly string[];
}

/** One source, parsed once. */
const parsedSources = new Map<string, ts.SourceFile>();

function parse(name: string): ts.SourceFile {
  const already = parsedSources.get(name);
  if (already !== undefined) {
    return already;
  }
  // The parent links are kept, because the reading of a global below asks what
  // encloses an identifier.
  const file = ts.createSourceFile(
    name,
    sourceOf(name),
    ts.ScriptTarget.Latest,
    true,
    name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsedSources.set(name, file);
  return file;
}

function literalOf(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;
}

/**
 * Every module that one source names, as the parser of the language reports it.
 *
 * The parser decides what a form is, so this holds every form the language has
 * and not the forms that somebody thought to write a pattern for. A reader
 * built from patterns held three of them and needed a double quote on each
 * side; a quote of either kind, an import that takes nothing, an export that
 * passes a module on, an import inside an expression, and a require all arrive
 * here the same way, and so does the form the language gains next.
 *
 * A specifier that is not a literal arrives with no module named. The caller
 * refuses it, because a module named by a value is a module that no reader of
 * the source can follow.
 */
export function namedModulesOf(name: string): readonly NamedModule[] {
  const found: NamedModule[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalOf(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause === undefined) {
        found.push({ specifier, form: "bare", names: [] });
      } else {
        if (clause.name !== undefined) {
          found.push({ specifier, form: "default", names: [] });
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          found.push({ specifier, form: "namespace", names: [] });
        }
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          found.push({
            specifier,
            form: "import",
            names: bindings.elements.map((each) => (each.propertyName ?? each.name).text),
          });
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      found.push({ specifier: literalOf(node.moduleSpecifier), form: "export", names: [] });
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      found.push({
        specifier: ts.isExternalModuleReference(reference)
          ? literalOf(reference.expression)
          : undefined,
        form: "require",
        names: [],
      });
    }
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      found.push({
        specifier: ts.isLiteralTypeNode(argument) ? literalOf(argument.literal) : undefined,
        form: "dynamic",
        names: [],
      });
    }
    if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamic || required) {
        found.push({
          specifier: literalOf(node.arguments[0]),
          form: dynamic ? "dynamic" : "require",
          names: [],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(name));
  return found;
}

/** One use that a source makes of a global. */
export interface GlobalUse {
  /** The global that the source names. */
  readonly global: string;
  /** The member taken from it, or nothing when the use takes no member. */
  readonly member: string | undefined;
}

/**
 * Every use that one source makes of the globals that the caller watches.
 *
 * The names come from the caller, because the caller holds the one table that
 * says which globals this package may name and what it may take from each. A
 * list here would be a second copy of that table.
 *
 * A use that is not a member under a plain name is reported as a use that this
 * reader cannot follow, so an alias, a destructuring, a computed member, and a
 * call of the name itself all fail against the table rather than passing
 * unseen.
 */
export function globalUsesOf(name: string, watched: readonly string[]): GlobalUse[] {
  const file = parse(name);
  const found: GlobalUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && watched.includes(node.text)) {
      const parent: ts.Node | undefined = node.parent;
      const isMemberName =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isMemberObject =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node;
      if (isMemberName) {
        // A property of something else that happens to carry this name.
      } else if (isMemberObject && ts.isPropertyAccessExpression(parent)) {
        found.push({ global: node.text, member: parent.name.text });
      } else {
        // An alias, a destructuring, a computed member, a call of the name
        // itself, and a name under `new` all arrive here, because none of them
        // is a member that this reader can name.
        found.push({ global: node.text, member: undefined });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The options that the reading of a global uses, fixed here on purpose.
 *
 * The library decides which names count as intrinsics of the language, and the
 * language library of this version defines nothing that opens a connection. The
 * library of a browser does, so a project setting that added it would turn
 * `fetch` and `WebSocket` into intrinsics and widen the rule below without
 * touching the rule. These options are therefore stated here, and a change to
 * the configuration of the package cannot reach them.
 */
const READING_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: ["node"],
  strict: true,
  noEmit: true,
};

/**
 * The files that the options above entitle this reading to call the language.
 *
 * A reader that asked whether a file is named `lib.something` would be a
 * pattern over a file name, which is the shape this whole reading exists to
 * stop. It would also be defeated by one line: a source of this package can
 * carry `/// <reference lib="dom" />`, the compiler honours it whatever the
 * options say, and `WebSocket` then arrives in a file named `lib.dom.d.ts` and
 * counts as an intrinsic everywhere in the package.
 *
 * So the set comes from the options instead. An empty source is compiled with
 * the same options and no ambient type package, and the files that the compiler
 * loads for it are the language, by construction. A library that arrives by any
 * other route is outside that set, whatever it is called and however it was
 * asked for.
 */
function entitledLibrary(): ReadonlySet<string> {
  if (library === undefined) {
    const nothing = "an empty source that names the library";
    const host = ts.createCompilerHost(READING_OPTIONS, true);
    const readSource = host.getSourceFile.bind(host);
    const exists = host.fileExists.bind(host);
    const read = host.readFile.bind(host);
    host.getSourceFile = (name, ...rest) =>
      name === nothing
        ? ts.createSourceFile(nothing, "", ts.ScriptTarget.Latest, true)
        : readSource(name, ...rest);
    host.fileExists = (name) => name === nothing || exists(name);
    host.readFile = (name) => (name === nothing ? "" : read(name));
    // No ambient type package. The globals of the runtime arrive through one,
    // and they are the names this reading is looking for, so they must not
    // count as the language.
    const program = ts.createProgram([nothing], { ...READING_OPTIONS, types: [] }, host);
    library = new Set(
      program
        .getSourceFiles()
        .map((each) => each.fileName)
        .filter((name) => name !== nothing),
    );
  }
  return library;
}

let library: Set<string> | undefined;

let resolved: ts.Program | undefined;

function programOfPackage(): ts.Program {
  if (resolved === undefined) {
    resolved = ts.createProgram(
      sourceFiles().map((name) => join(SOURCE, name)),
      READING_OPTIONS,
    );
  }
  return resolved;
}

/** True when a name in this position names a type rather than a value. */
function inTypePosition(node: ts.Node): boolean {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isTypeNode(parent) || ts.isQualifiedName(parent)) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

/**
 * Every global that one source names, other than an intrinsic of the language.
 *
 * The rule this feeds is the general one, and the shape matters. A rule that
 * watched a list of dangerous globals would be an enumeration, and it was: it
 * held three names, and `WebSocket` opened a connection beside them with
 * nothing objecting. This asks instead which names a module uses that no import
 * introduces and no declaration of its own binds, and then which of those the
 * language itself defines.
 *
 * An intrinsic of the language passes, and which names those are comes from the
 * options that this reading fixed rather than from the name of a file. The
 * library of this version defines `Promise`, `Map`, `JSON` and their like, and
 * none of them reaches a network.
 * Everything else is a global of the runtime, which is where a connection is
 * opened, so the caller names the ones this package uses and every other one
 * fails, including the one the runtime adds next.
 *
 * A name in a type position names no value and opens nothing, so this reads the
 * value positions.
 *
 * A name that a module binds itself passes, and the reading asks the compiler
 * that question rather than answering it from where a declaration sits.
 *
 * That distinction cost three attempts and it is the same mistake each time. A
 * reading that asked whether every declaration sits in a declaration file
 * skipped a `declare global` block, which lives in an ordinary module and binds
 * nothing there. A reading that then named those two cases skipped a file with
 * no import and no export, because such a file is a script and a `declare var`
 * at its top level is global while sitting in neither case. Two entries is a
 * short enumeration that met its third form immediately.
 *
 * So the reading asks whether the name resolves to the same symbol in the
 * global scope as it does where it is used. That is the question the other
 * three were standing in for, the compiler answers it directly, and a fourth
 * form of the same split has nothing left to hide in.
 */
export function freeGlobalsOf(name: string): string[] {
  const program = programOfPackage();
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(join(SOURCE, name));
  if (file === undefined) {
    throw new Error(`the reading of this package holds no module named ${name}`);
  }
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !inTypePosition(node)) {
      const parent: ts.Node | undefined = node.parent;
      const names =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          ts.isImportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isNamespaceImport(parent) ||
          ts.isExportSpecifier(parent) ||
          ts.isPropertyAssignment(parent) ||
          (!ts.isPropertyAccessExpression(parent) && "name" in parent && parent.name === node));
      if (!names) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol === undefined) {
          found.push(`${node.text}, a name this reader cannot resolve`);
        } else if (
          symbol === checker.resolveName(node.text, undefined, ts.SymbolFlags.Value, false)
        ) {
          // The name lives in the global scope, so a module took it from the
          // runtime rather than bringing it. A name that a module binds itself,
          // and a name that shadows a global, resolve to another symbol here.
          // A symbol with no declaration at all is skipped. `undefined` is
          // the one that this package names, and the compiler models it with no
          // declaration to point at.
          //
          // That allowance is measured rather than argued. Of the 243 global
          // value symbols in scope of this program, two carry no declaration,
          // `globalThis` and `undefined`, and the other 241 each carry one.
          // Neither of the two opens a connection, and the table that reads the
          // members holds `globalThis` with no member allowed.
          //
          // The count answers one question and a reader who takes it again must
          // ask the same one: the symbols in scope at a module, under the value
          // flag, kept only where the name resolves to that same symbol in the
          // global scope. A count without that last step is wider, because it
          // holds the module level names of the file it was asked from.
          const declarations = symbol.declarations ?? [];
          if (
            declarations.length > 0 &&
            !declarations.some((each) => entitledLibrary().has(each.getSourceFile().fileName))
          ) {
            found.push(node.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(found)];
}
