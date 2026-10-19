/**
 * How each agent's score has moved across the snapshots of one review.
 *
 * Pure: it takes the snapshots and the agent rows and returns the lines to draw. Every judgement it
 * makes is about what the data does *not* say — an agent that joined late, a review that produced no
 * score, a snapshot that graded a different subject — because those are the cases where a chart is
 * easiest to make lie, and a progress tracker that flatters is worse than none.
 */

import { subjectChanged, type ReviewResult } from '../models/review';
import type { SnapshotAgentScore } from './snapshot-agent-scores';

export interface AgentSeriesPoint {
  resultId: string;
  sequenceNumber: number;
  score: number;
  runTimestamp: string;
}

export interface AgentSeries {
  /** Empty for the fallback series, which stands for the review rather than a known agent row. */
  agentId: string;
  agentName: string;
  isParent: boolean;
  depth: number;
  /** Oldest first. Only snapshots where this agent was actually scored. */
  points: AgentSeriesPoint[];
}

export interface ReviewProgress {
  series: AgentSeries[];
  /**
   * Snapshots left off every line because they reviewed a different subject.
   *
   * Only ever non-zero for an uploaded skill, whose re-review can name a different skill. Reported
   * rather than silently dropped: a chart that quietly starts at #3 owes the reader an explanation.
   */
  excludedForSubjectChange: number;
}

/** Parent first, then by depth, then alphabetically — the order the graph was walked in. */
function bySeriesOrder(a: AgentSeries, b: AgentSeries): number {
  if (a.isParent !== b.isParent) return a.isParent ? -1 : 1;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.agentName.localeCompare(b.agentName);
}

/**
 * Build one line per agent from the snapshots of a review.
 *
 * `results` may arrive in any order; `fallbackName` names the single line drawn for snapshots that
 * predate agent rows.
 */
export function buildReviewProgress(
  results: readonly ReviewResult[],
  scores: ReadonlyMap<string, SnapshotAgentScore[]>,
  fallbackName: string,
): ReviewProgress {
  // Oldest first: progress reads left to right, in the order the readings were taken.
  const ordered = [...results].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  // Everything before the last subject change graded something else. Charting across it would draw
  // a trend between two different skills, which is arithmetically fine and factually meaningless.
  let firstCharted = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (subjectChanged(ordered[index], ordered[index - 1])) firstCharted = index;
  }
  const charted = ordered.slice(firstCharted);
  const excludedForSubjectChange = firstCharted;

  const byAgent = new Map<string, AgentSeries>();
  for (const result of charted) {
    for (const agent of scores.get(result.id) ?? []) {
      const series = byAgent.get(agent.agentId) ?? {
        agentId: agent.agentId,
        agentName: agent.agentName,
        isParent: agent.isParent,
        depth: agent.depth,
        points: [],
      };
      // The newest snapshot has the last word on what an agent is called and where it sits: a
      // renamed agent should read under the name it has now, not the one it had in snapshot #1.
      series.agentName = agent.agentName;
      series.isParent = agent.isParent;
      series.depth = agent.depth;
      // A missing score is a gap, not a zero. Zero is a review that found nothing to credit; a gap
      // is a review that never landed, and plotting the second as the first invents a collapse.
      if (agent.score !== null) {
        series.points.push({
          resultId: result.id,
          sequenceNumber: result.sequenceNumber,
          score: agent.score,
          runTimestamp: result.runTimestamp,
        });
      }
      byAgent.set(agent.agentId, series);
    }
  }

  const series = [...byAgent.values()]
    .filter((candidate) => candidate.points.length > 0)
    .sort(bySeriesOrder);

  if (series.length > 0) return { series, excludedForSubjectChange };

  // Snapshots recorded before the engine wrote agent rows still have a score of their own, so the
  // review can be charted as a single line rather than showing a reader an empty panel.
  const fallback = charted
    .filter((result) => result.score !== null)
    .map((result) => ({
      resultId: result.id,
      sequenceNumber: result.sequenceNumber,
      score: result.score as number,
      runTimestamp: result.runTimestamp,
    }));

  if (fallback.length === 0) return { series: [], excludedForSubjectChange };

  return {
    series: [{ agentId: '', agentName: fallbackName, isParent: true, depth: 0, points: fallback }],
    excludedForSubjectChange,
  };
}

/**
 * The y-axis range to draw a series against.
 *
 * Named for what it returns. It was called `scoreBand`, which is also the name of three unrelated
 * functions that grade a score — so "the band" meant a letter in one import and a pair of axis
 * bounds in another. Grading lives in `review-core/bands.ts`; this is chart geometry.
 *
 * Not `[0, 100]`. A review that moves 63 → 67 → 65 is a real change of direction, and on a full
 * hundred-point axis it is four pixels of noise — the chart would technically be accurate and would
 * still tell the reader nothing. The range is the data plus padding, rounded out to fives so the
 * ticks are whole numbers, and clamped to the range a score can actually take.
 */
export function scoreAxisRange(scores: readonly number[]): { min: number; max: number } {
  if (scores.length === 0) return { min: 0, max: 100 };
  const lowest = Math.min(...scores);
  const highest = Math.max(...scores);
  // Padding is proportional so a wide swing is not cramped, with a floor so a flat line is not
  // magnified into a cliff by a band only a point or two tall.
  const padding = Math.max(5, Math.ceil((highest - lowest) * 0.6));
  return {
    min: Math.max(0, Math.floor((lowest - padding) / 5) * 5),
    max: Math.min(100, Math.ceil((highest + padding) / 5) * 5),
  };
}

export interface SeriesSummary {
  first: number;
  latest: number;
  /** Percentage-point move from the first charted reading to the latest. */
  delta: number;
  firstSequence: number;
  latestSequence: number;
}

/** The first-to-latest move, which a chart shows but never states in words. */
export function summarize(series: AgentSeries): SeriesSummary | null {
  const { points } = series;
  if (points.length === 0) return null;
  const first = points[0];
  const latest = points[points.length - 1];
  return {
    first: first.score,
    latest: latest.score,
    delta: latest.score - first.score,
    firstSequence: first.sequenceNumber,
    latestSequence: latest.sequenceNumber,
  };
}
