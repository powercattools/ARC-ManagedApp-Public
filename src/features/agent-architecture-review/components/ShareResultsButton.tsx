/**
 * "Share results" — downloads the snapshot as JSON or PDF.
 *
 * Both formats are rendered from the same `ShareReport` object, so the PDF can never quietly disagree
 * with the JSON. The JSON is the superset: the PDF truncates each ranked table for readability, and says
 * so, while the JSON carries every row.
 *
 * The button stays disabled until the aggregated review has loaded, because a report built from a partial
 * agent list would look complete — it would simply be missing agents, with nothing on the page to say so.
 */

import { useCallback, useState } from 'react';
import {
  Button,
  Menu,
  MenuGroupHeader,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Toast,
  ToastTitle,
  Toaster,
  useId,
  useToastController,
} from '@fluentui/react-components';
import { BracesRegular, DocumentPdfRegular, ShareRegular } from '@fluentui/react-icons';
import { useAggregatedReview } from '../hooks/use-art';
import { useAllResultRuntime } from '../hooks/use-runtime';
import { useSnapshotAgentScores } from '../hooks/use-snapshot-agent-scores';
import { buildShareReport, reportFileStem } from '../services/report-service';
import type { Review, ReviewResult } from '../models/review';
import { useOrchestration } from '../hooks/use-orchestration';
import { isOrchestrated } from '../services/snapshot-orchestration';

interface ShareResultsButtonProps {
  review: Review;
  result: ReviewResult;
}

/** Hands a blob to the browser. Revoking on the next tick keeps Safari from cancelling the download. */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ShareResultsButton({ review, result }: ShareResultsButtonProps) {
  const toasterId = useId('share-results');
  const { dispatchToast } = useToastController(toasterId);
  const [busy, setBusy] = useState(false);
  const aggregated = useAggregatedReview(review.botId, review.environmentUrl, result);
  const runtime = useAllResultRuntime(result.id, true, result);
  const progress = useOrchestration(result);
  const agentScores = useSnapshotAgentScores(result.id);

  const ready = Boolean(aggregated.data) && !aggregated.isError && !runtime.isPending && !runtime.isError &&
    !agentScores.isPending &&
    (!isOrchestrated(result) || (!progress.isPending && !progress.isError));

  // Why the control is unavailable, so it is never a dead button with no explanation.
  const blockedReason = isOrchestrated(result) && progress.isError
    ? 'The snapshot assessment status could not be read.'
    : aggregated.isError
    ? "We couldn't load the analysis this report is built from."
    : runtime.isError ? 'Exact snapshot runtime evidence could not be read.'
    : !ready
      ? 'Preparing the report…'
      : undefined;

  const build = useCallback(() => {
    if (!ready || !aggregated.data) return undefined;
    return buildShareReport({
      review,
      snapshot: result,
      aggregated: aggregated.data,
      runtimeByAgent: runtime.data ?? new Map(),
      scoreByAgent: agentScores.data,
      orchestration: progress.data?.progress,
    });
  }, [ready, aggregated.data, review, result, runtime.data, agentScores.data, progress.data]);

  const fail = useCallback(
    (message: string) => {
      dispatchToast(
        <Toast>
          <ToastTitle>{message}</ToastTitle>
        </Toast>,
        { intent: 'error' },
      );
    },
    [dispatchToast],
  );

  const onJson = useCallback(() => {
    const report = build();
    if (!report) {
      fail("We couldn't assemble the report.");
      return;
    }
    download(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
      `${reportFileStem(report)}.json`,
    );
  }, [build, fail]);

  const onPdf = useCallback(async () => {
    const report = build();
    if (!report) {
      fail("We couldn't assemble the report.");
      return;
    }

    setBusy(true);
    try {
      // Loaded on demand: jsPDF is large, and most visits to this page never export.
      const { renderReportPdf } = await import('../services/report-pdf');
      download(renderReportPdf(report), `${reportFileStem(report)}.pdf`);
    } catch {
      fail("We couldn't generate the PDF. The JSON export still works.");
    } finally {
      setBusy(false);
    }
  }, [build, fail]);

  // Reviews with no target agent have no design findings and no components, so there is nothing to
  // export. `AnalysisPanel` shows an empty state for the same case; a permanently disabled button here
  // would just be an unexplained dead control.
  if (!review.botId) return null;

  return (
    <>
      <Toaster toasterId={toasterId} />
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            appearance="subtle"
            icon={busy ? <Spinner size="tiny" /> : <ShareRegular />}
            disabled={!ready || busy}
            title={blockedReason}
          >
            {busy ? 'Preparing…' : 'Share results'}
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuGroupHeader>
              {runtime.data && runtime.data.size > 0
                ? `Includes runtime analysis for ${runtime.data.size} agent${runtime.data.size === 1 ? '' : 's'}`
                : 'Design findings only (no runtime analysis in this snapshot)'}
            </MenuGroupHeader>
            <MenuItem icon={<DocumentPdfRegular />} onClick={() => void onPdf()}>
              Download PDF report
            </MenuItem>
            <MenuItem icon={<BracesRegular />} onClick={onJson}>
              Download JSON report
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </>
  );
}
