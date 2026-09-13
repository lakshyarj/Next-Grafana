import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';

import './globals.css';
import styles from './layout.module.css';

export const metadata: Metadata = {
  title: {
    default: 'Grafana Dashboards',
    template: '%s | Grafana Dashboards',
  },
  description:
    'Read-only Grafana dashboards embedded in Next.js. Grafana credentials stay on the server and never reach the browser.',
};

/**
 * Root layout — a server component.
 *
 * The header is deliberately static: no pathname reading, no client hooks. The
 * breadcrumb here is the fixed top-level trail (Home / Dashboards); a dashboard
 * detail page renders its own breadcrumb region below the header.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className={styles.header}>
          <div className={styles.container}>
            <div className={styles.headerBar}>
              <Link href="/" className={styles.wordmark}>
                Grafana Dashboards
              </Link>

              <nav className={styles.nav} aria-label="Primary">
                <Link href="/dashboards" className={styles.navLink}>
                  All dashboards
                </Link>
              </nav>
            </div>
          </div>

          <div className={`${styles.container} ${styles.breadcrumbBar}`}>
            <nav aria-label="Breadcrumb">
              <ol className={styles.breadcrumbList}>
                <li className={styles.breadcrumbItem}>
                  <Link href="/" className={styles.breadcrumbLink}>
                    Home
                  </Link>
                  <span className={styles.breadcrumbSeparator} aria-hidden="true">
                    /
                  </span>
                </li>
                <li className={styles.breadcrumbItem}>
                  <span className={styles.breadcrumbCurrent} aria-current="page">
                    Dashboards
                  </span>
                </li>
              </ol>
            </nav>
          </div>
        </header>

        <main className={styles.main}>
          <div className={styles.container}>{children}</div>
        </main>
      </body>
    </html>
  );
}
