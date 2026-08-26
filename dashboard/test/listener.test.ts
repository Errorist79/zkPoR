/**
 * The running listener, over a real socket.
 *
 * Every other test drives the route function, which touches no socket. That
 * leaves the server itself unchecked, and the server is where an answer can
 * escape the one writer and lose the policy. These tests start the real
 * listener, send real requests, and read the real headers.
 */

import { connect } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CACHE_CONTROL,
  CONTENT_SECURITY_POLICY,
  LOOPBACK_HOST,
  MAX_BODY_BYTES,
  ROUTES,
} from "../src/constants.js";
import { openDashboard } from "../src/server.js";
import { dashboard } from "./support.js";

let server: Server;
let origin: string;

beforeAll(async () => {
  // The port 0 asks the operating system for a free one, so a test run never
  // fights the dashboard of a developer on the usual port.
  server = await openDashboard({ port: 0, dashboard: dashboard({ deploymentsText: "[]" }) });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the listener bound no port");
  }
  origin = `http://${LOOPBACK_HOST}:${String(bound.port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** The headers that every answer must carry, whatever the answer holds. */
const REQUIRED = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * The headers of one answer, with what a browser may keep of it.
 *
 * A page carries balance figures, so every page states that a browser keeps no
 * copy. The stylesheet holds no data about anybody and its address carries the
 * version of its text, so a browser may keep it.
 *
 * The two values are named here, and each case says which one it expects. A
 * change to either value fails, and a page that started to permit a copy fails
 * on the page value rather than passing on a rule that no longer covers it.
 */
function expectRequiredHeaders(
  answer: Response,
  what: string,
  cacheControl: string = CACHE_CONTROL.page,
): void {
  for (const [name, value] of Object.entries(REQUIRED)) {
    expect(answer.headers.get(name), `${what}: ${name}`).toBe(value);
  }
  expect(answer.headers.get("cache-control"), `${what}: cache-control`).toBe(cacheControl);
}

/**
 * One raw request, written to the socket exactly as given.
 *
 * A client library refuses to send a host line that names another machine,
 * because that is a header it reserves. The rebinding guard exists for exactly
 * that request, so the test writes the bytes itself.
 */
async function rawRequest(lines: readonly string[]): Promise<string> {
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the listener bound no port");
  }
  return await new Promise((resolve, reject) => {
    const socket = connect(bound.port, LOOPBACK_HOST, () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let answer = "";
    socket.setTimeout(10_000);
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString();
    });
    socket.on("end", () => {
      resolve(answer);
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("the listener did not answer"));
    });
    socket.on("error", reject);
  });
}

/** The status line and the headers of a raw answer, lowercased by name. */
function statusOf(answer: string): number {
  const first = answer.split("\r\n")[0] ?? "";
  return Number.parseInt(first.split(" ")[1] ?? "0", 10);
}

function headersOf(answer: string): Map<string, string> {
  const head = answer.split("\r\n\r\n")[0] ?? "";
  const found = new Map<string, string>();
  for (const line of head.split("\r\n").slice(1)) {
    const cut = line.indexOf(":");
    if (cut > 0) {
      found.set(line.slice(0, cut).toLowerCase(), line.slice(cut + 1).trim());
    }
  }
  return found;
}

describe("the listener", () => {
  it("binds the loopback address only", () => {
    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("the listener bound no port");
    }
    expect(bound.address).toBe(LOOPBACK_HOST);
  });
});

describe("every answer that the listener writes", () => {
  it("carries the policy on a page it serves", async () => {
    const answer = await fetch(`${origin}${ROUTES.home}`);
    expect(answer.status).toBe(200);
    expectRequiredHeaders(answer, "the home page");
  });

  it("carries the policy on the stylesheet", async () => {
    const answer = await fetch(`${origin}${ROUTES.style}`);
    expect(answer.status).toBe(200);
    expectRequiredHeaders(answer, "the stylesheet", CACHE_CONTROL.stylesheet);
  });

  it("carries the policy on a path it does not serve", async () => {
    const answer = await fetch(`${origin}/no/such/page`);
    expect(answer.status).toBe(404);
    expectRequiredHeaders(answer, "an unknown path");
  });

  it("carries the policy on a request that names another authority", async () => {
    const answer = await rawRequest([`GET ${ROUTES.home} HTTP/1.1`, "Host: issuer.example", "Connection: close"]);
    expect(statusOf(answer)).toBe(421);
    for (const [name, value] of Object.entries(REQUIRED)) {
      expect(headersOf(answer).get(name), `a foreign authority: ${name}`).toBe(value);
    }
    expect(headersOf(answer).get("cache-control"), "a foreign authority: cache-control").toBe(
      CACHE_CONTROL.page,
    );
  });

  it("carries the policy on a submission from another site", async () => {
    const answer = await fetch(`${origin}${ROUTES.inclusion}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: "package-path=/etc/passwd",
    });
    expect(answer.status).toBe(403);
    expectRequiredHeaders(answer, "a cross-site submission");
  });

  it("carries the policy on a body that is too long", async () => {
    // The audit found this one answer leaving through a header object of its
    // own, so it served a page that the policy did not govern.
    const answer = await fetch(`${origin}${ROUTES.inclusion}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: `package-path=${"x".repeat(MAX_BODY_BYTES + 1_000)}`,
    });
    expect(answer.status).toBe(413);
    expectRequiredHeaders(answer, "a body that is too long");
  });

  it("carries the policy on a submission it refuses for its value", async () => {
    const answer = await fetch(`${origin}${ROUTES.inclusion}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: "package-path=",
    });
    expect(answer.status).toBe(400);
    expectRequiredHeaders(answer, "a submission with no path");
  });
});

describe("a submission that carries no statement of its origin", () => {
  it("stops, because the guard fails closed", async () => {
    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("the listener bound no port");
    }
    const body = "package-path=/etc/passwd";
    const answer = await rawRequest([
      `POST ${ROUTES.inclusion} HTTP/1.1`,
      `Host: 127.0.0.1:${String(bound.port)}`,
      "Content-Type: application/x-www-form-urlencoded",
      `Content-Length: ${String(body.length)}`,
      "Connection: close",
      "",
      body,
    ]);
    expect(statusOf(answer)).toBe(403);
    expect(answer).not.toContain("passwd");
  });

  it("stops a run that no page of this process started", async () => {
    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("the listener bound no port");
    }
    // A real attestation on a real network sits behind this path.
    const body = "context-path=a&customers-path=b&action=attest";
    const answer = await rawRequest([
      `POST ${ROUTES.run} HTTP/1.1`,
      `Host: 127.0.0.1:${String(bound.port)}`,
      "Content-Type: application/x-www-form-urlencoded",
      `Content-Length: ${String(body.length)}`,
      "Connection: close",
      "",
      body,
    ]);
    expect(statusOf(answer)).toBe(403);
  });
});

describe("the authority of a raw request", () => {
  it("stops a name that resolves to this machine but is not this machine", async () => {
    // A remote name can resolve to the loopback address. A page served under
    // that name would be same-origin with this process and could read every
    // answer, so the guard compares the name and not the address.
    const answer = await rawRequest([
      `GET ${ROUTES.home} HTTP/1.1`,
      "Host: dashboard.issuer.example",
      "Connection: close",
    ]);
    expect(statusOf(answer)).toBe(421);
    expect(answer).toContain("loopback address only");
  });

  it("stops a request of the oldest kind, which carries no host line", async () => {
    const answer = await rawRequest([`GET ${ROUTES.home} HTTP/1.0`, "Connection: close"]);
    expect(statusOf(answer)).toBe(421);
  });

  it("accepts every loopback name that a browser sends", async () => {
    for (const name of ["127.0.0.1", "localhost"]) {
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        throw new Error("the listener bound no port");
      }
      const answer = await rawRequest([
        `GET ${ROUTES.home} HTTP/1.1`,
        `Host: ${name}:${String(bound.port)}`,
        "Connection: close",
      ]);
      expect(statusOf(answer), name).toBe(200);
    }
  });
});
