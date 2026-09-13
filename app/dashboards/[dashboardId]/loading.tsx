/**
 * Route-level loading UI for /dashboards/[dashboardId].
 *
 * Renders the page shell as a skeleton. It deliberately uses the same
 * `.page` / `--skeleton-height` rules as the real page (embed.module.css) so
 * the shell does not jump when the content arrives.
 *
 * Pure decoration, so it is exposed to assistive technology as a single
 * `role="status"` region with a label, with the shapes themselves hidden.
 */

import styles from './embed.module.css';

export default function DashboardLoading() {
  return (
    <div className={styles.page} role="status" aria-label="Loading dashboard">
      <div className={styles.skeleton} aria-hidden="true">
        <div className={styles.skeletonToolbar}>
          <span className={`${styles.skeletonBar} ${styles.skeletonTextBar}`} />
          <span className={`${styles.skeletonBar} ${styles.skeletonButton}`} />
        </div>
        <span className={`${styles.skeletonBar} ${styles.skeletonTitleBar}`} />
        <span className={`${styles.skeletonBar} ${styles.skeletonWideBar}`} />
        <div className={styles.skeletonPanel} />
      </div>
    </div>
  );
}
