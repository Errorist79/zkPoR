import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AUTHORITY_SECRET_ENV, DISPUTER_SECRET_ENV, MASTER_SECRET_ENV, MASTER_SECRET_FILE_ENV, RESERVE_SECRET_ENV,
  SECRET_FILE_MODE, answerDispute, leafHash, parseInclusionEvidence, readAssetRecord,
  readAuthorityKeypair, readStoredDispute, rootFromPath, runTool, toHex,
} from "@zkpor/sdk";
import type { DisputeRecord, Environment, SubmitResult } from "@zkpor/sdk";
import type { Reader } from "./chain.js";
import { ANSWER_GENERATOR_DIRECTORY, ANSWER_TEMP_PREFIX } from "./constants.js";
import { readDisputeView } from "./dispute.js";
import type { DisputeSelection } from "./dispute.js";

export interface AnswerResult {
  readonly submission: SubmitResult;
  readonly dispute: DisputeRecord | undefined;
  readonly readFailure: string | undefined;
}

/** The retained tree supplies commitments and paths. No balance, salt, or master secret is needed. */
export async function answerFromRetainedTree(input: {
  readonly reader: Reader;
  readonly selection: DisputeSelection;
  readonly manifestPath: string;
  readonly repository: string;
  readonly environment: Environment;
  readonly beforeSend?: (hash: string) => Promise<void>;
}): Promise<AnswerResult> {
  const { reader, selection } = input;
  const signer = readAuthorityKeypair(input.environment);
  const view = await readDisputeView(reader, selection);
  if (view.dispute === undefined || view.target === undefined) {
    throw new Error("The requested dispute does not exist.");
  }
  if (view.dispute.status !== "Open") {
    throw new Error("The dispute is already closed. No answer was sent.");
  }
  if (view.currentLedger > view.dispute.deadline) {
    throw new Error("The answer deadline has passed. No answer was sent.");
  }
  const asset = await readAssetRecord(reader.server, reader.config, reader.readOptions,
    selection.registry, selection.asset);
  if (asset === undefined || asset.authority !== signer.publicKey()) {
    throw new Error("The configured issuer key does not match the asset authority.");
  }
  const scratch = await mkdtemp(join(tmpdir(), ANSWER_TEMP_PREFIX));
  let evidence;
  try {
    const requestPath = join(scratch, "request.json");
    const answerPath = join(scratch, "answer.json");
    await writeFile(requestPath, JSON.stringify({
      network: reader.config.network, registry: selection.registry, asset: selection.asset,
      attestation_id: selection.targetId.toString(), context_hash: toHex(view.target.contextHash),
      root: toHex(view.target.finalRoot), snapshot_ledger: view.target.snapshotLedger,
      tree_depth: view.generation.treeDepth, identifier: toHex(selection.identifier),
    }), { mode: SECRET_FILE_MODE, flag: "wx" });
    await runTool("cargo", ["run", "--release", "--quiet", "--", "answer",
      resolve(input.manifestPath), requestPath, answerPath], {
      cwd: join(input.repository, ANSWER_GENERATOR_DIRECTORY),
      env: {
        [AUTHORITY_SECRET_ENV]: "", [RESERVE_SECRET_ENV]: "",
        [DISPUTER_SECRET_ENV]: "",
        [MASTER_SECRET_ENV]: "", [MASTER_SECRET_FILE_ENV]: "",
      },
    });
    evidence = parseInclusionEvidence(await readFile(answerPath, "utf8"));
    if (evidence.id !== selection.identifier || rootFromPath({
      leaf: leafHash(evidence), leafIndex: evidence.position,
      siblings: evidence.path, depth: view.generation.treeDepth,
    }) !== view.target.finalRoot) {
      throw new Error("The generated answer does not reach the fixed target root.");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const submission = await answerDispute(reader.server, reader.config, {
    sourceAccount: await reader.server.getAccount(signer.publicKey()), sourceSigner: signer,
    registry: selection.registry, asset: selection.asset, targetId: selection.targetId, evidence,
    ...(input.beforeSend === undefined ? {} : { beforeSend: input.beforeSend }),
  });
  try {
    const dispute = await readStoredDispute(reader.config, selection.registry, selection.asset,
      selection.targetId, selection.identifier, { ...reader.readOptions, server: reader.server });
    return { submission, dispute, readFailure: dispute?.status === "Answered"
      ? undefined : "The answer transaction settled, but the stored status is not confirmed as Answered." };
  } catch {
    return { submission, dispute: undefined,
      readFailure: "The answer transaction settled, but the client cannot reread the stored dispute." };
  }
}
