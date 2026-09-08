# Phase 1 Desktop Verification

Status: **PASS**

Date: 2026-09-08  
Scope: Desktop-only fixture-backed Web experience. This result covers the
Phase 1 portion of AC-12 only; it makes no mobile/PWA, live provider, LLM,
authentication, persistence, or production mutation claim.

## Acceptance Basis

- `AGENTS.md` product invariants
- `CONTEXT.md` domain language
- `docs/design/0001-mvp-product-and-workflow.md`, Section 20, AC-12
- `docs/design/0002-phase1-desktop-implementation.md`

### Tested Snapshot

- No Git commit was created. Source snapshot SHA-256:
  `414d32effab52f61a6714d61bec249561d759b297e125fa796e8fd18bc35f165`.
- This fingerprints 35 files: all files in `src`, `tests`, and `public`, plus
  `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`,
  `next-env.d.ts`, `eslint.config.mjs`, `vitest.config.ts`, and
  `playwright.config.ts`. Paths are sorted, normalized to forward slashes, and
  joined with their lowercase SHA-256 hashes as `path:hash` lines; the final
  digest hashes the UTF-8 lines joined by LF without a trailing LF.
- Fixture: `version_beijing-3day-v1`, Trip `trip_beijing-cultural`,
  Conversation `conversation_beijing-cultural`, Brief revision `1`.
- Runtime prompt/model and production scheduling-policy versions: not applicable
  in Phase 1; none were executed. All other acceptance IDs remain later-phase
  work, not implicitly passed by this result.

AC-12 requires Library, continuous overview/day List, Map shell, and Planning
Conversation to use one Itinerary Version; day, Visit, and Leg selection to
persist across projection switches; desktop panels not to overlap; fixture edit
failure and image fallback to remain usable; and labels and keyboard focus to
work at 1024px, 1280px, and 1440px desktop widths.

## Reference Review

The supplied references are mobile compositions, so only their information
patterns were applied to this desktop-only implementation:

- The library keeps trip identity, duration/version, date state, photography,
  and a direct Map affordance visible.
- List keeps trip/day/mode navigation above one continuous overview and day
  timeline. Visit cards and intervening Leg rows remain distinct.
- Day selection anchors the continuous List instead of removing other days.
- Map synchronizes numbered Visit selection with the same detail state while
  remaining explicitly unconnected. It renders no basemap, coordinates, road
  path, or invented route geometry.

## Browser Matrix

Playwright `1.63.0` used Chrome for Testing `153.0.8010.12` (Chromium revision
1243). The final full suite ran 9 tests in each project.

| Project | Viewport | Result | Production screenshot evidence |
| --- | --- | --- | --- |
| `desktop-1024` | 1024 x 768 | 9/9 pass | [Library](artifacts/phase1/desktop-1024-library.png), [List](artifacts/phase1/desktop-1024-day2-list.png), [Visit detail](artifacts/phase1/desktop-1024-temple-detail.png), [Map](artifacts/phase1/desktop-1024-day2-map.png) |
| `desktop-1280` | 1280 x 800 | 9/9 pass | [Library](artifacts/phase1/desktop-1280-library.png), [List](artifacts/phase1/desktop-1280-day2-list.png), [Visit detail](artifacts/phase1/desktop-1280-temple-detail.png), [Map](artifacts/phase1/desktop-1280-day2-map.png) |
| `desktop-1440` | 1440 x 900 | 9/9 pass | [Library](artifacts/phase1/desktop-1440-library.png), [List](artifacts/phase1/desktop-1440-day2-list.png), [Visit detail](artifacts/phase1/desktop-1440-temple-detail.png), [Map](artifacts/phase1/desktop-1440-day2-map.png) |

All 12 PNGs were regenerated from the final production build and visually
inspected. There is no development toolbar in the final artifacts. The
`09:00-11:30` value is fully visible at 1024px, detail and conversation regions
do not collide, and the Temple of Heaven remains recognizable in card and
detail crops at all widths. No incoherent overlap or clipped visible text was
found.

## Independent E2E Coverage

| Area | Observation | Result |
| --- | --- | --- |
| Library/workspace | Beijing fixture opens; return navigation and labelled Map shortcut work | Pass |
| Shared version | Library, List, day detail, Map, and conversation retain version 1 | Pass |
| Continuous List | All three day anchors stay mounted; Day 3 then Overview resets projection scrollTop to 0 | Pass |
| Selection | Day, Visit, and Leg selections survive List/Map and conversation switches | Pass |
| Details | Visit times/duration/district and null Leg facts remain explicit | Pass |
| Conversation | Toggle works; unsupported free-form generation receives a fixture-only response | Pass |
| Fixture outcomes | Pending, rejected, cancelled, phase status, and retained old version are explicit | Pass |
| Empty/image states | Empty library and six accessible image placeholders work | Pass |
| Date staging | Cancel discards the draft; simulated submit does not rewrite canonical card date | Pass |
| Dialog accessibility | Labels, Enter, Tab/Shift+Tab trap, Escape, focus retention while typing, and trigger restoration work | Pass |
| Layout | No horizontal page overflow; detail/conversation panels stay in viewport without collision | Pass |
| Runtime isolation | No console/page errors, failed HTTP/assets, failed requests, or remote requests | Pass |

The E2E suite intentionally does not duplicate schema or reducer unit tests. It
exercises integrated browser behavior and visible state.

## Commands And Results

| Command | Result |
| --- | --- |
| `npm run test:e2e` | 27/27 passed in 35.6s; 9 tests at each required viewport |
| `npx playwright test -g "capture desktop visual evidence"` against `npm run start -- --hostname 127.0.0.1 --port 3100` | 3/3 passed in 5.6s; produced 12 final production PNGs |
| `npm test` | 2 files passed, 30/30 tests passed in 1.34s |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with 0 errors and 3 warnings |
| `npm run build` | Passed; Next.js 16.3.4 generated static `/` and `/_not-found` routes |

The final production server was stopped after screenshot capture.

## Findings Closed

Testing found or protected regressions for the continuous List day anchors,
the Library Map shortcut, date cancellation/canonical display, modal focus
stability, mismatched conversation CSS selectors, malformed CSS tokens,
detail/conversation panel layout, 1024px detail-time clipping, and Overview
scroll reset. These were routed to the UI coder and the final suite and visual
pass confirm the corrected behavior.

An initial 1024 run had 7/9 passes. One failure was an obsolete exact-text test
expectation after the staged Typed Command was intentionally exposed. The other
was a screenshot timing artifact: Playwright's default caret hiding modified a
controlled input while hydration was completing. Final capture first proves
React interactivity and uses `caret: "initial"`; console-error assertions remain
active and the final development and production runs emitted no browser errors.

A scoped text scan found no credential-like assignment, bearer value, or
32-hex token in `src`, `public`, `tests`, or this report. Runtime observation
found no remote network request. No environment or private credential source
was inspected.

## Remaining Risks

- Lint retains three non-blocking warnings: one `@next/next/no-img-element` in
  the fallback-capable Place image component and two unused destructuring
  bindings in `tests/contracts.test.ts`.
- Vitest 5.0.0 reports that `vitest.config.ts` uses ESM syntax while loaded as
  CommonJS, which may be unsupported when Vite's native config loader becomes
  the default in a future major version.
- Browser coverage is Chromium desktop only. Mobile/PWA and Firefox/WebKit are
  outside the approved Phase 1 scope.
- The Map is intentionally a fixture shell. Live maps, routing, providers,
  credentials, persistence, authorization, and real mutation execution remain
  later-phase gates.
