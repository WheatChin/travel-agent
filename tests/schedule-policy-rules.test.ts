import { describe, expect, it } from "vitest";
import { scheduleInputSchema } from "../src/domain/canonical";
import { scheduleItinerary } from "../src/domain/schedule";
import { scheduleFixture } from "./schedule-fixtures";

describe("policy, admission and identity scheduling", () => {
  it("reserves one lunch and exactly one rest for three Visits", () => {
    const input = scheduleFixture();
    const third = { ...input.draft.days[0].visits[1], id: "visit_three", placeId: "place_three", evidenceIds: ["evidence_three"] };
    const context = scheduleInputSchema.parse({
      ...input,
      brief: { ...input.brief, dayWindows: [], durationOverrides: [...input.brief.durationOverrides, { placeId: "place_three", durationMinutes: 60 }] },
      draft: { ...input.draft, days: [{ ...input.draft.days[0], visits: [...input.draft.days[0].visits, third] }] },
      visitBindings: [...input.visitBindings, { visitId: "visit_three", candidateId: "candidate_three" }],
      candidateSet: { ...input.candidateSet, candidates: [...input.candidateSet.candidates, { ...input.candidateSet.candidates[1], id: "candidate_three", placeId: "place_three", evidenceIds: ["evidence_three"] }] },
      places: [...input.places, { ...input.places[1], id: "place_three", providerPlaceId: "three" }],
      evidence: [...input.evidence, { ...input.evidence[1], id: "evidence_three", placeId: "place_three" }],
      routes: [...input.routes, { ...input.routes[0], id: "route_two-three", fromPlaceId: "place_two", toPlaceId: "place_three" }],
      routeBindings: [...input.routeBindings, { segmentId: "leg_two-to-three", routeFactId: "route_two-three" }],
    });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    const blocks = result.itinerary.days[0].scheduleBlocks;
    expect(blocks.filter(value => value.kind === "rest").map(value => [value.startMinute, value.endMinute])).toEqual([[700, 715]]);
    expect(blocks.filter(value => value.kind === "meal").map(value => [value.startMinute, value.endMinute])).toEqual([[720, 765]]);
    expect(result.itinerary.days[0].visits[2].startMinute).toBe(795);
  });

  it("requires an explicit lunch change for a conflicting fixed Visit", () => {
    const input = scheduleFixture();
    const brief = { ...input.brief, dayWindows: [], hardConstraints: [{ id: "constraint_fixed", type: "fixed_visit_start", visitId: "visit_two", dayIndex: 1, startMinute: 730 }] };
    const context = scheduleInputSchema.parse({ ...input, brief });
    const failed = scheduleItinerary(context);
    expect(failed.status).toBe("blocked");
    expect(failed.report.issues.some(issue => issue.code === "schedule.fixed_break_conflict")).toBe(true);
    const accepted = scheduleInputSchema.parse({ ...context, brief: { ...context.brief, acceptedPolicyOverrides: [{
      id: "override_lunch", origin: "owner", dayIndex: 1, settings: { lunch: { enabled: false, startMinute: 720, durationMinutes: 45 } },
    }] } });
    expect(scheduleItinerary(accepted).status).toBe("scheduled");
  });

  it("keeps disjoint openings and inclusive latest entry", () => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({
      ...input, brief: { ...input.brief, dayWindows: [{ dayIndex: 1, startMinute: 540, endMinute: 720 }] },
      evidence: [input.evidence[0], { ...input.evidence[1], value: [{ startMinute: 630, endMinute: 635 }, { startMinute: 650, endMinute: 720 }] },
        { ...input.evidence[1], id: "evidence_latest", field: "latest_entry", value: 660 }],
    });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    expect(result.itinerary.days[0].visits[1].startMinute).toBe(660);
    expect(result.itinerary.days[0].visits[1].endMinute).toBe(720);
    expect(result.itinerary.days[0].scheduleBlocks.some(block => block.kind === "wait" && block.startMinute === 630 && block.endMinute === 650)).toBe(true);
    const closed = scheduleInputSchema.parse({ ...context, evidence: context.evidence.map(fact => fact.id === "evidence_latest" ? { ...fact, value: 659 } : fact) });
    expect(scheduleItinerary(closed).status).toBe("blocked");
  });

  it("creates an exact zero identity start transfer without provider metadata", () => {
    const input = scheduleFixture();
    const context = scheduleInputSchema.parse({ ...input, brief: { ...input.brief,
      references: [{ id: "reference_start", role: "start", query: "First attraction", status: "resolved", placeId: "place_one", candidates: [], dayIndex: 1 }],
      boundaries: [{ dayIndex: 1, startRequired: true, startReferenceId: "reference_start", endRequired: false, endReferenceId: null }],
    } });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    const route = result.itinerary.days[0].boundaryTransfers[0].route;
    expect(route).toMatchObject({ temporalBasis: "identity", freshness: "current", durationMinutes: 0, provider: null, retrievedAt: null, geometry: null, sourceKind: "code_identity" });
    expect(result.itinerary.days[0].visits[0].startMinute).toBe(550);
  });

  it("blocks unknown walking components under a hard cap but only warns otherwise", () => {
    const input = scheduleFixture();
    const unknown = scheduleInputSchema.parse({ ...input, routes: [{ ...input.routes[0], geometry: null, walking: { durationMinutes: null, distanceMeters: null, longestSegmentMinutes: null } }] });
    expect(scheduleItinerary(unknown).report.degraded).toBe(true);
    const hard = scheduleInputSchema.parse({ ...unknown, brief: { ...unknown.brief, hardConstraints: [{ id: "constraint_walk", type: "max_walking", durationMinutes: 60, distanceMeters: 5000 }] } });
    const result = scheduleItinerary(hard);
    expect(result.status).toBe("blocked");
    expect(result.report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["walking.hard_minutes", "walking.hard_distance"]));
  });

  it("uses Owner duration above sourced recommendation but cannot waive a required minimum", () => {
    const input = scheduleFixture();
    const evidence = { ...input.evidence[0], id: "evidence_stay", field: "stay_duration", value: 90 };
    const option = { id: "duration_one", placeId: "place_one", evidenceId: evidence.id, evidenceRevision: 1, durationMinutes: 90, status: "usable", requiredMinimum: false, entryCoverage: { status: "included", includedMinutes: 10 } };
    const context = scheduleInputSchema.parse({ ...input,
      evidence: [...input.evidence, evidence], durationOptions: [option],
      candidateSet: { ...input.candidateSet, candidates: input.candidateSet.candidates.map((value, index) => index ? value : { ...value, evidenceIds: [...value.evidenceIds, evidence.id], durationOptionIds: [option.id] }) },
    });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    expect(result.itinerary.days[0].visits[0].durationMinutes).toBe(60);
    expect(result.itinerary.days[0].visits[0].durationOrigin.origin).toBe("owner");
    const required = scheduleInputSchema.parse({ ...context, durationOptions: [{ ...option, requiredMinimum: true }] });
    expect(scheduleItinerary(required).report.issues.some(issue => issue.code === "duration.required_minimum")).toBe(true);
  });
});
