import { describe, expect, it } from "vitest";
import { scheduleItinerary } from "../src/domain/schedule";
import { scheduleFixture } from "./schedule-fixtures";

describe("bounded forward scheduling", () => {
  it("matches the approved 160-minute morning fixture exactly", () => {
    const result = scheduleItinerary(scheduleFixture());
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    expect(result.itinerary.days[0].visits.map(visit => [visit.startMinute, visit.endMinute])).toEqual([[550, 610], [640, 700]]);
    expect(result.itinerary.days[0].scheduleBlocks.reduce((total, block) => total + block.endMinute - block.startMinute, 0)).toBe(160);
    expect(result.report.commitEligible).toBe(true);
    expect(result.report.issues.map(issue => issue.code)).toContain("policy.lunch_omitted");
    expect(result.itinerary.days[0].scheduleBlocks.some(block => block.kind === "rest")).toBe(false);
    expect(scheduleItinerary(scheduleFixture())).toEqual(result);
  });
});
