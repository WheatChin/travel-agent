import { describe, expect, it } from "vitest";
import { scheduleInputSchema, type ScheduleInput } from "../src/domain/canonical";
import { scheduleItinerary } from "../src/domain/schedule";
import { validateItinerary } from "../src/domain/validation";
import { scheduleFixture } from "./schedule-fixtures";

function boundaries(endMinute = 1080): ScheduleInput {
  const input = scheduleFixture();
  return scheduleInputSchema.parse({
    ...input,
    brief: { ...input.brief, dayWindows: [{ dayIndex: 1, startMinute: 840, endMinute }],
      references: [
        { id: "reference_start", role: "start", query: "Synthetic start", status: "resolved", placeId: "place_start", candidates: [], dayIndex: 1 },
        { id: "reference_end", role: "end", query: "Synthetic end", status: "resolved", placeId: "place_end", candidates: [], dayIndex: 1 },
      ],
      boundaries: [{ dayIndex: 1, startRequired: true, endRequired: true, startReferenceId: "reference_start", endReferenceId: "reference_end" }],
    },
    places: [...input.places, ...["start", "end"].map(name => ({ ...input.places[0], id: `place_${name}`, providerPlaceId: name, name }))],
    routes: [input.routes[0],
      { ...input.routes[0], id: "route_start", fromPlaceId: "place_start", toPlaceId: "place_one", durationMinutes: 30, walking: { durationMinutes: 30, distanceMeters: 1000, longestSegmentMinutes: 30 } },
      { ...input.routes[0], id: "route_end", fromPlaceId: "place_two", toPlaceId: "place_end", durationMinutes: 40, walking: { durationMinutes: 40, distanceMeters: 1000, longestSegmentMinutes: 40 } },
    ],
    routeBindings: [...input.routeBindings, { segmentId: "boundary_one-start", routeFactId: "route_start" }, { segmentId: "boundary_one-end", routeFactId: "route_end" }],
  });
}

describe("approved finite numerical fixtures", () => {
  it("counts both boundary transfers once: 230 minutes and 17:50 finish", () => {
    const context = boundaries();
    const result = scheduleItinerary(context);
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    const day = result.itinerary.days[0];
    expect(day.visits.map(visit => [visit.startMinute, visit.endMinute])).toEqual([[880, 940], [970, 1030]]);
    expect(day.scheduleBlocks.at(-1)?.endMinute).toBe(1070);
    expect(day.scheduleBlocks.reduce((sum, block) => sum + block.endMinute - block.startMinute, 0)).toBe(230);
    expect(day.legs).toHaveLength(1);
    expect(day.boundaryTransfers).toHaveLength(2);
    expect(validateItinerary({ candidate: result.itinerary, context }).commitEligible).toBe(true);
  });

  it("rejects the same boundaries when the window ends at 17:30", () => {
    const result = scheduleItinerary(boundaries(1050));
    expect(result.status).toBe("blocked");
    expect(result.report.commitEligible).toBe(false);
  });

  it.each([
    { status: "included", includedMinutes: 5, total: 20 },
    { status: "included", includedMinutes: 2, total: 23 },
    { status: "included", includedMinutes: null, total: 20 },
    { status: "unknown", includedMinutes: null, total: 20 },
    { status: "excluded", includedMinutes: null, total: 25 },
  ])("counts transit coverage once: %j", ({ status, includedMinutes, total }) => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({ ...input,
      routes: [{ ...input.routes[0], mode: "public_transit", temporalBasis: "current_estimate", transferCoverage: { status, includedMinutes } }],
      dayModes: [{ dayId: "day_one", mode: "public_transit" }],
    });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    const day = result.itinerary.days[0];
    expect(day.visits[1].startMinute - day.visits[0].endMinute - 10).toBe(total);
    if (status === "unknown") expect(result.report.issues.some(issue => issue.code === "buffer.transfer_unknown")).toBe(true);
    if (total > 20) {
      const extra = day.scheduleBlocks.find(block => block.kind === "transfer_buffer")!;
      const corrupted = { ...result.itinerary, days: [{ ...day, scheduleBlocks: day.scheduleBlocks.map(block => block.id === extra.id ? { ...block, startMinute: day.visits[1].endMinute, endMinute: day.visits[1].endMinute + total - 20 } : block) }] };
      expect(validateItinerary({ candidate: corrupted, context }).issues.some(issue => issue.code === "route.buffer_order")).toBe(true);
    }
  });

  it("keeps unknown durations as a draft and aggregates independent admission failure", () => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({ ...input,
      routes: [{ ...input.routes[0], status: "unknown", durationMinutes: null }],
      evidence: input.evidence.map((fact, index) => index ? { ...fact, value: [] } : fact),
    });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("blocked");
    expect(result.report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["route.duration_missing", "admission.closed"]));
  });
});
