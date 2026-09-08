# Provider Execution Policy

Status: Main-approved deterministic implementation policy. Live provider
selection and capability verification remain open; no paid calls are authorized
by this document alone. Baseline 0001 AC-07, AC-14, AC-15 and AC-16 govern gates.

## Boundaries

Use server-only adapters with injected transport and explicit capabilities.
An adapter accepts typed queries and returns normalized facts or typed failures.
It never writes versions, chooses Owner identity, or expands mutation scope.
Fake and live implementations share contracts; only fake returns synthetic
facts, with explicit synthetic provenance. Provider docs are recorded separately
in `docs/research/live-provider-contracts.md` when verified.

Retain the user's configured DeepSeek endpoint and `deepseek-v4-flash` model.
An unsupported model is a capability failure, never silent model substitution.
AMap Web Service and restricted browser keys remain separate capabilities.
Research provider choice is not inferred from possession of an LLM credential.
Missing capabilities must be visible without crashing unrelated history reads.

## Budget Policy

Pin policy ID `provider-budget-mvp-v1`. These are ceilings, not targets or
latency promises. Reserve attempts durably before starting transport. Counters
are cumulative across recovery and clarification, and each retry consumes one.

| Operation | Per-Run ceiling | Timeout |
| --- | --- | --- |
| Research search | 4 requests total; at most 1 supplementary round | 15 seconds |
| Research document fetch | 8 requests, 1 MiB decoded bytes each | 15 seconds |
| POI search/details | 40 requests; retain at most 28 candidates | 10 seconds |
| Route comparisons plus selected Legs/boundaries | 96 requests total | 15 seconds |
| Model tasks after Turn acceptance | 12 calls total | 60 seconds |
| Accepted model output | 4096 output tokens per call, 32768 total requested output tokens | Same call timeout |
| Semantic repair | 2 attempts, additionally constrained by all budgets above | No separate allowance |

Natural-language classification happens before Run acceptance. Bound each
submission to 2 model attempts and 1024 output tokens per attempt. Perform
ownership, strict input, existing Turn replay and base checks before its first
call, then recheck at acceptance. Classification retry does not bypass the
Run's own subsequent budgets. Deterministic commands use zero classification
calls. A malformed result never becomes a default mutation.

At most 2 transport attempts per logical operation, including the initial one,
within the relevant ceiling. Retry only transient transport failures, 408,
429 and 5xx; no retry on auth, denied capability, malformed input or known
unreachable route. For attempt two, wait 1 second or a valid Retry-After up to
30 seconds. Longer requested delays return a typed rate-limit outcome.
Persist nextRetryAt; do not occupy a lease by sleeping indefinitely.

The two semantic repairs are two distinct logical repair operations, not two
HTTP requests. A repair retry reuses its logical operation ID and consumes
another model call and requested-token allowance, but not a second semantic
repair round. Each repair operation still has at most two transport attempts.
Thus two repair operations with one retry each consume four model calls within
the same total ceilings. Resumption must preserve both logical repair identities
and their attempt ledgers.

Schema-invalid model output allows one corrective attempt within task and
global limits. Refusal/empty/incomplete response is explicit, not fabricated
JSON. Retry prompts contain only the allowed schema error summary, not raw
provider errors or hidden reasoning. No automatic unbounded extraction loop.

Run budget exhaustion produces `budget_exhausted` and the retained draft/current
version. Missing required facts produce unresolved issues; neither becomes a
degraded committed timeline. Local deterministic edits do not replenish budgets
by creating hidden planning Runs or launch supplementary research.

## Fact Freshness

Pin policy ID `fact-freshness-mvp-v1`. Inject current time; retain retrievedAt,
source applicability, provider revision and source-kind independently.
Historical snapshots are never reevaluated against today's cache clock.

| Fact | Maximum cache age for new planning |
| --- | --- |
| POI identity, area and coordinate record | 7 days |
| Opening windows, closure, latest entry, reservation and entry conditions | 24 hours |
| Accessibility | 24 hours; ordinary routing is not evidence |
| Sourced planned stay recommendation | 30 days |
| Walk/bicycle routes | 24 hours, exact endpoint/mode/applicability key |
| Transit/taxi/drive routes | 15 minutes, exact departure context |

Age alone does not establish applicability or truth. Unknown retrieval time,
future retrieval time, conflicting sources or outside-date applicability cannot
be admitted as current verified facts. Undated trips do not inherit a claim of
specific-date availability. If a provider does not support future departure
semantics, its current estimate must be labelled as such and cannot satisfy an
explicit exact-departure requirement.

Prefer applicable official venue notices; unresolved conflicts remain explicit.
Evidence extraction may reference only supplied source and Place IDs. The
adapter retains excerpts and checks field/value bindings. A URL or matching ID
does not prove entailment; source-support evaluation remains a separate gate.

## Fetch And Redaction

The model cannot select arbitrary fetch targets. Fetch only source URLs returned
by the configured research adapter after server validation. Allow HTTPS only,
no userinfo, no IP-literal host, and no private/loopback/link-local/reserved
resolved address. Revalidate every redirect, at most three; pin transport to the
validated resolution to avoid DNS rebinding. If that guarantee is unavailable,
disable direct fetch and use the research provider's documented extraction API.
Honor byte/time limits while streaming, including decompressed output.

Do not forward cookies, authorization headers or provider keys between hosts.
Map/LLM origins are configured allowlisted endpoints, never web-result URLs.
Logs contain operation IDs, duration, normalized status and consumed counters
only. No request bodies, response bodies, raw URLs containing query secrets,
credentials, full prompts or chain-of-thought in logs or SSE.

## Verification

Use injected deterministic transport for budget reservation-before-call,
crash/reopen consumption, timeout/429/retry exhaustion, cancellation admission,
schema correction limits, source applicability and cache immutability.
Test fetch redirects, DNS/address rejection, byte limits and synthetic-secret
redaction separately. Live capability, latency/cost observations and source
quality evaluation remain unpassed until recorded against configured providers.
