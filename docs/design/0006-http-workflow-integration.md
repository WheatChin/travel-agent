# HTTP And Workflow Integration

Status: Approved bounded integration direction; implement after canonical domain
and repository interfaces pass their focused tests. This is not a passed gate.
Baseline 0001 remains authoritative. No runtime subagents or LangGraph.

## Composition And Modes

Use Next Node Route Handlers and a single process-local composition root in
`src/server/runtime.ts`. Initialize the SQLite repository from DATABASE_PATH
(default `data/travel-agent.sqlite`, project-relative), run migrations once,
and start the executor from Node-only `src/instrumentation.ts`. Avoid initialization
during static prerender/build. Hot reload may reuse a global runtime keyed by
configuration to avoid duplicate timers/connections. Close owned resources on
shutdown; leases still protect multiple processes accidentally sharing a DB.

Modes are explicit `fixture`, `fake`, and `live` configuration, never an automatic
fallback. Fixture is the legacy presentation harness. Fake runs the real durable
workflow using deterministic adapters and synthetic clearly labelled facts.
Live requires all chosen providers and credentials; missing configuration
returns a typed capability error without invoking fixture or fake providers.
Only explicit test/demo configuration can enable fake or fixture mode.

Keep runtime mode visible. Final deliverable defaults to live with a usable empty
library and configuration errors; a missing provider is not a build error or a
reason for the whole application to crash. Fixture remains an explicitly
selected separate development route after runtime UI adoption.

## HTTP Boundary

Prefix the baseline routes with `/api`. Add `/api/bootstrap` for initial identity
and capabilities, plus conversation/messages and version-history reads needed
by the desktop client. All responses carrying Owner data use Cache-Control:
no-store. Resource IDs and envelopes are strict schema-validated.

POST bootstrap, with a same-origin check, issues an opaque anonymous cookie only
when no credential is present. Existing invalid/expired credentials return 401,
not silent access to a new identity. An explicit start-new-identity action can
clear the expired credential, with a warning that old history cannot be recovered.
Never return the credential as JSON or expose an Owner ID as authorization.

Use a host-only HttpOnly, Secure, SameSite=Strict cookie with Path=/ and repository
expiration. Verify the actual localhost browser behavior with a real browser;
do not remove Secure merely to pass a test. Non-loopback deployments require
HTTPS. Never trust client-supplied forwarding headers to choose security policy.

All mutations require an exact configured origin (APP_ORIGIN; local default
http://127.0.0.1:3000) and JSON content type; reject cross-site Fetch Metadata,
missing/mismatched Origin, malformed JSON, duplicate credential cookies, extra
Owner fields and oversized bodies before domain/provider work. Bound body size
to 64 KiB by reading actual bytes, not trusting Content-Length alone. Return
stable codes and concise messages, never stack traces, prompts or credentials.

POST turns validates Conversation path/envelope agreement and persists acceptance
before returning the Run identifier (202) or immediate read/no-op/issue outcome.
SSE is a separate GET subscription. Cancel/retry use the same Turn contract;
no unauthenticated convenience endpoints.

## Workflow And Executor

The Conversation Engine interprets only natural-language inputs. Typed Commands
go directly to domain dispatch. Each model task accepts a closed JSON result;
only supplied canonical IDs can reach facts. Rebuild context from this owned
Conversation, current/historical version as requested, pending Brief, and bounded
recent messages. Never include other Conversations implicitly.

Mutation classification does not grant commit rights. Recheck submitted bases
at repository acceptance after any asynchronous interpretation. A failed
precondition cannot supersede another Run. Questions never enter the executor;
new-destination intent opens a separate Conversation/Trip and tells the client
which one to display. Ambiguous scope returns all known questions without
speculative mutation. Clarification is strictly bound to Run/issue revision.

Executor phases implement baseline Section 6 via checkpointed accepted outputs:
assessment, research, Place resolution, composition, routing, scheduling,
independent validation, at most two repairs, atomic commit. No task holds a
transaction across awaits. Use a 1-second discovery tick, concurrency two,
30-second leases with renewal before a third of the lease remains, and a shutdown
signal. All writes carry current fencing/sequence/Brief/version expectations.
Admission to external calls stops when cancelled/superseded or lease renewal fails.

Persist each operation budget reservation before issuing its external read,
then its accepted output before advancing. Crash-before-output may repeat the
read but cannot reset consumed attempts or invent a success. Replay committed
results before doing any external work. A stale worker cannot write a failure
over a newer successful result.

Fake adapter behavior is deterministic from explicit injected scenarios, not
arbitrary substring heuristics pretending to understand general Chinese.
Fake integration fixtures enumerate the Beijing three-day create, clarification,
read-only question and day-two revision conversation. Unknown fake messages
return unsupported intent, not an unrelated prebuilt trip. Both fake and live
adapters satisfy the same strict public interfaces.

## SSE And Client

Durable events are the closed canonical event vocabulary. The GET events route
checks ownership first, accepts bounded valid Last-Event-ID/afterSequence, replays
saved events in order, and polls only for observation. Disconnect cancels the
subscription timer, never the Generation Run. Send keep-alive comments every
15 seconds, not fake progress percentages. Close at terminal/needs_input state.

Client fetches the authoritative Run/Trip after reconnect, ignores duplicate
event sequence numbers, and binds completion to the displayed Trip and current
accepted Run. An old event cannot replace a newer version. Historical versions
are read-only until an explicit new mutation uses the current base.

Replace fixture-only local messages/edits with backend state, preserving the
existing desktop layout and selection semantics. Render canonical snapshot
projections including schedule blocks, warnings, Evidence and mode provenance.
No client-created Visit times, provider facts or route lines.

## Verification Slices

1. HTTP identity/isolation and strict request validation using actual repository
   plus Request/Response interfaces; browser verifies cookie behavior.
2. Real workflow with deterministic provider boundaries: AC-01 through AC-11,
   AC-14/15; explicit call tracing only at external adapters.
3. Fault-injected recovery at external-call/checkpoint/commit boundaries, two
   executor races, cancellation and supersession, event replay and reconnect.
4. Browser create/clarify/generate/revise/history/reload and independent browser
   contexts at all three supported desktop widths: AC-12 and fake AC-17.

No live acceptance is claimed by these slices. Adapter policy, research choice,
source freshness and exact live budgets require a separate Phase 5 elaboration.

## H0 Independent HTTP Boundary

Approved pre-integration slice: pure standard Request/Response helpers may be
implemented while repository and domain verification continues. This exception
does not authorize routes, runtime composition, cookies tied to repository
issuance, or workflow integration before those interfaces are verified.

Own `src/server/http/security.ts` and focused tests. Expose a small interface:
`readMutationJson(request, appOrigin)`, `readCredential(request)`,
`credentialCookie(credential, expiresAt)`, and `errorResponse(error)`.
The caller supplies a strict domain schema after JSON parsing. Helpers never
call providers, read configuration implicitly, or authorize a resource.

- Pin the credential cookie name to `travel_owner`; accept only the repository's
  43-character base64url credential format. Absent is distinct from invalid.
  Reject repeated `travel_owner` entries, including identical values; do not
  select the first or last. Never decode an invalid credential into a valid one.
- Validate configured origin as an HTTP(S) origin without path, query, fragment
  or credentials. Require request Origin to equal it exactly. Reject cross-site
  Fetch Metadata; absent metadata is allowed only with the exact Origin.
- Mutation content type is `application/json`, with optional UTF-8 charset.
  Reject unsupported content encodings. Consume at most 65536 actual bytes,
  cancelling the reader on overflow; malformed UTF-8 and JSON are bad requests.
  Content-Length is not the enforcement mechanism.
- Reject JSON primitives/arrays and recursively reject `owner`, `ownerId`,
  and `owner_id` properties before downstream execution. Strict domain schemas
  must still reject every other unknown field at their own boundary.
- Serialize the cookie with Path=/, HttpOnly, Secure, SameSite=Strict and the
  supplied expiration; no Domain attribute. Validate values before serialization
  to prevent header injection. No browser storage or JSON credential response.
- Errors use a closed local code/status mapping: invalid origin or Fetch
  Metadata 403; invalid credential 401; malformed input 400; media/encoding 415;
  body overflow 413; unknown internal errors 500. Include only stable code and
  fixed message, with Cache-Control: no-store and JSON content type. Never
  serialize arbitrary Error messages, stack traces or input.

Test actual Request streams, multibyte byte limits, missing/forged length,
malformed UTF-8, duplicate cookies, nested forged ownership, origin variants
and secret-bearing error redaction. Browser acceptance of Secure loopback cookies
and two-Owner authorization remain later integration tests, not H0 passes.

## H1 Identity And Library Reads

Repository focused verification passed 48/48 after fixture correction. H1 may
now implement the HTTP identity and read boundary against that repository.
This slice does not start the executor or accept Turns.

- Implement an injected handler factory in `src/server/http/library.ts`; thin
  Node Route Handlers call a lazy `src/server/runtime.ts` repository accessor.
  Importing modules must not open SQLite or start timers. Runtime construction
  caches the repository by resolved database path and exposes explicit close.
- POST `/api/bootstrap` accepts only `{}`. With no cookie, issue an Owner cookie;
  with an existing cookie, validate through `listConversations` without minting
  a replacement. Return mode, library and closed capability status only, never
  credentials, Owner IDs, environment values or worker recovery records.
- GET/POST `/api/conversations` list/create owned Conversations; POST accepts
  only `{}`. GET `/api/conversations/[conversationId]/messages` reads messages.
  GET `/api/trips` lists Trips. GET `/api/trips/[tripId]` returns the current
  snapshot when available; optional `versionId` selects owned history.
  GET `/api/trips/[tripId]/versions` returns version history.
  GET `/api/runs/[runId]` returns only the public Generation Run schema.
- Validate canonical path/query IDs and reject unknown or duplicate query
  parameters. Each read and write requires the cookie; only bootstrap can
  create identity. All JSON responses, including errors, are no-store.
- Reuse H0 for mutation admission and credential parsing. Map repository
  UNAUTHORIZED to 401, NOT_FOUND to 404, known conflicts to 409 and validation
  errors to 400 with fixed messages. Unknown exceptions remain generic 500.
- Configuration defaults to live, local APP_ORIGIN and the documented SQLite
  path. Explicit fake/fixture modes may be reported, but this slice must not
  claim planning capability or create simulated provider success. Capabilities
  distinguish unavailable integration from credential presence; never claim
  live verification by checking an environment variable.
- Test real in-memory SQLite through standard Request/Response handlers:
  bootstrap, repeat/expired/invalid identity, empty/populated library,
  two-Owner foreign resource denial, strict inputs, history immutability,
  error redaction and no credential response fields. Browser cookie acceptance
  and full workflow remain separate pending gates.

## H2 Bounded Event Observation

Implement the GET events route independently of Turn admission and executor
startup. Use H0 credential parsing and real repository ownership checks before
returning a stream. This read cannot claim, renew, cancel or restart a Run.

The wire event ID is the persisted per-Run positive decimal sequence, not the
opaque event record ID. `afterSequence` and `Last-Event-ID` accept only canonical
nonnegative safe-integer decimal strings (zero starts initial replay). If both
are present they must agree. Reject duplicates, unknown query fields, malformed
Run IDs and malformed cursors before streaming. No cursor silently resets.

Inject clock/timer dependencies for finite tests; production observation polls
at one second and emits a comment heartbeat after 15 seconds of inactivity.
Use a demand-driven ReadableStream: at most one pending timer/read, enqueue
only while demanded, and retain no accumulating event queue for a stalled
consumer. Cancellation and request abort clean up the timer/listener. Recheck
Owner authorization on every observation; expiry closes the stream without
serializing error details. Pre-stream errors use fixed H0/H1-style JSON errors.

Validate persisted events against the closed event schema before serialization.
Send `id`, `event` (closed event type), and JSON `data`; no internal checkpoint
or execution fields. Set text/event-stream, no-store and buffering-disabled
headers. Drain persisted events in order before closing a terminal or
needs_input Run. Observe terminal state before the final event read so a commit
between reads cannot cause the completion event to be skipped. A cursor ahead
of the durable head is a conflict, not a reason to regenerate anything.

Add a repository-owned `listEventPage(credential, runId, afterSequence = 0,
limit = 16)` returning `{events, headSequence}`. Validate safe integer cursors
and limits 1..16, authorize the owned Run, and read the head and selected rows
in one short read transaction. Use SQL LIMIT and a SQL CASE byte-length guard:
only materialize event_json when its UTF-8 BLOB length is at most 65536 bytes;
an oversized row is rejected, never skipped or fetched in full. Parse each
selected event and verify its stored sequence and Run linkage. This does not
change the existing listEvents contract or expose SQL to the HTTP module.

Read the initial finite page before returning HTTP 200 to detect invalid
cursors/data. Use stream highWaterMark zero and at most one retained page of
16 events. Encoded frames are limited to 65536 + 256 bytes each. No read demand
means no further polling or growing queue; a slow reader does not cause Run
cancellation. No extra slow-consumer timeout is needed. Stream errors and limit
failures close observation without emitting synthetic business events.

Finite tests cover ownership, cursor rejection, ordered replay, no-change and
needs_input closure, an event arriving between observations, duplicate-free
resume, abort/cancel cleanup, expired identity, invalid persisted event
redaction and a non-reading consumer with fake time. Do not create an infinite
producer or real waiting loop. Browser reconnection acceptance remains pending.
