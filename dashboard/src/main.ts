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
  carriesAuthoritySecret,
  carriesMasterSecret,
  deploymentsPath,
  generationsNewestFirst,
  EXIT_USAGE,
  openServer,
  readDeployments,
  resolveNetworkConfig,
  resolveReadOptions,
} from "@zkpor/sdk";
import { DEFAULT_PORT, LOG_SETTING_ENV, LOOPBACK_HOST, PORT_ENV } from "./constants.js";
import { LOG_SETTINGS, endpointOrigin, openLog } from "./log.js";
import type { Log, LogSetting } from "./log.js";
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

/**
 * How much this process records, from the environment.
 *
 * A value that names no setting stops the start. An operator who wrote the name
 * of a setting wants that setting, and a process that answered a mistake with
 * the default would record less than the operator believes it records.
 */
function logSetting(value: string | undefined): LogSetting {
  if (value === undefined || value.length === 0) {
    return "info";
  }
  const named = LOG_SETTINGS.find((setting) => setting === value.trim());
  if (named === undefined) {
    throw new ConfigurationError(
      `${LOG_SETTING_ENV} must carry one of ${LOG_SETTINGS.join(", ")}`,
    );
  }
  return named;
}

/** The log of this process. Every line goes to the standard error stream. */
function processLog(environment: NodeJS.ProcessEnv): Log {
  return openLog({
    setting: logSetting(environment[LOG_SETTING_ENV]),
    write: (line) => {
      process.stderr.write(line);
    },
  });
}

async function main(): Promise<void> {
  const log = processLog(process.env);
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
        log,
      },
      store: new RunStore(log),
      log,
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
  // The banner and the log carry the same facts. The banner is the interface to
  // the person who typed the command, and the address it names is the host and
  // the port below, so an operator who keeps the standard output stream only
  // loses convenience and never information.
  log({
    event: "process.started",
    host: LOOPBACK_HOST,
    port: bound.port,
    network: config.network,
    rpc_origin: endpointOrigin(config.rpcUrl),
    generations: generationsNewestFirst(deploymentsText, config.network).length,
    deployments_file: deploymentsPath(process.env),
    repository: process.cwd(),
    master_secret_present: carriesMasterSecret(process.env),
    authority_secret_present: carriesAuthoritySecret(process.env),
  });
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
  // The setting of the log can be the reason this process stops, so the record
  // of the refusal takes the default setting rather than the one that failed.
  openLog({
    setting: "info",
    write: (line) => {
      process.stderr.write(line);
    },
  })({ event: "process.refused", error: message });
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_USAGE);
});
