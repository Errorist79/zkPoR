// The customer check, runnable from a clone with nothing.
//
// A recording is not the chain. Every answer here is one this repository wrote
// down, so a check that passes against it proves that the client reads and
// refuses correctly. It proves nothing about what any network holds now.
//
// This runs the real command, `zkpor verify-inclusion`, against a recording of
// the registry. The only difference from a check against the test network is
// where the answers come from. To read the network instead, see the second
// command in the README of this package.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetRecordXdr, fakeEndpoint } from "../dist/replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, "..", "..");
// A path on the command line names another package, and the repository commits
// one that the check refuses. Without a path the example reads the package that
// the recording attests.
const packagePath = process.argv[2] ?? join(repository, "fixtures", "example_package.zkpor.json");

// What the registry held when this package was written. The root is the one the
// attestation put on the chain, and the check recomputes it from the package
// and compares. A recording that carried another root would be refused, which
// is the point: the recording does not decide the verdict.
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

const entry = JSON.parse(readFileSync(packagePath, "utf8"));
const endpoint = await fakeEndpoint({
  holds: { [entry.registry]: assetRecordXdr(RECORDED) },
  fallback: 7,
  // A recording states its own present. This one sits inside the window of the
  // attestation, so the verdict about the currency of the claim is coherent
  // with the ledgers the record carries.
  latestLedger: RECORDED.attestation.attestedLedger + 200,
});

try {
  const answer = await new Promise((resolve) => {
    // The endpoint answers from this process, so the child must not stop the
    // event loop. A synchronous child would wait for an answer that cannot
    // come until it ends.
    const child = spawn(
      process.execPath,
      [
        join(repository, "sdk", "dist", "cli.js"),
        "verify-inclusion",
        packagePath,
        // The command reads its deployments file from the working directory,
        // and this example runs from the package rather than the repository.
        join(repository, "scripts", "deployments.json"),
      ],
      {
        stdio: "inherit",
        env: { ...process.env, ZKPOR_NETWORK: entry.network, ZKPOR_RPC_URL: endpoint.url },
      },
    );
    child.on("close", (code) => resolve(code ?? 1));
  });
  console.log(`\nthe command answered the exit code ${answer}`);
  console.log(`it read the recording of ${endpoint.asked.join(", ")}`);
  process.exitCode = answer;
} finally {
  await endpoint.close();
}
