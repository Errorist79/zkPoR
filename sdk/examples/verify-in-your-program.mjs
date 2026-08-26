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
// A recording is not the chain. Every answer here is one this repository wrote
// down, so a check that passes against it proves that the client reads and
// refuses correctly. It proves nothing about what any network holds now. To
// read a network, give `rpcUrl` the address of one.
//
// Not shown, because an integrating team does not do these: proving,
// attestation, registration, and the signing of a reserve consent. Those belong
// to the issuer, and the issuer runs them from the command line of this package.

import { Networks } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InfrastructureError, exitCode, openServer, verdictLines, verifyInclusion } from "../dist/index.js";
import { assetRecordXdr, fakeEndpoint } from "../dist/replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, "..", "..");
const packageText = readFileSync(join(repository, "fixtures", "example_package.zkpor.json"), "utf8");
const deploymentsText = readFileSync(join(repository, "scripts", "deployments.json"), "utf8");

const RECORDED = {
  authority: "GBTWIUFV6TF7GDS22K6YUMS65G4TA5UOZNYB4HNBNESWOY6VIWORR6NU",
  reserves: ["GDL3HMPUWH2P3KVQPTSVKSZ5PPUSG5MU53UG3R3GPJ4F6G7Y4OFC36JW"],
  attestation: {
    finalRoot:
      20554074537088043555280822736271664885243051878812220006918736495728922963448n,
    totalLiabilities: 18446744074315096615n,
    snapshotLedger: 4274940,
    reserveSum: 20000000000000000000n,
    attestedLedger: 4274948,
  },
};

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
  holds: { [JSON.parse(packageText).registry]: assetRecordXdr(RECORDED) },
  fallback: 7,
  latestLedger: RECORDED.attestation.attestedLedger + 200,
});

try {
  // 1. A package that is under the root. The verdict carries the fields your
  //    program shows a customer, so nothing has to be parsed out of a sentence.
  const good = await check(packageText, endpoint.url);
  if (good.kind === "included") {
    console.log(`included: leaf ${good.leafIndex} holds ${good.balance}`);
    console.log(`  the claim ${good.solvencyLapsed ? "has lapsed" : "is current"}`);
  }

  // 2. A package somebody changed. The balance no longer hashes to the leaf, so
  //    the recomputed root differs. This is a verdict, and your program shows it
  //    rather than reporting an error.
  const tampered = JSON.stringify({ ...JSON.parse(packageText), balance: "999999" });
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
