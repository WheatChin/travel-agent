import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/domain/snapshot";
import { committedSnapshotFixture, scheduleFixture, scheduledFixture } from "./schedule-fixtures";
import { planTypedEdit, type EditContext } from "../src/domain/edits";
import { briefStateSchema } from "../src/domain/brief";

function fixture() {
  return {
    versionId: "version_new",
    committedAt: "2026-09-08T12:00:00+08:00",
    turn: {
      conversationId: "conversation_test", turnId: "turn_new",
      targetTripId: "trip_test", baseVersionId: null, baseBriefRevision: 1,
      input: { type: "user_message" as const, text: "Plan this trip" },
    },
    context: scheduleFixture(),
    candidate: scheduledFixture(),
  };
}

describe("snapshot construction", () => {
  it("freezes supplied identities and facts after independent validation", () => {
    const result = buildSnapshot(fixture());
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.snapshot.id).toBe("version_new");
    expect(result.snapshot.turnId).toBe("turn_new");
    expect(result.snapshot.briefRevision).toBe(1);
    expect(result.commandBrief).toBeUndefined();
    expect(result.snapshot.evidenceIds).toEqual(["evidence_one", "evidence_two"]);
    expect(Object.isFrozen(result.snapshot.itinerary.days[0].visits[0])).toBe(true);
  });

  it("rejects a corrupted Visit clock even though the candidate schema accepts it", () => {
    const input = fixture();
    const day = input.candidate.days[0];
    const candidate = { ...input.candidate, days: [{
      ...day, visits: day.visits.map((visit, index) => index === 0
        ? { ...visit, endMinute: 609 } : visit),
    }] };
    expect(buildSnapshot({ ...input, candidate }).status).toBe("rejected");
  });

  it("does not accept a command Brief through a natural-language Turn", () => {
    const input = fixture();
    const result = buildSnapshot({ ...input, commandBrief: { ...input.context.brief, revision: 2 } });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.report.issues.map(value => value.code)).toContain("snapshot.unexpected_command");
  });

  it("rejects a mismatched accepted Brief revision", () => {
    const input = fixture();
    expect(buildSnapshot({ ...input, turn: { ...input.turn, baseBriefRevision: 2 } }).status).toBe("rejected");
  });

  it("rejects conflicting exact Visit duration bindings without rejecting legacy Place overrides", () => {
    const brief = scheduleFixture().brief;
    expect(briefStateSchema.safeParse(brief).success).toBe(true);
    expect(briefStateSchema.safeParse({ ...brief, durationOverrides: [
      { placeId: "place_one", visitId: "visit_one", durationMinutes: 30 },
      { placeId: "place_one", visitId: "visit_one", durationMinutes: 45 },
    ] }).success).toBe(false);
    expect(briefStateSchema.safeParse({ ...brief, durationOverrides: [
      { placeId: "place_one", visitId: "visit_one", durationMinutes: 30 },
      { placeId: "place_two", visitId: "visit_one", durationMinutes: 30 },
    ] }).success).toBe(false);
  });

  it("returns a tentative command Brief only with its exact validated snapshot", () => {
    const supplied = scheduleFixture();
    const base = committedSnapshotFixture();
    const editContext: EditContext = {
      turn: {
        conversationId: base.conversationId, turnId: "turn_remove",
        targetTripId: base.tripId, baseVersionId: base.id, baseBriefRevision: 1,
        input: { type: "remove_visit", visitId: "visit_two" },
      },
      newVisitId: null,
      schedule: {
        ...supplied, base,
        draft: { ...supplied.draft, runId: "run_remove", baseVersionId: base.id },
        candidateSet: { ...supplied.candidateSet, runId: "run_remove", baseVersionId: base.id },
        scope: { kind: "local", dayIds: ["day_one"] },
      },
    };
    const plan = planTypedEdit(base, { type: "remove_visit", visitId: "visit_two" }, editContext);
    expect(plan.status).toBe("candidate");
    if (plan.status !== "candidate") return;
    const input = {
      versionId: "version_removed", committedAt: "2026-09-08T12:00:00+08:00",
      turn: editContext.turn, editContext, context: plan.scheduleInput,
      candidate: plan.itinerary, commandBrief: plan.commandBrief ?? undefined,
    };
    const result = buildSnapshot(input);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.snapshot.briefRevision).toBe(2);
    expect(result.commandBrief?.excludedPlaceIds).toEqual(["place_two"]);
    expect(result.snapshot.brief).toEqual(result.commandBrief);
    expect(editContext.turn.baseBriefRevision).toBe(1);
    expect(buildSnapshot({ ...input, commandBrief: undefined }).status).toBe("rejected");
  });
});
