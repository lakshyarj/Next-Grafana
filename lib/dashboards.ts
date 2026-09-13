/**
 * Grafana dashboard registry — the single source of truth.
 *
 * This module is PURE DATA: it contains no secrets and no server-only imports,
 * so it is safe to import from both server and client components.
 *
 * To add a dashboard: append an entry below. The index page, the dynamic
 * embed page, and the breadcrumb navigation all derive from this array, so
 * there is nothing else to wire up.
 */

/** Grafana dashboard UIDs. Kept as a union so a typo fails at compile time. */
export const DASHBOARD_IDS = [
  'batch-report',
  'batch-comparison',
  'oee',
  'golden-batch',
] as const;

export type DashboardId = (typeof DASHBOARD_IDS)[number];

/** A dashboard as presented in the UI. */
export interface DashboardDefinition {
  /** Stable slug used in this app's own URLs: /dashboards/<id> */
  readonly id: DashboardId;
  /** Grafana's dashboard UID, taken from the /d/<uid> segment of its URL. */
  readonly uid: string;
  /** Friendly name shown in cards and breadcrumbs. */
  readonly title: string;
  /** One-line summary shown on the index card. */
  readonly description: string;
  /**
   * Cosmetic slug appended to the Grafana iframe URL. Grafana ignores it for
   * routing but it makes URLs readable and appears in shared links. Omit to
   * let GrafanaDashboard fall back to "dashboard".
   */
  readonly slug?: string;
  /** Kicker shown above the title, for grouping on the index page. */
  readonly category: string;
  /** Default time range for this dashboard, e.g. 'now-24h'. */
  readonly defaultFrom?: string;
  /** Default auto-refresh interval, e.g. '1m'. Omit to disable auto-refresh. */
  readonly defaultRefresh?: string;
}

/**
 * The dashboards surfaced by this app.
 *
 * UIDs below are transcribed from the supplied Grafana URLs. They are the one
 * thing worth double-checking against your Grafana instance — a wrong UID
 * renders Grafana's "Dashboard not found" panel rather than an error, so the
 * failure is quiet. Verify each with:
 *
 *   curl -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
 *        "$GRAFANA_URL/api/dashboards/uid/<uid>" | jq '.dashboard.title'
 *
 * All three below were confirmed against the live instance via /api/search.
 * A fourth dashboard from the original brief, "Folder Dashboard"
 * (/d/afuuudk7rrvnkc), returned HTTP 404 there and is not listed.
 */
export const DASHBOARDS: readonly DashboardDefinition[] = [
  {
    id: 'batch-report',
    uid: 'ad8hd5sh',
    title: 'Batch Report',
    description:
      'Per-batch production detail: yields, cycle times, and quality metrics for a single batch run.',
    category: 'Production',
    defaultFrom: 'now-7d',
  },
  {
    id: 'batch-comparison',
    uid: 'adrpb69',
    title: 'Batch-to-Batch Comparison',
    description:
      'Side-by-side comparison of two or more batches to isolate drift in yield, throughput, or downtime.',
    category: 'Production',
    defaultFrom: 'now-30d',
  },
  {
    id: 'oee',
    uid: 'ad8hd5h',
    title: 'OEE',
    description:
      'Overall Equipment Effectiveness: availability, performance, and quality, rolled up by line and shift.',
    category: 'Performance',
    defaultFrom: 'now-7d',
    defaultRefresh: '30s',
  },
  {
    id: 'golden-batch',
    uid: 'addrp',
    title: 'Golden Batch',
    description:
      'Compare a test batch with golden batches across process parameters including pressure, speed, temperature, and torque.',
    category: 'Quality',
    defaultFrom: 'now-30m',
  },
];

/** Type guard: is this string one of our known dashboard ids? */
export function isDashboardId(value: string): value is DashboardId {
  return (DASHBOARD_IDS as readonly string[]).includes(value);
}

/** Look up a dashboard by its app slug. Returns undefined when unknown. */
export function getDashboard(id: string): DashboardDefinition | undefined {
  return DASHBOARDS.find((dashboard) => dashboard.id === id);
}

/**
 * Look up a dashboard by Grafana UID. Used by the embed page so that a URL
 * carrying the raw Grafana UID (e.g. /dashboards/ad8hd5h) still resolves
 * instead of 404-ing.
 */
export function getDashboardByUid(uid: string): DashboardDefinition | undefined {
  return DASHBOARDS.find((dashboard) => dashboard.uid === uid);
}

/** Resolve any accepted identifier (app slug or Grafana UID) to a dashboard. */
export function resolveDashboard(identifier: string): DashboardDefinition | undefined {
  return getDashboard(identifier) ?? getDashboardByUid(identifier);
}
