/**
 * The master secret channel.
 *
 * The secret derives every salt of every leaf. A leaked secret exposes every
 * leaf of every context that used it. It therefore never travels in an
 * argument vector, where the process list of the machine shows it, and it never
 * reaches a log.
 *
 * The two accepted channels are an environment variable and a file whose mode
 * gives no access to another user.
 */

import { readFile, stat } from "node:fs/promises";
import { MASTER_SECRET_ENV, MASTER_SECRET_FILE_ENV, SECRET_FILE_MODE } from "./constants.js";
import { bytesFromHex, reduce } from "./fr.js";
import { FR_BYTES } from "./constants.js";

/** A master secret that this client refuses to read. */
export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

function fromText(text: string, source: string): bigint {
  const trimmed = text.trim();
  const bytes = bytesFromHex(trimmed);
  if (bytes.length !== FR_BYTES) {
    throw new SecretError(
      `the master secret of ${source} must be ${FR_BYTES} bytes as hexadecimal digits`,
    );
  }
  // The secret comes from a random source, so its value can reach or pass the
  // modulus. The reduction is part of the derivation, not a repair.
  return reduce(bytes);
}

/**
 * Reads the master secret from the environment variable, or from the file that
 * the environment names.
 *
 * The function refuses a file whose mode grants access beyond its owner, and it
 * refuses when both channels are set, because two sources can disagree.
 */
export async function readMasterSecret(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<bigint> {
  const inline = environment[MASTER_SECRET_ENV];
  const path = environment[MASTER_SECRET_FILE_ENV];
  if (inline !== undefined && path !== undefined) {
    throw new SecretError(
      `set ${MASTER_SECRET_ENV} or ${MASTER_SECRET_FILE_ENV}, and not both, because two sources can disagree`,
    );
  }
  if (inline !== undefined) {
    return fromText(inline, MASTER_SECRET_ENV);
  }
  if (path === undefined) {
    throw new SecretError(
      `set ${MASTER_SECRET_ENV} or ${MASTER_SECRET_FILE_ENV}; no argument carries the master secret`,
    );
  }
  const information = await stat(path).catch(() => {
    throw new SecretError(`the client cannot read the master secret file ${path}`);
  });
  const mode = information.mode & 0o777;
  if ((mode & ~SECRET_FILE_MODE) !== 0) {
    throw new SecretError(
      `the master secret file ${path} has the mode ${mode.toString(8)}, and it must be ${SECRET_FILE_MODE.toString(8)}`,
    );
  }
  return fromText(await readFile(path, "utf8"), path);
}
