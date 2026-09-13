/**
 * Server-only Grafana configuration.
 *
 * SECURITY: this module reads the service account token. It must only ever be
 * imported from server-side code (route handlers, server components). The
 * runtime guard below converts an accidental client import into a loud crash
 * during development rather than a silent token leak into the browser bundle.
 */

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/grafana.ts is server-only and was imported into client-side code. ' +
      'Import it from a route handler or server component instead, and never ' +
      'pass the service account token across the server/client boundary.',
  );
}

/** Shape of the validated server-side configuration. */
export interface GrafanaServerConfig {
  /** Upstream base URL, normalised with no trailing slash. */
  readonly baseUrl: string;
  /** Service account token. Never log, never serialise, never return. */
  readonly token: string;
  /** Optional org id sent as X-Grafana-Org-Id. */
  readonly orgId: string | undefined;
  /** Path prefix this app serves the proxy on, e.g. '/api/grafana'. */
  readonly pathPrefix: string;
  /** Whether to strip pathPrefix before calling Grafana. */
  readonly stripPathPrefix: boolean;
  /** Upstream timeout for control-plane requests, in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Upstream timeout for datasource queries, in milliseconds. */
  readonly queryTimeoutMs: number;
  /** Verbose proxy logging (never includes credentials). */
  readonly debug: boolean;
}

/** Thrown when required configuration is missing or malformed. */
export class GrafanaConfigError extends Error {
  public readonly variable: string;

  constructor(variable: string, detail: string) {
    super(`Invalid Grafana configuration: ${variable} ${detail}`);
    this.name = 'GrafanaConfigError';
    this.variable = variable;
  }
}

const DEFAULT_PATH_PREFIX = '/api/grafana';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Timeout for datasource queries (`/api/ds/query`), which is a different class
 * of request from the rest of the API.
 *
 * A dashboard query can legitimately aggregate over a large ClickHouse table
 * for tens of seconds. Giving it the same 15s budget as a control-plane call
 * means a query that would have finished at 20s is killed and surfaced to the
 * user as a 504 instead of as data.
 */
const DEFAULT_QUERY_TIMEOUT_MS = 60_000;

/** Remove trailing slashes without a regex (avoids pathological backtracking). */
function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** Trim and normalise a leading slash onto a path prefix. */
function normalisePathPrefix(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return DEFAULT_PATH_PREFIX;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return stripTrailingSlash(withLeadingSlash);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalised = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalised)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Validate that a string is a usable http(s) URL. */
function assertHttpUrl(value: string, variable: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GrafanaConfigError(variable, 'is not a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GrafanaConfigError(variable, `must use http or https, got "${parsed.protocol}"`);
  }
}

/**
 * Read and validate the server configuration.
 *
 * Throws {@link GrafanaConfigError} with an actionable message. Callers should
 * turn that into a 500 with the message — the message never contains the token,
 * only the *name* of the offending variable.
 */
export function getGrafanaConfig(): GrafanaServerConfig {
  const rawUrl = process.env.GRAFANA_URL?.trim();
  const rawToken = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN?.trim();

  if (!rawUrl) {
    throw new GrafanaConfigError(
      'GRAFANA_URL',
      'is not set. Add it to .env.local (see .env.local.example).',
    );
  }
  assertHttpUrl(rawUrl, 'GRAFANA_URL');

  if (!rawToken) {
    throw new GrafanaConfigError(
      'GRAFANA_SERVICE_ACCOUNT_TOKEN',
      'is not set. Create a service account token in Grafana and add it to .env.local.',
    );
  }

  const pathPrefix = normalisePathPrefix(
    process.env.GRAFANA_PATH_PREFIX ?? DEFAULT_PATH_PREFIX,
  );

  // `GRAFANA_URL` is documented as a bare origin, but operators routinely paste
  // the full browser URL including the sub-path. Normalise the sub-path away
  // here, once, so both topologies below can compute their target from a bare
  // origin and a doubled prefix becomes impossible rather than merely unlikely.
  let baseUrl = stripTrailingSlash(rawUrl);
  if (pathPrefix !== '/' && baseUrl.endsWith(pathPrefix)) {
    const withoutPrefix = stripTrailingSlash(baseUrl.slice(0, -pathPrefix.length));
    // Refuse to normalise away an origin that would leave nothing behind.
    if (withoutPrefix !== '') baseUrl = withoutPrefix;
  }

  return {
    baseUrl,
    token: rawToken,
    orgId: process.env.GRAFANA_ORG_ID?.trim() || undefined,
    pathPrefix,
    stripPathPrefix: parseBoolean(process.env.GRAFANA_STRIP_PATH_PREFIX, false),
    requestTimeoutMs: parsePositiveInt(
      process.env.GRAFANA_REQUEST_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    queryTimeoutMs: parsePositiveInt(
      process.env.GRAFANA_QUERY_TIMEOUT_MS,
      DEFAULT_QUERY_TIMEOUT_MS,
    ),
    debug: parseBoolean(process.env.GRAFANA_DEBUG, false),
  };
}

/**
 * Build the upstream Grafana URL for a proxied request.
 *
 * @param config   Validated server config.
 * @param segments Catch-all route segments, e.g. ['d','abc123','dashboard'].
 * @param search   Query string from the inbound request, without the '?'.
 */
export function buildUpstreamUrl(
  config: GrafanaServerConfig,
  segments: readonly string[],
  search: string,
): string {
  const cleanSegments = segments
    .filter((segment) => segment !== '')
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''));

  // Reject traversal before it can reach the upstream URL.
  for (const segment of cleanSegments) {
    if (segment === '.' || segment === '..' || segment.includes('..')) {
      throw new GrafanaConfigError('path', `contains an illegal segment "${segment}"`);
    }
  }

  const path = cleanSegments.join('/');

  // Two supported topologies — see .env.local.example and the README.
  // `config.baseUrl` is already normalised to a bare origin, so neither branch
  // has to worry about the operator having pasted the sub-path twice.
  //
  //   stripPathPrefix = false  Grafana serves from the sub-path itself:
  //                            <origin>/api/grafana/public/build/app.js
  //   stripPathPrefix = true   nginx-style: Grafana serves from root and we
  //                            remove our prefix before forwarding:
  //                            <origin>/public/build/app.js
  // Trim the leading slash from the prefix before joining: `pathPrefix` is
  // stored browser-style ("/api/grafana") for use in redirect rewriting, but
  // joining it verbatim would emit "host//api/grafana/...". Grafana tolerates
  // that double slash, which is exactly why it is worth removing here rather
  // than leaving to be discovered by a stricter upstream.
  const prefix = config.pathPrefix.replace(/^\/+|\/+$/g, '');

  const parts = config.stripPathPrefix
    ? [config.baseUrl, path]
    : [config.baseUrl, prefix, path];

  const url = parts.filter((part) => part !== '').join('/');
  return search ? `${url}?${search}` : url;
}

/** Search params that must never be forwarded upstream (credential leakage). */
const DROPPED_SEARCH_PARAMS = new Set(['auth_token', 'authtoken', 'access_token']);

/**
 * Strip credential-bearing query parameters from an inbound query string.
 *
 * If a dashboard URL ever picks up an `auth_token`, forwarding it would write
 * the credential into Grafana's access log — the exact leak this proxy exists
 * to prevent.
 */
export function sanitiseSearch(search: string): string {
  if (!search) return '';
  const params = new URLSearchParams(search);
  let mutated = false;
  for (const key of [...params.keys()]) {
    if (DROPPED_SEARCH_PARAMS.has(key.toLowerCase())) {
      params.delete(key);
      mutated = true;
    }
  }
  return mutated ? params.toString() : search;
}
