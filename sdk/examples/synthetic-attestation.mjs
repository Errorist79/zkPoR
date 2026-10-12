import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "..", "..", "fixtures", "package_vectors.json"), "utf8"));
const tree = vectors.trees.find((item) => item.depth === 12);
const sample = vectors.packages.find((item) => item.tree === vectors.trees.indexOf(tree) && item.filename === "package-000000.zkpor.json");
if (tree === undefined || sample === undefined || vectors.leaf_rule !== "the leaf at index i holds id = i + 1, balance = i * 7, and salt = i + 1000") {
  throw new Error("the synthetic example needs the depth-12 package vectors");
}
const fields = JSON.parse(sample.lines.join("\n"));
const leafCount = 1n << BigInt(tree.depth);
const totalLiabilities = 7n * leafCount * (leafCount - 1n) / 2n;

// This attestation exists only in the local example endpoint.
export const SYNTHETIC_REGISTRY = fields.registry;
export const SYNTHETIC_ASSET = fields.asset;
export const SYNTHETIC_ATTESTATION_ID = BigInt(fields.attestation_id);
export const SYNTHETIC_ATTESTATION = {
  contextHash: BigInt(fields.context_hash),
  finalRoot: BigInt(tree.root),
  totalLiabilities,
  snapshotLedger: fields.snapshot_ledger,
  reserveSum: totalLiabilities,
  attestedLedger: fields.snapshot_ledger + 1,
};
