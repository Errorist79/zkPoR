/**
 * The tools of the issuer script, driven rather than read.
 *
 * Every guarantee the shell made used to be asserted by reading its source,
 * because the script cannot be entered without the pinned toolchain. Reading
 * catches a deletion and it does not catch a change that keeps the text and
 * moves the behaviour, which is how the same guarantee was defeated twice in
 * the client library.
 *
 * The tools now live in a file that a test can source, so these drive the
 * property with a tool of their own: a sleep in place of a prover, and a
 * further process in place of the generator that `cargo run` starts.
 *
 * Two tests replace `kill` for their own duration. That is the only way to
 * observe the two properties they are about, because both are statements about
 * a signal that is not sent, or one that is sent and does not land, and neither
 * can be seen in its consequence.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alive, until } from "./processes.js";

/** The file under test. */
const TOOLS = join(import.meta.dirname, "..", "..", "scripts", "run_tools.sh");

/** A directory for one case. */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), "zkpor-tools-"));
}

/** Runs one bash script to completion and returns what it wrote. */
function runScript(body: string, argument: string): { status: number; stderr: string } {
  const directory = workspace();
  const path = join(directory, "case.sh");
  writeFileSync(path, `source ${JSON.stringify(TOOLS)}\n${body}\n`);
  // Both streams are read, because a case states what it saw on the error
  // stream and a reader of a failure needs the other one too.
  const answer = spawnSync("bash", [path, argument], { encoding: "utf8" });
  return { status: answer.status ?? -1, stderr: `${answer.stdout}${answer.stderr}` };
}

describe("a tool of the issuer script", () => {
  it("runs in a process group of its own", () => {
    const answer = runScript(
      [
        'run_tool bash -c \'echo "pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d " ")" >&2\'',
      ].join("\n"),
      "unused",
    );
    const found = /pid=(\d+) pgid=(\d+)/.exec(answer.stderr);
    expect(found, `the tool printed nothing: ${answer.stderr}`).not.toBeNull();
    // A tool that led no group would report the group of the script instead,
    // and the negated signal the stop sends would then reach nothing.
    expect(found?.[1]).toBe(found?.[2]);
  });

  it("is stopped with the further process it started, on a signal to the script alone", async () => {
    const directory = workspace();
    const grandchild = join(directory, "grandchild");
    const path = join(directory, "case.sh");
    writeFileSync(
      path,
      [
        `source ${JSON.stringify(TOOLS)}`,
        "trap 'stop_tools; exit 130' TERM",
        `run_tool bash -c 'sleep 60 & echo $! > ${JSON.stringify(grandchild)}; echo ready >&2; sleep 60'`,
      ].join("\n"),
    );
    const child = spawn("bash", [path], { stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let seen = "";
      child.stderr.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        if (seen.includes("ready")) {
          resolve();
        }
      });
      child.on("exit", () => {
        reject(new Error("the script ended before its tool was ready"));
      });
    });
    const further = Number.parseInt(readFileSync(grandchild, "utf8").trim(), 10);
    expect(Number.isInteger(further)).toBe(true);

    if (child.pid === undefined) {
      throw new Error("the script has no identifier");
    }
    process.kill(child.pid, "SIGTERM");
    expect(await until(() => !alive(child.pid ?? 0)), "the script outlived the signal").toBe(true);
    // The further process is the one a signal aimed at the tool alone would
    // have left running, and it is the one that writes the prover inputs.
    expect(await until(() => !alive(further)), "the further process outlived the stop").toBe(true);
  }, 40_000);

  it("gives back the status of a tool that failed", () => {
    // A run continues past a tool that failed when the helper reports success,
    // and the steps after it then work from an output that was never written.
    const answer = runScript(
      ['run_tool bash -c "exit 3"', 'echo "status=$?" >&2'].join("\n"),
      "unused",
    );
    expect(answer.stderr).toContain("status=3");
  });

  it("gives back success for a tool that succeeded", () => {
    const answer = runScript(
      ['run_tool bash -c "exit 0"', 'echo "status=$?" >&2'].join("\n"),
      "unused",
    );
    expect(answer.stderr).toContain("status=0");
  });

  it("is not signalled once it has been waited for", () => {
    // The identifier of a tool that has been reaped may name another process,
    // and the signal the stop sends cannot be caught. The property is that no
    // signal is sent, which cannot be seen in a consequence, so the test reads
    // the call.
    const directory = workspace();
    const log = join(directory, "signals");
    const answer = runScript(
      [
        `kill() { echo "$*" >> ${JSON.stringify(log)}; builtin kill "$@"; }`,
        "run_tool sleep 0.05",
        "stop_tools",
      ].join("\n"),
      "unused",
    );
    expect(answer.status).toBe(0);
    const sent = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(sent, "the stop signalled a tool it had already waited for").not.toContain("-KILL");
  });

  it("does not return until the group has gone", async () => {
    // The case below it proves the stop speaks when a group outlives the
    // deadline, and it cannot prove the stop waited: it swallows the signal, so
    // the group survives either way and the message prints whether the wait ran
    // or not. Removing the wait passed that case.
    //
    // Here the signal lands, late. A tool that takes a known time to die
    // separates a stop that waited from one that returned and left the sweep to
    // run against something still ending.
    const directory = workspace();
    const path = join(directory, "case.sh");
    writeFileSync(
      path,
      [
        `source ${JSON.stringify(TOOLS)}`,
        // The kill is delivered after a delay rather than swallowed, so the
        // group really goes and the wait really has something to wait for.
        'kill() { if [ "$1" = "-KILL" ]; then ( sleep 0.4; builtin kill -KILL "$2" 2>/dev/null ) & return 0; fi; builtin kill "$@"; }',
        "trap 'stop_tools; echo stopped >&2; exit 130' TERM",
        "run_tool sleep 60",
      ].join("\n"),
    );
    const child = spawn("bash", [path], { stdio: ["ignore", "ignore", "pipe"] });
    let seen = "";
    child.stderr.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (child.pid === undefined) {
      throw new Error("the script has no identifier");
    }
    const sent = Date.now();
    process.kill(child.pid, "SIGTERM");
    expect(await until(() => seen.includes("stopped"), 10_000), `stderr was: ${seen}`).toBe(true);
    const waited = Date.now() - sent;
    // The tool dies 400 milliseconds after the signal. A stop that returned
    // before that did not wait for it.
    expect(waited, `the stop returned after ${String(waited)} milliseconds`).toBeGreaterThanOrEqual(
      300,
    );
    // And it went, so the stop has nothing to report. This separates waiting
    // from giving up.
    expect(seen, "the stop reported a group that had in fact ended").not.toContain(
      "had not ended",
    );
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // It ended on its own, which is the ordinary case.
    }
  }, 40_000);

  it("says so when a group outlives the deadline, rather than passing quietly", async () => {
    const directory = workspace();
    const path = join(directory, "case.sh");
    writeFileSync(
      path,
      [
        `source ${JSON.stringify(TOOLS)}`,
        // The signal is swallowed, so the group stays alive and the wait runs
        // to its deadline. Nothing else makes a group survive an uncatchable
        // signal, which is why this is the only way to reach the statement.
        'kill() { if [ "$1" = "-KILL" ]; then return 0; fi; builtin kill "$@"; }',
        "trap 'stop_tools; exit 130' TERM",
        "run_tool sleep 60",
      ].join("\n"),
    );
    const child = spawn("bash", [path], { stdio: ["ignore", "ignore", "pipe"] });
    let seen = "";
    child.stderr.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    // The waits below yield rather than block. A synchronous sleep holds the
    // loop that delivers the output of the child, so the test would read an
    // empty stream and report a silent stop that had in fact spoken.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (child.pid === undefined) {
      throw new Error("the script has no identifier");
    }
    process.kill(child.pid, "SIGTERM");
    expect(await until(() => seen.includes("had not ended"), 5_000), `stderr was: ${seen}`).toBe(
      true,
    );
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // It ended on its own, which is the ordinary case.
    }
  }, 40_000);
});

/**
 * One name for the network, across the scripts and the client.
 *
 * The scripts used to invent `STELLAR_NETWORK_NAME`, which is a name inside the
 * namespace of the Stellar command line that the command line does not define.
 * That tool reads `STELLAR_NETWORK` for a lookup in its own configuration, so
 * three names described two concepts, and a person who had just attested had
 * none of them set for the check that follows.
 *
 * These drive the shared profile rather than reading it, because a profile that
 * states the value and exports nothing would pass a reading.
 */
describe("the network profile of the scripts", () => {
  const CONFIG = join(import.meta.dirname, "..", "..", "scripts", "config.sh");

  function profile(network: string): Record<string, string> {
    const answer = spawnSync(
      "bash",
      ["-c", `source ${CONFIG} >/dev/null 2>&1; env | grep -E "^(ZKPOR|STELLAR)_"`],
      { encoding: "utf8", env: { ...process.env, ZKPOR_NETWORK: network } },
    );
    const found: Record<string, string> = {};
    for (const line of answer.stdout.split("\n")) {
      const cut = line.indexOf("=");
      if (cut > 0) {
        found[line.slice(0, cut)] = line.slice(cut + 1);
      }
    }
    return found;
  }

  it("configures the client of this project as well as the command line", () => {
    // The defect this replaces: the scripts set the endpoint for one tool, and
    // a person running the check afterwards set it again from memory.
    const found = profile("testnet");
    expect(found.ZKPOR_NETWORK).toBe("testnet");
    expect(found.ZKPOR_RPC_URL).toBe(found.STELLAR_RPC_URL);
    expect(found.ZKPOR_NETWORK_PASSPHRASE).toBe(found.STELLAR_NETWORK_PASSPHRASE);
  });

  it("carries the endpoint of each profile it names", () => {
    expect(profile("testnet").ZKPOR_RPC_URL).toContain("soroban-testnet");
    expect(profile("local").ZKPOR_RPC_URL).toContain("localhost");
  });

  it("names no network variable that the Stellar command line does not define", () => {
    // `STELLAR_NETWORK_NAME` reads like a variable of that tool and is not one.
    const found = profile("testnet");
    expect(Object.keys(found)).not.toContain("STELLAR_NETWORK_NAME");
  });
});
