import { Global_LogFeatureTelemetryService } from '../../../data';
import type { AssetType } from '../models/review';

export type ReviewFlowAction = 'create' | 'review-again';

/**
 * Notifies the LogFeatureTelemetry cloud flow that a review action was accepted, passing the
 * details as a JSON string.
 *
 * Fire-and-forget by design: a telemetry call must never block the review it reports on, nor surface
 * its own failure to the user. Every error — the connector rejecting, the flow reporting failure, or
 * a synchronous throw — is swallowed to `console.log`, matching the sibling Makers telemetry
 * contract (`CopilotStudioKitMakers/src/shared/services/featureTelemetry.ts`).
 *
 * `score` is carried as requested even though it is `null` at the point a review is started — the
 * score does not exist until the run completes. The flow's own JSON parsing must therefore accept a
 * null `score`.
 */
export function logReviewAction(
  action: ReviewFlowAction,
  assetType: AssetType,
  score: number | null,
): void {
  const payload = {
    action,
    assetType,
    score,
    timestamp: new Date().toISOString(),
  };

  try {
    void Global_LogFeatureTelemetryService.Run({ text: JSON.stringify(payload) })
      .then((result) => {
        if (!result.success) {
          console.log('[reviewTelemetry] flow returned failure:', result.error);
        }
      })
      .catch((err) => {
        console.log('[reviewTelemetry] flow call rejected:', err);
      });
  } catch (err) {
    console.log('[reviewTelemetry] synchronous throw:', err);
  }
}
