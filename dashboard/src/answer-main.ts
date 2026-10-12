#!/usr/bin/env node
import {
  EXIT_USAGE, openServer, readDeployments, resolveNetworkConfig, resolveReadOptions,
} from "@zkpor/sdk";
import { answerFromRetainedTree } from "./answer.js";
import { DISPUTE_FIELDS } from "./constants.js";
import { disputeSelection } from "./dispute.js";
import { SILENT_LOG } from "./log.js";

async function main(): Promise<void> {
  const [registry, asset, targetId, identifier, manifestPath] = process.argv.slice(2);
  if (process.argv.length !== 7 || registry === undefined || asset === undefined ||
    targetId === undefined || identifier === undefined || manifestPath === undefined) {
    throw new Error("usage: zkpor-answer <registry> <asset> <target-id> <identifier-hex> <generation.json>");
  }
  const config = resolveNetworkConfig(process.env);
  const result = await answerFromRetainedTree({
    reader: {
      server: openServer(config), config, readOptions: resolveReadOptions(process.env),
      deploymentsText: await readDeployments(process.env), log: SILENT_LOG,
    },
    selection: disputeSelection(new URLSearchParams({
      [DISPUTE_FIELDS.registry]: registry, [DISPUTE_FIELDS.asset]: asset,
      [DISPUTE_FIELDS.targetId]: targetId, [DISPUTE_FIELDS.identifier]: identifier,
    })),
    repository: process.cwd(), environment: process.env, manifestPath,
    beforeSend: async (hash) => {
      process.stdout.write(`Answer transaction hash before send: ${hash}\n`);
    },
  });
  process.stdout.write(`Answer settled at ledger ${result.submission.ledger}: ${result.submission.transactionHash}\n`);
  if (result.readFailure !== undefined) {
    process.stderr.write(`${result.readFailure}\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  process.stdout.write("Stored dispute status: Answered\n");
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : "The answer command failed."}\n`);
  process.exitCode = EXIT_USAGE;
});
