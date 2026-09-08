import { describe, expect, it } from "vitest";
import { scheduleInputSchema, validateItinerary } from "../src/domain";
import { scheduleFixture, scheduledFixture } from "./schedule-fixtures";

describe("D2 independent validator cross-checks", () => {
  it("accepts the independently hand-authored arithmetic fixture", () => {
    expect(validateItinerary({ candidate: scheduledFixture(), context: scheduleFixture() })).toMatchObject({
      commitEligible: true,
      degraded: false,
    });
  });

  it("rejects ledger arithmetic tampering after schema validation", () => {
    const original = scheduledFixture();
    const day = original.days[0];
    const candidate = { ...original, days: [{
      ...day,
      visits: day.visits.map((visit, index) => index === 0
        ? { ...visit, endMinute: visit.endMinute + 1 }
        : visit),
    }] };
    const report = validateItinerary({ candidate, context: scheduleFixture() });
    expect(report.commitEligible).toBe(false);
    expect(report.issues.map(issue => issue.code)).toContain("ledger.visit");
  });

  it("rejects a non-numeric Visit clock at the strict schema boundary", () => {
    const original = scheduledFixture();
    const day = original.days[0];
    const candidate = { ...original, days: [{
      ...day,
      visits: day.visits.map((visit, index) => index === 0
        ? { ...visit, endMinute: "610" }
        : visit),
    }] };
    const report = validateItinerary({ candidate, context: scheduleFixture() });
    expect(report.commitEligible).toBe(false);
    expect(report.issues.map(issue => issue.code)).toContain("candidate.schema");
  });

  it("aggregates parsable endpoint, route-fact, and provenance tampering", () => {
    const original = scheduledFixture();
    const day = original.days[0];
    const candidate = { ...original, days: [{
      ...day,
      visits: day.visits.map((visit, index) => index === 0 ? {
        ...visit,
        durationOrigin: { ...visit.durationOrigin, origin: "policy" as const, policyKey: "stayMinutes" },
      } : visit),
      legs: day.legs.map(leg => ({
        ...leg,
        fromVisitId: leg.toVisitId,
        toVisitId: leg.fromVisitId,
        route: { ...leg.route, durationMinutes: leg.route.durationMinutes! + 1 },
      })),
    }] };

    const report = validateItinerary({ candidate, context: scheduleFixture() });
    expect(report.commitEligible).toBe(false);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      "visit.duration_provenance",
      "route.fact_binding",
      "route.endpoints",
    ]));
  });

  it("rejects a fabricated extra block even when its interval is finite", () => {
    const original = scheduledFixture();
    const day = original.days[0];
    const candidate = { ...original, days: [{
      ...day,
      scheduleBlocks: [...day.scheduleBlocks, {
        ...day.scheduleBlocks[0],
        id: "block_fabricated",
        kind: "break" as const,
        startMinute: 700,
        endMinute: 710,
        visitId: null,
        legId: null,
        boundaryTransferId: null,
        origin: "derived" as const,
        policyKey: null,
      }],
    }] };
    const report = validateItinerary({ candidate, context: scheduleFixture() });
    expect(report.commitEligible).toBe(false);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      "ledger.extra_block",
    ]));
  });

  it("warns for absent geometry while duration and walking facts remain provable", () => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({ ...input, routes: [{ ...input.routes[0], geometry: null }] });
    const original = scheduledFixture();
    const day = original.days[0];
    const candidate = { ...original, days: [{
      ...day,
      legs: day.legs.map(leg => ({ ...leg, route: context.routes[0] })),
    }] };
    const report = validateItinerary({ candidate, context });
    expect(report.commitEligible).toBe(true);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "route.geometry_distance_missing",
      severity: "WARNING",
    }));
  });

  it("blocks unknown walking components when hard caps require proof", () => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({
      ...input,
      brief: { ...input.brief, hardConstraints: [{
        id: "constraint_walking-cap", type: "max_walking", durationMinutes: 60, distanceMeters: 5000,
      }] },
      routes: [{ ...input.routes[0], geometry: null, walking: {
        durationMinutes: null, distanceMeters: null, longestSegmentMinutes: null,
      } }],
    });
    const original = scheduledFixture();
    const day = original.days[0];
    const candidate = { ...original, days: [{
      ...day,
      legs: day.legs.map(leg => ({ ...leg, route: context.routes[0] })),
    }] };
    const report = validateItinerary({ candidate, context });
    expect(report.commitEligible).toBe(false);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      "walking.hard_minutes",
      "walking.hard_distance",
    ]));
  });
});
