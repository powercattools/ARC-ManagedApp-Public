/**
 * The findings drawer's window onto the rule registry.
 *
 * A review records what happened to an agent; it does not record what the rule *asks*, why the
 * question is worth asking, or where the guidance comes from. Those belong to the rule and are
 * declared once, in `review-core/rules/<family>.rules.ts`. Without this adapter a reader who opens
 * a finding sees the verdict and the evidence but nothing about the standard being applied — and
 * worse, a *passing* rule has no finding at all, so it would carry no description either.
 *
 * It lives beside the panel rather than inside `engine/` deliberately: the engine stays free of
 * anything the renderer needs, and `@review-ui` is a React barrel. The registry itself is reached
 * through `art-ports`, which is still the only gateway into ART.
 */
import type { RuleMeta } from '@review-ui';

import { ruleById } from '../engine/scoring/art-ports';

/**
 * Resolves a rule id to its registry facts, or `undefined` when no rule owns that id.
 *
 * Unregistered ids are expected rather than exceptional — a saved review can name a rule that has
 * since been retired, and the AI workflow can report an id the host does not model. Both must read
 * as "no extra detail", never as an error.
 */
export function ruleMetaLookup(ruleId: string): RuleMeta | undefined {
  const rule = ruleById(ruleId);
  if (!rule) return undefined;

  const { prose } = rule;
  return {
    description: prose.question || prose.summary,
    why: prose.why,
    tags: rule.tags,
    harnesses: rule.harnesses,
    references: rule.references,
    fixSteps: prose.fixSteps,
    severity: rule.severity,
    /**
     * Only when the rule names one pillar outright.
     *
     * A rule shared across harnesses declares a pillar *per harness* (D-14) — a skill rule rolls
     * into the host agent's Skills pillar under `copilot-skill` and into the upload rubric under
     * `standalone-skill`. A finding carries no harness, so there is no honest way to pick one of
     * them here. Showing nothing is correct; showing the first key would be a guess.
     */
    pillar: typeof rule.pillar === 'string' ? rule.pillar : undefined,
  };
}
