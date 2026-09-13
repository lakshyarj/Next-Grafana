import Link from 'next/link';

import styles from './layout.module.css';

export default function HomePage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Grafana dashboards, embedded</h1>

      <p className={styles.pageLead}>
        This app embeds Grafana dashboards read-only. The browser never talks to
        Grafana directly and never learns its address or credential: every panel
        request goes through this app&apos;s own proxy route, which attaches a
        server-side service-account token before forwarding it upstream.
      </p>

      <div className={styles.actions}>
        <Link href="/dashboards" className={`${styles.button} ${styles.buttonPrimary}`}>
          Browse dashboards
        </Link>
      </div>
    </div>
  );
}
