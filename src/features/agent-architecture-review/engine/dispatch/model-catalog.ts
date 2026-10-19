/**
 * Resolve ART's AI Builder prompts by name instead of by hardcoded id.
 *
 * ## Why this module exists
 *
 * `AI_MODEL_IDS` is a list of GUIDs read out of one environment's `msdyn_aimodels` table. That is
 * fine while the app only ever runs where those rows were authored, and wrong everywhere else: a
 * solution import creates the same prompts with *new* ids, so every hardcoded GUID resolves to
 * nothing. `predict-transport` then reports "not provisioned in this environment" for each stage,
 * and every rule that stage feeds is rendered as "Could not run" — not because the prompt is
 * missing, but because the app was looking for it under an id only the authoring environment uses.
 *
 * Names survive the import; ids do not. So the catalog is keyed on name and the GUIDs become what
 * they always should have been — a fallback for the environment they came from.
 *
 * ## What this module deliberately does not do
 *
 * It never fails a review. A prompt that cannot be resolved keeps its compiled-in id, and a lookup
 * that errors outright leaves every id untouched, because the alternative is an environment that
 * reviews nothing at all when one query is throttled. Unresolvable prompts are reported by the
 * stages that need them, which is where the operator can see which one is missing.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import type { EngineTransport } from '../contracts/transport';
import { AI_MODEL_IDS, type ReviewModelIds } from '../scoring/art-ports';

/** The table AI Builder prompts live in. */
const MODEL_ENTITY_SET = 'msdyn_aimodels';

/** `statecode` of a prompt that is available to call. */
const ACTIVE = 0;

/**
 * Display name of every prompt ART calls, keyed by the constant that used to carry its id.
 *
 * `INSTRUCTION_COVERAGE` is absent on purpose. Its constant is the zero GUID — ART's sentinel for
 * "deliberately not provisioned" — and the copilot harness branches on that to serve coverage from
 * the workflow instead. Giving it a name here would resolve it to a real prompt and silently change
 * which engine answers that stage.
 */
export const REVIEW_PROMPT_NAMES: Readonly<Partial<Record<keyof ReviewModelIds, string>>> = {
  STAGE_D_PDF_GENERATION: 'Stage D GenAI - PDF Report Generation',
  SKILL_BUNDLE_EVAL: 'ART - Prompt - Skill Evaluator',
  SKILL_RESOURCE_EVAL: 'ART - Prompt - Skill Resource Chunk Evaluator',
  SKILL_FILE_SYNTHESIS: 'ART - Prompt - Skill Resource File Synthesizer',
  SKILL_DEEP_BUNDLE_SYNTHESIS: 'ART - Prompt - Skill Bundle Synthesizer',
  SKILL_CROSS_SKILL_ORCHESTRATION: 'ART - Prompt - Cross-Skill Orchestration Evaluator',
};

/** OData string literal. Names carry no apostrophes today; doubling one is cheaper than finding out. */
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

function readString(row: Record<string, unknown>, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * One resolution per environment, not per agent.
 *
 * A snapshot reviews many agents through the same transport, and the prompt list cannot change
 * between them. Keyed on the organization URL so a cross-environment run cannot serve one
 * environment's ids to another.
 */
const cache = new Map<string, Promise<ReviewModelIds>>();

/** Drop memoized catalogs. Exists for tests and for a retry after an admin provisions prompts. */
export function clearReviewModelCatalog(): void {
  cache.clear();
}

async function resolve(transport: EngineTransport): Promise<ReviewModelIds> {
  const resolved: { -readonly [K in keyof ReviewModelIds]: ReviewModelIds[K] } = {
    ...AI_MODEL_IDS,
  };
  const wanted = Object.entries(REVIEW_PROMPT_NAMES) as [keyof ReviewModelIds, string][];

  const filter = wanted.map(([, name]) => `msdyn_name eq ${literal(name)}`).join(' or ');

  let rows: Record<string, unknown>[];
  try {
    rows = (await transport.rows(
      `${MODEL_ENTITY_SET}?$select=msdyn_aimodelid,msdyn_name,statecode` +
        `&$filter=${encodeURIComponent(filter)}`,
    )) as Record<string, unknown>[];
  } catch (error) {
    // Compiled-in ids are still correct in the environment they were taken from, so a failed lookup
    // degrades to the old behaviour rather than to no AI at all.
    console.warn(
      `[ArchitectureReview] Could not read the AI prompt catalog from ${transport.organization}; ` +
        'falling back to the compiled-in model ids.',
      error,
    );
    return resolved;
  }

  if (!Array.isArray(rows)) return resolved;

  // An environment can hold more than one prompt with the same name — a draft beside the imported
  // one, or a leftover from a previous install. An active row always wins; without that rule the
  // choice would depend on return order, and a review would start failing for no visible reason.
  const byName = new Map<string, { id: string; active: boolean }>();
  for (const row of rows) {
    const name = readString(row, 'msdyn_name');
    const id = readString(row, 'msdyn_aimodelid');
    if (!name || !id) continue;
    const active = row['statecode'] === ACTIVE;
    const held = byName.get(name.toLowerCase());
    if (!held || (active && !held.active)) byName.set(name.toLowerCase(), { id, active });
  }

  const missing: string[] = [];
  for (const [key, name] of wanted) {
    const found = byName.get(name.toLowerCase());
    if (found) resolved[key] = found.id;
    else missing.push(name);
  }

  if (missing.length) {
    console.warn(
      `[ArchitectureReview] ${missing.length} AI prompt(s) are not provisioned in ` +
        `${transport.organization}: ${missing.join(', ')}. The stages that need them will report ` +
        'that they could not run until the prompts are imported.',
    );
  }

  return resolved;
}

/**
 * Resolve the prompt ids this environment actually uses.
 *
 * Safe to call on every run: the first call per environment does the query and the rest read the
 * memoized answer.
 */
export function resolveReviewModelIds(transport: EngineTransport): Promise<ReviewModelIds> {
  const key = transport.organization;
  const held = cache.get(key);
  if (held) return held;

  // Memoized before the await so concurrent agents in one snapshot share a single query. A failed
  // resolution is dropped so the next run can retry rather than caching a degraded catalog forever.
  const pending = resolve(transport).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}
