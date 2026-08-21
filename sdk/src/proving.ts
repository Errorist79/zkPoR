/**
 * The proving driver.
 *
 * The driver runs the pinned native binaries. It compiles no circuit of its own
 * and it holds no copy of the proof format: the scheme and both oracle hashes
 * come from the versions file, and the shape of the tree comes from the
 * configuration file that the circuits read. A version that differs from the
 * pin stops the run before any proof exists, because a proof of another version
 * is a proof that the deployed verifier rejects.
 *
 * The witness files hold every salt of the snapshot, and one of them holds the
 * master secret in derived form. The driver therefore removes every witness
 * file, every prover input, and every build directory when the run ends, on the
 * failing path as well as the passing one.
 *
 * The master secret reaches the generator through the environment of the child
 * process. It never reaches an argument vector, where the process list of the
 * machine shows it, and the driver writes no command line to its output.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ATTESTATION_MAX_AGE_LEDGERS,
  FIXTURE_DIRECTORY,
  FIXTURE_MASTER_SECRET,
  MASTER_SECRET_ENV,
  PROVING_MARGIN_LEDGERS,
  PUBLIC_INPUT_BYTES,
} from "./constants.js";
import { parseManifest, readPublicInputs } from "./manifest.js";
import type { Manifest, PublicInputName } from "./manifest.js";
import { readPins, requirePinnedTools } from "./versions.js";
import { forgetChild, watchChild } from "./children.js";
import { withRunLifecycle } from "./runlifecycle.js";
import type { Pins } from "./versions.js";

/** The paths of the repository that the driver reads and writes. */
const PATHS = {
  versions: "scripts/versions.env",
  manifest: "circuits/recursion/manifest.json",
  shape: "circuits/recursion/params.toml",
  generator: "tools/recursion-gen",
  inner: "circuits/recursion/inner",
  aggregator: "circuits/recursion/agg",
  innerOut: "circuits/recursion/inner/out",
} as const;

/** The file names that the pinned prover writes and reads. */
const FILES = {
  innerBytecode: "target/recursion_inner.json",
  aggregatorBytecode: "target/recursion_agg.json",
  proof: "proof",
  publicInputs: "public_inputs",
  aggregatorWitness: "aggwit",
} as const;

/** A proving run that the driver refuses or that a tool failed. */
export class ProvingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvingError";
  }
}

/** The shape of the tree, from the one configuration file that fixes it. */
export interface Shape {
  /** The customer leaves in one batch. */
  readonly batchB: number;
  /** The batches that one aggregation folds. */
  readonly numBatchesK: number;
  /** The leaves of the whole tree. */
  readonly capacity: number;
}

/** The result of one proving run. */
export interface Proof {
  readonly proof: Uint8Array;
  readonly publicInputs: Uint8Array;
  readonly values: Record<PublicInputName, bigint>;
}

/** A report of progress, so a caller can show which step runs. */
export type ProgressReporter = (step: string) => void;

/** The two values that the context file states about one run. */
export interface RunContext {
  readonly asset: string;
  readonly snapshotLedger: number;
}

/**
 * Reads the asset and the snapshot ledger from the context file.
 *
 * Every front end of this client needs the same two values before it can check
 * the window or submit an attestation, so the reader lives here and not in one
 * of them.
 */
export function parseContext(text: string, path: string): RunContext {
  const asset = /^asset\s*=\s*"([^"]+)"\s*$/m.exec(text);
  if (asset?.[1] === undefined) {
    throw new ProvingError(`the context file ${path} names no asset`);
  }
  const snapshot = /^snapshot_ledger\s*=\s*(\d+)\s*$/m.exec(text);
  if (snapshot?.[1] === undefined) {
    throw new ProvingError(`the context file ${path} states no snapshot_ledger`);
  }
  return { asset: asset[1], snapshotLedger: Number.parseInt(snapshot[1], 10) };
}

/** Reads the context file at one path. */
export async function readContext(path: string): Promise<RunContext> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ProvingError(`the client cannot read the context file ${path}`);
  }
  return parseContext(text, path);
}

/**
 * Reads the shape from the configuration file that the circuits read.
 *
 * The specification puts both values in that one file, and no implementation
 * may hold them anywhere else.
 */
export function parseShape(text: string): Shape {
  const read = (name: string): number => {
    const found = new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, "m").exec(text);
    if (found === null || found[1] === undefined) {
      throw new ProvingError(`the configuration file states no ${name}`);
    }
    const value = Number.parseInt(found[1], 10);
    if (value < 2 || (value & (value - 1)) !== 0) {
      throw new ProvingError(`${name} is a power of two and at least two, and the file says ${value}`);
    }
    return value;
  };
  const batchB = read("batch_b");
  const numBatchesK = read("num_batches_k");
  return { batchB, numBatchesK, capacity: batchB * numBatchesK };
}

/**
 * Runs one tool of a proving run and fails with its output when it fails.
 *
 * This is the one place that starts a tool, and it is exported so a test can
 * start one the same way rather than writing its own `spawn`. A test that
 * hand-rolled the options would leave the two lines that matter untested: the
 * process group, and the record that lets a run stop what it started.
 */
export async function runTool(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      // The tool leads a process group of its own. `cargo run` starts the
      // generator as a further process, so a signal aimed at the tool alone
      // would leave the process that writes the prover inputs. One signal to
      // the group reaches the whole tree.
      detached: true,
    });
    // The record holds the object the runtime returns, not its identifier, so
    // the stop can ask the runtime whether the tool is still ours before it
    // signals a whole process group.
    watchChild(child);
    const stopWatching = (): void => {
      forgetChild(child);
    };
    let out = "";
    let notes = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      notes += chunk.toString();
    });
    child.on("error", () => {
      stopWatching();
      reject(new ProvingError(`the driver cannot run ${command}`));
    });
    child.on("close", (code) => {
      stopWatching();
      if (code === 0) {
        resolve(out);
        return;
      }
      // The output of a failed prover names the reason, and nothing in it
      // carries the master secret, because the secret never enters an argument.
      reject(
        new ProvingError(
          `${command} ${args[0] ?? ""} failed with the code ${String(code)}:\n${notes || out}`,
        ),
      );
    });
  });
}

/**
 * Refuses a run whose tools differ from the pins, and reports what it found.
 *
 * The proof format depends on the prover version and on the oracle hash, so
 * this gate stands at the start of every run.
 */
export async function readyToProve(
  repository: string,
  report: ProgressReporter = () => {},
): Promise<{ pins: Pins; manifest: Manifest; shape: Shape }> {
  const pins = await readPins(join(repository, PATHS.versions));
  report("checking the prover against the pins");
  const found = await requirePinnedTools(pins);
  report(`nargo and bb match the pins: ${found.nargo}, ${found.bb}`);

  const manifest = parseManifest(await readFile(join(repository, PATHS.manifest), "utf8"));
  const shape = parseShape(await readFile(join(repository, PATHS.shape), "utf8"));

  // The manifest is generated from the configuration file, so a difference
  // means one of the two is stale and every key of the run would be wrong.
  if (manifest.batchB !== shape.batchB || manifest.numBatchesK !== shape.numBatchesK) {
    throw new ProvingError(
      `the configuration file states ${shape.batchB} leaves for each of ${shape.numBatchesK} batches, and the manifest states ${manifest.batchB} and ${manifest.numBatchesK}`,
    );
  }
  if (manifest.proofScheme !== pins.proofScheme) {
    throw new ProvingError(
      `the versions file pins the scheme ${pins.proofScheme} and the manifest names ${manifest.proofScheme}`,
    );
  }
  if (manifest.terminalOracleHash !== pins.terminalOracleHash) {
    throw new ProvingError(
      `the versions file pins the terminal oracle hash ${pins.terminalOracleHash} and the manifest names ${manifest.terminalOracleHash}`,
    );
  }
  if (manifest.innerOracleHash !== pins.innerOracleHash) {
    throw new ProvingError(
      `the versions file pins the inner oracle hash ${pins.innerOracleHash} and the manifest names ${manifest.innerOracleHash}`,
    );
  }
  return { pins, manifest, shape };
}

/**
 * Refuses a run that would distribute salts which anybody can recompute.
 *
 * The fixture secret of this repository is public, so its salts are public and
 * every leaf it builds falls to a search over plausible balances. A fixture
 * input file is public for the same reason. A run that used either one would
 * produce customer packages that protect nothing, and the packages would look
 * exactly like real ones.
 */
export function inputsAreNotFixtures(input: {
  masterSecret: bigint;
  contextFile: string;
  customersFile: string;
}): void {
  if (input.masterSecret === FIXTURE_MASTER_SECRET) {
    throw new ProvingError(
      "the master secret is the fixture secret of this repository; its salts are public, so anybody could recompute every leaf",
    );
  }
  for (const path of [input.contextFile, input.customersFile]) {
    const parts = path.split(/[/\\]/);
    if (parts.includes(FIXTURE_DIRECTORY)) {
      throw new ProvingError(
        `${path} is a fixture of this repository; write your own context file and your own customer file`,
      );
    }
  }
}

/**
 * Refuses a run that cannot land inside the window.
 *
 * The registry compares the snapshot against the ledger that executes the
 * attestation. Proving takes minutes, so a run that starts with less of the
 * window than the margin produces a proof that the registry then refuses.
 */
export function windowAllowsProving(snapshotLedger: number, currentLedger: number): void {
  if (snapshotLedger > currentLedger) {
    throw new ProvingError(
      `the snapshot ledger ${snapshotLedger} is later than the current ledger ${currentLedger}`,
    );
  }
  const remaining = snapshotLedger + ATTESTATION_MAX_AGE_LEDGERS - currentLedger;
  if (remaining <= 0) {
    throw new ProvingError(
      `the snapshot ledger ${snapshotLedger} left the window at ${snapshotLedger + ATTESTATION_MAX_AGE_LEDGERS}, and the network is at ${currentLedger}`,
    );
  }
  if (remaining < PROVING_MARGIN_LEDGERS) {
    throw new ProvingError(
      `the window has ${remaining} ledgers left and the proof needs at least ${PROVING_MARGIN_LEDGERS}; take a fresh snapshot`,
    );
  }
}

/**
 * Produces one aggregated proof for one snapshot.
 *
 * The steps are the steps of the pinned pipeline, in order: the generator
 * writes the witness of each batch, the inner circuit proves each batch, the
 * generator assembles the aggregation input, and the aggregator produces the
 * terminal proof that the registry verifies.
 */
export async function prove(input: {
  repository: string;
  contextFile: string;
  customersFile: string;
  masterSecret: bigint;
  report?: ProgressReporter;
}): Promise<Proof> {
  const report = input.report ?? (() => {});
  const repository = input.repository;
  // This one refuses the run itself rather than the working tree, so it takes
  // no lock and sweeps nothing. A run with a public secret must not disturb a
  // run that is legitimately using the repository.
  inputsAreNotFixtures(input);

  // The generator reads the secret from the environment of its own process.
  const secretEnvironment = {
    [MASTER_SECRET_ENV]: `0x${input.masterSecret.toString(16).padStart(64, "0")}`,
  };
  const generator = join(repository, PATHS.generator);
  const inner = join(repository, PATHS.inner);
  const aggregator = join(repository, PATHS.aggregator);
  const innerOut = join(repository, PATHS.innerOut);

  // The lock, the guards, and the sweeps are one lifecycle with one order, and
  // that order is the guarantee.
  //
  // The toolchain check sits inside it rather than before it, and that is
  // deliberate. Before it, a machine without the pinned tools left this
  // function before the lifecycle began, so nothing that entered here could
  // observe whether the driver used the lifecycle at all. Inside it, a run
  // that stops on the pins still takes the lock, still sweeps what an earlier
  // run left, and still gives everything back. The lock is held for the
  // length of a version check, which is short, and a refused run sweeps the
  // working tree, which is the right thing to do with another run's leftovers
  // in any case.
  return await withRunLifecycle(repository, report, async () => {
    const { pins, manifest, shape } = await readyToProve(repository, report);

    report("writing the witness of each batch");
    await runTool(
      "cargo",
      ["run", "--release", "--quiet", "--", "witness", input.contextFile, input.customersFile],
      { cwd: generator, env: secretEnvironment },
    );

    report("compiling the inner circuit");
    await rm(join(inner, "target"), { recursive: true, force: true });
    await rm(innerOut, { recursive: true, force: true });
    await runTool("nargo", ["compile"], { cwd: inner });

    for (let batch = 0; batch < shape.numBatchesK; batch += 1) {
      report(`proving the batch ${batch + 1} of ${shape.numBatchesK}`);
      await copyFile(join(inner, `Prover_${batch}.toml`), join(inner, "Prover.toml"));
      await runTool("nargo", ["execute", `wit${batch}`], { cwd: inner });
      const output = join(innerOut, `batch_${batch}`);
      await mkdir(output, { recursive: true });
      await runTool(
        "bb",
        [
          "prove",
          "--scheme",
          pins.proofScheme,
          "--oracle_hash",
          pins.innerOracleHash,
          "--honk_recursion",
          "1",
          "--bytecode_path",
          FILES.innerBytecode,
          "--witness_path",
          `target/wit${batch}.gz`,
          "--output_path",
          output,
          "--output_format",
          "bytes_and_fields",
        ],
        { cwd: inner },
      );
    }

    report("writing the verification key of the inner circuit");
    await runTool(
      "bb",
      [
        "write_vk",
        "--scheme",
        pins.proofScheme,
        "--oracle_hash",
        pins.innerOracleHash,
        "--honk_recursion",
        "1",
        "--verifier_type",
        "standalone",
        "--bytecode_path",
        FILES.innerBytecode,
        "--output_path",
        innerOut,
        "--output_format",
        "bytes_and_fields",
      ],
      { cwd: inner },
    );

    report("assembling the aggregation input");
    await runTool("cargo", ["run", "--release", "--quiet", "--", "assemble", input.contextFile, innerOut], {
      cwd: generator,
      env: secretEnvironment,
    });

    report("compiling the aggregator");
    await rm(join(aggregator, "target"), { recursive: true, force: true });
    await runTool("nargo", ["compile"], { cwd: aggregator });
    report("proving the aggregation, which is the slowest step");
    await runTool("nargo", ["execute", FILES.aggregatorWitness], { cwd: aggregator });
    await runTool(
      "bb",
      [
        "prove",
        "--scheme",
        pins.proofScheme,
        "--oracle_hash",
        pins.terminalOracleHash,
        "--bytecode_path",
        FILES.aggregatorBytecode,
        "--witness_path",
        `target/${FILES.aggregatorWitness}.gz`,
        "--output_path",
        "target",
        "--output_format",
        "bytes_and_fields",
      ],
      { cwd: aggregator },
    );

    const target = join(aggregator, "target");
    const proof = new Uint8Array(await readFile(join(target, FILES.proof)));
    const publicInputs = new Uint8Array(await readFile(join(target, FILES.publicInputs)));
    if (publicInputs.length !== PUBLIC_INPUT_BYTES) {
      throw new ProvingError(
        `the prover wrote a public input string of ${publicInputs.length} bytes and the manifest names ${PUBLIC_INPUT_BYTES}`,
      );
    }
    report("the proof is ready");
    return { proof, publicInputs, values: readPublicInputs(manifest, publicInputs) };
  });
}

/**
 * Writes the package of every customer of one accepted attestation.
 *
 * The generator writes the files. This function starts it and passes the master
 * secret through the environment of that process, exactly as the proof does, so
 * no second writer of per-customer files appears and the secret reaches no
 * argument vector.
 *
 * The generator recomputes every salt from the master secret and refuses to
 * write unless the recomputed root equals the root that this call declares. A
 * caller that reads the root back from the registry therefore gets a round trip
 * which proves that the balance file reproduces the attestation the chain
 * holds.
 *
 * Each file carries one balance in clear text. The files are the copy of the
 * customer and not the working material of a run, so they land outside the
 * repository and the sweep of the run lifecycle never reaches them.
 *
 * Returns the directory that holds the files. The generator adds the asset and
 * the snapshot below the directory this call names, so the answer is not the
 * directory the caller asked for, and only the generator knows those levels.
 */
export async function writeCustomerPackages(input: {
  repository: string;
  contextFile: string;
  customersFile: string;
  outputDirectory: string;
  masterSecret: bigint;
  network: string;
  registry: string;
  attestedRoot: bigint;
  attestedSnapshot: number;
  transactionHash: string;
  deploymentsFile: string;
}): Promise<string> {
  // The generator names the directory it filled, and it names it in a file that
  // this process chooses. It also prints the directory for an operator who
  // watches a run, and a caller that read that sentence would turn it into an
  // interface that neither side could change.
  const scratch = await mkdtemp(join(tmpdir(), "zkpor-packages-"));
  const reportFile = join(scratch, "directory");
  await runTool(
    "cargo",
    [
      "run",
      "--release",
      "--quiet",
      "--",
      "packages",
      // The generator runs in its own directory, so a path that the caller gave
      // relative to this process would name a different file there, or none.
      resolve(input.contextFile),
      resolve(input.customersFile),
      resolve(input.outputDirectory),
      "--network",
      input.network,
      "--registry",
      input.registry,
      "--attested-root",
      input.attestedRoot.toString(16).padStart(64, "0"),
      "--attested-snapshot",
      String(input.attestedSnapshot),
      "--transaction",
      input.transactionHash,
      "--deployments",
      resolve(input.deploymentsFile),
      "--report-file",
      reportFile,
    ],
    {
      cwd: join(input.repository, PATHS.generator),
      env: {
        [MASTER_SECRET_ENV]: `0x${input.masterSecret.toString(16).padStart(64, "0")}`,
      },
    },
  );
  try {
    return await packagesDirectoryOf(reportFile);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The directory that the generator named in its report file.
 *
 * The path runs to the end of the file rather than to the first space, because
 * an operator chooses where the packages go and that choice can hold a space.
 * Only the final newline goes.
 *
 * A file that names nothing stops the caller. The packages exist at that point,
 * so a run that returned an empty path would send a reader to the root of the
 * file system and would look like a run that wrote nothing.
 */
export async function packagesDirectoryOf(reportFile: string): Promise<string> {
  let reported: string;
  try {
    reported = await readFile(reportFile, "utf8");
  } catch {
    throw new ProvingError(
      "the generator wrote the packages and left no report of the directory that holds them",
    );
  }
  const directory = reported.replace(/\n$/, "");
  if (directory.length === 0) {
    throw new ProvingError("the generator wrote the packages and named no directory for them");
  }
  return directory;
}
