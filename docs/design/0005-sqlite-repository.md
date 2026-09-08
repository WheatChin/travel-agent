# SQLite Repository And Recovery

Status: Approved implementation elaboration of baseline Sections 7, 8 and 17,
with the user's SQLite decision. Full HTTP and workflow gates remain separate.

## Scope

Implement `src/server/repository/` using native `node:sqlite` and no database
service. This module owns anonymous credentials, Owner-scoped storage, atomic
Turn acceptance, immutable versions, and durable Generation Run execution state.
No Next routes, provider adapters, frontend, or model interpretation in this slice.
Tests use public repository operations and real temporary SQLite files.

The host currently runs Node 26.7.0; its DatabaseSync was exercised successfully
with SQLite 3.53.4. Use only supported DatabaseSync constructor, exec, prepare,
run/get/all and close APIs. Do not require recently added convenience APIs.
Reference: https://nodejs.org/api/sqlite.html
Transactions: https://sqlite.org/lang_transaction.html
Connection configuration: https://sqlite.org/pragma.html

## Storage And Credentials

`openRepository({path, now?})` creates parent directories and runs idempotent,
versioned migrations. Production default path is resolved by the eventual server
composition root, not by each query. Enable foreign_keys, WAL, synchronous FULL
and busy_timeout 5000ms for file databases. Use parameter binding throughout.
Transactions are synchronous BEGIN IMMEDIATE / COMMIT / ROLLBACK blocks.

`createOwner()` returns a newly generated 32-byte opaque random credential.
Store only its SHA-256 digest with Owner ID and expiration (30 days).
All public Owner-resource operations take this credential and validate it
inside the operation; never take a client-provided Owner ID. Invalid/expired
credentials produce UNAUTHORIZED. Missing/foreign resources produce the same
NOT_FOUND response. Runtime schema validation rejects extra Owner properties.
Owner identity is not a browser session ID or a Conversation ID.
HTTP will transport the credential in an HttpOnly/SameSite cookie, not JSON.

Tables cover schema migrations, Owners, Conversations, Trips, brief revisions,
Turns/messages, immutable versions, Runs, durable events and Owner-scoped caches.
Trip and Conversation linkage must be enforced on all nested resource reads.
Version facts and Evidence are stored inside the immutable version JSON.
Caches may be refreshed but cannot be referenced as mutable historical facts.

## Public Operations

Use a small exported repository class/interface and typed results/errors:

- createOwner; createConversation; listConversations; listTrips; getTrip
  (optional owned version ID); listVersions; getVersion; getEvidence.
- acceptTurn(credential, {turn, kind, brief?}), with kind supplied only by the
  trusted Conversation Engine: `mutation` or `read`. Parse the existing strict
  Turn envelope. Initial mutation allocates a Trip in the existing empty
  Conversation when target is null, version null, brief revision zero.
  Existing requests must match the Conversation's Trip. A different destination
  is a new Conversation/Trip, never reassignment of existing history.
- getTurn; listMessages; getRun; listEvents(afterSequence).
- claimRun(credential, runId, executorId, leaseMs); renewLease; checkpointRun;
  commitVersion; cancelRun; retryRun; resumeRun.
- putCache/getCache with Owner, namespace and key scope. Return deserialized
  independent values, not references that callers can mutate in memory.
- close; recovery discovery through listRecoverableRuns using a separate
  trusted worker interface. It returns scoped work handles, not anonymous data
  through an HTTP endpoint. Keep public request reads Owner-scoped.

The worker composition root may iterate owned work handles internally; it must
not need stored raw credentials. Provide a distinct private/trusted worker API
for execution, bound to the Owner and Run selected by the database, never a
request-controlled Owner ID. A claimed handle includes a fencing token, not an
authorization bypass exposed to browser callers.

Brief/phase checkpoint payloads are internal JSON data, validated by the domain
or phase schema at the service boundary. Store explicit revisions and snapshot
metadata separately from payloads. Do not silently coerce or default an invalid
Itinerary Version; validate the canonical committed snapshot schema from design
0003 on production persisted IO. The Phase 1 fixture schema may be supplied by
an explicit test-only repository configuration while canonical contracts are
being established, never as the production default for live commits. Coordinate
the schema handoff with D1; do not coerce live provenance into fixture provenance.

## Atomic Acceptance

Validate Owner/resource linkage first. Canonicalize the strict Turn JSON by
recursively sorting object keys, preserving arrays. Idempotency is keyed by
Owner, Conversation, Turn ID. Same payload returns the original accepted
outcome even when the current base has since advanced; different payload
returns IDEMPOTENCY_CONFLICT. Compare canonical input, not interpreted output.

Check current version and Brief revision before accepting a mutation. Failures
must not insert a Turn or supersede work. Atomically allocate mutation sequence,
persist message and outcome, and create an accepted Run. Persist a supplied new
Brief snapshot at revision +1. Even the first generation checks revision races.
Only successfully accepted newer mutations supersede prior active Runs for
that Trip. Read Turns persist one answer slot/message without a Run, require
owned historical references but not current-version equality, and never alter
the Trip's mutation sequence or cancel planning.

Clarification uses `resumeRun`, not ordinary superseding acceptance: bind Run,
issue revision, current Trip base and Brief revision, plus a new idempotent
Turn. Stale, unrelated, or terminal targets cannot resume. Keep consumed repair
and adapter budgets, increment Brief revision only for an accepted change,
record the resolving Turn, and restore the persisted resume phase.

## Leases, Events And Commit

Use injected server time for tests. Claim only runnable nonterminal states with
no unexpired lease; claims increment a monotonic fencing token. Default lease
30 seconds; renew before long work and reject expired or mismatched tokens.
Never hold a SQLite transaction while executing network or model operations.

Checkpoints require the current lease, state, mutation sequence and Brief base;
persist accepted phase output, operation IDs, attempt counts and nextRetryAt.
Allow only the baseline state machine transitions. Repair count cannot decrease
or exceed two, even after reopening the database. needs_input releases execution;
terminal states cannot be restarted except retry creating a linked new Run.

Generate durable events from a closed event schema, never arbitrary raw model
objects. Sequence increases per Run and supports replay after disconnect.
Persist a state change and its associated event in the same transaction.
Cancellation and supersession are durable and revoke further checkpoint/commit.

commitVersion validates owned Trip/Conversation identity, base current version,
Brief revision, mutation sequence, lease/fence, eligible validating state and
unique immutable version ID. The service must run the deterministic validator
before calling it; repository schema checks do not claim itinerary feasibility.
Insert version, move pointer, set completed/degraded Run state, persist terminal
event and save Turn outcome in ONE transaction. Invalid input/constraint failure
rolls everything back. Replaying an already committed operation returns the
same version, never inserts another. No in-place version update method exists.
The displayed historical version keeps its Brief/policy/fact snapshot.

Retry requires a new Turn ID and current base, a failed owned Run, a linked new
Run and fresh recorded budgets. Cancellation itself does not create a Run.
No-op domain edits must be completed without committing a version; provide a
terminal no-change result operation with the same fencing/base checks.

### No-Change Completion

Approved contract clarification: add `run.no_change` to the closed event union.
It has the standard event metadata, a required existing `versionId`, and a fixed
safe message. Do not reuse `itinerary.completed` to imply a newly created version.

Expose `completeNoChange` through the credential-scoped and trusted claimed
worker interfaces. The deterministic edit planner must already have returned
`no_op`; this repository operation cannot establish semantic equality itself.
Accept only a live leased `ready` Run, a Typed Command Turn, and an existing
current version. Check Owner/Conversation/Trip linkage, executor/fence, mutation
sequence, version and Brief revision exactly as for commit. The current Brief
revision must also equal the frozen base version's Brief revision: pending or
newly accepted requirement changes cannot be completed as an unchanged itinerary.

In one transaction set the Run to `completed`, clear its lease, persist
`run.no_change`, and save the originating Turn outcome with
`noChange: true` and the existing `versionId`. Do not insert a version, update
the current pointer, mutate the Brief, or reset consumed budgets. Exact replay
returns this saved outcome before current-base or lease checks, including after
later versions advance; it never adds another event. A different outcome or
Run binding is not a replay.

Tests cover successful no-change, repeated acknowledgement, no additional
version/event, cross-Owner denial, stale fence/base, pending Brief, cancellation,
and rejection of natural-language/initial-generation Turns. Workflow tests
separately prove zero model/research/routing calls on this deterministic path.

### Command Brief Atomicity And Recoverable Input

Approved integration clarification: distinguish accepted natural-language
requirement changes from tentative Typed Command effects. The former may persist
an updated Brief during acceptance as described above. For a Typed Command,
`acceptTurn` rejects a supplied `brief` before any writes or supersession.
Removal exclusions, free-day changes, explicit duration changes and other
command-owned effects remain a proposed Brief until successful version commit.
Failed, cancelled, stale and no-change commands must not persist that proposal.

Add optional `commandBrief: BriefState` to credential-scoped commit requests
and as an optional third argument to trusted `commitVersion`. Absence retains
the current commit contract, including canonical equality between the snapshot
Brief and the currently persisted Brief, not merely revision equality.
Presence requires a persisted Typed Command mutation with an existing base.
The service must have validated the deterministic edit plan and its allowed
Brief delta; this argument is internal, never a client-authorized patch.

Check the lease, current version, mutation sequence and current Brief against the
Run's accepted base before writing. The proposed Brief revision must be exactly
current revision plus one, and its entire normalized value must equal the
snapshot Brief. Snapshot, itinerary and candidate metadata use that new revision;
the Run's accepted base revision remains the old concurrency precondition.
Insert the new Brief revision, update Trip Brief/current version, insert the
immutable version, finalize the Run and persist its saved outcome/event in the
same transaction. No intermediate checkpoint updates the Trip Brief.
Exact replay must match both the saved snapshot and optional proposal before
returning success without another revision or event, even after later mutations.
Tests cover successful removal/duration proposals, rollback on invalid commit,
cancellation, stale base, wrong next revision, payload mismatch, replay and
attempted command-Brief persistence through ordinary acceptance.

Add `getRunInput(claim): TurnInput` to the private trusted worker interface.
Read the strict persisted canonical Turn belonging to the claimed Run, joining
Owner, Conversation, Trip and Turn identities. Require a current live lease and
fence; copied/forged/expired claims cannot read it. Return an independent parsed
value, never a credential or an arbitrary Conversation's message history.
This lets accepted-phase recovery reconstruct Typed Commands after restart
without browser credentials. Clarification checkpoints retain any original
operation context needed alongside the separately recorded resolving Turn.
Test close/reopen recovery, exact input preservation, forged claim denial,
expired/taken-over lease denial and cross-Run/Owner isolation.

## Acceptance Evidence

Through public methods, incrementally write failing tests then implementation:

- AC-08: two Owners/two Conversations; foreign Trip, Run, version, Evidence and
  event reads plus cancel/retry; invalid and expired credentials.
- AC-09: replay, changed payload, stale version, initial Brief race, newer
  mutation supersedes, read-only question does not; separate database
  connections to the same temporary file exercise actual serialized writes.
- AC-10: close/reopen between phase operations; live lease exclusion, expired
  lease takeover, old token refusal, retained repair budgets; atomic terminal
  result replay after a simulated disconnect before event delivery.
- AC-11: historical snapshot remains identical after cache/Brief/new-version
  changes; cancelling a revision preserves old current version.

Use temporary directories and close all connections before cleanup on Windows.
Do not claim full AC-08 HTTP/CSRF or full AC-10 provider crash coverage until the
HTTP/executor slices implement and test those paths.
