# Architecture review engine

The reviewing half of the feature: capture an agent, score it under the rubric its
harness demands, and persist the result as a comparable snapshot.

It is deliberately separate from `../components` and `../hooks`. Those render a
review; this produces one. Nothing in this folder may import React, the Power Apps
SDK, or `src/generated/**` — see *Host targets* below, which is not a style rule but
a build-breaking one.

## Host targets

Code here runs in two places, and the two have incompatible capabilities. Which one a
module targets is a property of the module, not a preference.

**Browser-safe (the whole engine, today).** The app runs its own review work, which is
what lets a review start without a Node host at all. Capture, orchestration, scoring
and persistence therefore have to bundle for a browser. They may not use `Buffer`,
`process`, `global`, `__dirname` or `__filename` — these are *globals*, not imports, so
a bundler leaves them as free variables and the build passes. The failure appears
later, in the browser, as `Buffer is not defined`.

**Node-only (no current resident).** A long-running worker host is not part of this
package. `@azure/identity` and anything else that needs a bearer token stayed behind in
the reference workspace and must not enter this app's dependency tree.

Host purity is currently enforced only by `tsc` and by review: the import rules above
(no React, no `src/generated/**`, no Node globals) are not checked by an automated
guard. The reference workspace had one, `build-live.mjs`, which moved out with it.

## Legacy ART and the explicit ARC2 native policy

Legacy rubric behavior stays in the sibling `CopilotStudioKitMakers` source.
Its historical grades, findings-only responses and saved ratings keep their own
meaning. Spec 022 adds an opt-in, versioned native ARC2 catalog, provider merge and
score. That result is intentionally labelled separately in the comparison app;
it is not a rewritten historical ART rating.

All cross-repository imports go through `scoring/art-ports.ts`, so the dependency surface is
declared once. ART exposes `*Core` modules (`StageACore`, `AIServiceCore`,
`reviewAiPortCore`) for exactly this: the pure half of a service, importable by any
host. Import the core, never the service.

## Compact production AI boundary

`ai-workflow/` owns the new request and persisted-receipt path. It is separate from
`dispatch/review-job-port.ts`, whose legacy readers cannot consume compact output.

| Module | Responsibility |
| --- | --- |
| `frozen-input.ts` | Reuse the pinned five reviewer adapters, independent zero-skill instructions, ART redaction/resource excerpts, and explicit unbound skill context |
| `request.ts` | Reserve stable unit result IDs; validate the complete routed population and rule/source identities under `arc2-workflow-v1` |
| `provenance.ts` | Fingerprint captured sources and retain optional frozen deterministic context outside model-visible inputs |
| `job-port.ts` | Create an isolated ARC2 parent, upload/read back frozen bytes, deliberately queue with the exact parent row version, and resume read-only |
| `receipt.ts` | Reconcile reserved `arc2-unit-result-v1` rows without last-write-wins; invoke the strict compact normalizer |
| `validation/ai-nodes/compact-output.ts` | Infer omitted eligible passes only after a valid complete `arc2-exceptions-v1` acknowledgement and sufficient source scope |

The workflow persists transport receipts, not model-chosen grades. A successful
Dataverse write or Agent action is not proof of a complete quality review.
Foreign, duplicate, missing, malformed and incomplete results remain explicit;
none triggers the legacy AI Builder fallback.

An explicit Not assessed can be a valid model result and must not be retried merely
to obtain a more favorable verdict. Informational records and score metadata stay
host-owned. A saved AI result cannot be combined with a different current capture's
deterministic results as if both came from the same evidence.

## Harnesses

One function decides which rubric reviews what — `harnesses/harness-dispatch.ts` — and it decides
from `capture.harness`, the discriminant the capture derives from the agent's own configuration on
every load. A capture therefore cannot be replayed under a rubric it was not taken for, and no
caller can assert a harness the agent does not have. The dispatch is exhaustive over the captured
union rather than defaulting: scoring an agent with the wrong rubric produces a number that looks
valid and is not.

| Harness | Rubric | Status in the engine |
| --- | --- | --- |
| `standard` | Stage A -> B -> C, pattern merge, scoring | implemented, `harnesses/standard` |
| `copilot` | agents-experience; skills via predictions or the review workflow | implemented, `harnesses/copilot` |
| `declarative-agent` | Separate declarative-agent rubric | **Not captured or dispatched** by the native five-reviewer path |
| `skill-artifact` | `reviewArtifact`; separate compact standalone profile | Explicit upload entry point in `harnesses/skill`; compact requests support one complete unbound skill |

The agent capture union admits only `standard` and `copilot`. Skills enter through
an explicit upload context, not a fabricated bot capture. Automation and declarative
artifacts must not be guessed into the standalone skill AI route. Connected-agent
metadata does not establish that the connected agent's internal content was reviewed.

Each harness is specified before it is implemented. See
`specs/015-architectural-workbench/`.

## Scoring policy — the three places you change it

`scoring/ai-review-scoring.ts` deliberately contains no harness names. Every per-harness
difference is data in `scoring/ai-review-catalog.ts`, so the arithmetic stays one code path
that every harness runs identically.

| To do this | Change only this | The scorer then |
| --- | --- | --- |
| Add or retire a rule | `AI_RULE_CATALOG` — give it a `pillar` (and `dimension` for skills) plus the harnesses that own it | Picks up its weight, coverage and ownership with no scorer edit |
| Reweight a pillar for one harness | `HARNESS_POLICY[harness].weights` | Applies the new points directly; the table must still sum to 100 |
| Rename a group or add a standing note for one harness | `HARNESS_POLICY[harness].labels` / `.disclosures` | Reports it without touching the arithmetic |

Every harness declares the **same 100-point table**: Instructions 25, Skills 15, Tools 12,
Knowledge 8, Orchestration 10, Agent Evaluation 30. A harness may rename a group it fills
differently — Standard labels Skills as *Topics* — but it may not reprice one, because two
agents reviewed against different prices are not comparable on a single 0-100 number.

Renormalization is therefore **not** routine. It happens for exactly one reason: a group the
host proved does not apply, such as an agent with no knowledge sources at all. The remaining
pillars then share the full 100 in proportion to their declared weight.

A pillar with no provider is not a thing this scorer models. Two states remain:

- **`excluded`** — the host proved the population is empty, so no rule in the group could
  apply. Non-blocking; its weight is redistributed.
- **`unavailable`** — a provider exists but its evidence did not arrive. Blocking, on purpose:
  absent evidence is not proof of non-applicability.

A pillar whose rules could not run belongs in the unit builder or normalizer — emit
`not-applicable` when the population is genuinely empty *and* the manifest is complete. Never
reach for a static policy declaration to silence a runtime evidence gap.

`overall.reasons` is the de-duplicated union of two internal channels: `blockers`, which gate
`calculable`, and `notes`, which only disclose. Adding a disclosure must never suppress a score.
