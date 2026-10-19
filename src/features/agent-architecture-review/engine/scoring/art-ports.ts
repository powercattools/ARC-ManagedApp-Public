/**
 * The single point at which this engine depends on the Agent Review Tool (ART) in
 * `CopilotStudioKitMakers`.
 *
 * Legacy ART rubrics remain unchanged behind this boundary. The opt-in ARC2 native policy in
 * spec 022 deliberately has a separate versioned catalog/merger/scorer; it must never relabel
 * that result as an original ART rating or reinterpret a historical graded output as compact
 * exceptions. This seam reuses the established parsers, deterministic predicates and evidence
 * preparation without coupling the app to ART's generated client.
 *
 * Every cross-app import lives in this file so the dependency surface is declared once and stays
 * reviewable in one place, instead of being spread across `@art/...` paths in every module.
 *
 * ## What may be re-exported here
 *
 * Only the host-agnostic half of ART. Each module below takes its Dataverse access as an injected
 * port rather than importing a client, which is why ART exposes `*Core` modules (`AIServiceCore`,
 * `WorkflowReviewAiProviderCore`, `reviewAiPortCore`, `connectedAgentMapCore`): the pure half of a
 * service, importable by any host.
 *
 * Re-exporting the React-bound half instead — `hooks/`, `context/`, or the concrete `*Service`
 * singletons — would drag ART's `src/generated/**` client into this bundle.
 *
 * An earlier version of this note said that client is bound to ART's app identity and to data
 * sources "which do not exist in this app". That was measured and is false, and it is corrected
 * here rather than left to mislead: a generated service resolves its table by plain name
 * (`dataSourceName = 'cat_agentreviewses'`), and the `dataSourcesInfo` entry it reads carries only
 * that name and a primary key — `tableId` and `version` are empty strings, and there is no app id
 * and no connector GUID anywhere in it. This app binds the three Declarative Agent tables itself,
 * and its generated services and data-source entries are byte-identical to ART's.
 *
 * The real cost is narrower, and it is still reason enough. `dataSourcesInfo` is imported by
 * *relative* path, so a bound ART module pulled in here drags **Makers'** 5,839-line map — naming
 * some forty tables this app never binds — into this bundle, and stands up a second `getClient`
 * beside this app's own. Whether the SDK resolves that map lazily per table or validates it
 * eagerly is unverified. Using this app's own client costs nothing and leaves no such question
 * open, which is why the rule stands.
 *
 * ## Scope
 *
 * Copilot, standard and skill harnesses, per the one-harness-at-a-time rollout in
 * `specs/015-architectural-workbench/harness-copilot.md`, `harness-standard.md` and
 * `harness-skill.md`.
 *
 * Declarative agents are a fourth, deliberately narrower case, and D-12 has been partly superseded.
 * This app now *accepts a DA package and submits it for review*, so the reading half of the DA
 * surface — the zip type test and the package parser — is re-exported below.
 *
 * What has **not** changed is the scoring exclusion, and it is the half that matters. The scorer
 * behind this port still holds zero declarative-agent rules, so a DA subject reaching
 * `computeGroundedScore` would be measured against nothing and report a perfect result.
 * `assertScorableHarness` still turns that into a failure, and a DA review must never be routed
 * through it: a DA is graded by its own six-criterion rubric, on the cloud flow, exactly as it is
 * in ART.
 *
 * Nor does this file reach for `executeDAReviewPipeline`. That hook calls ART's `upsertDAReview`
 * unconditionally, which binds ART's generated client — the coupling described above. This engine
 * composes ART's *pure* DA stages against its own job port and its own persistence instead, which
 * is the same bargain already struck for the artifact AI stage below.
 *
 * Persistence is deliberately *not* a divergence. This engine writes the same `cat_agentreviews`
 * row ART does — same `cat_agenttype`, same `getDAIdentifier` dedupe key, same serialized payload —
 * through its own client. ART owns the shape; this app owns the client, so a package reviewed in
 * either app resolves to one row.
 */

// ---------------------------------------------------------------------- contracts

export { AI_MODEL_IDS, COMPLIANCE_CRITERIA } from '@art/contracts/Constants';
export type { ComplianceCriterion } from '@art/contracts/Constants';
export type {
  AgentSettings,
  BotComponent,
  BotComponentFetchOptions,
  BotSchemaMatch,
  ParsedBotData,
} from '@art/contracts/ServiceContracts';
export type {
  ReviewResult,
  ReviewAnalysisStatus,
  AgentsExperienceReviewPayload,
  CopilotReviewDisplayPayload,
} from '@art/contracts/ReviewResult';
export type { AgentsExperienceModel } from '@art/agents-experience/contracts/AgentsExperienceModel';
export type { NormalizedEvaluationEvidence } from '@art/agents-experience/contracts/EvaluationEvidence';
export type { GroundedSkillFinding } from '@art/agents-experience/contracts/Findings';
export type {
  RuleEvaluationResult, RuleEvaluationStatus,
} from '@art/agents-experience/contracts/Findings';
export type { SkillBundle, SkillResourceRow } from '@art/agents-experience/contracts/SkillBundle';
export type { AgentMapConnectedAgentSnapshot } from '@art/agents-experience/contracts/AgentMap';

// ------------------------------------------------------------------ job contracts

// `ReviewJobKind` and `corpusKindToJobKind` are the FR-134 bridge: the corpus names its shape as a
// string, the job row stores an option-set value, and this is the only sanctioned translation
// between the two. Writing a literal into `cat_jobkind` is what caused every artifact review to be
// mis-filed as a bundle review.
export {
  REVIEW_JOB_ENTITY_SET,
  REVIEW_JOB_ITEM_ENTITY_SET,
  ReviewJobStatus,
  ReviewJobItemStatus,
  ReviewJobKind,
  ReviewJobError,
  ReviewHarness,
  corpusKindToJobKind,
} from '@art/agents-experience/contracts/ReviewJob';
export type {
  AgentComponentResult,
  ReviewCorpus,
  ReviewCorpusKind,
  ReviewHarnessValue,
  ReviewJobItemRow,
  ReviewJobRow,
  ReviewJobSubmissionCorpus,
} from '@art/agents-experience/contracts/ReviewJob';

// --------------------------------------------------------------- capture / parsing

export { parseAgentsExperience } from '@art/agents-experience/services/AgentsExperienceParser';
export { unifiedInstructionRules } from '@art/agents-experience/services/rules/instructionRules';
export { unifiedSkillRules } from '@art/agents-experience/services/rules/skillRules';
export { standardNativeEvaluationRules } from '@art/agents-experience/services/rules/evaluationRules';
export { computeCoverage } from '@art/agents-experience/services/EvaluationCoverageService';
export {
  standardAgentsExperienceModel,
  standardCoverageModel,
} from '@art/agents-experience/services/standardModelProjection';

/**
 * The two `bots` columns Stage A cannot read raw.
 *
 * Extracted from `BotService` so this engine's transport can produce the same description and
 * settings the Agent Review Tool's own fetch produces. Both feed rules, so parsing them here by
 * hand is how the two products would start scoring the same agent differently.
 */
export { parseAgentDescription, parseAgentSettings } from '@art/utils/agentMetadata';
export { usesCopilotHarness } from '@art/agents-experience/services/detection';
export { normalizeResource } from '@art/agents-experience/services/skill/resourceNormalizer';
export { assembleSkillBundle } from '@art/agents-experience/services/skill/bundleAssembler';

// ------------------------------------------------------ connected agent discovery

// Bundle-safe half of `connectedAgentMapService`: takes the bot service as a parameter instead of
// importing the concrete singleton, which would pull ART's generated client into this bundle.
export { loadConnectedAgentMapSnapshotWith } from '@art/agents-experience/services/agent-map/connectedAgentMapCore';
export type { ConnectedAgentBotService } from '@art/agents-experience/services/agent-map/connectedAgentMapCore';

// ------------------------------------------------------------------- agent map

// The map itself reads nothing: it takes the persisted review payload and draws it. Its two live
// Dataverse reads — expanding a connected agent, and avatars — arrive as props, bound by whichever
// app renders it (see `AgentMapTabProps`). That is what keeps ART's generated client out of here.
export { AgentMapTab } from '@art/agents-experience/components/agent-map/AgentMapTab';
export type {
  AgentMapTabProps,
  ConnectedAgentQueryResult,
  UseConnectedAgentMap,
  LoadAgentMapIcons,
} from '@art/agents-experience/components/agent-map/AgentMapTab';

// ----------------------------------------------------------------- review engine

export { executeCopilotReview } from '@art/agents-experience/services/CopilotReviewService';
export type { ReviewAiPort } from '@art/agents-experience/services/CopilotReviewService';
export { computeDeterministicFindingsByBundle } from '@art/agents-experience/services/SkillBundleReviewService';
export { buildPersistedCopilotReview } from '@art/agents-experience/services/skill/persistedSkillReview';

// ------------------------------------------------------------ dismissed rules

// "Ignore this rule" is a scoring concern, so the rubric owns it: which key identifies an instance,
// what credit a set-aside rule earns back, and which dismissals survive a re-review are all ART's
// answers. This app stores the list and draws the buttons, and decides none of it.
export {
  carryForwardDismissals,
  componentRuleKey,
  dismissedKeys,
  parseDismissals,
  ruleKey,
  serializeDismissals,
  withDismissal,
  withoutDismissal,
} from '@art/agents-experience/services/dismissals';
export type { RuleDismissal } from '@art/agents-experience/services/dismissals';

// Re-scoring a stored review after a dismissal is still the rubric's arithmetic, so it stays ART's.
export { rescorePillars, rescoreGroundedScore } from '@art/agents-experience/services/scoring';
export type { RescoreInput, PillarBreakdown } from '@art/agents-experience/services/scoring';

// The live pillar scorer. Every harness reaches its composite through these two and no other
// arithmetic, which is what makes the single-scorer claim checkable rather than conventional.
export {
  computePillarBreakdown,
  computeGroundedScore,
  pillarForResult,
  ruleResultCredit,
  scoreLegacyDeterministicRules,
} from '@art/agents-experience/services/scoring';
export type { GroundedScoreInput } from '@art/agents-experience/services/scoring';

// ------------------------------------------------------------- review vocabulary

/**
 * The shared vocabulary — pillars, weights, severity, harness, grade bands.
 *
 * ART owns the rubric and this app reads it, which is already what `models/art.ts`
 * says. `review-core` is the one module both sides reach, so a weight or a
 * severity level exists once rather than twice in agreement.
 */
export {
  AGENT_PILLARS,
  AGENT_PILLAR_WEIGHTS,
  UNCONDITIONAL_AGENT_PILLARS,
  SKILL_DIMENSIONS,
  SKILL_DIMENSION_WEIGHTS,
  PILLAR_LABELS,
  LEGACY_PILLAR_NAME,
  PILLAR_FROM_LEGACY,
  toAgentPillar,
  SEVERITIES,
  SEVERITY_WEIGHT,
  SEVERITY_FROM_LEGACY,
  SEVERITY_TO_LEGACY,
  isSeverity,
  HARNESSES,
  AGENT_HARNESSES,
  SKILL_HARNESSES,
  EXTERNAL_HARNESSES,
  isHarness,
  isExternalHarness,
  assertScorableHarness,
  GRADE_BANDS,
  gradeForScore,
} from '@art/review-core';
export type {
  AgentPillar,
  SkillDimension,
  Pillar,
  LegacyPillarName,
  Severity,
  LegacyRuleSeverity,
  ArtifactFindingSeverity,
  Harness,
  ExternalHarness,
  Grade,
} from '@art/review-core';

/**
 * The rule registry itself. A rule's severity, pillar and tags are declared once, where the rule is
 * defined, and every scorer on both sides reads them from here rather than restating them.
 */
export { ruleById, rulesFor } from '@art/review-core';
export type { Rule, RuleId } from '@art/review-core';

// ----------------------------------------------------- standard harness rubric

/**
 * `extractStandardSnapshot`, never `StageAService`.
 *
 * The service adds exactly one thing — `executeStageA`, the Dataverse fetch — and that reaches
 * `src/generated/**`. The engine does not want the fetch anyway: it captures components up front so
 * a snapshot scores the bytes it froze, and hands them straight to the shared extractor the service
 * itself delegates to, so both tools parse and check identically.
 */
export { extractStandardSnapshot } from '@art/utils/standardSnapshot';
export type { StandardSnapshotMetadata } from '@art/utils/standardSnapshot';
export { parseStandardComponents } from '@art/utils/stageAParser';

export {
  UNIFIED_DETERMINISTIC_POLICY_VERSION,
  evaluateUnifiedRules,
  getUnifiedRuleCatalog,
} from '@art/agents-experience/services/UnifiedRuleEngine';
export { compareCapturedDeterministicReview } from '@art/agents-experience/services/UnifiedReviewComparison';
export { UNIFIED_COMPARISON_POLICY_VERSION } from '@art/agents-experience/services/UnifiedRuleEngine';
export type {
  UnifiedReviewComparison,
  UnifiedRuleChange,
} from '@art/agents-experience/contracts/UnifiedReviewComparison';
export type {
  UnifiedHarness,
  UnifiedOutcome,
  UnifiedSeverity,
  UnifiedRuleContext,
  UnifiedRuleAssessment,
  UnifiedRuleReport,
  UnifiedDeterministicScore,
} from '@art/agents-experience/contracts/UnifiedReview';

/**
 * The standard review workflow, as five pure steps.
 *
 * ART runs these from `StandardReviewWorkflowService`, which reaches Dataverse through its own
 * generated services. The steps themselves do not: a corpus is built from a snapshot, rows are
 * parsed against that corpus, and the parsed results are projected into the two stage outputs. The
 * engine supplies its own job I/O in between and gets an identical evaluation, which is the only
 * way a snapshot can carry the workflow's AI findings without ART's app identity.
 */
export { buildStandardReviewWorkflowCorpus } from '@art/utils/standardReviewCorpus';
export { STANDARD_WORKFLOW_RULES } from '@art/utils/standardReviewWorkflowRules';
export { resolveStandardRuleId } from '@art/agents-experience/services/standardRuleResults';
export { parseStandardReviewResultRows } from '@art/utils/standardReviewResultRows';
export { projectStandardReviewWorkflow } from '@art/utils/standardReviewWorkflowProjection';
export type { StandardReviewWorkflowEvaluation } from '@art/utils/standardReviewWorkflowProjection';
export { pollReviewJob } from '@art/agents-experience/services/jobs/reviewJobPolling';
export { STANDARD_REVIEW_UNIT_INDEX } from '@art/contracts/StandardReviewWorkflow';
export type {
  StandardReviewWorkflowCorpus,
  StandardReviewWorkflowProvenance,
  StandardReviewUnitIndex,
} from '@art/contracts/StandardReviewWorkflow';

/**
 * How that provenance record is read out loud.
 *
 * The engine writes `workflowProvenance`; this is the reading of it. It is imported rather than
 * reimplemented because both products have to describe the same record identically — a review whose
 * workflow returned nothing has to say so in the same words here as in the Agent Review Tool, or
 * the two tools disagree about whether the same saved review can be trusted.
 */
export { describeWorkflowOutcome } from '@art/utils/workflowOutcome';
export type { WorkflowOutcome, WorkflowOutcomeState } from '@art/utils/workflowOutcome';

/**
 * Everything the standard rubric decides after the workflow returns.
 *
 * The deterministic Stage A patterns are merged into the AI ones here, and the two scores are
 * derived from the merged list. Importing it is what keeps a snapshot's standard score identical to
 * the one ART would record for the same agent; recomputing any part of it here is how the two
 * products would start disagreeing.
 */
export { assembleStandardReviewResult } from '@art/utils/standardReviewAssembly';
/**
 * A snapshot's standard review is a real version in the agent's ART review history, so it has to
 * carry the same assessment identity an ART review would. Without it the next review of that agent
 * cannot use this one as its consistency baseline, and the run silently loses its comparison.
 */
export { tryBuildStandardReviewAssessmentIdentity } from '@art/utils/standardReviewConsistency';
export {
  getIssueCriterionId,
  getInstructionAssessments,
  getPatternAssessment,
  getPatternTopicAssessment,
} from '@art/utils/reviewAssessment';
export type {
  StandardReviewIdentity,
  StandardReviewWorkflowOutcome,
} from '@art/utils/standardReviewAssembly';

export type {
  ComplianceIssue,
  CriterionAssessment,
  InstructionEvaluation,
  LocalStageAOutput,
  Pattern,
  PatternEvaluation,
  PatternTopic,
} from '@art/contracts/StageOutputs';

// ---------------------------------------------------------- skill harness rubric

/**
 * The uploaded-artifact rubric, per `specs/015-architectural-workbench/harness-skill.md`.
 *
 * `reviewArtifact` is already dependency-injected — it takes `runAiStage`, `announce` and `now` as
 * parameters rather than importing a client — so the whole rubric is reachable from this host
 * without touching ART. Every module below is pure: contracts, rule groups and readers that take
 * their input as arguments.
 *
 * Deliberately absent: `artifactReviewStore`, `artifactAiStage`, `artifactReviewResume`, every
 * `hooks/*` and `context/*`, and every `components/*.tsx`. Each reaches ART's `src/generated/**`,
 * which binds to ART's app identity and its data sources; importing one would not fail the build,
 * it would fail at runtime as an unresolved data source. This engine supplies its own AI stage and
 * its own persistence instead.
 */

export { readUploadedArtifact, hashUploadedFile } from '@art/skills-automations/services/artifactReader';
export { detectArtifactKind } from '@art/skills-automations/services/artifactDetector';
export { reviewArtifact } from '@art/skills-automations/services/artifactReviewService';
export type {
  ArtifactReviewDeps,
  ArtifactReviewRequest,
} from '@art/skills-automations/services/artifactReviewService';

/**
 * The AI judgement stage, minus its host binding.
 *
 * `createArtifactAiStage` — ART's own entry point — builds its ports from ART's generated client and
 * names the upload by its content hash. Both are wrong here, so this engine binds the same core to
 * its own job port and its own subject id. Everything the stage *decides* — grounding a finding
 * against the uploaded bytes, dropping the uncorroborated ones, combining portions — stays in ART.
 */
export { createArtifactAiStageCore } from '@art/skills-automations/services/artifactAiStageCore';
export type {
  ArtifactAiStageProgress,
  ArtifactWorkflowBinding,
  ArtifactWorkflowContext,
} from '@art/skills-automations/services/artifactAiStageCore';

export { toSkillBundle, SYNTHETIC_ID_PREFIX } from '@art/skills-automations/services/uploadBundleAdapter';
export { findFile, parseFrontmatter, readString } from '@art/skills-automations/services/artifactUtils';

// ------------------------------------------------------------- declarative agent

/**
 * The declarative-agent package reader.
 *
 * Three pure modules, each depending on nothing but `jszip`, `js-yaml` and ART's own contracts.
 * They answer "is this a DA package?" and "what is in it?", which is all this engine needs to put a
 * DA upload in front of a reviewer. `parseDAZip` returns exactly the three values the review stages
 * consume — `manifest`, `packageEvidence`, `skillBundles` — so nothing downstream has to re-read
 * the archive.
 *
 * `getDAIdentifier` is the subject id ART itself stamps on a DA review: the manifest's `appId` when
 * it has one, and a SHA-256 over the stable manifest fields when it does not. Deriving it here
 * rather than inventing one is what lets a package reviewed in either app resolve to the same row.
 *
 * Deliberately absent, and they must stay absent: `DAReviewService` (binds
 * `Cat_agentreviewsesService`), `DAEvaluationService` (binds `MicrosoftDataverseService`, and is
 * unreachable on the zip path anyway — a package always carries evidence, so the workflow branch
 * always wins), and `useDAReviewMutation` itself.
 *
 * That absent list is complete rather than a guess: of the thirty-four modules in ART's
 * `declarative-agent/` tree, exactly two import from `src/generated/**`, and they are the two
 * named above. Everything else is pure, which is what makes the rest of this section possible.
 */
export { detectZipType } from '@art/declarative-agent/utils/zipTypeDetector';
export type { ZipType } from '@art/declarative-agent/utils/zipTypeDetector';
export { parseDAZip } from '@art/declarative-agent/utils/zipParser';
export { getDAIdentifier } from '@art/declarative-agent/utils/daIdGenerator';
export type { DAManifest } from '@art/declarative-agent/contracts/DAManifest';
export type { DAPackageEvidence } from '@art/declarative-agent/contracts/DAPackageReview';

/**
 * The declarative-agent review stages, in pipeline order.
 *
 * Six pure functions plus the job contract. Each takes its input and returns its output; none
 * reaches Dataverse, so this engine runs ART's rubric unchanged against its own transport and its
 * own persistence. Reusing them is the whole point — a DA review here must be the same review,
 * not a second opinion that happens to look similar.
 *
 * `evaluateDAWorkflowRequest` is the injection point. It takes a `DAWorkflowTransport`, which is
 * where this engine supplies its own job port in place of ART's `executeDAReviewJob`, and it
 * verifies the rows that come back against the request it sent before projecting an evaluation.
 *
 * `buildDAReviewJobCorpus` and `parseDAReviewJobRows` are the two halves of the job contract: the
 * corpus a submission writes, and the rejection ladder that reads the rows back. They are
 * re-exported rather than reimplemented precisely so the two apps cannot drift on either shape.
 * The ladder matters more than it looks: it is what stops a rule that was never really evaluated
 * from being read as a rule that passed.
 *
 * Absent by design, beyond the two bound services above: `evaluateDA`, which is ART's AI Builder
 * stage and is unreachable on the zip path, and `reviewDACustomSkills`, which is deferred — a DA
 * package shipping skill bundles gets the six-criterion rubric only, for now.
 */
export { runManifestHealthCheck } from '@art/declarative-agent/utils/manifestHealthCheck';
export { runDAPackageValidation } from '@art/declarative-agent/utils/packageValidation';
export { buildDAWorkflowRequest } from '@art/declarative-agent/services/DAWorkflowContractService';
export { evaluateDAWorkflowRequest } from '@art/declarative-agent/services/DAWorkflowEvaluationService';
export { applyDAEvaluationApplicability } from '@art/declarative-agent/utils/evaluationApplicability';
export { calculateDAScore } from '@art/declarative-agent/utils/scoreCalculator';
export {
  buildDAReviewJobCorpus,
  parseDAReviewJobRows,
} from '@art/declarative-agent/services/daReviewJobContract';

/**
 * How a finished DA review becomes a row in the shared `cat_agentreviews` table.
 *
 * ART's own mapping, imported rather than reproduced, for the same reason `buildReviewRecord` is
 * on the skills path: a declarative agent reviewed inside a snapshot and the same package reviewed
 * in the Agent Review Tool are one record in one table, discriminated by `cat_agenttype`. Writing
 * the option-set value, the completed status code, the issue count or the score column by hand here
 * would drift the first time any of them changed there.
 *
 * `serializeDAReviewResult` is the blob half — sanitised, secret-redacted and compacted against the
 * Dataverse column limit — and `buildDAReviewRecord` calls it, so a caller that wants the whole row
 * needs only the one function. Both come from `daReviewRecordContract`, which was split out of
 * `DAReviewService` precisely so a host without ART's generated client could still reach them.
 */
export {
  buildDAReviewRecord,
  countReviewIssues,
  parseDAReviewResult,
  serializeDAReviewResult,
} from '@art/declarative-agent/services/daReviewRecordContract';
export type { DAStoredReviewData } from '@art/declarative-agent/services/daReviewRecordContract';
export {
  AGENT_TYPE,
  CRITERION_WEIGHTS,
  DA_SCORE_THRESHOLDS,
} from '@art/declarative-agent/contracts/constants';

export type {
  DAWorkflowTransport,
  DAWorkflowTransportResult,
} from '@art/declarative-agent/services/DAWorkflowEvaluationService';
export type {
  DAReviewJobComponent,
  DAReviewJobCorpus,
  DAReviewJobItemPayload,
  ParsedDAReviewJobRows,
} from '@art/declarative-agent/services/daReviewJobContract';
export type {
  DARejectedWorkflowOutcome,
  DASemanticCriterion,
  DAWorkflowOutcome,
  DAWorkflowProvenance,
  DAWorkflowRequest,
  DAWorkflowResponse,
} from '@art/declarative-agent/contracts/DAWorkflowReview';
export type {
  AssessmentNote,
  CriterionResult,
  DAEvaluationResult,
  EvaluationIssue,
  EvaluationMethod,
  EvaluationStatus,
  IssueSeverity,
  PassingCheck,
} from '@art/declarative-agent/contracts/DAEvaluationResult';

/**
 * The declarative-agent score rail, and the criterion labels that name its parts.
 *
 * A declarative agent is not graded on the six agent pillars — it has its own six weighted criteria
 * (`CRITERION_WEIGHTS`), and `assertScorableHarness` throws if a DA subject is routed through the
 * agent scorer. `buildDAScoreBreakdown` is ART's own projection of that rubric: it resolves each
 * criterion's label, its configured weight, and the effective weight once an unassessed criterion
 * has left the denominator. Importing it keeps one set of labels and one set of weights; writing
 * either out here would drift the first time the rubric is retuned.
 */
export { buildDAScoreBreakdown } from '@art/declarative-agent/adapters/daScoreBreakdown';
export type { DAScoreBreakdownPart } from '@art/declarative-agent/adapters/daScoreBreakdown';

/**
 * The two halves of a finding's remediation text.
 *
 * A DA recommendation is one string that packs the action, an example and a verification step
 * behind the literal markers `Example:` and `How to verify:`. The findings drawer has separate
 * places for the fix and for the check that proves it, so the string has to be split rather than
 * dumped into one field — and the split is ART's, so the markers stay in one place.
 */
export { splitRecommendation } from '@art/declarative-agent/utils/packageRemediation';
export type { RecommendationParts } from '@art/declarative-agent/utils/packageRemediation';

/**
 * Documentation links for a declarative-agent finding.
 *
 * Model-supplied URLs are never trusted: `guidanceLinks` resolves an issue to an allow-listed Learn
 * page, returning nothing when it cannot. Pure — it reads only the DA contracts and the Learn doc
 * table — so it is safe on this seam.
 */
export { distinctGuidanceLinks, issueGuidanceLink } from '@art/declarative-agent/utils/guidanceLinks';
export type { ManifestHealthCheck } from '@art/declarative-agent/contracts/ManifestHealthCheck';
export type {
  DAEvidenceRecord,
  DAPackageFinding,
  DAPackageValidation,
} from '@art/declarative-agent/contracts/DAPackageReview';
export type { DAReviewRecord } from '@art/declarative-agent/contracts/DAReviewRecord';

export {
  effectiveWeights,
  hasScore,
  overallScoreOf,
} from '@art/skills-automations/services/artifactScore';

// How an artifact review becomes a row in the shared `cat_agentreviews` table. ART's own mapping,
// imported rather than reproduced: a snapshot's skill review and an Agent Review Tool skill review
// are the same record, and hand-writing `cat_agenttype`, the status codes or the score column here
// would drift the first time any of them changed there. `artifactReviewStore` — which owns the
// requests — is not importable, because it reaches for ART's generated client.
export {
  artifactReviewKey,
  buildReviewRecord,
  keyForResult,
} from '@art/skills-automations/services/artifactReviewRecord';

// The runtime choice is a form field rather than something detected, because it cannot be detected:
// a SKILL.md carries no marker naming its target platform. These are the helpers that gate the
// choice against the file actually chosen, so the two decisions can be made in either order.
export {
  describeUnsupportedUpload,
  reconcileRuntimes,
  runtimesForFile,
} from '@art/skills-automations/services/runtimeApplicability';
export { describeRuntimeCoverage, resolveCatalogue } from '@art/skills-automations/data/catalogueResolver';

// The rubric's own vocabulary. Imported rather than restated so a dimension renamed or reweighted
// in ART reads the same here: a score card that labels a dimension differently from the tool that
// produced the score is a card the reader cannot reconcile with the report.
export {
  ARTIFACT_KIND_LABELS,
  RECOMMENDATION_LABELS,
  RUBRIC_DIMENSION_DESCRIPTIONS,
  RUBRIC_DIMENSION_IMPROVEMENTS,
  RUBRIC_DIMENSION_LABELS,
  RUNTIME_VERDICT_LABELS,
  TARGET_RUNTIMES,
  RUNTIME_LABELS,
  RUBRIC_DIMENSION_WEIGHTS,
} from '@art/skills-automations/contracts/ArtifactReview';
export type {
  ArtifactDetection,
  ArtifactFinding,
  ArtifactKind,
  ArtifactReviewProgress,
  ArtifactReviewResult,
  ArtifactRecommendation,
  ReviewedFile,
  RubricDimensionId,
  RubricDimensionScore,
  RuntimeVerdict,
  RuntimeVerdictValue,
  TargetRuntime,
  UploadedArtifact,
  UploadedFile,
} from '@art/skills-automations/contracts/ArtifactReview';

// --------------------------------------------------------------------- AI ports
export { AIServiceCore } from '@art/services/AIServiceCore';
export type { PredictResult, PredictTransport, ReviewModelIds } from '@art/services/AIServiceCore';
export { WorkflowReviewAiProviderCore } from '@art/agents-experience/services/ai-providers/WorkflowReviewAiProviderCore';
export {
  bindPromptReviewAiPort,
  bindWorkflowReviewAiPort,
  WORKFLOW_SERVED_MODEL_ID,
} from '@art/agents-experience/services/ai-providers/reviewAiPortCore';

// ------------------------------------------------------------- skill evaluator

/**
 * ART's per-skill rubric — the numbers, not the screen.
 *
 * A skill inside a Copilot agent is scored by ART's LLM-as-judge across four dimensions, with an
 * upload-safety scan and four qualified bundle scores. This app draws that in its own drawer, so it
 * imports the view model and the band helpers and renders them with its own components. What it
 * must never do is re-derive a percent, a band or a weakest dimension: two renderings of one
 * judgement must not be able to disagree.
 */
export { buildReviewViewModel } from '@art/agents-experience/components/viewModel';
/**
 * ART's spelling of a model series — `Sonnet46` reads as `claude-sonnet-4.6`.
 *
 * Imported rather than reimplemented so the summary bar here names a model exactly the way ART's
 * own report does. Two spellings of one model is the kind of difference a reader reads as two
 * different models.
 */
export { prettyModelSeries } from '@art/agents-experience/services/modelDisplay';
/** ART's duration wording — `1m 5s` — so a review's runtime reads the same in both products. */
export { formatDuration } from '@art/utils/dateUtils';
export {
  skillScorePercent,
  weakestDimension,
  scoreBand,
  dimensionBand,
  normalizedDimensionScore,
  evaluationStateLabel,
} from '@art/agents-experience/components/skillHelpers';
export type { ReviewViewModel, SkillView, SkillDimensionView, QualifiedScoreView } from '@art/agents-experience/components/viewTypes';

/**
 * The file inventory behind a skill's Files tab.
 *
 * Which file carries retained source, and why one does not, is a property of how ART persisted the
 * review — not of how this app draws it. `buildSkillFileExplorerModel` already joins the manifest,
 * the analyses and the source files, resolves duplicate and legacy paths, and attaches SKILL.md's
 * retained text; `definitionUnavailableText` states the one true reason that text is missing. Both
 * are imported rather than re-derived so the drawer cannot contradict ART about what was stored.
 */
export {
  buildSkillFileExplorerModel,
  resolveSelectedSkillFile,
} from '@art/agents-experience/components/skills/skillFileExplorerModel';
export { definitionUnavailableText } from '@art/agents-experience/components/skills/SkillFileDetail';
export type {
  SkillFileExplorerEntry,
  SkillFilesExplorerModel,
} from '@art/agents-experience/components/skills/skillFileExplorerTypes';

// ------------------------------------------------------------- jobs / persistence

export {
  buildCorpusComponent,
  buildReviewCorpus,
  collectConfiguredCapabilities,
} from '@art/agents-experience/services/jobs/reviewCorpusBuilder';
export { redactSecrets } from '@art/agents-experience/services/skill/resourceScanners';
export {
  mapReviewJobItems,
  isComponentRow,
  safeParse,
  AGENT_LEVEL_INDEX,
  RESOURCE_INDEX_BASE,
} from '@art/agents-experience/services/jobs/reviewJobMapping';
// Crosses the seam beside `mapReviewJobItems` because it is that function's
// parameter. ARC2 declares its own identical union for the AI workflow contract;
// taking ART's here keeps the argument tied to the function that consumes it.
export type { NodeKind } from '@art/review-core/rule';
export { serializeReviewRecord } from '@art/services/reviewRecordSerializer';
export { parsePersistedCopilotPayload } from '@art/agents-experience/utils/persistedCopilotReviewGuard';
