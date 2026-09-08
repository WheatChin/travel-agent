import { describe, expect, it } from "vitest";
import { committedSnapshotFixture, scheduledFixture } from "./schedule-fixtures";

import {
  committedItinerarySnapshotSchema,
  evidenceFactSchema,
  groundedCandidateSchema,
  groundedPlaceSchema,
  itineraryDraftSchema,
  scheduledItinerarySchema,
} from "../src/domain";

const brief = {
  revision: 1,
  destination: { query: "Beijing", status: "resolved", candidates: [], cityId: "city_beijing", administrativeAreaIds: ["area_beijing"], timeZone: "Asia/Shanghai" },
  requestedDayCount: 1,
  startDate: null,
  endDate: null,
  exactDateVerificationRequired: false,
  references: [],
  hardConstraints: [],
  preferences: { pace: "balanced", transportModes: ["walk"], interests: [], companions: null },
  dayWindows: [{ dayIndex: 1, startMinute: 540, endMinute: 1080 }],
  boundaries: [],
  durationOverrides: [],
  allowedRepeatedPlaceIds: [],
  explicitlyFreeDayIndices: [],
  excludedPlaceIds: [],
  acceptedPolicyOverrides: [],
  assumptions: [],
} as const;

const place = {
  id: "place_palace-museum",
  factRevision: 1,
  provider: "synthetic-test",
  providerPlaceId: "test-palace",
  name: "Palace Museum",
  cityId: "city_beijing",
  administrativeAreaId: "area_beijing",
  coordinates: { longitude: 116.397, latitude: 39.916, coordinateSystem: "GCJ-02" },
} as const;

const evidence = {
  id: "evidence_palace-hours",
  revision: 1,
  placeId: place.id,
  field: "opening_windows",
  value: [{ startMinute: 510, endMinute: 1020 }],
  excerpt: "Synthetic opening window for contract tests.",
  sourceUrl: null,
  retrievedAt: null,
  applicableFrom: null,
  applicableThrough: null,
  status: "known",
  freshness: "current",
  sourceKind: "synthetic_fixture",
} as const;

const scheduled = scheduledFixture();

describe("canonical contracts", () => {
  it.each([
    { value: [{ startMinute: 600, endMinute: 600 }] },
    { value: [{ startMinute: 700, endMinute: 600 }] },
    { applicableFrom: "2026-10-02", applicableThrough: "2026-10-01" },
    { field: "closure_dates", value: ["2026-02-30"] },
    { field: "latest_entry", value: 1441 },
    { field: "stay_duration", value: 1440 },
    { field: "opening_windows", value: null },
  ])("rejects invalid typed Evidence values or applicability: %j", override => {
    expect(evidenceFactSchema.safeParse({ ...evidence, ...override }).success).toBe(false);
  });

  it("permits ordered applicability and deeply freezes opening windows", () => {
    const parsed = evidenceFactSchema.parse({ ...evidence, applicableFrom: "2026-10-01", applicableThrough: "2026-10-01" });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.value)).toBe(true);
    if (Array.isArray(parsed.value)) expect(Object.isFrozen(parsed.value[0])).toBe(true);
  });

  it("freezes every nested value at each public canonical schema", () => {
    const assertFrozen = (value: unknown): void => {
      if (value !== null && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        for (const child of Object.values(value)) assertFrozen(child);
      }
    };
    assertFrozen(groundedPlaceSchema.parse(place));
    assertFrozen(groundedCandidateSchema.parse({ id: "candidate_palace", placeId: place.id, placeFactRevision: 1, evidenceIds: [evidence.id], durationOptionIds: ["duration_palace"] }));
    assertFrozen(itineraryDraftSchema.parse({ kind: "draft", tripId: "trip_beijing", runId: "run_beijing-1", baseVersionId: null, briefRevision: 1, days: [{ id: "day_beijing-1", dayIndex: 1, visits: [{ id: "visit_palace", placeId: place.id, durationOptionId: null, durationMinutes: null, locked: false, evidenceIds: [] }] }] }));
    assertFrozen(scheduledItinerarySchema.parse(scheduled));
    const parsed = evidenceFactSchema.parse(evidence);
    assertFrozen(parsed);
  });
  it("requires grounded Place coordinates and rejects unknown fields", () => {
    expect(groundedPlaceSchema.parse(place)).toEqual(place);
    expect(groundedPlaceSchema.safeParse({ ...place, coordinates: null }).success).toBe(false);
    expect(groundedPlaceSchema.safeParse({ ...place, district: "Dongcheng" }).success).toBe(false);
  });

  it("enforces field-level Evidence grounding rules", () => {
    expect(evidenceFactSchema.parse(evidence)).toEqual(evidence);
    expect(evidenceFactSchema.safeParse({ ...evidence, sourceKind: "external" }).success).toBe(false);
    expect(evidenceFactSchema.safeParse({ ...evidence, status: "unknown", value: "09:00" }).success).toBe(false);
  });

  it("separates unscheduled drafts from complete scheduled ledgers", () => {
    expect(itineraryDraftSchema.safeParse({ kind: "draft", tripId: "trip_beijing", runId: "run_beijing-1", baseVersionId: null, briefRevision: 1, days: [{ id: "day_beijing-1", dayIndex: 1, visits: [{ id: "visit_palace", placeId: place.id, durationOptionId: null, durationMinutes: null, locked: false, evidenceIds: [] }] }] }).success).toBe(true);
    expect(scheduledItinerarySchema.parse(scheduled)).toEqual(scheduled);
    expect(scheduledItinerarySchema.safeParse({ ...scheduled, percentage: 100 }).success).toBe(false);
  });

  it("exports one strict production committed snapshot with repository identity and Evidence references", () => {
    const snapshot = committedSnapshotFixture();

    const parsed = committedItinerarySnapshotSchema.parse(snapshot);
    expect(parsed).toEqual(snapshot);
    expect(Object.isFrozen(parsed.brief.destination)).toBe(true);
    expect(Object.isFrozen(parsed.places[0].coordinates)).toBe(true);
    expect(Object.isFrozen(parsed.itinerary.days[0].scheduleBlocks[0])).toBe(true);
    if (Array.isArray(parsed.evidence[0].value)) expect(Object.isFrozen(parsed.evidence[0].value[0])).toBe(true);
    expect(committedItinerarySnapshotSchema.safeParse({ ...snapshot, ownerId: "owner_forged" }).success).toBe(false);
    expect(committedItinerarySnapshotSchema.safeParse({ ...snapshot, brief: { ...brief, surprise: true } }).success).toBe(false);
    expect(committedItinerarySnapshotSchema.safeParse({ ...snapshot, evidenceIds: [] }).success).toBe(false);
    expect(committedItinerarySnapshotSchema.safeParse({ ...snapshot, schemaVersion: undefined }).success).toBe(false);
    expect(committedItinerarySnapshotSchema.safeParse({ ...snapshot, routes: [] }).success).toBe(false);
    expect(committedItinerarySnapshotSchema.safeParse({ ...snapshot, candidates: [] }).success).toBe(false);
    expect(committedItinerarySnapshotSchema.safeParse({ ...snapshot, places: snapshot.places.map(value => ({ ...value, factRevision: 2 })) }).success).toBe(false);
  });
});
