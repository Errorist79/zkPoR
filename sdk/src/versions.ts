/**
 * The pinned toolchain versions, and the refusal to run on a drift.
 *
 * The proof format depends on the prover version, on the proof scheme, and on
 * the oracle hash. A run under another version produces a proof that the
 * deployed verifier rejects, or worse, a key that no committed artifact
 * matches. The versions file is the one source of these pins, so this module
 * reads it and refuses at the boundary rather than trusting a document.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The pins that a proving run needs. */
export interface Pins {
  readonly nargoVersion: string;
  readonly bbVersion: string;
  readonly proofScheme: string;
  readonly terminalOracleHash: string;
  readonly innerOracleHash: string;
  readonly stellarJsSdkVersion: string;
}

/** A pin that this client cannot read, or a tool whose version differs. */
export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionError";
  }
}

/**
 * Reads the shell assignments of the versions file.
 *
 * The file is a shell fragment of `NAME="value"` lines with comments, so the
 * reader takes the assignments and ignores everything else.
 */
export function parseVersions(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const found = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (found !== null && found[1] !== undefined && found[2] !== undefined) {
      values.set(found[1], found[2]);
    }
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) {
    throw new VersionError(`the versions file carries no ${name}`);
  }
  return value;
}

/** Reads the pins of the versions file. */
export async function readPins(path: string): Promise<Pins> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new VersionError(`the client cannot read the versions file ${path}`);
  }
  const values = parseVersions(text);
  return {
    nargoVersion: required(values, "NARGO_VERSION"),
    bbVersion: required(values, "BB_VERSION"),
    proofScheme: required(values, "PROOF_SCHEME"),
    terminalOracleHash: required(values, "TERMINAL_ORACLE_HASH"),
    innerOracleHash: required(values, "INNER_ORACLE_HASH"),
    stellarJsSdkVersion: required(values, "STELLAR_JS_SDK_VERSION"),
  };
}

async function toolVersion(command: string): Promise<string> {
  try {
    const { stdout } = await run(command, ["--version"]);
    return stdout.trim();
  } catch {
    throw new VersionError(`the client cannot run ${command} --version`);
  }
}

/**
 * Checks the prover toolchain against the pins.
 *
 * The comparison looks for the pinned version inside the reported text,
 * because each tool prints its version in its own layout. A tool that reports
 * another version stops the run.
 */
export async function requirePinnedTools(pins: Pins): Promise<{ nargo: string; bb: string }> {
  const nargo = await toolVersion("nargo");
  if (!nargo.includes(pins.nargoVersion)) {
    throw new VersionError(
      `this repository pins nargo ${pins.nargoVersion}, and the tool reports ${nargo}`,
    );
  }
  const bb = await toolVersion("bb");
  const wanted = pins.bbVersion.startsWith("v") ? pins.bbVersion.slice(1) : pins.bbVersion;
  if (!bb.includes(wanted)) {
    throw new VersionError(
      `this repository pins bb ${pins.bbVersion}, and the tool reports ${bb}`,
    );
  }
  return { nargo, bb };
}
