import { describe, expect, it } from "vitest";
import { planTypedEdit, type EditContext } from "../src/domain/edits";
import { committedItinerarySnapshotSchema, scheduleInputSchema } from "../src/domain/canonical";
import { validateItinerary } from "../src/domain/validation";
import { scheduleItinerary } from "../src/domain/schedule";
import { buildSnapshot } from "../src/domain/snapshot";
import { committedSnapshotFixture, scheduleFixture } from "./schedule-fixtures";
import { type TypedCommand } from "../src/domain/contracts";

export function editFixture(): EditContext {
  const base = committedSnapshotFixture();
  const input = scheduleFixture();
  return {
    turn: { conversationId: base.conversationId, turnId: "turn_edit", targetTripId: base.tripId, baseVersionId: base.id, baseBriefRevision: 1, input: { type: "remove_visit", visitId: "visit_two" } },
    schedule: scheduleInputSchema.parse({ ...input, base,
      draft: { ...input.draft, runId: "run_edit", baseVersionId: base.id },
      candidateSet: { ...input.candidateSet, runId: "run_edit", baseVersionId: base.id },
      scope: { kind: "local", dayIds: ["day_one"] },
    }),
    newVisitId: null,
  };
}

describe("deterministic Typed Commands", () => {
  it("removes and excludes tentatively, without mutating the accepted Brief", () => {
    const context = editFixture();
    const base = context.schedule.base!;
    const result = planTypedEdit(base, { type: "remove_visit", visitId: "visit_two" }, context);
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") return;
    expect(result.commandBrief?.revision).toBe(2);
    expect(result.commandBrief?.excludedPlaceIds).toEqual(["place_two"]);
    expect(result.itinerary.days[0].visits.map(value => value.id)).toEqual(["visit_one"]);
    expect(base.brief.revision).toBe(1);
    expect(base.brief.excludedPlaceIds).toEqual([]);
  });

  it("interprets move index after removal and recognizes unchanged order", () => {
    const context = editFixture();
    const command: TypedCommand = { type: "move_visit", visitId: "visit_one", toDayId: "day_one", toIndex: 0 };
    const result = planTypedEdit(context.schedule.base!, command, { ...context, turn: { ...context.turn, input: command } });
    expect(result).toEqual({ status: "no_op", versionId: "version_test" });
  });

  it("rejects an insertion beyond the remaining destination length", () => {
    const context = editFixture();
    const command: TypedCommand = { type: "move_visit", visitId: "visit_one", toDayId: "day_one", toIndex: 2 };
    const result = planTypedEdit(context.schedule.base!, command, { ...context, turn: { ...context.turn, input: command } });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.report.issues.map(value => value.code)).toContain("edit.index");
  });

  it("requests supplied route facts for a changed transport mode", () => {
    const context = editFixture();
    const command: TypedCommand = { type: "update_day_transport_mode", dayId: "day_one", mode: "public_transit" };
    const result = planTypedEdit(context.schedule.base!, command, { ...context, turn: { ...context.turn, input: command } });
    expect(result.status).toBe("route_required");
    if (result.status !== "route_required") return;
    expect(result.routeRequirements).toEqual([expect.objectContaining({
      dayId: "day_one", fromPlaceId: "place_one", toPlaceId: "place_two", mode: "public_transit",
    })]);
    expect(result.changedDayIds).toEqual(["day_one"]);
  });

  it.each(["cancel_run", "retry_run"] as const)("dispatches %s without producing an itinerary", type => {
    const context = editFixture();
    const command: TypedCommand = { type, runId: "run_previous" };
    expect(planTypedEdit(context.schedule.base!, command, { ...context, turn: { ...context.turn, input: command } }))
      .toEqual({ status: "control_dispatch", command });
  });

  it("does not treat a newer pending Brief as successful no-change", () => {
    const context = editFixture();
    const command: TypedCommand = { type: "update_visit_duration", visitId: "visit_one", durationMinutes: 60 };
    const result = planTypedEdit(context.schedule.base!, command, {
      ...context,
      turn: { ...context.turn, baseBriefRevision: 2, input: command },
      schedule: { ...context.schedule, brief: { ...context.schedule.brief, revision: 2 } },
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.report.issues.map(value => value.code)).toContain("edit.pending_requirements");
  });

  it("changes only the requested lock metadata without rebuilding the ledger", () => {
    const context = editFixture();
    const command: TypedCommand = { type: "set_visit_lock", visitId: "visit_one", locked: true };
    const base = context.schedule.base!;
    const result = planTypedEdit(base, command, { ...context, turn: { ...context.turn, input: command } });
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") return;
    const day = base.itinerary.days[0];
    expect(result.itinerary.days).toEqual([{
      ...day, visits: day.visits.map(visit => visit.id === "visit_one" ? { ...visit, locked: true } : visit),
    }]);
    expect(result.commandBrief).toBeNull();
  });

  it("explicitly unlocks a historical Visit with stale routes but rejects implicit unlock", () => {
    const original = editFixture();
    const old = original.schedule.base!;
    const route = { ...old.routes[0], freshness: "stale" };
    const base = committedItinerarySnapshotSchema.parse({
      ...old, routes: [route],
      itinerary: { ...old.itinerary, days: old.itinerary.days.map(day => ({
        ...day, legs: day.legs.map(leg => ({ ...leg, route })),
        visits: day.visits.map(visit => ({ ...visit, locked: visit.id === "visit_one" })),
      })) },
    });
    const command: TypedCommand = { type: "set_visit_lock", visitId: "visit_one", locked: false };
    const context = {
      ...original, turn: { ...original.turn, input: command },
      schedule: { ...original.schedule, base, routes: base.routes },
    };
    const result = planTypedEdit(base, command, context);
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") return;
    expect(result.itinerary.days[0].visits[0].locked).toBe(false);
    expect(result.itinerary.days[0].scheduleBlocks).toEqual(base.itinerary.days[0].scheduleBlocks);
    const { typedCommand: _command, ...unauthorized } = result.scheduleInput;
    expect(validateItinerary({ candidate: result.itinerary, context: unauthorized }).commitEligible).toBe(false);
    const day = result.itinerary.days[0];
    expect(validateItinerary({
      context: result.scheduleInput,
      candidate: { ...result.itinerary, days: [{ ...day, visits: day.visits.map((visit, index) => index === 1 ? { ...visit, locked: true } : visit) }] },
    }).commitEligible).toBe(false);
  });

  it("changes one repeated Place Visit without changing the other stay", () => {
    const original = scheduleFixture();
    const input = scheduleInputSchema.parse({
      ...original,
      brief: { ...original.brief, allowedRepeatedPlaceIds: ["place_one"] },
      draft: { ...original.draft, days: [{ ...original.draft.days[0],
        visits: original.draft.days[0].visits.map(visit => ({ ...visit, placeId: "place_one", evidenceIds: ["evidence_one"] })),
      }] },
      visitBindings: [{ visitId: "visit_one", candidateId: "candidate_one" }, { visitId: "visit_two", candidateId: "candidate_one" }],
      routes: [], routeBindings: [],
    });
    const scheduled = scheduleItinerary(input);
    expect(scheduled.status).toBe("scheduled");
    if (scheduled.status !== "scheduled") return;
    const frozen = buildSnapshot({
      versionId: "version_repeated", committedAt: "2026-09-08T12:00:00+08:00",
      turn: { conversationId: "conversation_test", turnId: "turn_test", targetTripId: "trip_test",
        baseVersionId: null, baseBriefRevision: 1, input: { type: "user_message", text: "Repeat this Place" } },
      context: input, candidate: scheduled.itinerary,
    });
    expect(frozen.status).toBe("ready");
    if (frozen.status !== "ready") return;
    const base = frozen.snapshot;
    const command: TypedCommand = { type: "update_visit_duration", visitId: "visit_one", durationMinutes: 30 };
    const context: EditContext = {
      newVisitId: null,
      turn: { conversationId: base.conversationId, turnId: "turn_edit", targetTripId: base.tripId,
        baseVersionId: base.id, baseBriefRevision: 1, input: command },
      schedule: { ...input, base, routes: base.routes,
        draft: { ...input.draft, runId: "run_edit", baseVersionId: base.id },
        candidateSet: { ...input.candidateSet, runId: "run_edit", baseVersionId: base.id },
        scope: { kind: "local", dayIds: ["day_one"] },
      },
    };
    const result = planTypedEdit(base, command, context);
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") return;
    expect(result.itinerary.days[0].visits.map(visit => visit.durationMinutes)).toEqual([30, 60]);
    expect(result.commandBrief?.durationOverrides).toContainEqual({ placeId: "place_one", visitId: "visit_one", durationMinutes: 30 });
    expect(result.commandBrief?.durationOverrides).toContainEqual({ placeId: "place_one", durationMinutes: 60 });
    expect(result.itinerary.days[0].visits[1].durationOrigin).toEqual(base.itinerary.days[0].visits[1].durationOrigin);
    const mismatch = { ...result.scheduleInput, brief: { ...result.scheduleInput.brief,
      durationOverrides: [{ placeId: "place_two", visitId: "visit_one", durationMinutes: 30 }],
    } };
    expect(validateItinerary({ candidate: result.itinerary, context: mismatch }).commitEligible).toBe(false);
  });

  it.each(["policy", "evidence"] as const)("preserves %s stay provenance while moving an unlocked Visit", origin => {
    const original = scheduleFixture();
    const evidence = { ...original.evidence[0], id: "evidence_stay", field: "stay_duration", value: 45 };
    const option = {
      id: "duration_stay", placeId: "place_one", evidenceId: "evidence_stay", evidenceRevision: 1,
      durationMinutes: 45, status: "usable", requiredMinimum: false,
      entryCoverage: { status: "excluded", includedMinutes: null },
    };
    const input = scheduleInputSchema.parse({
      ...original,
      brief: { ...original.brief, durationOverrides: [], dayWindows: [{ dayIndex: 1, startMinute: 540, endMinute: 1000 }] },
      evidence: origin === "evidence" ? [...original.evidence, evidence] : original.evidence,
      durationOptions: origin === "evidence" ? [option] : [],
      candidateSet: { ...original.candidateSet, candidates: original.candidateSet.candidates.map(candidate =>
        origin === "evidence" && candidate.id === "candidate_one"
          ? { ...candidate, evidenceIds: [...candidate.evidenceIds, "evidence_stay"], durationOptionIds: ["duration_stay"] } : candidate) },
    });
    const scheduled = scheduleItinerary(input);
    expect(scheduled.status).toBe("scheduled");
    if (scheduled.status !== "scheduled") return;
    const frozen = buildSnapshot({
      versionId: "version_move", committedAt: "2026-09-08T12:00:00+08:00",
      turn: { conversationId: "conversation_test", turnId: "turn_test", targetTripId: "trip_test",
        baseVersionId: null, baseBriefRevision: 1, input: { type: "user_message", text: "Plan" } },
      context: input, candidate: scheduled.itinerary,
    });
    expect(frozen.status).toBe("ready");
    if (frozen.status !== "ready") return;
    const base = frozen.snapshot;
    const command: TypedCommand = { type: "move_visit", visitId: "visit_one", toDayId: "day_one", toIndex: 1 };
    const reverse = { ...input.routes[0], id: "route_reverse", fromPlaceId: "place_two", toPlaceId: "place_one",
      geometry: { ...input.routes[0].geometry!, path: [...input.routes[0].geometry!.path].reverse() } };
    const context: EditContext = {
      newVisitId: null,
      turn: { conversationId: base.conversationId, turnId: "turn_edit", targetTripId: base.tripId,
        baseVersionId: base.id, baseBriefRevision: 1, input: command },
      schedule: { ...input, base, routes: [...input.routes, reverse],
        routeBindings: [{ segmentId: "leg_two-to-one", routeFactId: "route_reverse" }],
        draft: { ...input.draft, runId: "run_edit", baseVersionId: base.id },
        candidateSet: { ...input.candidateSet, runId: "run_edit", baseVersionId: base.id },
        scope: { kind: "local", dayIds: ["day_one"] },
      },
    };
    const result = planTypedEdit(base, command, context);
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") return;
    expect(result.itinerary.days[0].visits.map(visit => visit.id)).toEqual(["visit_two", "visit_one"]);
    const moved = result.itinerary.days[0].visits[1];
    expect(moved.durationMinutes).toBe(origin === "policy" ? 90 : 45);
    expect(moved.durationOrigin).toEqual(base.itinerary.days[0].visits[0].durationOrigin);
    expect(moved.durationOrigin.origin).toBe(origin);
    const day = result.itinerary.days[0];
    expect(validateItinerary({
      context: result.scheduleInput,
      candidate: { ...result.itinerary, days: [{ ...day, visits: day.visits.map(visit =>
        visit.id === "visit_one" ? { ...visit, durationMinutes: 20 } : visit) }] },
    }).commitEligible).toBe(false);
  });
});
