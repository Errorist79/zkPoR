/**
 * The configuration of a client, read from the environment of its process.
 *
 * The command line and the dashboard are two front ends over the same client,
 * so they must resolve an endpoint, a network, and a deployments file the same
 * way. One definition here gives them that. A resolver throws instead of
 * stopping the process, because a server that stops on a bad value gives its
 * reader no message.
 */

import { Address } from "@stellar/stellar-sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PACKAGES_DIRECTORY_NAME } from "./constants.js";
import { InfrastructureError } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { passphraseOfNetwork } from "./registry.js";
import type { ReadOptions } from "./registry.js";

/** The environment variable that names the network. */
export const NETWORK_ENV = "ZKPOR_NETWORK";

/** The environment variable that names the endpoint. */
export const RPC_URL_ENV = "ZKPOR_RPC_URL";

/** The environment variable that names the network passphrase. */
export const PASSPHRASE_ENV = "ZKPOR_NETWORK_PASSPHRASE";

/** The environment variable that names the account a read simulates as. */
export const READ_SOURCE_ENV = "ZKPOR_READ_SOURCE";

/** The environment variable that names the deployments file. */
export const DEPLOYMENTS_ENV = "ZKPOR_DEPLOYMENTS";


/** The environment name that says where the packages of the customers land. */
export const PACKAGES_OUT_ENV = "ZKPOR_PACKAGES_OUT";

/**
 * The directory of the packages, beside the balance file when nothing names
 * one.
 *
 * The balance file already holds every balance in clear text, so its directory
 * is already at the sensitivity that a package carries. Writing there keeps the
 * material of the customers in one place that the issuer chose, and keeps it
 * out of the repository, where the sweep of a run and the working tree of the
 * project both live.
 */
export function packagesDirectory(environment: Environment, customersFile: string): string {
  const named = environment[PACKAGES_OUT_ENV];
  if (named !== undefined && named.length > 0) {
    return named;
  }
  return join(dirname(customersFile), PACKAGES_DIRECTORY_NAME);
}

/** The default path of the deployments file, against the working directory. */
export const DEFAULT_DEPLOYMENTS = "scripts/deployments.json";

/** The environment variable that carries the secret key of a reserve holder. */
export const RESERVE_SECRET_ENV = "ZKPOR_RESERVE_SECRET";

/** The environment variable that carries the secret key of the authority. */
export const AUTHORITY_SECRET_ENV = "ZKPOR_AUTHORITY_SECRET";

/** The environment, as a process gives it: a name maps to a value or to nothing. */
export type Environment = Readonly<Partial<Record<string, string>>>;

/** A configuration value that the environment does not carry, or cannot carry. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * The network configuration of the environment.
 *
 * The endpoint decides whether the client accepts plain HTTP. A local network
 * serves plain HTTP, and every other endpoint must carry a certificate.
 */
export function resolveNetworkConfig(environment: Environment): NetworkConfig {
  const network = environment[NETWORK_ENV];
  if (network === undefined || network.length === 0) {
    throw new ConfigurationError(
      `set ${NETWORK_ENV} to the network name that the deployments file records`,
    );
  }
  const rpcUrl = environment[RPC_URL_ENV];
  if (rpcUrl === undefined || rpcUrl.length === 0) {
    throw new ConfigurationError(`set ${RPC_URL_ENV} to the address of the endpoint`);
  }
  const passphrase = environment[PASSPHRASE_ENV] ?? passphraseOfNetwork(network);
  if (passphrase === undefined) {
    throw new ConfigurationError(
      `set ${PASSPHRASE_ENV}, because this client does not know the network ${network}`,
    );
  }
  return {
    network,
    rpcUrl,
    networkPassphrase: passphrase,
    allowHttp: rpcUrl.startsWith("http://"),
  };
}

/** The read options of the environment. A read needs no signature and no funds. */
export function resolveReadOptions(environment: Environment): ReadOptions {
  const source = environment[READ_SOURCE_ENV];
  if (source === undefined || source.length === 0) {
    return {};
  }
  try {
    return { readSourceAccount: Address.fromString(source).toString() };
  } catch (cause) {
    throw new ConfigurationError(`${READ_SOURCE_ENV} does not carry an address: ${String(cause)}`);
  }
}

/** The path of the deployments file: the argument, then the environment, then the default. */
export function deploymentsPath(environment: Environment, path?: string): string {
  return path ?? environment[DEPLOYMENTS_ENV] ?? DEFAULT_DEPLOYMENTS;
}

/** The text of the deployments file that this client trusts. */
export async function readDeployments(environment: Environment, path?: string): Promise<string> {
  const chosen = deploymentsPath(environment, path);
  try {
    return await readFile(chosen, "utf8");
  } catch {
    throw new InfrastructureError(`the client cannot read the deployments file ${chosen}`);
  }
}
