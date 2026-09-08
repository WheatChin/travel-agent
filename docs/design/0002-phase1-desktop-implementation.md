# Phase 1: Desktop Contract And Fixture Workspace

Status: Completed and verified, 2026-09-08. Derived from the approved Phase 1
and the user's desktop-only change. Acceptance authority remains design 0001,
Section 20, AC-12 and the Phase 1 exit gate. Results are recorded in
[the verification report](../reviews/phase1-verification.md).

## Goal And Boundaries

Deliver a usable Chinese desktop travel-planning workspace from one immutable
Beijing three-day fixture version. This is a presentation/contract milestone,
not live itinerary generation. No LLM, AMap SDK, network search, database,
anonymous authentication, durable SSE execution, mobile UI, or PWA.

Use Next.js App Router, React, TypeScript, Zod and lucide-react. Pin installed
dependency versions in the lockfile. Vitest covers contracts and fixture state;
Playwright covers desktop interactions and screenshots. Runtime UI does not
fetch provider data or silently claim fixture facts were verified live.

## Implementation Ownership

- Domain/fixture coder: `src/domain/`, `src/fixtures/`, and contract unit tests.
- Web coder: package/configuration, `src/app/`, `src/components/`,
  `src/presentation/`, local public assets, and presentation unit tests.
- Tester: browser test configuration/tests, verification artifacts and report.
- Main thread: design/process documents, integration decisions and final gate.

Workers must accommodate each other's edits, not revert unrelated files.

## Shared Contract

Export strict Zod schemas and inferred types from `src/domain/contracts.ts`.
Model identity, Brief, Place, Evidence, Visit, Leg, Day Plan, immutable Version,
Typed Commands, Turn envelope, Requirement Issues, Run states, SSE events, and
view selection. Reject unknown properties at transport boundaries. Cross-record
travel feasibility and real authorization belong to later phases.

The UI's fixture import is `beijingFixture` from `src/fixtures/beijing.ts`,
typed as `ItineraryVersion`, with this stable shape:

```text
id, tripId, conversationId, title, destination, dateStart (nullable),
dayCount, briefRevision, provenance ("fixture"),
days: [{ id, dayIndex, title, summary, visits, legs }],
places: [{ id, name, district, description, imageSrc, imageAlt,
           coordinates (nullable), provenance ("fixture") }],
evidence: [{ id, placeId, title, url (nullable), retrievedAt (nullable),
             status ("fixture" | "unknown" | "verified"), excerpt }],
assumptions: string[], warnings: string[]

Visit: id, placeId, startTime, endTime, durationMinutes, locked, evidenceIds
Leg: id, fromVisitId, toVisitId, mode, durationMinutes (nullable),
     distanceMeters (nullable), geometry (nullable), provenance ("fixture")
```

Day indices are 1-based. UI selects day 0 for overview. Domain/fixture coder
communicates any necessary additions before changing these required names.
Fixtures use three days and at least two Visits per day, deterministic stable
IDs, explicit demonstration provenance and no fabricated source URLs/route
geometry. Numeric example schedules are fixture data, not sourced facts or
production scheduler output. Deep-freeze fixture state.

## Desktop Experience

Use quiet light surfaces, charcoal text, restrained green primary accents,
secondary muted red/day colors and real place photography with recorded
attribution. Reference the user's trip library, continuous overview/timeline,
and map/day-selection patterns without copying social navigation.

Start with a usable Trip Library containing the Beijing example. Opening it
shows an itinerary workspace, day tabs, list/map segmented control, source and
warning details, and a planning conversation column. Library/create/date edit
dialogs, active selections, detail closing, and return navigation must work.
Keep visible fixture status concise; no marketing hero or feature explanations.

List and map shell share one version plus view selection; map is explicitly
unconnected, with selectable numbered Visit controls and no invented basemap
or road paths. Leg detail reflects fixture values, labelled as examples.
All external imagery must be local for offline acceptance; missing images
render accessible placeholders. Any display photo's origin/license is recorded.

Only fixture presentation behavior is implemented: pending edits, simulated
rejection/cancellation, status phases, empty library, and retained old version.
A dedicated fixture harness can select these states. Editing controls stage
commands and give explicit simulated outcomes; never claim backend commits.
Typed schemas cover later controls without requiring every mutation engine.
Chat is a fixture exchange, not an ad-hoc pretend LLM. Clear unsupported
messages must not silently produce an unrelated Beijing trip.

## Verification

- Typecheck, lint, unit tests, and production build pass.
- Schemas parse the immutable fixture and representative commands/events;
  reject malformed IDs/enums/unknown fields and missing mutation baselines.
- Browser checks at 1024x768, 1280x800 and 1440x900 cover library/workspace,
  day/list/map selection preservation, Visit/Leg details, conversation toggle,
  pending/rejected/cancelled fixture edits, image fallback and empty state.
- Test labelled controls, keyboard navigation and modal focus restoration.
- Verify no horizontal page overflow, major overlap, browser errors, hidden
  live-provider calls, or credentials in source/output/screenshot artifacts.
- Save real screenshots and report commands/counts/failures honestly. Other
  acceptance IDs remain future-phase work, not implicitly passed.

## LLM Configuration

The user selected DeepSeek with model `deepseek-v4-flash`. Public endpoint/model
metadata may be documented; credentials must not be persisted in this repo,
passed to workers, or used for Phase 1. Do not change Codex's own model routing.
