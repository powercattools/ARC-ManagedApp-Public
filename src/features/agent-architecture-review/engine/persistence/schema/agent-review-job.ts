/**
 * Additive alignment of the Agent Review Tool's `cat_agentreviewjob` table (spec 015,
 * FR-134).
 *
 * Two gaps, both found by inspecting the deployed table rather than the code:
 *
 * 1. `cat_jobkind` offers `StandardSkillBundle` (1) and `CrossSkillOrchestration` (2),
 *    but the corpus that drives the workflow is discriminated by a *different* type of
 *    the same name whose values are `StandardSkillBundle` and `ArtifactBundle`. An
 *    upload review therefore has no value it can be written as, and is recorded as a
 *    skill-bundle review: all 318 rows in the dev environment are `1`, including
 *    artifact runs. `ArtifactBundle` (3) closes that gap.
 *
 * 2. Nothing on the row says which harness produced the agent. The workflow trigger
 *    fires on a column change and cannot read inside the uploaded corpus, so routing a
 *    future harness to its own flow requires the harness to be a column. `cat_harness`
 *    adds it, sharing HARNESS_OPTIONS with the engine's own agent table so the two can
 *    never disagree.
 *
 * Both changes are additive: no existing value is renumbered or reinterpreted, and rows
 * written before them stay valid.
 */

import { type Json, HARNESS_OPTIONS, choice, label } from './metadata.ts';

export const JOB_TABLE = 'cat_agentreviewjob';
export const JOB_SET = 'cat_agentreviewjobs';
export const JOB_KIND_COLUMN = 'cat_jobkind';
export const JOB_HARNESS_COLUMN = 'cat_harness';

/** The solution that owns the table, so the fix ships with the tool that has the bug. */
export const JOB_SOLUTION = 'CopilotStudioAccelerator';

/**
 * `cat_jobkind` values, extended.
 *
 * 1 and 2 already exist in the environment and keep their meaning. 3 is new.
 */
export const JobKindOption = {
  StandardSkillBundle: 1,
  CrossSkillOrchestration: 2,
  ArtifactBundle: 3,
} as const;

export type JobKindOptionValue = (typeof JobKindOption)[keyof typeof JobKindOption];

/**
 * Option to insert into the existing local option set.
 *
 * A local set is addressed by entity plus attribute; `OptionSetName` is for global sets
 * and is rejected here.
 */
export const artifactBundleOption: Json = {
  EntityLogicalName: JOB_TABLE,
  AttributeLogicalName: JOB_KIND_COLUMN,
  Value: JobKindOption.ArtifactBundle,
  Label: label('ArtifactBundle'),
};

export const jobHarnessColumn: Json = choice(
  JOB_TABLE,
  JOB_HARNESS_COLUMN,
  'Harness',
  HARNESS_OPTIONS,
  'Harness that produced the agent under review. A column rather than a corpus field so the workflow trigger can route on it without opening the uploaded file.',
);
