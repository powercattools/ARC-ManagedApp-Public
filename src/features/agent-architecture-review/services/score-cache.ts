/**
 * The snapshot's cached score, kept in step with the reviewer's decisions.
 *
 * `cat_architecturereviewresult.cat_score` is a derived copy of the rolled-up review — the schema
 * says so in as many words: "Derived cache of the referenced review, never the source of truth."
 * Two surfaces read it and nothing else: the home grid's percentage, and the headline of a shared
 * report. Both therefore went on showing the rubric's original verdict after a reviewer set rules
 * aside, while the results panel beside them showed the revised one.
 *
 * Updating a derived cache when its inputs change is what "derived" means, so this writes over the
 * old number rather than recording a second one. A snapshot carries one score.
 *
 * The agent half of the same cache is written by `dismissal-store`, in the same PATCH as the
 * decisions themselves, because they live on one row.
 */

import { MicrosoftDataverseService } from '../../../data';
import { CURRENT_ORGANIZATION } from './art-service';

const SNAPSHOT_SET = 'cat_architecturereviewresults';

/**
 * Record the snapshot's rolled-up score.
 *
 * Written as a string of a whole number, matching what the persistence layer writes when the
 * snapshot is first scored — the readers accept either, but two shapes in one column is how a
 * column starts needing a parser.
 *
 * A null or non-finite score is left alone rather than written as zero: "not scored" and "scored
 * zero" are different findings and this column is read for both.
 *
 * Throws when the write fails, so the caller can put the screen back to what the environment
 * actually holds.
 */
export async function cacheSnapshotScore(
  snapshotId: string,
  score: number | null,
): Promise<void> {
  if (score === null || !Number.isFinite(score)) return;

  const result = await MicrosoftDataverseService.UpdateRecordWithOrganization(
    '',
    'application/json',
    CURRENT_ORGANIZATION,
    SNAPSHOT_SET,
    snapshotId,
    { cat_score: String(Math.round(score)) },
    false,
  );
  if (!result.success) throw new Error('The environment rejected the revised score.');
}
