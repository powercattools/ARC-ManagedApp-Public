/**
 * Bounded parallelism, shared by every snapshot entry point.
 *
 * Extracted so the agent run and the upload run cannot drift apart in how much work they put in
 * flight at once. Both hold one Dataverse job per in-flight item and poll it, so the bound is about
 * the request budget of a single browser tab rather than about CPU.
 *
 * Pure. No I/O, no host APIs.
 */

/**
 * How many items may be in flight at once.
 *
 * Each in-flight item holds one queued workflow run and polls one job row, so this trades a browser
 * tab's Dataverse request budget for wall-clock time. Six rather than three because the cost of the
 * old bound fell entirely on the agents that need this most: a parent with nine connected agents ran
 * as four sequential waves, each waiting on a workflow that takes minutes, while the tab sat almost
 * idle between polls.
 *
 * Not unbounded. The fan-out is what decides how many AI-backed flow runs are queued at once, and
 * exhausting the environment's capacity is a real failure mode — `classifyFailure` has a branch for
 * it. Six keeps a typical graph to one or two waves without flooding a shared environment.
 */
export const DEFAULT_CONCURRENCY = 6;

/** Run `tasks` with at most `limit` in flight, preserving input order in the results. */
export async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });

  await Promise.all(workers);
  return results;
}
