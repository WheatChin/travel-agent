# Natural Language Interpretation

Status: main-approved bounded implementation of baseline Sections 6, 8, 10,
11 and provider policy 0007. This is a model task module, not permission to
skip durable Conversation Engine admission or to claim evaluated model quality.

## Interface

Implement `src/server/conversation/interpretation.ts` with a single task entry
`interpretTurn(context, structuredTask)`. Use the injected DeepSeek task
interface and strict local schemas, as in composition. No fetch, environment
reads, clock, ID allocation, repository access, retry or arbitrary tool use.
Prompt version is `extract_trip_brief-v1`; request `classification` with 1024
output tokens and one adapter invocation. The caller supplies durable attempt
reservation; this module does not reset the two-attempt submission allowance.

Context contains the strict Turn envelope, current Brief or null, the requested
owned immutable version or null, and bounded relevant context:

- At most 12 recent messages, each at most 2048 characters, belonging to the
  same Conversation; current user text remains bounded by the Turn contract.
- Supported city records with canonical city ID, label, administrative areas
  and time zone; at most 64 supplied records. These are trusted capability
  records, not model-created geography.
- At most 40 supplied grounded Place identity records needed for the query,
  with canonical Place ID and label. The frozen version supplies Day/Visit IDs.
- Caller-allocated pools of at most 16 new reference IDs and 32 new constraint
  IDs, unique and disjoint from existing IDs. Unused IDs are permitted.
- Optional waiting Run ID, issue revision and current structured issues.
  These must agree with the Turn's resume binding for a clarification task.
- Injected local calendar date and time zone for interpreting relative dates;
  without an explicit resolved calendar anchor, relative date ambiguity must
  remain unresolved. Never compute duration/date arithmetic in this module
  using model output; downstream requirement assessment owns that arithmetic.

Validate context Trip/Conversation/version/Brief references before calling the
model. Historical read context is allowed; this module cannot grant current
mutation rights from it. Reject a foreign version, unrelated waiting Run, or
unknown contextual ID before the task. A Typed Command returns a typed bypass
with its original command and performs zero task calls.

## Closed Result

The model output is a strict object:

```text
{
  intent: create_trip | update_requirements | answer_clarification |
          ask_question | revise_local | revise_global | unsupported,
  scope: null | {kind: global} | {kind: local, dayIds: supplied Day IDs[]},
  patch: restricted BriefPatch,
  questions: [{field, kind: missing | ambiguous | unsupported | conflict,
               message}],
  mixedReadWrite: boolean
}
```

`questions` is bounded to 16 items with short safe display text. It represents
interpretation uncertainty, not a replacement for aggregate deterministic
requirement assessment. No confidence score, rationale trace, arbitrary answer,
coordinates, routes, evidence facts, source URLs or tool requests are accepted.
Return a closed failure on malformed output; never substitute `create_trip`.

Use existing Brief patch set/clear semantics, restricted as follows:

- Never admit `revision`, `assumptions`, or `acceptedPolicyOverrides`.
- Destination may be cleared, be an unresolved query with no candidates, or
  match one supplied city record exactly. Bind the latter through its canonical
  ID; derive area IDs/time zone in code from that record, not from the model.
- New Place references have a supplied reference ID, role, query, optional day,
  and either an unresolved state or an exact supplied grounded Place binding.
  Do not turn matching text alone into verified grounding. Model-created
  candidate lists and coordinates are forbidden.
- Hard constraints use existing closed domain variants and supplied IDs.
  Unknown explicit constraints become an `unresolved` constraint, never a
  discarded preference. Place and Visit references must close over supplied
  context. Query-only must-visits remain unresolved references until grounding.
- Dates, requested day count, day windows, preferences, boundaries, duration
  overrides, repeats, exclusions and free days may encode explicit Owner
  requirements only. Stay numbers are Owner requirements, not venue facts.
  Visit-specific overrides must bind both the supplied Visit and its Place.
  Every identifier referenced by any nested patch field must be supplied or an
  admitted newly allocated reference/constraint ID.
- A set operation replaces that field, so the prompt must retain unrelated
  existing entries. Code rejects removal or modification of unrelated scoped
  entries for a local request. Do not silently clear locked constraints,
  exclusions, duration overrides or previous explicit requirements.

The transport JSON schema may use a compact destination representation
`{query, cityId: supplied ID | null}` and unresolved/grounded reference records;
normalize it deterministically to the canonical BriefPatch before returning.
Publish the exact strict schema in trusted task instructions and enforce its
equivalent local validation and cross-record joins after adapter success.
Do not expose the full unrestricted domain patch as the model schema.

## Dispatch Rules

- `ask_question` and `unsupported` require empty patch, null scope and
  `mixedReadWrite: false`. They do not create a Run or alter any Brief/version.
  Answer generation, when needed, is a separate grounded read operation.
- `create_trip` requires global scope. With an existing Trip, the caller must
  allocate a separate Conversation/Trip atomically with saved dispatch outcome;
  interpretation never replaces current history.
- `update_requirements` and `revise_global` require an existing Trip and global
  scope. `revise_local` requires an existing version and a nonempty unique set
  of supplied Day IDs. Its patch must not alter requirements affecting days
  outside that set. Unclear scope returns questions with no executable mutation.
- `answer_clarification` requires an exact waiting Run/issue binding from the
  input, not IDs chosen by the model. Preserve the original operation scope
  stored with that waiting Run; unrelated requests do not resume it.
- Any interpretation questions prevent mutation dispatch. Return the complete
  question list plus the proposed intent/scope for display; the caller combines
  this with all currently identifiable deterministic Requirement Issues.
- A mixed read/write result exposes the proposed mutation scope. It is admitted
  only when that scope is explicit and all deterministic checks succeed.
- Reduce patches without changing revision here. Repository acceptance owns
  revision progression and rechecks the submitted bases after the model await.

Context history, labels and current user text are untrusted task data. Keep
them out of trusted instructions. Include supplied-ID positive examples and
negative examples for invented IDs, factual travel times, implicit global
revision and source-text instructions. Return only normalized interpretation,
prompt version, usage and fixed issue codes; sanitize adapter failures.

## Durable Integration Obligations

Before a paid interpretation call, Conversation Engine must authorize, validate,
check exact Turn replay and submitted bases, and durably reserve a submission
attempt under Owner + Conversation + Turn with canonical payload equality.
Concurrent requests and restart cannot reset the two-attempt ledger. A saved
interpretation is replayed rather than paid for again. Recheck base/Brief on
acceptance; a stale submission cannot supersede work. These repository and
engine changes need integration tests; the task module alone does not satisfy
AC-02, AC-08, AC-09 or durable budget acceptance.

## Finite Verification

Test through the public interface with an injected structured-task fake:
initial Beijing/culture/three-day extraction, partial requirements, all
questions together, historical read-only query, explicit new Trip, bound and
stale clarification, local day-two revision, unsupported and mixed intent,
Typed Command zero-call bypass, ID/field injection, city grounding, unknown
hard constraints, repeated Place Visit-specific duration, preservation of
unrelated requirements, invalid context zero-call, strict malformed/refusal
failure, malicious task data isolation and exactly one task attempt.
Use enumerated fake outputs, not substring rules pretending to understand
arbitrary text. Actual Chinese prompt evaluation and grounded answers remain
separate AC-16/full workflow checks.
