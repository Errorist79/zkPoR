/**
 * The property that nothing leaves the machine.
 *
 * The property is structural, so the tests are structural. They do not check
 * that today's markup happens to avoid a remote host. They render every page in
 * every state and refuse any address that is not a path of this process, refuse
 * any script, and refuse a listener that a setting could move off the loopback
 * address. A later page that added a font from a network would fail here
 * without anybody remembering the rule.
 *
 * One outbound connection is inherent and stays: the process reads the registry
 * from the endpoint that the issuer configured. That connection carries a
 * contract call and never a balance, a salt, a path, a witness, or a key.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * The programs this process started while a test drove it.
 *
 * A recorder that replaces a call cannot see a program: a program this process
 * starts opens its own connections, through its own runtime, and nothing in
 * this one is asked. That is not an exotic path here, it is how the proving run
 * works, so the guard on connections has to be paired with one on programs or
 * it is aimed away from the way out that this system actually has.
 *
 * The list is declared through the hoisting helper because the interception
 * below is hoisted above the imports, and its factory runs as soon as anything
 * reaches for the module.
 */
const programs = vi.hoisted(() => {
  const started: string[] = [];
  return { started };
});

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (command: unknown): never => {
    programs.started.push(String(command));
    throw new Error("this test starts no program");
  };
  return {
    ...real,
    spawn: refuse,
    spawnSync: refuse,
    exec: refuse,
    execFile: refuse,
    execSync: refuse,
    execFileSync: refuse,
    fork: refuse,
  };
});

// A thread is the same escape as a program and it needs its own entry. A worker
// gets its own copy of every prototype, so a recorder that replaces a call in
// this thread patches one copy while the worker uses another, and the worker
// then reaches the network with nothing watching.
vi.mock("node:worker_threads", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:worker_threads")>();
  class RefusedWorker {
    constructor(source: unknown) {
      programs.started.push(`a thread running ${String(source)}`);
      throw new Error("this test starts no thread");
    }
  }
  return { ...real, Worker: RefusedWorker };
});
import type { Verdict } from "@zkpor/sdk";
import {
  CONTENT_SECURITY_POLICY,
  LOOPBACK_AUTHORITIES,
  LOOPBACK_HOST,
  ROUTES,
} from "../src/constants.js";
import { responseHeaders, route } from "../src/routes.js";
import type { DashboardRequest } from "../src/routes.js";
import { recordEgress } from "./egress.js";
import { createSocket } from "node:dgram";
import { Socket } from "node:net";
import { STYLESHEET } from "../src/style.js";
import { AssetPage, Home, UnregisteredAssetPage } from "../src/views/asset.js";
import { InclusionForm, InclusionVerdictPage } from "../src/views/inclusion.js";
import { Failure } from "../src/views/layout.js";
import { AttestationForm, ForgottenRunPage, RunPage } from "../src/views/run.js";
import type { Run } from "../src/runs.js";
import {
  ASSET,
  NETWORK,
  REGISTRY,
  assetRecord,
  assetView,
  diagnosis,
  historyView,
  dashboard,
  request,
  framed,
  sources,
} from "./support.js";

/** One verdict of each kind, so every branch of the verdict page renders. */
const VERDICTS: readonly Verdict[] = [
  {
    kind: "included",
    id: 0x2an,
    asset: ASSET,
    registry: REGISTRY,
    leafIndex: 5,
    balance: 100n,
    snapshotLedger: 5_000,
    attestedLedger: 5_100,
    totalLiabilities: 1_000n,
    reserveSum: 1_500n,
    currentLedger: 5_200,
    solvencyLapsed: false,
  },
  { kind: "unsupported-format", reason: "the package names another format" },
  { kind: "malformed", reason: "the package carries no salt" },
  {
    kind: "untrusted-deployment",
    reason: "this verifier trusts no such registry",
    network: NETWORK,
    registry: REGISTRY,
  },
  { kind: "invalid-deployments", reason: "the file names one pair twice" },
  { kind: "no-matching-attestation", reason: "the registry attests another snapshot" },
  { kind: "root-mismatch", recomputed: 0x11n, attested: 0x22n },
];

/** One run in each stage. */
function runs(): readonly Run[] {
  const base = {
    id: "0a1b2c3d-0000-4000-8000-000000000000",
    asset: ASSET,
    snapshotLedger: 5_000,
    steps: ["checking the prover against the pins", "proving the aggregation"],
    proof: undefined,
    submission: undefined,
    window: undefined,
    packages: undefined,
    failure: undefined,
  };
  const proof = {
    proofBytes: 14_592,
    finalRoot: 0x2ban,
    totalLiabilities: 1_000n,
    contextHash: 0x3can,
  };
  return [
    { ...base, action: "prove", stage: "running" },
    { ...base, action: "attest", stage: "running" },
    { ...base, action: "prove", stage: "finished", proof, window: { currentLedger: 5_150, stillOpen: true } },
    { ...base, action: "prove", stage: "finished", proof, window: { currentLedger: 9_999, stillOpen: false } },
    { ...base, action: "attest", stage: "failed", proof, failure: "the snapshot left the window" },
    {
      ...base,
      action: "attest",
      stage: "finished",
      proof,
      submission: { ledger: 5_150, transactionHash: "b".repeat(64), registry: REGISTRY },
    },
    { ...base, action: "attest", stage: "failed", failure: "the prover does not match the pins" },
  ];
}

/** Every page of the dashboard, in every state it renders. */
function everyPage(): readonly { name: string; markup: string }[] {
  const pages: { name: string; markup: string }[] = [
    { name: "home", markup: framed(<Home />) },
    {
      name: "home with a reason",
      markup: framed(<Home reason="give an address" />),
    },
    {
      name: "asset with an attestation and a history",
      markup: framed(<AssetPage view={assetView({ observedSum: 9n })} history={historyView()} />),
    },
    {
      name: "asset without an attestation",
      markup: framed(
        <AssetPage
          view={assetView({ record: assetRecord({ attestation: undefined }), observedSum: 9n })}
          history={undefined}
        />,
      ),
    },
    {
      name: "asset whose observation failed",
      markup: framed(
        <AssetPage
          view={assetView({ observationFailure: "one balance read failed", diagnosis: diagnosis() })}
          history={historyView({ entries: [], reachesTheRetentionLimit: false })}
        />,
      ),
    },
    {
      name: "an asset with no record",
      markup: framed(<UnregisteredAssetPage asset={ASSET} asked={[REGISTRY]} />),
    },
    { name: "the inclusion form", markup: framed(<InclusionForm />) },
    {
      name: "the inclusion form with a reason",
      markup: framed(<InclusionForm reason="give a path" />),
    },
    { name: "the attestation form", markup: framed(<AttestationForm open={undefined} />) },
    {
      name: "the attestation form with an open run",
      markup: framed(<AttestationForm open={runs()[0]} reason="a run is open" />),
    },
    { name: "a forgotten run", markup: framed(<ForgottenRunPage />) },
    {
      name: "a failure",
      markup: framed(<Failure title="cannot read" reason="the endpoint refused" />),
    },
  ];
  for (const verdict of VERDICTS) {
    pages.push({
      name: `the verdict ${verdict.kind}`,
      markup: framed(<InclusionVerdictPage verdict={verdict} />),
    });
  }
  for (const run of runs()) {
    pages.push({
      name: `a ${run.action} run that is ${run.stage}`,
      markup: framed(<RunPage run={run} joined={false} />),
    });
    pages.push({
      name: `a joined ${run.action} run that is ${run.stage}`,
      markup: framed(<RunPage run={run} joined={true} />),
    });
  }
  return pages;
}

/** Every value of an attribute that names something to load or to submit to. */
function addresses(markup: string): string[] {
  return [...markup.matchAll(/(?:href|src|action|formaction)="([^"]*)"/gi)].map(
    (found) => found[1] ?? "",
  );
}

describe("every page", () => {
  // A sweep that reached no page, or a scan that found no address, would pass
  // every test below without checking anything. The counts are part of the
  // check.
  it("covers every page and finds the addresses in them", () => {
    const pages = everyPage();
    expect(pages.length).toBeGreaterThanOrEqual(24);
    const found = pages.flatMap((page) => addresses(page.markup));
    expect(found.length).toBeGreaterThanOrEqual(pages.length * 3);
  });

  it("names no remote host", () => {
    for (const page of everyPage()) {
      expect(page.markup, page.name).not.toMatch(/https?:\/\//i);
      expect(page.markup, page.name).not.toMatch(/="\/\//);
    }
  });

  it("names only paths of this process", () => {
    const known = new Set<string>(Object.values(ROUTES));
    for (const page of everyPage()) {
      for (const address of addresses(page.markup)) {
        expect(address, `${page.name}: ${address}`).toMatch(/^\//);
        const path = address.split("?")[0] ?? "";
        const isRunPage = path.startsWith(`${ROUTES.run}/`);
        expect(known.has(path) || isRunPage, `${page.name}: ${address}`).toBe(true);
      }
    }
  });

  it("carries no script and no handler that runs on an event", () => {
    for (const page of everyPage()) {
      expect(page.markup, page.name).not.toMatch(/<script/i);
      expect(page.markup, page.name).not.toMatch(/\son[a-z]+="/i);
      expect(page.markup, page.name).not.toMatch(/javascript:/i);
    }
  });

  it("loads one resource, which is the stylesheet of this process", () => {
    for (const page of everyPage()) {
      const links = [...page.markup.matchAll(/<link[^>]*>/gi)].map((found) => found[0]);
      expect(links.length, page.name).toBe(1);
      // The address carries the version of the stylesheet text, so the match
      // allows a query and still pins the path. A remote address fails, because
      // the path must follow the quote with nothing before it.
      expect(links[0], page.name).toMatch(new RegExp(`href="${ROUTES.style}(\\?[^"]*)?"`));
      expect(page.markup, page.name).not.toMatch(/<img|<iframe|<object|<embed|<video|<audio/i);
    }
  });

  it("submits a form only to a path of this process", () => {
    for (const page of everyPage()) {
      for (const form of [...page.markup.matchAll(/<form[^>]*>/gi)].map((found) => found[0])) {
        expect(form, page.name).toMatch(/action="\/[^"]*"/);
      }
    }
  });
});

describe("the stylesheet", () => {
  it("loads nothing of its own", () => {
    expect(STYLESHEET).not.toMatch(/url\(/i);
    expect(STYLESHEET).not.toMatch(/@import/i);
    expect(STYLESHEET).not.toMatch(/https?:/i);
  });
});

describe("the policy that every answer carries", () => {
  it("refuses every fetch that a page could start", () => {
    // `default-src` is the fallback of the fetch directives, so `'none'` here
    // covers a script, an image, a font, a frame, and a connection at once.
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
    // The one resource a page loads comes from this process and from nowhere
    // else, and no directive names a host.
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:/i);
    expect(CONTENT_SECURITY_POLICY).not.toContain("*");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
  });

  it("rides on every answer, whatever the answer is", () => {
    for (const status of [200, 400, 403, 404, 421, 502]) {
      const headers = responseHeaders({ status, contentType: "text/html", body: "" });
      expect(headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
      expect(headers["referrer-policy"]).toBe("no-referrer");
    }
  });
});

describe("the listener", () => {
  const files = sources();

  it("has a source to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("binds a loopback address", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
    expect(LOOPBACK_AUTHORITIES).toContain(LOOPBACK_HOST);
  });

  it("opens exactly one listener, at the constant host", () => {
    const text = files.map((path) => readFileSync(path, "utf8")).join("\n");
    expect([...text.matchAll(/createServer\(/g)]).toHaveLength(1);
    const listens = [...text.matchAll(/\.listen\([^)]*/g)].map((found) => found[0]);
    expect(listens).toHaveLength(1);
    expect(listens[0]).toContain("host: LOOPBACK_HOST");
  });

  it("reads no setting that could name a host", () => {
    // A setting for the host is the one mistake that would put raw values on a
    // network. The scan refuses a name that suggests one, so a later addition
    // of such a setting fails here.
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const found of text.matchAll(/ZKPOR_[A-Z_]+/g)) {
        expect(found[0], path).not.toMatch(/HOST|BIND|ADDRESS|INTERFACE|ORIGIN|UPLOAD|ENDPOINT/);
      }
    }
  });
});


/**
 * What the process reaches, rather than what its pages name.
 *
 * Everything above reads markup. Markup is the right instrument for the
 * addresses a page gives a browser, and it is the wrong one for the process:
 * a line added inside a route opens a connection without changing a page, so
 * every assertion above stays green while the property is gone.
 *
 * This drives the routes with a recorder installed and reads the destinations
 * the process actually opened. One destination is allowed, the endpoint the
 * configuration names, because reading the registry is the one connection this
 * process is meant to make.
 */
describe("what the process reaches while it answers", () => {
  /** The endpoint of the test configuration, as a recorder spells a destination. */
  const ENDPOINT = "127.0.0.1:1";

  /** A request for every route a browser of this dashboard can reach. */
  function everyRequest(): DashboardRequest[] {
    return [
      request({ target: ROUTES.home }),
      request({ target: `${ROUTES.asset}?asset=${ASSET}` }),
      request({ target: ROUTES.inclusion }),
      request({ target: ROUTES.attestation }),
      request({ target: ROUTES.style }),
      request({ target: `${ROUTES.run}/0a1b2c3d-0000-4000-8000-000000000000` }),
      request({
        method: "POST",
        target: ROUTES.inclusion,
        body: new URLSearchParams({ "package-path": "/no/such/package.zkpor.json" }).toString(),
      }),
      request({
        method: "POST",
        target: ROUTES.run,
        body: new URLSearchParams({
          "context-path": "/no/such/context.toml",
          "customers-path": "/no/such/customers.csv",
          action: "prove",
        }).toString(),
      }),
    ];
  }

  it("records a connection through every way of opening one", async () => {
    // The check below is worth nothing if the recorder cannot see a call. Every
    // way a destination is reached here is exercised, because a recorder that
    // held two of the three would report a clean run for a call made the third
    // way.
    const egress = recordEgress();
    try {
      await fetch("http://example.invalid/somewhere").catch(() => undefined);
      new Socket().connect(9999, "example.invalid").on("error", () => {});
      createSocket("udp4").send("nothing", 9998, "example.invalid");
    } finally {
      egress.restore();
    }
    expect(egress.destinations).toContain("example.invalid:80");
    expect(egress.destinations).toContain("example.invalid:9999");
    expect(egress.destinations).toContain("example.invalid:9998");
  });

  it("records a started program, so the check below is not vacuous", async () => {
    programs.started.length = 0;
    const { spawn } = await import("node:child_process");
    expect(() => spawn("curl", ["http://example.invalid/"])).toThrow();
    expect(programs.started).toContain("curl");
  });

  it("records a started thread, so the check below is not vacuous", async () => {
    programs.started.length = 0;
    const { Worker } = await import("node:worker_threads");
    expect(() => new Worker("/no/such/worker.js")).toThrow();
    expect(programs.started.join(" ")).toContain("a thread running");
  });

  it("starts no program while it answers, on every route", async () => {
    // A connection this process opens is recorded elsewhere. A program it
    // starts opens connections that no recorder here can see, so the property
    // is that answering a request starts none at all. The proving run starts
    // programs, and it does so through the client library and never while a
    // route is answered, which is what makes the empty list the right claim.
    programs.started.length = 0;
    let answered = 0;
    for (const each of everyRequest()) {
      await route(each, dashboard({ deploymentsText: "[]" }));
      answered += 1;
    }
    expect(answered).toBeGreaterThanOrEqual(8);
    expect(programs.started, "answering a request started a program or a thread").toEqual([]);
  });

  it("reaches the configured endpoint and nothing else, on every route", async () => {
    const egress = recordEgress();
    let answered = 0;
    try {
      for (const each of everyRequest()) {
        await route(each, dashboard({ deploymentsText: "[]" }));
        answered += 1;
      }
    } finally {
      egress.restore();
    }
    // A loop that answered nothing would pass the assertion below without
    // driving a single route.
    expect(answered).toBeGreaterThanOrEqual(8);
    for (const destination of egress.destinations) {
      expect(destination, `a route reached ${destination}`).toBe(ENDPOINT);
    }
  });
});


/**
 * Which question the guard on programs answers.
 *
 * "This process starts no program" and "this process starts no unexpected
 * program" are different guarantees, and only one of them can be true of a
 * system whose main mechanism is starting programs. They are answered in
 * different places, because the two packages are in different positions.
 *
 * The client library starts programs; that is a proving run. Its guard is that
 * only the tool runner and the version check may start one, and it drives a
 * whole run with the module that starts a program replaced, so it reads the
 * list of programs that the run actually started.
 *
 * This package starts none. Every program of a run is started by the client
 * library, through the one runner that records it so a stop can reach it. So
 * the question here is the strict one, and it is answered twice: once by
 * driving the routes with the ways of starting a program replaced, and once by
 * reading this package for any mention of them. The second catches a program
 * on a path the eight requests do not reach.
 */
describe("this package starts nothing of its own", () => {
  /** The ways a program or a thread is started, matched as calls. */
  const STARTS: readonly { name: string; call: RegExp }[] = [
    { name: "spawn", call: /(?<![.\w])spawn\s*\(/ },
    { name: "spawnSync", call: /(?<![.\w])spawnSync\s*\(/ },
    { name: "exec", call: /(?<![.\w])exec\s*\(/ },
    { name: "execSync", call: /(?<![.\w])execSync\s*\(/ },
    { name: "execFile", call: /(?<![.\w])execFile\s*\(/ },
    { name: "execFileSync", call: /(?<![.\w])execFileSync\s*\(/ },
    { name: "fork", call: /(?<![.\w])fork\s*\(/ },
    { name: "new Worker", call: /new\s+Worker\s*\(/ },
  ];

  it("reaches every source of this package, or it checks nothing", () => {
    expect(sources().length).toBeGreaterThanOrEqual(8);
  });

  it("names no way of starting a program or a thread", () => {
    for (const path of sources()) {
      const source = readFileSync(path, "utf8");
      for (const way of STARTS) {
        expect(source, `${path} starts something with ${way.name}`).not.toMatch(way.call);
      }
      expect(source, `${path} reaches for the module that starts a program`).not.toContain(
        '"node:child_process"',
      );
      expect(source, `${path} reaches for the module that starts a thread`).not.toContain(
        '"node:worker_threads"',
      );
    }
  });
});
