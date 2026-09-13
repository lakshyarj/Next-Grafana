/**
 * Grafana reverse proxy — app/api/grafana/[...path]/route.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The browser must never hold a Grafana credential. Every request from an
 * embedded dashboard hits this same-origin route, which attaches the service
 * account token server-side and streams Grafana's reply back. The token is
 * therefore absent from the client bundle, from DevTools, and from any URL.
 *
 * WHY IT IS NOT next-grafana-auth's handleGrafanaProxy
 * ---------------------------------------------------
 * That helper authenticates with Grafana's *auth.proxy* mode, which sends
 * X-WEBAUTH-USER / X-WEBAUTH-ROLE identity headers derived from a per-user
 * server session, and it deliberately strips `Authorization` and `Cookie`
 * before forwarding. It has no token parameter, so it cannot carry a service
 * account token. This app needs a shared Viewer identity instead, so the proxy
 * is implemented here. The header allowlists below are modelled on that
 * library's, which is a sound baseline.
 *
 * WHAT IT DELIBERATELY DOES NOT FORWARD
 * -------------------------------------
 * Inbound: `authorization`, `cookie`, `host`, and anything hop-by-hop — so a
 * caller cannot smuggle their own credential or poison the upstream Host.
 * Outbound: `x-frame-options` and CSP `frame-ancestors` — stripped so the
 * dashboard can render inside our iframe. See README "Embedding headers".
 */

import type { NextRequest } from 'next/server';
import {
  buildUpstreamUrl,
  getGrafanaConfig,
  GrafanaConfigError,
  sanitiseSearch,
  type GrafanaServerConfig,
} from '@/lib/grafana';

/** Node runtime: `fetch` with streaming/AbortController behaves predictably here. */
export const runtime = 'nodejs';

/** Never statically optimise or cache a credentialed route at build time. */
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Header policy
// ---------------------------------------------------------------------------

/**
 * Inbound request headers forwarded upstream. An allowlist rather than a
 * denylist: anything not named here is dropped, so a new browser header can
 * never accidentally leak a credential.
 */
const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'pragma',
  'range',
]);

/** Headers that must never travel upstream, even if an allowlist entry matches. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

/**
 * Upstream response headers re-emitted to the browser. Anything absent is
 * dropped — notably `set-cookie`, which stops Grafana from setting a session
 * cookie in the browser, and `content-encoding`, which must not survive
 * because `fetch` has already transparently decompressed the body. Re-emitting
 * it would make the browser try to gunzip plain bytes.
 */
const SAFE_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-disposition',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'vary',
]);

/** Framing headers removed from every response so the iframe is allowed to render. */
const FRAMING_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
];

/** Methods proxied through to Grafana. */
const PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type ProxyMethod = (typeof PROXY_METHODS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON error that never echoes configuration values. */
function errorResponse(status: number, error: string, detail?: string): Response {
  return Response.json(
    { error, ...(detail ? { detail } : {}) },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Translate a Grafana `Location` header into an equivalent path on this app.
 *
 * Without this, Grafana's redirects would point the browser straight at the
 * Grafana origin — bypassing the proxy, and landing on a login page. Handles
 * both topologies: Grafana may emit the sub-path already (`/api/grafana/...`)
 * or a root-relative path that still needs our prefix.
 */
function rewriteLocation(location: string, config: GrafanaServerConfig): string {
  let parsed: URL;
  try {
    parsed = new URL(location, 'http://proxy.invalid');
  } catch {
    return location;
  }

  // Relative redirects need no rewriting.
  if (!location.startsWith('/') && !location.includes('://')) return location;

  let upstreamBasePath = '';
  try {
    upstreamBasePath = new URL(config.baseUrl).pathname.replace(/\/+$/, '');
  } catch {
    upstreamBasePath = '';
  }

  let grafanaPath = parsed.pathname;

  // Grafana already emitted our prefix — leave the path alone.
  if (config.pathPrefix && grafanaPath.startsWith(config.pathPrefix)) {
    return `${grafanaPath}${parsed.search}${parsed.hash}`;
  }

  // Strip the upstream base path (e.g. "/api/grafana") before re-prefixing.
  if (upstreamBasePath && upstreamBasePath !== '' && grafanaPath.startsWith(upstreamBasePath)) {
    grafanaPath = grafanaPath.slice(upstreamBasePath.length);
  }

  const rewritten = `${config.pathPrefix}${grafanaPath.startsWith('/') ? '' : '/'}${grafanaPath}`;
  return `${rewritten}${parsed.search}${parsed.hash}`;
}

/** True when an upstream redirect is really Grafana bouncing us to its login page. */
function isLoginRedirect(location: string | null): boolean {
  if (!location) return false;
  return /\/login(\?|$|#)/.test(location);
}

/** Build the upstream request headers from the inbound request. */
function buildUpstreamHeaders(
  request: NextRequest,
  config: GrafanaServerConfig,
): Headers {
  const headers = new Headers();

  for (const [name, value] of request.headers.entries()) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith('x-webauth-')) continue;
    if (!SAFE_REQUEST_HEADERS.has(lower)) continue;
    headers.set(lower, value);
  }

  // Ask for an uncompressed body. `fetch` transparently decompresses but keeps
  // the upstream `content-encoding`, which would produce a body the browser
  // then fails to decode. Requesting identity sidesteps the mismatch entirely.
  headers.set('accept-encoding', 'identity');

  // The credential. Server-side only, for the lifetime of this call.
  headers.set('authorization', `Bearer ${config.token}`);

  if (config.orgId) {
    headers.set('x-grafana-org-id', config.orgId);
  }

  return headers;
}

/**
 * Retry policy for upstream calls.
 *
 * Only idempotent methods are retried — replaying a POST/PUT/PATCH/DELETE could
 * duplicate a side effect upstream. Embedded dashboards are read-only, so the
 * requests that actually matter here are GETs.
 *
 * A single retry converts an intermittent stall (a dropped connection, a
 * momentary upstream hiccup) into a slightly slower success instead of the 504
 * the user would otherwise see.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_ATTEMPTS = 2;

/**
 * Attempts allowed for a method.
 *
 * Shared between the fetch loop and the timeout error message so the two cannot
 * drift: the message has to state the real attempt count, and the count is
 * decided here.
 */
function maxAttemptsFor(method: ProxyMethod): number {
  return IDEMPOTENT_METHODS.has(method) ? MAX_ATTEMPTS : 1;
}

/**
 * True for paths that execute a datasource query rather than control-plane work.
 *
 * `POST /api/ds/query` is where Grafana runs the panel and template-variable
 * SQL behind every dashboard. Those queries can legitimately run for tens of
 * seconds over a large table, where a 15s `login/ping` would already be a
 * failure. They need a different budget.
 */
function isDatasourceQueryPath(segments: readonly string[]): boolean {
  const path = segments.filter((segment) => segment !== '').join('/');
  return path === 'api/ds/query' || path.startsWith('api/datasources/proxy/');
}

/** Pick the upstream timeout for this request. */
function timeoutForPath(config: GrafanaServerConfig, segments: readonly string[]): number {
  return isDatasourceQueryPath(segments) ? config.queryTimeoutMs : config.requestTimeoutMs;
}

/** True for failures worth retrying: timeouts and transport-level errors. */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // AbortError/TimeoutError: our own deadline elapsed.
  // TypeError: undici's signal for a connection-level failure (DNS, reset, TLS).
  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.name === 'TypeError'
  );
}

/**
 * Fetch upstream, retrying once for idempotent methods.
 *
 * Each attempt gets a fresh AbortController and its own timeout, so a retry is
 * not charged against the first attempt's remaining budget.
 */
async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  method: ProxyMethod,
  timeoutMs: number,
): Promise<Response> {
  const attempts = maxAttemptsFor(method);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) throw error;
      console.warn(
        `[grafana-proxy] ${method} attempt ${attempt}/${attempts} failed ` +
          `(${error instanceof Error ? error.name : 'unknown'}); retrying once.`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Next.js 15 delivers dynamic route params as a Promise. */
type RouteContext = { params: Promise<{ path: string[] }> };

async function proxyRequest(request: NextRequest, context: RouteContext): Promise<Response> {
  let config: GrafanaServerConfig;
  try {
    config = getGrafanaConfig();
  } catch (error) {
    if (error instanceof GrafanaConfigError) {
      // Misconfiguration is an operator problem, not a user problem.
      console.error(`[grafana-proxy] ${error.message}`);
      return errorResponse(500, 'Grafana proxy is not configured.', error.message);
    }
    throw error;
  }

  const { path } = await context.params;

  let upstreamUrl: string;
  try {
    const search = sanitiseSearch(new URL(request.url).searchParams.toString());
    upstreamUrl = buildUpstreamUrl(config, path ?? [], search);
  } catch (error) {
    if (error instanceof GrafanaConfigError) {
      return errorResponse(400, 'Invalid Grafana path.');
    }
    throw error;
  }

  const method = request.method.toUpperCase() as ProxyMethod;
  if (!PROXY_METHODS.includes(method)) {
    return errorResponse(405, `Method ${method} is not supported by this proxy.`);
  }

  // Buffer the body for methods that carry one. Dashboards are read-only, but
  // Grafana's own frontend issues POSTs (e.g. /api/ds/query), so these must pass.
  let body: ArrayBuffer | undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const buffered = await request.arrayBuffer();
    if (buffered.byteLength > 0) body = buffered;
  }

  const startedAt = Date.now();
  const timeoutMs = timeoutForPath(config, path ?? []);

  try {
    const upstream = await fetchWithRetry(
      upstreamUrl,
      {
        method,
        headers: buildUpstreamHeaders(request, config),
        body,
        // Manual so we can inspect and rewrite redirects instead of letting
        // fetch follow them straight to the Grafana origin.
        redirect: 'manual',
        cache: 'no-store',
      },
      method,
      timeoutMs,
    );

    if (config.debug) {
      const elapsed = Date.now() - startedAt;
      // Path and status only — never headers, never the token.
      console.log(
        `[grafana-proxy] ${method} ${new URL(upstreamUrl).pathname} -> ${upstream.status} (${elapsed}ms)`,
      );
    }

    // An expired or under-privileged token. Surface it as an actionable 502
    // rather than letting a login page render silently inside the iframe.
    if (upstream.status === 401 || upstream.status === 403) {
      console.error(
        `[grafana-proxy] Grafana rejected the service account token (${upstream.status}). ` +
          'Check GRAFANA_SERVICE_ACCOUNT_TOKEN is valid, unrevoked, and has the Viewer role.',
      );
      return errorResponse(
        502,
        'Grafana rejected the service account token.',
        `Upstream returned ${upstream.status}. The token may be expired, revoked, or lack permission for this dashboard.`,
      );
    }

    // A redirect toward /login means the request was not authenticated.
    const location = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && isLoginRedirect(location)) {
      console.error(
        '[grafana-proxy] Grafana redirected to its login page — the token was not accepted.',
      );
      return errorResponse(
        502,
        'Grafana redirected to its login page.',
        'The service account token was not accepted. Verify the token and that GRAFANA_URL points at the right instance.',
      );
    }

    // 204/205/304 and HEAD replies must not carry a body.
    const bodyless =
      method === 'HEAD' ||
      upstream.status === 204 ||
      upstream.status === 205 ||
      upstream.status === 304;

    const payload = bodyless ? null : await upstream.arrayBuffer();
    const response = new Response(payload, { status: upstream.status });

    for (const [name, value] of upstream.headers.entries()) {
      if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) {
        response.headers.set(name, value);
      }
    }

    // Explicitly drop framing restrictions, in both topologies. `allow_embedding`
    // on the Grafana side is still recommended; this is defence in depth.
    for (const header of FRAMING_HEADERS) {
      response.headers.delete(header);
    }

    // Keep redirects on this origin so the browser never leaves the proxy.
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      response.headers.set('location', rewriteLocation(location, config));
    }

    if (!response.headers.has('content-type') && payload) {
      response.headers.set('content-type', 'application/octet-stream');
    }

    return response;
  } catch (error) {
    const isAbort =
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

    if (isAbort) {
      const attempts = maxAttemptsFor(method);
      // Report the real attempt count. Earlier wording claimed "(after retry)"
      // and "both attempts" unconditionally, which was false for POST — and
      // POST /api/ds/query is the request that actually times out here. The
      // message described a retry that never happens, which reads as flakiness
      // and sends the reader looking for the wrong cause.
      const attemptDetail =
        attempts > 1 ? `${attempts} attempts` : '1 attempt (POST is not retried)';

      console.error(
        `[grafana-proxy] Upstream timed out after ${timeoutMs}ms over ${attemptDetail}: ` +
          `${method} ${new URL(upstreamUrl).pathname}`,
      );
      return errorResponse(
        504,
        'Grafana did not respond in time.',
        `Upstream exceeded its ${timeoutMs}ms budget over ${attemptDetail}. ` +
          'A slow datasource query is the usual cause — raise GRAFANA_QUERY_TIMEOUT_MS ' +
          '(dashboard queries) or GRAFANA_REQUEST_TIMEOUT_MS (everything else).',
      );
    }

    // Log the cause, return a generic message: upstream errors can embed the URL.
    console.error('[grafana-proxy] Upstream request failed:', error);
    return errorResponse(
      502,
      'Could not reach Grafana.',
      'Check that GRAFANA_URL is reachable from the Next.js server.',
    );
  }
}

// Next.js requires each verb to be exported individually.
export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function HEAD(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function OPTIONS(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}
