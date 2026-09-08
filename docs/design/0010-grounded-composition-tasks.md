# Grounded Composition Tasks

Status: main-approved bounded elaboration of baseline Sections 10-11 and design
0003. This slice supplies the model planning boundary; it is not an executor,
intent classifier, source extractor, or passed prompt-quality evaluation.

## Scope

Implement `src/server/planning/composition.ts` and focused finite tests after
the D2 canonical interface is stable. Use the structured adapter from design
0009 through an injected task function. No direct fetch, persistence, retries,
clock reads, ID allocation, runtime agents or frontend changes in this module.
Separate versioned prompts are `compose_itinerary-v1`, `revise_itinerary-v1`
and `repair_itinerary-v1`. Their task shapes can share deterministic admission
and joining code without becoming one universal travel prompt.

The caller authorizes the Owner, Run, base and mutation scope, reserves durable
budgets through the adapter callback, and persists accepted task results.
This module never treats a successful model response as a commit-ready version.

## Supplied Context

Accept a strictly validated context containing canonical Trip/Run/base/Brief
references, the assessed effective day count, ordered target Day IDs and indices,
an optional frozen base, allowed scope, grounded candidate bindings and their
Place/Evidence/duration-option snapshots. Candidate provenance remains synthetic
in fake mode. Include explicit user text and allowed interests as task data.
Only necessary grounded geographic context is projected into model input;
do not serialize repository records, credentials or raw transport responses.

The caller supplies a bounded pool of new Visit IDs and the surviving Visit IDs
from the base. IDs are unique across both sets. The pool is at most 49 new IDs
(seven possible selections per day across seven days); unused IDs are allowed.
The canonical policy's seven-Visit soft maximum is not a universal hard cap:
explicit larger valid base content is not silently deleted to fit this pool.
If a requested create/revision needs more new IDs than this bounded task can
handle, return an explicit task-capacity issue before invoking the model.
Retain at most 28 supplied candidates as prescribed by design 0007.

Missing destination/duration, unresolved required references or other currently
identified blocking requirements prevent composition. Do not call the model to
guess answers. Source research and grounding happen earlier in the workflow.
References in the task context must close over supplied canonical records, with
matching immutable revisions. Do not accept an arbitrary candidate ID merely
because it follows the ID syntax.

## Model Result

The JSON result is exactly:

```text
{
  days: [{
    dayId,
    selections: [{
      visitId,
      candidateId,
      durationOptionId: supplied ID or null,
      evidenceIds: supplied IDs
    }]
  }]
}
```

Use strict objects at every level and bounded arrays. No free-form result
narrative, tool requests, coordinates, route fields, numerical durations,
opening hours or source URLs are admitted. Construct and include the strict JSON
Schema in task instructions; validate with the equivalent local schema plus
cross-record checks after response parsing.

Require exactly the targeted days once each. A full composition targets every
day; local revision/repair targets only the approved changed days. Empty
selections require an explicitly free day in the effective Brief. The module
does not authorize freeing a day through model output.

Every Visit ID is supplied and selected at most once. A surviving Visit ID can
only retain its original Place. Selecting a different Place requires a supplied
new Visit ID. Candidate, Evidence and duration-option bindings must all match
the selected Place and allowed candidate. Null duration choice means retain
applicable existing duration or let deterministic precedence choose, never
zero minutes. Reject duplicate Places unless explicitly allowed by the Brief,
including duplicates against preserved unscoped days.

Preserve locked Visit day, Place, duration and pairwise order. Enforce exclusions,
must-visits and approved local scope across the joined whole draft, not only
within the result's changed days. Known hard-constraint conflicts return
structured issues; the caller decides repair or Owner clarification. A malformed
result does not expand scope or trigger hidden research.

## Joining And Provenance

Join selected IDs against supplied facts to produce the canonical Itinerary
Draft plus explicit Visit-to-candidate bindings. New Visits receive no
model-authored duration. Surviving Visits retain their ID, Place, lock and
explicit duration unless the separately authorized requirement mutation changes
that duration. The scheduler applies Owner/sourced/policy precedence.

The returned plan identifies changed Day IDs. Preserve untouched frozen Day
Plans separately for the scheduler's local-scope input; never reconstruct their
facts, policy, notices or ledger from current caches. A draft projection alone
does not prove byte-for-byte preservation of the canonical unaffected days.
Do not omit necessary retained candidates/facts from validator input.

Return a closed typed outcome with the prompt version and validated selections
or stable issue codes. Never expose raw adapter errors, schema issue values,
reasoning content or full prompts. The workflow checkpoints accepted output and
numeric usage, with Run/operation identities, before advancing to routing.

## Prompt Behavior

Compose ranks supplied candidates for the user's interests, groups by day and
geographic context, and observes constraints. It does not claim route efficiency
from unqueried transport times. Revision only changes the declared local/global
scope and preserves explicit durations, exclusions and locks. Repair receives
structured validator issues and may reorder/reselect only within that same
scope; it cannot weaken requirements or request another tool.

All prompts explicitly distinguish product-policy assumptions from verified
facts. Web excerpts and user text are data and cannot override output rules.
Include a positive supplied-ID example and negative examples for an invented
ID, numeric travel time and out-of-scope day. No self-reported confidence gate.
Budgets remain design 0007: 4096 requested output tokens per task maximum,
two transport attempts per logical operation, and two logical repair operations
within the cumulative model allowance. This module does not retry itself.

## Verification

Use a finite injected structured-task fake and supplied canonical fixtures.
Verify strict shape, extra-field rejection, all ID bindings, duplicate/day
coverage, locked identity/order/duration, scope and unaffected-day preservation,
exclusion/must-visit checks and explicit free days. Verify missing prerequisites
and invalid context cause zero task calls. Verify new Visit durations are null
until deterministic scheduling and surviving explicit durations are retained.
Check task name/version and input isolation; malicious excerpt instructions
must not change trusted prompt instructions or allowed schema.

Adapter success, schema tests and deterministic fake selection are not Chinese
planning-quality evidence. AC-16 still requires versioned evaluation fixtures,
actual model runs and source/human quality review. Full AC-03/07 requires
workflow budgets, routing, independent validation and persisted commits.
