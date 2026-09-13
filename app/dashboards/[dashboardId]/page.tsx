/**
 * /dashboards/[dashboardId] — one embedded Grafana dashboard.
 *
 * Server component. It resolves the URL segment against the registry, emits the
 * page chrome (breadcrumb, heading, back link) on the server, and hands the
 * embed itself to a client component with serializable props only.
 *
 * Deliberately does NOT import `@/lib/grafana`: that module reads the service
 * account token, and pulling it into the module graph above a client component
 * is exactly the footgun this app exists to avoid. The embed needs no
 * credential here — the proxy attaches it server-side.
 */

import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { resolveDashboard } from '@/lib/dashboards';

import DashboardFrame from './DashboardFrame';
import styles from './embed.module.css';

/**
 * Render this route per request instead of caching a prerendered shell.
 *
 * The identifier is resolved against a registry that can grow without a
 * rebuild, and `resolveDashboard` accepts raw Grafana UIDs as well as app
 * slugs — so a cached HTML shell (and its cached 404) would outlive the state
 * it was built from. The render is pure data lookups, so the cost is nil.
 */
export const dynamic = 'force-dynamic';

/** App Router page props: Next 15 delivers `params` as a Promise. */
interface DashboardPageProps {
  params: Promise<{ dashboardId: string }>;
}

export async function generateMetadata({ params }: DashboardPageProps): Promise<Metadata> {
  const { dashboardId } = await params;
  const dashboard = resolveDashboard(dashboardId);

  if (!dashboard) {
    // The page itself calls notFound(); keep the title consistent with it.
    return { title: 'Dashboard not found · Grafana Dashboards' };
  }

  return {
    title: `${dashboard.title} · Grafana Dashboards`,
    description: dashboard.description,
  };
}

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { dashboardId } = await params;
  const dashboard = resolveDashboard(dashboardId);

  if (!dashboard) {
    notFound();
  }

  return (
    <main className={styles.page}>
      <div className={styles.breadcrumbRow}>
        <nav aria-label="Breadcrumb">
          <ol className={styles.breadcrumb}>
            <li className={styles.breadcrumbItem}>
              <Link className={styles.breadcrumbLink} href="/dashboards">
                Dashboards
              </Link>
              <span className={styles.breadcrumbSeparator} aria-hidden="true">
                /
              </span>
            </li>
            <li className={styles.breadcrumbItem}>
              <span className={styles.breadcrumbCurrent} aria-current="page">
                {dashboard.title}
              </span>
            </li>
          </ol>
        </nav>

        {/* The explicit way back to the list — visible, keyboard reachable,
            and never collapsed behind the embed. */}
        <Link className={styles.backLink} href="/dashboards">
          <span aria-hidden="true">←</span> Back to dashboard list
        </Link>
      </div>

      <header className={styles.header}>
        <h1 className={styles.title}>{dashboard.title}</h1>
        <p className={styles.description}>{dashboard.description}</p>
      </header>

      <Suspense fallback={<DashboardFallback />}>
        <DashboardFrame
          dashboardUid={dashboard.uid}
          dashboardSlug={dashboard.slug}
          title={dashboard.title}
          defaultFrom={dashboard.defaultFrom}
          defaultRefresh={dashboard.defaultRefresh}
        />
      </Suspense>
    </main>
  );
}

/**
 * Fallback for the embed boundary. Mirrors the shape and height of the real
 * frame (see `--skeleton-height` in embed.module.css) so resolving it causes
 * no layout shift. Same markup as app/dashboards/[dashboardId]/loading.tsx —
 * kept local because a page module may not export arbitrary components.
 */
function DashboardFallback() {
  return (
    <div className={styles.skeleton} role="status" aria-label="Loading dashboard">
      <div className={styles.skeletonToolbar} aria-hidden="true">
        <span className={`${styles.skeletonBar} ${styles.skeletonTextBar}`} />
        <span className={`${styles.skeletonBar} ${styles.skeletonButton}`} />
      </div>
      <span className={`${styles.skeletonBar} ${styles.skeletonTitleBar}`} aria-hidden="true" />
      <span className={`${styles.skeletonBar} ${styles.skeletonWideBar}`} aria-hidden="true" />
      <div className={styles.skeletonPanel} aria-hidden="true" />
    </div>
  );
}
