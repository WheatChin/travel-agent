import { describe, expect, it } from "vitest";
import { routeFactSchema, scheduleInputSchema } from "../src/domain/canonical";
import { scheduleItinerary } from "../src/domain/schedule";
import { validateItinerary } from "../src/domain/validation";
import { scheduleFixture, scheduledFixture } from "./schedule-fixtures";

describe("explicit route temporal authority", () => {
  it.each(["stale", "unknown"] as const)("requires rerouting for %s facts in new planning", freshness => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({ ...input, routes: [{ ...input.routes[0], freshness }] });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("route_required");
    expect(result.report.commitEligible).toBe(false);
    expect(result.report.issues.some(issue => issue.code === "route.freshness")).toBe(true);
    const itinerary = scheduledFixture();
    const candidate = { ...itinerary, days: itinerary.days.map(day => ({ ...day, legs: day.legs.map(leg => ({ ...leg, route: context.routes[0] })) })) };
    expect(validateItinerary({ candidate, context }).commitEligible).toBe(false);
  });

  it("permits a current estimate only with an explicit degraded warning", () => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({ ...input, routes: [{
      ...input.routes[0], temporalBasis: "current_estimate", applicability: { date: null, departureWindow: null },
    }] });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("scheduled");
    expect(result.report.degraded).toBe(true);
    expect(result.report.issues.some(issue => issue.code === "route.current_estimate" && issue.severity === "WARNING")).toBe(true);
  });

  it("requires an actual date and departure window for a departure estimate", () => {
    const route = scheduleFixture().routes[0];
    expect(routeFactSchema.safeParse({ ...route, temporalBasis: "departure_estimate" }).success).toBe(false);
    expect(routeFactSchema.safeParse({ ...route, temporalBasis: "time_independent", mode: "public_transit" }).success).toBe(false);
    expect(routeFactSchema.safeParse({ ...route, temporalBasis: undefined }).success).toBe(false);
    expect(routeFactSchema.safeParse({ ...route, freshness: undefined }).success).toBe(false);
  });

  it.each([
    { date: "2026-10-01", departureWindow: { startMinute: 610, endMinute: 611 }, expected: "scheduled" },
    { date: "2026-10-01", departureWindow: { startMinute: 600, endMinute: 610 }, expected: "route_required" },
    { date: "2026-10-02", departureWindow: { startMinute: 610, endMinute: 611 }, expected: "route_required" },
  ])("matches exact departure applicability %j", ({ date, departureWindow, expected }) => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({ ...input, routes: [{
      ...input.routes[0], temporalBasis: "departure_estimate", applicability: { date, departureWindow },
    }] });
    expect(scheduleItinerary(context).status).toBe(expected);
  });
});
