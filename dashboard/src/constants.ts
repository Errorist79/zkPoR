/**
 * The fixed values of the dashboard.
 *
 * Two of them carry a property that the rest of this package depends on. The
 * host is a constant and not a setting, so no configuration can move the
 * listener off the loopback address. The content security policy forbids every
 * outbound request that a page can make, so no markup can reach a remote host
 * even if a later change adds one.
 */

/**
 * The address that the listener binds.
 *
 * The value is a constant and no environment variable overrides it. A setting
 * for the host is the one mistake that would expose raw balances to a network,
 * so the setting does not exist.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * The authorities that a request may name. A request with another one stops.
 *
 * The listener binds one IPv4 address, so a connection never arrives over IPv6
 * and no request can carry the IPv6 loopback name. The list holds what this
 * listener can actually receive: its own address, and the name that a browser
 * resolves to it.
 */
export const LOOPBACK_AUTHORITIES = [LOOPBACK_HOST, "localhost"] as const;

/** The port that the listener takes when the environment names none. */
export const DEFAULT_PORT = 7878;

/** The environment variable that names the port. */
export const PORT_ENV = "ZKPOR_DASHBOARD_PORT";

/**
 * The policy that every response carries.
 *
 * `default-src 'none'` refuses every fetch that the page can start, which
 * covers a script, an image, a font, a frame, and a connection. The stylesheet
 * is the one resource the page loads, and `'self'` limits it to this process.
 * `form-action 'self'` keeps a form on this process, and `base-uri 'none'`
 * stops a base element from moving a relative path to another host.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The paths that the dashboard answers. */
export const ROUTES = {
  home: "/",
  asset: "/asset",
  inclusion: "/inclusion",
  attestation: "/attestation",
  run: "/run",
  style: "/style.css",
} as const;

/** The query parameter that names the asset on the asset page. */
export const ASSET_PARAMETER = "asset";

/**
 * The query parameter that marks a run page a submission joined.
 *
 * The page says that the submission started nothing, so the marker travels in
 * the address and survives a reload of it.
 */
export const JOINED_PARAMETER = "joined";

/** The value of that parameter, which is the only value it takes. */
export const JOINED_VALUE = "1";

/** The form field that names the path of an inclusion package. */
export const PACKAGE_PATH_FIELD = "package-path";

/** The form fields of an attestation run. */
export const RUN_FIELDS = {
  contextPath: "context-path",
  customersPath: "customers-path",
  action: "action",
} as const;

/**
 * The seconds between two readings of an open run.
 *
 * The page refreshes itself with a pragma directive, so the browser runs no
 * script of ours and the policy keeps every script blocked. A refresh is a
 * navigation, and the fetch directives of the policy do not govern one.
 */
export const RUN_REFRESH_SECONDS = 3;

/**
 * The runs that one process remembers.
 *
 * A run takes minutes, so this count covers a long day of work. The record of
 * an accepted attestation is the registry, and not this list, so a dropped run
 * loses no evidence.
 */
export const MAX_REMEMBERED_RUNS = 20;

/** The largest request body that the dashboard reads, in bytes. */
export const MAX_BODY_BYTES = 8 * 1024;

/**
 * The identifier of each section that a page renders.
 *
 * A test names a section through this record rather than through a copy of the
 * text, so a rule about where a value may appear stays a rule about the markup
 * and not about a phrase that a later edit changes.
 */
export const SECTION_IDS = {
  headline: "solvency-headline",
  attestedReserves: "attested-reserves",
  observedReserves: "observed-reserves",
  registration: "registration",
  history: "attestation-history",
  verdict: "inclusion-verdict",
  run: "attestation-run",
} as const;
