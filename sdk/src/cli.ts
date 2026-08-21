#!/usr/bin/env node
/**
 * The `zkpor` command line.
 *
 * Each command maps one outcome to one exit code. A verdict of the inclusion
 * check keeps its own code, and an infrastructure failure keeps a code of its
 * own, because it is not a verdict.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Account, Address, xdr } from "@stellar/stellar-sdk";
import {
  CONSENT_VALIDITY_LEDGERS,
  MASTER_SECRET_ENV,
  MASTER_SECRET_FILE_ENV,
} from "./constants.js";
import { latestLedger, openServer } from "./network.js";
import type { NetworkConfig } from "./network.js";
import {
  AUTHORITY_SECRET_ENV,
  ConfigurationError,
  DEPLOYMENTS_ENV,
  RESERVE_SECRET_ENV,
  NETWORK_ENV,
  PASSPHRASE_ENV,
  READ_SOURCE_ENV,
  RPC_URL_ENV,
  readDeployments,
  resolveNetworkConfig,
  resolveReadOptions,
} from "./config.js";
import type { Generation } from "./deployments.js";
import {
  generationForRegistration,
  generationsNewestFirst,
  locateAsset,
} from "./resolve.js";
import {
  EXIT_NO_VERDICT,
  EXIT_USAGE,
  exitCode,
  verdictLines,
  verifyInclusion,
} from "./inclusion.js";
import {
  defaultHistoryStart,
  observeReserves,
  readAttestationHistory,
  solvencyLapsed,
} from "./registry.js";
import type { ReadOptions } from "./registry.js";
import { diagnoseReserves } from "./diagnose.js";
import {
  consentState,
  describeEntry,
  signConsentEntry,
  signEntryInEnvelope,
} from "./consent.js";
import { prepareRegistration, readPreparedCall, submitPreparedCall } from "./registration.js";
import { isAcceptedAddress } from "./address.js";
import { bytesFromHex } from "./fr.js";
import { ProvingError, prove, readContext, windowAllowsProving } from "./proving.js";
import {
  carriesAuthoritySecret,
  carriesReserveSecret,
  readAuthorityKeypair,
  readAuthoritySecret,
  readMasterSecret,
  readReserveKeypair,
} from "./secret.js";
import { attestWithAuthority } from "./attest.js";
import { attestAndReport, completeCommand, failureNote, runReport } from "./report.js";
import type { CommandResult } from "./report.js";

const USAGE = `zkpor <command> [arguments]

Commands:
  verify-inclusion <package.zkpor.json> [deployments.json]
      Check one customer package against the registry.

  entry <asset>
      Print the registry record of one asset.

  observe-reserves <asset>
      Print the current reserve sum. No attestation covers this reading.

  history <asset> [from-ledger]
      Print the attestation events, and the oldest ledger the query covered.

  diagnose-reserves <asset>
      Read each registered reserve balance on its own and name every failure.

  prepare-registration <asset> <authority> <reserve>[,<reserve>...] [asset-xdr]
      Simulate the registration and print one authorization entry per reserve.
      The last argument is the serialized asset as hexadecimal digits, which
      registers a classic asset. Without it the call registers a contract token
      and the registry asks that token for its administrator.

  sign-entry <reserve-address>
      Sign one exported authorization entry. The entry arrives on the standard
      input as base64, and the secret key arrives in ${RESERVE_SECRET_ENV}.

  sign-entry-in-transaction <reserve-address> <valid-until-ledger> <passphrase>
      Sign the entry of one address inside a whole transaction envelope. The
      envelope arrives on the standard input as base64 and leaves on the
      standard output. The secret key arrives in ${RESERVE_SECRET_ENV}.

  prove <context.toml> <customers.csv> [repository]
      Produce one aggregated proof with the pinned prover, and print the root
      and the total liabilities that it commits to. The master secret arrives
      in ${MASTER_SECRET_ENV} or in the mode 0600 file that
      ${MASTER_SECRET_FILE_ENV} names, never in an argument.

  attest <context.toml> <customers.csv> [repository]
      Prove, then submit the attestation. The authority key arrives in
      ${AUTHORITY_SECRET_ENV}.

  consent-validity-ledgers
      Print the ledger count that a reserve consent stays valid for. A caller
      that computes its own deadline reads the value here, so the number has
      one definition.

  submit-registration <prepared.json> <signed-entry.txt>[,<signed-entry.txt>...]
      Reassemble a prepared registration, sign the envelope, and submit it.

Configuration comes from the environment: ${NETWORK_ENV}, ${RPC_URL_ENV},
${PASSPHRASE_ENV}, ${READ_SOURCE_ENV}, and ${DEPLOYMENTS_ENV}.

A package reveals the balance of one customer. Share the file only with a party
that may see that balance.`;

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// A missing configuration value stops the command line with the usage code.
// The resolver throws instead, because the dashboard reports the same failure
// to a reader and must stay running.
function networkConfig(): NetworkConfig {
  try {
    return resolveNetworkConfig(process.env);
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      fail(cause.message, EXIT_USAGE);
    }
    throw cause;
  }
}

function readOptions(): ReadOptions {
  try {
    return resolveReadOptions(process.env);
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      fail(cause.message, EXIT_USAGE);
    }
    throw cause;
  }
}

async function deploymentsText(path: string | undefined): Promise<string> {
  return await readDeployments(process.env, path);
}

/**
 * One address that an argument carries.
 *
 * An address that this protocol does not accept is a value the operator can
 * correct, so it belongs to the usage code. Without this check it reaches the
 * client library, which refuses it with a message about an unsupported type,
 * and the command line reports it as a failure of the client or of the
 * network. That is the same category error as a context file that omits a
 * field, on a different input.
 */
function addressArgument(value: string, what: string): string {
  if (!isAcceptedAddress(value)) {
    fail(`${what} is not a Stellar account address and not a contract address: ${value}`, EXIT_USAGE);
  }
  return value;
}

function print(lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}


async function commandVerifyInclusion(args: readonly string[]): Promise<CommandResult> {
  const packagePath = args[0];
  if (packagePath === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const config = networkConfig();
  const verdict = await verifyInclusion({
    packageText: await readFile(packagePath, "utf8"),
    deploymentsText: await deploymentsText(args[1]),
    server: openServer(config),
    config,
    readOptions: readOptions(),
  });
  return { lines: verdictLines(verdict), code: exitCode(verdict) };
}

/**
 * What a read says when no recorded generation holds the asset.
 *
 * It names every generation the walk asked. A reader who expected a record
 * learns which registries answered for it, and a reader whose asset lives on a
 * network this file does not record learns that too.
 */
function noHolder(asset: string, asked: readonly Generation[]): string {
  const names = asked.map((generation) => generation.registry).join(", ");
  return `No recorded generation holds the asset ${asset}. This client asked ${names}.`;
}

async function commandEntry(args: readonly string[]): Promise<CommandResult> {
  const named = args[0];
  if (named === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const asset = addressArgument(named, "the asset");
  const config = networkConfig();
  const server = openServer(config);
  const located = await locateAsset({
    server,
    config,
    options: readOptions(),
    deploymentsText: await deploymentsText(undefined),
    asset,
  });
  if (located.holder === undefined) {
    return { lines: [noHolder(asset, located.asked)] };
  }
  const { generation, record } = located.holder;
  const registry = generation.registry;
  const lines = [
    `The registry is ${registry}.`,
    `The authority is ${record.authority}.`,
    record.tier === "ClassicIssuer"
      ? "The tier is the classic issuer tier, and the authority is the issuer of the asset."
      : "The tier is the contract administrator tier, and the authority is the administrator that the token names.",
    `The reserve addresses are ${record.reserves.join(", ")}.`,
  ];
  if (record.attestation === undefined) {
    lines.push("The registry holds no attestation for this asset.");
  } else {
    const current = await latestLedger(server);
    lines.push(
      `The snapshot ledger is ${record.attestation.snapshotLedger}.`,
      `The total liabilities are ${record.attestation.totalLiabilities.toString(10)}.`,
      `The reserves at the attestation, at ledger ${record.attestation.attestedLedger}, were ${record.attestation.reserveSum.toString(10)}.`,
      solvencyLapsed(record.attestation.snapshotLedger, current)
        ? `The solvency claim has lapsed at the current ledger ${current}.`
        : `The solvency claim is current at ledger ${current}.`,
    );
  }
  return { lines };
}

async function commandObserveReserves(args: readonly string[]): Promise<CommandResult> {
  const named = args[0];
  if (named === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const asset = addressArgument(named, "the asset");
  const config = networkConfig();
  const server = openServer(config);
  const options = readOptions();
  const located = await locateAsset({
    server,
    config,
    options,
    deploymentsText: await deploymentsText(undefined),
    asset,
  });
  if (located.holder === undefined) {
    fail(noHolder(asset, located.asked), EXIT_NO_VERDICT);
  }
  const registry = located.holder.generation.registry;
  const observation = await observeReserves(server, config, options, registry, asset);
  return {
    lines: [
      `The registry ${registry} read the reserves of ${asset} at ledger ${observation.observedLedger}.`,
      `The sum of the reserve balances is ${observation.observedSum.toString(10)}.`,
      "No attestation covers this reading. It is an observation at that ledger.",
    ],
  };
}

async function commandHistory(args: readonly string[]): Promise<CommandResult> {
  const named = args[0];
  if (named === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const asset = addressArgument(named, "the asset");
  const config = networkConfig();
  const server = openServer(config);
  const from =
    args[1] === undefined
      ? defaultHistoryStart(await latestLedger(server))
      : Number.parseInt(args[1], 10);
  // Every recorded generation, and not the one that holds the record. An issuer
  // who registered again after a migration has attestations on two registries,
  // and a query that read one of them would answer truthfully and read as the
  // whole history. Asking each generation costs a query and says which
  // registry each attestation came from.
  const generations = generationsNewestFirst(await deploymentsText(undefined), config.network);
  if (generations.length === 0) {
    fail(`the deployments file records no generation on the network ${config.network}`, EXIT_NO_VERDICT);
  }
  const lines: string[] = [];
  for (const generation of generations) {
    let history;
    try {
      history = await readAttestationHistory(
        server,
        generation.registry,
        asset,
        Math.max(from, 0),
      );
    } catch (cause) {
      fail(
        `the registry ${generation.registry} did not answer the attestation query, so this result would not say whether it holds earlier attestations: ${cause instanceof Error ? cause.message : String(cause)}`,
        EXIT_NO_VERDICT,
      );
    }
    lines.push(
      `The registry ${generation.registry}:`,
      `  The query covered the ledgers from ${history.oldestLedgerCovered} to ${history.latestLedger}.`,
      `  The endpoint retains the ledgers from ${history.oldestLedgerRetained}.`,
    );
    if (history.reachesTheRetentionLimit) {
      lines.push(
        "  The query started at the oldest retained ledger, so an earlier attestation may exist that this result does not name.",
      );
    }
    if (history.coversTheWholeRange) {
      lines.push(`  The query found ${history.attestations.length} attestations.`);
    } else {
      lines.push(
        `  The endpoint stopped before the end of the range, so this result does not say how many attestations the range holds. It names the ${history.attestations.length} attestations that the query saw. Ask again from a later ledger.`,
      );
    }
    for (const attestation of history.attestations) {
      lines.push(
        `  Ledger ${attestation.ledger}: snapshot ${attestation.snapshotLedger}, liabilities ${attestation.totalLiabilities.toString(10)}, reserves ${attestation.reserveSum.toString(10)}, transaction ${attestation.transactionHash}.`,
      );
    }
  }
  return { lines };
}

async function commandDiagnoseReserves(args: readonly string[]): Promise<CommandResult> {
  const named = args[0];
  if (named === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const asset = addressArgument(named, "the asset");
  const config = networkConfig();
  const server = openServer(config);
  const options = readOptions();
  const located = await locateAsset({
    server,
    config,
    options,
    deploymentsText: await deploymentsText(undefined),
    asset,
  });
  if (located.holder === undefined) {
    fail(noHolder(asset, located.asked), EXIT_NO_VERDICT);
  }
  const record = located.holder.record;
  const diagnosis = await diagnoseReserves(server, config, options, {
    asset,
    reserves: record.reserves,
  });
  const lines = diagnosis.readings.map((reading) =>
    reading.balance === undefined
      ? `${reading.address}: no balance. ${reading.failure ?? ""}`.trimEnd()
      : `${reading.address}: ${reading.balance.toString(10)}`,
  );
  lines.push(`The readings that answered sum to ${diagnosis.sumOfTheReadings.toString(10)}.`);
  if (diagnosis.failed.length > 0) {
    lines.push(
      `The registry cannot attest while a balance read fails. These addresses failed: ${diagnosis.failed.join(", ")}.`,
    );
  }
  return diagnosis.failed.length > 0 ? { lines, code: 1 } : { lines };
}

async function commandPrepareRegistration(args: readonly string[]): Promise<CommandResult> {
  const [asset, authority, reserveList, serializedAsset] = args;
  if (asset === undefined || authority === undefined || reserveList === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const reserves = reserveList.split(",").map((address) => address.trim());
  addressArgument(asset, "the asset");
  addressArgument(authority, "the authority");
  for (const address of reserves) {
    addressArgument(address, "a reserve address");
  }
  const config = networkConfig();
  const server = openServer(config);
  if (!carriesAuthoritySecret(process.env)) {
    fail(`set ${AUTHORITY_SECRET_ENV} to the secret key of the transaction source`, EXIT_USAGE);
  }
  // The key is read into the signer it makes and reaches no value here.
  const source = readAuthorityKeypair(process.env);
  const account = await server.getAccount(source.publicKey());
  const prepared = await prepareRegistration(server, config, {
    sourceAccount: new Account(account.accountId(), account.sequenceNumber()),
    registry: generationForRegistration(await deploymentsText(undefined), config.network)
      .registry,
    asset,
    authority,
    authenticity:
      serializedAsset === undefined
        ? { tier: "contract" }
        : { tier: "classic", serializedAsset: bytesFromHex(serializedAsset) },
    reserves,
    currentLedger: await latestLedger(server),
  });
  return { lines: [JSON.stringify(prepared, null, 2)] };
}

async function commandSignEntry(args: readonly string[]): Promise<CommandResult> {
  const named = args[0];
  if (named === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const address = addressArgument(named, "the reserve address");
  if (!carriesReserveSecret(process.env)) {
    fail(`set ${RESERVE_SECRET_ENV} to the secret key of ${address}`, EXIT_USAGE);
  }
  // The key is read into the signer it makes and reaches no value here.
  const signer = readReserveKeypair(process.env);
  if (signer.publicKey() !== Address.fromString(address).toString()) {
    fail(`the secret key does not belong to ${address}`, EXIT_USAGE);
  }
  const config = networkConfig();
  const text = readFileSync(0, "utf8");
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(text.trim(), "base64");
  const described = describeEntry(entry);
  const signed = await signConsentEntry({
    entryXdr: described.entryXdr,
    signer,
    expirationLedger:
      described.expirationLedger > 0
        ? described.expirationLedger
        : (await latestLedger(openServer(config))) + CONSENT_VALIDITY_LEDGERS,
    networkPassphrase: config.networkPassphrase,
    expectedAddress: address,
  });
  return { lines: [signed.entryXdr] };
}

/**
 * Signs one entry inside a whole envelope.
 *
 * The command takes the network passphrase and the deadline as arguments, so a
 * caller that drives a pipeline needs no endpoint and no other configuration.
 */
async function commandSignEntryInTransaction(args: readonly string[]): Promise<CommandResult> {
  const [named, validUntil, passphrase] = args;
  if (named === undefined || validUntil === undefined || passphrase === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const address = addressArgument(named, "the reserve address");
  const deadline = Number.parseInt(validUntil, 10);
  if (!Number.isInteger(deadline) || deadline <= 0) {
    fail("the ledger until which the consent stays valid is a positive integer", EXIT_USAGE);
  }
  if (!carriesReserveSecret(process.env)) {
    fail(`set ${RESERVE_SECRET_ENV} to the secret key of ${address}`, EXIT_USAGE);
  }
  // The key is read into the signer it makes and reaches no value here.
  const signer = readReserveKeypair(process.env);
  if (signer.publicKey() !== Address.fromString(address).toString()) {
    fail(`the secret key does not belong to ${address}`, EXIT_USAGE);
  }
  const signed = await signEntryInEnvelope({
    envelopeXdr: readFileSync(0, "utf8").trim(),
    address,
    signer,
    expirationLedger: deadline,
    networkPassphrase: passphrase,
  });
  return { lines: [signed] };
}

async function commandSubmitRegistration(args: readonly string[]): Promise<CommandResult> {
  const [preparedPath, signedList] = args;
  if (preparedPath === undefined || signedList === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const config = networkConfig();
  const server = openServer(config);
  const prepared = readPreparedCall(await readFile(preparedPath, "utf8"));
  const collected = await Promise.all(
    signedList.split(",").map(async (path) => {
      const text = (await readFile(path.trim(), "utf8")).trim();
      return describeEntry(xdr.SorobanAuthorizationEntry.fromXDR(text, "base64"));
    }),
  );
  const state = consentState(collected, await latestLedger(server));
  for (const one of state) {
    if (!one.signed) {
      fail(`the address ${one.address} did not sign its authorization entry`, EXIT_USAGE);
    }
    if (one.expired) {
      fail(
        `the consent of ${one.address} expired at ledger ${one.expirationLedger}; collect it again`,
        EXIT_USAGE,
      );
    }
  }
  if (!carriesAuthoritySecret(process.env)) {
    fail(`set ${AUTHORITY_SECRET_ENV} to the secret key of the transaction source`, EXIT_USAGE);
  }
  const result = await submitPreparedCall(server, config, {
    prepared,
    collected,
    // The key is read into the signer it makes and reaches no value here.
    envelopeSigner: readAuthorityKeypair(process.env),
  });
  return {
    lines: [
      `The network accepted the registration at ledger ${result.ledger}.`,
      `The transaction is ${result.transactionHash}.`,
    ],
  };
}

async function runProof(args: readonly string[]) {
  const [contextFile, customersFile, repository] = args;
  if (contextFile === undefined || customersFile === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const config = networkConfig();
  const server = openServer(config);
  // A context file that cannot be read, and one that omits a field, are both
  // values the operator can correct. They belong to the usage code and not to
  // the code that means a failure of the client or of the network.
  const context = await readContext(contextFile).catch((cause: unknown) => {
    if (cause instanceof ProvingError) {
      fail(cause.message, EXIT_USAGE);
    }
    throw cause;
  });
  // The window check reads the ledger from the network, because a typed value
  // could hide a snapshot that can no longer land.
  windowAllowsProving(context.snapshotLedger, await latestLedger(server));
  const proof = await prove({
    repository: repository ?? process.cwd(),
    contextFile,
    customersFile,
    masterSecret: await readMasterSecret(),
    report: (step) => process.stderr.write(`[prove] ${step}\n`),
  });
  return { config, server, context, proof };
}

async function commandProve(args: readonly string[]): Promise<CommandResult> {
  const { server, proof, context } = await runProof(args);
  return { lines: runReport({ context, proof, currentLedger: await latestLedger(server) }) };
}

async function commandAttest(args: readonly string[]): Promise<CommandResult> {
  const { config, server, context, proof } = await runProof(args);
  // The presence of the key is checked here and its value is not read here. A
  // key that the environment does not carry is a wrong command line, and the
  // read below happens inside the call that signs with it.
  if (!carriesAuthoritySecret(process.env)) {
    fail(`set ${AUTHORITY_SECRET_ENV} to the secret key of the authority`, EXIT_USAGE);
  }
  // The attestation goes where the asset is registered. An asset that lives on
  // an earlier generation can be attested nowhere else, and the newest
  // generation holds no record of it.
  const located = await locateAsset({
    server,
    config,
    options: readOptions(),
    deploymentsText: await deploymentsText(undefined),
    asset: context.asset,
  });
  if (located.holder === undefined) {
    fail(noHolder(context.asset, located.asked), EXIT_NO_VERDICT);
  }
  const registry = located.holder.generation.registry;
  const outcome = await attestAndReport({
    context,
    proof,
    readCurrentLedger: async () => await latestLedger(server),
    submit: async () => {
      const accepted = await attestWithAuthority(
        server,
        config,
        // The key is read here and passed on in the same expression, so it
        // reaches no value of this command line.
        readAuthoritySecret(process.env),
        {
          registry,
          asset: context.asset,
          snapshotLedger: context.snapshotLedger,
          finalRoot: proof.values.final_root,
          totalLiabilities: proof.values.L,
          proof: proof.proof,
        },
      );
      return { ledger: accepted.ledger, transactionHash: accepted.transactionHash };
    },
  });
  return { lines: outcome.lines, failure: outcome.failure };
}

/** The command that one name runs, or nothing when the name is not a command. */
async function run(command: string, args: readonly string[]): Promise<CommandResult> {
  switch (command) {
    case "verify-inclusion":
      return await commandVerifyInclusion(args);
    case "entry":
      return await commandEntry(args);
    case "observe-reserves":
      return await commandObserveReserves(args);
    case "history":
      return await commandHistory(args);
    case "diagnose-reserves":
      return await commandDiagnoseReserves(args);
    case "prepare-registration":
      return await commandPrepareRegistration(args);
    case "sign-entry":
      return await commandSignEntry(args);
    case "sign-entry-in-transaction":
      return await commandSignEntryInTransaction(args);
    case "prove":
      return await commandProve(args);
    case "attest":
      return await commandAttest(args);
    case "consent-validity-ledgers":
      return { lines: [String(CONSENT_VALIDITY_LEDGERS)] };
    case "submit-registration":
      return await commandSubmitRegistration(args);
    default:
      fail(USAGE, EXIT_USAGE);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const result = await run(command ?? "", args);
  // Every command states what it produced through this one call. A command
  // that printed for itself put that statement on a path only it reached, and
  // the two that need the pinned toolchain reach nothing a test can drive.
  // The statement and the raise happen in one place outside this file, so the
  // order between them can be driven. The one command that returns a failure
  // cannot be reached without the pinned toolchain.
  const code = completeCommand(result, print);
  if (code !== undefined) {
    process.exit(code);
  }
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${failureNote(cause)}\n`);
  process.exit(EXIT_NO_VERDICT);
});
