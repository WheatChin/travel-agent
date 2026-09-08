# AMap Routing Contracts

## Scope And Evidence Status

- Scope: walking/transit routing, POI detail and coordinate basis; two official pages supply the bounded HTTP evidence below. Two additional coordinate URLs are unverified leads only.
- This research task initially received no readable web-tool results. Its earlier claim of four fetched documents remains withdrawn; previously reported line counts and update dates are not evidence.
- Subsequently, the main thread supplied readable evidence from bounded HttpClient reads: **1 MiB per page, 10 seconds per page**. This update transcribes that supplied evidence, not an independent fetch or a live API verification.
- Main reported 625355 bytes for [routing][direction] and 381160 bytes for [POI search/detail][search].
- The subsequent claim of readable coordinate-basis web-search evidence was withdrawn: web returned no readable output. The two coordinate URLs are leads only, not supporting evidence. [FAQ lead][coordinate-faq] / [JS coordinate conversion lead][coordinate-conversion]
- Only this file is owned here. This update made no network requests, read no credentials, called no paid API, and ran no browser, Node, build or tests.

## Documented Facts From Main-Thread Evidence

### Walking

- Endpoint: `GET https://restapi.amap.com/v3/direction/walking`. `origin` and `destination` use longitude,latitude with at most six decimal places. [Source][direction]
- Response: `status=1` means success; `status=0` means failure, with `info`. Walking `paths.distance` is in meters; `paths.duration` is in seconds; `steps.polyline` supplies coordinates. Paths here are descriptive nesting, not a claim that array indexes are absent. [Source][direction]

### Transit

- Endpoint: `GET https://restapi.amap.com/v3/direction/transit/integrated`. `city` is required and accepts a city name or citycode; `cityd` is required for cross-city travel. Documented options include `extensions=all`, `strategy=0` (fastest) and `strategy=3` (least walking). [Source][direction]
- Optional `date` and `time` filter available lines by departure date/time. The supplied evidence does not establish a supported future horizon or guarantee that a future departure will operate. [Source][direction]
- `transits.duration` is in seconds and `transits.walking_distance` in meters. Within segments, `walking.duration` is in seconds, `walking.distance` in meters, and `walking.steps.polyline` supplies walking geometry. [Source][direction]
- Within segments, `bus.buslines.duration` is in seconds, `bus.buslines.distance` in meters, and `bus.buslines.polyline` is a geometry string. The documented `route.distance` is the origin-to-destination walking distance, **not total transit distance**. [Source][direction]

### POI Detail And Administrative Metadata

- Endpoint: `GET https://restapi.amap.com/v3/place/detail?id=POIID&key=...` (placeholders only). The documentation directs users unable to obtain detail to contact business support for advanced permissions; actual account entitlement is not established here. [Source][search]
- Detail responses refer to the keyword-search result schema, including `location` as X,Y, `adcode` and `citycode`; administrative fields are annotated with `extensions=all`. These are returned POI metadata, not evidence of an authoritative geographic-boundary test. [Source][search]
- Text search supports `citylimit=true` for strict city restriction and recommends an adcode for `city`. Missing values may be `[]`; adapters must not assume every nominal scalar field is a string. [Source][search]

## Coordinate Basis: Unverified

- GCJ-02 is **not verified by the available evidence**. Longitude/latitude order and X,Y notation do not establish a coordinate reference system. The previously supplied coordinate URLs remain research leads only; neither returned readable web evidence. [FAQ lead][coordinate-faq] / [JS coordinate conversion lead][coordinate-conversion]

## Proposed Policies For Main-Thread Review

These are proposed application policies, **not documented AMap guarantees**.

- Pin the evidenced v3 operations; do not mix in unverified v5 parameters or response paths.
- Normalize documented meters/seconds explicitly; preserve missing fields rather than manufacturing zero. Validate `[]` before scalar conversion.
- Retain transit walking and bus components separately. Do not double-count walking or reinterpret `route.distance` as a transit total.
- Store requested departure date/time separately from returned estimates; do not claim future service confirmation.
- Bind the requested POI ID to the corresponding detail result, retaining coordinates and administrative metadata with provenance; reject or flag absent/conflicting identity or metadata.
- Ordinary routing results must not be treated as proof of wheelchair accessibility, step-free passage, reservation availability, or booking confirmation.
- Neither provider `status=0` nor an absent/empty path automatically means `known_unreachable`. Keep provider failure, unusable data and no-result evidence distinct pending approved deterministic mapping.

## Handoff And Blockers

- **Established from supplied documentation:** v3 walking/transit endpoints, selected parameters, component units/geometry fields, and POI detail metadata. This is documentation evidence, not tested account capability. [Sources][direction] / [POI][search]
- **Unverified:** fine-grained error-code mapping, HTTP/body-error relationships and no-route semantics; the supplied routing evidence only establishes the stated status/info convention. [Evidence scope][direction]
- **Unverified:** the provider coordinate reference system, including the GCJ-02 claim, still requires readable official evidence. The coordinate URLs above are leads only.
- **Unverified:** exact geometry delimiters, completeness and field scalar types still need evidence. [Routing][direction] / [POI][search]
- **Unverified:** date/time formats, timezone, defaults, maximum future horizon and future-service guarantees are not established by the supplied extract. [Evidence scope][direction]
- **Unverified:** complete required-parameter sets, limits, optional-field behavior, and transit-total composition beyond the fields recorded above; do not treat this extract as the complete wire schema. [Evidence scope][direction]
- **Unverified:** POI field optionality and identity/cardinality guarantees beyond the supplied schema summary; advanced-permission availability and actual credentials have not been tested. [Evidence scope][search]
- Main thread owns adapter design and remaining evidence decisions. No implementation, runtime verification or credential-capability approval is included.

[direction]: https://lbs.amap.com/api/webservice/guide/api/direction
[search]: https://lbs.amap.com/api/webservice/guide/api/search
[coordinate-faq]: https://lbs.amap.com/faq/advisory/others/39838
[coordinate-conversion]: https://lbs.amap.com/api/javascript-api-v2/guide/transform/convertfrom
