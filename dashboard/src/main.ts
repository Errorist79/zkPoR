#!/usr/bin/env node
/**
 * The one command that starts the dashboard.
 *
 * It reads the same configuration as the command line of the kit, opens the
 * listener on the loopback address, and prints the address to open. It reaches
 * the network only through the read calls of the kit, against the endpoint the
 * configuration names.
 */

import {
  ConfigurationError,
  generationsNewestFirst,
  EXIT_USAGE,
  openServer,
  readDeployments,
  resolveNetworkConfig,
  resolveReadOptions,
} from "@zkpor/sdk";
import { DEFAULT_PORT, LOOPBACK_HOST, PORT_ENV } from "./constants.js";
import { RunStore } from "./runs.js";
import { openDashboard } from "./server.js";

/**
 * The port of the environment, or the default.
 *
 * The value 0 asks the operating system for a free port. An operator needs that
 * when another process already holds the usual one, and a test needs it so a run
 * never fights whatever the machine is already running. The address that this
 * command prints comes from the listener, so a reader learns which port the
 * process took.
 *
 * The check compares the parsed number against the text it came from. A reader
 * of digits alone would take `0.5` for 0 and `70000x` for 70000, and would then
 * accept a mistake as a port.
 */
function port(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    return DEFAULT_PORT;
  }
  const text = value.trim();
  const parsed = Number.parseInt(text, 10);
  if (String(parsed) !== text || parsed < 0 || parsed > 65535) {
    throw new ConfigurationError(
      `${PORT_ENV} must carry a port number from 0 to 65535, and 0 asks for any free port`,
    );
  }
  return parsed;
}

async function main(): Promise<void> {
  const config = resolveNetworkConfig(process.env);
  const deploymentsText = await readDeployments(process.env);
  // This process holds no registry, and it still refuses to start against a
  // network the file does not record. That is a setting an operator can
  // correct, so they meet it now rather than on the first page they open.
  if (generationsNewestFirst(deploymentsText, config.network).length === 0) {
    throw new ConfigurationError(
      `the deployments file records no generation on the network ${config.network}`,
    );
  }
  const server = await openDashboard({
    port: port(process.env[PORT_ENV]),
    dashboard: {
      reader: {
        server: openServer(config),
        config,
        readOptions: resolveReadOptions(process.env),
        deploymentsText,
      },
      store: new RunStore(),
      environment: process.env,
      // The prover reads the circuits and the generator from the directory the
      // issuer started this process in, exactly as the command line does.
      repository: process.cwd(),
    },
  });
  // The address comes from the listener and never from the value that asked
  // for it. The two agree for a fixed port, and they differ when the setting
  // asked for any free one, so reading the listener is the only form that is
  // true in both cases.
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new ConfigurationError("the listener bound no port");
  }
  process.stdout.write(
    [
      `The zkPoR dashboard listens on http://${LOOPBACK_HOST}:${String(bound.port)}/`,
      `The network is ${config.network}.`,
      "The listener binds the loopback address only, so no other machine reaches it.",
      "Stop it with Ctrl-C.",
      "",
    ].join("\n"),
  );
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "the dashboard cannot start";
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_USAGE);
});
