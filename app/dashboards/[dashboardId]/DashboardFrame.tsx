'use client';

/**
 * Client shell around the embedded Grafana dashboard.
 *
 * Everything here runs in the browser, so it receives only serializable props
 * and holds no credential: the Grafana service account token is attached
 * server-side by app/api/grafana/[...path]/route.ts. In particular this file
 * never reads `process.env` and never names the Grafana host.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { GrafanaDashboard } from 'next-grafana-auth/component';

import DashboardErrorBoundary from './DashboardErrorBoundary';
import styles from './DashboardFrame.module.css';

/** Same-origin mount point for the proxy. Must match GRAFANA_PATH_PREFIX. */
const GRAFANA_BASE_URL = '/api/grafana';

type Theme = 'light' | 'dark';

/**
 * The subset of the library's `GrafanaUrlParams` this app sets. Declared
 * locally rather than imported so the file does not depend on a type export we
 * have not verified; the shape is structurally assignable to `params`.
 *
 * `authToken` is intentionally absent, and must stay absent: the library
 * documents it as leaking through browser history, referrers, and access logs.
 * This app authenticates server-side in the proxy route instead, so the browser
 * never holds a Grafana credential and there is nothing to leak.
 */
interface EmbedParams {
  readonly kiosk: boolean | 'tv';
  readonly theme: Theme;
  readonly from?: string;
  readonly refresh?: string;
}

interface DashboardFrameProps {
  readonly dashboardUid: string;
  readonly dashboardSlug?: string;
  readonly title: string;
  readonly defaultFrom?: string;
  readonly defaultRefresh?: string;
  /** Overrides the responsive default height, e.g. '60vh'. */
  readonly height?: string;
}

export default function DashboardFrame({
  dashboardUid,
  dashboardSlug,
  title,
  defaultFrom,
  defaultRefresh,
  height,
}: DashboardFrameProps) {
  /**
   * Doubles as the retry attempt counter and as the iframe `key`: bumping it
   * remounts <GrafanaDashboard>, which is the only way to force a genuine
   * reload (a soft prop change would leave the existing frame in place).
   */
  const [reloadCount, setReloadCount] = useState(0);

  /**
   * Start from 'light' on both the server and the first client render so the
   * markup matches, then correct to the user's system preference in the effect
   * below. Reading matchMedia during render would be a hydration mismatch.
   */
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const applyPreference = () => setTheme(query.matches ? 'dark' : 'light');

    applyPreference();
    query.addEventListener('change', applyPreference);
    return () => query.removeEventListener('change', applyPreference);
  }, []);

  const params = useMemo<EmbedParams>(
    () => ({
      // Hides Grafana's own navigation and breadcrumb chrome so the embed reads
      // as a native page rather than a window into another app.
      kiosk: true,
      theme,
      // Spread conditionally: sending `from=` / `refresh=` with an empty value
      // would override Grafana's own saved defaults with nothing.
      ...(defaultFrom ? { from: defaultFrom } : {}),
      ...(defaultRefresh ? { refresh: defaultRefresh } : {}),
      // No authToken here by design — see EmbedParams above.
    }),
    [theme, defaultFrom, defaultRefresh],
  );

  const handleReload = useCallback(() => {
    setReloadCount((count) => count + 1);
  }, []);

  const handleRetry = useCallback(
    (context: { attempt: number; reason: 'timeout' | 'error' }) => {
      // The retry context carries no credentials; safe to log for diagnostics.
      console.warn(
        `[dashboard:${dashboardUid}] embed retry ${context.attempt} after ${context.reason}`,
      );
      setReloadCount((count) => count + 1);
    },
    [dashboardUid],
  );

  return (
    <section className={styles.frame} aria-label={`${title} dashboard`}>
      <div className={styles.toolbar}>
        <p className={styles.toolbarTitle}>{title}</p>
        <div className={styles.toolbarActions}>
          <button type="button" className={styles.reloadButton} onClick={handleReload}>
            Reload
          </button>
          <Link className={styles.backLink} href="/dashboards">
            <span aria-hidden="true">←</span> Back to dashboard list
          </Link>
        </div>
      </div>

      <div className={styles.viewport} style={height ? { height } : undefined}>
        <DashboardErrorBoundary
          fallbackTitle={`Could not display “${title}”`}
          onReset={handleReload}
        >
          <GrafanaDashboard
            key={reloadCount}
            baseUrl={GRAFANA_BASE_URL}
            dashboardUid={dashboardUid}
            dashboardSlug={dashboardSlug}
            params={params}
            title={`${title} dashboard`}
            showLoading
            loadingMessage={`Loading ${title}…`}
            // The library renders its own Retry button on timeout/error; without
            // this the click would be swallowed and the iframe would never
            // actually reload.
            onRetry={handleRetry}
          />
        </DashboardErrorBoundary>
      </div>
    </section>
  );
}
