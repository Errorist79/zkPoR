/**
 * The record of what this process did.
 *
 * A page states what an issuer asked for. This states what the process did, for
 * the operator who runs it and for a machine that reads it later, so the two
 * never say the same thing in different words. A sentence for a reader lives in
 * the client library and on the pages, and one of those sentences travels here
 * whole, in the `step` field, rather than being written a second time.
 *
 * One event is one line, and one line is one JSON object. The keys are lower
 * snake case because this is a wire format and not TypeScript: the registry and
 * the circuit publish `final_root` and `context_hash`, and an operator who
 * matches a log line against the chain must not have to translate a name. Do
 * not rename these keys to match the code around them.
 *
 * Every line goes to the standard error stream, and the address to open goes to
 * the standard output stream. So a reader of the machine stream meets no
 * sentence, and an operator who wants one file writes `2>&1`. The banner states
 * nothing that `process.started` does not carry, so the split loses convenience
 * and never information.
 *
 * A caller cannot log a value of its own choosing. There is no function here
 * that takes a message or a free object: an event is one member of the union
 * below, and every field of it is declared. To put a customer balance in a log
 * somebody must add a field to that union, in this file, where a reader of the
 * change sees it. The tests hold three further guards, and this is the one that
 * makes the accident hard rather than visible.
 */

/** What a line carries beyond its fields. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** The levels an operator can ask for. `debug` adds the lines that repeat. */
export const LOG_SETTINGS = ["info", "debug"] as const;

/** The level that the operator asked for. */
export type LogSetting = (typeof LOG_SETTINGS)[number];

/**
 * Every event, with every field it carries.
 *
 * Two fields are absent on purpose.
 *
 * The versions of the pinned tools have no field of their own. The client
 * library finds them inside the proving run and returns the proof alone, so the
 * only place they exist here is the text of the step that names them, which
 * `run.step` carries. A structured field waits until that library returns its
 * pins.
 *
 * The count of the packages is named for who counted it. The generator answers
 * with the directory it filled and with no count, so this process reads that
 * directory and counts what it finds. A field named `files` would read as a
 * number the generator reported.
 */
export type LogEvent =
  | {
      event: "process.started";
      host: string;
      port: number;
      network: string;
      rpc_origin: string;
      generations: number;
      deployments_file: string;
      repository: string;
      master_secret_present: boolean;
      authority_secret_present: boolean;
    }
  | { event: "process.refused"; error: string }
  | {
      event: "run.started";
      run: string;
      action: string;
      asset: string;
      snapshot_ledger: number;
      registry: string;
      context_file: string;
      customers_file: string;
    }
  | { event: "run.refused"; reason: string }
  | { event: "run.step"; run: string; step: string; ms: number }
  | {
      event: "proof.finished";
      run: string;
      proof_bytes: number;
      final_root: string;
      total_liabilities: string;
      context_hash: string;
      ms: number;
    }
  | { event: "window.read"; run: string; current_ledger: number; still_open: boolean }
  | {
      event: "attestation.submitted";
      run: string;
      registry: string;
      ledger: number;
      transaction: string;
      ms: number;
    }
  | {
      event: "packages.written";
      run: string;
      directory: string;
      /** Absent when this process did not count. A wrong count is worse than none. */
      files_counted_here?: number | undefined;
      ms: number;
    }
  | { event: "run.finished"; run: string; action: string; stage: string; ms: number }
  | { event: "run.failed"; run: string; error: string; ms: number }
  | { event: "chain.read"; call: string; registry?: string | undefined; ms: number }
  | { event: "chain.failed"; call: string; registry?: string | undefined; error: string; ms: number }
  | { event: "request.answered"; method: string; route: string; status: number; ms: number }
  | { event: "request.failed"; method: string; route: string; status: number; ms: number };

/** The name of one event. */
export type LogEventName = LogEvent["event"];

/**
 * The level of each event.
 *
 * The record names every event, so an event added without a level does not
 * compile. A level that lives beside the call site instead would let two calls
 * of one event disagree.
 */
export const LEVEL_OF_EVENT: Record<LogEventName, LogLevel> = {
  "process.started": "info",
  "process.refused": "error",
  "run.started": "info",
  "run.refused": "warn",
  "run.step": "info",
  "proof.finished": "info",
  "window.read": "info",
  "attestation.submitted": "info",
  "packages.written": "info",
  "run.finished": "info",
  "run.failed": "error",
  "chain.read": "debug",
  "chain.failed": "warn",
  "request.answered": "debug",
  "request.failed": "warn",
};

/** Writes one event. */
export type Log = (event: LogEvent) => void;

/**
 * The address of the endpoint, as its origin and nothing else.
 *
 * Some endpoints carry a key in the path of the address, so a log that named
 * the address would publish it to every reader of the file. The origin holds
 * the scheme, the host and the port, and it drops the user information, the
 * path and the query. An address that this process cannot read gives a
 * statement rather than the text, because the text is what may carry the key.
 */
export function endpointOrigin(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return "an address that this process cannot read";
  }
}

/**
 * A log that writes to the stream a caller names.
 *
 * The caller supplies the writer, so a test reads what a run wrote and no test
 * writes to a stream of the machine.
 */
export function openLog(input: {
  setting: LogSetting;
  write: (line: string) => void;
  now?: () => Date;
}): Log {
  const now = input.now ?? ((): Date => new Date());
  return (event: LogEvent): void => {
    const level = LEVEL_OF_EVENT[event.event];
    if (level === "debug" && input.setting !== "debug") {
      return;
    }
    input.write(`${JSON.stringify({ time: now().toISOString(), level, ...event })}\n`);
  };
}

/** A log that writes nothing. It is for a caller that states it wants none. */
export const SILENT_LOG: Log = () => {};
