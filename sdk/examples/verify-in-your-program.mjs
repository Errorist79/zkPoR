// The inclusion check, called from your own program.
//
// This is the library rather than the command line. It shows the three things a
// caller has to get right, and nothing else.
//
//   1. A verdict is not a boolean. The check answers one of seven kinds, and
//      six of them are refusals that each mean something different.
//   2. A refusal is an answer. "This package is not under the attested root" is
//      the check working, not the check failing.
//   3. A failure is not a verdict. When the network cannot be read, the call
//      throws, and a caller that turned that into "not included" would tell a
//      customer their balance is missing because a request timed out.
//
// A synthetic endpoint is not the chain. Its answer comes from test vectors.
// This example checks the client behavior. It does not report network state.
// To read a network, use your own accepted package, deployments file, and RPC.
//
// Not shown, because an integrating team does not do these: proving,
// attestation, registration, and the signing of a reserve consent. Those belong
// to the issuer, and the issuer runs them from the command line of this package.

import { Networks } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InfrastructureError, exitCode, openServer, verdictLines, verifyInclusion } from "../dist/index.js";
import { fakeEndpoint, storedAttestationXdr } from "../dist/replay.js";
import {
  SYNTHETIC_ASSET,
  SYNTHETIC_ATTESTATION,
  SYNTHETIC_ATTESTATION_ID,
  SYNTHETIC_REGISTRY,
} from "./synthetic-attestation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, "..", "..");
const packageText = readFileSync(join(repository, "fixtures", "synthetic_package_v2.zkpor.json"), "utf8");
const deploymentsText = readFileSync(join(repository, "fixtures", "synthetic_deployments.json"), "utf8");

/** What your program calls. The configuration is yours, not an environment. */
async function check(text, rpcUrl) {
  const config = {
    network: "testnet",
    rpcUrl,
    // Every signature commits to this, and a read builds a transaction to
    // simulate, so a configuration without it cannot even ask a question.
    networkPassphrase: Networks.TESTNET,
    allowHttp: rpcUrl.startsWith("http://"),
  };
  return await verifyInclusion({
    packageText: text,
    deploymentsText,
    server: openServer(config),
    config,
    readOptions: {},
  });
}

const endpoint = await fakeEndpoint({
  attestations: {
    [SYNTHETIC_REGISTRY]: {
      asset: SYNTHETIC_ASSET,
      id: SYNTHETIC_ATTESTATION_ID,
      xdr: storedAttestationXdr(SYNTHETIC_ATTESTATION),
    },
  },
  fallback: 7,
  latestLedger: SYNTHETIC_ATTESTATION.attestedLedger + 200,
});

try {
  // 1. A package that is under the root. The verdict carries the fields your
  //    program shows a customer, so nothing has to be parsed out of a sentence.
  const good = await check(packageText, endpoint.url);
  if (good.kind === "included") {
    console.log(`included: leaf ${good.leafIndex} holds ${good.balance}`);
    console.log(`  the claim ${good.solvencyLapsed ? "has lapsed" : "is current"}`);
  }

  // 2. A package somebody changed. One sibling leads to a different root.
  //    This is a verdict, and your program shows it rather than an error.
  const tampered = readFileSync(
    join(repository, "fixtures", "synthetic_package_v2_wrong_path.zkpor.json"),
    "utf8",
  );
  const bad = await check(tampered, endpoint.url);
  console.log(`\n${bad.kind}: the check refused it`);
  for (const line of verdictLines(bad)) {
    console.log(`  ${line}`);
  }
  console.log(`  your program would exit with ${exitCode(bad)}`);

  // 3. An endpoint that answers nothing. This throws, and the difference
  //    between this and the refusal above is the difference between "we cannot
  //    tell you" and "we checked, and no".
  try {
    await check(packageText, "http://127.0.0.1:1");
    console.log("\nunreachable: no failure, which should not happen");
  } catch (cause) {
    const named = cause instanceof InfrastructureError ? "an infrastructure failure" : "a failure";
    console.log(`\nthe unreachable endpoint raised ${named}, which is not a verdict`);
  }
} finally {
  await endpoint.close();
}
