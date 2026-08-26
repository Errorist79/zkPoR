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
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ATTESTATION_MAX_AGE_LEDGERS,
  FIXTURE_DIRECTORY,
  FIXTURE_MASTER_SECRET,
  GENERATOR_SECRET_ENV,
  PROVING_MARGIN_LEDGERS,
  PUBLIC_INPUT_BYTES,
} from "./constants.js";
import { parseManifest, readPublicInputs } from "./manifest.js";
import type { Manifest, PublicInputName } from "./manifest.js";
import { readPins, requirePinnedTools } from "./versions.js";
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

/** Runs one command and fails with its output when it fails. */
async function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let notes = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      notes += chunk.toString();
    });
    child.on("error", () => {
      reject(new ProvingError(`the driver cannot run ${command}`));
    });
    child.on("close", (code) => {
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
 * Removes every file of a run that carries a salt or a witness.
 *
 * The step runs on the failing path too. A failed run that left the prover
 * inputs on disk would leave every salt of the snapshot readable.
 */
export async function clearWitnesses(repository: string): Promise<void> {
  const inner = join(repository, PATHS.inner);
  const aggregator = join(repository, PATHS.aggregator);
  const paths = [
    join(inner, "Prover.toml"),
    join(inner, "target"),
    join(repository, PATHS.innerOut),
    join(aggregator, "Prover.toml"),
    join(aggregator, "target"),
  ];
  for (const path of paths) {
    await rm(path, { recursive: true, force: true });
  }
  // The generator writes one prover input per batch, so the sweep reads the
  // directory instead of guessing how many there are.
  const names = await readdir(inner).catch((): string[] => []);
  for (const name of names) {
    if (/^Prover_\d+\.toml$/.test(name)) {
      await rm(join(inner, name), { force: true });
    }
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
  inputsAreNotFixtures(input);
  const { pins, manifest, shape } = await readyToProve(repository, report);

  // The generator reads the secret from the environment of its own process.
  const secretEnvironment = {
    [GENERATOR_SECRET_ENV]: `0x${input.masterSecret.toString(16).padStart(64, "0")}`,
  };
  const generator = join(repository, PATHS.generator);
  const inner = join(repository, PATHS.inner);
  const aggregator = join(repository, PATHS.aggregator);
  const innerOut = join(repository, PATHS.innerOut);

  try {
    report("writing the witness of each batch");
    await run(
      "cargo",
      ["run", "--release", "--quiet", "--", "witness", input.contextFile, input.customersFile],
      { cwd: generator, env: secretEnvironment },
    );

    report("compiling the inner circuit");
    await rm(join(inner, "target"), { recursive: true, force: true });
    await rm(innerOut, { recursive: true, force: true });
    await run("nargo", ["compile"], { cwd: inner });

    for (let batch = 0; batch < shape.numBatchesK; batch += 1) {
      report(`proving the batch ${batch + 1} of ${shape.numBatchesK}`);
      await copyFile(join(inner, `Prover_${batch}.toml`), join(inner, "Prover.toml"));
      await run("nargo", ["execute", `wit${batch}`], { cwd: inner });
      const output = join(innerOut, `batch_${batch}`);
      await mkdir(output, { recursive: true });
      await run(
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
    await run(
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
    await run("cargo", ["run", "--release", "--quiet", "--", "assemble", input.contextFile, innerOut], {
      cwd: generator,
      env: secretEnvironment,
    });

    report("compiling the aggregator");
    await rm(join(aggregator, "target"), { recursive: true, force: true });
    await run("nargo", ["compile"], { cwd: aggregator });
    report("proving the aggregation, which is the slowest step");
    await run("nargo", ["execute", FILES.aggregatorWitness], { cwd: aggregator });
    await run(
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
  } finally {
    // The witness files carry every salt of the snapshot, so they go whether
    // the run passed or failed.
    report("removing the witness files");
    await clearWitnesses(repository);
  }
}
