// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { RepositoryError, openRepository, type TripRepository, type RunClaim } from "@/server/repository";
import type { TurnInput } from "@/domain/contracts";
import type { BriefState, CommittedItinerarySnapshot } from "@/domain";
import { committedSnapshotFixture, scheduleFixture } from "./schedule-fixtures";

const repositories: TripRepository[] = [];
const directories: string[] = [];

async function databasePath() {
  const directory = await mkdtemp(path.join(tmpdir(), "travel-agent-repository-"));
  directories.push(directory);
  return path.join(directory, "travel.sqlite");
}

function brief(revision = 1): BriefState {
  return { ...scheduleFixture().brief, revision };
}

function snapshot(ids: { tripId: string; conversationId: string; turnId: string; runId: string }): CommittedItinerarySnapshot {
  const fixture = committedSnapshotFixture();
  return {
    ...fixture, id: "version_one", ...ids,
    committedAt: "2026-09-08T00:00:00.000Z",
    itinerary: {
      ...fixture.itinerary, tripId: ids.tripId, runId: ids.runId,
    },
  };
}

function advanceRun(repository: TripRepository, credential: string, claim: RunClaim,
  states: readonly ("checking_requirements" | "ready" | "drafting" | "validating")[]) {
  for (const state of states) {
    repository.checkpointRun(credential, { ...claim, state, checkpoint: { state }, repairCount: 1,
      attemptCounts: { routing: 1 }, operationIds: { routing: "operation_saved" },
      event: { type: "run.started", versionId: null, message: state } });
  }
}

async function noChangeScenario(now = () => new Date("2026-09-08T00:00:00.000Z"),
  input: TurnInput["input"] = { type: "update_day_transport_mode", dayId: "day_one", mode: "walk" }) {
  const dbPath = await databasePath();
  const repository = openRepository({ path: dbPath, now });
  const second = openRepository({ path: dbPath, now });
  repositories.push(repository, second);
  const { credential } = repository.createOwner();
  const conversation = repository.createConversation(credential);
  const generation = repository.acceptTurn(credential, { kind: "mutation", brief: brief(),
    turn: { conversationId: conversation.id, turnId: "turn_seed", targetTripId: null, baseVersionId: null,
      baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } } });
  const generationClaim = repository.claimRun(credential, generation.runId!, "seed");
  advanceRun(repository, credential, generationClaim, ["checking_requirements", "ready", "drafting", "validating"]);
  const base = snapshot({ tripId: generation.tripId, conversationId: conversation.id, turnId: generation.turnId, runId: generation.runId! });
  repository.commitVersion(credential, { ...generationClaim, snapshot: base });
  const turn: TurnInput = { conversationId: conversation.id, turnId: "turn_no-change",
    targetTripId: generation.tripId, baseVersionId: base.id, baseBriefRevision: 1,
    input };
  const accepted = repository.acceptTurn(credential, { kind: "mutation", turn });
  const worker = repository.trustedWorker();
  const handle = worker.listRecoverableRuns().find(item => item.runId === accepted.runId)!;
  const claim = worker.claimRun(handle, "no_change", 1_000);
  advanceRun(repository, credential, claim, ["checking_requirements", "ready"]);
  return { dbPath, repository, second, credential, conversation, accepted, claim, worker, base, turn, generationClaim };
}

async function commandScenario(operation: "remove" | "duration",
  now = () => new Date("2026-09-08T00:00:00.000Z")) {
  const scenario = await noChangeScenario(now, operation === "remove"
    ? { type: "remove_visit", visitId: "visit_two" }
    : { type: "update_visit_duration", visitId: "visit_two", durationMinutes: 50 });
  const { repository, credential, claim, base, accepted } = scenario;
  advanceRun(repository, credential, claim, ["drafting", "validating"]);
  const commandBrief: BriefState = { ...base.brief, revision: 2,
    durationOverrides: operation === "remove"
      ? base.brief.durationOverrides.filter(item => item.placeId !== "place_two")
      : base.brief.durationOverrides.map(item => item.placeId === "place_two" ? { ...item, durationMinutes: 50 } : item),
    excludedPlaceIds: operation === "remove" ? ["place_two"] : [],
  };
  // Independent edits to the 160-minute fixture: remove the last stay/leg, or shorten it by ten minutes.
  const proposed: CommittedItinerarySnapshot = { ...base, id: "version_command",
    runId: accepted.runId!, turnId: accepted.turnId, baseVersionId: base.id,
    mutationOrigin: "typed_command", briefRevision: 2, brief: commandBrief,
    itinerary: { ...base.itinerary, runId: accepted.runId!, baseVersionId: base.id, briefRevision: 2,
      days: base.itinerary.days.map(day => ({ ...day,
        visits: operation === "remove" ? day.visits.slice(0, 1)
          : day.visits.map(visit => visit.id === "visit_two" ? { ...visit, durationMinutes: 50, endMinute: 690 } : visit),
        legs: operation === "remove" ? [] : day.legs,
        scheduleBlocks: operation === "remove" ? day.scheduleBlocks.slice(0, 2)
          : day.scheduleBlocks.map(block => block.kind === "visit" && block.visitId === "visit_two"
            ? { ...block, endMinute: 690 } : block),
      })) },
  };
  return { ...scenario, commandBrief, proposed };
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Trip Repository", () => {
  test("reconstructs an accepted Typed Command after restart without the browser credential", async () => {
    const now = () => new Date("2026-09-08T00:00:00.000Z");
    const { repository, second, credential, dbPath, turn } = await noChangeScenario(now);
    const input: TurnInput = { ...turn, turnId: "turn_accepted-recovery",
      input: { type: "update_visit_duration", visitId: "visit_two", durationMinutes: 50 } };
    const accepted = repository.acceptTurn(credential, { kind: "mutation", turn: input });
    repository.close();
    second.close();
    const reopened = openRepository({ path: dbPath, now });
    repositories.push(reopened);
    const recovery = reopened.trustedWorker();
    const handle = recovery.listRecoverableRuns().find(item => item.runId === accepted.runId)!;
    const claim = recovery.claimRun(handle, "accepted_recovery");
    expect(recovery.getRunExecution(claim).state).toBe("accepted");
    expect(recovery.getRunInput(claim)).toEqual(input);
  });

  test("rolls back a proposed Brief when immutable version insertion fails after the Brief write", async () => {
    const { repository, second, credential, accepted, claim, base, proposed, commandBrief } = await commandScenario("duration");
    const foreign = repository.createOwner();
    const conversation = repository.createConversation(foreign.credential);
    const generation = repository.acceptTurn(foreign.credential, { kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_foreign-version", targetTripId: null,
        baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } } });
    const foreignClaim = repository.claimRun(foreign.credential, generation.runId!, "foreign");
    advanceRun(repository, foreign.credential, foreignClaim, ["checking_requirements", "ready", "drafting", "validating"]);
    const foreignVersion = { ...snapshot({ tripId: generation.tripId, conversationId: conversation.id,
      turnId: generation.turnId, runId: generation.runId! }), id: proposed.id };
    repository.commitVersion(foreign.credential, { ...foreignClaim, snapshot: foreignVersion });
    const before = second.getTrip(credential, accepted.tripId);
    const events = second.listEvents(credential, accepted.runId!);
    expect(() => repository.commitVersion(credential, { ...claim, snapshot: proposed, commandBrief })).toThrow();
    expect(second.getTrip(credential, accepted.tripId)).toEqual(before);
    expect(second.listBriefRevisions(credential, accepted.tripId)).toEqual([base.brief]);
    expect(second.listVersions(credential, accepted.tripId)).toEqual([base]);
    expect(second.getRun(credential, accepted.runId!).state).toBe("validating");
    expect(second.getTurn(credential, accepted.conversationId, accepted.turnId)).toEqual(accepted);
    expect(second.listEvents(credential, accepted.runId!)).toEqual(events);
    expect(second.getVersion(foreign.credential, foreignVersion.id)).toEqual(foreignVersion);
    const retried = { ...proposed, id: "version_after-rollback" };
    expect(second.commitVersion(credential, { ...claim, snapshot: retried, commandBrief })).toEqual(retried);
    expect(repository.listBriefRevisions(credential, accepted.tripId)).toEqual([base.brief, commandBrief]);
  });

  test("recovers exact Run input after reopen only through live Run-bound worker claims", async () => {
    let clock = new Date("2026-09-08T00:00:00.000Z");
    const now = () => clock;
    const { repository, second, dbPath, credential, accepted, worker, claim, turn, base } = await noChangeScenario(now);
    expect(worker.getRunInput(claim)).toEqual(turn);
    expect(worker.getRunInput(claim)).not.toBe(worker.getRunInput(claim));
    expect(() => worker.getRunInput({ ...claim }))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => second.trustedWorker().getRunInput(claim))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    clock = new Date("2026-09-08T00:00:02.000Z");
    expect(() => worker.getRunInput(claim)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    repository.close();
    second.close();
    const reopened = openRepository({ path: dbPath, now });
    const otherConnection = openRepository({ path: dbPath, now });
    repositories.push(reopened, otherConnection);
    const recovery = reopened.trustedWorker();
    const handle = recovery.listRecoverableRuns().find(item => item.runId === accepted.runId)!;
    const recovered = recovery.claimRun(handle, "recovered", 1_000);
    expect(recovery.getRunInput(recovered)).toEqual(turn);
    expect(() => recovery.getRunInput(claim)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    const otherOwner = reopened.createOwner();
    const otherConversation = reopened.createConversation(otherOwner.credential);
    const foreignTurn: TurnInput = { conversationId: otherConversation.id, turnId: turn.turnId,
      targetTripId: null, baseVersionId: null, baseBriefRevision: 0,
      input: { type: "user_message", text: "Different Owner input" } };
    const foreign = reopened.acceptTurn(otherOwner.credential, { kind: "mutation", brief: brief(), turn: foreignTurn });
    const foreignHandle = recovery.listRecoverableRuns().find(item => item.runId === foreign.runId)!;
    const foreignClaim = recovery.claimRun(foreignHandle, "foreign");
    expect(recovery.getRunInput(foreignClaim)).toEqual(foreignTurn);
    expect(() => recovery.getRunInput({ ...recovered, runId: foreign.runId! }))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(recovery.getRunInput(recovered)).toEqual(turn);
    clock = new Date("2026-09-08T00:00:04.000Z");
    const takeover = otherConnection.trustedWorker();
    const takeoverHandle = takeover.listRecoverableRuns().find(item => item.runId === accepted.runId)!;
    const current = takeover.claimRun(takeoverHandle, "takeover");
    expect(() => recovery.getRunInput(recovered)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(takeover.getRunInput(current)).toEqual(turn);
    takeover.completeNoChange(current, base.id);
    expect(() => takeover.getRunInput(current)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(reopened.getTurn(credential, accepted.conversationId, accepted.turnId)).toMatchObject({ noChange: true });
  });

  test.each(["remove", "duration"] as const)("atomically commits the %s command Brief and binds replay to its proposal", async (operation) => {
    const now = () => new Date("2026-09-08T00:00:00.000Z");
    const { repository, second, dbPath, credential, accepted, worker, claim, base, proposed, commandBrief } =
      await commandScenario(operation, now);
    expect(second.getTrip(credential, accepted.tripId).brief).toEqual(base.brief);
    expect(worker.commitVersion(claim, proposed, commandBrief)).toEqual(proposed);
    expect(second.getTrip(credential, accepted.tripId)).toMatchObject({ brief: commandBrief,
      briefRevision: 2, currentVersionId: proposed.id });
    expect(second.listBriefRevisions(credential, accepted.tripId)).toEqual([base.brief, commandBrief]);
    expect(second.getRunExecution(credential, accepted.runId!)).toMatchObject({
      state: "completed", baseBriefRevision: 1, repairCount: 1, attemptCounts: { routing: 1 },
    });
    expect(second.getVersion(credential, base.id)).toEqual(base);
    expect(second.getTurn(credential, accepted.conversationId, accepted.turnId)).toEqual({ ...accepted, versionId: proposed.id });
    const later = second.acceptTurn(credential, { kind: "mutation", brief: { ...commandBrief, revision: 3 },
      turn: { conversationId: accepted.conversationId, turnId: "turn_later-requirements",
        targetTripId: accepted.tripId, baseVersionId: proposed.id, baseBriefRevision: 2,
        input: { type: "user_message", text: "Next requirements" } } });
    repository.close();
    second.close();
    const reopened = openRepository({ path: dbPath, now });
    repositories.push(reopened);
    expect(reopened.commitVersion(credential, { ...claim, snapshot: proposed, commandBrief })).toEqual(proposed);
    expect(() => reopened.commitVersion(credential, { ...claim, snapshot: proposed }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() => reopened.commitVersion(credential, { ...claim, snapshot: proposed,
      commandBrief: { ...commandBrief, preferences: { ...commandBrief.preferences, interests: ["different"] } } }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(reopened.listBriefRevisions(credential, accepted.tripId)).toHaveLength(3);
    expect(reopened.listEvents(credential, accepted.runId!, 5)).toHaveLength(1);
    expect(reopened.getRun(credential, later.runId!).state).toBe("accepted");
    expect(reopened.getTrip(credential, accepted.tripId).briefRevision).toBe(3);
  });

  test.each(["mutation", "read"] as const)("rejects a supplied Typed Command Brief on %s acceptance without superseding work", async (kind) => {
    const { repository, second, credential, accepted, claim, worker, base, turn } = await noChangeScenario();
    const before = second.getTrip(credential, accepted.tripId);
    const events = second.listEvents(credential, accepted.runId!);
    expect(() => repository.acceptTurn(credential, { kind, brief: brief(2),
      turn: { ...turn, turnId: "turn_rejected-brief" } }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(second.getTrip(credential, accepted.tripId)).toEqual(before);
    expect(second.listBriefRevisions(credential, accepted.tripId)).toEqual([brief()]);
    expect(second.listEvents(credential, accepted.runId!)).toEqual(events);
    expect(() => second.getTurn(credential, accepted.conversationId, "turn_rejected-brief"))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(worker.completeNoChange(claim, base.id)).toMatchObject({ noChange: true });
  });

  test.each(["cancelled", "failed", "superseded", "wrong_revision", "different_brief", "wrong_base", "invalid_snapshot"] as const)(
    "does not persist a command proposal on %s commit", async (failure) => {
      const { repository, second, credential, accepted, worker, claim, base, commandBrief, proposed, turn } =
        await commandScenario("remove");
      let candidate = proposed;
      let proposal = commandBrief;
      if (failure === "cancelled") second.cancelRun(credential, accepted.runId!, "Cancelled");
      if (failure === "failed") repository.checkpointRun(credential, { ...claim, state: "failed", repairCount: 1,
        checkpoint: {}, event: { type: "run.failed", versionId: base.id, code: "VALIDATION", message: "Rejected" } });
      if (failure === "superseded") second.acceptTurn(credential, { kind: "mutation",
        turn: { ...turn, turnId: "turn_superseding-command" } });
      if (failure === "wrong_revision") {
        proposal = { ...commandBrief, revision: 3 };
        candidate = { ...proposed, brief: proposal, briefRevision: 3,
          itinerary: { ...proposed.itinerary, briefRevision: 3 } };
      }
      if (failure === "different_brief") proposal = { ...commandBrief,
        preferences: { ...commandBrief.preferences, interests: ["different"] } };
      if (failure === "wrong_base") candidate = { ...proposed, baseVersionId: "version_stale",
        itinerary: { ...proposed.itinerary, baseVersionId: "version_stale" } };
      if (failure === "invalid_snapshot") candidate = { ...proposed, evidence: [] };
      const before = second.getTrip(credential, accepted.tripId);
      const events = second.listEvents(credential, accepted.runId!);
      expect(() => worker.commitVersion(claim, candidate, proposal)).toThrow();
      expect(second.getTrip(credential, accepted.tripId)).toEqual(before);
      expect(second.listBriefRevisions(credential, accepted.tripId)).toEqual([base.brief]);
      expect(second.listVersions(credential, accepted.tripId)).toEqual([base]);
      expect(second.listEvents(credential, accepted.runId!)).toEqual(events);
      expect(second.getTurn(credential, accepted.conversationId, accepted.turnId)).toEqual(accepted);
    },
  );

  test("requires full persisted Brief equality when no command proposal is supplied", async () => {
    const { repository, second, credential, accepted, worker, claim, base } = await commandScenario("duration");
    const candidate: CommittedItinerarySnapshot = { ...base, id: "version_without-proposal",
      runId: accepted.runId!, turnId: accepted.turnId, baseVersionId: base.id, mutationOrigin: "typed_command",
      brief: { ...base.brief, preferences: { ...base.brief.preferences, interests: ["unaccepted"] } },
      itinerary: { ...base.itinerary, runId: accepted.runId!, baseVersionId: base.id } };
    expect(() => repository.commitVersion(credential, { ...claim, snapshot: candidate }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(second.getTrip(credential, accepted.tripId).brief).toEqual(base.brief);
    const unchangedBrief = { ...candidate, brief: base.brief };
    expect(worker.commitVersion(claim, unchangedBrief)).toEqual(unchangedBrief);
    expect(() => repository.commitVersion(credential, { ...claim, snapshot: unchangedBrief, commandBrief: base.brief }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(second.listBriefRevisions(credential, accepted.tripId)).toEqual([base.brief]);
  });

  test.each(["generation", "natural_language_revision"] as const)("rejects commandBrief for %s", async (origin) => {
    const { repository, second, credential, conversation, base, turn } = await noChangeScenario();
    const target = origin === "generation" ? repository.createConversation(credential) : conversation;
    const accepted = repository.acceptTurn(credential, { kind: "mutation",
      ...(origin === "generation" ? { brief: brief() } : {}),
      turn: { ...turn, conversationId: target.id, turnId: "turn_not-command",
        targetTripId: origin === "generation" ? null : turn.targetTripId,
        baseVersionId: origin === "generation" ? null : base.id,
        baseBriefRevision: origin === "generation" ? 0 : 1,
        input: { type: "user_message", text: "Plan" } } });
    const claim = repository.claimRun(credential, accepted.runId!, "not_command");
    advanceRun(repository, credential, claim, ["checking_requirements", "ready", "drafting", "validating"]);
    const proposal = brief(2);
    const seed = snapshot({ tripId: accepted.tripId, conversationId: target.id, turnId: accepted.turnId, runId: accepted.runId! });
    const candidate = { ...seed, id: "version_not-command", mutationOrigin: origin, brief: proposal, briefRevision: 2,
      baseVersionId: origin === "generation" ? null : base.id,
      itinerary: { ...seed.itinerary, briefRevision: 2, baseVersionId: origin === "generation" ? null : base.id } };
    expect(() => repository.commitVersion(credential, { ...claim, snapshot: candidate, commandBrief: proposal }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(second.getTrip(credential, accepted.tripId).brief).toEqual(brief());
    expect(second.listBriefRevisions(credential, accepted.tripId)).toHaveLength(1);
  });

  test.each(["run.no_change", "itinerary.completed", "run.degraded"] as const)(
    "cannot publish %s through a checkpoint without the dedicated completion transaction", async (type) => {
      const { repository, second, credential, accepted, claim, worker, base } = await noChangeScenario();
      const before = second.getRunExecution(credential, accepted.runId!);
      const events = second.listEvents(credential, accepted.runId!);
      const request = { state: "ready" as const, checkpoint: { forgedCompletion: true }, repairCount: 1,
        event: { type, versionId: base.id, message: "Itinerary unchanged",
          ...(type === "run.degraded" ? { warnings: ["Route geometry unavailable"] } : {}) } };
      expect(() => repository.checkpointRun(credential, { ...claim, ...request }))
        .toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
      expect(() => worker.checkpointRun(claim, request))
        .toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
      expect(second.getRunExecution(credential, accepted.runId!)).toEqual(before);
      expect(second.listEvents(credential, accepted.runId!)).toEqual(events);
      expect(second.getTurn(credential, accepted.conversationId, accepted.turnId)).toEqual(accepted);
      expect(worker.completeNoChange(claim, base.id)).toMatchObject({ noChange: true, versionId: base.id });
    },
  );

  test("completes a ready Typed Command without changing its immutable version, Brief, or consumed budgets", async () => {
    const { repository, second, credential, accepted, claim, worker, base } = await noChangeScenario();
    const before = repository.getTrip(credential, accepted.tripId);
    const outcome = repository.completeNoChange(credential, { ...claim, versionId: base.id });
    expect(outcome).toEqual({ ...accepted, noChange: true, versionId: base.id });
    expect(second.getTurn(credential, accepted.conversationId, accepted.turnId)).toEqual(outcome);
    expect(second.getRunExecution(credential, accepted.runId!)).toMatchObject({
      state: "completed", repairCount: 1, attemptCounts: { routing: 1 }, operationIds: { routing: "operation_saved" },
    });
    expect(second.getTrip(credential, accepted.tripId)).toEqual(before);
    expect(second.listVersions(credential, accepted.tripId)).toEqual([base]);
    expect(second.listBriefRevisions(credential, accepted.tripId)).toEqual([brief()]);
    expect(second.listEvents(credential, accepted.runId!, 3)).toEqual([
      expect.objectContaining({ type: "run.no_change", sequence: 4, runId: accepted.runId,
        turnId: accepted.turnId, versionId: base.id, message: "Itinerary unchanged" }),
    ]);
    expect(worker.completeNoChange(claim, base.id)).toEqual({ ...outcome, replayed: true });
    expect(second.completeNoChange(credential, { ...claim, versionId: base.id })).toEqual({ ...outcome, replayed: true });
    expect(second.listEvents(credential, accepted.runId!)).toHaveLength(4);
    expect(() => worker.renewLease(claim)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
  });

  test("replays no-change after reopen and a later version advances without emitting another event", async () => {
    const now = () => new Date("2026-09-08T00:00:00.000Z");
    const { dbPath, repository, second, credential, accepted, claim, worker, base, turn, generationClaim } = await noChangeScenario(now);
    const outcome = worker.completeNoChange(claim, base.id);
    const later = second.acceptTurn(credential, { kind: "mutation", turn: {
      ...turn, turnId: "turn_later", input: { type: "user_message", text: "Revise the itinerary" },
    } });
    const laterClaim = second.claimRun(credential, later.runId!, "later");
    advanceRun(second, credential, laterClaim, ["checking_requirements", "ready", "drafting", "validating"]);
    const next: CommittedItinerarySnapshot = {
      ...base, id: "version_two", turnId: later.turnId, runId: later.runId!, baseVersionId: base.id,
      mutationOrigin: "natural_language_revision",
      itinerary: { ...base.itinerary, runId: later.runId!, baseVersionId: base.id },
    };
    second.commitVersion(credential, { ...laterClaim, snapshot: next });
    repository.close();
    second.close();
    const reopened = openRepository({ path: dbPath, now });
    repositories.push(reopened);
    expect(reopened.completeNoChange(credential, { ...claim, versionId: base.id })).toEqual({ ...outcome, replayed: true });
    expect(reopened.acceptTurn(credential, { kind: "mutation", turn })).toEqual({ ...outcome, replayed: true });
    expect(reopened.getTrip(credential, accepted.tripId).currentVersionId).toBe(next.id);
    expect(reopened.listVersions(credential, accepted.tripId)).toHaveLength(2);
    expect(reopened.listEvents(credential, accepted.runId!)).toHaveLength(4);
    expect(() => reopened.completeNoChange(credential, { ...claim, versionId: next.id }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() => reopened.completeNoChange(credential, { ...generationClaim, versionId: base.id }))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
  });

  test("denies foreign Owners and copied worker claims before returning a saved no-change result", async () => {
    const { repository, credential, accepted, claim, worker, base } = await noChangeScenario();
    const stranger = repository.createOwner();
    expect(() => repository.completeNoChange(stranger.credential, { ...claim, versionId: base.id }))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => worker.completeNoChange({ ...claim }, base.id))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    worker.completeNoChange(claim, base.id);
    expect(() => repository.completeNoChange(stranger.credential, { ...claim, versionId: base.id }))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => repository.completeNoChange("invalid", { ...claim, versionId: base.id }))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(repository.listEvents(credential, accepted.runId!)).toHaveLength(4);
  });

  test("fences stale no-change executors across two connections and lets the current worker finish", async () => {
    let clock = new Date("2026-09-08T00:00:00.000Z");
    const { repository, second, credential, accepted, claim, worker, base } = await noChangeScenario(() => clock);
    clock = new Date("2026-09-08T00:00:02.000Z");
    const recovery = second.trustedWorker();
    const [handle] = recovery.listRecoverableRuns();
    const current = recovery.claimRun(handle!, "recovery");
    expect(() => worker.completeNoChange(claim, base.id))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(() => repository.completeNoChange(credential, { ...claim, versionId: base.id }))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(second.listEvents(credential, accepted.runId!)).toHaveLength(3);
    expect(recovery.completeNoChange(current, base.id)).toMatchObject({ noChange: true, versionId: base.id });
  });

  test("rejects no-change for a mismatched base, a cancelled Run, or a superseded mutation", async () => {
    const { repository, second, credential, accepted, claim, worker, base, turn } = await noChangeScenario();
    expect(() => worker.completeNoChange(claim, "version_not-current"))
      .toThrowError(expect.objectContaining({ code: "STALE_VERSION" }));
    expect(repository.getRun(credential, accepted.runId!).state).toBe("ready");
    second.cancelRun(credential, accepted.runId!, "Cancelled");
    expect(() => worker.completeNoChange(claim, base.id))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(repository.getTrip(credential, accepted.tripId).currentVersionId).toBe(base.id);
    const stale = repository.acceptTurn(credential, { kind: "mutation", turn: { ...turn, turnId: "turn_stale-no-change" } });
    const staleClaim = repository.claimRun(credential, stale.runId!, "stale");
    advanceRun(repository, credential, staleClaim, ["checking_requirements", "ready"]);
    const newer = second.acceptTurn(credential, { kind: "mutation", turn: { ...turn, turnId: "turn_superseding" } });
    const newerClaim = second.claimRun(credential, newer.runId!, "newer");
    advanceRun(second, credential, newerClaim, ["checking_requirements", "ready", "drafting", "validating"]);
    const next: CommittedItinerarySnapshot = {
      ...base, id: "version_newer", turnId: newer.turnId, runId: newer.runId!, baseVersionId: base.id,
      mutationOrigin: "typed_command",
      itinerary: { ...base.itinerary, runId: newer.runId!, baseVersionId: base.id },
    };
    second.commitVersion(credential, { ...newerClaim, snapshot: next });
    expect(() => repository.completeNoChange(credential, { ...staleClaim, versionId: base.id }))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(repository.listVersions(credential, accepted.tripId)).toHaveLength(2);
    expect(repository.getTrip(credential, accepted.tripId).currentVersionId).toBe(next.id);
    expect(repository.listEvents(credential, stale.runId!).at(-1)?.type).toBe("run.superseded");
  });

  test.each(["already_pending"] as const)(
    "rejects no-change when Brief changes are %s relative to the frozen version", async (mode) => {
      const { repository, credential, accepted, base, turn } = await noChangeScenario();
      if (mode === "already_pending") {
        repository.acceptTurn(credential, { kind: "mutation", brief: brief(2), turn: {
          ...turn, turnId: "turn_pending-brief", input: { type: "user_message", text: "Change requirements" },
        } });
      }
      const changed = repository.acceptTurn(credential, {
        kind: "mutation",
        turn: { ...turn, turnId: "turn_pending-command", baseBriefRevision: mode === "already_pending" ? 2 : 1 },
      });
      const claim = repository.claimRun(credential, changed.runId!, "pending");
      advanceRun(repository, credential, claim, ["checking_requirements", "ready"]);
      const before = repository.getTrip(credential, accepted.tripId);
      expect(() => repository.completeNoChange(credential, { ...claim, versionId: base.id }))
        .toThrowError(expect.objectContaining({ code: "STALE_BRIEF" }));
      expect(repository.getTrip(credential, accepted.tripId)).toEqual(before);
      expect(repository.getRun(credential, changed.runId!).state).toBe("ready");
      expect(repository.listEvents(credential, changed.runId!)).toHaveLength(3);
      expect(repository.listVersions(credential, accepted.tripId)).toEqual([base]);
    },
  );

  test.each(["natural_language", "initial_generation", "initial_command", "not_ready"] as const)(
    "rejects no-change for %s without saving a successful outcome", async (mode) => {
      const { repository, credential, claim: readyClaim, accepted: ready, base, turn } = await noChangeScenario();
      let accepted = ready;
      let claim = readyClaim;
      if (mode === "not_ready") {
        advanceRun(repository, credential, claim, ["drafting"]);
      } else {
        const conversation = mode === "initial_generation" || mode === "initial_command" ? repository.createConversation(credential) : null;
        if (mode === "initial_command") {
          expect(() => repository.acceptTurn(credential, { kind: "mutation", brief: brief(),
            turn: { ...turn, turnId: "turn_initial-command", conversationId: conversation!.id,
              targetTripId: null, baseVersionId: null, baseBriefRevision: 0 } }))
            .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
          expect(repository.listConversations(credential).find(item => item.id === conversation!.id)?.tripId).toBeNull();
          return;
        }
        accepted = repository.acceptTurn(credential, { kind: "mutation",
          ...(conversation ? { brief: brief() } : {}),
          turn: { ...turn, turnId: "turn_ineligible", conversationId: conversation?.id ?? turn.conversationId,
            targetTripId: conversation ? null : turn.targetTripId, baseVersionId: conversation ? null : base.id,
            baseBriefRevision: conversation ? 0 : 1,
            input: { type: "user_message", text: "Plan an itinerary" } },
        });
        claim = repository.claimRun(credential, accepted.runId!, "ineligible");
        advanceRun(repository, credential, claim, ["checking_requirements", "ready"]);
      }
      expect(() => repository.completeNoChange(credential, { ...claim, versionId: base.id }))
        .toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
      expect(repository.getTurn(credential, accepted.conversationId, accepted.turnId).noChange).toBeUndefined();
      expect(repository.listEvents(credential, accepted.runId!).some(event => event.type === "run.no_change")).toBe(false);
    },
  );

  test("an Owner credential survives reopening while another Owner cannot read its Conversation", async () => {
    const dbPath = await databasePath();
    const first = openRepository({ path: dbPath });
    repositories.push(first);
    const owner = first.createOwner();
    const stranger = first.createOwner();
    const conversation = first.createConversation(owner.credential);

    expect(owner.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.listConversations(owner.credential)).toEqual([conversation]);
    expect(() => first.getTrip(stranger.credential, "trip_missing")).toThrowError(
      expect.objectContaining<Partial<RepositoryError>>({ code: "NOT_FOUND" }),
    );

    first.close();
    repositories.splice(repositories.indexOf(first), 1);
    const reopened = openRepository({ path: dbPath });
    repositories.push(reopened);

    expect(reopened.listConversations(owner.credential)).toEqual([conversation]);
    expect(() => reopened.listConversations("not-a-credential")).toThrowError(
      expect.objectContaining<Partial<RepositoryError>>({ code: "UNAUTHORIZED" }),
    );
  });

  test("accepts an initial mutation atomically and replays only the identical canonical Turn", async () => {
    const dbPath = await databasePath();
    const repository = openRepository({ path: dbPath });
    repositories.push(repository);
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const tripBrief = brief();
    const turn: TurnInput = {
      conversationId: conversation.id,
      turnId: "turn_initial",
      targetTripId: null,
      baseVersionId: null,
      baseBriefRevision: 0,
      input: { type: "user_message", text: "Plan Beijing" },
    };

    const accepted = repository.acceptTurn(credential, { turn, kind: "mutation", brief: tripBrief });
    const replayed = repository.acceptTurn(credential, {
      kind: "read",
      brief: brief(-1),
      turn: { ...turn, input: { text: "Plan Beijing", type: "user_message" } },
    });

    expect(replayed).toEqual({ ...accepted, replayed: true });
    expect(repository.getTrip(credential, accepted.tripId)).toMatchObject({
      id: accepted.tripId,
      conversationId: conversation.id,
      briefRevision: 1,
      currentVersionId: null,
    });
    expect(repository.getRun(credential, accepted.runId!)).toMatchObject({
      state: "accepted",
      baseBriefRevision: 1,
    });
    expect(repository.listMessages(credential, conversation.id)).toHaveLength(1);

    expect(() =>
      repository.acceptTurn(credential, {
        turn: { ...turn, input: { type: "user_message", text: "Changed" } },
        kind: "mutation",
        brief: tripBrief,
      }),
    ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  test("a newer mutation durably supersedes active work while a read Turn does not", async () => {
    const dbPath = await databasePath();
    const repository = openRepository({ path: dbPath });
    repositories.push(repository);
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const first = repository.acceptTurn(credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_first", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "First" } },
    });
    const read = repository.acceptTurn(credential, {
      kind: "read",
      turn: { conversationId: conversation.id, turnId: "turn_read", targetTripId: first.tripId, baseVersionId: null, baseBriefRevision: 1, input: { type: "user_message", text: "Status?" } },
    });
    expect(read.runId).toBeNull();
    expect(repository.getRun(credential, first.runId!).state).toBe("accepted");

    const second = repository.acceptTurn(credential, {
      kind: "mutation",
      turn: { conversationId: conversation.id, turnId: "turn_second", targetTripId: first.tripId, baseVersionId: null, baseBriefRevision: 1, input: { type: "user_message", text: "Second" } },
    });
    expect(repository.getRun(credential, first.runId!).state).toBe("superseded");
    expect(repository.listEvents(credential, first.runId!).at(-1)).toMatchObject({ type: "run.superseded", replacementRunId: second.runId });
  });

  test("serializes initial Brief races across real connections without leaving a rejected Turn", async () => {
    const dbPath = await databasePath();
    const first = openRepository({ path: dbPath });
    const second = openRepository({ path: dbPath });
    repositories.push(first, second);
    const { credential } = first.createOwner();
    const conversation = first.createConversation(credential);
    const makeTurn = (turnId: string): TurnInput => ({
      conversationId: conversation.id,
      turnId,
      targetTripId: null,
      baseVersionId: null,
      baseBriefRevision: 0,
      input: { type: "user_message", text: turnId },
    });
    const tripBrief = brief();

    first.acceptTurn(credential, { turn: makeTurn("turn_winner"), kind: "mutation", brief: tripBrief });
    expect(() =>
      second.acceptTurn(credential, { turn: makeTurn("turn_loser"), kind: "mutation", brief: tripBrief }),
    ).toThrowError(expect.objectContaining({ code: "STALE_BRIEF" }));
    expect(() => second.getTurn(credential, conversation.id, "turn_loser")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  test("persists leases, fences stale executors, repair budgets, and events across reopen", async () => {
    const dbPath = await databasePath();
    let clock = new Date("2026-09-08T00:00:00.000Z");
    const now = () => clock;
    const repository = openRepository({ path: dbPath, now });
    repositories.push(repository);
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const accepted = repository.acceptTurn(credential, {
      kind: "mutation",
      brief: brief(),
      turn: {
        conversationId: conversation.id, turnId: "turn_lease", targetTripId: null,
        baseVersionId: null, baseBriefRevision: 0,
        input: { type: "user_message", text: "Plan" },
      },
    });
    const firstClaim = repository.claimRun(credential, accepted.runId!, "executor_first", 1_000);
    expect(() => repository.claimRun(credential, accepted.runId!, "executor_second", 1_000)).toThrowError(
      expect.objectContaining({ code: "LEASE_CONFLICT" }),
    );

    clock = new Date("2026-09-08T00:00:02.000Z");
    const secondClaim = repository.claimRun(credential, accepted.runId!, "executor_second", 5_000);
    expect(secondClaim.fencingToken).toBe(firstClaim.fencingToken + 1);
    expect(() => repository.checkpointRun(credential, {
      runId: accepted.runId!, executorId: "executor_first", fencingToken: firstClaim.fencingToken,
      state: "checking_requirements", checkpoint: { phase: "requirements" }, repairCount: 0,
      event: { type: "requirements.checked", versionId: null, blockingIssueCount: 0, assumptionCount: 0, warningCount: 0, message: "Requirements checked" },
    })).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));

    repository.checkpointRun(credential, {
      runId: accepted.runId!, executorId: "executor_second", fencingToken: secondClaim.fencingToken,
      state: "checking_requirements", checkpoint: { phase: "requirements" }, repairCount: 0,
      event: { type: "requirements.checked", versionId: null, blockingIssueCount: 0, assumptionCount: 0, warningCount: 0, message: "Requirements checked" },
    });
    repository.checkpointRun(credential, {
      runId: accepted.runId!, executorId: "executor_second", fencingToken: secondClaim.fencingToken,
      state: "ready", checkpoint: { phase: "ready" }, repairCount: 2,
      event: { type: "research.started", versionId: null, querySummary: "Beijing", message: "Research ready" },
    });
    expect(() => repository.checkpointRun(credential, {
      runId: accepted.runId!, executorId: "executor_second", fencingToken: secondClaim.fencingToken,
      state: "researching", checkpoint: {}, repairCount: 1,
      event: { type: "research.started", versionId: null, querySummary: "Beijing", message: "Researching" },
    })).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));

    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
    const reopened = openRepository({ path: dbPath, now });
    repositories.push(reopened);
    expect(reopened.getRunExecution(credential, accepted.runId!)).toMatchObject({ repairCount: 2, checkpoint: { phase: "ready" } });
    expect(reopened.listEvents(credential, accepted.runId!, 1).map((event) => event.sequence)).toEqual([2, 3]);
  });

  test("keeps cancellation and caches Owner-scoped and returns independent cache values", async () => {
    const dbPath = await databasePath();
    const repository = openRepository({ path: dbPath });
    repositories.push(repository);
    const owner = repository.createOwner();
    const stranger = repository.createOwner();
    const conversation = repository.createConversation(owner.credential);
    const accepted = repository.acceptTurn(owner.credential, {
      kind: "mutation",
      brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_cancel", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });

    expect(() => repository.cancelRun(stranger.credential, accepted.runId!, "stop")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    repository.cancelRun(owner.credential, accepted.runId!, "Owner cancelled");
    expect(repository.getRun(owner.credential, accepted.runId!).state).toBe("cancelled");

    repository.putCache(owner.credential, "places", "beijing", { values: [1] });
    const cached = repository.getCache<{ values: number[] }>(owner.credential, "places", "beijing")!;
    cached.values.push(2);
    expect(repository.getCache(owner.credential, "places", "beijing")).toEqual({ values: [1] });
    expect(repository.getCache(stranger.credential, "places", "beijing")).toBeNull();
  });

  test.each([false, true])("commits canonical-v2 atomically with degraded=%s and replays after delivery disconnect", async (degraded) => {
    const dbPath = await databasePath();
    const repository = openRepository({ path: dbPath, now: () => new Date("2026-09-08T00:00:00.000Z") });
    const second = openRepository({ path: dbPath, now: () => new Date("2026-09-08T00:00:00.000Z") });
    repositories.push(repository, second);
    const owner = repository.createOwner();
    const stranger = repository.createOwner();
    const conversation = repository.createConversation(owner.credential);
    const accepted = repository.acceptTurn(owner.credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_commit", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });
    const claim = repository.claimRun(owner.credential, accepted.runId!, "executor_commit");
    const checkpoint = (state: "checking_requirements" | "ready" | "drafting" | "validating") => repository.checkpointRun(owner.credential, {
      runId: accepted.runId!, executorId: claim.executorId, fencingToken: claim.fencingToken,
      state, checkpoint: { state }, repairCount: 0,
      event: { type: "run.started", versionId: null, message: state },
    });
    checkpoint("checking_requirements"); checkpoint("ready"); checkpoint("drafting"); checkpoint("validating");
    let committed = snapshot({ tripId: accepted.tripId, conversationId: conversation.id, turnId: accepted.turnId, runId: accepted.runId! });
    if (degraded) {
      const warning = { code: "route.geometry_missing", severity: "WARNING" as const, field: "routes",
        targetId: "leg_one-to-two", message: "Route geometry unavailable", disposition: "retry" as const,
        factIds: ["route_one-two"] };
      const routes = committed.routes.map(route => ({ ...route, geometry: null }));
      committed = { ...committed, routes, warnings: [warning],
        validationReport: { ...committed.validationReport, degraded: true,
          issues: [...committed.validationReport.issues, warning] },
        itinerary: { ...committed.itinerary, days: committed.itinerary.days.map(day => ({
          ...day, notices: [...day.notices, warning],
          legs: day.legs.map(leg => ({ ...leg, route: routes[0] })),
        })) },
      };
    }

    const missingTemporalBasis = structuredClone(committed);
    Reflect.deleteProperty(missingTemporalBasis.routes[0], "temporalBasis");
    expect(() => repository.commitVersion(owner.credential, { ...claim, snapshot: missingTemporalBasis })).toThrow();
    expect(second.listVersions(owner.credential, accepted.tripId)).toEqual([]);
    expect(second.getTrip(owner.credential, accepted.tripId).currentVersionId).toBeNull();
    expect(second.getRun(owner.credential, accepted.runId!).state).toBe("validating");
    expect(second.listEvents(owner.credential, accepted.runId!, 5)).toEqual([]);

    expect(repository.commitVersion(owner.credential, { ...claim, snapshot: committed })).toEqual(committed);
    expect(second.commitVersion(owner.credential, { ...claim, snapshot: committed })).toEqual(committed);
    expect(second.getVersion(owner.credential, committed.id)).toEqual(committed);
    expect(second.getTrip(owner.credential, accepted.tripId).currentVersionId).toBe(committed.id);
    expect(second.getRun(owner.credential, accepted.runId!).state).toBe(degraded ? "degraded" : "completed");
    expect(second.listEvents(owner.credential, accepted.runId!, 5)).toEqual([
      expect.objectContaining({ type: degraded ? "run.degraded" : "itinerary.completed", versionId: committed.id,
        ...(degraded ? { warnings: ["Route geometry unavailable"] } : {}) }),
    ]);
    expect(second.getEvidence(owner.credential, committed.id, "evidence_one")).toEqual(committed.evidence[0]);
    expect(() => repository.getVersion(stranger.credential, committed.id)).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => second.getEvidence(stranger.credential, committed.id, "evidence_one"))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));

    repository.putCache(owner.credential, "places", "current", { changed: true });
    repository.putCache(owner.credential, "evidence", "evidence_one", { status: "unknown" });
    expect(second.getVersion(owner.credential, committed.id)).toEqual(committed);
  });

  test("discovers recoverable work without credentials and claims it with a fresh fence", async () => {
    const dbPath = await databasePath();
    let clock = new Date("2026-09-08T00:00:00.000Z");
    const repository = openRepository({ path: dbPath, now: () => clock });
    repositories.push(repository);
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const accepted = repository.acceptTurn(credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_recover", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });
    repository.claimRun(credential, accepted.runId!, "dead_executor", 1_000);
    expect(repository.trustedWorker().listRecoverableRuns()).toEqual([]);
    clock = new Date("2026-09-08T00:00:02.000Z");
    const [handle] = repository.trustedWorker().listRecoverableRuns();
    expect(handle).toEqual({ runId: accepted.runId });
    expect(repository.trustedWorker().claimRun(handle!, "recovery_executor").fencingToken).toBe(2);
  });

  test("resumes only the bound clarification Turn and preserves consumed repair budget", async () => {
    const dbPath = await databasePath();
    const repository = openRepository({ path: dbPath });
    repositories.push(repository);
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const accepted = repository.acceptTurn(credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_wait", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });
    const claim = repository.claimRun(credential, accepted.runId!, "executor_wait");
    repository.checkpointRun(credential, { ...claim, state: "checking_requirements", checkpoint: {}, repairCount: 1,
      operationIds: { research: "operation_saved" }, attemptCounts: { research: 2 },
      event: { type: "run.started", versionId: null, message: "Checking" } });
    repository.checkpointRun(credential, { ...claim, state: "needs_input", checkpoint: { issueRevision: 2, resumePhase: "checking_requirements" }, repairCount: 1, event: { type: "run.needs_input", versionId: null, issueRevision: 2, issues: [{ id: "issue_destination", revision: 2, kind: "missing", field: "destination", message: "Choose", blocking: true, options: ["Beijing"] }], message: "Input needed" } });
    const resumed = repository.resumeRun(credential, {
      turn: { conversationId: conversation.id, turnId: "turn_resume", targetTripId: accepted.tripId, baseVersionId: null, baseBriefRevision: 1, resume: { runId: accepted.runId!, issueRevision: 2 }, input: { type: "user_message", text: "Beijing" } },
      brief: brief(2),
    });
    expect(resumed.runId).toBe(accepted.runId);
    expect(repository.getRunExecution(credential, accepted.runId!)).toMatchObject({
      state: "checking_requirements", repairCount: 1, baseBriefRevision: 2,
      operationIds: { research: "operation_saved" }, attemptCounts: { research: 2 },
    });
    expect(repository.listBriefRevisions(credential, accepted.tripId).map((item) => item.revision)).toEqual([1, 2]);
  });

  test.each(["constructor", "toString", "__proto__"])("rejects a persisted invalid resume phase %s atomically", async (resumePhase) => {
    const dbPath = await databasePath();
    const repository = openRepository({ path: dbPath });
    const second = openRepository({ path: dbPath });
    repositories.push(repository, second);
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const accepted = repository.acceptTurn(credential, { kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_invalid-resume", targetTripId: null,
        baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } } });
    const claim = repository.claimRun(credential, accepted.runId!, "waiting");
    advanceRun(repository, credential, claim, ["checking_requirements"]);
    repository.checkpointRun(credential, { ...claim, state: "needs_input", repairCount: 1,
      checkpoint: { issueRevision: 1, resumePhase },
      event: { type: "run.needs_input", versionId: null, issueRevision: 1,
        issues: [{ id: "issue_destination", revision: 1, kind: "missing", field: "destination",
          message: "Choose", blocking: true, options: ["Beijing"] }], message: "Input needed" } });
    const before = second.getRunExecution(credential, accepted.runId!);
    const events = second.listEvents(credential, accepted.runId!);
    expect(() => second.resumeRun(credential, { brief: brief(2),
      turn: { conversationId: conversation.id, turnId: "turn_rejected-resume", targetTripId: accepted.tripId,
        baseVersionId: null, baseBriefRevision: 1, resume: { runId: accepted.runId!, issueRevision: 1 },
        input: { type: "user_message", text: "Beijing" } } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(repository.getRunExecution(credential, accepted.runId!)).toEqual(before);
    expect(repository.listEvents(credential, accepted.runId!)).toEqual(events);
    expect(repository.listBriefRevisions(credential, accepted.tripId)).toEqual([brief()]);
    expect(() => repository.getTurn(credential, conversation.id, "turn_rejected-resume"))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  test("a failed Run retry supersedes newer active work atomically across two connections", async () => {
    const dbPath = await databasePath();
    const first = openRepository({ path: dbPath });
    const second = openRepository({ path: dbPath });
    repositories.push(first, second);
    const { credential } = first.createOwner();
    const conversation = first.createConversation(credential);
    const failed = first.acceptTurn(credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_retry-source", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });
    const claim = first.claimRun(credential, failed.runId!, "executor");
    first.checkpointRun(credential, { ...claim, state: "checking_requirements", checkpoint: {}, repairCount: 0,
      event: { type: "run.started", versionId: null, message: "Checking" } });
    first.checkpointRun(credential, { ...claim, state: "failed", checkpoint: {}, repairCount: 0,
      event: { type: "run.failed", versionId: null, code: "PROVIDER", message: "Failed" } });
    const active = second.acceptTurn(credential, { kind: "mutation",
      turn: { conversationId: conversation.id, turnId: "turn_active", targetTripId: failed.tripId, baseVersionId: null, baseBriefRevision: 1, input: { type: "user_message", text: "Try another plan" } },
    });
    const activeClaim = second.claimRun(credential, active.runId!, "active_executor");
    const turn: TurnInput = { conversationId: conversation.id, turnId: "turn_retry-latest", targetTripId: failed.tripId,
      baseVersionId: null, baseBriefRevision: 1, input: { type: "retry_run", runId: failed.runId! } };
    const retried = first.retryRun(credential, { turn, budgets: { research: 3 } });
    expect(second.getRun(credential, active.runId!).state).toBe("superseded");
    expect(second.listEvents(credential, active.runId!).at(-1)).toMatchObject({ type: "run.superseded", replacementRunId: retried.runId });
    expect(() => second.renewLease(credential, activeClaim)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(second.retryRun(credential, { turn, budgets: { research: 9 } })).toEqual({ ...retried, replayed: true });
    expect(second.listEvents(credential, active.runId!)).toHaveLength(2);
  });

  test("recovery capabilities execute without credentials and reject copied or foreign handles across two connections", async () => {
    const dbPath = await databasePath();
    let clock = new Date("2026-09-08T00:00:00.000Z");
    const first = openRepository({ path: dbPath, now: () => clock });
    const second = openRepository({ path: dbPath, now: () => clock });
    repositories.push(first, second);
    const { credential } = first.createOwner();
    const conversation = first.createConversation(credential);
    const accepted = first.acceptTurn(credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_worker", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });
    const worker = first.trustedWorker();
    const [handle] = worker.listRecoverableRuns();
    expect(() => worker.claimRun({ ...handle! }, "forged")).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => second.trustedWorker().claimRun(handle!, "foreign")).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    const claim = worker.claimRun(handle!, "first", 1_000);
    expect(() => worker.renewLease({ ...claim })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(worker.getRunExecution(claim).id).toBe(accepted.runId);
    expect(worker.getTrip(claim).id).toBe(accepted.tripId);
    expect(second.trustedWorker().listRecoverableRuns()).toEqual([]);
    clock = new Date("2026-10-09T00:00:00.000Z");
    expect(() => first.getRun(credential, accepted.runId!)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    const recovery = second.trustedWorker();
    const [recoveredHandle] = recovery.listRecoverableRuns();
    const recovered = recovery.claimRun(recoveredHandle!, "second");
    expect(recovered.fencingToken).toBe(2);
    expect(() => worker.renewLease(claim)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    const renewed = recovery.renewLease(recovered);
    for (const state of ["checking_requirements", "ready", "drafting", "validating"] as const) {
      recovery.checkpointRun(renewed, { state, checkpoint: { state }, repairCount: 0,
        event: { type: "run.started", versionId: null, message: state, runId: "untrusted", turnId: "untrusted" } });
    }
    const committed = snapshot({ tripId: accepted.tripId, conversationId: conversation.id, turnId: accepted.turnId, runId: accepted.runId! });
    expect(recovery.commitVersion(renewed, committed)).toEqual(committed);
    expect(recovery.commitVersion(renewed, committed)).toEqual(committed);
    expect(recovery.getTrip(renewed).currentVersionId).toBe(committed.id);
    expect(recovery.getVersion(renewed, committed.id)).toEqual(committed);
    expect(recovery.listEvents(renewed).map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(recovery.listEvents(renewed).every(event => event.runId === accepted.runId && event.turnId === accepted.turnId)).toBe(true);
    expect(() => recovery.renewLease(renewed)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
  });

  test("recovery honors a persisted retry time and stale workers cannot cancel or commit", async () => {
    const dbPath = await databasePath();
    let clock = new Date("2026-09-08T00:00:00.000Z");
    const first = openRepository({ path: dbPath, now: () => clock });
    const second = openRepository({ path: dbPath, now: () => clock });
    repositories.push(first, second);
    const { credential } = first.createOwner();
    const conversation = first.createConversation(credential);
    const accepted = first.acceptTurn(credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_worker-retry", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });
    const worker = first.trustedWorker();
    const [handle] = worker.listRecoverableRuns();
    const claim = worker.claimRun(handle!, "first", 1_000);
    worker.checkpointRun(claim, { state: "checking_requirements", checkpoint: {}, repairCount: 0,
      nextRetryAt: "2026-09-08T00:00:05.000Z",
      event: { type: "run.started", versionId: null, message: "Checking" } });
    clock = new Date("2026-09-08T00:00:02.000Z");
    expect(second.trustedWorker().listRecoverableRuns()).toEqual([]);
    expect(() => worker.claimRun(handle!, "early")).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    clock = new Date("2026-09-08T00:00:05.000Z");
    const recovery = second.trustedWorker();
    const [next] = recovery.listRecoverableRuns();
    const recovered = recovery.claimRun(next!, "second");
    const committed = snapshot({ tripId: accepted.tripId, conversationId: conversation.id, turnId: accepted.turnId, runId: accepted.runId! });
    expect(() => worker.cancelRun(claim, "stale")).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(() => worker.commitVersion(claim, committed)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    recovery.cancelRun(recovered, "Stopped");
    expect(recovery.getRunExecution(recovered).state).toBe("cancelled");
    expect(recovery.listEvents(recovered).at(-1)).toMatchObject({ type: "run.cancelled" });
    expect(() => recovery.commitVersion(recovered, committed)).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(second.listVersions(credential, accepted.tripId)).toEqual([]);
    expect(second.getTrip(credential, accepted.tripId).currentVersionId).toBeNull();
  });

  test("checkpoints bounded repair work and resumes validation conflicts without resetting adapter attempts", async () => {
    const dbPath = await databasePath();
    const repository = openRepository({ path: dbPath });
    repositories.push(repository);
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const accepted = repository.acceptTurn(credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_repair-resume", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });
    const claim = repository.claimRun(credential, accepted.runId!, "executor");
    for (const state of ["checking_requirements", "ready", "drafting", "validating", "repairing", "routing", "validating"] as const) {
      repository.checkpointRun(credential, { ...claim, state, checkpoint: { state }, repairCount: 2,
        event: { type: "run.started", versionId: null, message: state } });
    }
    repository.checkpointRun(credential, { ...claim, state: "validating", checkpoint: { acceptedOutput: true }, repairCount: 2,
      attemptCounts: { routing: 2 }, operationIds: { routing: "operation_route_saved" },
      event: { type: "run.started", versionId: null, message: "Validation checkpoint" } });
    expect(() => repository.checkpointRun(credential, { ...claim, state: "completed", checkpoint: {}, repairCount: 2,
      event: { type: "itinerary.completed", versionId: "version_uncommitted", message: "Invalid completion" },
    })).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    repository.checkpointRun(credential, { ...claim, state: "needs_input",
      checkpoint: { issueRevision: 3, resumePhase: "routing" }, repairCount: 2,
      event: { type: "run.needs_input", versionId: null, issueRevision: 3,
        issues: [{ id: "issue_conflict", revision: 3, kind: "conflict", field: "destination", message: "Choose", blocking: true, options: ["Beijing"] }],
        message: "Decision required" } });
    repository.close();
    const reopened = openRepository({ path: dbPath });
    repositories.push(reopened);
    const turn: TurnInput = { conversationId: conversation.id, turnId: "turn_resolve-conflict", targetTripId: accepted.tripId,
      baseVersionId: null, baseBriefRevision: 1, resume: { runId: accepted.runId!, issueRevision: 3 },
      input: { type: "user_message", text: "Keep Beijing" } };
    const resumed = reopened.resumeRun(credential, { turn });
    expect(reopened.resumeRun(credential, { turn, brief: brief(-1) })).toEqual({ ...resumed, replayed: true });
    expect(reopened.getRunExecution(credential, accepted.runId!)).toMatchObject({
      state: "routing", repairCount: 2, attemptCounts: { routing: 2 },
      operationIds: { routing: "operation_route_saved" },
    });
    const nextClaim = reopened.claimRun(credential, accepted.runId!, "resumed");
    expect(() => reopened.checkpointRun(credential, { ...nextClaim, state: "validating", checkpoint: {}, repairCount: 3,
      event: { type: "run.started", versionId: null, message: "Over budget" },
    })).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(reopened.listBriefRevisions(credential, accepted.tripId)).toHaveLength(1);
  });

  test("retries a failed Run with a linked fresh Run and fresh recorded budgets", async () => {
    const dbPath = await databasePath();
    const repository = openRepository({ path: dbPath });
    repositories.push(repository);
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const accepted = repository.acceptTurn(credential, {
      kind: "mutation", brief: brief(),
      turn: { conversationId: conversation.id, turnId: "turn_failed", targetTripId: null, baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan" } },
    });
    const claim = repository.claimRun(credential, accepted.runId!, "executor_failed");
    repository.checkpointRun(credential, { ...claim, state: "checking_requirements", checkpoint: {}, repairCount: 2, event: { type: "run.started", versionId: null, message: "Checking" } });
    repository.checkpointRun(credential, { ...claim, state: "failed", checkpoint: { reason: "provider" }, repairCount: 2, event: { type: "run.failed", versionId: null, code: "PROVIDER", message: "Provider failed" } });
    const turn: TurnInput = { conversationId: conversation.id, turnId: "turn_retry", targetTripId: accepted.tripId, baseVersionId: null, baseBriefRevision: 1, input: { type: "retry_run", runId: accepted.runId! } };

    const retried = repository.retryRun(credential, { turn, budgets: { research: 3, repair: 2 } });
    expect(retried.runId).not.toBe(accepted.runId);
    expect(repository.getRunExecution(credential, retried.runId!)).toMatchObject({
      state: "accepted", repairCount: 0, retryOfRunId: accepted.runId,
      attemptCounts: { budgets: { research: 3, repair: 2 } },
    });
    expect(repository.getTrip(credential, accepted.tripId).mutationSequence).toBe(2);
    expect(repository.retryRun(credential, { turn, budgets: { research: 99 } })).toEqual({ ...retried, replayed: true });
    expect(repository.retryRun(credential, { turn, budgets: undefined })).toEqual({ ...retried, replayed: true });
  });
});
