# Phase 3: Domain Rules And Scheduling

Status: Main-thread approved implementation elaboration on 2026-09-08.
The policy numbers and compatibility strategy below are approved product
defaults, not external travel facts or passed acceptance tests.

## 1. Authority And Ownership

Read [the glossary](../../CONTEXT.md) and the complete
[approved baseline](0001-mvp-product-and-workflow.md), especially Sections 5,
8-12, 14, 17, 19 and 20. Acceptance authority remains AC-01 through AC-17 in
that baseline. [The development workflow](../agent-workflow.md) controls routing.

This assignment owns this document only. It designs the bounded domain portion
of Phase 3: Brief reduction, Requirement Assessment, scheduling policy,
validation, and Typed Commands. Persistence is described only through the
requirements its caller must satisfy. The main thread separately owns
[the SQLite repository design](0005-sqlite-repository.md), its public interface
and transaction acceptance tests, plus environment, authentication, Run execution,
launch scripts, README, requirements and an independent Git repository.
Baseline Section 18 now selects SQLite on local persistent disk for one host:
no Docker, PostgreSQL service or separate database-driver dependency is required.
The repository uses the main-thread-tested built-in `node:sqlite` driver.
This document does not initialize, move, commit, or clean a repository.

The overall goal is a runnable product covering all AC-01 through AC-17.
Completing this domain assignment alone cannot meet that goal. No HTTP handlers,
database migrations, worker, SSE transport, model prompts/adapters, browser map,
frontend edits, dependencies or executable implementation are authorized here.
Do not introduce runtime specialist agents or LangGraph. Do not change approved
scope, model routing, or design 0001 without main-thread approval.

## 2. Inspected Contracts And Required Evolution

The inspected implementation is the Phase 1 presentation milestone:

| Existing surface | Constraint on Phase 3 |
| --- | --- |
| `src/domain/contracts.ts`, `tripBriefSchema` | Requires destination and 1-7 days immediately; string Hard Constraints cannot drive deterministic validation. Keep this presentation shape; add a strict canonical incomplete Brief schema. |
| `placeSchema`, `evidenceSchema` | Fixture provenance, nullable coordinates, and generic citation text are insufficient for grounding, applicability or admission rules. Add canonical grounded Place and field-level Evidence schemas. |
| `visitSchema`, `legSchema`, `dayPlanSchema` | Clock times cannot represent an unscheduled draft; Legs only join Visits; no break, buffer or boundary-transfer records exist. Add draft and canonical schedule schemas without fabricating Visits for non-attraction blocks. |
| `itineraryVersionSchema` | No frozen Brief, effective policy, mutation origin or fact revisions. Add a canonical persisted snapshot schema; never treat a parsed Phase 1 fixture as commit-valid. |
| `typedCommandSchema`, `turnInputSchema` | Preserve all current command discriminants and fields, ID formats, explicit null creation baseline, and required Turn/version/Brief revision. No client Owner field. |
| `requirementIssueSchema`, `turnEventSchema` | Preserve issue fields and strict event vocabulary. Map richer internal issues to these existing transport shapes; do not add raw reasoning, prompts, percentages or arbitrary fact payloads. |
| `tests/contracts.test.ts` | Exact fixture keys, fixture provenance, unknown-field rejection and deep freezing are intentional. Preserve these tests; add canonical-schema tests separately. |
| `src/components/itinerary-workspace.tsx` | Timeline indexes `day.legs[index]`; boundary transfers must not be inserted into that array. Later UI work must render schedule blocks from the same version. |

### Compatibility Strategy

Keep the current exported presentation types and Phase 1 fixture intact during
domain implementation. Add strict canonical types under `src/domain/`, exported
through its existing index. Use explicit names such as `BriefState`,
`GroundedPlace`, `EvidenceFact`, `ItineraryDraft`, `ScheduledItinerary` and
`CommittedItinerarySnapshot`. These are implementation representations of
existing glossary terms, not replacement domain language.

For subsequent application integration, add an explicitly versioned read model
which retains current required display names and extends them with schedule
blocks, provenance and structured notices. Do not make live data claim
`provenance: "fixture"` just to satisfy a presentation schema. Do not add catch-all
fields or silently strip unknown fields. Existing v1 fixture payloads still
parse unchanged; the live v2 read model requires an explicit projector and
coordinated frontend adoption before the Phase 4 end-to-end gate.

There is one authoritative snapshot per version. A read-model projection is
derived data, never another mutable itinerary. All canonical schemas reject
unknown fields and discriminate draft, validated, and persisted records.
Unknown route time may exist in a draft, not a committed timeline.

## 3. Canonical Inputs

### Brief State

The incomplete Brief must represent missing and ambiguous answers, including
invalid-but-identifiable duration requests, without first passing the existing
complete `tripBriefSchema`. Its strict input schema still rejects arbitrary
fields, malformed ID syntax and invalid value types. Represent:

- `revision`, destination query and resolution status; a resolved destination
  has a canonical city ID, permitted administrative-area IDs and time zone.
- Nullable requested day count, start date and end date. Day count may be outside
  1-7 at this collection stage so scope issues can be returned together.
- A destination candidate set and unresolved must-visit/start/end references.
  An ambiguous reference retains its choices; never pick the first match.
- Typed Hard Constraints with stable IDs: must-visit Place, excluded Place,
  fixed Visit start, allowed day window, verified admission/accessibility,
  explicit maximum walking duration/distance, and explicit Visit-count limits.
  Preserve an unrecognized explicit Hard Constraint as an unresolved blocking
  issue; never downgrade it to a Preference because code cannot enforce it.
- Preferences for pace and transport, optional interests and companion context;
  explicit supported transport restrictions belong in Hard Constraints.
- Per-day windows, optional grounded start/end Places, and separate flags saying
  a start/end Place is required. A supplied hotel address is a reference to
  ground, not coordinates and not a booking request.
- Explicit duration overrides, allowed repeated Place IDs, explicitly free days,
  Trip-level excluded Place IDs, and accepted policy overrides. Distinguish
  absent, explicitly cleared, and explicit Owner values in a Brief patch.
- Structured Assumptions with stable key, affected field/day, chosen value,
  policy version and Owner override status. Display strings are projections.

Use date-only calendar arithmetic in the resolved city's time zone. Inclusive
date ranges determine `dayCount = calendarDaysBetween(start, end) + 1`. Reject
reversed ranges, disagreement with an explicit day count, and 0 or more than
7 days together with other known issues. Do not subtract UTC timestamps to count
travel days. A start date plus day count determines the end date; an end date
alone does not determine duration. Phase 3 fixtures support Beijing only, with
`Asia/Shanghai`; live capability registration belongs to provider integration.

### Facts And Candidates

`GroundedPlace` carries canonical ID, provider record identity, canonical city
and administrative area, coordinates with coordinate-system provenance, and an
immutable fact revision. District display text is not membership verification.
Coordinates may not be null on a scheduled attraction or boundary Place.

`EvidenceFact` binds an Evidence ID and immutable revision to Place ID, a typed
field/value, supporting excerpt, source URL, retrieval timestamp, applicability
dates and `known | unknown | conflicting` status. Minimum admission fields are
opening windows, closure dates, latest entry, reservation requirements and entry
conditions. Accessibility facts have the same provenance requirements. A known
external fact requires source URL and retrieval time; unknown facts carry no
invented values. Fixture sources are explicitly synthetic, never live evidence.

The domain consumes an adapter's resolved applicability/freshness status; Phase 5
must pin fact-specific freshness rules. Stale required facts are not treated as
verified. Unresolved contradictory facts stay conflicting, not merged.
Provider policy cannot authorize ignoring an explicit required fact.

A grounded candidate binds a supplied candidate ID to a GroundedPlace and
applicable Evidence/duration-option IDs, with Trip/Run/base references in the
caller-owned candidate set. Unknown or stale candidates are rejected. Models
return only supplied references and permitted ordering/grouping, not numerical
durations, coordinates, route facts, opening times or URLs.

## 4. Requirement Assessment

Assess the entire reduced Brief, not just changed fields. Gather independently
identifiable issues in one pass; do not short-circuit on missing destination.
Do not manufacture downstream contradictions where prerequisites are unknown.
Run assessment again after grounding exposes ambiguity and after every answer.

| Check | Result |
| --- | --- |
| Missing/ambiguous destination; missing duration; unsupported city, day count or requested transport capability | Blocking missing/ambiguous/unsupported issue. |
| Must-visit or required boundary Place unresolved/ambiguous | Blocking issue with available choices. |
| Exact-date opening/admission verification requested without sufficient dates | Blocking missing-date issue. |
| Must-visit also excluded, contradictory windows/fixed times, unsupported Hard Constraint, explicit density irreconcilable with a hard pace limit | Blocking conflict/unsupported issue. |
| Trip shrinks across a locked day; fixed/must-visit requirements cannot fit retained days without a decision | Blocking conflict; no automatic relocation or removal. |
| Enough known lower-bound stay/travel/buffer time already exceeds a hard window | Blocking conflict; unknown route time is not zero. |
| Missing budget, dates without exact verification, start time, mode, pace, companions, meals or lodging | Visible Assumptions as applicable; no requirement to answer before planning. |
| Optional unresolved boundary address that was actually requested for inclusion | Return its grounding issue; do not silently discard the requested transfer. The Owner may explicitly withdraw it. |

Budget default is unspecified, not an invented spending amount. Companions are
unspecified, not assumed adults or accessibility-compliant. Meals use time
reservations only; lodging and booking are not generated. Missing boundary Places
produce the explicit assumption "starts at the first attraction and ends at the
last; airport/hotel transfers are not included."

Default pace and transport are preferences. They must not cause an alleged
Hard Constraint contradiction merely because a remote attraction is inconvenient.
An attraction inside the allowed areas remains eligible; outside-area requests
require an explicit scope decision. Before route facts exist, do not claim that
ordinary missing travel data proves infeasibility.

Return `blockingIssues`, `assumptions` and `warnings`. Issue identity is stable
for the same rule, target and normalized conflict; sort by field, rule and target
for reproducibility. Each assessment exposed for a waiting Run has one monotonic
issue revision; every transported issue has that revision. Options are display
choices, not authority to use an arbitrary Place ID. The caller checks bound
Run/issue revision before reduction, then persists the complete new assessment.

## 5. Versioned Schedule Policy

Proposed policy ID: `schedule-mvp-v1`, fixture revision `schedule-fixtures-v1`.
All following numbers are explicit product defaults selected for review, not
claims about Beijing, attraction visit times, walking ability, queue length,
meal availability or provider travel time. Policy values have
`source: "product_policy"` and an editable Assumption; external facts instead
have provider/Evidence provenance. No web research is needed to assert a chosen
policy; live facts require provider verification.

| Setting | Pinned value and interpretation |
| --- | --- |
| Default day window | 09:00-18:00 in destination local time; same-day only. |
| Internal time unit | Integer minutes after local midnight; intervals `[start, end)`. Supported clock range 00:00-23:59; no implicit midnight wrap. |
| Planned stay bounds | 1-1439 integer minutes, additionally constrained by actual day/opening windows. Never clamp a submitted duration. |
| Policy stay default | Relaxed 120 minutes; balanced 90; brisk 60. Applied only without Owner duration or applicable sourced recommendation. |
| Automatic selection target | Relaxed 2, balanced 3, brisk 4 Visits per non-free full day. This is an optimization target, not a required count. |
| Soft Visit-count ceiling | Relaxed 3, balanced 5, brisk 7 per day. Exceeding emits a pace Warning, not automatic deletion or a hard error. |
| Soft walking totals | Relaxed 60, balanced 120, brisk 180 minutes per day; relaxed 4000, balanced 8000, brisk 12000 meters per day. |
| Soft longest walking segment | Relaxed 30, balanced 45, brisk 60 minutes. Provider walking components count, including boundary transfers; no straight-line estimate. |
| Lunch reservation | One 45-minute block, 12:00-12:45, when the non-free day's window fully contains it. Otherwise omit with a visible short-window Assumption. |
| Rest reservation | 15 minutes after every second completed Visit only when another Visit remains that day. No trailing rest and none on free days. |
| Entry buffer | 10 minutes immediately before each attraction Visit, subject to coverage rules below. Not before a boundary Place. |
| Transfer buffer | Walk/bicycle 0 minutes; public transit/taxi/drive 5 minutes per traveled segment, including each boundary transfer, subject to coverage rules below. |
| Opening wait | Earliest feasible placement, with waiting explicitly recorded; no arbitrary maximum wait. Entire schedule must still fit. |
| Default transport preference | Walking plus public transport. Actual supported mode and confirmed routes decide feasibility. No default speed or distance-to-time conversion. |
| Algorithm budget | One deterministic forward scheduling pass per supplied Visit Order; no internal route search, backtracking, model call or repair loop. |

An Owner may override policy stay, breaks, buffers, planning window and soft
limits with explicitly accepted structured settings. Positive stay duration,
same-day time representation, actual openings, verified required conditions and
explicit Hard Constraints are never waived. Overrides persist with origin and
scope. A fixed Visit overlapping the default lunch is a conflict to resolve by
explicitly shifting/disabling the editable lunch policy, not a claim that the
venue is closed. Do not silently override an Owner constraint to retain a default.

Duration precedence is Owner override, applicable sourced recommendation,
then policy default. A lock preserves its existing duration and its original
provenance; policy changes or newly retrieved recommendations cannot change it.
Owner duration updates mean planned stay, excluding separately displayed
buffers. Invalid sourced recommendations are unusable facts: warn and use the
visible policy only when they are not a required minimum. A required sourced
minimum conflicting with an Owner duration blocks instead.

### Buffer Coverage

Facts/duration options explicitly report included buffer components with coverage
`included | excluded | unknown` and, if known, included minutes. Transfer buffers
cover boarding/transfer allowance, not additional walking or guessed congestion.
Entry buffers cover a planning allowance, not a prediction of queue duration.

- If a component is excluded, add the full selected policy allowance.
- If included minutes are known, add `max(0, policyAllowance - includedMinutes)`.
- If included but amount is unknown, add zero for that component.
- If coverage is unknown, add zero and emit an uncertainty Warning; never blindly
  add a second allowance. Explicit Owner buffer overrides can resolve the choice.

Fresh Owner stay inputs and policy stay defaults declare entry coverage excluded.
A sourced stay recommendation must provide coverage or use the unknown rule.
Route adapters must supply transfer coverage; unknown is an honest supported
fallback, not a reason to invent provider metadata. Known durations are counted
once regardless of geometry availability. Freeze effective coverage, additional
buffer minutes and provenance in the snapshot so replay cannot reinterpret them.

## 6. Deterministic Scheduling

The scheduler consumes allowed Visit Order, resolved stay inputs, effective
windows/policy, admission facts and route results. It does not choose attractions
or infer geographic facts. It returns either a scheduled candidate plus notices
or a non-committed draft plus all identifiable issues.

1. Establish exactly the Brief's contiguous 1-based days and each day's effective
   window. Explicit per-day/arrival/departure windows replace defaults; actual
   hard availability windows intersect them. Empty intersections are conflicts.
   A one-day trip applies both arrival and departure restrictions to that day.
2. Resolve durations by the precedence above. Reserve fixed lunch and explicit
   Owner break blocks. Preserve fixed Visit starts as constraints, not locks.
3. Start at the day window's beginning, consume a start boundary transfer if
   present, then its additional transfer buffer. Before each Visit place its
   additional entry buffer and stay contiguously at the earliest feasible time,
   respecting fixed breaks and applicable opening windows. Record idle waiting.
4. After each Visit, add the required rest when another Visit remains, then its
   outgoing Leg and additional transfer buffer. If a travel/rest/buffer block
   would intersect a reserved break, wait until that break ends before placing
   the contiguous block; never overlap or duplicate the break. Fixed Visit
   starts and latest-entry checks may make that order infeasible.
5. After the last Visit include the end boundary transfer and its buffer, when
   present. Validate the resulting end against the effective day window.
6. Missing duration on any required Leg/transfer leaves dependent Visit times
   unresolved, with feasibility unverified. Return a draft, never guessed times.
   Evaluate independent days and constraints to report other visible issues.
7. Independently validate the candidate before proposing it for commit.

The scheduler need not find every mathematically feasible arrangement. Its
structured placement failure identifies the rule and affected scope; generation
may reorder through the baseline's bounded repair workflow. A deterministic
Typed Command never invokes semantic repair. Do not assert a global impossibility
when only the supplied order fails the forward pass.

Known opening windows must contain the entire stay, including any sourced
required entry condition. Disjoint windows remain disjoint. Entry allowance
cannot imply access before a known permitted entry time. Latest entry is
inclusive (`visit.start <= latestEntry`); close-time departure is allowed.
Fixed start means the Visit's start, not the beginning of a travel or buffer
block. Unknown applicable opening windows produce a Warning unless verified
access was required; then they block. Undated plans never assert date-specific
availability, and explicitly known universal closure is not ignored.

### Schedule Blocks And Boundary Transfers

Each canonical day carries `visits`, adjacency-only `legs`, `boundaryTransfers`
and an ordered `scheduleBlocks` ledger. A block references a Visit, Leg or
boundary transfer, or has kind `meal | rest | entry_buffer | transfer_buffer |
wait`. Every block has local start/end minute, origin, applicable policy key or
fact revision, and a stable local ID. Zero-length extra buffers are omitted.
Each duration appears in exactly one occupied ledger interval. Derived Visit
clock strings and end times must equal that ledger, not a separate calculation.

Boundary transfers use endpoints discriminated as Visit reference or grounded
boundary Place reference. They do not create attraction Visits, affect Visit
counts or satisfy must-visit constraints. They do consume time and walking
limits, require supported modes and follow every route degradation rule.
Changing the first/last Visit invalidates its respective boundary transfer.

For an explicitly free day with both boundary Places, include a direct boundary
transfer when they differ. With only one boundary Place, show the free day with
no inferred destination or transfer. If endpoints resolve to the identical Place
ID, a code-derived identity transfer consumes zero time and has no invented
geometry; coordinate proximity alone does not establish identity. Canonical
route duration accepts zero only for that identity case or an explicitly
provider-confirmed zero duration. The legacy positive-duration fixture schema
does not govern this new canonical representation.

Reused route facts require matching endpoints, mode, applicable date/departure
context, fact revision and buffer coverage. If rescheduling changes a
time-dependent route's applicability, return a route requirement to the caller;
do not quietly reuse it or loop without the workflow's recorded budget.

Freeze explicit route temporal provenance in addition to nullable dates:
`temporalBasis` is `time_independent`, `departure_estimate`, `current_estimate`
or `identity`. Only walking/bicycle facts may claim time independence; identity
requires the existing same-Place code identity rules. A departure estimate
requires its requested date and nonempty departure window, and is reusable only
inside both. A current estimate is not evidence of future-date availability:
it carries a visible `route.current_estimate` Warning, not an implicit wildcard
claim of exact applicability. Explicit exact-departure requirements that the
capability cannot enforce remain blocking, never downgraded by this label.
Adapters also supply `freshness: current | stale | unknown` for new planning;
stale/unknown confirmed facts require rerouting before scheduling. Historical
snapshots freeze the admission assessment and are not recalculated using today's
clock. Identity routes use current freshness without an external retrieval time.

### Numeric Fixture Expectations

These are synthetic arithmetic cases, not travel recommendations:

- Window 09:00-12:00, two Owner stays of 60 minutes, entry coverage excluded,
  one confirmed walking Leg of 20 minutes: Visits 09:10-10:10 and 10:40-11:40.
  Total occupied time is `60 + 60 + 10 + 10 + 20 = 160` minutes. No lunch or
  trailing rest; lunch omission is explicit.
- Window 14:00-18:00, two 60-minute stays, 10-minute entry buffers, start/interior/
  end walking transfers of 30/20/40 minutes: Visits 14:40-15:40 and 16:10-17:10,
  end transfer finishes 17:50. Total is 230 minutes; boundary time counts once.
  Changing the day end to 17:30 produces an ERROR and no version.
- A 20-minute transit result with 5 minutes of included transfer allowance
  consumes 20, not 25, minutes. With 2 minutes included it consumes 23; unknown
  coverage consumes 20 and emits a Warning.
- Three Visits trigger exactly one 15-minute rest; two Visits trigger none.
  A 09:00-18:00 non-free day reserves exactly one 45-minute lunch. A Visit cannot
  span that reserved interval unless the Owner explicitly changes that policy.

## 7. Validator Interface And Severity

The pure validator independently checks scheduler output and externally composed
draft references. Caller and tests use the same interface. It returns structured
issues with stable code, severity, field/target IDs, concise message,
`owner_decision | redraft | reroute | retry | reject` disposition, and supporting
fact IDs when relevant. Disposition is advice to the workflow, not a tool call.

| Validation group | Required checks |
| --- | --- |
| Brief/structure | No blocking Requirement Issues; exact day count; contiguous indices; unique day/Visit/Leg/block IDs; stable surviving Visit IDs. |
| Grounding | Supplied/owned candidate and Place references; allowed area; valid coordinates/system; no duplicate Place unless explicitly allowed. |
| Inclusion/scope | All must-visits present; all exclusions absent; empty days explicitly allowed; no changes outside approved local scope. |
| Locks | Place, day, duration and pairwise order of locked Visits unchanged; clock time may change unless fixed separately. |
| Time | Positive bounded stays; stay/end agreement; ledger consistency; no overlapping occupied blocks; fixed starts, windows, breaks and applicable opening/latest-entry constraints. |
| Routes | Exactly one Leg for each adjacent Visit pair and no extra adjacency Legs; endpoints/order/mode correct; required boundary transfers exact; applicable confirmed durations and provenance. |
| Geometry | No invented path; matching coordinate-system provenance throughout; missing geometry never replaced with a straight road line. |
| Pace/access | Explicit hard limits enforced; soft policy excess warned; walking totals include provider walking components and boundary transfers. Unknown components cannot prove a hard walking limit satisfied. |
| Admission/Evidence | Known unmet reservation/entry/closure conditions block; unknown required admission/accessibility blocks; correct Place/field/date Evidence binding, source/retrieval metadata and immutable revisions. |
| Provenance | No model-provided numeric facts or fabricated IDs; every duration and schedule allowance has its distinct permitted origin. |

Existence of an Evidence ID does not prove textual entailment. The domain checks
typed binding and provenance; unsupported narrative is excluded by the composing
interface and later source/evaluation checks. It cannot claim to prove source
semantics from a URL. Ordinary route availability never proves accessibility.

Route outcomes exactly implement baseline Section 12:

| Result | Candidate status |
| --- | --- |
| Confirmed duration and geometry | Validate normally; no route Warning unless another field is missing. |
| Confirmed duration, missing geometry and/or distance | May commit degraded; omit missing line/distance. Missing walking distance still blocks an explicit required distance cap. |
| Missing duration, not known unreachable | ERROR preventing commit; retain a draft with unverified feasibility and retry/alternative choices. |
| Known unreachable, admission conflict, violated Hard Constraint | ERROR; never a degraded bypass. |
| Required accessibility fact unknown | ERROR with Owner-decision/unresolved-fact issue, even if ordinary route succeeds. |

An ERROR always forbids commit. WARNING permits a degraded result only when no
ERROR remains. ASSUMPTION alone does not imply provider degradation. A draft
that schema-parses or looks reasonable is not a validated complete itinerary.

## 8. Typed Edits And Mutation Scope

The existing Turn envelope is mandatory for every command. The caller performs
authorization, idempotency and base checks before running the pure edit planner.
The planner works on one immutable base and returns `no_op`, `rejected`,
`route_required`, `candidate`, or a bounded semantic/control dispatch.
It performs no model, research, persistence or provider I/O.

| Existing command | Deterministic behavior and scope |
| --- | --- |
| `remove_visit` | Reject locked/must-visit target; remove and exclude its Place at Trip level, reschedule that day, update affected adjacency/boundary transfers. A now-empty day is explicitly free. |
| `move_visit` | Preserve ID and Place/duration; scope includes source and destination days. Remove first, then interpret `toIndex` against destination's remaining list; allow 0 through its length, reject out-of-range indices. Same final order is a no-op. |
| `set_visit_lock` | Only changes lock metadata; equal value is a no-op. Explicit unlock is required in a prior successful command before a prohibited edit. No automatic unlock through repair. |
| `update_visit_duration` | Set Owner stay override on the target; reject locked target unless value is unchanged. Reschedule that day; reroute only when route applicability changes. |
| `update_day_start_time` | Change that day's explicit scheduling start, preserving end and hard arrival/departure availability. Reject start at/after end or fixed-time infeasibility. |
| `update_day_transport_mode` | Check capability/hard restrictions, reroute that day's affected Legs and boundary transfers, then reschedule. No invented fallback mode. |
| `replace_visit` | Resolve selected supplied candidate deterministically; reject locked/must-visit old target, excluded replacement, duplicate or out-of-area candidate. Allocate a new Visit ID; preserve surviving IDs. Exclude old Place to prevent its automatic return. |
| `regenerate_day` | Return bounded semantic dispatch for that day, with locks, must-visits, exclusions, explicit durations and boundaries. No NLP intent interpretation. |
| `cancel_run` | Return Run-control dispatch only; it cannot create a candidate or start generation. |
| `retry_run` | Return linked-new-Run dispatch after caller rechecks scope/current bases; no local reset of an old Run or its consumed budget. |

Replacement selects a new planned presence: it does not silently copy the old
Visit's explicit duration or Visit-specific fixed start to the new Place.
If an old Visit-specific Hard Constraint exists, return a conflict requiring
resolution. The new Visit uses its own Owner/sourced/policy duration precedence.
Replacing by the same Place is a no-op unless explicitly requesting another
presence through an approved requirement change.

Removal/replacement exclusions persist across later generation and repair until
an explicit Owner re-add Brief patch clears them. An `add_visit` command is not
silently added to the current public union; re-add is an explicit requirement
update until a later approved command extension. Failed commands do not persist
their tentative exclusions or policy changes.

Moving a locked Visit to a different day/order is prohibited, even when it is
the only lock. Moving an unlocked Visit around locks is allowed provided locked
Visits retain their pairwise order and all remaining constraints are satisfied.
Locking does not freeze Visit ordinal among unlocked Visits. No-op detection
precedes lock-conflict detection for commands that truly change nothing.

Local edits preserve every unaffected Day Plan's canonical content, stable IDs,
facts, policy and notices byte-for-byte in normalized snapshot representation.
Only top-level revision metadata and explicitly affected Brief fields may differ.
Cross-day moves name both days; deleting the last source Visit explicitly frees
that day. Never silently remove a day to match the number of remaining Visits.
Shrinking duration across a locked day requires a decision even if relocation
looks easy. Surviving explicit stay overrides and Trip exclusions survive repair.

Typed edits use the base version's frozen policy, not the currently shipped
default. Changing policy version globally is a separately approved requirement
mutation, not a side effect of a local edit. If a newer pending Brief cannot be
reconciled with the displayed base version within the requested scope, return a
structured pending-requirements conflict; do not generate from a hidden Brief
or overwrite its pending changes.

Only affected adjacency pairs, changed boundary endpoints, changed modes and
time-inapplicable results require routing. Scope never silently expands after a
route or validation failure. Invalid explicit edits return all known issues and
retain the current version, with zero implicit semantic repair/search calls.

## 9. Small Domain Interfaces

### D3 Integration Decisions

Approved clarification for the existing Section 8 commands:

- Add an optional `visitId` to a Brief duration override. Absence retains the
  existing Place-wide meaning; presence binds the override to that exact Visit
  and Place. A Visit-specific override takes precedence over a Place-wide one.
  Reject contradictory duplicate bindings and a Visit/Place mismatch. The
  `update_visit_duration` command creates or changes only the target Visit
  override. Other occurrences of the Place remain unchanged. Snapshot closure,
  composition and scheduling must retain these bindings; replacement does not
  transfer an old Visit override to its new ID.
- The internal scheduling/validation context may carry an optional, strict
  `typedCommand` using the existing Typed Command schema. It is supplied from
  the accepted owned Turn by trusted orchestration, never from model output.
  The edit planner checks Turn/base binding before supplying it. Its absence
  preserves current model-planning behavior.
- For `set_visit_lock`, independently validate that the target exists, that
  only its lock flag changes in canonical Day content, and that its flag equals
  the requested value. All clocks, facts, ledger, other Visit flags and days
  remain identical. This explicit metadata command alone permits an old lock
  to become false. Never modify the base to bypass generic lock validation.
  This path does not reroute or reschedule historical facts, and must not fail
  merely because a route would be stale for a newly planned journey.
- For deterministic edits other than the target of `update_visit_duration`,
  surviving Visits retain their frozen stay duration and duration provenance,
  including sourced/policy stays. The scheduler and independent validator
  apply this rule from the same exact base identity, not an arbitrary draft
  number. Explicitly changed stay durations use Owner provenance; any applicable
  sourced required minimum still applies. New replacement Visits use normal
  precedence. Generic compose/repair does not acquire this authorization.

Finite tests must cover explicit unlock versus implicit unlock denial,
metadata-only equality and zero route work, two Visits at the same Place with
one duration changed, moved sourced/policy stays retaining provenance, stale
route metadata-only edits, and rejection of mismatched Visit override bindings.
These changes reopen focused D1/D2 compatibility verification; historical
passing results are not evidence for the updated contracts.

These signatures describe contracts, not code supplied by this assignment.
Immutable inputs include caller-supplied IDs and deterministic fact snapshots;
no domain function reads a clock, generates randomness or accesses a database.

```ts
reduceBrief(current: BriefState, patch: BriefPatch): BriefReduction
assessRequirements(brief: BriefState, context: RequirementContext): RequirementAssessment
planTypedEdit(base: CommittedItinerarySnapshot, command: TypedCommand,
              context: EditContext): EditPlan
scheduleItinerary(input: ScheduleInput): ScheduleResult
validateItinerary(input: ValidationInput): ValidationReport
```

- `BriefReduction` returns a tentative next Brief or structured conflicts; the
  repository, not this function, assigns/commits its accepted revision.
- `RequirementContext` contains the capability allowlist, already available
  resolution facts, relevant base locks and deterministic issue revision input.
- `EditContext` contains allowed scope, candidate bindings, proposed new IDs and
  the effective Brief. Server ownership proof is not client JSON.
- `EditPlan` includes changed day IDs, tentative Brief delta, required route
  endpoint/mode/applicability keys and candidate Visit Order. The caller supplies
  obtained route results to scheduling; it does not need to manipulate blocks.
- `ScheduleInput` includes the Brief, allowed scope, preserved base content,
  ordered Visits, applicable frozen Place/Evidence/route facts, policy and IDs.
  `ScheduleResult` discriminates `scheduled`, `route_required` and `blocked`;
  blocked output may include a draft, never a commit-ready version.
- `ValidationInput` includes the candidate, base snapshot, approved scope,
  assessed Brief, supplied-ID sets and effective fact/policy snapshots.
  `ValidationReport` lists every checkable issue and explicit commit eligibility.

Contract failures reject before domain execution. Travel conflicts return typed
results rather than throw generic exceptions. Avoid exposing many helper-level
steps as public methods; callers should not reimplement duration precedence,
ledger construction, scope checks or exclusion bookkeeping.

## 10. Persistence Handoff

The repository interface, SQL decisions and transaction tests belong to
[design 0005](0005-sqlite-repository.md), not this document. The public repository
verifies its credential and resource ownership; internal execution uses a trusted
Owner-scoped work handle. Domain work receives only that verified context, never
an Owner ID supplied in request JSON. Cached Place/Evidence access and historical
snapshots are not exceptions.

SQLite preserves all accepted invariants: foreign keys and WAL, a bounded busy
timeout, short atomic transactions on local disk, optimistic version/Brief checks,
lease fencing and durable events. Never perform network/model work inside a
transaction. Design 0005 owns concrete connection settings, migration details
and driver use; this domain assignment adds no database dependency or service.

The accepted context supplied to this domain work includes Conversation, Trip,
Turn, current/base version, Brief revision, mutation sequence and, for an executing
Run, Run ID and fencing token. Canonical Version snapshots freeze:

- Version/Trip/Conversation IDs, parent version, originating Turn and Run,
  accepted Brief revision and complete Brief snapshot.
- All used Place/Evidence revisions, adjacency Legs and geometry, boundary
  transfers, schedule blocks, duration origins, locks and explicit free days.
- Policy ID, complete effective settings/overrides, validation policy revision
  `validator-mvp-v1`, structured Assumptions/Warnings and validation report.

The trusted caller validates again against the exact proposed snapshot, then
commits through one transaction checking Owner, current version, Brief revision,
accepted mutation sequence, Run terminal/cancellation status and fencing token.
Insert version, move current-version pointer, apply command-owned Brief delta
(including exclusions), finalize Run and save completion event atomically.
No caller may turn an ERROR into an eligible commit by changing its severity.
Pre-first-version Brief changes still need revision checks.

Idempotency remains Owner + Conversation + Turn ID with canonical payload equality.
Same payload returns saved outcome, including no-op or rejection; different
payload conflicts. Domain purity does not substitute for transactional checks.
The same candidate cannot commit twice after an acknowledgement failure.

Historical versions are loaded from their own frozen records, never hydrated
from today's mutable Place/Evidence caches or current policy. New route facts
require an explicitly requested versioned mutation. A failed/cancelled edit
preserves both old display and all old snapshots.

This design does not duplicate SQL layout, anonymous credential issuance, lease
timings or migration tooling. Those remain mandatory for design 0005 and the
separate AC-08 through AC-10 HTTP/workflow work, not waived by this handoff.

Integration item for main: design 0005 currently says to validate the existing
exported Itinerary Version schema on persisted I/O. That schema is fixture-only.
Coordinate a strict canonical commit schema from this document before accepting
real commits; do not persist a live version by labeling it fixture or dropping
Brief/policy/ledger fields. Repository development can start on its public
transaction behavior with explicitly test-only snapshots while this is settled.

## 11. Tests And Acceptance Mapping

All results below are required tests, currently `not_run`. Fixture arithmetic is
not evidence of real routes. Pin `schedule-mvp-v1`, `schedule-fixtures-v1` and
`validator-mvp-v1`; use synthetic grounded facts marked test-only, not modified
Phase 1 demonstration Places presented as externally verified.

| Acceptance | Required bounded tests and later dependencies |
| --- | --- |
| AC-01 | One Brief returns missing city/duration, ambiguous must-visit, conflicting requirements, missing exact dates/start Place and known density conflicts together. Include unsupported days/cities/modes, complete re-evaluation, area scope and partial unknowns. Workflow later proves zero paid calls before gate. |
| AC-03 | Local day-two proposal preserves days one/three, surviving IDs, locks, explicit duration origins and exclusions. Test cross-day scope, replacement ID, rejected must-visit removal, re-add, empty days, shortening across a locked day and pending-Brief conflict. Semantic revision/repair integration remains Phase 4. |
| AC-04 | Every current Typed Command parses and dispatches correctly; no-op, index semantics, deterministic replacement, unsupported candidate and lock rejection. Spy dependencies prove deterministic domain paths have no model/research calls. Workflow separately verifies provider calls, bounded regeneration, cancel and linked retry. |
| AC-05 | Exact numeric fixtures above; duration precedence/bounds; sourced minimum; user overrides; lunch/rest placement; included/excluded/unknown buffers; shortened first/last/single day; all boundary combinations; opening/latest-entry/fixed-time conflicts; required unknown admission/accessibility. |
| AC-06 | Validator rejects overlapping blocks, inconsistent derived clocks, extra/missing/wrong Legs, invalid coordinates/areas, duplicates, broken day count and fabricated fact origins. Table-test every degradation row for both adjacency Legs and boundary transfers. Hard walking caps include known components; unknown required components block. |
| AC-07 | Domain rejects unknown candidate/Visit/Evidence/duration-option IDs and model numeric facts at its input schema. Full model refusal/JSON/retry/repair-budget tests belong to Phase 4, not this gate. |
| AC-08 | Domain never accepts client Owner identity; caller-scoped foreign candidate/fact references fail. Full two-Owner/two-Conversation repository/HTTP/SSE/cookie/CSRF verification is a separate assignment. |
| AC-09 | Stable outputs for identical pure inputs and correct proposed Brief/version references. Real idempotency, stale base, first-generation races, latest-wins and atomic commit tests require the repository/workflow assignment. |
| AC-11 | Mutating cloned caches, input objects or shipped policy does not alter a frozen snapshot or projection; local changes preserve untouched days. Repository integration proves reload/history and rejects in-place late routing. |
| AC-14 | Reject wrong Place/field/applicability binding; preserve conflicting/stale/unknown admission status. Source entailment and malicious web/tool-permission tests remain adapter/workflow responsibilities. |
| AC-02, AC-10, AC-12, AC-13, AC-15, AC-16, AC-17 | No full acceptance claim here. Require workflow intent/run recovery, projection integration, browser map, budgets/redaction, evaluated prompts, and complete fake/live end-to-end checks respectively. |

Add property-style generated cases through public interfaces: repeatability;
successful schedules never overlap or exceed windows; sum of occupied durations
equals ledger occupancy; every duration/buffer counted once; no unscoped change;
locks and required inclusions invariant; missing route duration never commits.
Use bounded deterministic seeds and include minimal failing inputs in reports.
Tests must independently compute expected totals, not reuse scheduler helpers as
their oracle. Freeze/deep-clone tests inspect nested arrays and fact revisions,
not only TypeScript `readonly` or top-level object freezing.

## 12. Bounded Delegation After Review

Main must accept or amend the policy and compatibility plan before work begins.
Delegate sequentially where contracts overlap; no simultaneous ownership of
`src/domain/contracts.ts`.

| Assignment | Owner and bounds | Required output |
| --- | --- | --- |
| D1: canonical contracts and gate | `coder`; `src/domain/` canonical types/Brief module and focused tests; preserve existing presentation contracts | Strict schemas, reducer, full issue aggregation, capability fixtures; AC-01 and input portions of AC-07. |
| D2: policy, scheduler, validator | `coder`; reviewed policy fixtures, schedule/validation modules and focused tests; consume D1 | Exact effective policy/provenance, ledger/boundary handling, independent validation; AC-05/AC-06 and domain AC-14. |
| D3: Typed Commands and snapshots | `coder`; edit module, snapshot construction and focused tests; consume D1/D2 | Scope/locks/exclusions/durations/no-op/route requirements; AC-03/AC-04 and domain AC-11. |
| D4: independent verification | `tester`; focused domain/contract/property tests and report after each bounded implementation | Pass/fail/blocked/not_run per assigned AC portion, implementation revision, policy/fixture versions, commands and observed failures. |

Use the configured custom `coder` and `tester`, both `gpt-5.6-sol` at low
reasoning effort, without routing changes. Wait for tester findings and route
implementation fixes through coder. Return design contradictions to main before
continuing. Workers must accommodate other agents' changes and never revert
unrelated files.

### Review Decisions And Remaining Risks

Main review: accepted schedule-mvp-v1 values, explicit buffer coverage, canonical
schemas alongside the unchanged fixture schemas, replacement exclusions,
Visit-specific conflict handling, free-day boundary rules and pending-Brief
conflicts. Repository details are in design 0005. Implement D1 first and expose
its canonical snapshot schema to the repository before persisting live versions.
The repository's temporary fixture-schema tests must not authorize a fixture
as a production itinerary. Forward placement remains bounded and nonoptimal.

- Approve the concrete policy values, buffer-coverage behavior and explicit
  policy-versus-fact labeling before schedule coding.
- Approve canonical schemas alongside unchanged v1 fixture contracts, with the
  later v2 read-model/frontend handoff explicitly tracked.
- Confirm replacement exclusion and Visit-specific constraint behavior, empty
  day boundary transfers, and pending-Brief conflict handling as elaborations of
  the existing invariants rather than silently selected coder behavior.
- Forward-only scheduling can reject an order that another order could fit;
  workflow repair is bounded to the approved two persisted attempts and never
  broadens local scope without an Owner decision.
- The domain cannot establish source entailment, live provider capability,
  durability, isolation or operational readiness by itself. These gates remain
  open until the main thread's subsequent assignments provide actual evidence.
