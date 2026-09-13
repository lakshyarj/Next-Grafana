'use client';

/**
 * Error boundary for the embedded dashboard.
 *
 * A class component, because React error boundaries have no hook equivalent.
 * Without one, a render-time failure inside the embed leaves an empty box with
 * no explanation — this turns that into a visible, retryable message.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import styles from './DashboardErrorBoundary.module.css';

interface DashboardErrorBoundaryProps {
  readonly children: ReactNode;
  /** Heading shown in the fallback; defaults to a generic one. */
  readonly fallbackTitle?: string;
  /** Called after the boundary clears itself, so the caller can remount. */
  readonly onReset?: () => void;
}

interface DashboardErrorBoundaryState {
  readonly error: Error | null;
}

export default class DashboardErrorBoundary extends Component<
  DashboardErrorBoundaryProps,
  DashboardErrorBoundaryState
> {
  constructor(props: DashboardErrorBoundaryProps) {
    super(props);
    // Assigned rather than re-declared as a class field: `state` is inherited
    // from React.Component, and re-declaring it is an implicit override.
    this.state = { error: null };
  }

  /**
   * React may throw any value, not just an Error, so normalise before storing.
   *
   * Declared without the `override` modifier on purpose: React's static
   * lifecycle methods are not members of the `Component` base class (they live
   * on the separate `StaticLifecycle` interface), so `override` here would be
   * rejected as "not declared in the base class".
   */
  static getDerivedStateFromError(error: unknown): DashboardErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    // The diagnostic context only — no credentials ever reach this tree, since
    // the token is attached server-side by the proxy route.
    console.error('[dashboard] embed failed to render:', error, errorInfo.componentStack);
  }

  private readonly handleTryAgain = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <section className={styles.panel} role="alert">
        <h2 className={styles.title}>
          {this.props.fallbackTitle ?? 'This dashboard could not be displayed'}
        </h2>
        <p className={styles.message}>
          The embedded Grafana dashboard failed to load. This is usually a temporary problem with
          the connection to Grafana, or a rendering error in the dashboard itself.
        </p>
        <button type="button" className={styles.tryAgain} onClick={this.handleTryAgain}>
          Try again
        </button>
      </section>
    );
  }
}
