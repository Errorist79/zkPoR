// The customer check, runnable from a clone.
//
// A synthetic endpoint is not the chain. Its answer comes from test vectors.
// This example checks the client behavior. It does not report network state.
//
// This runs `zkpor verify-inclusion` against the synthetic endpoint. Use the
// command with your own accepted package and trusted registry to read a network.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeEndpoint, storedAttestationXdr } from "../dist/replay.js";
import {
  SYNTHETIC_ASSET,
  SYNTHETIC_ATTESTATION,
  SYNTHETIC_ATTESTATION_ID,
  SYNTHETIC_REGISTRY,
} from "./synthetic-attestation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, "..", "..");
// The optional path selects a package with one incorrect sibling.
const packagePath = process.argv[2] ?? join(repository, "fixtures", "synthetic_package_v2.zkpor.json");

// The root comes from the tree vector, separate from the package path.
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
        join(repository, "fixtures", "synthetic_deployments.json"),
      ],
      {
        stdio: "inherit",
        env: { ...process.env, ZKPOR_NETWORK: "testnet", ZKPOR_RPC_URL: endpoint.url },
      },
    );
    child.on("close", (code) => resolve(code ?? 1));
  });
  console.log(`\nthe command answered the exit code ${answer}`);
  console.log(`it read the synthetic endpoint for ${endpoint.asked.join(", ")}`);
  process.exitCode = answer;
} finally {
  await endpoint.close();
}
