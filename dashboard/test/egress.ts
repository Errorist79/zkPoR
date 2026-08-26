/**
 * Every destination that this process tries to reach while a test drives it.
 *
 * The pages are checked elsewhere for the addresses they name. That is a
 * property of the markup and it says nothing about the process. A line added
 * anywhere inside a route can open a connection of its own, and no assertion
 * about markup notices, because the markup does not change.
 *
 * A scan of the source is the other tempting instrument and it is the weaker
 * one. It reads a spelling, and a call can be written in a spelling the scan
 * does not hold. This records the call instead, at the three places a client
 * ends: the stream socket, the fetch the runtime provides, and the datagram
 * socket. Every request this dashboard makes is one of those.
 *
 * It opens none of them, and a test therefore reaches no network at all. A
 * recorded connection is refused the way a closed port refuses one, so a reader
 * of a route sees the failure that a real unreachable endpoint produces. A
 * recorded datagram goes nowhere and reports nothing, which is what a datagram
 * to an unreachable host also does.
 *
 * What this covers, stated as a boundary rather than as a list of cases.
 *
 * Replacing a call catches every client that reaches the network through that
 * call, in this thread, in this process. That is what the three replacements
 * below are: the socket every stream client ends at, the fetch the runtime
 * provides, and the send of a datagram socket. It follows that two kinds of
 * thing are outside it, and the second is the general form of the first.
 *
 * A client that reaches the network without one of the three calls. A name
 * resolution is the one that exists here, and this refuses no resolution,
 * because the runtime resolves names for its own reasons during a test run and
 * a refusal would break machinery unrelated to this property. Nothing this does
 * cover reaches a resolver, because a connection is recorded and refused before
 * a name is looked up.
 *
 * Anything holding its own copy of the calls. A program this process starts has
 * its own runtime, and a thread of this process has its own copy of every
 * prototype, so each reaches the network with nothing here watching. Both are
 * covered, and not by this file: the test that drives the routes replaces the
 * modules that start a program and a thread, and refuses both.
 *
 * The boundary is written this way on purpose. An earlier version of this
 * comment enumerated the uncovered cases and said there were two. There were
 * four. A closed set of cases written from a reading is the failure this
 * project names in its own conventions, and it happened in the file that exists
 * to stop the same mistake elsewhere. A rule about where the mechanism reaches
 * stays true when somebody finds a fifth way out; a count does not.
 *
 * The same comment then gave a reason that a measurement disproves. It said the
 * runtime exposes the datagram module in a form that a test cannot replace, so
 * the datagram path had to stay outside. The send of a datagram socket is
 * writable and configurable, the same as the connect of a stream socket, and
 * the third replacement below now takes it. A reason that nobody measures is a
 * closed set with one member.
 */

import { Socket as DatagramSocket } from "node:dgram";
import { Socket } from "node:net";

/** What one test run observed. */
export interface Egress {
  /** Every destination, in the order the process tried to reach it. */
  readonly destinations: readonly string[];
  /** Puts the runtime back the way it was. */
  restore(): void;
}

/** The destination of one connection, as `host:port`. */
function destinationOf(args: readonly unknown[]): string {
  // The runtime normalises the arguments of its own helpers before it reaches
  // the socket, and hands this one array holding the options and the callback.
  // Reading the array as if it were the options names every destination
  // `localhost`, which is wrong in the one direction that matters: it hides
  // which host a call reached.
  const head = Array.isArray(args[0]) ? args[0][0] : args[0];
  const first: unknown = head;
  if (typeof first === "number") {
    const host = args[1];
    return `${typeof host === "string" ? host : "localhost"}:${String(first)}`;
  }
  if (typeof first === "string") {
    // A path rather than an address. It reaches no network and it is recorded
    // anyway, because a reader of a failure should see what was opened.
    return first;
  }
  if (typeof first === "object" && first !== null) {
    const host: unknown = Reflect.get(first, "host");
    const port: unknown = Reflect.get(first, "port");
    const path: unknown = Reflect.get(first, "path");
    if (typeof path === "string") {
      return path;
    }
    const named = typeof host === "string" ? host : "localhost";
    const numbered =
      typeof port === "number" || typeof port === "string" ? String(port) : "unknown";
    return `${named}:${numbered}`;
  }
  return "a destination this recorder cannot name";
}

/** The destination of one datagram, as `host:port`. */
function destinationOfDatagram(socket: DatagramSocket, args: readonly unknown[]): string {
  // The runtime takes the message alone, and the message with an offset and a
  // length, so the port sits at one of two places. Reading the wrong one names
  // every datagram `localhost`, which hides which host a call reached.
  const counted = typeof args[1] === "number" && typeof args[2] === "number";
  const port = counted ? args[3] : args[1];
  const address = counted ? args[4] : args[2];
  if (typeof port === "number" || typeof port === "string") {
    return `${typeof address === "string" ? address : "localhost"}:${String(port)}`;
  }
  // A connected socket names no destination in the call and holds it instead.
  try {
    const remote = socket.remoteAddress();
    return `${remote.address}:${String(remote.port)}`;
  } catch {
    return "a destination this recorder cannot name";
  }
}

/**
 * True when a value is the completion that a send takes as its last argument.
 *
 * The parameter list of a function is not observable at run time, so this is
 * the narrowest check the runtime allows.
 */
function isCompletion(value: unknown): value is (error: Error) => void {
  return typeof value === "function";
}

/** The destination of one fetch, as `host:port`, with the runtime's defaults. */
function destinationOfUrl(target: unknown): string {
  const text =
    typeof target === "string"
      ? target
      : target instanceof URL
        ? target.href
        : typeof target === "object" && target !== null
          ? String(Reflect.get(target, "url"))
          : String(target);
  try {
    const parsed = new URL(text);
    const port = parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : parsed.port;
    return `${parsed.hostname}:${port}`;
  } catch {
    return text;
  }
}

/**
 * Records every connection this process opens, and opens none of them.
 *
 * The caller restores the runtime in a `finally`, because a recorder left
 * installed would break every test that runs after it.
 */
export function recordEgress(): Egress {
  const destinations: string[] = [];
  const originalConnect = Socket.prototype.connect;
  const originalSend = DatagramSocket.prototype.send;
  const originalFetch = globalThis.fetch;

  function connect(this: Socket, ...args: readonly unknown[]): Socket {
    destinations.push(destinationOf(args));
    // The refusal arrives on the next tick, as a real refusal does, so the
    // caller sees a connection failure rather than a thrown call.
    process.nextTick(() => {
      this.destroy(new Error("this test opens no connection"));
    });
    return this;
  }

  function send(this: DatagramSocket, ...args: readonly unknown[]): void {
    destinations.push(destinationOfDatagram(this, args));
    // A datagram carries no answer, and a real one that never arrives reports
    // nothing to the caller, so this reports nothing either. A caller that
    // passed a completion is told the send failed, which is what the runtime
    // tells it when the send does not go.
    const last = args[args.length - 1];
    if (isCompletion(last)) {
      process.nextTick(() => {
        last(new Error("this test sends no datagram"));
      });
    }
  }

  async function refuse(target: unknown): Promise<Response> {
    destinations.push(destinationOfUrl(target));
    throw new Error("this test opens no connection");
  }

  // Each is installed through a property definition rather than an assignment,
  // because the runtime declares narrower types for them and an assignment
  // would need a type assertion to satisfy it.
  Object.defineProperty(Socket.prototype, "connect", {
    value: connect,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(DatagramSocket.prototype, "send", {
    value: send,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "fetch", {
    value: refuse,
    writable: true,
    configurable: true,
  });
  return {
    destinations,
    restore(): void {
      Object.defineProperty(Socket.prototype, "connect", {
        value: originalConnect,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(DatagramSocket.prototype, "send", {
        value: originalSend,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(globalThis, "fetch", {
        value: originalFetch,
        writable: true,
        configurable: true,
      });
    },
  };
}
