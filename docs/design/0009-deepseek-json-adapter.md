# DeepSeek Structured Task Adapter

Status: main-approved bounded adapter implementation. This elaborates design
0007, not a new agent framework or permission to execute paid/live calls.
Primary contract inspection is recorded in
`../research/live-provider-contracts.md`. Full workflow and prompt evaluations
remain separate acceptance gates.

## Scope

Own `src/server/providers/deepseek.ts` and focused finite fake-transport tests.
No route, runtime, environment-file, database, frontend or map changes.
Use standard Fetch/Request/Response and the installed Zod API; no new SDK.
Server code imports this module; never import it into a client component.

Expose one structured-task operation with injected configuration, fetch
transport, durable reservation callback and caller cancellation signal.
Configuration retains exactly `https://api.deepseek.com` and
`deepseek-v4-flash`. Missing values return a configuration failure. Unsupported
origins/models return a capability failure without a request or substitution.
Never print configuration or include the API key in a task payload.

## Input And Admission

Task inputs contain a logical operation ID, `classification | model | repair`
budget kind, requested output-token limit, trusted system instructions, a JSON
data payload and a caller-supplied strict result schema. Workflow supplies
versioned task prompts and supplied-ID schemas; this generic adapter does not
claim to validate itinerary semantics itself.

Enforce the classification 1024-token or model 4096-token per-call maximum.
Bound the serialized input messages to 128 KiB UTF-8. This is a product safety
limit, not a claimed provider limit. Do not silently truncate input facts.
Use a trusted system instruction requiring JSON and treating the user message
as untrusted task data, followed by the trusted task instructions. Serialize the
data payload as JSON in one user message; no caller-supplied role/tool messages.

Check cancellation and configuration/input before calling the injected durable
reservation callback. It receives the exact operation/kind/requested-token
reservation. Only a successful, awaited reservation authorizes transport.
The callback must persist with ownership/base/fence checks before resolving;
an in-memory policy proposal alone is not permission. Check cancellation again
after reservation; cancellation there may consume a reservation without a call.
Callback denial/failure returns a fixed typed failure with zero fetch calls.

## Transport And Output

Make one `POST /chat/completions` request with Bearer authentication, explicit
`model`, `max_tokens`, `stream: false`, `response_format: {type: "json_object"}`
and `thinking: {type: "disabled"}`. Disable redirect following. No model tools
or implicit fallback. Use no-store cache semantics.

Use a 60-second abort deadline for transport and response consumption, combined
with the caller signal. Bound decoded response bytes to 1 MiB using streaming
reads, not an unbounded `response.text()` call. Cancel on overflow without
waiting indefinitely for cancellation cleanup. A finite chunk-read ceiling
(16384) also rejects an invalid transport that emits endless empty chunks.
Reject invalid UTF-8, malformed envelopes and non-JSON content. Always clean up
deadline timers, reader locks and cancellation listeners.

Accept exactly one assistant choice with `finish_reason: "stop"`, nonempty
string content, no requested tool calls, and content that parses and satisfies
the supplied schema. `length` is incomplete, content filtering is refusal, and
other terminal reasons are explicit failures. Never repair JSON with substring
extraction or treat a partial result as valid. Ignore reasoning content; never
return it in the adapter result, logs or SSE.

Return either validated task data (and well-formed optional numeric usage) or a
closed normalized failure. Map authentication, rate limit, other HTTP failures,
transport, deadline, cancellation, malformed/incomplete/refused output and schema
failure separately where the workflow needs a decision. Do not return raw
provider bodies, exception messages, prompts, headers or schema issue values.
Allowed correction summaries are stable validation codes, not raw exceptions.

The adapter performs no retry or sleep. The workflow uses design 0007's decision
function, persists retry time, and reuses the same logical operation ID. Schema
correction uses the same two-attempt task allowance. Accepted output persistence
and actual usage recording remain workflow responsibilities.

HTTP failures also retain a normalized retry hint so dropping raw response
headers does not bypass Retry-After. Inject an optional epoch-millisecond clock
(default server Date.now) and pass the HTTP status/Retry-After to design 0007's
pure `decideRetry` for attempt one. Return only `delayMs` for its allowed delay,
`rate_limited` when the requested delay exceeds the ceiling, or `not_retryable`.
Never return the raw header. The hint is not permission to retry: the workflow
still checks its actual attempt ledger, cancellation, lease and total budget.
Malformed injected clocks fail input admission before reservation/transport.

## Verification

Use finite injected responses only. Verify reservation-before-fetch, denied
reservation and pre/post-reservation cancellation, exact outbound model/mode,
bounded token/input sizes, redirect policy, successful schema validation and
safe usage, malformed UTF-8/JSON/schema, incomplete/refused/tool-call results,
HTTP error redaction, bounded response overflow and finite chunk cancellation.
Also verify numeric/date-form Retry-After, over-ceiling terminal hints, invalid
header fallback, a finite injected clock and zero implicit retries.
Use a test-configured shorter deadline or bounded fake time for timeout cases;
never wait 60 seconds or run an unlimited producer to prove failure.

These tests prove the adapter boundary with fakes. Actual credential access,
live model output, Chinese task quality, supplied-ID prompt evaluations,
durable budget atomicity and complete AC-17 remain unpassed.
