/**
 * The answer to one request.
 *
 * The function here takes a decoded request and returns bytes. It touches no
 * socket, so a test drives every page without a listener. Two guards run before
 * any route: the request must name a loopback authority, and a form submission
 * must come from this process. The first stops a remote name that resolves to
 * this machine, and the second stops a page on another site from submitting a
 * form here.
 *
 * A submission that starts work answers with a redirect to the resource it
 * created. The reader then holds an address that it can reload, and a reload
 * repeats a read rather than the work.
 */

import { readFile } from "node:fs/promises";
import { InfrastructureError, isAcceptedAddress, verifyInclusion } from "@zkpor/sdk";
import type { Environment } from "@zkpor/sdk";
import {
  ASSET_PARAMETER,
  CONTENT_SECURITY_POLICY,
  JOINED_PARAMETER,
  JOINED_VALUE,
  LOOPBACK_AUTHORITIES,
  PACKAGE_PATH_FIELD,
  ROUTES,
  RUN_FIELDS,
} from "./constants.js";
import type { Reader } from "./chain.js";
import { readAssetView, readHistoryView } from "./chain.js";
import { submitRun } from "./attestation.js";
import type { RunAction, RunStore } from "./runs.js";
import { renderPage } from "./render.js";
import type { Frame } from "./render.js";
import { STYLESHEET } from "./style.js";
import { registryAnswered } from "@zkpor/sdk";
import { AssetPage, Home, UnregisteredAssetPage } from "./views/asset.js";
import { InclusionForm, InclusionVerdictPage } from "./views/inclusion.js";
import { Failure } from "./views/layout.js";
import { AttestationForm, ForgottenRunPage, RunPage, runPath } from "./views/run.js";

/** Everything one dashboard process holds. */
export interface Dashboard {
  readonly reader: Reader;
  readonly store: RunStore;
  /** The environment that carries the keys. No route reads a key out of it. */
  readonly environment: Environment;
  /** The directory that holds the circuits and the generator. */
  readonly repository: string;
}

/** One request, with the parts that a route reads. */
export interface DashboardRequest {
  readonly method: string;
  /** The request target, as the first line of the request carries it. */
  readonly target: string;
  /** The authority of the `Host` header, or nothing when the request carries none. */
  readonly host: string | undefined;
  /** The value of `Sec-Fetch-Site`, which a browser sends and another client does not. */
  readonly fetchSite: string | undefined;
  /** The body, already decoded as text. */
  readonly body: string;
}

/** One answer. */
export interface DashboardResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** The address of a redirect, which is always a path of this process. */
  readonly location?: string;
}

/**
 * What the frame of a page states, for one request.
 *
 * The navigation entry is the one the reader is inside, which is not always the
 * path they are on: an asset page and a run page each sit under an entry of
 * their own.
 */
function frameOf(dashboard: Dashboard, current: string): Frame {
  return {
    network: dashboard.reader.config.network,
    current,
  };
}

/** The headers that one answer carries. */
export function responseHeaders(response: DashboardResponse): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": response.contentType,
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
  if (response.location !== undefined) {
    headers["location"] = response.location;
  }
  return headers;
}

const HTML = "text/html; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

function html(status: number, body: string): DashboardResponse {
  return { status, contentType: HTML, body };
}

/**
 * A redirect after a submission.
 *
 * The status makes the browser read the new address with a GET, so a reload of
 * the result never repeats the submission.
 */
function seeOther(location: string): DashboardResponse {
  return { status: 303, contentType: TEXT, body: `${location}\n`, location };
}

/**
 * True when the authority names this machine.
 *
 * A remote name can resolve to the loopback address, and a page served under
 * that name would then be same-origin with this process. The check compares the
 * authority against the loopback names, so such a request stops here.
 */
export function isLoopbackAuthority(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  const withoutPort = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  return LOOPBACK_AUTHORITIES.some((name) => name === withoutPort);
}

/**
 * True when a form submission may proceed.
 *
 * A browser states where a request came from, and a submission of a page of
 * this process says `same-origin`. Every other value stops, and so does a
 * request that says nothing.
 *
 * The guard fails closed. An earlier version passed a request that carried no
 * such header, on the reasoning that no page drives such a client. That reads
 * as a statement about clients, and it is an assumption rather than something
 * this process can check: what arrives is a request, not a client. Behind this
 * guard sit a read of a file on this machine and the start of a real
 * attestation on a real network, so the safe direction is to refuse.
 *
 * The cost is that a client which sends no such header cannot submit a form
 * here. That client uses the `zkpor` command line, which covers every operation
 * of this page and is the supported way to script one.
 *
 * A token in the form would add nothing on top. A page on another site cannot
 * set this header, so a request that carries `same-origin` already came from a
 * page of this process.
 */
export function isOwnSubmission(fetchSite: string | undefined): boolean {
  return fetchSite === "same-origin";
}

/** The path and the query of a request target. */
function split(target: string): { path: string; query: URLSearchParams } {
  const cut = target.indexOf("?");
  if (cut < 0) {
    return { path: target, query: new URLSearchParams() };
  }
  return { path: target.slice(0, cut), query: new URLSearchParams(target.slice(cut + 1)) };
}

/** The identity in a run address, when the path names one. */
function runIdOf(path: string): string | undefined {
  const prefix = `${ROUTES.run}/`;
  if (!path.startsWith(prefix)) {
    return undefined;
  }
  const id = path.slice(prefix.length);
  return id.length === 0 || id.includes("/") ? undefined : id;
}

/** The answer to one request. */
export async function route(
  request: DashboardRequest,
  dashboard: Dashboard,
): Promise<DashboardResponse> {
  if (!isLoopbackAuthority(request.host)) {
    return {
      status: 421,
      contentType: TEXT,
      body: "This dashboard answers the loopback address only.\n",
    };
  }
  const { path, query } = split(request.target);

  if (request.method === "GET") {
    if (path === ROUTES.style) {
      return { status: 200, contentType: CSS, body: STYLESHEET };
    }
    if (path === ROUTES.home) {
      return html(
        200,
        renderPage(<Home />, frameOf(dashboard, ROUTES.home)),
      );
    }
    if (path === ROUTES.asset) {
      return await assetPage(query.get(ASSET_PARAMETER), dashboard);
    }
    if (path === ROUTES.inclusion) {
      return html(200, renderPage(<InclusionForm />, frameOf(dashboard, ROUTES.inclusion)));
    }
    if (path === ROUTES.attestation) {
      return html(
        200,
        renderPage(
          <AttestationForm open={dashboard.store.open()} />,
          frameOf(dashboard, ROUTES.attestation),
        ),
      );
    }
    const id = runIdOf(path);
    if (id !== undefined) {
      const run = dashboard.store.get(id);
      if (run === undefined) {
        return html(404, renderPage(<ForgottenRunPage />, frameOf(dashboard, ROUTES.attestation)));
      }
      return html(
        200,
        renderPage(
          <RunPage run={run} joined={query.get(JOINED_PARAMETER) === JOINED_VALUE} />,
          frameOf(dashboard, ROUTES.attestation),
        ),
      );
    }
  }

  if (request.method === "POST") {
    if (!isOwnSubmission(request.fetchSite)) {
      return {
        status: 403,
        contentType: TEXT,
        body: "This dashboard accepts a form only from its own pages.\n",
      };
    }
    const fields = new URLSearchParams(request.body);
    if (path === ROUTES.inclusion) {
      return await inclusionVerdict(fields.get(PACKAGE_PATH_FIELD), dashboard);
    }
    if (path === ROUTES.run) {
      return await startRun(fields, dashboard);
    }
  }

  // A page, and not bare text. An unknown run already answers with one, and a
  // reader who mistypes an address should not meet a different kind of answer
  // from a reader who mistypes a path.
  return html(
    404,
    renderPage(
      <Failure
        title="This dashboard serves no such page"
        reason={`There is no page at ${path}.`}
      />,
      frameOf(dashboard, ROUTES.home),
    ),
  );
}

async function assetPage(asset: string | null, dashboard: Dashboard): Promise<DashboardResponse> {
  const { reader } = dashboard;
  const chooseAgain = (reason: string): DashboardResponse =>
    html(
      400,
      renderPage(<Home reason={reason} />, frameOf(dashboard, ROUTES.home)),
    );
  if (asset === null || asset.trim().length === 0) {
    return chooseAgain("Give the address of a registered asset.");
  }
  const address = asset.trim();
  if (!isAcceptedAddress(address)) {
    return chooseAgain(`${address} is not a Stellar account address and not a contract address.`);
  }
  let read;
  try {
    read = await readAssetView(reader, address);
  } catch (cause) {
    return failure("The dashboard cannot read the asset", cause, frameOf(dashboard, ROUTES.home));
  }
  const view = read.view;
  if (view === undefined) {
    // The list comes from the walk that just ran, and not from a second reading
    // of the file. The two agree only while the walk always finishes, and a page
    // that named registries it had not asked would be stating somebody's guess.
    return html(
      404,
      renderPage(
        <UnregisteredAssetPage asset={address} asked={read.asked} />,
        frameOf(dashboard, ROUTES.home),
      ),
    );
  }
  // The history is a second read and it can fail on its own. A page without it
  // still carries the attestation that the entry holds, so a failure of the
  // history must not take the solvency result away from the reader.
  let history;
  try {
    history = await readHistoryView(reader, address);
  } catch {
    history = undefined;
  }
  return html(
    200,
    renderPage(<AssetPage view={view} history={history} />, frameOf(dashboard, ROUTES.home)),
  );
}

async function inclusionVerdict(
  path: string | null,
  dashboard: Dashboard,
): Promise<DashboardResponse> {
  if (path === null || path.trim().length === 0) {
    return html(
      400,
      renderPage(
        <InclusionForm reason="Give the path of your package file." />,
        frameOf(dashboard, ROUTES.inclusion),
      ),
    );
  }
  const chosen = path.trim();
  let packageText;
  try {
    packageText = await readFile(chosen, "utf8");
  } catch {
    return html(
      400,
      renderPage(
        <InclusionForm reason={`This machine holds no readable file at ${chosen}.`} />,
        frameOf(dashboard, ROUTES.inclusion),
      ),
    );
  }
  const { reader } = dashboard;
  try {
    const verdict = await verifyInclusion({
      packageText,
      deploymentsText: reader.deploymentsText,
      server: reader.server,
      config: reader.config,
      readOptions: reader.readOptions,
    });
    return html(
      200,
      renderPage(<InclusionVerdictPage verdict={verdict} />, frameOf(dashboard, ROUTES.inclusion)),
    );
  } catch (cause) {
    return failure(
      "The dashboard cannot complete the check",
      cause,
      frameOf(dashboard, ROUTES.inclusion),
    );
  }
}

/** The action of a submission. An unknown value is a refusal, never a guess. */
function actionOf(value: string | null): RunAction | undefined {
  if (value === "prove" || value === "attest") {
    return value;
  }
  return undefined;
}

async function startRun(
  fields: URLSearchParams,
  dashboard: Dashboard,
): Promise<DashboardResponse> {
  const refuse = (reason: string): DashboardResponse =>
    html(
      400,
      renderPage(
        <AttestationForm open={dashboard.store.open()} reason={reason} />,
        frameOf(dashboard, ROUTES.attestation),
      ),
    );

  const contextPath = fields.get(RUN_FIELDS.contextPath)?.trim() ?? "";
  const customersPath = fields.get(RUN_FIELDS.customersPath)?.trim() ?? "";
  const action = actionOf(fields.get(RUN_FIELDS.action));
  if (contextPath.length === 0 || customersPath.length === 0) {
    return refuse("Give the path of the context file and the path of the balance file.");
  }
  if (action === undefined) {
    return refuse("Choose whether this run proves only or proves and attests.");
  }

  let result;
  try {
    result = await submitRun({
      store: dashboard.store,
      reader: dashboard.reader,
      environment: dashboard.environment,
      repository: dashboard.repository,
      submission: { action, contextPath, customersPath },
    });
  } catch (cause) {
    // A failure of the endpoint is not a refusal of the submission, so it does
    // not come back as one. Every other failure here names something the
    // issuer can correct on the form: the kit refuses a toolchain drift, a
    // secret whose salts anybody can recompute, and a snapshot that can no
    // longer land, and this package refuses a missing key.
    if (cause instanceof InfrastructureError) {
      return failure(
        "The dashboard cannot start the run",
        cause,
        frameOf(dashboard, ROUTES.attestation),
      );
    }
    return refuse(cause instanceof Error ? cause.message : "The dashboard cannot start the run.");
  }
  // A submission that joined an open run says so on the run page, so the reader
  // learns that this submission started nothing.
  return seeOther(result.started ? runPath(result.run.id) : `${runPath(result.run.id)}?${JOINED_PARAMETER}=${JOINED_VALUE}`);
}

/**
 * The page of a failure that gives no result.
 *
 * An infrastructure failure is not a verdict, so it never arrives as one. A
 * failure of another kind carries no message that a reader can act on, so the
 * page states the kind and nothing more.
 */
function failure(title: string, cause: unknown, frame: Frame): DashboardResponse {
  const reason =
    cause instanceof Error ? cause.message : "the client failed for a reason it cannot describe";
  return html(
    502,
    renderPage(<Failure title={title} reason={reason} answered={registryAnswered(cause)} />, frame),
  );
}
