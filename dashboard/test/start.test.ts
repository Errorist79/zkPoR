/**
 * The one command that starts the dashboard, run as a process.
 *
 * The entry point resolves the configuration, opens the listener, and prints
 * the address. Nothing else drives it, so a configuration that the environment
 * does not carry would stop the process with whatever code the last edit left.
 * The code is part of the contract that the client library publishes: 2 means
 * the command line is wrong.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory that holds the tests of this package. */
const HERE = dirname(fileURLToPath(import.meta.url));
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_USAGE } from "@zkpor/sdk";
import { DEFAULT_PORT, LOOPBACK_HOST, PORT_ENV } from "../src/constants.js";
import { REPOSITORY_ROOT } from "./support.js";
import { builtMain } from "./built.js";

/**
 * The built entry point, in a directory this test run owns.
 *
 * Reading `dist` made the verdict depend on a build the test does not control:
 * a build in progress removes the file, and a run that skips the build measures
 * an older artifact. Both arrive here as a wrong exit code or an empty output.
 */
let MAIN = "";

beforeAll(() => {
  MAIN = builtMain();
  if (!existsSync(MAIN)) {
    throw new Error(`the build wrote no entry point at ${MAIN}`);
  }
}, 180_000);

/** What one start of the process did. */
interface Start {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Starts the process and waits.
 *
 * A start that succeeds never returns on its own, so the caller names a stop
 * once it has read what it needed.
 */
async function start(
  environment: Record<string, string>,
  stopWhenListening = false,
): Promise<Start> {
  const child = spawn(process.execPath, [MAIN], {
    cwd: REPOSITORY_ROOT,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stopWhenListening && stdout.includes("listens on")) {
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on("exit", (status) => {
      resolve(status);
    });
  });
  return { code, stdout, stderr };
}

/**
 * Starts the process, reads the address it printed, and asks that address.
 *
 * The process stays up until the request settles, so the answer states whether
 * the printed port is the port the listener actually holds.
 */
async function startAndAsk(
  environment: Record<string, string>,
): Promise<{ port: number; status: number }> {
  const child = spawn(process.execPath, [MAIN], {
    cwd: REPOSITORY_ROOT,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let seen = "";
      child.stdout.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        const found = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(seen);
        if (found?.[1] !== undefined) {
          resolve(Number.parseInt(found[1], 10));
        }
      });
      child.on("error", reject);
      child.on("exit", () => {
        reject(new Error(`the process ended before it printed an address: ${seen}`));
      });
    });
    const answer = await fetch(`http://${LOOPBACK_HOST}:${String(port)}/`);
    return { port, status: answer.status };
  } finally {
    child.kill("SIGTERM");
  }
}

/** A configuration that lets the process start. The port 0 asks for a free one. */
const WORKING = {
  ZKPOR_NETWORK: "testnet",
  ZKPOR_RPC_URL: "http://127.0.0.1:1/",
  [PORT_ENV]: "0",
};

describe("a configuration that the process cannot start with", () => {
  it("stops with the code that the client library publishes, and not one of its own", async () => {
    // The code has one definition, in the client library. A copy here would
    // drift from it without anything noticing.
    expect(EXIT_USAGE).toBe(2);
    const answer = await start({ ZKPOR_RPC_URL: "http://127.0.0.1:1/" });
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("ZKPOR_NETWORK");
  });

  it("stops when the environment names no endpoint", async () => {
    const answer = await start({ ZKPOR_NETWORK: "testnet" });
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("ZKPOR_RPC_URL");
  });

  it("stops when the deployments file records no generation of that network", async () => {
    const answer = await start({
      ...WORKING,
      ZKPOR_NETWORK: "a-network-nobody-deployed",
      ZKPOR_NETWORK_PASSPHRASE: "a passphrase of its own",
    });
    expect(answer.code).toBe(EXIT_USAGE);
    expect(answer.stderr).toContain("no generation");
  });

  it("stops when the port is not a port", async () => {
    for (const port of ["not a number", "0.5", "70000", "-1"]) {
      const answer = await start({ ...WORKING, [PORT_ENV]: port });
      expect(answer.code, port).toBe(EXIT_USAGE);
      expect(answer.stderr, port).toContain(PORT_ENV);
    }
  });

  it("names no key in anything it prints", async () => {
    const secret = `0x${"ab".repeat(32)}`;
    const answer = await start({
      ZKPOR_RPC_URL: "http://127.0.0.1:1/",
      ZKPOR_MASTER_SECRET: secret,
      ZKPOR_AUTHORITY_SECRET: "SAUTHORITYKEYVALUE",
    });
    expect(answer.stderr).not.toContain(secret);
    expect(answer.stdout).not.toContain(secret);
    expect(answer.stderr).not.toContain("SAUTHORITYKEYVALUE");
  });
});

describe("a configuration that the process starts with", () => {
  it("prints the loopback address, and says that no other machine reaches it", async () => {
    const answer = await start(WORKING, true);
    expect(answer.stdout).toContain(`http://${LOOPBACK_HOST}:`);
    expect(answer.stdout).toContain("loopback address only");
    // The address it prints is the address it binds, and the host is a
    // constant of this package.
    expect(answer.stdout).not.toContain("0.0.0.0");
  });

  it("prints a port that answers, and never the one that was asked for", async () => {
    // This is the truthfulness property, and reachability is the only way to
    // state it. A test that matched the prefix `http://127.0.0.1:` passes
    // against `http://127.0.0.1:0/`, which names no port anybody can reach, so
    // it would accept a process that printed the request instead of the
    // binding. The setting asks for any free port, so the two differ here,
    // which is the condition that makes the question meaningful at all.
    const answer = await start(WORKING, true);
    const printed = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(answer.stdout)?.[1];
    expect(printed, `no address in: ${answer.stdout}`).toBeDefined();
    expect(printed).not.toBe("0");
    expect(Number.parseInt(printed ?? "0", 10)).toBeGreaterThan(0);
  });

  it("answers on the port it printed", async () => {
    // The process is still running while this asks, so the answer settles
    // whether the printed port was the bound one.
    const reached = await startAndAsk(WORKING);
    expect(reached.port, "the process printed no port").not.toBe(0);
    expect(reached.status, `nothing answered on the port ${String(reached.port)}`).toBe(200);
  });

  it("states the default without binding it, so a running dashboard breaks no test", () => {
    // A test that started the process on the default would turn red whenever
    // anything already held that port, including the issuer's own dashboard.
    // The default is a constant, and the address is built from it, so the two
    // can be checked without taking the port from whoever has it.
    expect(DEFAULT_PORT).toBe(7878);
    expect(`http://${LOOPBACK_HOST}:${String(DEFAULT_PORT)}/`).toBe("http://127.0.0.1:7878/");
  });
});

describe("no test imports the entry point", () => {
  /**
   * The specifier that no test may name, assembled rather than written.
   *
   * A scan that held the specifier as a literal would find it in its own
   * source and refuse itself.
   */
  const ENTRY = ["/src/", "main", ".js"].join("");

  /** Every test source of this package. */
  function testSources(): string[] {
    return readdirSync(HERE).filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
  }

  it("scans a plausible number of files, because a scan of none reads as clean", () => {
    // A scan that reaches no file passes without checking anything and looks
    // like a clean result. This repository codified that once already, in the
    // scan that refuses a type assertion, so the count is part of the check.
    expect(testSources().length).toBeGreaterThanOrEqual(5);
    expect(testSources()).toContain("start.test.ts");
  });

  it("because importing it would start the dashboard inside the test process", () => {
    // The entry point runs itself at the end of its own module. Reaching it
    // from a test would open a listener and resolve a configuration inside the
    // process running the tests, and its failure path calls process.exit,
    // which a runner reports as an unhandled rejection while every test still
    // passes. The suite then fails with nothing in the counts to read.
    //
    // The scan looks for the specifier anywhere rather than only after `from`,
    // because a dynamic import names it too and an earlier form of this check
    // saw only the static spelling.
    for (const name of testSources()) {
      expect(
        readFileSync(join(HERE, name), "utf8"),
        `${name} reaches the entry point module`,
      ).not.toContain(ENTRY);
    }
  });

  it("and the entry point offers nothing worth importing", () => {
    // The scan reads text, so it cannot see a specifier assembled at run time,
    // which is what this file itself does two definitions above.
    // This closes the motive rather than the spelling. The backstop for both
    // is the exit status of the suite, which the agreement job reads.
    const main = readFileSync(join(HERE, "..", "src", "main.ts"), "utf8");
    expect(main).not.toMatch(/^export /m);
  });

  it("and the entry point is still the entry point it claims to be", () => {
    const main = readFileSync(join(HERE, "..", "src", "main.ts"), "utf8");
    expect(main).toContain("main().catch(");
  });
});
