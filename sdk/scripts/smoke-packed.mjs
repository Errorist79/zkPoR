#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Networks } from "@stellar/stellar-sdk";

const archive = process.argv[2];
if (archive === undefined) {
  throw new Error("give the packed SDK tarball path");
}

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..");
const consumer = mkdtempSync(join(tmpdir(), "zkpor-sdk-consumer-"));

try {
  execFileSync("npm", [
    "install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", resolve(archive),
  ], { stdio: "pipe" });

  writeFileSync(join(consumer, "check.cjs"), `
const sdk = require("@zkpor/sdk");
const replay = require("@zkpor/sdk/replay");
for (const [name, value] of Object.entries({
  verifyInclusion: sdk.verifyInclusion,
  readStoredDispute: sdk.readStoredDispute,
  preparePriorGeneration: sdk.preparePriorGeneration,
  fakeEndpoint: replay.fakeEndpoint,
})) {
  if (typeof value !== "function") throw new Error(name + " is not a CommonJS export");
}
`);

  writeFileSync(join(consumer, "check.mjs"), `
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openServer, verifyInclusion, readStoredDispute } from "@zkpor/sdk";
import { fakeEndpoint, storedAttestationXdr } from "@zkpor/sdk/replay";

if (typeof readStoredDispute !== "function") throw new Error("the ESM dispute reader is missing");
const source = process.env.ZKPOR_SMOKE_SOURCE;
const fixtureRoot = process.env.ZKPOR_SMOKE_FIXTURES;
const passphrase = process.env.ZKPOR_SMOKE_PASSPHRASE;
if (source === undefined || fixtureRoot === undefined || passphrase === undefined) {
  throw new Error("the synthetic fixture is missing");
}
const reference = await import(source);
const packagePath = join(fixtureRoot, "synthetic_package_v2.zkpor.json");
const deploymentsPath = join(fixtureRoot, "synthetic_deployments.json");
const endpoint = await fakeEndpoint({
  attestations: {
    [reference.SYNTHETIC_REGISTRY]: {
      asset: reference.SYNTHETIC_ASSET,
      id: reference.SYNTHETIC_ATTESTATION_ID,
      xdr: storedAttestationXdr(reference.SYNTHETIC_ATTESTATION),
    },
  },
  fallback: 7,
  latestLedger: reference.SYNTHETIC_ATTESTATION.attestedLedger + 200,
});
try {
  const config = {
    network: "testnet", rpcUrl: endpoint.url,
    networkPassphrase: passphrase, allowHttp: true,
  };
  const verdict = await verifyInclusion({
    packageText: readFileSync(packagePath, "utf8"),
    deploymentsText: readFileSync(deploymentsPath, "utf8"),
    server: openServer(config), config, readOptions: {},
  });
  if (verdict.kind !== "included") throw new Error("the installed ESM check returned " + verdict.kind);

  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(join(process.cwd(), "node_modules", ".bin", "zkpor"), [
      "verify-inclusion", packagePath, deploymentsPath,
    ], {
      env: { ...process.env, ZKPOR_NETWORK: "testnet", ZKPOR_RPC_URL: endpoint.url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) reject(new Error("the installed CLI refused the synthetic package: " + output));
      else resolveCode(status);
    });
  });
  if (code !== 0) throw new Error("the installed CLI returned a failure");
} finally {
  await endpoint.close();
}
`);

  const environment = {
    ...process.env,
    ZKPOR_SMOKE_SOURCE: pathToFileURL(join(repository, "sdk", "examples", "synthetic-attestation.mjs")).href,
    ZKPOR_SMOKE_FIXTURES: join(repository, "fixtures"),
    ZKPOR_SMOKE_PASSPHRASE: Networks.TESTNET,
  };
  execFileSync(process.execPath, [join(consumer, "check.cjs")], { cwd: consumer, env: environment, stdio: "inherit" });
  execFileSync(process.execPath, [join(consumer, "check.mjs")], { cwd: consumer, env: environment, stdio: "inherit" });
  process.stdout.write("The packed SDK passed the installed consumer checks.\n");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
