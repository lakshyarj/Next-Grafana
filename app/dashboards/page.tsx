import type { Metadata } from 'next';
import Link from 'next/link';

import { DASHBOARDS } from '@/lib/dashboards';
import styles from './dashboards.module.css';

export const metadata: Metadata = {
  title: 'All dashboards',
  description:
    'Every Grafana dashboard embedded in this app, grouped by category and embedded read-only.',
};

export default function DashboardsPage() {
  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>All dashboards</h1>
        <p className={styles.pageLead}>
          Each dashboard is embedded read-only. Open one to view it in a
          time-range you can adjust without leaving this app.
        </p>
      </header>

      <ul className={styles.cardGrid}>
        {DASHBOARDS.map((dashboard) => (
          <li key={dashboard.id} className={styles.cardItem}>
            <Link
              href={`/dashboards/${dashboard.id}`}
              className={styles.card}
              aria-label={`${dashboard.title} — open dashboard`}
            >
              <span className={styles.cardKicker}>{dashboard.category}</span>
              <h2 className={styles.cardTitle}>{dashboard.title}</h2>
              <p className={styles.cardDescription}>{dashboard.description}</p>
              {dashboard.defaultFrom ? (
                <p className={styles.cardMeta}>
                  Default range: {dashboard.defaultFrom}
                </p>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
