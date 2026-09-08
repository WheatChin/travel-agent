# Typed Workflow Preparation

Status: main-approved W1 pure integration slice. This connects the already
verified snapshot/edit domain to accepted Run inputs; it is not an executor,
HTTP endpoint or completed AC-03/04 gate.

## Interface

Implement `src/server/workflow/typed-preparation.ts` with
`prepareTypedRun({turn, run, brief, base, capabilities, newVisitId})`.
Inputs are the strict original Turn loaded by trusted getRunInput, the public
Generation Run metadata from the same live claim, its accepted Brief state,
the owned immutable base snapshot, supported city/mode capabilities and a
caller-allocated optional replacement Visit ID. No credentials, environment,
SQL, model, provider, clock, random IDs or mutable caches in this module.

Return a closed `rejected` result with fixed codes for invalid input/linkage;
otherwise return `{status: "prepared", context: EditContext, plan: EditPlan}`.
The caller uses the existing plan variants for no-change, routing, semantic
dispatch or candidate validation. Preserve the complete context for independent
buildSnapshot replay. Do not collapse route_required into a failed edit or
silently reroute within this module.

## Binding And Reconstruction

Parse all input schemas before dereferencing. Accept only non-control Typed
Commands; user_message, cancel_run and retry_run belong to admission, not
this preparation path. Run must be in ready state. Exact Turn, Run, Conversation,
Trip, base version and accepted Brief revision must agree. Base snapshot may
have an older Brief revision when requirements are pending, but cannot have a
newer one; never replace the accepted Brief with base.brief to force a no-op.
A forged cross-Run or cross-Conversation association is rejected before edits.
These checks do not replace repository claim/fence/current-base authorization.

Reconstruct ScheduleInput exclusively from frozen base facts plus the accepted
Brief and capabilities. Keep policy = base.policy. Set new draft and candidate
set metadata to the accepted Run, exact base ID and accepted Brief revision;
retain all existing Day/Visit IDs, order, explicit lock flags, duration values,
duration option IDs and Evidence IDs. Copy base candidates, Places, Evidence,
durationOptions, routes and conditionResolutions without creating facts.
Derive Visit-to-candidate bindings from frozen scheduled Visits and day modes
from frozen days. Derive segment-to-route bindings from each frozen Leg and
boundary transfer ID and its embedded route ID.

Build requirementContext with issueRevision = accepted Brief revision,
injected supportedCityIds/supportedTransportModes, resolvedPlaces joined from
base Places and lockedDayIndices from frozen locked Visits. Capability arrays
must be nonempty, unique canonical values; do not infer supported cities or
modes merely because they appear in the historical snapshot.

Derive local scope from the exact command target in the base: target Visit's
day or supplied Day ID; move includes the destination Day once. Missing targets
fail closed. Regenerate-day remains local. newVisitId must be null except for
replace_visit, which requires a fresh noncolliding ID. The original persisted
Turn is never rewritten. Pass this exact reconstructed context to planTypedEdit
and return its plan, including domain rejection, without model/research calls.
Return independent schema-parsed/frozen values and do not mutate any input.

## Verification

Finite tests use the existing canonical schedule fixture. Cover lock/unlock,
no-op, moved Visit duration/provenance preservation, missing routes, replacement
ID admission, local regeneration, pending-Brief no-op rejection, read/control
bypass rejection, invalid schemas, cross-Run/Trip/Conversation/base mismatch,
accepted revision mismatch, immutable inputs and exact frozen fact reuse.
For a ready metadata-only candidate, pass returned context and proposal through
buildSnapshot and confirm independent validation accepts it. Do not invent a
second scheduling algorithm or fixture-only output provenance.

Initial natural-language generation needs a separate trusted execution
envelope because its original Turn has targetTripId null and Brief revision
zero. This slice neither changes buildSnapshot nor silently substitutes those
client preconditions; that integration remains pending.
