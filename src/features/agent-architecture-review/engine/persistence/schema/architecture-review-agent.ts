/**
 * Dataverse metadata for `cat_architecturereviewagent` — one row per agent reviewed in
 * a snapshot, parent and connected alike (spec 015, FR-126).
 *
 * Definitions only. They are plain data, so this module stays browser-safe and carries
 * no Node globals; the installer that POSTs them is a Node host concern and lives
 * outside this folder.
 *
 * The row records what the deployed `cat_agentreviews.cat_resultid` lookup cannot
 * express: the agent graph, the harness, the correlation id, and the identifiers of the
 * three rows a review produces. Review content itself is never copied here (FR-127).
 */

import {
  type Json, HARNESS_OPTIONS, attributeBase, label, choice as choiceOn,
  integer as integerCol, memo, text as textCol,
} from './metadata.ts';

export const AGENT_TABLE = 'cat_architecturereviewagent';
export const AGENT_SET = 'cat_architecturereviewagents';
export const AGENT_ID = 'cat_architecturereviewagentid';
export const SNAPSHOT_TABLE = 'cat_architecturereviewresult';

const text = textCol;
const integer = integerCol;
const choice = (
  schemaName: string, name: string,
  options: readonly (readonly [number, string])[], description?: string,
): Json => choiceOn(AGENT_TABLE, schemaName, name, options, description);

/** Mirrors `cat_architecturereviewresult_cat_grade` so both tables grade identically. */
const GRADES: [number, string][] = [
  [1, 'A'], [2, 'A-'], [3, 'B+'], [4, 'B'], [5, 'B-'],
  [6, 'C+'], [7, 'C'], [8, 'C-'], [9, 'D'], [10, 'F'],
];

export const agentTable: Json = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: AGENT_TABLE,
  EntitySetName: AGENT_SET,
  DisplayName: label('Architecture Review Agent'),
  DisplayCollectionName: label('Architecture Review Agents'),
  Description: label('One agent reviewed within an architecture snapshot, parent or connected. Points at the review, job and runtime rows rather than copying their content.'),
  OwnershipType: 'UserOwned',
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  IsOptimisticConcurrencyEnabled: true,
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    ...attributeBase('cat_name', 'Name'),
    IsPrimaryName: true,
    MaxLength: 200,
    FormatName: { Value: 'Text' },
  }],
};

export const agentColumns: Json[] = [
  text('cat_agentid', 'Agent ID', 100,
    'Bot identifier in its source environment. Held as text, not a lookup, because the agent may be read from another environment.'),
  text('cat_agentname', 'Agent name', 200),
  text('cat_schemaname', 'Agent schema name', 200),

  choice('cat_role', 'Role', [[1, 'Parent'], [2, 'Connected']]),
  text('cat_parentagentid', 'Parent agent ID', 100, 'Graph edge. Empty for the parent agent.'),
  integer('cat_depth', 'Depth', 0, 32, 'Zero for the parent agent.'),

  // Carries all four harnesses from the outset so a later slice adds rows, not schema (FR-129).
  choice('cat_harness', 'Harness', HARNESS_OPTIONS),

  text('cat_correlationid', 'Correlation ID', 400,
    'snapshotId:agentId. Joins this row to its review job without the botId-and-createdon time window, which cannot separate two snapshots of the same agent.'),

  text('cat_agentreviewid', 'Agent review ID', 100, 'cat_agentreviews row holding the review JSON, stage detail and PDF.'),
  text('cat_agentreviewjobid', 'Agent review job ID', 100, 'cat_agentreviewjobs row that triggered Review Agent Components.'),
  text('cat_runtimeanalysisjobid', 'Runtime analysis job ID', 100, 'cat_runtimeanalysisjob row for this agent in this snapshot.'),

  choice('cat_reviewstatus', 'Review status',
    [[1, 'Pending'], [2, 'Running'], [3, 'Succeeded'], [4, 'Failed']]),

  integer('cat_score', 'Score', 0, 100, 'Derived cache of the referenced review, never the source of truth (FR-128).'),
  choice('cat_grade', 'Grade', GRADES, 'Derived cache of the referenced review, never the source of truth (FR-128).'),

  memo('cat_dismissedrules', 'Dismissed rules', 32768,
    'Rule instances the reviewer set aside for this agent, as a JSON array of {key, ruleId, reason, dismissedOn, dismissedBy}. Held here rather than inside the review payload so a reviewer can change their mind with one small write, and so an older snapshot keeps the judgement it was read under. Copied forward when the agent is reviewed again.'),

  {
    ...memo('cat_errormessage', 'Error message', 8192),
  },
];

/**
 * Agent rows are owned by their snapshot, so deletion cascades — unlike
 * `cat_agentreviews.cat_resultid`, which restricts to protect reviews that outlive a
 * snapshot as standalone history.
 */
export const agentSnapshotRelationship: Json = {
  '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
  SchemaName: `${AGENT_TABLE}_architecture_result`,
  ReferencedEntity: SNAPSHOT_TABLE,
  ReferencedAttribute: 'cat_architecturereviewresultid',
  ReferencingEntity: AGENT_TABLE,
  ReferencingEntityNavigationPropertyName: 'cat_resultid',
  ReferencedEntityNavigationPropertyName: `${AGENT_TABLE}_architecture_results`,
  AssociatedMenuConfiguration: { Behavior: 'DoNotDisplay', Group: 'Details', Order: 10000 },
  CascadeConfiguration: {
    Assign: 'NoCascade', Delete: 'Cascade', Merge: 'NoCascade',
    Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade',
  },
  Lookup: {
    '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
    ...attributeBase('cat_resultid', 'Architecture review snapshot',
      'Snapshot this agent was reviewed in. Required in practice; agent rows do not exist outside a snapshot.'),
  },
};
