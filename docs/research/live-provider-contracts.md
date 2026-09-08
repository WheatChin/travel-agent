# Live Provider Contracts

Status: partial primary-source inspection on 2026-09-08 (local date).
No authenticated request or paid call was made. Documentation support does not
prove this installation's credentials, permissions, balance, or live latency.
The background research slot was unavailable; the main thread inspected the
official documentation directly. Web-tool calls returned no readable content.
Subsequent HttpClient reads used a ten-second cancellation deadline and a fixed
1 MiB byte buffer per public document. Readable passages were returned for the
Chat Completions reference (133067 bytes), AMap POI (381160 bytes), and AMap
browser security (120486 bytes). The pricing-page request timed out and does
not support any conclusion here.

## DeepSeek

Source: https://api-docs.deepseek.com/api/create-chat-completion/

The API reference lists `deepseek-v4-flash` among supported model identifiers.
Retain the user's endpoint and model name; do not substitute either.

The Chat Completions reference documents `POST /chat/completions`, `messages`,
`model`, `max_tokens`, and `response_format: { type: "json_object" }`.
JSON mode also requires an explicit instruction to produce JSON. A `length`
finish reason can mean truncated content. Thinking is enabled by default and
can be disabled with `thinking: { type: "disabled" }`.
Responses separate `message.content` from `reasoning_content`; terminal reasons
also include content filtering, tool calls, and insufficient resources.
Function arguments require application validation.

Implementation decisions (not vendor guarantees): use bounded non-streaming
JSON task calls, no model-granted tools, strict task schemas and supplied-ID
checks. Only accept a complete permitted result; never expose reasoning content
through application SSE. Explicitly set token limits from design 0007.
Structured tasks initially disable thinking to avoid an implicit reasoning mode;
quality must still pass the fixed prompt evaluations. The adapter must not
silently change model/mode after an error.

## AMap Places

Source: https://lbs.amap.com/api/webservice/guide/api/search

The official POI reference requires a Web Service API key. Keyword search uses
`https://restapi.amap.com/v3/place/text`.
`city` favors a city but is not a strict city restriction; `citylimit=true`
restricts it. The documentation recommends administrative codes for precision.
Results include provider identity, longitude/latitude location and administrative
fields. Some absent values are arrays rather than strings. Detail lookup's
exact request and permission contract still needs focused inspection.

Implementation decisions: request city restriction, retain provider IDs and
validate returned administrative membership again in deterministic code.
Normalize missing data explicitly rather than converting an empty array to
a real fact. Do not interpret HTTP 200 alone as provider success.

## AMap Browser Security

Source: https://lbs.amap.com/api/jsapi-v2/guide/abc/prepare

The official security guide describes proxy-based and cleartext security-code
configuration and recommends keeping the security code on the server.
The guide shows `serviceHost` ending in the fixed `/_AMapService` prefix and
requires configuration before loading the JS API script. Its sample proxies
map styles to `webapi.amap.com` and Web Service requests to `restapi.amap.com`,
adding the server security code. It explicitly allows a Node implementation.
An application-specific restricted path/query allowlist, byte limits, and
credential redaction must be designed before implementing this proxy; do not
copy a permissive catch-all proxy into the application.

## Still Open

- Actual DeepSeek authentication/model access, bounded live completion and
  measured usage; do not print credentials or full provider response bodies.
- AMap browser-key versus Web Service-key capabilities and server security
  proxy details; supplied credentials have not been exercised.
- Route endpoint versions, response duration units, geometry structure and
  transit/walking component normalization need dedicated primary-source review.
- Web research provider selection, authenticated search/extraction contract and
  user configuration remain open. An LLM key is not a search capability.
- Source-quality and entailment evaluation, future-date applicability, and all
  live AC-17 evidence remain open. These notes close documentation questions
  only, not application acceptance gates.
