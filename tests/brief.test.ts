import { describe, expect, it } from "vitest";

import {
  assessRequirements,
  briefPatchSchema,
  briefStateSchema,
  reduceBrief,
  type BriefState,
  type RequirementContext,
} from "../src/domain";

const context: RequirementContext = {
  issueRevision: 4,
  supportedCityIds: ["city_beijing"],
  supportedTransportModes: ["walk", "public_transit"],
  lockedDayIndices: [3],
  resolvedPlaces: [],
};

const incompleteBrief: BriefState = briefStateSchema.parse({
  revision: 2,
  destination: { query: null, status: "missing", candidates: [] },
  requestedDayCount: null,
  startDate: null,
  endDate: null,
  exactDateVerificationRequired: true,
  references: [
    {
      id: "reference_palace",
      role: "must_visit",
      query: "Palace",
      status: "ambiguous",
      placeId: null,
      candidates: [
        { placeId: "place_summer-palace", label: "Summer Palace" },
        { placeId: "place_old-summer-palace", label: "Old Summer Palace" },
      ],
      dayIndex: null,
    },
  ],
  hardConstraints: [
    { id: "constraint_unknown", type: "unresolved", description: "Avoid strenuous climbs" },
    { id: "constraint_density", type: "visit_count", dayIndex: 1, minimum: 6, maximum: null },
    { id: "constraint_pace", type: "max_visits", dayIndex: 1, count: 3 },
  ],
  preferences: { pace: "relaxed", transportModes: ["walk"], interests: [], companions: null },
  dayWindows: [{ dayIndex: 1, startMinute: 540, endMinute: 1080 }],
  boundaries: [
    { dayIndex: 1, startRequired: true, startReferenceId: null, endRequired: false, endReferenceId: null },
  ],
  durationOverrides: [],
  allowedRepeatedPlaceIds: [],
  explicitlyFreeDayIndices: [],
  excludedPlaceIds: [],
  acceptedPolicyOverrides: [],
  assumptions: [],
});

describe("Brief contracts", () => {
  it("deeply freezes Brief and patch children even under readonly containers", () => {
    const value = { ...incompleteBrief, assumptions: [{ key: "modes", field: "transport", dayIndex: null, value: ["walk"], policyVersion: "schedule-mvp-v1", ownerOverridden: false }] };
    const parsed = briefStateSchema.parse(value);
    const patch = briefPatchSchema.parse({ assumptions: { operation: "set", value: value.assumptions } });
    expect(Object.isFrozen(parsed.destination)).toBe(true);
    expect(Object.isFrozen(parsed.hardConstraints[0])).toBe(true);
    expect(Object.isFrozen(parsed.assumptions[0].value)).toBe(true);
    expect(Object.isFrozen(patch.assumptions)).toBe(true);
    if (patch.assumptions?.operation === "set") expect(Object.isFrozen(patch.assumptions.value[0].value)).toBe(true);
  });
  it("accepts incomplete states but rejects unknown fields and malformed IDs", () => {
    expect(briefStateSchema.safeParse(incompleteBrief).success).toBe(true);
    expect(briefStateSchema.safeParse({ ...incompleteBrief, ownerId: "owner_forged" }).success).toBe(false);
    expect(
      briefStateSchema.safeParse({
        ...incompleteBrief,
        hardConstraints: [{ id: "bad", type: "unresolved", description: "Anything" }],
      }).success,
    ).toBe(false);
  });

  it("distinguishes absent, cleared, and explicit patch values without assigning a revision", () => {
    const patch = briefPatchSchema.parse({
      destination: { operation: "set", value: { query: "Beijing", status: "unresolved", candidates: [] } },
      startDate: { operation: "clear" },
    });

    const reduced = reduceBrief(incompleteBrief, patch);

    expect(reduced.conflicts).toEqual([]);
    expect(reduced.brief.revision).toBe(2);
    expect(reduced.brief.destination.query).toBe("Beijing");
    expect(reduced.brief.startDate).toBeNull();
    expect(reduced.brief.endDate).toBeNull();
  });

  it("does not persist a derived end date into the Owner's incomplete Brief", () => {
    const reduced = reduceBrief(incompleteBrief, briefPatchSchema.parse({
      requestedDayCount: { operation: "set", value: 3 },
      startDate: { operation: "set", value: "2026-10-31" },
    }));

    expect(reduced.brief.endDate).toBeNull();
  });
});

describe("Requirement assessment", () => {
  it("blocks fixed and requested days removed by a known shorter duration", () => {
    const parsed = briefStateSchema.parse({
      ...incompleteBrief, requestedDayCount: 1,
      references: [{ id: "reference_museum", role: "must_visit", query: "Museum", status: "resolved", placeId: "place_museum", candidates: [], dayIndex: 2 }],
      hardConstraints: [{ id: "constraint_fixed", type: "fixed_visit_start", visitId: "visit_museum", dayIndex: 2, startMinute: 600 }],
    });
    const rules = assessRequirements(parsed, context).blockingIssues.map(issue => issue.rule);
    expect(rules).toEqual(expect.arrayContaining(["duration.locked_day_removed", "fixed_visit.day_removed", "reference.day_removed"]));
    const unknown = assessRequirements(briefStateSchema.parse({ ...parsed, requestedDayCount: null }), context).blockingIssues.map(issue => issue.rule);
    expect(unknown).not.toContain("fixed_visit.day_removed");
    expect(unknown).not.toContain("reference.day_removed");
  });

  it("keeps unsupported explicit date ranges visible even with a supported day count", () => {
    const parsed = briefStateSchema.parse({ ...incompleteBrief, startDate: "2026-01-01", endDate: "2026-01-08", requestedDayCount: 2 });
    expect(assessRequirements(parsed, context).blockingIssues.map(issue => issue.rule)).toEqual(expect.arrayContaining(["duration.unsupported", "dates.day_count_disagrees"]));
  });

  it("reports calendar overflow without throwing or changing the explicit Brief", () => {
    const parsed = briefStateSchema.parse({ ...incompleteBrief, startDate: "9999-12-31", requestedDayCount: 2 });
    expect(assessRequirements(parsed, context).blockingIssues.map(issue => issue.rule)).toContain("dates.unsupported_range");
    expect(parsed.endDate).toBeNull();
  });

  it("checks every window and fixed-time contradiction regardless of input order", () => {
    const hardConstraints = [
      { id: "constraint_wide", type: "allowed_day_window", dayIndex: 1, startMinute: 500, endMinute: 1000 },
      { id: "constraint_late", type: "allowed_day_window", dayIndex: 1, startMinute: 800, endMinute: 900 },
      { id: "constraint_early", type: "allowed_day_window", dayIndex: 1, startMinute: 600, endMinute: 700 },
      { id: "constraint_fixed", type: "fixed_visit_start", visitId: "visit_palace", dayIndex: 1, startMinute: 650 },
      { id: "constraint_other", type: "fixed_visit_start", visitId: "visit_palace", dayIndex: 2, startMinute: 650 },
    ];
    const input = { ...incompleteBrief, hardConstraints, dayWindows: [] };
    const result = assessRequirements(briefStateSchema.parse(input), context).blockingIssues;
    expect(result.map(issue => issue.rule)).toEqual(expect.arrayContaining(["day_window.conflict", "fixed_visit.outside_window", "fixed_visit.conflict"]));
    expect(assessRequirements(briefStateSchema.parse({ ...input, hardConstraints: [...hardConstraints].reverse() }), context).blockingIssues).toEqual(result);
  });

  it("checks fixed times against explicit Brief windows without inventing default windows", () => {
    const input = { ...incompleteBrief, hardConstraints: [{ id: "constraint_fixed", type: "fixed_visit_start", visitId: "visit_palace", dayIndex: 1, startMinute: 1080 }] };
    expect(assessRequirements(briefStateSchema.parse(input), context).blockingIssues.map(issue => issue.rule)).toContain("fixed_visit.outside_window");
    expect(assessRequirements(briefStateSchema.parse({ ...input, dayWindows: [] }), context).blockingIssues.map(issue => issue.rule)).not.toContain("fixed_visit.outside_window");
  });

  it.each([
    [{ id: "constraint_count", type: "visit_count", dayIndex: 1, minimum: 4, maximum: 3 }],
    [{ id: "constraint_min", type: "visit_count", dayIndex: 1, minimum: 4, maximum: 8 }, { id: "constraint_max", type: "visit_count", dayIndex: 1, minimum: null, maximum: 3 }],
    [{ id: "constraint_min", type: "visit_count", dayIndex: 1, minimum: 4, maximum: null }, { id: "constraint_loose", type: "max_visits", dayIndex: 1, count: 8 }, { id: "constraint_strict", type: "max_visits", dayIndex: 1, count: 3 }],
  ].map(hardConstraints => ({ hardConstraints })))("intersects all hard density bounds: $hardConstraints", ({ hardConstraints }) => {
    const parsed = briefStateSchema.parse({ ...incompleteBrief, hardConstraints, preferences: { ...incompleteBrief.preferences, pace: null } });
    expect(assessRequirements(parsed, context).blockingIssues.filter(issue => issue.rule === "density.conflict")).toHaveLength(1);
  });

  it("blocks requested references without backing facts even without boundary records", () => {
    const references = [
      { id: "reference_start", role: "start", query: "Hotel", status: "unresolved", placeId: null, candidates: [], dayIndex: 1 },
      { id: "reference_end", role: "end", query: "Station", status: "resolved", placeId: "place_station", candidates: [], dayIndex: 1 },
      { id: "reference_must", role: "must_visit", query: "Museum", status: "resolved", placeId: null, candidates: [], dayIndex: null },
    ];
    const parsed = briefStateSchema.parse({ ...incompleteBrief, references, boundaries: [], hardConstraints: [] });
    expect(assessRequirements(parsed, context).blockingIssues.map(issue => issue.rule)).toEqual(expect.arrayContaining(["boundary.start_unresolved", "boundary.end_unresolved", "must_visit.unresolved"]));
    const grounded = assessRequirements(parsed, { ...context, resolvedPlaces: [{ placeId: "place_station", administrativeAreaId: "area_beijing" }] });
    expect(grounded.blockingIssues.map(issue => issue.rule)).not.toContain("boundary.end_unresolved");
    expect(grounded.assumptions.some(assumption => assumption.field === "boundaries")).toBe(false);
  });

  it("does not accept boundary references bound to a different role or day", () => {
    const parsed = briefStateSchema.parse({
      ...incompleteBrief,
      references: [{ id: "reference_hotel", role: "end", query: "Hotel", status: "resolved", placeId: "place_hotel", candidates: [], dayIndex: 2 }],
      boundaries: [{ dayIndex: 1, startRequired: false, startReferenceId: "reference_hotel", endRequired: false, endReferenceId: null }],
    });
    expect(assessRequirements(parsed, { ...context, resolvedPlaces: [{ placeId: "place_hotel", administrativeAreaId: "area_beijing" }] }).blockingIssues.map(issue => issue.rule)).toContain("boundary.start_reference_mismatch");
  });
  it.each([
    ["2024-02-28", 3, "2024-03-01"],
    ["1900-02-28", 2, "1900-03-01"],
    ["2000-02-28", 3, "2000-03-01"],
    ["0099-12-31", 2, "0100-01-01"],
    ["2026-12-31", 2, "2027-01-01"],
  ])("uses bounded calendar dates from %s without persisting inference", (startDate, requestedDayCount, endDate) => {
    const reduced = reduceBrief(incompleteBrief, briefPatchSchema.parse({
      startDate: { operation: "set", value: startDate },
      requestedDayCount: { operation: "set", value: requestedDayCount },
    })).brief;
    expect(reduced.endDate).toBeNull();
    const assessment = assessRequirements(reduced, context);
    expect(assessment.effectiveEndDate).toBe(endDate);
    expect(assessment.blockingIssues.some(issue => issue.rule === "dates.required_for_exact_verification")).toBe(false);
    const explicit = briefStateSchema.parse({ ...reduced, endDate });
    expect(assessRequirements(explicit, context).blockingIssues.some(issue => issue.rule === "dates.day_count_disagrees")).toBe(false);
  });

  it("recomputes inferred dates after duration changes but preserves explicit end dates", () => {
    const initial = briefStateSchema.parse({ ...incompleteBrief, startDate: "2026-10-31", requestedDayCount: 3 });
    const patch = briefPatchSchema.parse({ requestedDayCount: { operation: "set", value: 2 } });
    const inferred = reduceBrief(initial, patch).brief;
    expect(inferred.endDate).toBeNull();
    expect(assessRequirements(inferred, context).effectiveEndDate).toBe("2026-11-01");
    const explicit = reduceBrief(briefStateSchema.parse({ ...initial, endDate: "2026-11-02" }), patch).brief;
    expect(explicit.endDate).toBe("2026-11-02");
    expect(assessRequirements(explicit, context).blockingIssues.map(issue => issue.rule)).toContain("dates.day_count_disagrees");
  });

  it.each([0, -1, 8, 1_000_000_000])("aggregates unsupported count %s without date expansion", requestedDayCount => {
    const reduced = reduceBrief(incompleteBrief, briefPatchSchema.parse({
      startDate: { operation: "set", value: "2026-01-01" },
      requestedDayCount: { operation: "set", value: requestedDayCount },
    })).brief;
    const assessment = assessRequirements(reduced, context);
    expect(assessment.effectiveEndDate).toBeNull();
    expect(assessment.blockingIssues.map(issue => issue.rule)).toEqual(expect.arrayContaining(["duration.unsupported", "destination.missing"]));
  });

  it("returns all independently identifiable AC-01 blockers together", () => {
    const assessment = assessRequirements(incompleteBrief, context);

    expect(assessment.blockingIssues.map((issue) => issue.rule)).toEqual([
      "boundary.start_missing",
      "dates.required_for_exact_verification",
      "destination.missing",
      "duration.missing",
      "density.conflict",
      "hard_constraint.unsupported",
      "must_visit.ambiguous",
    ]);
    expect(assessment.blockingIssues.every((issue) => issue.revision === 4)).toBe(true);
    expect(assessment.blockingIssues.find((issue) => issue.rule === "must_visit.ambiguous")?.options).toEqual([
      "Summer Palace",
      "Old Summer Palace",
    ]);
  });

  it("reports unsupported scope, transport, dates, exclusion, and locked shortening in one pass", () => {
    const brief = briefStateSchema.parse({
      ...incompleteBrief,
      destination: {
        query: "Shanghai",
        status: "resolved",
        candidates: [],
        cityId: "city_shanghai",
        administrativeAreaIds: ["area_shanghai"],
        timeZone: "Asia/Shanghai",
      },
      requestedDayCount: 2,
      startDate: "2026-10-05",
      endDate: "2026-10-03",
      exactDateVerificationRequired: false,
      references: [],
      hardConstraints: [
        { id: "constraint_must", type: "must_visit", placeId: "place_temple" },
        { id: "constraint_exclude", type: "excluded_place", placeId: "place_temple" },
        { id: "constraint_mode", type: "transport_modes", modes: ["drive"] },
      ],
      boundaries: [],
    });

    const assessment = assessRequirements(brief, {
      ...context,
      resolvedPlaces: [{ placeId: "place_temple", administrativeAreaId: "area_shanghai" }],
    });

    expect(assessment.blockingIssues.map((issue) => issue.rule)).toEqual([
      "dates.reversed",
      "destination.unsupported",
      "duration.locked_day_removed",
      "place.must_visit_excluded",
      "transport.unsupported",
    ]);
  });

  it("does not manufacture date, area, or density conflicts while prerequisites are unknown", () => {
    const brief = briefStateSchema.parse({
      ...incompleteBrief,
      exactDateVerificationRequired: false,
      references: [],
      hardConstraints: [{ id: "constraint_density", type: "visit_count", dayIndex: 1, minimum: 6, maximum: null }],
      boundaries: [],
    });

    expect(assessRequirements(brief, context).blockingIssues.map((issue) => issue.rule)).toEqual([
      "destination.missing",
      "duration.missing",
    ]);
  });

  it("aggregates date-count disagreement and a grounded Place outside the destination area", () => {
    const brief = briefStateSchema.parse({
      ...incompleteBrief,
      destination: { query: "Beijing", status: "resolved", candidates: [], cityId: "city_beijing", administrativeAreaIds: ["area_beijing"], timeZone: "Asia/Shanghai" },
      requestedDayCount: 2,
      startDate: "2026-10-01",
      endDate: "2026-10-03",
      exactDateVerificationRequired: false,
      references: [{ id: "reference_remote", role: "must_visit", query: "Remote", status: "resolved", placeId: "place_remote", candidates: [], dayIndex: null }],
      hardConstraints: [],
      boundaries: [],
    });

    const assessment = assessRequirements(brief, {
      ...context,
      lockedDayIndices: [],
      resolvedPlaces: [{ placeId: "place_remote", administrativeAreaId: "area_tianjin" }],
    });

    expect(assessment.blockingIssues.map((issue) => issue.rule)).toEqual([
      "dates.day_count_disagrees",
      "place.outside_allowed_area",
    ]);
  });
});
