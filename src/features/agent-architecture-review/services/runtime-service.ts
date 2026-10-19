/**
 * Drives the agent runtime (transcript) analysis.
 *
 * The heavy lifting happens server-side. `AnalyzeAgentRuntimePlugin` is an async Dataverse plugin that
 * scans `conversationtranscript` in bounded chunks and folds the result into one job row; this service
 * only queues that row, follows it, and reads the report off the end. Nothing is parsed in the browser —
 * a run can cover tens of thousands of transcripts (10,010 in ~50s against kit-dev), which is not work a
 * tab should be doing.
 *
 * Three things here are easy to get wrong and are therefore deliberate:
 *
 * 1. **Resuming writes `Running`, never `Paused`.** The plugin can only chain a handful of executions
 *    before Dataverse's depth limit stops it, so it parks the job as `Paused` and waits. That park is
 *    itself a write, and it re-fires the plugin's own update step. If `Paused` were also the resume
 *    signal, the run would immediately re-enter the chain it parked to escape and be killed. Writing
 *    `Running` starts a fresh pipeline at depth 1.
 *
 * 2. **Failures are classified, not swallowed.** The proof-of-concept collapsed every error into
 *    "no transcripts", which hides the two cases the user can actually act on — recording switched off,
 *    and not holding read privileges on the transcript table.
 *
 * 3. **Only the newest analysis per snapshot survives.** Superseded runs are deleted on start rather than
 *    left to accumulate, because a stale runtime report next to a fresh one is worse than no report.
 *
 * An analysis belongs to a **review result** (a snapshot), never to the review as a whole. A result is a
 * reading over one date range at one moment, which is exactly what an analysis is; hanging it off the
 * review would let a later re-review silently overwrite the evidence behind an earlier snapshot.
 */

import { Cat_runtimeanalysisjobsService, MicrosoftDataverseService } from '../../../data';
import type { Cat_runtimeanalysisjobs } from '../../../data/models/Cat_runtimeanalysisjobsModel';
import { artService, isCurrentEnvironment } from './art-service';
import {
  RUNTIME_SCHEMA_VERSION,
  RuntimeBlockedError,
  RuntimeJobStatus,
  type RuntimeJob,
  type RuntimePreflight,
  type RuntimeReport,
} from '../models/runtime';

/** See `environment-service`: every header argument must be an explicit value. */
const HEADERS = ['', 'application/json', false, false] as const;

const CURRENT_ORGANIZATION = 'current';

/** Transcripts per plugin execution. Sized from measurement, not guesswork: kit-dev sustains ~200/s. */
const DEFAULT_CHUNK_SIZE = 500;

/** Dataverse refuses to aggregate over more rows than this. */
const AGGREGATE_LIMIT = 50_000;

/**
 * Whether a failed read is Dataverse refusing to aggregate, rather than a genuine fault.
 *
 * `0x8004e023` is not an error about the agent, the range or the caller's access — it is the platform
 * saying the matching set is larger than it will count. Treating it as a read failure blocked review
 * creation outright on any agent busy enough to be worth analysing, which is exactly backwards.
 */
function isAggregateLimit(message: string): boolean {
  return message.includes('0x8004e023') || /maximum record limit/i.test(message);
}

/** A transcript count, honest about when it could not be resolved exactly. */
export interface TranscriptCount {
  count: number;
  /** True when the real number is at least `count` — the aggregate limit was hit. */
  isLowerBound: boolean;
  /** True when the count could not be read at all, rather than being large. */
  unavailable?: boolean;
  /** Why it was unavailable. Surfaced by the pre-flight, which must name the cause. */
  error?: string;
}

/** FetchXML compares `createdon` by date, so only the date part is meaningful here. */
function isoDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}

/**
 * Transcripts for one agent, optionally within a date range.
 *
 * Shared by the pre-flight and the range field's counter so the gate and the number shown beside it
 * are answers to the same question. When they were separate queries the gate asked "any transcript,
 * ever" while the field counted the chosen dates, so an agent whose only conversations were months old
 * passed the gate and produced a run with nothing in it.
 */
async function transcriptTotal(
  agentId: string,
  rangeStart?: string,
  rangeEnd?: string,
): Promise<TranscriptCount> {
  if (!agentId) return { count: 0, isLowerBound: false };

  const conditions = [
    `<condition attribute="bot_conversationtranscriptid" operator="eq" value="${odataLiteral(agentId)}" />`,
  ];
  if (rangeStart) {
    conditions.push(
      `<condition attribute="createdon" operator="on-or-after" value="${isoDate(rangeStart)}" />`,
    );
  }
  if (rangeEnd) {
    conditions.push(
      `<condition attribute="createdon" operator="on-or-before" value="${isoDate(rangeEnd)}" />`,
    );
  }

  const fetchXml =
    '<fetch aggregate="true"><entity name="conversationtranscript">' +
    '<attribute name="conversationtranscriptid" aggregate="count" alias="total" />' +
    `<filter>${conditions.join('')}</filter>` +
    '</entity></fetch>';

  try {
    const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
      CURRENT_ORGANIZATION,
      'conversationtranscripts',
      ...HEADERS,
      undefined,
      undefined,
      undefined,
      undefined,
      fetchXml,
    );

    if (!result.success) {
      const message = describeError(result);
      // The platform answers "too many to count" as a failed request, not an exception, so this is
      // the branch that sees it. "At least the cap" is a true answer; "could not be read" is not.
      if (isAggregateLimit(message)) return { count: AGGREGATE_LIMIT, isLowerBound: true };
      return { count: 0, isLowerBound: true, unavailable: true, error: message };
    }

    const rows = valuesOf<{ total?: number | string }>(result);
    const total = toNumber(rows[0]?.total as string | undefined);
    return { count: total, isLowerBound: false };
  } catch {
    // Aggregate limit or a transient failure. Either way the honest answer is "at least the cap".
    return { count: AGGREGATE_LIMIT, isLowerBound: true };
  }
}

/** Columns for following a run. Deliberately excludes the report, which can reach 1 MB. */
const POLL_COLUMNS = [
  'cat_runtimeanalysisjobid',
  'cat_jobstatus',
  'cat_chunkindex',
  'cat_transcriptsprocessed',
  'cat_laststatus',
  'cat_errorkind',
  'cat_errormessage',
  // Carried on every poll, not just full reads: stall detection compares it against the clock.
  'modifiedon',
];

const FULL_COLUMNS = [...POLL_COLUMNS, 'cat_agentid', 'cat_agentname', 'cat_reportjson'];

export interface StartAnalysisInput {
  agentId: string;
  agentName?: string;
  /** The review result this analysis is evidence for. */
  resultId?: string;
  /** Inclusive lower bound. Omitted means "every transcript retained for this agent". */
  rangeStart?: string;
  rangeEnd?: string;
  chunkSize?: number;
  /** Where the agent lives. Analysis is possible only when this is the current environment. */
  environmentUrl?: string;
}

/** Every agent a snapshot reviewed, so runtime evidence can cover the same architecture. */
export interface StartForAgentsInput {
  resultId: string;
  agents: readonly { agentId: string; agentName?: string }[];
  rangeStart?: string;
  rangeEnd?: string;
  chunkSize?: number;
  environmentUrl?: string;
  /**
   * Told why an agent was skipped, so the caller can say so.
   *
   * A blocked agent creates no row, which is correct - there is nothing to analyse - but it is also
   * indistinguishable from "not started yet" to anything reading the job table afterwards. Without
   * this the commonest outcome of all, an agent whose transcripts fall outside the snapshot's date
   * range, would be reported as silence.
   */
  onBlocked?: (agentId: string, verdict: RuntimePreflight) => void;
}

interface OrganizationRow {
  blocktranscriptrecordingforcopilotstudio?: boolean;
  blockaccesstosessiontranscriptsforcopilotstudio?: boolean;
}

function toNumber(value: string | number | undefined, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function odataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function describeError(result: { error?: unknown; data?: unknown }): string {
  const raw = result.error ?? result.data;
  if (typeof raw === 'object' && raw !== null) {
    const outer = raw as { message?: string; error?: { message?: string } };
    if (outer.error?.message) return outer.error.message;
    if (outer.message) return outer.message;
  }
  return 'The environment did not answer.';
}

function valuesOf<T>(result: { data?: unknown }): T[] {
  const data = result.data as { value?: T[] } | T[] | undefined;
  if (Array.isArray(data)) return data;
  return data?.value ?? [];
}

/**
 * Parses the report defensively.
 *
 * Only the exact schema version this build understands is accepted. A report written by an older plugin
 * has fields in different places, and rendering it would produce confident nonsense — far worse than an
 * empty state that prompts a re-run.
 *
 * The array check is not belt-and-braces: a version match alone once let a v2 report reach a v3 renderer,
 * which read `.length` of a property that shape never had and took the entire app down with it. A report
 * that fails to satisfy the contract is discarded here, where the cost is an empty panel.
 */
function parseReport(json: string | undefined): RuntimeReport | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as RuntimeReport;
    if (parsed?.schemaVersion !== RUNTIME_SCHEMA_VERSION) return undefined;

    const lists = [parsed.errors, parsed.nodes, parsed.tools, parsed.knowledge];
    return lists.every(Array.isArray) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toJob(row: Cat_runtimeanalysisjobs): RuntimeJob {
  return {
    id: row.cat_runtimeanalysisjobid,
    agentId: row.cat_agentid ?? '',
    agentName: row.cat_agentname,
    resultId: row._cat_resultid_value,    status: toNumber(row.cat_jobstatus, RuntimeJobStatus.Queued) as RuntimeJobStatus,
    chunkIndex: toNumber(row.cat_chunkindex),
    transcriptsProcessed: toNumber(row.cat_transcriptsprocessed),
    lastStatus: row.cat_laststatus,
    errorKind: row.cat_errorkind,
    errorMessage: row.cat_errormessage,
    report: parseReport(row.cat_reportjson),
    createdOn: row.createdon,
    modifiedOn: row.modifiedon,
  };
}

export const runtimeService = {
  /**
   * Read the analysis this snapshot accepted for one agent.
   *
   * Bound by job id, snapshot and agent together, so a later re-analysis of the same agent can never
   * be substituted for the one the snapshot recorded - the reason this does not simply take the
   * newest row for the agent.
   *
   * The report is read from the job row, which is where the engine writes it. The POC kept a
   * separately signed copy in `cat_arworchestrationrecords`; the engine writes no such record, so
   * reading from there left the Runtime tab empty for every snapshot the engine produced, even when
   * the analysis had succeeded and stored a full report.
   */
  async forAssessment(snapshotId: string, assessment: import('../models/orchestration').AssessmentProgress): Promise<RuntimeJob | undefined> {
    if (assessment.stage !== 'runtime' || !assessment.jobId ||
      (assessment.status !== 'succeeded' && assessment.status !== 'no-data')) return undefined;
    const context = await artService.linkContext();
    if (context.environmentId?.toLowerCase() !== assessment.environmentId.toLowerCase()) throw new Error('Runtime evidence belongs to an unsupported source environment.');

    const result = await Cat_runtimeanalysisjobsService.getAll({
      select: FULL_COLUMNS,
      filter: [
        `cat_runtimeanalysisjobid eq ${odataLiteral(assessment.jobId)}`,
        `_cat_resultid_value eq ${odataLiteral(snapshotId)}`,
        `cat_agentid eq '${odataLiteral(assessment.agentId)}'`,
      ].join(' and '),
      top: 2,
    });
    const rows = result?.data ?? [];
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error('The accepted runtime analysis for this assessment is missing or ambiguous.');
    }
    const job = { ...toJob(rows[0]), resultId: snapshotId, agentName: assessment.agentName };
    // An analysis that found nothing to read may hold no report at all. That is the "no transcripts"
    // outcome the panel is expected to state, not a broken row to refuse.
    if (assessment.status === 'no-data' && !job.report) return job;
    const report = job.report;
    if (!report || report.agentId?.toLowerCase() !== assessment.agentId.toLowerCase() ||
      !Number.isSafeInteger(report.transcriptsAnalyzed) || report.transcriptsAnalyzed < 0 ||
      (report.transcriptsAnalyzed === 0) !== (assessment.status === 'no-data')) {
      throw new Error('The retained runtime report schema, agent, or outcome does not match this assessment.');
    }
    return job;
  },
  /**
   * Decides whether a run is worth offering, and says why when it is not.
   *
   * The transcript-recording flag is read from the `organization` row and is **inverted** —
   * `blocktranscriptrecordingforcopilotstudio: true` means recording is OFF. Reading a count of
   * transcripts is not a substitute for that flag: rows survive the setting being turned off, and new
   * ones can keep arriving for up to a day afterwards.
   */
  async preflight(
    agentId: string,
    environmentUrl?: string,
    range?: { start?: string; end?: string },
  ): Promise<RuntimePreflight> {
    if (!agentId) {
      return { canRun: false, reason: 'no-agent', message: 'No agent is selected for this review.' };
    }

    // Settled before anything is read, because every query below - and the plugin that does the
    // analysis - is scoped to this environment. Asking about an agent elsewhere would answer
    // "no transcripts" for an agent that may have thousands, which is a different problem with a
    // different fix.
    if (environmentUrl !== undefined && !(await isCurrentEnvironment(environmentUrl))) {
      return {
        canRun: false,
        reason: 'other-environment',
        message:
          'Conversation transcripts are analysed only in the environment this app runs in. The configuration review still covers this agent; select the current environment to include runtime analysis.',
      };
    }

    let org: OrganizationRow = {};
    try {
      const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
        CURRENT_ORGANIZATION,
        'organizations',
        ...HEADERS,
        'blocktranscriptrecordingforcopilotstudio,blockaccesstosessiontranscriptsforcopilotstudio',
        undefined,
        undefined,
        undefined,
        undefined,
        1,
      );
      if (result.success) org = valuesOf<OrganizationRow>(result)[0] ?? {};
    } catch {
      // A readable environment that will not answer this query is not a reason to block a run; the
      // plugin enforces privileges server-side regardless.
      org = {};
    }

    if (org.blocktranscriptrecordingforcopilotstudio === true) {
      return {
        canRun: false,
        reason: 'recording-off',
        message:
          'Conversation transcript recording is turned off for this environment, so there is nothing to analyse. An environment administrator can re-enable it in the Power Platform admin center.',
      };
    }

    // Counted over the selected range using the very same query the range field shows, so the gate and
    // the number beside it can never disagree. Failure stays distinct from emptiness: it usually means
    // the signed-in user cannot read the transcript table, which is not the agent being idle.
    const total = await transcriptTotal(agentId, range?.start, range?.end);

    if (total.unavailable) {
      // The connector's own payload is a wall of JSON naming an operation and a request id, which says
      // nothing to the person reading it, so it goes to the console and the screen gets one sentence.
      // The cause is usually transient — the same request commonly succeeds moments later — so the
      // sentence names the way forward rather than blaming the reader's privileges.
      console.warn('[runtime] transcript count refused:', total.error ?? 'the request was refused');
      return {
        canRun: false,
        reason: 'no-privilege',
        message: "Couldn't read conversation transcripts just now. Click Run to review without runtime analysis.",
      };
    }

    if (total.count === 0) {
      return {
        canRun: false,
        reason: 'no-transcripts',
        message:
          range?.start && range?.end
            ? 'This agent has no conversation transcripts in the selected dates. Widen the range, or choose another agent.'
            : 'This agent has no stored conversation transcripts yet. Runtime analysis needs at least one conversation.',
        transcriptCount: 0,
      };
    }

    if (org.blockaccesstosessiontranscriptsforcopilotstudio === true) {
      // Viewing being blocked does not stop the analysis, which reads the table directly, but it does
      // mean nobody can open a conversation to verify a finding — worth saying up front.
      return {
        canRun: true,
        reason: 'viewing-blocked',
        message:
          'Transcript viewing is blocked for this environment. The analysis will still run, but individual conversations cannot be opened to confirm a finding.',
      };
    }

    return { canRun: true };
  },

  /**
   * How many transcripts a run would actually cover.
   *
   * Counted with a FetchXML aggregate rather than by paging ids, so a 10,000-conversation agent costs one
   * cheap call. Dataverse refuses to aggregate beyond 50,000 rows; that refusal is reported as a lower
   * bound instead of being swallowed, because "we can't count this" and "there is nothing here" must not
   * look the same.
   */
  async countTranscripts(
    agentId: string,
    rangeStart?: string,
    rangeEnd?: string,
  ): Promise<TranscriptCount> {
    return transcriptTotal(agentId, rangeStart, rangeEnd);
  },

  /**
   * Queues one analysis per reviewed agent, skipping agents a snapshot already covers.
   *
   * A snapshot reviews the requested agent *and* every agent it connects to, so runtime evidence has
   * to cover the same set or the report compares a full architecture against transcripts from one
   * node of it. `start` supersedes by deleting earlier rows for the agent, which would destroy a run
   * already in flight, so the existing set is read once up front and those agents are left alone.
   * That also makes this safe to call again when a snapshot is reopened.
   */
  async startForAgents(input: StartForAgentsInput): Promise<RuntimeJob[]> {
    if (!input.resultId || input.agents.length === 0) return [];

    const covered = await runtimeService.agentsWithJobs(input.resultId);
    const pending = input.agents.filter(agent => agent.agentId && !covered.has(agent.agentId));

    const started: RuntimeJob[] = [];
    for (const agent of pending) {
      try {
        started.push(await runtimeService.start({
          agentId: agent.agentId,
          agentName: agent.agentName,
          resultId: input.resultId,
          rangeStart: input.rangeStart,
          rangeEnd: input.rangeEnd,
          chunkSize: input.chunkSize,
          environmentUrl: input.environmentUrl,
        }));
      } catch (error) {
        // One agent that cannot be analysed must not stop the others: a blocked agent has no
        // transcripts to offer, and the Runtime tab explains why for the one being viewed.
        if (error instanceof RuntimeBlockedError) input.onBlocked?.(agent.agentId, error.verdict);
        else {
          input.onBlocked?.(agent.agentId, {
            canRun: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return started;
  },

  /**
   * Agents that already have a run of any status under this snapshot.
   *
   * Any status, not just succeeded: a queued or running job means work is already under way, and a
   * failed one means a retry belongs to the user rather than to an automatic re-queue.
   */
  async agentsWithJobs(resultId: string): Promise<Set<string>> {
    if (!resultId) return new Set();

    const result = await Cat_runtimeanalysisjobsService.getAll({
      select: ['cat_agentid'],
      filter: `_cat_resultid_value eq ${odataLiteral(resultId)}`,
    });

    const rows = result?.data ?? [];
    if (!Array.isArray(rows)) return new Set();
    return new Set(rows.map(row => row.cat_agentid).filter((id): id is string => Boolean(id)));
  },

  /**
   * Queues a run and removes any earlier one for the same agent under the same snapshot.
   *
   * Superseding on start rather than on completion keeps exactly one row per agent per snapshot even if
   * a run fails or is abandoned, which is what stops the table growing without bound between the nightly
   * bulk-delete passes.
   */
  async start(input: StartAnalysisInput): Promise<RuntimeJob> {
    if (!input.agentId) throw new Error('An agent is required to run a runtime analysis.');

    // The invariant lives here rather than at each call site, so no caller can queue work that
    // cannot produce evidence. Creating the row is what starts the plugin, so a row queued for an
    // agent in another environment - or one whose transcripts this user cannot read - would surface
    // as a failed job instead of an explanation the user can act on.
    const verdict = await runtimeService.preflight(input.agentId, input.environmentUrl, {
      start: input.rangeStart,
      end: input.rangeEnd,
    });
    if (!verdict.canRun) throw new RuntimeBlockedError(verdict);

    await runtimeService.deleteSuperseded(input.agentId, input.resultId);

    const payload = {
      cat_name: `${input.agentName ?? 'Agent'}: runtime analysis`,
      cat_agentid: input.agentId,
      cat_agentname: input.agentName,
      cat_chunksize: String(input.chunkSize ?? DEFAULT_CHUNK_SIZE),
      cat_jobstatus: String(RuntimeJobStatus.Queued),
      cat_rangestart: input.rangeStart,
      cat_rangeend: input.rangeEnd,
      ...(input.resultId
        ? { 'cat_resultid@odata.bind': `/cat_architecturereviewresults(${input.resultId})` }
        : {}),
    };

    // The generated model marks `statecode` as required, but Dataverse assigns it on create and
    // rejects nothing by its absence. Casting here rather than inventing a value keeps the payload
    // honest; the same cast is used for creates elsewhere in this feature.
    const created = await Cat_runtimeanalysisjobsService.create(payload as never);

    const row = created?.data;
    if (!row?.cat_runtimeanalysisjobid) {
      throw new Error('Dataverse did not return the queued runtime analysis.');
    }
    return toJob(row);
  },

  /** Current state of a run, without pulling the report payload. */
  async poll(jobId: string): Promise<RuntimeJob> {
    const result = await Cat_runtimeanalysisjobsService.get(jobId, { select: POLL_COLUMNS });
    const row = result?.data;
    if (!row) throw new Error('The runtime analysis job could not be read.');
    return toJob(row);
  },

  /** The finished run including its report. */
  async read(jobId: string): Promise<RuntimeJob> {
    const result = await Cat_runtimeanalysisjobsService.get(jobId, { select: FULL_COLUMNS });
    const row = result?.data;
    if (!row) throw new Error('The runtime analysis job could not be read.');
    return toJob(row);
  },

  /**
   * Restarts a parked run.
   *
   * Writes `Running`, not `Paused` — see the note at the top of this file. Writing the status is what
   * re-arms the plugin, whose update step is filtered to that single column.
   */
  async resume(jobId: string): Promise<void> {
    await Cat_runtimeanalysisjobsService.update(jobId, {
      cat_jobstatus: String(RuntimeJobStatus.Running),
    });
  },

  /**
   * Accepts a parked run as finished, keeping the conversations already analysed as the answer.
   *
   * Writing `Succeeded` is safe for the same reason `resume` writing `Running` is: the plugin's step
   * re-fires on the status write and returns immediately, because it acts only on `Queued` or
   * `Running`. This exists because everything that reads a snapshot's runtime evidence filters on
   * `Succeeded` — without it, a partial report is visible only to the tab that happened to be open.
   */
  async accept(jobId: string): Promise<void> {
    await Cat_runtimeanalysisjobsService.update(jobId, {
      cat_jobstatus: String(RuntimeJobStatus.Succeeded),
    });
  },

  /**
   * The completed analysis attached to a snapshot, so opening it shows its evidence rather than an
   * empty state.
   *
   * Scoped to the result, not the agent: two snapshots of the same agent cover different date ranges and
   * must never show each other's numbers.
   */
  async forResult(resultId: string, agentId?: string): Promise<RuntimeJob | undefined> {
    if (!resultId) return undefined;

    const filters = [
      `_cat_resultid_value eq ${odataLiteral(resultId)}`,
      `cat_jobstatus eq ${RuntimeJobStatus.Succeeded}`,
    ];
    if (agentId) filters.push(`cat_agentid eq '${odataLiteral(agentId)}'`);

    const result = await Cat_runtimeanalysisjobsService.getAll({
      select: FULL_COLUMNS,
      filter: filters.join(' and '),
      orderBy: ['createdon desc'],
      top: 1,
    });

    const rows = result?.data ?? [];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? toJob(row) : undefined;
  },

  /**
   * Every completed analysis under a snapshot, one per agent.
   *
   * `forResult` deliberately takes the single newest row, which is right for the Runtime tab but wrong
   * for a report covering the root agent and each connected agent. Dedupes by agent keeping the newest,
   * because a re-run leaves the superseded rows behind until the nightly bulk delete clears them.
   *
   * `includeParked` also takes a run halted at the chunk cap. The engine writes the cumulative report
   * on every chunk, so a parked run holds real evidence. It is excluded by default because
   * `snapshotProgress` reports stage completion from these rows, and a parked run has not completed.
   */
  async allForResult(resultId: string, options?: { includeParked?: boolean }): Promise<RuntimeJob[]> {
    if (!resultId) return [];

    const statuses = options?.includeParked
      ? [RuntimeJobStatus.Succeeded, RuntimeJobStatus.Paused]
      : [RuntimeJobStatus.Succeeded];

    const result = await Cat_runtimeanalysisjobsService.getAll({
      select: FULL_COLUMNS,
      filter: [
        `_cat_resultid_value eq ${odataLiteral(resultId)}`,
        `(${statuses.map((status) => `cat_jobstatus eq ${status}`).join(' or ')})`,
      ].join(' and '),
      orderBy: ['createdon desc'],
    });

    const rows = result?.data ?? [];
    if (!Array.isArray(rows)) return [];

    const newestByAgent = new Map<string, RuntimeJob>();
    for (const row of rows) {
      const job = toJob(row);
      // Rows arrive newest first, so the first sighting of an agent is the one to keep.
      if (job.agentId && !newestByAgent.has(job.agentId)) newestByAgent.set(job.agentId, job);
    }
    return Array.from(newestByAgent.values());
  },

  /**
   * The run currently in flight for a snapshot, if any.
   *
   * A run is queued when the snapshot is created and usually outlives the dialog that started it, so a
   * user who navigates away and comes back must be able to rejoin it rather than start a second one.
   */
  async inFlightForResult(resultId: string, agentId?: string): Promise<RuntimeJob | undefined> {
    if (!resultId) return undefined;

    const filters = [
      `_cat_resultid_value eq ${odataLiteral(resultId)}`,
      `cat_jobstatus lt ${RuntimeJobStatus.Succeeded}`,
    ];
    if (agentId) filters.push(`cat_agentid eq '${odataLiteral(agentId)}'`);

    const result = await Cat_runtimeanalysisjobsService.getAll({
      // Read whole, not just the polling columns: a parked job carries the report for everything
      // analysed so far, and returning to the tab should show that rather than an empty panel.
      select: FULL_COLUMNS,
      filter: filters.join(' and '),
      orderBy: ['createdon desc'],
      top: 1,
    });

    const rows = result?.data ?? [];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? toJob(row) : undefined;
  },

  /**
   * Removes previous runs for this agent under this snapshot so only the newest survives.
   *
   * Best effort by design: a delete that fails must not stop a new analysis from starting, and the
   * nightly bulk-delete job clears anything left behind.
   */
  async deleteSuperseded(agentId: string, resultId?: string): Promise<void> {
    try {
      const filters = [`cat_agentid eq '${odataLiteral(agentId)}'`];
      if (resultId) filters.push(`_cat_resultid_value eq ${odataLiteral(resultId)}`);

      const result = await Cat_runtimeanalysisjobsService.getAll({
        select: ['cat_runtimeanalysisjobid'],
        filter: filters.join(' and '),
        top: 50,
      });

      const rows = result?.data ?? [];
      if (!Array.isArray(rows)) return;

      await Promise.all(
        rows
          .map((row) => row.cat_runtimeanalysisjobid)
          .filter((id): id is string => Boolean(id))
          .map((id) => Cat_runtimeanalysisjobsService.delete(id).catch(() => undefined)),
      );
    } catch {
      // Ignored deliberately — see the doc comment.
    }
  },
};
