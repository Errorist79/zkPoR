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
import { Account, Address, Keypair, xdr } from "@stellar/stellar-sdk";
import {
  CONSENT_VALIDITY_LEDGERS,
  HISTORY_DEFAULT_LEDGERS,
  MASTER_SECRET_ENV,
  MASTER_SECRET_FILE_ENV,
} from "./constants.js";
import { InfrastructureError, latestLedger, openServer } from "./network.js";
import type { NetworkConfig } from "./network.js";
import { currentGeneration } from "./deployments.js";
import {
  EXIT_NO_VERDICT,
  EXIT_USAGE,
  exitCode,
  verdictLines,
  verifyInclusion,
} from "./inclusion.js";
import {
  observeReserves,
  passphraseOfNetwork,
  readAssetRecord,
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
import { addressParts } from "./address.js";
import { bytesFromHex, toHex } from "./fr.js";
import { prove, windowAllowsProving } from "./proving.js";
import { readMasterSecret } from "./secret.js";
import { submitAttestation } from "./attest.js";

/** The environment variable that names the endpoint. */
const RPC_URL_ENV = "ZKPOR_RPC_URL";
/** The environment variable that names the network. */
const NETWORK_ENV = "ZKPOR_NETWORK";
/** The environment variable that names the network passphrase. */
const PASSPHRASE_ENV = "ZKPOR_NETWORK_PASSPHRASE";
/** The environment variable that names the account a read simulates as. */
const READ_SOURCE_ENV = "ZKPOR_READ_SOURCE";
/** The environment variable that names the deployments file. */
const DEPLOYMENTS_ENV = "ZKPOR_DEPLOYMENTS";
/** The environment variable that carries the secret key of a reserve holder. */
const RESERVE_SECRET_ENV = "ZKPOR_RESERVE_SECRET";
/** The environment variable that carries the secret key of the authority. */
const AUTHORITY_SECRET_ENV = "ZKPOR_AUTHORITY_SECRET";
/** The default path of the deployments file, relative to the working directory. */
const DEFAULT_DEPLOYMENTS = "scripts/deployments.json";

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

function networkConfig(): NetworkConfig {
  const network = process.env[NETWORK_ENV];
  if (network === undefined) {
    fail(`set ${NETWORK_ENV} to the network name that the deployments file records`, EXIT_USAGE);
  }
  const rpcUrl = process.env[RPC_URL_ENV];
  if (rpcUrl === undefined) {
    fail(`set ${RPC_URL_ENV} to the address of the endpoint`, EXIT_USAGE);
  }
  const passphrase = process.env[PASSPHRASE_ENV] ?? passphraseOfNetwork(network);
  if (passphrase === undefined) {
    fail(`set ${PASSPHRASE_ENV}, because this client does not know the network ${network}`, EXIT_USAGE);
  }
  return {
    network,
    rpcUrl,
    networkPassphrase: passphrase,
    allowHttp: rpcUrl.startsWith("http://"),
  };
}

function readOptions(): ReadOptions {
  const source = process.env[READ_SOURCE_ENV];
  if (source === undefined) {
    return {};
  }
  return { readSourceAccount: Address.fromString(source).toString() };
}

async function deploymentsText(path: string | undefined): Promise<string> {
  const chosen = path ?? process.env[DEPLOYMENTS_ENV] ?? DEFAULT_DEPLOYMENTS;
  try {
    return await readFile(chosen, "utf8");
  } catch {
    throw new InfrastructureError(`the client cannot read the deployments file ${chosen}`);
  }
}

function print(lines: readonly string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function registryOf(config: NetworkConfig, path?: string): Promise<string> {
  const generation = currentGeneration(await deploymentsText(path), config.network);
  if (generation === undefined) {
    throw new InfrastructureError(
      `the deployments file records no generation on the network ${config.network}`,
    );
  }
  return generation.registry;
}

async function commandVerifyInclusion(args: readonly string[]): Promise<never> {
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
  print(verdictLines(verdict));
  process.exit(exitCode(verdict));
}

async function commandEntry(args: readonly string[]): Promise<void> {
  const asset = args[0];
  if (asset === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const config = networkConfig();
  const server = openServer(config);
  const registry = await registryOf(config);
  const record = await readAssetRecord(server, config, readOptions(), registry, asset);
  if (record === undefined) {
    print([`The registry ${registry} holds no record of the asset ${asset}.`]);
    return;
  }
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
  print(lines);
}

async function commandObserveReserves(args: readonly string[]): Promise<void> {
  const asset = args[0];
  if (asset === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const config = networkConfig();
  const server = openServer(config);
  const observation = await observeReserves(
    server,
    config,
    readOptions(),
    await registryOf(config),
    asset,
  );
  print([
    `The registry read the reserves of ${asset} at ledger ${observation.observedLedger}.`,
    `The sum of the reserve balances is ${observation.observedSum.toString(10)}.`,
    "No attestation covers this reading. It is an observation at that ledger.",
  ]);
}

async function commandHistory(args: readonly string[]): Promise<void> {
  const asset = args[0];
  if (asset === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const config = networkConfig();
  const server = openServer(config);
  const registry = await registryOf(config);
  const from =
    args[1] === undefined
      ? (await latestLedger(server)) - HISTORY_DEFAULT_LEDGERS
      : Number.parseInt(args[1], 10);
  const history = await readAttestationHistory(server, registry, asset, Math.max(from, 0));
  const lines = [
    `The query covered the ledgers from ${history.oldestLedgerCovered} to ${history.latestLedger}.`,
    `The endpoint retains the ledgers from ${history.oldestLedgerRetained}.`,
  ];
  if (history.reachesTheRetentionLimit) {
    lines.push(
      "The query started at the oldest retained ledger, so an earlier attestation may exist that this result does not name.",
    );
  }
  lines.push(`The query found ${history.attestations.length} attestations.`);
  for (const attestation of history.attestations) {
    lines.push(
      `Ledger ${attestation.ledger}: snapshot ${attestation.snapshotLedger}, liabilities ${attestation.totalLiabilities.toString(10)}, reserves ${attestation.reserveSum.toString(10)}, transaction ${attestation.transactionHash}.`,
    );
  }
  print(lines);
}

async function commandDiagnoseReserves(args: readonly string[]): Promise<void> {
  const asset = args[0];
  if (asset === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const config = networkConfig();
  const server = openServer(config);
  const options = readOptions();
  const record = await readAssetRecord(
    server,
    config,
    options,
    await registryOf(config),
    asset,
  );
  if (record === undefined) {
    fail(`the registry holds no record of the asset ${asset}`, EXIT_NO_VERDICT);
  }
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
  print(lines);
  if (diagnosis.failed.length > 0) {
    process.exit(1);
  }
}

async function commandPrepareRegistration(args: readonly string[]): Promise<void> {
  const [asset, authority, reserveList, serializedAsset] = args;
  if (asset === undefined || authority === undefined || reserveList === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const reserves = reserveList.split(",").map((address) => address.trim());
  for (const address of [asset, authority, ...reserves]) {
    addressParts(address);
  }
  const config = networkConfig();
  const server = openServer(config);
  const secret = process.env[AUTHORITY_SECRET_ENV];
  if (secret === undefined) {
    fail(`set ${AUTHORITY_SECRET_ENV} to the secret key of the transaction source`, EXIT_USAGE);
  }
  const source = Keypair.fromSecret(secret);
  const account = await server.getAccount(source.publicKey());
  const prepared = await prepareRegistration(server, config, {
    sourceAccount: new Account(account.accountId(), account.sequenceNumber()),
    registry: await registryOf(config),
    asset,
    authority,
    authenticity:
      serializedAsset === undefined
        ? { tier: "contract" }
        : { tier: "classic", serializedAsset: bytesFromHex(serializedAsset) },
    reserves,
    currentLedger: await latestLedger(server),
  });
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
}

async function commandSignEntry(args: readonly string[]): Promise<void> {
  const address = args[0];
  if (address === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const secret = process.env[RESERVE_SECRET_ENV];
  if (secret === undefined) {
    fail(`set ${RESERVE_SECRET_ENV} to the secret key of ${address}`, EXIT_USAGE);
  }
  const signer = Keypair.fromSecret(secret);
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
  process.stdout.write(`${signed.entryXdr}\n`);
}

/**
 * Signs one entry inside a whole envelope.
 *
 * The command takes the network passphrase and the deadline as arguments, so a
 * caller that drives a pipeline needs no endpoint and no other configuration.
 */
async function commandSignEntryInTransaction(args: readonly string[]): Promise<void> {
  const [address, validUntil, passphrase] = args;
  if (address === undefined || validUntil === undefined || passphrase === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const deadline = Number.parseInt(validUntil, 10);
  if (!Number.isInteger(deadline) || deadline <= 0) {
    fail("the ledger until which the consent stays valid is a positive integer", EXIT_USAGE);
  }
  const secret = process.env[RESERVE_SECRET_ENV];
  if (secret === undefined) {
    fail(`set ${RESERVE_SECRET_ENV} to the secret key of ${address}`, EXIT_USAGE);
  }
  const signer = Keypair.fromSecret(secret);
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
  process.stdout.write(`${signed}\n`);
}

async function commandSubmitRegistration(args: readonly string[]): Promise<void> {
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
  const secret = process.env[AUTHORITY_SECRET_ENV];
  if (secret === undefined) {
    fail(`set ${AUTHORITY_SECRET_ENV} to the secret key of the transaction source`, EXIT_USAGE);
  }
  const result = await submitPreparedCall(server, config, {
    prepared,
    collected,
    envelopeSigner: Keypair.fromSecret(secret),
  });
  print([
    `The network accepted the registration at ledger ${result.ledger}.`,
    `The transaction is ${result.transactionHash}.`,
  ]);
}

/** Reads the snapshot ledger and the asset out of the context file. */
async function contextOf(path: string): Promise<{ asset: string; snapshotLedger: number }> {
  const text = await readFile(path, "utf8");
  const asset = /^asset\s*=\s*"([^"]+)"\s*$/m.exec(text);
  const snapshot = /^snapshot_ledger\s*=\s*(\d+)\s*$/m.exec(text);
  if (asset?.[1] === undefined) {
    fail(`the context file ${path} names no asset`, EXIT_USAGE);
  }
  if (snapshot?.[1] === undefined) {
    fail(`the context file ${path} states no snapshot_ledger`, EXIT_USAGE);
  }
  return { asset: asset[1], snapshotLedger: Number.parseInt(snapshot[1], 10) };
}

async function runProof(args: readonly string[]) {
  const [contextFile, customersFile, repository] = args;
  if (contextFile === undefined || customersFile === undefined) {
    fail(USAGE, EXIT_USAGE);
  }
  const config = networkConfig();
  const server = openServer(config);
  const context = await contextOf(contextFile);
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

async function commandProve(args: readonly string[]): Promise<void> {
  const { proof, context } = await runProof(args);
  print([
    `The proof holds ${proof.proof.length} bytes.`,
    `The snapshot ledger is ${context.snapshotLedger}.`,
    `The root is ${toHex(proof.values.final_root)}.`,
    `The total liabilities are ${proof.values.L.toString(10)}.`,
    `The context hash is ${toHex(proof.values.context_hash)}.`,
  ]);
}

async function commandAttest(args: readonly string[]): Promise<void> {
  const { config, server, context, proof } = await runProof(args);
  const secret = process.env[AUTHORITY_SECRET_ENV];
  if (secret === undefined) {
    fail(`set ${AUTHORITY_SECRET_ENV} to the secret key of the authority`, EXIT_USAGE);
  }
  const authority = Keypair.fromSecret(secret);
  const account = await server.getAccount(authority.publicKey());
  const result = await submitAttestation(server, config, {
    sourceAccount: new Account(account.accountId(), account.sequenceNumber()),
    authoritySigner: authority,
    registry: await registryOf(config),
    asset: context.asset,
    snapshotLedger: context.snapshotLedger,
    finalRoot: proof.values.final_root,
    totalLiabilities: proof.values.L,
    proof: proof.proof,
  });
  print([
    `The registry accepted the attestation at ledger ${result.ledger}.`,
    `The transaction is ${result.transactionHash}.`,
    "Generate the customer packages with the generator, which reads the",
    "attested root from the registry before it writes any file.",
  ]);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "verify-inclusion":
      await commandVerifyInclusion(args);
      return;
    case "entry":
      await commandEntry(args);
      return;
    case "observe-reserves":
      await commandObserveReserves(args);
      return;
    case "history":
      await commandHistory(args);
      return;
    case "diagnose-reserves":
      await commandDiagnoseReserves(args);
      return;
    case "prepare-registration":
      await commandPrepareRegistration(args);
      return;
    case "sign-entry":
      await commandSignEntry(args);
      return;
    case "sign-entry-in-transaction":
      await commandSignEntryInTransaction(args);
      return;
    case "prove":
      await commandProve(args);
      return;
    case "attest":
      await commandAttest(args);
      return;
    case "consent-validity-ledgers":
      process.stdout.write(`${CONSENT_VALIDITY_LEDGERS}\n`);
      return;
    case "submit-registration":
      await commandSubmitRegistration(args);
      return;
    default:
      fail(USAGE, EXIT_USAGE);
  }
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${message}\n`);
  process.stderr.write("This is a failure of the client or of the network. It is not a verdict.\n");
  process.exit(EXIT_NO_VERDICT);
});
