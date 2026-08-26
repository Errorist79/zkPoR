/**
 * The two secret channels of this client.
 *
 * The master secret derives every salt of every leaf, and a leaked one exposes
 * every leaf of every context that used it. The authority key signs the
 * attestation, and a leaked one lets another party attest for the asset. Both
 * are secrets and both follow one rule: they never travel in an argument
 * vector, where the process list of the machine shows them, and they never
 * reach a log or a page.
 *
 * A reader here returns the secret and never stores it. A caller passes the
 * result straight into the call that needs it, so no front end holds either
 * secret in a name of its own, where a later line could render or log it.
 *
 * The master secret has two accepted channels: an environment variable, and a
 * file whose mode gives no access to another user.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { readFile, stat } from "node:fs/promises";
import { MASTER_SECRET_ENV, MASTER_SECRET_FILE_ENV, SECRET_FILE_MODE } from "./constants.js";
import { AUTHORITY_SECRET_ENV, RESERVE_SECRET_ENV } from "./config.js";
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

/** True when the environment carries the master secret through one of its channels. */
export function carriesMasterSecret(environment: NodeJS.ProcessEnv = process.env): boolean {
  return (
    environment[MASTER_SECRET_ENV] !== undefined ||
    environment[MASTER_SECRET_FILE_ENV] !== undefined
  );
}

/** True when the environment carries the authority key. */
export function carriesAuthoritySecret(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[AUTHORITY_SECRET_ENV] !== undefined;
}

/**
 * Reads the secret key of the authority from the environment.
 *
 * The reader exists so a caller passes the key straight into the call that
 * signs with it, exactly as it does for the master secret. A caller that bound
 * the key to a name of its own could later render it, log it, or interpolate it
 * into a progress message, and the two secrets would then be held to different
 * rules.
 */
export function readAuthoritySecret(environment: NodeJS.ProcessEnv = process.env): string {
  const secret = environment[AUTHORITY_SECRET_ENV];
  if (secret === undefined || secret.length === 0) {
    throw new SecretError(
      `set ${AUTHORITY_SECRET_ENV} in the environment of this process; no argument carries the authority key`,
    );
  }
  return secret;
}

/**
 * Reads the key of the transaction source and returns the signer it makes.
 *
 * A caller that needs a signer would otherwise read the secret into a name of
 * its own in order to build one, which is the thing the readers here exist to
 * avoid. The secret enters and the signer leaves, so no front end holds the key.
 */
export function readAuthorityKeypair(environment: NodeJS.ProcessEnv = process.env): Keypair {
  const secret = readAuthoritySecret(environment);
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new SecretError(`${AUTHORITY_SECRET_ENV} does not carry a Stellar secret key`);
  }
}

/** True when the environment carries the key of a reserve holder. */
export function carriesReserveSecret(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[RESERVE_SECRET_ENV] !== undefined;
}

/**
 * Reads the key of a reserve holder and returns the signer it makes.
 *
 * The third secret of this client follows the rule of the other two. A reserve
 * holder runs this on its own machine, so its key is as sensitive there as the
 * authority key is on the machine of an authority.
 */
export function readReserveKeypair(environment: NodeJS.ProcessEnv = process.env): Keypair {
  const secret = environment[RESERVE_SECRET_ENV];
  if (secret === undefined || secret.length === 0) {
    throw new SecretError(
      `set ${RESERVE_SECRET_ENV} in the environment of this process; no argument carries the key of a reserve holder`,
    );
  }
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new SecretError(`${RESERVE_SECRET_ENV} does not carry a Stellar secret key`);
  }
}
