/**
 * The network configuration and the one source of the current ledger.
 *
 * The client obtains its remote procedure call endpoint and its network
 * passphrase from its own configuration, never from a package or from a
 * record it reads. A supplied current ledger could hide a lapsed solvency
 * claim, so the value comes from the network that holds the registry.
 */

import { rpc } from "@stellar/stellar-sdk";

/** The configuration that every operation against one network needs. */
export interface NetworkConfig {
  /** The network name, as the deployments file records it. */
  readonly network: string;
  /** The address of the remote procedure call endpoint. */
  readonly rpcUrl: string;
  /** The network passphrase that every signature commits to. */
  readonly networkPassphrase: string;
  /** True when the endpoint serves plain HTTP, which a local network does. */
  readonly allowHttp?: boolean;
}

/** A failure of the infrastructure. A failure of this kind is not a verdict. */
export class InfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InfrastructureError";
  }
}

/** Opens a client for the endpoint of the configuration. */
export function openServer(config: NetworkConfig): rpc.Server {
  return new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp ?? false });
}

/** The latest closed ledger sequence of the network. */
export async function latestLedger(server: rpc.Server): Promise<number> {
  try {
    const answer = await server.getLatestLedger();
    return answer.sequence;
  } catch (cause) {
    throw new InfrastructureError("the client cannot read the latest ledger", { cause });
  }
}

/** The oldest ledger that the endpoint still retains, and the latest one. */
export interface RetainedLedgers {
  readonly oldestLedger: number;
  readonly latestLedger: number;
}

/**
 * The retained ledger window of the endpoint.
 *
 * An event query answers from this window only, so a report of history states
 * the oldest ledger that the query covered.
 */
export async function retainedLedgers(server: rpc.Server): Promise<RetainedLedgers> {
  try {
    const health = await server.getHealth();
    return { oldestLedger: health.oldestLedger, latestLedger: health.latestLedger };
  } catch (cause) {
    throw new InfrastructureError("the client cannot read the retained ledger window", { cause });
  }
}
