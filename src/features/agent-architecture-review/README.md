# Agent Architecture Review

Implementation of spec `015-architectural-workbench`: the data model and UI for
creating a review, viewing a review, and viewing its results.

## Status

The shipping entry point is `main.tsx` -> `App.tsx`, a `HashRouter` that mounts
the full route set: `/reviews` with its progress and result-detail pages,
`/setup`, `/skills`, `/agent-debugger`, and the read-only scoring comparison at
`/scoring-lab`. `/` and any unmatched path redirect to `/reviews`.

The inherited snapshot engine uses ART's shared rubrics and Dataverse
persistence. The queue isolation described below applies whenever the review
engine runs.

### Review job queueing

New `cat_agentreviewjob` parents are created with **`Queued (1)`** so ART's
workflow claims them. The port uploads the unchanged corpus to `cat_inputfile`,
then patches `cat_jobstatus` to `1` again; Dataverse update triggering is based
on attribute presence, not a value change. ART's trigger also requires
`cat_inputfile_name ne null`, so the row stays dormant until the corpus lands.
An upload failure is reported and does not reach that final queue patch.

`cat_botid` carries the real bot or skill id, as ART writes it.
`cat_correlationid` remains `snapshotId:sourceSubjectId` (or the original corpus
correlation without a snapshot), preserving existing history and resume joins.

Only one workflow watches this table: ART's
`71b31233-076b-facf-68e6-6a8b67a7d075`, filtering on
`cat_jobstatus eq 1 and cat_inputfile_name ne null`. The ARC2 copy
`782fff99-546e-4114-82d4-47627e5683b0` is **off** and its branches were merged
into ART's. The app invokes no workflow URL.

Rows written before the cutover carry `ARC2Queued (100000000)` and an
`arc2:<jobId>` prefix on `cat_botid`. The polling read projection still
normalizes `ARC2Queued` to ART's logical `Queued` so those rows keep parsing;
historical statuses 1/2/3/4 are unchanged.

### ARC2 workflow availability

`ARC2_Execution_Enabled` remains **false** during queue isolation. The copied
workflow reports parent status **Failed (4)**, `cat_laststatus = ARC2_NOT_ENABLED`,
and this `cat_errormessage`:

> ARC2_NOT_ENABLED: ARC2 routing is isolated, but the V3 review pipeline is not enabled. No AI review or score was produced.

Standard polling propagates that failure directly; the
app-only Copilot/upload guard prevents it from becoming an alternate-provider
prediction or a successfully persisted partial review.

The existing review-engine progress contract carries the full reason as a failed
assessment, and snapshot persistence/history retain it. Runtime evidence remains
independent, so its queueing or analysis can still be in progress while the AI
assessment already shows the failure. These review surfaces are not mounted by
the current read-only ARC2 host.

Full V3 corpus/output integration, catalog, validation, writers, canonical merge,
and scoring remain pending under `specs/022-unified-ai-review`. Queue isolation
does not complete AI review or change corpus versions, source identities, or the
accepted deterministic comparisons.

## Deployment

This app is a managed app. You create and deploy your own copy with the
`ms` CLI. For the full steps, see the README at the root of this repository.

## Dataverse

Solution **ArchitecturalWorkbench** (publisher PowerCAT, `cat` prefix) in
Copilot Studio Kit - Dev:

| Table | Entity set | Notes |
|---|---|---|
| `cat_architecturereview` | `cat_architecturereviews` | Primary name `cat_projectname`; asset type 1 agent / 2 declarative agent / 3 skill; status 1 Active / 2 Inactive |
| `cat_architecturereviewresult` | `cat_architecturereviewresults` | Lookup `cat_reviewid` (cascade delete), plus a 16 MB `cat_artifactfile` File column |
| `cat_runtimeanalysisjob` | `cat_runtimeanalysisjobs` | Queue row for the runtime analyzer plugin; lookup `cat_resultid` → **result**, not review (cascade delete); `cat_reportjson` holds the finished report |

`cat_agentreviews` in the same environment belongs to the **Agent Review Tool**
and is not touched by this app.

Add a table with `pac code add-data-source`, never by hand-editing
`power.config.json`. A table listed only in `databaseReferences` has no generated
service, falls back to the connector's `ListRecords` operation and fails every
query with `Invalid organization URL 'null' provided`:

```powershell
pac code add-data-source -a dataverse -t systemuser
```

After `pac code push` the player caches aggressively. If a change appears to have
had no effect, compare the `assets/index-*.js` hash the player loaded against
`dist/assets/` before assuming the code is wrong.

## Structure

| Path | Purpose |
|---|---|
| `ReviewsPage.tsx` | Landing page — filter toolbar over a sortable, paginated grid |
| `ReviewRedirectPage.tsx` | `/reviews/:reviewId` — resolves a review to its newest snapshot, or offers to run its first |
| `ReviewProgressPage.tsx` | Progress tracker — per-agent score chart over the review's snapshots, with the timeline below |
| `ResultDetailPage.tsx` | Snapshot detail — score, findings, components, runtime for **one** result |
| `components/SnapshotTimeline.tsx` | The review's snapshots as a vertical timeline, with grade, trend and subject-change warnings |
| `services/snapshot-agent-scores.ts` | Per-agent scores across a review's snapshots, read from `cat_architecturereviewagent` |
| `services/review-progress.ts` | Pure builder turning snapshots plus agent rows into one score line per agent |
| `components/ReviewAgainDialog.tsx` | "Review the agent again" (transcript window) and the creating-review progress dialog |
| `components/TranscriptRangeField.tsx` | Shared date-range picker with a live transcript count |
| `SetupPage.tsx` | Setup — readiness checklist behind the banner gear (`/setup`) |
| `components/PrerequisiteCard.tsx` | One checklist card; expands to show roles, connections or flows |
| `components/SetupWelcomeBanner.tsx` | Dismissible first-run banner |
| `components/ConnectionPicker.tsx` | Per-reference connection dropdown, with a "Create a new connection" deep link |
| `services/setup-service.ts` | The readiness checks, connection mapping, and two-way cloud-flow toggling |
| `components/NewReviewDialog.tsx` | Create dialog, both variants |
| `components/GradeBadge.tsx` | Colour-coded letter grade avatar |
| `models/review.ts` | `Review`, `ReviewResult`, trend derivation |
| `services/review-service.ts` | Dataverse repository for reviews and results |
| `services/environment-service.ts` | Environment and agent pickers |
| `components/RuntimePanel.tsx` | Runtime tab — Errors / Latency / Knowledge tabs, scoped to a snapshot |
| `models/runtime.ts` | TypeScript mirror of the analyzer's JSON contract |
| `services/runtime-service.ts` | Queues, follows and resumes an analysis; preflight checks |
| `hooks/use-runtime.ts` | React Query bindings plus the poll/resume loop |
| `hooks/use-reviews.ts` | React Query bindings; components never call services directly |

## Design reference

Figma `Architecture Review Tool`:

| Screen | Node |
|---|---|
| Setup | `8647:24939` |
| Landing | `8650:28881` |
| New review — agent | `8647:28543` |
| New review — upload | `8650:33139` |
| Review detail | `8650:37498` |

`figma-get_screenshot` was timing out for this file, so layout and colour were
taken from `figma-get_metadata` (node geometry) and `figma-get_variable_defs`
(bound design tokens) instead. Values read from Figma rather than guessed:

| Token | Value | Where it is used |
|---|---|---|
| `MCS Primary` | `#4b58e3` | Banner background. The design keeps Fluent's own brand `#0F6CBD` for buttons and links, so this is applied **only** to the banner. |
| `Shell background` | `#F5F5F5` | Page shell behind the inset white content card |
| `Web/Title 3` | 24 / 32 semibold | Page titles — `Title3`, not `Title2` |
| `Transparency/Slot 5·8·10·7` | `#5EC75A` `#A4CC6C` `#DAC157` `#DF8E64` | Grade avatars, best to worst |
| Content column | 1024 px, centred | Landing and detail body |
| Banner height | 44 px | App shell |

The grade colours are pastel, so the letter is drawn in
`colorNeutralForeground1` — white text on those backgrounds would fail contrast.

## Tests

`npm run test` — 78 tests covering trend derivation, the two invariants the
spec is most specific about (exactly one Active result, and an artifact version
that increments per upload), the Setup checks (the inverted transcript
booleans, that a flow is not offered for activation while a connection
reference is unmapped, that broken connections are never offered, and all four
connection-identifier shapes `normalizeConnectionId` has to cope with), and the
runtime analysis client (each distinct block reason, supersede-on-start, and
that resume writes `Running` rather than `Paused`). The
generated Dataverse services are replaced with an in-memory fake, so the tests
exercise the real mapping and filter logic without a live connection.

## Decisions worth knowing

- **All active agents are listed.** The Agent Review Tool filters to
  `configuration.settings.GenerativeActionsEnabled`, because its rubric only
  applies to generative-orchestration agents. We deliberately do not (FR-086a).
- **DA/Skill artifacts belong to the result, not the review.** Each re-review
  asks for a fresh upload and writes a new result row, so the timeline doubles as
  a version history (FR-112 to FR-114).
- **Artifact version is the upload sequence** — 1, 2, 3 — owned by this app, not
  parsed from a manifest, because `.md` and `.yaml` artifacts have no manifest.
- **Uploads accept `.zip`, `.md`, `.yaml`, `.yml` up to 16 MB.** Dataverse takes
  a file that size in one Web API call; larger needs 4 MB chunking (FR-115a).
- **Only the newest result is Active** (FR-116).
- **Trend is derived on read**, never stored, so it cannot drift (OQ-40).
- **Grades are opaque to the UI.** No rendering code derives a letter from a
  score — the real banding is designed alongside ART (FR-103). `review-service`
  applies a placeholder banding when generating a score, purely so rows are
  internally consistent; without it a score of 85 could show `A` beside an 87
  showing `B+`.
- **Owner names are resolved separately.** Dataverse returns the owner as a
  lookup id; the display name rides on a formatted-value annotation the generated
  table client does not request. Names are fetched from `systemusers` once per
  owner, cached for the session, and treated as cosmetic if the call fails.
- **Empty, error and loading states** use the CoreAI `EmptyState` template
  (published as copy-paste source, so it lives in `shared/components/`),
  `Skeleton`, and `MessageBar`. The landing page's primary empty state shows
  `PlaceholderIllustration` — a token-built stand-in until the real artwork is
  designed. Secondary states (no results, errors, coming soon) keep the icon so
  they do not compete with it.

## Not yet built (Phase 2)

Recommendations, progress tracker, real ART integration,
in-app connection *mapping* (Setup reports mapping state but does not yet change
it), the blocking entry banner, and the live "Returning {n} transcript records"
count, which is deliberately omitted rather than faked (FR-088b).

## Runtime analysis

The **Runtime** tab reports what an agent actually did in production, from its
conversation transcripts. It lives on a **snapshot**, not on the review — see
"Snapshots own their evidence" below. The analysis runs entirely inside Dataverse
— the plugin `AnalyzeAgentRuntimePlugin` (source in
`../../../../AgentRuntimeAnalyzer/`) scans transcripts in bounded chunks and folds
the result into one job row. The app queues that row, polls it, and reads the
report off the end. Nothing is parsed in the browser; a single run can cover tens
of thousands of transcripts (10,010 in ~50 s against kit-dev, ~200-250
transcripts/second).

**Snapshots own their evidence.** A review result is a reading over one
transcript window at one moment, which is exactly what an analysis is, so
`cat_runtimeanalysisjob` points at `cat_architecturereviewresult` via
`cat_resultid`. Hanging it off the review instead — as the first build did —
means a later re-review silently replaces the evidence behind every earlier
snapshot, and the timeline then shows scores that no longer agree with the data
you can open underneath them. The window is stored on the snapshot
(`cat_transcriptstart` / `cat_transcriptend`) and is not editable from the
Runtime tab: changing the window is what taking a new snapshot *means*.

**The analysis is queued when a snapshot is created, and never awaited.** It is a
server-side job that routinely runs for minutes, so blocking the create dialog on
it would make taking a snapshot feel broken, and the snapshot is valid without
it. The Runtime tab rejoins a run that is still in flight
(`runtimeService.inFlightForResult`) rather than starting a second one over the
same transcripts.

**Resuming a parked job writes `Running`, never `Paused`.** Dataverse limits how
many executions a plugin may chain, so the plugin parks itself as `Paused` and
waits for a client to wake it. That park is itself a write, and it re-fires the
plugin's own update step. If `Paused` were also the resume signal, the run would
re-enter the exhausted chain and be killed — observed as a permanent stall
against a live environment. Writing `Running` starts a fresh chain at depth 1.
The update step is filtered on `cat_jobstatus` alone, which is what lets the
plugin write its lease and cursor without re-triggering itself.

**Retention has three rules, and one of them cannot live in the sweep.** A
Dataverse bulk-delete job cannot express "the newest row per snapshot", because
that is relational — so superseding the previous analysis happens client-side in
`runtimeService.start`. The recurring sweep covers what the client cannot: runs
abandoned for over 24 hours, and rows left **unbound to a snapshot** for over an
hour. That second rule exists because every query in the
app is scoped by `cat_resultid`; an unbound row is unreachable forever, so
nothing else would ever dispose of it. Bound rows never reach the sweep — they
cascade away with their snapshot, and a snapshot cascades from its review.

There is deliberately **no age rule**. An earlier generation also deleted
anything older than 7 days, which quietly destroyed the runtime report of every
snapshot more than a week old: a snapshot is a permanent record of one reading,
the Runtime tab loads its analysis by snapshot, and so a populated tab would
empty itself after seven days with nothing to explain why. A succeeded,
snapshot-bound job is not stale — it is the evidence.

Changing any of those rules means changing the sweep's **name**, which carries a
version (`… (v3)`). Dataverse offers no way to edit a recurring bulk delete's
query; `EnsureBulkDelete` cancels every earlier generation it finds by prefix and
schedules the new one. Without the version in the name a redeploy would find "a
job with the right name", conclude there was nothing to do, and silently keep the
old rules.

**Blocked runs are classified, not collapsed into a boolean.** "Recording is
switched off", "you may not read transcripts", "this agent has no conversations"
and "viewing is blocked" need four different responses, and only one of them is
the reader's own to fix. Note that transcript *count* is never used to infer the
recording setting: rows survive the setting being turned off, and new ones can
keep arriving for up to a day afterwards. The setting is read from the
`organization` row (see below) and the analysis runs as the calling user, so
Dataverse — not the app — enforces transcript privileges.

**Knowledge usage is graded by evidence, because retrieval is not use.** Usage is
never inferred from configuration. A source listed in a search tool's
`Available search sources:` block only proves the agent *could* have searched it;
counting that block was the original defect, and it marked every source as used
in every conversation. Each source is instead placed on a four-stage ladder built
from `conversationtranscript` activities:

| Stage | Evidence | Means |
| --- | --- | --- |
| Available | `ToolCallTrace:Started.value.description` | Configured only — never usage |
| Selected | `hiddenFilledParameters.sources` | A source *group* was searched |
| Retrieved | `ToolCallTrace:Completed.value.result` | Returned as a candidate |
| Cited | Answer `[n]` resolves to that result | The source grounded the answer |

Started and Completed traces are correlated on `value.toolCallId`. The resulting
confidence label is what the UI and PDF print:

- **Confirmed used** — mapped to an explicit answer citation.
- **Likely used** — an uncited answer followed a search this source was the
  *only* candidate for.
- **Retrieved only** — came back from a search and was never cited.
- **Selected only** — its group was searched but it never came back.
- **Never used** — configured, with no runtime evidence at all.

Three details are counter-intuitive enough to be worth stating, each having been
checked against live transcripts rather than assumed:

- **`[n]` resolves by identity, not position.** Results do not arrive in
  `ReferenceId` order — `turn2doc5` has been observed returning first — so a
  citation is matched to the record whose id *equals* `turn{turn}doc{n}`. Reading
  the nth element of the result array attributes citations to the wrong file.
- **`turn1doc1` is scoped to a conversation, not to the corpus.** It names a
  different file in every conversation, so aggregation keys on the normalised URL
  or persistent source identity and never on the reference id.
- **"Likely used" is sole-candidate, not top-ranked.** Answer text is
  deliberately not projected (it is most of the payload), so content matching is
  not derivable. Top-ranked-among-many was tried and immediately over-claimed a
  source whose answer had explicitly rejected it. Sole-candidate is the strongest
  attribution the evidence actually supports.

Two counters guard the reader against over-reading a number.
`answersWithoutCitations` says how much of the corpus is unattributable, and
`knowledgeSourcesOmitted` says how many configured sources fell outside the
report's cap — so "0 citations" can be distinguished from "not in this list".
Headline counters (`knowledgeSourcesConfigured` / `Cited` / `NeverUsed`) count
*configured* sources only and are computed before the list is capped. The cap
deliberately reserves room for never-used sources: they sort last but are the
actionable finding.

**Results that match nothing configured are folded into a category, not listed
one per page.** An open-web answer cites a different URL every time — one live
agent produced 638 single-use rows such as "50 Best London Attractions" — and a
row that occurs once carries no signal while crowding out the ones that do. The
fold happens in `KnowledgeCorrelator.Use`, at the point a record is identified,
so the unbounded set never forms; that is why no carry cap is needed downstream.

Classification (`KnowledgeEvidence.Classify`) reads the record's **name before
its URL**, because a document's identity is its filename. The reverse order was
the earlier defect: on an agent whose transcripts carried no configured-sources
block, `Coffee Gear.docx` was reported as a web result purely because it arrived
with a URL.

- `category:web-search` → **Web search results** — every ad-hoc page.
- `category:sharepoint` → **SharePoint and OneDrive**.
- Unmatched documents keep an individual row, typed `Document`. They are bounded
  by what is attached to the agent, and the filename is the actionable unit.

A category row is not a black box: it carries `pagesReturned` and a `sites` map
of domain to conversation count, so "the agent answers travel questions out of
gsa.gov" survives the fold. Category rows are never `configured`, so they stay
out of the headline counters and out of the removal-candidate list — there is
nothing to detach.

Empty states still stay apart. No knowledge steps means none is configured, which
is not a finding; knowledge steps that never searched means configured and idle,
which is. The `knowledgeTraces` / `knowledgeTracesWithSearch` counters exist
solely to tell those two apart.

Connected agents are followed. A parent transcript often contains only the
child's final response, so `ConnectedAgentInitializeTraceData` triggers a second
pass over the child's transcripts, which live under a different bot id and are
reachable only by conversation-id prefix.

### A conversation is not a transcript row

Dataverse writes a long conversation as several `conversationtranscript` rows
sharing one `name`. On one live agent 146 rows were **115 conversations**, and a
single conversation spanned 21 rows. Two things follow, both of which were
getting reported wrongly:

- **Counts.** Rows were reported as "conversations analysed", overstating the
  sample by a quarter. `transcriptsAnalyzed` now counts conversations and
  `transcriptRowsAnalyzed` carries the rows, because a reader comparing the
  report against a Dataverse row count needs both numbers.
- **Attribution.** A search can land in one row and the answer citing it in
  another. Parsed apart, the citation resolves against nothing and the source is
  reported as retrieved but never cited. Worse, the search row on its own has a
  single candidate and no visible citation, so the sole-candidate rule infers
  "likely used" — a measured fact silently downgraded to a guess.

The plugin therefore pages rows, groups them by conversation, and issues one
bounded follow-up query for the rows its page cut off. A conversation is
processed by exactly one chunk: the one whose page held its **earliest** row.
That rule is what makes the extra query safe to run on every chunk without
double-counting anything.

The date range is applied to the completion query too, so a conversation that
began before the analysed window is measured only over its in-window rows. The
report is a statement about a period; reaching outside it would also break the
ownership rule above.

### Turn numbering restarts at every session

`turn{T}doc{N}` is scoped to a session, not to a conversation — and one live row
carried **eleven** sessions. Resolving `[1]` across a session boundary does not
merely miss an attribution, it produces a confident wrong one: the citation lands
on whichever document happened to be `turn1doc1` in an earlier session.

`ConversationInfo` marks the boundary, so the normalizer keeps it as a bare
`SessionStart` marker and every turn-scoped structure in the correlator is keyed
by session as well as turn. Sources accumulated so far survive the boundary;
turn state does not.

**Tool ranking carries `conversationReach`** — the number of distinct
conversations a tool appeared in — because a high call count with a low reach is
a loop, not popularity.

`models/runtime.ts` mirrors `AgentRuntimeAnalyzer/Core/RuntimeModels.cs`. A
rename on either side is a silent break, which is why the report carries
`schemaVersion` and an unrecognised payload degrades to "no report" rather than
rendering nonsense.

**Bump `RUNTIME_SCHEMA_VERSION` in the same change as `SchemaVersion`.** The
guard accepts only an exact match, so leaving the client behind hides every new
report and the tab reads "never analysed" while jobs succeed. A test in
`runtime-service.test.ts` parses the C# default and fails on drift, because
every other test refers to the constant symbolically and so stays green through
it.

## Opening a conversation in the Agent Debugger

Each error group in the Runtime tab lists example conversations as links that
open that conversation in the Agent Debugger. The view they open is the
*Copilot Studio Kit Admin app's own* `AnalysisWorkspace`, but it runs inside
this app, at `/agent-debugger`.

Nothing is copied. `vite.agent-debugger.ts` compiles the component from
`../CopilotStudioKitAdmin/src/features/agent-debugger`, and `tsconfig.app.json`
maps `@agent-debugger/*` to the same place so it is type-checked here too. A
change to the debugger's transcript parser, waterfall or insights tabs is
therefore picked up by this app on its next build, and a breaking change to
`AnalysisWorkspaceProps` fails this app's `tsc -b`. A fork would have given
neither.

Three things make that work:

- **Bare imports are re-resolved against this app.** The Admin tree has no
  `node_modules`, and a bundler resolving `react` from a file outside this
  app's root does not fall back to this app's packages. The Vite plugin
  re-resolves every package import as though this app had made it, which also
  guarantees a single React instance. `tsconfig` does the same with a
  `"*": ["./node_modules/@types/*", "./node_modules/*"]` fallback.
- **App-bound imports are redirected.** `dataSourcesInfo` and the generated
  `MicrosoftDataverseService` describe *which* data sources an app declares.
  Left alone the shared code would address the Admin app's connections, so both
  are pointed at this app's own. The redirect is keyed on the importer, so this
  app's identical-looking relative imports are untouched.
- **`noUnusedLocals` and `noUnusedParameters` are off.** The Admin app sets both
  to false and a compiler flag cannot be scoped to part of a program. No
  coverage is lost: ESLint reports the same thing over this app's own files.

The page renders only the analysis, not the debugger page around it. The agent
and conversation pickers exist to *choose* a conversation and the link has
already chosen one. That also avoids the debugger's `cat_agentdetailses`
lookup, which resolves an agent by its Kit registration and fails when there is
no matching row: `AnalysisWorkspace` skips that lookup entirely when it is
handed a `botId` (`AnalysisWorkspace.tsx:629`), so a conversation opens even for
an agent nobody registered in the Kit. No new data sources are needed — the
transcripts are read through `ListRecordsWithOrganization`, which this app
already has.

The route is deliberately outside the app shell: it is opened in its own tab
from a finding, and a banner offering navigation back to a reviews list that tab
never showed is only clutter.

**The link has to spell its destination as a `deeplink` parameter.** A code app
runs in an iframe on a different origin from the player, so
`window.location.search` is empty and the player's `#hash` never reaches it. The
SDK's `getContext().app.queryParams` is the only channel that carries anything
from the opening URL. `DeepLinkGate` in `App.tsx` reads it once and redirects
before anything renders, rather than showing the reviews list and replacing it a
moment later.

**Neither link spells an app id of its own.** A play URL is
`/play/e/<environment>/app/<app>`, and every solution import assigns a fresh
`canvasappid`, so a GUID written into source is only correct in the environment
it was read from — it points at nothing once this app is installed anywhere
else. This link therefore asks the host which app it is already running as
(`getContext().app.appId`), which reconstructs the play URL the browser is on
rather than guessing it. The Agent Review Tool link has no such shortcut, so it
looks the tool up in Dataverse by its logical name — the same discipline the
Kit's model-driven app lookup already used, for the same reason. If either
lookup comes back empty, the link is withheld and the caller renders plain
text: a link missing any of its three parts looks live and lands on an error,
which is worse than no link.

Unlike the Agent Review Tool link, this one carries **no** `mda_org_url` or
`mda_app_id`. Those exist because ART's router reports "not MDA context" and
ignores `deeplink` without them; this app reads the route straight from the SDK,
so on this link they would only be two parameters naming a third, unrelated app
— the Kit's model-driven app, which is neither the source nor the destination.

**The link carries the conversation id, not the transcript name.** Transcript
rows are named `<conversationId>_<botId>`, and when an agent hands off, the
connected agent's rows for the same conversation carry further segments. The
analyzer follows connected agents and files an error under the name of whichever
transcript recorded it — so a handed-off failure is recorded under the *child's*
name. The debugger matches on name **and** owning agent
(`conversation-transcript-service.ts:114`), so a child's full name finds nothing
under the parent agent: those links dead-ended while their siblings worked,
depending only on which agent happened to fail. `conversationKey` takes the
leading id every participant shares, which selects the parent's rows; the
debugger then expands the handoff into the connected agent itself.

## Testing the analyzer

The C# side has its own tests in `AgentRuntimeAnalyzer/Tests`:

```
dotnet test AgentRuntimeAnalyzer\Tests\AgentRuntimeAnalyzer.Tests.csproj
```

Fixtures are written by hand rather than captured from real transcripts. A live
transcript is user content, and a fixture short enough to read in full is the
only way a test documents *which field* carries the signal it asserts on.

The suite deliberately keeps a control case: the same two rows parsed separately
must **not** reach `ConfirmedUsed`. Without it, a regression in assembly would
leave every assertion about the assembled path passing for the wrong reason.

For live checks against real transcripts the Setup harness has read-only verbs:

```
dotnet run --project Setup -- bots                     # agents, transcript counts, date spans
dotnet run --project Setup -- batches <botGuid> [n]    # how many rows per conversation, and turn numbering
dotnet run --project Setup -- knowledge <botGuid> [n]  # the full knowledge table for one agent
dotnet run --project Setup -- toolerrors <botGuid> [n] # tool trace phases, statuses and result-body error shapes
dotnet run --project Setup -- jobs [n]                 # recent analysis jobs and why they failed
```

### A tool can fail on a successful-looking trace

Copilot Studio emits `ToolCallTrace:Failed` only when the call itself threw. A
tool that ran to completion and handed the planner an error arrives as
`ToolCallTrace:Completed`, and on kit-dev `toolCallStatus` is then *always* the
literal `"Completed"` — 141 of 141. Nothing in the phase or the status
distinguishes it.

The failure is in the result body, which arrives as a JSON **string** rather
than a nested object (132 of 141), in one of three shapes:

| Source           | Shape                                                       |
| ---------------- | ----------------------------------------------------------- |
| MCP tools        | `{"content":[…],"isError":true}`                             |
| Connected agents | `{"conversation_id":…,"agent_response":…,"is_error":true}`   |
| Connectors/REST  | `{"error":{"code":…,"message":…}}` or `{"statusCode":403}`   |

`ToolResultInspector` parses the string and reads all three. Before it existed,
three genuine DevDocs failures were reported as successes — including an MCP
server refusing every call because a licence check failed. `toolerrors` is the
verb that proves the shape in any given environment.

The normalizer extracts only `resultError` / `resultErrorCode` and drops the
body: results routinely run to hundreds of kilobytes and the chunk budget cannot
carry them.

### Error groups are keyed on a normalized signature

Raw messages carry per-call detail, so keying a group on the message splits one
fault into many. Enabling result-body detection made this immediately visible:
`Send an email (V2)` produced five groups for one 500, differing only in the
JSON reader offset quoted at the end, and `GetMyDetails` produced two because
the MCP envelope prepends a per-turn `ReferenceId`.

`ErrorSignature.For` masks GUIDs, `turn{N}doc{M}` references and standalone
6+ digit runs, collapses whitespace and truncates to 160 characters. It
deliberately preserves HTTP status codes and hex error codes: those are what
keep genuinely different faults apart, and the three `List rows from selected
environment` faults (404, 400, 403) must stay in three rows. Unique error types
on DevDocs fell 17 → 12 and the report shrank 55.5k → 45.9k characters.

Masking is whole-token only. An earlier version emitted `0x8{n}` for
`0x80072560`, because once the leading digit was written as a literal the
remaining run looked standalone — the reason `IsStandaloneNumber` rejects a run
preceded by a digit as well as by a letter.

### A source's identity is its filename, not its location

`ZAVA-Visual-Merchandising-Standards-v4.2.pdf` was reported twice on the live
ZAVA agent: a configured "Uploaded file" with 8 retrievals and 2 citations, and
an unconfigured "Document" with a third. One configured source, three citations,
two rows.

Answer citations are markdown reference definitions — `[1]: cite:1 "Some
File.pdf"`. The `cite:N` target is a per-answer placeholder, not a location, so
keying on it gives one file a fresh identity in every answer. The orphan row
appeared in the one conversation that cited the PDF without searching in that
same conversation, so the configured list was never read and the name lookup had
nothing to match against.

`KnowledgeEvidence.DocumentIdentity` keys a document on its filename, and
`ConfiguredKey` uses the *same* rule for a source with no crawl root. Configured
and unconfigured records therefore land on one row without either side knowing
about the other — which is what makes it hold across chunk boundaries, where one
chunk may see only the citation and another only the configured source.

Sharing an identity introduced an ordering hazard worth knowing about: if a
citation claims the key before the configured list is read, the end-of-
conversation loop used to skip it and the source stopped counting as configured.
It now promotes the existing record instead. That regression was visible only as
configured conversations falling from 4 to 3 while the citations merged
correctly, which is why both numbers are asserted in `SourceIdentityTests`.

### A chunk is bounded by bytes, and the report by rows

The row cap was never a bound on work: transcript `content` runs to the 1 MB
column limit, so a 2,000-row page can be gigabytes and the sandbox dies before
the first report is written. A chunk now also stops at a byte ceiling.

Stopping mid-page is safe only because of the assembly rule: the cursor advances
solely over rows actually consumed, and a conversation is owned by the chunk
holding its earliest row, so rows left behind are simply re-read next time. The
one thing that had to change with it is the end-of-scan test — a page cut short
by bytes is *not* a drained query, and treating it as one would end the run
early with a partial report marked complete.

Only the knowledge list was previously bounded. An agent with a noisy error
surface could therefore grow `errors`, `tools` or `nodes` until the update
writing the report exceeded the 1 MB column, which fails the whole job rather
than shortening a list. All four are now capped, and each reports what it
dropped.

Everything the analysis could not cover is now in the report rather than only in
the plugin trace: rows that would not parse, and connected-agent conversations
past the per-chunk cap. Nobody reading a report can see a trace, and a report
that silently omits a child agent's entire tool and knowledge activity is
indistinguishable from one with nothing to omit. The Runtime tab shows a warning
when either is non-zero, and stays silent otherwise — on DevDocs both are 0.

The connected-agent query is also ordered now. With `TopCount` and no ordering,
which child rows survive the cap was the server's choice, so two runs over
identical data could disagree.

### Rule matching is token-bounded

`ErrorAdvisor` matches its rule table against free text, so a bare `IndexOf` is
unsafe: `"Rai"` matches t**rai**ning, **rai**se and const**rai**nt, each of
which would be reported as a Responsible AI content block, and `"400"` matches
any identifier containing those digits. `ContainsToken` requires the character
before to not be a letter or digit and the character after to not be a digit or
a lowercase letter — the uppercase allowance is what keeps `RaiBlocked`,
`NotFoundException` and `403Forbidden` matching.

## Setup page

Reached from the banner gear. Seven checks, all read from Dataverse through
`…WithOrganization`.

**Two scopes, and the difference matters.** Five checks answer for the
environment chosen in the picker — it is selectable because transcript recording
is an environment-level setting and the agent under review often lives
elsewhere. The other two, **connections and flows, are global**: there is one
`Review Agent Components` flow and one set of connection references, they belong
to the environment this app is installed in, and they serve every environment it
reviews.

`CHECK_SCOPES` in `models/setup.ts` records which is which, and `summarise`
stamps it onto every check so a new check cannot forget to declare one.
`connectionsCheck` and `flowsCheck` therefore always read `CURRENT_ORGANIZATION`
and ignore the picker entirely. When the picker is on another environment their
cards render read-only, naming the environment that owns them — editing shared
configuration from a context that does not own it would change it for everyone
without saying so.

Home is decided by comparing `organizationid`, not by the `'current'` sentinel:
the environments list includes the app's own environment, so selecting it *by
name* must leave the global cards editable exactly as selecting "current" does.
For the same reason the picker labels the sentinel with the real environment
name and filters the duplicate out of the list.

**Transcript settings come from the `organization` row, and are inverted:**

| Column | PPAC setting | `true` means |
|---|---|---|
| `blocktranscriptrecordingforcopilotstudio` | "…transcripts saved in Dataverse" | recording **OFF** (blocking) |
| `blockaccesstosessiontranscriptsforcopilotstudio` | "…owners/editors can see transcripts" | viewing **OFF** (warning) |

Mapping these straight through yields a checklist that is confidently backwards,
so the inversion is unit-tested.

**Do not reach for the Power Platform API here.** `api.powerplatform.com`
does not expose these two settings, and is unreachable from a code app anyway:
there is no way to obtain an `api.powerplatform.com/.default` token from the SDK,
and it does not answer CORS for the player origin. DLP is *not* the obstacle —
DLP governs connectors, not `fetch`. Routing it via a custom connector or a flow
HTTP action would work but adds DLP scope and premium licensing for data the
`organization` row already has.

### "Set up agent review"

Ported from the Copilot Agent Kit Installer
(`CopilotAgentKitInstaller/src/features/agent-review-installer/services/agentReviewInstallerService.ts`,
`configureAgentReview`). `setupService.setupAgentReview()` does four things,
skipping any that is already satisfied:

1. `AgentsService.ListAgents()` — proves the user's Agents connection answers.
   Binding a connection that cannot authenticate produces a flow that activates
   and then fails on its first run, which is far harder to diagnose.
2. Finds a `Connected` `shared_agentnode` connection.
3. PATCHes `connectionreferences.connectionid` on `cat_CopilotStudioAcceleratorAgent`.
4. Activates `Review Agent Components`, then re-reads to verify.

Two deliberate departures from the installer: connections are found through the
existing `RetrievePowerAppsConnections` action rather than the Power Apps for
Makers connector, so no second connector is needed; and the activation retry
lives in `setFlowState`, so the manual flow toggle benefits from it too.

**The retry is essential, not cosmetic.** Dataverse accepts the `connectionid`
write immediately but the flow service learns about it seconds later, so an
activation fired straight afterwards is rejected with
`ConnectionAuthorizationFailed`. `activateWithRetry` waits 5s, 10s, then 20s —
but only while the error still looks like propagation, so a genuine permission
failure surfaces in one round-trip rather than after 35 seconds.

**Why the Agents row has a button instead of a connection picker.** Its
connection is created by the Power Apps host when the user consents to this app,
so at the moment a picker would render there is typically nothing to choose, and
the connections page offers no better outcome than the consent already given.
`CheckItem.guidedSetup` marks that row; Dataverse keeps its picker.

### The Agents connector is registered by hand

`pac code add-data-source -a shared_agentnode` cannot be used:

```
Error: CONNECTION_ID argument is required for connector data sources
HTTP error status: 403 for GET .../connections/<id>
```

A first-time installer has no Agents connection to name — the connection is what
the registration is meant to bring about — and the one already present in a
shared environment belongs to whoever installed the solution, so reading it
returns 403. The declaration is therefore authored by hand in two places:

- `power.config.json` — the connection reference, carrying
  `xrmConnectionReferenceLogicalName: cat_CopilotStudioAcceleratorAgent`.
  (`pac code push` accepts this; the platform stores `id`, `displayName` and
  `dataSources`, exactly matching what the installer app produces.)
- `.power/schemas/appschemas/dataSourcesInfo.ts` — the operation schema, kept in
  `scripts/agentnode-datasource.json` and re-merged by
  `npm run restore:agentnode`, which `prebuild` runs automatically.

**Any `pac code add-data-source` rewrites that schema from the server and drops
the entry.** The loss is quiet — the build still succeeds and the button fails at
runtime with "Data source not found" — which is why the restore is wired into
`prebuild` rather than left as a manual step.

Other notes:

- **Connections are listed with the `RetrievePowerAppsConnections` unbound
  Dataverse action**, matching `Agent-Library`'s `ConnectionService` — not the
  Power Apps for Makers connector. Two reasons: no extra connector data source
  (so no extra consent prompt or DLP surface), and the API Hub route silently
  *ignored* its `apiId` filter and returned all 55 connectors in the environment
  regardless.
- **That list cannot be used to validate existing bindings.** It returns only
  connections the *caller* owns. In the dev environment none of the three mapped
  connection ids appear in it — including the two that demonstrably work, because
  a solution-installed reference points at a connection owned by whoever
  installed it. A "does this id resolve?" check would therefore report a
  confident failure on every healthy reference. Absence here is not evidence.
- **A bound id that cannot be parsed is a warning, never a failure.** The badge
  used to read "Mapped" straight from the raw column while the picker read
  `normalizeConnectionId`, got `null`, and showed nothing selected — the two
  silently disagreed. The item now reads "Unrecognised id" and shows the raw
  value. It deliberately does **not** block flow activation: per the point above,
  we cannot prove the binding is broken. Only an empty `connectionid` blocks.
  (Live example: `cat_CopilotStudioAcceleratorDataverse` holds
  `shared-commondataser-91ad7a5d`, 29 characters — shorter than every other
  `shared-…` name observed, all of which carry a full GUID.)
- **The action returns no `createdTime`**, but does return `maxAssignedRoleName`
  ("Owner" / "CanEdit"), which is what the picker shows as the secondary line.
- **Only `Connected` connections are offered.** Mapping a reference to a broken
  connection produces a flow that fails on its first run.
- **Every option is labelled with the id tail.** A tenant accumulates many
  Dataverse connections that all display the signed-in user's UPN — 16 of them,
  15 identical, in the dev environment. The id tail is the only thing a person
  can match against the admin centre.
- **Repointing an in-use reference is confirmed first, and may be one-way.**
  Dataverse validates that the caller has permission on the *target* connection,
  so if a reference currently points at a connection owned by someone else — the
  normal case for a solution-installed reference — the user cannot set it back.
  The dialog therefore shows the full outgoing connection id.
- **Connection references match on logical name**, not display name — the
  display name is editable and already differs per environment
  (`cat_CopilotStudioAcceleratorAgent` shows as "Agent Review Tool | Agents").
- **Which references are required is read from the flow, not hardcoded.** The
  same `Review Agent Components` flow ships in two packages that bind different
  Dataverse references: this app's solution binds
  `new_sharedcommondataserviceforapps_99a44867`, the Copilot Studio Kit binds
  `cat_CopilotStudioAcceleratorDataverse`. Since the app is supported with and
  without the Kit, a hardcoded name is wrong in one of them. It used to demand
  the Kit's name unconditionally, so every install of this app's own solution
  reported a reference that was never created as "Missing" — and blocked on it —
  while never checking the one the flow actually used. The names are now scanned
  out of the installed flow's `clientdata`, which lists every
  `connectionReferenceLogicalName` it binds. When no flow is installed yet there
  is nothing to read, so the shipped names are used as a fallback.
- **Required flow**: `Review Agent Components`, read with
  `category eq 5 and type eq 1`, toggled two-way with `statecode 1 / statuscode 2`
  (on) and `statecode 0 / statuscode 1` (off) — the same shape as PowerShield's
  `workflowService`.
- **Activation is refused while any connection reference is unmapped**, since the
  flow would turn on and fail on first run. Turning one *off* is always allowed.
- **`unknown` is a first-class status.** An environment-group rule can override an
  environment setting without changing the row, so passing cards still link to
  PPAC rather than claiming to be the last word.
- **The PPAC deep link needs the environment GUID**, available only for the
  current environment via `getContext()`; `organization.microsoftflowenvironment`
  is empty in practice.
- **Combine Griffel classes with `mergeClasses`.** Joining two `makeStyles`
  classes into a template string leaves two sequence hashes in one attribute and
  the second rule silently loses — this rendered every status icon in the default
  foreground instead of its status colour.

## Share results

The `Share results` button on a result (snapshot) exports the snapshot as **JSON**
or **PDF**. Both are rendered from one `ShareReport` object built by
`services/report-service.ts`, so the two cannot describe different runs. The PDF
truncates each ranked table to the top 8 rows and says so; the JSON carries every
row and is a strict superset by construction.

The report merges two sources that mean different things by "absent":

| Source | Covers | Absence means |
| --- | --- | --- |
| Agent Review Tool | the agent's full configured inventory | the capability is not configured |
| Runtime analyzer | only the transcripts in the snapshot's window | *nothing on its own* |

So "which tools are never called" is not answerable from either source alone. It
is the design inventory minus the observed set, and only meaningful when the
sample observed activity of that kind at all. `buildCapabilityUse` therefore
reports three states, never a boolean:

- **`observed`** — matched by name in the transcripts, with call counts and latency.
- **`not-observed`** — configured, and the sample *did* record activity of that
  kind, so its absence is evidence.
- **`not-attributable`** — configured, but the sample recorded no activity of that
  kind (`totalToolCalls === 0` / `knowledgeTracesWithSearch === 0`), or no analysis
  exists. `calls` is `null` here, never `0`, because zero would read as "we watched
  and it never ran".

Only `not-observed` entries reach `neverCalledTools` / `neverSearchedKnowledge`.
That is the list someone deletes from, so it must never contain a guess.

Other decisions:

- **A citation rate is only printed alongside its confidence label.** "0% cited"
  means two entirely different things for a source that was retrieved four times
  and ignored versus one whose group was searched and which never came back — the
  first is retrieval cost, the second is a matching problem. The rate's
  denominator is `max(retrieved, cited)`, because sources cited through the
  classic markdown reference-definition path carry a citation with no matching
  retrieval record and would otherwise report a false 0%.
- **Name matching normalises case and whitespace only.** Stripping punctuation
  would start merging genuinely distinct capabilities, and a false `observed` is
  worse than a false `not-observed` — it silently credits a tool that never ran.
- **Observed capabilities ART never inventoried are kept** with
  `inDesignInventory: false` (connected-agent hops, platform tools). Dropping them
  would stop the per-tool counts reconciling with `totalToolCalls`.
- **Example conversation ids are capped at 10 per error type.** Three numbers stay
  distinct and none is a substitute for another: `affectedConversations` is the
  error's real reach, `totalExampleConversations` is how many example ids the
  analyzer collected (itself a sample), and the list shown is at most 10.
- **The transcript window is on the cover and in `notes[]`.** Every runtime figure
  is scoped to it, and a reader who misses that will read "not observed" as
  "unused". The caveats travel as data so JSON consumers get them too.
- **jsPDF is pinned to 4.x, not the 2.5.2 the Agent Review Tool uses.** 2.x carries
  unpatched critical advisories. Only core text and vector drawing is used, and
  `services/report-pdf.test.ts` renders a real PDF to prove that API surface still
  behaves — a signature change there would not fail the type check.
- **The PDF module is imported dynamically** in `ShareResultsButton`, so the jsPDF
  bundle is not paid for by the many visits that never export.
- **`sampleMessages` is kept, and carries no conversation text.** The name invites
  the assumption that it holds user utterances. It does not: every value is sourced
  from a diagnostic field — an error object''s `message`, a connector `errorMessage`
  or `status`, or a string the parser synthesises (`AgentRuntimeAnalyzer/Core/TranscriptParser.cs`).
  It is what turns "a connector failed" into "Connector returned 403". The residual
  risk is an upstream validation error that echoes a submitted value, which the
  3-sample cap and the analyzer''s 300-character trim bound.

### Design sections carried from the Agent Review Tool

`REPORT_SCHEMA_VERSION` is **3**. The design half of the report carries five
things beyond findings and pillars, all read from `agentsExperience` in
`cat_reviewresultjson`:

| Field | Source | Why it is in the report |
| --- | --- | --- |
| `scoreBasis` | `score.basisVersion` / `score.status` | A legacy (v1) score and a partial v2 score both look like any other score and mean less. ART prints this on its own PDF cover for the same reason. |
| `skillReviewMode` | `skillReviewMode` | `standard` means ART could not read each skill's resources, so a clean result covers less ground than a `deep` one. |
| `instructionCoverage` | derived from `Instructions` findings + `analysisStatus` | The five-element grid. |
| `coverage` / `coverageBasis` / `coverageSets` | same-named keys | Which configured capabilities the evaluation sets exercise. |
| `orchestration` | `crossSkillOrchestration` | Findings about how skills interact. Agent-level by construction, so they appear nowhere in `findings` and would be dropped entirely. |

Three of these need care:

- **The instruction grid is derived, not stored, and ART's own rule is copied
  deliberately.** A missing element is recorded as a finding whose `fact` reads
  `element "role" not found in instructions`, so the check is for the *quoted*
  key. That precision matters: the positive "covers all five" finding reuses id
  `INS-02` — the same id as the "role is missing" rule — and states
  `role, tone, boundaries, ambiguity handling, and escalation are all present`
  *unquoted*. Matching on the bare word, or on the id, would turn a clean review
  into five failures. Deriving it independently was rejected: both reports
  describe the same review and must not disagree about it.
- **The grid is only drawn when `evaluated` is true** (`analysisStatus.instructionCoverage.state === 'complete'`).
  A review where the classifier never ran has no missing-element findings, which
  would otherwise render as five ticks — a clean bill of health from a check that
  did not happen. The PDF prints the state instead.
- **`coverageBasis` is printed with the coverage table, not as a footnote.** Under
  `inferred` — the live default — ART matched cases to capabilities by name, so a
  zero can mean "not exercised" *or* "could not be determined". The numbers
  overstate themselves without it.

Verified end-to-end against a live GitHub Copilot agent review in kit-dev: the
exported JSON reported 7 of 10 capabilities with zero cases, matching ART's own
`EVL-02` finding ("7 capabilities have no declared test coverage") computed
independently.
