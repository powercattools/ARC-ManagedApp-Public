/**
 * AI Builder prediction, as the transport ART's `AIServiceCore` asks for.
 *
 * One implementation serves every harness that still calls a prompt directly. The copilot harness
 * needs it for the deep-resource stages and for whichever workflow stage is missing its reserved
 * row; the skill harness runs its AI stage through it. The standard harness no longer uses it at
 * all — its Stage B and C moved to the `Review Agent Components` workflow (see
 * `harnesses/standard/standard-review.ts`), and Stage A was always local. Giving each harness its
 * own would be several chances to diverge on retry and entitlement behaviour, which are the parts
 * that decide whether a review completes.
 *
 * The model id handed in here is resolved by name for the hosting environment — see
 * `model-catalog.ts`. The compiled-in GUIDs only resolve where they were authored.
 *
 * ## What this module is *not* allowed to do
 *
 * It contributes no retry, no entitlement fallback and no payload shaping. `AIServiceCore` owns all
 * three: it walks `PVA -> AIBuilder` on capacity errors, backs off on transient ones, and caches the
 * resolved source for the rest of the run. This module's only job is to make the call and report the
 * outcome faithfully enough for those decisions to be correct.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import type { EngineTransport } from '../contracts/transport';
import type { PredictResult, PredictTransport } from '../scoring/art-ports';

/** The table AI Builder models live in. */
const MODEL_ENTITY_SET = 'msdyn_aimodels';

/**
 * The bound action to invoke.
 *
 * `Predict`, never `PredictV2`. They are different actions with different payload shapes, and the
 * prompts ART registers are bound to this one — swapping them returns a shape the extractor reads as
 * an empty evaluation rather than as an error.
 */
const PREDICT_ACTION = 'Microsoft.Dynamics.CRM.Predict';

/** An unset model id. Dataverse would accept the call and fail deep inside the action. */
const EMPTY_MODEL_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Statuses that mean "this request was not valid and never will be".
 *
 * Returned rather than thrown so `AIServiceCore` classifies them as permanent. A thrown error is
 * caught there and treated as a network failure, which would retry an unprovisioned model three
 * times before reporting a cause the first attempt already knew.
 */
const PERMANENT = 400;

function message(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const detail = value as { message?: unknown; error?: unknown };
    if (typeof detail.message === 'string') return detail.message;
    if (detail.error) return message(detail.error);
  }
  return undefined;
}

function status(value: unknown): number | undefined {
  if (value && typeof value === 'object') {
    const detail = value as { status?: unknown };
    if (typeof detail.status === 'number') return detail.status;
  }
  return undefined;
}

/**
 * Build the predict transport for one host.
 *
 * Prediction always runs in the environment hosting this app, never the reviewed one. The transport
 * enforces that by routing on table name — `msdyn_aimodels` is not a source table — so nothing here
 * has to know which environment the agent came from.
 */
export function createPredictTransport(transport: EngineTransport): PredictTransport {
  return async (modelId: string, payload: Record<string, unknown>): Promise<PredictResult> => {
    const id = modelId?.trim().toLowerCase();

    if (!id || id === EMPTY_MODEL_ID) {
      // Named as a missing prompt rather than a failed call, because that is the fix: the prompt has
      // to be provisioned in this environment before any review can use the stage that needs it.
      return {
        success: false,
        error: {
          message: 'The requested AI model is not provisioned in this environment.',
          status: PERMANENT,
        },
      };
    }

    if (!/^[0-9a-f-]{36}$/.test(id)) {
      return {
        success: false,
        error: { message: `"${modelId}" is not an AI model id.`, status: PERMANENT },
      };
    }

    try {
      const response = await transport.action(MODEL_ENTITY_SET, PREDICT_ACTION, id, payload);

      if (response.status >= 300) {
        return {
          success: false,
          error: {
            message: message(response.data) ?? `Prediction failed (HTTP ${response.status}).`,
            status: response.status,
          },
        };
      }

      const data = response.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {
          success: false,
          error: { message: 'The prediction returned no result.', status: PERMANENT },
        };
      }

      return { success: true, data: data as Record<string, unknown> };
    } catch (error) {
      // The capacity and entitlement text lives in this message, and `AIServiceCore` matches on it
      // to decide whether to try the next entitlement source. Losing it would turn a recoverable
      // "no capacity on PVA" into a hard failure, so the cause is passed through verbatim.
      const detail = message(error) ?? String(error);
      return {
        success: false,
        error: {
          message: detail,
          ...(status(error) === undefined ? {} : { status: status(error)! }),
        },
      };
    }
  };
}
