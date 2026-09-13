# next-grafana-embed

A Next.js 15 (App Router) + TypeScript application that embeds Grafana dashboards
in its own pages. Every embedded dashboard is served through a same-origin
reverse proxy at `/api/grafana/[...path]`, which attaches a Grafana **service
account token** to each upstream request on the server. The token is therefore
never present in the client bundle, never appears in DevTools, and never appears
in a URL — the browser only ever holds an unauthenticated request to this app's
own origin. The core security property is exactly this: **the browser never
receives a Grafana credential.**

---

## How it works

```
Browser (iframe src="/api/grafana/d/<uid>/<slug>")
   |
   |  GET /api/grafana/...        no credentials of any kind
   v
Next.js server  ──  app/api/grafana/[...path]/route.ts
   |                 adds  Authorization: Bearer <service account token>
   |                 strips inbound Authorization / Cookie / Host
   v
Grafana  ──  http://13.203.193.234:30016   (v12.4.1)
```

1. `<GrafanaDashboard>` (from `next-grafana-auth/component`) renders an `<iframe>`
   whose `src` is `${baseUrl}/d/${uid}/${slug}`. `baseUrl` is set to
   `/api/grafana`, so every asset and data request the dashboard makes is
   same-origin.
2. The catch-all route handler `app/api/grafana/[...path]/route.ts` receives the
   request, builds the upstream URL from `GRAFANA_URL`, and replays the request
   to Grafana with `Authorization: Bearer <token>`.
3. Grafana's reply is streamed back after passing through a response-header
   allowlist. Framing headers (`X-Frame-Options`, CSP) are removed so the
   dashboard can render inside the iframe.

Notes:

- The token is read via `getGrafanaConfig()` in `lib/grafana.ts`. That module
  throws at import time if it is ever loaded in client-side code, so an
  accidental client import fails loudly during development rather than silently
  shipping the token to the browser.
- **No `NEXT_PUBLIC_` variable is used anywhere in this project.** Only variables
  carrying that prefix are exposed to the browser, so nothing under `GRAFANA_*`
  reaches the client. `NEXT_PUBLIC_` must never be added to the token variable.

### Why the proxy is hand-written

The `next-grafana-auth` package is used **only** for its `<GrafanaDashboard>`
iframe component, imported from `next-grafana-auth/component`. The package's
`handleGrafanaProxy()` helper is deliberately **not** used: it authenticates via
Grafana's *auth.proxy* identity headers (`X-WEBAUTH-USER` / `X-WEBAUTH-ROLE`)
derived from a per-user session, and it strips `Authorization` and `Cookie`
before forwarding. It has no token parameter, so it structurally cannot carry a
service account token. This app needs one shared Viewer identity, so the proxy
is implemented in this repository. The header allowlists in the proxy are
modelled on that library's, which is a sound baseline.

---

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | `>= 18.18.0` | Declared in `package.json` `engines`. |
| Grafana | `>= 11.6` | The `next-grafana-auth` peer range. This project targets Grafana **v12.4.1**. |
| Grafana admin access | — | You must be able to edit `grafana.ini` and restart Grafana. |

Also required on the machine running the Next.js server: network reachability to
the Grafana host and port (here `13.203.193.234:30016`).

---

## Step 1 — Create the Grafana service account token

Log in to Grafana as an administrator and follow the exact path (Grafana 12):

1. **Administration → Users and access → Service accounts**
2. **Add service account**
3. Give it a name (for example `next-grafana-embed`) and set the role to
   **Viewer**.
4. Open the new service account and click **Add service account token**.
5. Copy the token immediately — **it is shown once** and cannot be retrieved
   afterwards. Only a hash is stored. If you lose it, add another token or
   delete and recreate it.

Tokens look like `glsa_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX_XXXXXXXX`.

**Use Viewer, not Editor or Admin.** Embedded dashboards are read-only — the
proxy only ever issues read requests for dashboard JSON, static assets, and data
queries. Editor or Admin would grant write access (creating, editing, and
deleting dashboards, and managing data sources) that nothing in this app needs.
If the token ever leaks, its blast radius is limited to reading data the Viewer
role can already see.

Note on anonymous access: anonymous access is **disabled** on the target
instance (the dashboard API returns `401` and pages redirect to `/login`), so a
credential is genuinely required. Do not "fix" the embed by enabling anonymous
access — that would expose every dashboard in the organisation to anyone who can
reach the Grafana port.

---

## Step 2 — Configure `grafana.ini`

This is the step that most often decides whether the embed works at all. Find
the file at `/etc/grafana/grafana.ini` (Debian/Ubuntu package), or wherever your
deployment mounts it (the official Docker image reads
`/etc/grafana/grafana.ini`, usually mounted from the host or set via
`GF_*` environment variables).

### 2a. Allow embedding

```ini
[security]
allow_embedding = true
```

**Why:** without this, Grafana sends `X-Frame-Options: deny` on its responses,
and the browser refuses to render the dashboard inside the iframe — you get a
blank frame and a console error naming `X-Frame-Options`. The target instance
currently has this off, so **this change is mandatory**.

The proxy also deletes `X-Frame-Options` and the CSP framing headers from every
upstream response as defence in depth. That helps, but it is not a substitute:
`allow_embedding = true` is the supported, first-class way to permit framing,
and Grafana's own frontend behaves better with it enabled.

### 2b. The sub-path requirement

Grafana emits **root-absolute asset URLs** — for example `/public/build/*.js`.
A proxy mounted at `/api/grafana` only works if Grafana's `root_url` carries the
same sub-path. If it does not, the browser fetches `/public/build/...` from the
*Next.js* server, gets a 404, and the dashboard renders as a broken shell: the
iframe loads, but the page is unstyled and non-interactive, or entirely blank,
with a column of 404s in the DevTools Network tab.

**This is the most common cause of a blank embed.** If you see 404s for Grafana's
own asset or API paths in DevTools, the fix is here, not in the Next.js code.

> **Verified against this instance.** With `GRAFANA_STRIP_PATH_PREFIX=true`, this
> proxy successfully served both `/api/grafana/api/health` (200) and the OEE
> dashboard's HTML (200, ~80 KB) from Grafana 12.4.1 with no `grafana.ini` change
> at all. What that mode does *not* give you is a guarantee that the dashboard's
> client-side assets resolve — Grafana's own documented configuration for
> sub-path serving is the one below, so prefer it, and treat `strip=true` as the
> quick way to confirm the credential and network path work before touching
> Grafana's config.

The path prefix must stay in sync across three places:

| Place | Value |
| --- | --- |
| The Next.js route folder | `app/api/grafana/[...path]/route.ts` |
| The `baseUrl` passed to `<GrafanaDashboard>` | `/api/grafana` |
| Grafana's `root_url` | `http://13.203.193.234:30016/api/grafana/` |

### Recommended configuration

```ini
[server]
domain = 13.203.193.234:30016
root_url = http://13.203.193.234:30016/api/grafana/
serve_from_sub_path = true
```

Matched in `.env.local` with:

```ini
GRAFANA_STRIP_PATH_PREFIX=false
```

`false` is the default. In this topology Grafana serves its own UI from the
sub-path, so the upstream URL is
`${GRAFANA_URL}${GRAFANA_PATH_PREFIX}${path}` — the proxy does **not** strip the
prefix, because Grafana expects to receive it. Direct access to Grafana's UI
moves from `/` to `/api/grafana/`; `/` no longer serves the dashboard UI.

Because Grafana itself serves at the sub-path, `GRAFANA_URL` must be the origin
reachable *without* the sub-path (for example
`http://13.203.193.234:30016`), so that appending the prefix once produces the
right URL.

### Alternative: nginx-style topology

```ini
[server]
domain = 13.203.193.234:30016
root_url = http://13.203.193.234:30016/api/grafana/
serve_from_sub_path = false
```

Matched in `.env.local` with:

```ini
GRAFANA_STRIP_PATH_PREFIX=true
```

Here Grafana serves from its root and an external reverse proxy is expected to
translate the public sub-path onto it. This proxy does that translation itself:
it removes `GRAFANA_PATH_PREFIX` before calling Grafana, so the upstream URL is
`${GRAFANA_URL}${path}` and `GRAFANA_URL` is again the bare origin
(`http://13.203.193.234:30016`).

> **`GRAFANA_URL` in both topologies.** Give the bare origin in either case. The
> proxy normalises a sub-path away if you paste one — `GRAFANA_URL` ending in
> `/api/grafana` is accepted and reduced to the origin — but the bare origin is
> the documented form and the one to reach for when debugging.

**Trade-off.** With `serve_from_sub_path = true`, Grafana is self-consistent: it
generates, serves, and understands its own sub-path, and there is nothing to
misconfigure. The cost is that direct access to Grafana moves to
`/api/grafana/`. With `serve_from_sub_path = false`, direct access at `/` keeps
working for everyone, but you must set `GRAFANA_STRIP_PATH_PREFIX=true`, and the
two ends of the path translation (Grafana's `root_url` and the proxy's strip
flag) must agree — a mismatch produces exactly the broken-shell symptom
described above.

**Recommendation: use the first topology** (`serve_from_sub_path = true` with the
default `GRAFANA_STRIP_PATH_PREFIX=false`). It keeps the sub-path handling in one
place, inside Grafana, and it is the configuration Grafana's own documentation
assumes. Choose the nginx-style variant only if other users depend on reaching
Grafana at `/`.

### Apply and restart

Grafana must be restarted for any of these changes to take effect. On a package
install that is typically `sudo systemctl restart grafana-server`; on Docker,
restart the container. The exact command depends on your deployment — use
whatever you normally use.

**Changing `root_url` affects every user of that Grafana instance.** It changes
the links Grafana generates in alert notifications, shared dashboard URLs, and
emails. If the instance is shared, check with the other users before applying the
sub-path configuration.

---

## Step 3 — Environment variables

Copy the template and fill it in.

```bash
cp .env.local.example .env.local          # macOS / Linux / Git Bash
```

```powershell
Copy-Item .env.local.example .env.local   # Windows PowerShell
```

`.env.local` is listed in `.gitignore` and **must never be committed**. It holds
a live credential; treat it like an SSH private key.

| Variable | Required? | Default | Purpose |
| --- | --- | --- | --- |
| `GRAFANA_URL` | **Required** | — | Base URL the *Next.js server* uses to reach Grafana. Must match the topology you chose in Step 2. Never sent to the browser. |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | **Required** | — | The Viewer-role service account token from Step 1. Sent upstream as `Authorization: Bearer <token>`. Never log, never serialise, never prefix with `NEXT_PUBLIC_`. |
| `GRAFANA_ORG_ID` | Optional | unset (Grafana's default org) | Grafana organisation id, sent upstream as the `X-Grafana-Org-Id` header. Grafana's default org is `1`. Leave empty to use the service account's default org. |
| `GRAFANA_PATH_PREFIX` | Optional | `/api/grafana` | The path this app serves the proxy on. Must stay in sync with the route folder, the `baseUrl` passed to `<GrafanaDashboard>`, and Grafana's `root_url` sub-path. |
| `GRAFANA_STRIP_PATH_PREFIX` | Optional | `false` | Whether the proxy strips `GRAFANA_PATH_PREFIX` before calling Grafana. `false` pairs with `serve_from_sub_path = true`; `true` pairs with `serve_from_sub_path = false`. See Step 2. |
| `GRAFANA_REQUEST_TIMEOUT_MS` | Optional | `15000` | Upstream timeout **per attempt** for API/control-plane requests — everything except datasource queries. On expiry the proxy returns `504` instead of hanging. Idempotent methods (`GET`/`HEAD`/`OPTIONS`) are retried once, so the worst case is two attempts (~30s at the default). |
| `GRAFANA_QUERY_TIMEOUT_MS` | Optional | `60000` | Upstream timeout **per attempt** for datasource queries (`POST /api/ds/query`, `/api/datasources/proxy/*`). Separate from the control-plane budget because the two are not comparable — 15s for a `login/ping` is already a failure, while a panel query aggregating over a large table can legitimately run 30s. `POST` is never retried, so this budget is one attempt. |
| `GRAFANA_DEBUG` | Optional | `false` | When `true`, the proxy logs method, upstream path, status, and duration for each request. It **never** logs the token or the `Authorization` header. |

Boolean values are parsed leniently: `1`, `true`, `yes`, `on` are truthy; `0`,
`false`, `no`, `off`, and the empty string are falsy.

`.env.local` is read by the Next.js dev server at startup. **Restart the dev
server after editing it** — changing a value while the server is running has no
effect.

---

## Step 4 — Run it

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server (default port 3000). |
| `npm run build` | Production build. |
| `npm start` | Serve the production build. Run `npm run build` first. |
| `npm run typecheck` | `tsc --noEmit` — type-check without emitting. |
| `npm run lint` | `next lint`. |
| `npm test` | Unit-tests the proxy's path/URL logic: prefix normalisation for both topologies, `..` traversal rejection, and `auth_token` stripping. Requires **Node >= 22.6** (it uses type stripping to import `lib/grafana.ts` directly). |
| `npm run check:secrets` | Scans the built client bundle in `.next/static` for a `glsa_…` token, the literal `GRAFANA_SERVICE_ACCOUNT_TOKEN` value, and the Grafana hostname. Run it after `npm run build`; it exits non-zero on a leak, so it is safe to wire into CI. |

---

## Verifying the security property

These checks are worth running once after setup. They demonstrate that the
credential lives only on the server.

### 1. The proxy works with no credentials from the caller

```bash
curl -i http://localhost:3000/api/grafana/api/health
```

This returns Grafana's health JSON (`200`) even though the request carried no
`Authorization` header. That is the whole point: the token was added server-side.

Adjust the path to match your `GRAFANA_PATH_PREFIX`. `api/health` is Grafana's
health endpoint; the proxy path is your prefix plus that endpoint.

A dashboard works the same way:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:3000/api/grafana/api/dashboards/uid/ad8hd5h
```

### 2. Grafana itself refuses the same request

```bash
curl -i http://13.203.193.234:30016/api/grafana/api/dashboards/uid/ad8hd5h
```

Returns `401`. Anonymous access is disabled on the instance, so this contrast is
the proof that the proxy — not a public dashboard — is what makes the embed work.

### 3. The token is absent from the client bundle

```bash
npm run build
grep -rq "glsa_" .next/static && echo "LEAK: token in client bundle" || echo "clean: no token in .next/static"
grep -rq "13.203.193.234" .next/static && echo "LEAK: Grafana host in client bundle" || echo "clean: no Grafana host in .next/static"
```

Both should print `clean`. `.next/static` holds the browser-facing chunks; the
server code lives under `.next/server` and is never sent to the client. The
Grafana hostname check is a belt-and-braces check that the server-only URL has
not been inlined by a stray client import.

PowerShell equivalent:

```powershell
Get-ChildItem -Recurse -File .next\static | Select-String -Pattern 'glsa_', '13.203.193.234'
```

No output means clean.

### 4. What to look for in DevTools

Open DevTools → **Network**, reload a dashboard page, and confirm:

- Every request goes to `/api/grafana/...` **on your own origin** — not to
  `13.203.193.234:30016`.
- **No `Authorization` header appears on any browser-originated request.** Select
  a request, open the Headers pane, and check the request headers. The
  `Authorization` header exists only on the server-to-Grafana hop, which the
  browser never sees.
- No `Set-Cookie` from Grafana lands in the browser. The proxy's response-header
  allowlist excludes `set-cookie`, so Grafana cannot establish a session in the
  browser through the proxy.

---

## Verifying the dashboard UIDs

The UIDs in `lib/dashboards.ts` are transcribed from the supplied Grafana URLs.
An incorrect UID **fails quietly** — Grafana renders a "Dashboard not found"
panel inside the frame rather than returning an error, so the embed looks like it
is working.

Check each one:

```bash
for uid in ad8hd5sh adrpb69 ad8hd5h; do
  printf '%s -> ' "$uid"
  curl -s -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
    "$GRAFANA_URL/api/dashboards/uid/$uid" | jq -r '.dashboard.title // "NOT FOUND"'
done
```

To compare against everything the token can actually see:

```bash
curl -s -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  "$GRAFANA_URL/api/search?type=dash-db&limit=200" | jq -r '.[] | "\(.uid)\t\(.title)"'
```

Or one at a time:

```bash
curl -s -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  "$GRAFANA_URL/api/dashboards/uid/ad8hd5sh" | jq -r .dashboard.title
```

These two are easy to confuse at a glance — they differ only by the trailing `s`:

| Dashboard | UID | Status |
| --- | --- | --- |
| Batch Report | `ad8hd5sh` | verified on the instance |
| OEE | `ad8hd5h` | verified on the instance |

Both were confirmed to resolve to distinct, correctly-titled dashboards. If one
ever shows another's content or a "Dashboard not found" panel, this pair is the
first place to look.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Blank white iframe; console shows an `X-Frame-Options` refusal | `allow_embedding` is still `false` | Set `[security] allow_embedding = true` and **restart Grafana**. The proxy strips the header from proxied responses, but the page itself is framed by the browser before that applies. |
| Dashboard renders as a broken shell — unstyled, unresponsive, with `404`s for `/public/...` in DevTools | `root_url` sub-path mismatch | See Step 2b. `root_url` must carry the same sub-path the proxy is mounted on, and the matching `GRAFANA_STRIP_PATH_PREFIX` value must be set. Restart Grafana. |
| `502` with `Grafana rejected the service account token.` | The token is wrong, expired, or revoked | Verify `GRAFANA_SERVICE_ACCOUNT_TOKEN` is the full `glsa_...` value with no surrounding quotes or whitespace. Check Grafana's own logs. Create a fresh token if needed. |
| `502` with `Grafana redirected to its login page.` | The token was not accepted at all | Same as above, and confirm `GRAFANA_URL` points at the intended instance. A redirect to `/login` means the request arrived unauthenticated. |
| `504` with `Grafana did not respond in time.` | A datasource query exceeded its budget — `GRAFANA_QUERY_TIMEOUT_MS` (default `60000`) for `POST /api/ds/query`, `GRAFANA_REQUEST_TIMEOUT_MS` (default `15000`) for everything else | Read the proxy log line: it names the method, the budget, and the real attempt count. See "Known errors" below. Raise the budget for that class of request, and check the datasource itself. |
| `500` with `Grafana proxy is not configured.` | `GRAFANA_URL` or `GRAFANA_SERVICE_ACCOUNT_TOKEN` is unset or invalid | Fill both in `.env.local` and **restart the dev server** — env files are read at startup only. The response `detail` field names the offending variable; it never contains the value. |
| Grafana's "Dashboard not found" panel renders inside the frame | Wrong UID in `lib/dashboards.ts` | Re-check with the UID verification commands above. |
| Infinite loading spinner, no error | The iframe's `fallbackTimeoutMs` has not elapsed, or Grafana is unreachable from the server | Wait for the fallback to fire. If it never does, check the server logs for a `[grafana-proxy]` line and confirm the server can reach `GRAFANA_URL`. |
| `502` with `Could not reach Grafana.` | Network failure — DNS, routing, firewall, or Grafana down | Check reachability from the server with `curl -i "$GRAFANA_URL/api/health"`. The response deliberately does not echo the upstream URL, since it can embed configuration. |

The proxy writes `[grafana-proxy] ...` lines to the server console for
misconfiguration, rejected tokens, login redirects, timeouts, and upstream
failures. Set `GRAFANA_DEBUG=true` for a per-request line with method, path,
status, and duration. Debug output never includes the token or the
`Authorization` header.

---

## Known errors

### `504` — `Grafana did not respond in time.`

```json
{
  "error": "Grafana did not respond in time.",
  "detail": "Upstream exceeded its 60000ms budget over 1 attempt (POST is not retried). A slow datasource query is the usual cause — raise GRAFANA_QUERY_TIMEOUT_MS (dashboard queries) or GRAFANA_REQUEST_TIMEOUT_MS (everything else)."
}
```

**What it means.** One upstream call to Grafana did not complete within its
budget. Which budget depends on the path: `POST /api/ds/query` and the
datasource proxy get `GRAFANA_QUERY_TIMEOUT_MS` (default `60000`); everything
else gets `GRAFANA_REQUEST_TIMEOUT_MS` (default `15000`).

The `detail` field states the real attempt count. `POST` is **never** retried —
replaying it could duplicate work upstream — so a timing-out `ds/query` is a
single attempt, and the message says so. Do not read a `ds/query` 504 as
flakiness.

**Observed on the `13.203.193.234:30016` instance.** A dashboard load there
fires its queries in one burst, and on the `golden-batch` dashboard a handful of
those `POST /api/ds/query` calls ran past 15s while the rest of the load, and
Grafana itself, stayed healthy:

| Path | Result |
| --- | --- |
| 14 × `POST /api/ds/query` on first load | `200` · 0.12s–1.43s |
| 4 × `POST /api/ds/query` (`SQR100`–`SQR103`) | `504` at ~15.0s |
| `GET /api/login/ping` during the stall | `200` · ~0.19s, repeatedly |

Grafana answering pings in ~190ms while four queries sit past 15s rules out a
network partition, a downed Grafana, and proxy saturation — those would fail the
ping too. It also rules out the burst itself: 14 of ~18 queries in the same
burst completed normally. What remains is that those specific queries are
genuinely slow on the datasource path. The `golden-batch` dashboard is the
likeliest source — it carries 15 template variables (13 of them query-backed)
against a ClickHouse datasource with a 1,014,564-row `machine_event` table.

**Diagnose, in order.**

1. **Which class of request is timing out.** The proxy log line names it:
   ```
   [grafana-proxy] Upstream timed out after 60000ms over 1 attempt (POST is not retried): /api/grafana/api/ds/query
   ```
   A `/api/ds/query` line is a query-performance problem. Any other path is
   control-plane, and steps 3–5 below apply.
2. **Which query, and how slow.** Set `GRAFANA_DEBUG=true` for per-request
   timing, then run the dashboard's own query against ClickHouse directly and
   time it. A query that takes 40s on its own is not a proxy problem — the
   budget just needs to fit it, or the query needs a narrower time range.
3. **Reachability from the server.** The Next.js server — not your browser —
   must reach Grafana:
   ```bash
   curl -i -m 10 "$GRAFANA_URL/api/health"
   ```
   A hang here is the cause. `13.203.193.234` is a public address, so a cloud
   security group or corporate firewall is the usual culprit.
4. **Wrong `GRAFANA_URL` host or port.** A URL that resolves but never answers
   (rather than refusing the connection) produces exactly this timeout. This
   instance listens on `30016`, not the default `3000`.
5. **`serve_from_sub_path = true` without the sub-path in `root_url`,** or a
   mismatch between the two. See Step 2.

**Fixes.**

- For slow datasource queries, raise the query budget and restart:
  ```ini
  GRAFANA_QUERY_TIMEOUT_MS=120000
  ```
  This lets a legitimately slow query finish instead of becoming a 504. It does
  not make ClickHouse faster — a query that needs 90s will still take 90s.
- For control-plane timeouts, raise `GRAFANA_REQUEST_TIMEOUT_MS` instead. Its
  worst case is two attempts (~30s at the default), since idempotent methods
  retry once.
- Reduce the query load: narrow the dashboard's default time range, and check
  template variables that ship large option lists. On this instance the
  `workorder` variable alone returns 30,134 rows to the browser.
- If the server cannot reach Grafana directly, put them on the same network.
  Changing any timeout will not help.

---

## Adding a dashboard

`lib/dashboards.ts` is the single source of truth. The index page, the dynamic
embed page, and the breadcrumb navigation all derive from the `DASHBOARDS` array,
so there is nothing else to wire up.

Before:

```ts
export const DASHBOARDS: readonly DashboardDefinition[] = [
  {
    id: 'golden-batch',
    uid: 'addrp',
    title: 'Golden Batch',
    description: 'Reference batch profile used as the baseline for comparisons.',
    category: 'Production',
    defaultFrom: 'now-30d',
  },
];
```

After:

```ts
export const DASHBOARDS: readonly DashboardDefinition[] = [
  {
    id: 'golden-batch',
    uid: 'addrp',
    title: 'Golden Batch',
    description: 'Reference batch profile used as the baseline for comparisons.',
    category: 'Production',
    defaultFrom: 'now-30d',
  },
  {
    id: 'line-uptime',
    uid: 'replace_with_the_real_uid',
    title: 'Line Uptime',
    description: 'Availability per production line, rolled up by shift.',
    category: 'Performance',
    defaultFrom: 'now-24h',
    defaultRefresh: '1m',
  },
];
```

Field reference:

| Field | Required? | Notes |
| --- | --- | --- |
| `id` | Yes | Stable slug used in *this app's* URLs (`/dashboards/<id>`). Must be one of `DASHBOARD_IDS` — the union is what makes a typo a compile error. |
| `uid` | Yes | Grafana's dashboard UID, from the `/d/<uid>` segment of its URL. |
| `title` | Yes | Friendly name shown on cards and in breadcrumbs. |
| `description` | Yes | One-line summary on the index card. |
| `slug` | No | Cosmetic slug appended to the iframe URL. Grafana ignores it for routing; it makes URLs readable and appears in shared links. Omit to let `<GrafanaDashboard>` fall back to `dashboard`. |
| `category` | Yes | Kicker shown above the title, used for grouping on the index page. |
| `defaultFrom` | No | Default time range, e.g. `now-24h`. |
| `defaultRefresh` | No | Default auto-refresh interval, e.g. `1m`. Omit to disable auto-refresh. |

Verify the new UID before reloading, since a wrong UID fails quietly:

```bash
curl -s -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  "$GRAFANA_URL/api/dashboards/uid/replace_with_the_real_uid" | jq -r .dashboard.title
```

---

## Project structure

```text
next-grafana/
├── app/
│   ├── api/
│   │   └── grafana/
│   │       └── [...path]/
│   │           └── route.ts                  # the credentialed reverse proxy
│   ├── dashboards/
│   │   ├── page.tsx                          # dashboard index (cards)
│   │   └── [dashboardId]/
│   │       ├── page.tsx                      # per-dashboard embed page
│   │       ├── DashboardFrame.tsx            # hosts <GrafanaDashboard>
│   │       └── DashboardErrorBoundary.tsx    # error / fallback UI for the frame
│   ├── layout.tsx                            # root layout
│   └── page.tsx                              # landing page
├── lib/
│   ├── grafana.ts                            # server-only config + URL building
│   └── dashboards.ts                         # dashboard registry (pure data)
├── .env.local.example                        # env template (safe to commit)
├── .gitignore
├── next.config.mjs
├── package.json
└── tsconfig.json
```

`lib/dashboards.ts` contains no secrets and no server-only imports, so it is safe
to import from both server and client components. `lib/grafana.ts` is the
opposite: it reads the token and must only ever be imported from server code.

---

## Security notes

- **Rotate the token if it is ever exposed** — pasted into chat, an issue, a
  screenshot, a log, or a commit. Rotation is cheap: create a new token on the
  same service account, update `.env.local`, restart the server, delete the old
  token.
- **Keep the Viewer role.** Embedded dashboards are read-only. Editor or Admin
  grants write access this app never uses and would widen the damage from a leak
  considerably.
- **Never add `NEXT_PUBLIC_` to the token** (or to any `GRAFANA_*` variable).
  That prefix inlines the value into the client bundle, where anyone can read it
  from DevTools or view-source. No `NEXT_PUBLIC_` variable exists in this project.
- **`.env.local` stays uncommitted.** It is in `.gitignore`; keep it that way and
  never commit it to a repository that others can read.
- **The proxy strips inbound `Authorization` and `Cookie`** (along with `Host`,
  `X-Forwarded-*`, and other hop-by-hop headers) and never forwards them, so a
  caller cannot smuggle their own credential through, poison the upstream host,
  or ride a session in. Requests are also checked for `..` path segments, and
  credential-bearing query parameters (`auth_token`, `authtoken`, `access_token`)
  are dropped before the query string is forwarded — forwarding one would write
  the credential into Grafana's access log.
- **Consider network-level restrictions** so that only the Next.js server can
  reach Grafana's port. The proxy's security model assumes the Grafana origin is
  not also reachable directly by browsers on the same network; restricting it
  closes that gap.
# Next-Grafana
