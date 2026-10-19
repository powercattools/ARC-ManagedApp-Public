/**
 * Dataverse-backed implementation of the review repository.
 *
 * Reviews live in `cat_architecturereview`, their graded snapshots in
 * `cat_architecturereviewresult`. The async signatures, filter arguments and
 * returned shapes are unchanged from the seeded implementation this replaced,
 * so the hooks and UI did not move with it.
 *
 * `currentScore`, `currentGrade`, `lastRun` and `numberOfResults` are derived
 * from the result rows on read rather than stored on the review, so they cannot
 * drift out of sync with the snapshots they summarise (the reasoning OQ-40
 * applies to `ResultTrend`).
 */

import { Cat_architecturereviewsService } from '../../../data';
import { Cat_architecturereviewresultsService } from '../../../data';
import { SystemusersService } from '../../../data';
import type { Cat_architecturereviews } from '../../../data/models/Cat_architecturereviewsModel';
import type { Cat_architecturereviewresults } from '../../../data/models/Cat_architecturereviewresultsModel';
import type { Systemusers } from '../../../data/models/SystemusersModel';
import {
  ASSET_TYPE_LABELS,
  type AssetType,
  type CreatedReview,
  type CreateReviewInput,
  type HarnessName,
  type LifecycleStatus,
  type Review,
  type ReviewAgainInput,
  type ReviewResult,
  gradeForScore,
  isUploadAssetType,
} from '../models/review';
import { ORCHESTRATED_RULE_PACK, snapshotRequest } from './snapshot-orchestration';
import { harnessBySnapshot, subjectBySnapshot, type SnapshotSubject } from './snapshot-harness';

/**
 * What a snapshot saved before orchestration is assumed to have been graded by.
 *
 * Read fallbacks only — nothing writes these. Every snapshot this app creates now records
 * `architecture-orchestration` because a real run produced it.
 */
const LEGACY_RULE_PACK_NAME = 'MS-default';
const LEGACY_RULE_PACK_VERSION = 'v1.2.0';

/** Choice values, mirroring the option sets created on the two tables. */
const ASSET_TYPE_BY_CHOICE: Record<number, AssetType> = {
  1: 'copilot-studio-agent',
  2: 'declarative-agent',
  3: 'skill',
};
const CHOICE_BY_ASSET_TYPE: Record<AssetType, number> = {
  'copilot-studio-agent': 1,
  'declarative-agent': 2,
  skill: 3,
};
const STATUS_BY_CHOICE: Record<number, LifecycleStatus> = { 1: 'active', 2: 'inactive' };
const CHOICE_BY_STATUS: Record<LifecycleStatus, number> = { active: 1, inactive: 2 };

/**
 * Whole-number and lookup columns arrive as strings from the connector, so every
 * numeric read goes through here rather than being trusted as a number.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `getAll` returns the array directly; the raw Web API shape nests it under `value`. */
function rowsOf<T>(result: unknown): T[] {
  const data = (result as { data?: T[] | { value?: T[] } } | undefined)?.data;
  if (Array.isArray(data)) return data;
  const nested = (data as { value?: T[] } | undefined)?.value;
  return Array.isArray(nested) ? nested : [];
}

/** Escapes a user-supplied value for an OData string literal. */
function odataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The owner's display name is only carried on the formatted-value annotation,
 * which the generated table client does not request, so `owneridname` is always
 * absent despite being declared on the generated model. The lookup id is
 * present, so names are resolved separately — once per owner, cached for the
 * session, and treated as cosmetic if the call fails.
 */
const ownerNameCache = new Map<string, string>();

function ownerIdOf(row: Cat_architecturereviews): string {
  return (row as unknown as { _ownerid_value?: string })._ownerid_value ?? '';
}

async function resolveOwnerNames(ids: string[]): Promise<void> {
  const missing = [...new Set(ids.filter((id) => id && !ownerNameCache.has(id)))];
  if (missing.length === 0) return;

  try {
    const response = await SystemusersService.getAll({
      select: ['systemuserid', 'fullname'],
      filter: missing.map((id) => `systemuserid eq ${id}`).join(' or '),
    });
    for (const user of rowsOf<Systemusers>(response)) {
      if (user.systemuserid) ownerNameCache.set(user.systemuserid, user.fullname ?? 'Unknown');
    }
  } catch {
    // A display name is not worth failing the page over.
  }
}


/** The snapshot the grid summarises: the newest Active one, or simply the newest (FR-116). */
function newestResult(resultRows: readonly ReviewResult[]): ReviewResult | undefined {
  const ordered = [...resultRows].sort((a, b) => b.sequenceNumber - a.sequenceNumber);
  return ordered.find((result) => result.status === 'active') ?? ordered[0];
}

/** Maps a Dataverse review row plus its result rows onto the UI model. */
function toReview(
  row: Cat_architecturereviews,
  resultRows: ReviewResult[],
  harnesses: Map<string, HarnessName>,
): Review {
  const newest = newestResult(resultRows);

  return {
    id: row.cat_architecturereviewid,
    projectName: row.cat_projectname ?? '(untitled review)',
    assetType: ASSET_TYPE_BY_CHOICE[num(row.cat_assettype) ?? 1] ?? 'copilot-studio-agent',
    status: STATUS_BY_CHOICE[num(row.cat_status) ?? 1] ?? 'active',
    ownerName: ownerNameCache.get(ownerIdOf(row)) ?? 'Unknown',
    createdOn: row.createdon ?? new Date().toISOString(),
    currentScore: newest?.score ?? null,
    currentGrade: newest?.grade ?? null,
    currentResultId: newest?.id ?? null,
    targetComponentCount: num(row.cat_targetcomponentcount) ?? 0,
    lastRun: newest?.runTimestamp ?? null,
    numberOfResults: resultRows.length,
    ...(newest && harnesses.has(newest.id) ? { harness: harnesses.get(newest.id)! } : {}),
    environmentUrl: row.cat_environmenturl || undefined,
    environmentName: row.cat_environmentname || undefined,
    botId: row.cat_botid || undefined,
    botName: row.cat_botname || undefined,
  };
}

/** Maps a Dataverse result row onto the UI model. */
function toResult(row: Cat_architecturereviewresults): ReviewResult {
  const score = num(row.cat_score);
  const snapshotDate = (value: string | undefined) => {
    if (!value) return undefined;
    if (row.cat_rulepackname !== ORCHESTRATED_RULE_PACK) return value;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
  };
  return {
    id: row.cat_architecturereviewresultid,
    reviewId: row._cat_reviewid_value ?? '',
    sequenceNumber: num(row.cat_sequencenumber) ?? 0,
    score,
    // Derived, never read back from `cat_grade`. A stored letter is a copy of a number that is right
    // here in the same row, and the two drift the moment the bands move — so the column is left to
    // whatever history put in it and the score is the only thing that decides.
    grade: score === null ? null : gradeForScore(score),
    status: STATUS_BY_CHOICE[num(row.cat_status) ?? 1] ?? 'active',
    runTimestamp: row.cat_runtimestamp ?? row.createdon ?? new Date().toISOString(),
    rulePackName: row.cat_rulepackname ?? LEGACY_RULE_PACK_NAME,
    rulePackVersion: row.cat_rulepackversion ?? LEGACY_RULE_PACK_VERSION,
    artifactFileName: row.cat_artifactfilename || undefined,
    artifactVersion: num(row.cat_artifactversion) ?? undefined,
    transcriptStart: snapshotDate(row.cat_transcriptstart),
    transcriptEnd: snapshotDate(row.cat_transcriptend),
  };
}

/** Fetches every result for the given review ids in one call, grouped by review. */
async function resultsByReview(reviewIds: string[]): Promise<Map<string, ReviewResult[]>> {
  const grouped = new Map<string, ReviewResult[]>();
  if (reviewIds.length === 0) return grouped;

  const filter = reviewIds.map((id) => `_cat_reviewid_value eq ${id}`).join(' or ');
  const response = await Cat_architecturereviewresultsService.getAll({ filter });

  for (const row of rowsOf<Cat_architecturereviewresults>(response)) {
    const result = toResult(row);
    if (!result.reviewId) continue;
    const bucket = grouped.get(result.reviewId);
    if (bucket) bucket.push(result);
    else grouped.set(result.reviewId, [result]);
  }
  return grouped;
}


export interface ReviewFilters {
  search?: string;
  assetType?: string;
  status?: string;
}

/**
 * The harness of the snapshot each review is summarised by.
 *
 * A failure here costs a label, not the page: the Harness column falls back to the asset type, which
 * is what it showed before the column could be answered at all. Losing the whole grid because a
 * refinement of one cell could not be read would be the worse trade.
 */
async function harnessesFor(
  reviewRows: readonly Cat_architecturereviews[],
  grouped: Map<string, ReviewResult[]>,
): Promise<Map<string, HarnessName>> {
  const snapshotIds = reviewRows
    .map((row) => newestResult(grouped.get(row.cat_architecturereviewid) ?? [])?.id)
    .filter((id): id is string => Boolean(id));

  return harnessBySnapshot(snapshotIds).catch(() => new Map<string, HarnessName>());
}

export const reviewService = {
  async listReviews(filters: ReviewFilters = {}): Promise<Review[]> {
    const clauses: string[] = [];
    const search = filters.search?.trim();
    if (search) clauses.push(`contains(cat_projectname,'${odataLiteral(search)}')`);
    if (filters.assetType && filters.assetType !== 'all') {
      const choice = CHOICE_BY_ASSET_TYPE[filters.assetType as AssetType];
      if (choice) clauses.push(`cat_assettype eq ${choice}`);
    }
    if (filters.status && filters.status !== 'all') {
      const choice = CHOICE_BY_STATUS[filters.status as LifecycleStatus];
      if (choice) clauses.push(`cat_status eq ${choice}`);
    }

    const response = await Cat_architecturereviewsService.getAll({
      filter: clauses.length > 0 ? clauses.join(' and ') : undefined,
      orderBy: ['createdon desc'],
    });
    const rows = rowsOf<Cat_architecturereviews>(response);

    // One extra call for every result row on the page, rather than one per
    // review, so the grid stays at two round trips regardless of row count.
    const grouped = await resultsByReview(rows.map((row) => row.cat_architecturereviewid));
    const [harnesses] = await Promise.all([
      harnessesFor(rows, grouped),
      resolveOwnerNames(rows.map(ownerIdOf)),
    ]);

    return rows
      .map((row) => toReview(row, grouped.get(row.cat_architecturereviewid) ?? [], harnesses))
      .sort((a, b) => (b.lastRun ?? '').localeCompare(a.lastRun ?? ''));
  },

  async getReview(id: string): Promise<Review | undefined> {
    const response = await Cat_architecturereviewsService.get(id);
    const row = (response as { data?: Cat_architecturereviews } | undefined)?.data;
    if (!row) return undefined;

    const grouped = await resultsByReview([id]);
    const [harnesses] = await Promise.all([
      harnessesFor([row], grouped),
      resolveOwnerNames([ownerIdOf(row)]),
    ]);
    return toReview(row, grouped.get(id) ?? [], harnesses);
  },

  /** Newest first, matching the detail page's descending timeline. */
  async listResults(reviewId: string): Promise<ReviewResult[]> {
    const response = await Cat_architecturereviewresultsService.getAll({
      filter: `_cat_reviewid_value eq ${reviewId}`,
      orderBy: ['cat_sequencenumber desc'],
    });
    const results = rowsOf<Cat_architecturereviewresults>(response)
      .map(toResult)
      .sort((a, b) => b.sequenceNumber - a.sequenceNumber);

    // Stamped from the parent agent rows so the timeline can tell a genuine trend from two
    // unrelated scores. A failure costs the warning, not the timeline: without subject ids nothing
    // contradicts anything and comparison behaves exactly as it did before they were recorded.
    const subjects = await subjectBySnapshot(results.map((result) => result.id)).catch(
      () => new Map<string, SnapshotSubject>(),
    );
    return results.map((result) => {
      const agentId = subjects.get(result.id)?.agentId;
      return agentId ? { ...result, subjectId: agentId } : result;
    });
  },

  /** One snapshot, for the result detail page. */
  async getResult(resultId: string): Promise<ReviewResult | undefined> {
    const response = await Cat_architecturereviewresultsService.get(resultId);
    const row = (response as { data?: Cat_architecturereviewresults } | undefined)?.data;
    return row ? toResult(row) : undefined;
  },

  /** Creates the review and its first result (snapshot) in one operation. */
  async createReview(input: CreateReviewInput): Promise<CreatedReview> {
    const orchestratedAgent = input.assetType === 'copilot-studio-agent';
    // An upload is orchestrated only once its bytes are in hand. The dialog reads and validates the
    // file before it gets here, so a package that is present has already been shown to hold
    // something reviewable — and one that is absent must not create a snapshot to sit empty. Either
    // field satisfies it: a skill bundle arrives read into an artifact, a declarative agent arrives
    // as the file itself, and both are the same claim that there is something to review.
    const orchestratedUpload =
      isUploadAssetType(input.assetType) && Boolean(input.artifact || input.declarativeAgent);
    if (!orchestratedAgent && !orchestratedUpload) {
      throw new Error('Attach the artifact to review before creating this review.');
    }
    // Only an agent snapshot has a request to validate. An upload has no bot id and no transcript
    // window, so putting it through this validator would fail on fields it is right not to carry.
    if (orchestratedAgent) await snapshotRequest(input, { id: crypto.randomUUID(), ...input });
    const now = new Date().toISOString();

    const created = await Cat_architecturereviewsService.create({
      cat_projectname: input.projectName,
      cat_assettype: CHOICE_BY_ASSET_TYPE[input.assetType] as never,
      cat_status: CHOICE_BY_STATUS.active as never,
      cat_targetcomponentcount: '1',
      cat_environmenturl: input.environmentUrl,
      cat_environmentname: input.environmentName,
      cat_botid: input.botId,
      cat_botname: input.botName,
    } as never);

    const row = (created as { data?: Cat_architecturereviews } | undefined)?.data;
    const reviewId = row?.cat_architecturereviewid;
    if (!reviewId) throw new Error('Dataverse did not return the created review.');

    const createdResult = await Cat_architecturereviewresultsService.create({
      cat_resultname: `${input.projectName}, run 1`,
      'cat_ReviewId@odata.bind': `/cat_architecturereviews(${reviewId})`,
      cat_sequencenumber: '1',
      // No score is written here. The run reports one when it has measured it; until then an empty
      // column is the only truthful thing to leave behind.
      cat_status: CHOICE_BY_STATUS.active as never,
      cat_runtimestamp: now,
      cat_rulepackname: ORCHESTRATED_RULE_PACK,
      cat_rulepackversion: '1',
      cat_artifactfilename: input.artifactFileName,
      cat_artifactversion: input.artifactFileName ? '1' : undefined,
      cat_transcriptstart: input.transcriptStart,
      cat_transcriptend: input.transcriptEnd,
    } as never);

    const resultRow = (createdResult as { data?: Cat_architecturereviewresults } | undefined)?.data;
    if (!resultRow) throw new Error('Dataverse did not return the created result.');

    const result = toResult(resultRow);
    // A review created a moment ago has no agent rows yet, so its harness is genuinely unknown.
    return { review: toReview(row, [result], new Map()), result };
  },

  /**
   * Appends another result and deactivates the previous ones, so exactly one
   * result is Active at any time (FR-116).
   *
   * The transcript date range is stored on the result rather than the review, because each snapshot is a
   * reading over its own window — a re-review that narrowed the range must not appear to restate what an
   * earlier, wider one measured.
   */
  async reviewAgain(reviewId: string, input: ReviewAgainInput = {}): Promise<ReviewResult> {
    const review = await reviewService.getReview(reviewId);
    const orchestratedAgent = review?.assetType === 'copilot-studio-agent';
    // An upload re-review is orchestrated on exactly the same terms as a first review: the bytes
    // are in hand. Without them there is nothing to re-read, and a snapshot saved anyway would be a
    // re-review that never happened.
    const orchestratedUpload =
      Boolean(review && isUploadAssetType(review.assetType))
      && Boolean(input.artifact || input.declarativeAgent);
    if (!orchestratedAgent && !orchestratedUpload) {
      throw new Error('Attach the artifact to review again.');
    }
    // Only an agent snapshot has a transcript window to validate; an upload has none to request.
    if (orchestratedAgent && review) await snapshotRequest(review, { id: crypto.randomUUID(), ...input });
    const existing = await reviewService.listResults(reviewId);
    const nextSequence = existing.length + 1;
    const now = new Date().toISOString();
    const priorUploads = existing.filter((result) => result.artifactFileName).length;

    await Promise.all(
      existing
        .filter((result) => result.status === 'active')
        .map((result) =>
          Cat_architecturereviewresultsService.update(result.id, {
            cat_status: CHOICE_BY_STATUS.inactive as never,
          } as never),
        ),
    );

    const created = await Cat_architecturereviewresultsService.create({
      cat_resultname: `Run ${nextSequence}`,
      'cat_ReviewId@odata.bind': `/cat_architecturereviews(${reviewId})`,
      cat_sequencenumber: String(nextSequence),
      // As on create: the run owns the score, so none is written here.
      cat_status: CHOICE_BY_STATUS.active as never,
      cat_runtimestamp: now,
      cat_rulepackname: ORCHESTRATED_RULE_PACK,
      cat_rulepackversion: '1',
      cat_artifactfilename: input.artifactFileName,
      cat_artifactversion: input.artifactFileName ? String(priorUploads + 1) : undefined,
      cat_transcriptstart: input.transcriptStart,
      cat_transcriptend: input.transcriptEnd,
    } as never);

    const row = (created as { data?: Cat_architecturereviewresults } | undefined)?.data;
    if (!row) throw new Error('Dataverse did not return the created result.');
    return toResult(row);
  },
};
