import { describe, expect, it } from "vitest";

import {
  assessRequirements,
  briefStateSchema,
  committedItinerarySnapshotSchema,
  evidenceFactSchema,
  reduceBrief,
} from "../src/domain";
import { committedSnapshotFixture } from "./schedule-fixtures";

const context = {
  issueRevision: 7,
  supportedCityIds: ["city_beijing"],
  supportedTransportModes: ["walk", "public_transit"],
  lockedDayIndices: [],
  resolvedPlaces: [],
} as const;

function brief(overrides: Record<string, unknown> = {}) {
  return briefStateSchema.parse({
    revision: 0,
    destination: { query: "Beijing", status: "resolved", candidates: [], cityId: "city_beijing", administrativeAreaIds: ["area_beijing"], timeZone: "Asia/Shanghai" },
    requestedDayCount: 2,
    startDate: null,
    endDate: null,
    exactDateVerificationRequired: false,
    references: [],
    hardConstraints: [],
    preferences: { pace: null, transportModes: [], interests: [], companions: null },
    dayWindows: [],
    boundaries: [],
    durationOverrides: [],
    allowedRepeatedPlaceIds: [],
    explicitlyFreeDayIndices: [],
    excludedPlaceIds: [],
    acceptedPolicyOverrides: [],
    assumptions: [],
    ...overrides,
  });
}

const rules = (value: ReturnType<typeof assessRequirements>) => value.blockingIssues.map(issue => issue.rule);

describe("D1 AC-01 requirement gate", () => {
  it("blocks an unresolved destination while aggregating independent issues", () => {
    const result = assessRequirements(brief({
      destination: { query: "Bei", status: "unresolved", candidates: [] },
      requestedDayCount: null,
      exactDateVerificationRequired: true,
    }), context);
    expect(rules(result)).toEqual(expect.arrayContaining([
      "destination.unresolved",
      "duration.missing",
      "dates.required_for_exact_verification",
    ]));
  });

  it.each([
    ["start", { dayIndex: 1, startRequired: true, startReferenceId: null, endRequired: false, endReferenceId: null }, "boundary.start_missing"],
    ["end", { dayIndex: 1, startRequired: false, startReferenceId: null, endRequired: true, endReferenceId: null }, "boundary.end_missing"],
  ])("requires a missing %s boundary", (_label, boundary, expectedRule) => {
    expect(rules(assessRequirements(brief({ boundaries: [boundary] }), context))).toContain(expectedRule);
  });

  it.each(["start", "end"] as const)("blocks an unresolved requested %s boundary reference", role => {
    const referenceId = `reference_${role}`;
    const result = assessRequirements(brief({
      references: [{ id: referenceId, role, query: "hotel", status: "unresolved", placeId: null, candidates: [], dayIndex: 1 }],
      boundaries: [{ dayIndex: 1, startRequired: role === "start", startReferenceId: role === "start" ? referenceId : null, endRequired: role === "end", endReferenceId: role === "end" ? referenceId : null }],
    }), context);
    expect(rules(result)).toContain(`boundary.${role}_unresolved`);
  });

  it("rejects an inclusive date-only range longer than seven days", () => {
    const result = assessRequirements(brief({ requestedDayCount: null, startDate: "2026-10-01", endDate: "2026-10-08" }), context);
    expect(rules(result)).toContain("duration.unsupported");
  });

  it("materializes visible policy assumptions for absent non-blocking fields", () => {
    const result = assessRequirements(brief(), context);
    expect(result.assumptions.map(assumption => assumption.field)).toEqual(expect.arrayContaining([
      "dates", "dayWindows", "preferences.pace", "preferences.transportModes",
      "preferences.companions", "budget", "meals", "lodging", "boundaries",
    ]));
  });

  it("detects contradictory hard density limits without a pace preference", () => {
    const result = assessRequirements(brief({
      hardConstraints: [
        { id: "constraint_min", type: "visit_count", dayIndex: 1, minimum: 4, maximum: null },
        { id: "constraint_max", type: "max_visits", dayIndex: 1, count: 3 },
      ],
    }), context);
    expect(rules(result)).toContain("density.conflict");
  });

  it("detects invalid windows and fixed times outside their hard day window", () => {
    const result = assessRequirements(brief({
      dayWindows: [{ dayIndex: 1, startMinute: 600, endMinute: 540 }],
      hardConstraints: [
        { id: "constraint_window", type: "allowed_day_window", dayIndex: 2, startMinute: 600, endMinute: 720 },
        { id: "constraint_fixed", type: "fixed_visit_start", visitId: "visit_fixed", dayIndex: 2, startMinute: 540 },
      ],
    }), context);
    expect(rules(result)).toEqual(expect.arrayContaining(["day_window.invalid", "fixed_visit.outside_window"]));
  });
});

describe("D1 canonical contracts and AC-07 input closure", () => {
  it("rejects duration overrides beyond the supported same-day bound", () => {
    expect(() => brief({ durationOverrides: [{ placeId: "place_palace", durationMinutes: 1440 }] })).toThrow();
  });

  it.each([
    ["opening_windows", "09:00-17:00"],
    ["closure_dates", 42],
    ["latest_entry", true],
    ["reservation_requirements", [{ startMinute: 540, endMinute: 600 }]],
  ])("discriminates Evidence field %s from incompatible values", (field, value) => {
    expect(() => evidenceFactSchema.parse({
      id: "evidence_fact", revision: 1, placeId: "place_palace", field, value,
      excerpt: "fixture", sourceUrl: null, retrievedAt: null,
      applicableFrom: null, applicableThrough: null, status: "known",
      freshness: "current", sourceKind: "synthetic_fixture",
    })).toThrow();
  });

  it("deep-freezes nested canonical records", () => {
    const parsed = brief({
      destination: { query: "Beijing", status: "resolved", candidates: [{ placeId: "place_beijing", label: "Beijing" }], cityId: "city_beijing", administrativeAreaIds: ["area_beijing"], timeZone: "Asia/Shanghai" },
      hardConstraints: [{ id: "constraint_walk", type: "max_walking", durationMinutes: 60, distanceMeters: null }],
    });
    expect(Object.isFrozen(parsed.destination)).toBe(true);
    expect(Object.isFrozen(parsed.destination.candidates[0])).toBe(true);
    expect(Object.isFrozen(parsed.hardConstraints[0])).toBe(true);
    expect(Object.isFrozen(parsed.preferences)).toBe(true);
  });

  it("rejects committed Visit Evidence IDs absent from frozen Evidence", () => {
    const original = committedSnapshotFixture();
    const day = original.itinerary.days[0];
    const input = {
      ...original,
      itinerary: {
        ...original.itinerary,
        days: [{
          ...day,
          visits: day.visits.map((visit, index) => index === 0
            ? { ...visit, evidenceIds: ["evidence_unknown"] }
            : visit),
        }],
      },
    };
    expect(() => committedItinerarySnapshotSchema.parse(input)).toThrowError(/Evidence/i);
  });

  it("keeps reducer output independent from later patch mutation", () => {
    const current = brief();
    const patch = { preferences: { operation: "set", value: { pace: "balanced", transportModes: ["walk"], interests: ["history"], companions: null } } } as const;
    const reduced = reduceBrief(current, patch).brief;
    expect(Object.isFrozen(reduced.preferences)).toBe(true);
    expect(Object.isFrozen(reduced.preferences.interests)).toBe(true);
  });
});

describe("D1 independent calendar and conflict boundaries", () => {
  it.each([
    ["ordinary year end", "2026-12-31", "2027-01-02", 3],
    ["non-leap century", "1900-02-28", "1900-03-01", 2],
    ["leap century", "2000-02-28", "2000-03-01", 3],
    ["leap day", "2028-02-29", "2028-03-01", 2],
  ])("counts inclusive calendar days across %s", (_label, startDate, endDate, expectedDays) => {
    const result = assessRequirements(brief({
      requestedDayCount: null,
      startDate,
      endDate,
      exactDateVerificationRequired: true,
    }), context);

    expect(result.effectiveDayCount).toBe(expectedDays);
    expect(rules(result)).not.toContain("dates.required_for_exact_verification");
    expect(rules(result)).not.toContain("dates.reversed");
    expect(rules(result)).not.toContain("duration.unsupported");
  });

  it.each([
    ["2026-12-31", 3, "2027-01-02"],
    ["1900-02-28", 2, "1900-03-01"],
    ["2000-02-28", 3, "2000-03-01"],
  ])("derives %s plus %i days for exact-date readiness without persisting endDate", (startDate, requestedDayCount, expectedEndDate) => {
    const input = brief({
      requestedDayCount,
      startDate,
      endDate: null,
      exactDateVerificationRequired: true,
    });
    const result = assessRequirements(input, context);

    expect(input.endDate).toBeNull();
    expect(result.effectiveEndDate).toBe(expectedEndDate);
    expect(rules(result)).not.toContain("dates.required_for_exact_verification");
  });

  it("returns all identifiable window and fixed-start conflicts together", () => {
    const result = assessRequirements(brief({
      dayWindows: [{ dayIndex: 1, startMinute: 480, endMinute: 1080 }],
      hardConstraints: [
        { id: "constraint_morning", type: "allowed_day_window", dayIndex: 1, startMinute: 540, endMinute: 660 },
        { id: "constraint_evening", type: "allowed_day_window", dayIndex: 1, startMinute: 900, endMinute: 1020 },
        { id: "constraint_fixed-early", type: "fixed_visit_start", visitId: "visit_palace", dayIndex: 1, startMinute: 600 },
        { id: "constraint_fixed-late", type: "fixed_visit_start", visitId: "visit_palace", dayIndex: 1, startMinute: 960 },
      ],
    }), context);

    expect(rules(result)).toEqual(expect.arrayContaining([
      "day_window.conflict",
      "fixed_visit.outside_window",
      "fixed_visit.conflict",
    ]));
  });

  it("combines every Visit-count maximum and applies the tightest one", () => {
    const result = assessRequirements(brief({
      hardConstraints: [
        { id: "constraint_minimum", type: "visit_count", dayIndex: 1, minimum: 5, maximum: 9 },
        { id: "constraint_maximum", type: "visit_count", dayIndex: 1, minimum: null, maximum: 6 },
        { id: "constraint_cap-loose", type: "max_visits", dayIndex: 1, count: 8 },
        { id: "constraint_cap-tight", type: "max_visits", dayIndex: 1, count: 4 },
      ],
    }), context);

    expect(rules(result).filter(rule => rule === "density.conflict")).toHaveLength(1);
  });

  it.each(["must_visit", "start", "end"] as const)(
    "does not treat a syntactically resolved %s reference as grounded",
    role => {
      const referenceId = `reference_${role.replace("_", "-")}`;
      const references = [{
        id: referenceId,
        role,
        query: "Unbacked place",
        status: "resolved" as const,
        placeId: "place_unbacked",
        candidates: [],
        dayIndex: role === "must_visit" ? null : 1,
      }];
      const boundaries = role === "must_visit" ? [] : [{
        dayIndex: 1,
        startRequired: role === "start",
        startReferenceId: role === "start" ? referenceId : null,
        endRequired: role === "end",
        endReferenceId: role === "end" ? referenceId : null,
      }];

      const result = assessRequirements(brief({ references, boundaries }), context);
      expect(rules(result)).toContain(
        role === "must_visit" ? "must_visit.unresolved" : `boundary.${role}_unresolved`,
      );
    },
  );

  it("deep-freezes descendants even when their supplied parent is already frozen", () => {
    const candidate = { placeId: "place_beijing", label: "Beijing" };
    const candidates = [candidate];
    const destination = Object.freeze({
      query: "Beijing",
      status: "resolved" as const,
      candidates,
      cityId: "city_beijing",
      administrativeAreaIds: ["area_beijing"],
      timeZone: "Asia/Shanghai",
    });

    const parsed = brief({ destination });
    expect(Object.isFrozen(parsed.destination)).toBe(true);
    expect(Object.isFrozen(parsed.destination.candidates)).toBe(true);
    expect(Object.isFrozen(parsed.destination.candidates[0])).toBe(true);
    expect(Object.isFrozen(parsed.destination.administrativeAreaIds)).toBe(true);
  });
});
