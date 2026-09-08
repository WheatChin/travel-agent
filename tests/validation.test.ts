import { describe, expect, it } from "vitest";
import { validateItinerary } from "../src/domain/validation";
import { committedSnapshotFixture, scheduledFixture, scheduleFixture } from "./schedule-fixtures";

describe("independent candidate validation", () => {
  it("rejects malformed candidates without trusting their reported eligibility", () => {
    const result = validateItinerary({ candidate: { commitEligible: true }, context: scheduleFixture() });
    expect(result.commitEligible).toBe(false);
    expect(result.issues.some(issue => issue.code === "candidate.schema")).toBe(true);
  });

  it("independently rejects clock, provenance and missing-route corruption together", () => {
    const context = scheduleFixture();
    const scheduled = scheduledFixture();
    const day = scheduled.days[0];
    const candidate = { ...scheduled, days: [{ ...day, legs: [], visits: day.visits.map((visit, index) => index ? visit : {
      ...visit, startMinute: 551, durationOrigin: { ...visit.durationOrigin, origin: "policy", policyKey: "stayMinutes" },
    }) }] };
    const result = validateItinerary({ candidate, context });
    expect(result.commitEligible).toBe(false);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      "visit.duration_provenance", "ledger.visit", "route.segment_set",
    ]));
  });

  it("rejects extra ledger blocks even when they do not overlap", () => {
    const context = scheduleFixture();
    const scheduled = scheduledFixture();
    const day = scheduled.days[0];
    const candidate = { ...scheduled, days: [{ ...day, scheduleBlocks: [...day.scheduleBlocks, {
      ...day.scheduleBlocks[0], id: "block_extra", startMinute: 700, endMinute: 710,
    }] }] };
    expect(validateItinerary({ candidate, context }).commitEligible).toBe(false);
  });

  it("accepts independently composed exact arithmetic and snapshot fixtures", () => {
    const context = scheduleFixture();
    expect(validateItinerary({ candidate: scheduledFixture(), context }).commitEligible).toBe(true);
    expect(validateItinerary({ candidate: committedSnapshotFixture().itinerary, context }).commitEligible).toBe(true);
  });
});
