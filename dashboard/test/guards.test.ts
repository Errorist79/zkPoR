/**
 * The two guards that run before any route.
 *
 * The listener binds the loopback address, so a remote machine cannot open a
 * connection to it. Two paths remain, and each has a guard.
 *
 * A remote name can resolve to the loopback address, which would make a page
 * on that name same-origin with this process and let it read every answer. The
 * authority guard stops a request that names anything but this machine.
 *
 * A page on another site can submit a form to this process. The submission
 * guard stops one, because a form here reads a file from this machine.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOPBACK_AUTHORITIES, ROUTES } from "../src/constants.js";
import { isLoopbackAuthority, isOwnSubmission, route } from "../src/routes.js";
import { REPOSITORY_ROOT, dashboard, request } from "./support.js";

describe("the authority of a request", () => {
  it("accepts every loopback name, with a port and without one", () => {
    for (const name of LOOPBACK_AUTHORITIES) {
      expect(isLoopbackAuthority(name)).toBe(true);
      expect(isLoopbackAuthority(`${name}:7878`)).toBe(true);
    }
  });

  it("refuses a name that resolves elsewhere, and a name that only looks local", () => {
    for (const name of [
      "issuer.example",
      "localhost.example",
      "127.0.0.1.example",
      "192.168.1.9",
      "0.0.0.0",
      "[::2]",
      undefined,
    ]) {
      expect(isLoopbackAuthority(name), String(name)).toBe(false);
    }
  });

  it("stops the request before any route reads it", async () => {
    const answered = await route(
      request({ target: ROUTES.home, host: "issuer.example" }),
      dashboard({ deploymentsText: "[]" }),
    );
    expect(answered.status).toBe(421);
    expect(answered.body).toContain("loopback address only");
  });
});

describe("a form submission", () => {
  it("passes from a page of this process", () => {
    expect(isOwnSubmission("same-origin")).toBe(true);
  });

  it("stops a request that states nothing about where it came from", () => {
    // The guard fails closed. What arrives is a request and not a client, so
    // an absent header is a fact this process cannot check rather than a
    // promise that no page drove it.
    expect(isOwnSubmission(undefined)).toBe(false);
  });

  it("stops from another site, from the same site, and from the address bar", () => {
    for (const site of ["cross-site", "same-site", "none", "", "SAME-ORIGIN"]) {
      expect(isOwnSubmission(site), site).toBe(false);
    }
  });

  it("stops before the route reads the body", async () => {
    const answered = await route(
      request({
        method: "POST",
        target: ROUTES.inclusion,
        fetchSite: "cross-site",
        body: "package-path=/etc/passwd",
      }),
      dashboard({ deploymentsText: "[]" }),
    );
    expect(answered.status).toBe(403);
    expect(answered.body).not.toContain("passwd");
  });
});

describe("a path that the dashboard does not serve", () => {
  it("answers that it serves no such page", async () => {
    const answered = await route(
      request({ target: "/../secrets" }),
      dashboard({ deploymentsText: "[]" }),
    );
    expect(answered.status).toBe(404);
  });

  it("serves the stylesheet from this process", async () => {
    const answered = await route(
      request({ target: ROUTES.style }),
      dashboard({ deploymentsText: "[]" }),
    );
    expect(answered.status).toBe(200);
    expect(answered.contentType).toContain("text/css");
  });
});

describe("a submission that names no file", () => {
  it("asks for a path again rather than stating an outcome", async () => {
    const answered = await route(
      request({ method: "POST", target: ROUTES.inclusion, body: "package-path=" }),
      dashboard({ deploymentsText: "[]" }),
    );
    expect(answered.status).toBe(400);
    expect(answered.body).toContain("Give the path of your package file.");
  });

  it("says a missing file is a missing file, and not a verdict", async () => {
    const answered = await route(
      request({
        method: "POST",
        target: ROUTES.inclusion,
        body: new URLSearchParams({ "package-path": "/no/such/package.zkpor.json" }).toString(),
      }),
      dashboard({ deploymentsText: "[]" }),
    );
    expect(answered.status).toBe(400);
    expect(answered.body).toContain("holds no readable file");
    expect(answered.body).not.toContain("The leaf is under the attested root");
  });
});

describe("a run that the endpoint stopped", () => {
  it("is a failure and not a refusal of the submission", async () => {
    // The client of the tests points at a port that nothing listens on, so the
    // window check cannot read the current ledger. That is a failure of the
    // infrastructure, and the specification keeps such a failure apart from a
    // value the issuer can correct.
    const answered = await route(
      request({
        method: "POST",
        target: ROUTES.run,
        body: new URLSearchParams({
          "context-path": join(REPOSITORY_ROOT, "fixtures", "test_only_context.toml"),
          "customers-path": "customers.csv",
          action: "prove",
        }).toString(),
      }),
      dashboard({
        deploymentsText: "[]",
        environment: { ZKPOR_MASTER_SECRET: `0x${"11".repeat(32)}` },
      }),
    );
    expect(answered.status).toBe(502);
    expect(answered.body).toContain("It is not a result.");
    expect(answered.body).not.toContain("11".repeat(32));
  });
});

