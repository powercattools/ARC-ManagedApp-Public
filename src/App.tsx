import { Suspense, lazy } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Spinner, makeStyles, tokens } from '@fluentui/react-components';
import ReviewsPage from './features/agent-architecture-review/ReviewsPage';
import ReviewRedirectPage from './features/agent-architecture-review/ReviewRedirectPage';
import ResultDetailPage from './features/agent-architecture-review/ResultDetailPage';
import SetupPage from './features/agent-architecture-review/SetupPage';

/**
 * Loaded on demand, because its chart comes from `@fluentui/react-charting`, which brings Fluent v8
 * with it. Splitting the route keeps that weight off everyone who never opens the page.
 */
const ReviewProgressPage = lazy(
  () => import('./features/agent-architecture-review/ReviewProgressPage'),
);

/**
 * Design tokens read from the Figma file that Fluent's default theme does not
 * supply.
 */
const SHELL_BACKGROUND = '#F5F5F5';

const useStyles = makeStyles({
  /**
   * Bounded to the viewport rather than merely at least as tall as it, so the card below is the
   * element that scrolls. While the shell was free to grow, the card grew with it and its
   * `overflow` never produced a scrollbar — yet it still counted as a scroll container, so every
   * `position: sticky` descendant in the app measured itself against a box that never moved and
   * rode the page away instead of pinning.
   */
  shell: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: SHELL_BACKGROUND,
  },
  // The body sits on the shell as an inset white card (Figma `.body-frame`).
  content: {
    flexGrow: 1,
    // A flex item will not shrink below its content without this, which is what kept the card
    // taller than the shell and its `overflow` inert.
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    margin: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
    overflow: 'auto',
  },
});

export default function App() {
  return (
    <HashRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<Navigate to="/reviews" replace />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            {/*
              No longer a page of its own. A review is read through one of its snapshots, so this
              address resolves to the newest one — which keeps every link and bookmark written
              against it working.
            */}
            <Route path="/reviews/:reviewId" element={<ReviewRedirectPage />} />
            <Route
              path="/reviews/:reviewId/progress"
              element={
                <Suspense fallback={<Spinner label="Loading progress…" />}>
                  <ReviewProgressPage />
                </Suspense>
              }
            />
            <Route
              path="/reviews/:reviewId/results/:resultId"
              element={<ResultDetailPage />}
            />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="*" element={<Navigate to="/reviews" replace />} />
          </Route>
        </Routes>
    </HashRouter>
  );
}

function Shell() {
  const styles = useStyles();

  return (
    <div className={styles.shell}>
      <div className={styles.content}>
        <Outlet />
      </div>
    </div>
  );
}
