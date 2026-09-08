// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openRepository, type TripRepository, type InterpretationClaim } from "@/server/repository";
import type { TurnInput } from "@/domain/contracts";
import { scheduleFixture, committedSnapshotFixture } from "./schedule-fixtures";

const repositories: TripRepository[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "travel-interpretation-ledger-"));
  directories.push(directory);
  const filename = path.join(directory, "travel.sqlite");
  let milliseconds = Date.parse("2026-09-08T00:00:00.000Z");
  const now = () => new Date(milliseconds);
  const connect = () => {
    const repository = openRepository({ path: filename, now });
    repositories.push(repository);
    return repository;
  };
  const repository = connect();
  const second = connect();
  const { credential } = repository.createOwner();
  const conversation = repository.createConversation(credential);
  const turn: TurnInput = {
    conversationId: conversation.id, turnId: "turn_interpret",
    targetTripId: null, baseVersionId: null, baseBriefRevision: 0,
    input: { type: "user_message", text: "Plan a trip" },
  };
  return { repository, second, credential, turn, connect,
    advance: (amount: number) => { milliseconds += amount; } };
}

function reserve(repository: TripRepository, credential: string, turn: TurnInput): InterpretationClaim {
  const result = repository.reserveInterpretation(credential, turn);
  expect(result.status).toBe("reserved");
  if (result.status !== "reserved") throw new Error("Expected a reservation");
  return result.claim;
}

function commit(repository: TripRepository, credential: string, turn: TurnInput, versionId: string, revision: number) {
  const brief = { ...scheduleFixture().brief, revision };
  const accepted = repository.acceptTurn(credential, { turn, kind: "mutation", brief });
  const claim = repository.claimRun(credential, accepted.runId!, "ledger_fixture");
  for (const state of ["checking_requirements", "ready", "drafting", "validating"] as const) {
    repository.checkpointRun(credential, {
      ...claim, state, checkpoint: { state }, repairCount: 0,
      event: { type: "run.started", versionId: turn.baseVersionId, message: state },
    });
  }
  const fixture = committedSnapshotFixture();
  const snapshot = {
    ...fixture, id: versionId, tripId: accepted.tripId, conversationId: turn.conversationId,
    turnId: turn.turnId, runId: accepted.runId!, baseVersionId: turn.baseVersionId,
    brief, briefRevision: revision,
    itinerary: { ...fixture.itinerary, tripId: accepted.tripId, runId: accepted.runId!,
      baseVersionId: turn.baseVersionId, briefRevision: revision },
  };
  repository.commitVersion(credential, { ...claim, snapshot });
  return { accepted, snapshot };
}

describe("durable interpretation admission", () => {
  test("one canonical Turn has one live reservation across two SQLite connections", async () => {
    const { repository, second, credential, turn } = await fixture();
    const claim = reserve(repository, credential, turn);
    expect(claim).toEqual({
      conversationId: turn.conversationId, turnId: turn.turnId, attempt: 1,
      leaseExpiresAt: "2026-09-08T00:01:30.000Z",
    });
    expect(Object.isFrozen(claim)).toBe(true);
    const reordered: TurnInput = {
      input: { text: "Plan a trip", type: "user_message" }, baseBriefRevision: 0,
      baseVersionId: null, targetTripId: null, turnId: turn.turnId, conversationId: turn.conversationId,
    };
    expect(second.reserveInterpretation(credential, reordered)).toEqual({ status: "busy" });
    expect(() => second.reserveInterpretation(credential, {
      ...turn, input: { type: "user_message", text: "Different" },
    })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(repository.listTrips(credential)).toEqual([]);
    expect(repository.listMessages(credential, turn.conversationId)).toEqual([]);
  });

  test("saved JSON replays independently, canonically, and without consuming another attempt", async () => {
    const { repository, second, credential, turn, advance } = await fixture();
    const claim = reserve(repository, credential, turn);
    const output = { kind: "question", choices: ["one"], detail: { b: 2, a: 1 } };
    expect(repository.saveInterpretation(credential, claim, output)).toEqual(output);
    output.choices.push("not saved");
    const saved = second.reserveInterpretation(credential, turn);
    expect(saved).toEqual({ status: "saved", output: { kind: "question", choices: ["one"], detail: { a: 1, b: 2 } } });
    if (saved.status !== "saved") throw new Error("Expected saved interpretation");
    (saved.output as { choices: string[] }).choices.push("not durable");
    advance(90_001);
    expect(repository.saveInterpretation(credential, claim, {
      detail: { a: 1, b: 2 }, choices: ["one"], kind: "question",
    })).toEqual({ kind: "question", choices: ["one"], detail: { a: 1, b: 2 } });
    expect(() => repository.saveInterpretation(credential, claim, { kind: "different" }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(second.reserveInterpretation(credential, turn)).toEqual({
      status: "saved", output: { kind: "question", choices: ["one"], detail: { a: 1, b: 2 } },
    });
  });

  test("durable expiry and reopen allow only one takeover, never a third attempt", async () => {
    const { repository, second, credential, turn, connect, advance } = await fixture();
    const first = reserve(repository, credential, turn);
    repository.close();
    second.close();
    const reopened = connect();
    expect(reopened.reserveInterpretation(credential, turn)).toEqual({ status: "busy" });
    expect(() => reopened.saveInterpretation(credential, first, { ok: true }))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    advance(90_000);
    const next = reserve(reopened, credential, turn);
    expect(next.attempt).toBe(2);
    advance(90_000);
    expect(() => reopened.saveInterpretation(credential, next, { ok: true }))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(() => reopened.releaseInterpretation(credential, next))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    reopened.close();
    expect(connect().reserveInterpretation(credential, turn)).toEqual({ status: "exhausted" });
  });

  test("release consumes its attempt and cannot clear a newer lease", async () => {
    const { repository, second, credential, turn } = await fixture();
    const first = reserve(repository, credential, turn);
    repository.releaseInterpretation(credential, first);
    const next = reserve(second, credential, turn);
    expect(next.attempt).toBe(2);
    expect(() => repository.releaseInterpretation(credential, first))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(() => repository.saveInterpretation(credential, first, { stale: true }))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(repository.reserveInterpretation(credential, turn)).toEqual({ status: "busy" });
    second.releaseInterpretation(credential, next);
    expect(repository.reserveInterpretation(credential, turn)).toEqual({ status: "exhausted" });
  });

  test("claims are identity-bound to their repository and Owner", async () => {
    const { repository, second, credential, turn } = await fixture();
    const foreign = repository.createOwner().credential;
    const claim = reserve(repository, credential, turn);
    for (const copied of [{ ...claim }, JSON.parse(JSON.stringify(claim)) as InterpretationClaim]) {
      expect(() => repository.saveInterpretation(credential, copied, {}))
        .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
      expect(() => repository.releaseInterpretation(credential, copied))
        .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    }
    expect(() => second.saveInterpretation(credential, claim, {}))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => repository.saveInterpretation(foreign, claim, {}))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => repository.releaseInterpretation(foreign, claim))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(repository.reserveInterpretation(credential, turn)).toEqual({ status: "busy" });
  });

  test("every operation reauthorizes even for an exact saved replay", async () => {
    const { repository, credential, turn, advance } = await fixture();
    expect(() => repository.reserveInterpretation("not-a-credential", turn))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    const claim = reserve(repository, credential, turn);
    repository.saveInterpretation(credential, claim, { ok: true });
    advance(30 * 24 * 60 * 60 * 1000);
    expect(() => repository.reserveInterpretation(credential, turn))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => repository.saveInterpretation(credential, claim, { ok: true }))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => repository.releaseInterpretation(credential, claim))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  test("a late worker cannot overwrite or clear the takeover's saved output", async () => {
    const { repository, second, credential, turn, advance } = await fixture();
    const first = reserve(repository, credential, turn);
    advance(90_000);
    const next = reserve(second, credential, turn);
    second.saveInterpretation(credential, next, { result: "second" });
    expect(() => repository.saveInterpretation(credential, first, { result: "second" }))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(() => repository.releaseInterpretation(credential, first))
      .toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(repository.reserveInterpretation(credential, turn)).toEqual({ status: "saved", output: { result: "second" } });
  });

  test("invalid original resources and Typed Commands do not reserve or change a Run", async () => {
    const { repository, credential, turn } = await fixture();
    const foreign = repository.createOwner().credential;
    const foreignConversation = repository.createConversation(foreign);
    for (const conversationId of [foreignConversation.id, "conversation_missing"]) {
      expect(() => repository.reserveInterpretation(credential, { ...turn, conversationId }))
        .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    }
    expect(() => repository.reserveInterpretation(credential, { ...turn, baseBriefRevision: 1 }))
      .toThrowError(expect.objectContaining({ code: "STALE_BRIEF" }));
    expect(() => repository.reserveInterpretation(credential, { ...turn, input: { type: "cancel_run", runId: "run_missing" } }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    const accepted = repository.acceptTurn(credential, { turn: { ...turn, turnId: "turn_seed" },
      kind: "mutation", brief: scheduleFixture().brief });
    const request = { ...turn, targetTripId: accepted.tripId, baseBriefRevision: 1 };
    const before = repository.getTrip(credential, accepted.tripId);
    const run = repository.getRun(credential, accepted.runId!);
    for (const targetTripId of [null, "trip_missing"]) {
      expect(() => repository.reserveInterpretation(credential, { ...request, targetTripId }))
        .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    }
    expect(() => repository.reserveInterpretation(credential, { ...request, baseBriefRevision: 2 }))
      .toThrowError(expect.objectContaining({ code: "STALE_BRIEF" }));
    expect(() => repository.reserveInterpretation(credential, { ...request, baseVersionId: "version_missing" }))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    const claim = reserve(repository, credential, request);
    expect(claim.attempt).toBe(1);
    repository.saveInterpretation(credential, claim, { kind: "question" });
    expect(repository.getTrip(credential, accepted.tripId)).toEqual(before);
    expect(repository.getRun(credential, accepted.runId!)).toEqual(run);
  });

  test("accepted exact replay wins over an old lease and subsequently advanced bases", async () => {
    const { repository, second, credential, turn } = await fixture();
    reserve(repository, credential, turn);
    const first = commit(repository, credential, turn, "version_first", 1);
    const next: TurnInput = { ...turn, turnId: "turn_next", targetTripId: first.accepted.tripId,
      baseVersionId: first.snapshot.id, baseBriefRevision: 1 };
    commit(repository, credential, next, "version_second", 2);
    expect(second.reserveInterpretation(credential, turn)).toEqual({
      status: "accepted", outcome: { ...repository.getTurn(credential, turn.conversationId, turn.turnId), replayed: true },
    });
    expect(() => second.reserveInterpretation(credential, { ...turn, input: { type: "user_message", text: "Changed" } }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  test("saved preacceptance output replays after the Conversation acquires a Trip", async () => {
    const { repository, second, credential, turn, advance } = await fixture();
    const claim = reserve(repository, credential, turn);
    repository.saveInterpretation(credential, claim, { kind: "question" });
    commit(repository, credential, { ...turn, turnId: "turn_generation" }, "version_first", 1);
    advance(90_001);
    expect(second.reserveInterpretation(credential, turn)).toEqual({ status: "saved", output: { kind: "question" } });
    expect(repository.saveInterpretation(credential, claim, { kind: "question" })).toEqual({ kind: "question" });
  });

  test("historical references admit interpretation without changing current mutation state", async () => {
    const { repository, second, credential, turn } = await fixture();
    const first = commit(repository, credential, { ...turn, turnId: "turn_first" }, "version_first", 1);
    const secondTurn: TurnInput = { ...turn, turnId: "turn_second", targetTripId: first.accepted.tripId,
      baseVersionId: first.snapshot.id, baseBriefRevision: 1 };
    const latest = commit(repository, credential, secondTurn, "version_second", 2);
    const active = repository.acceptTurn(credential, {
      kind: "mutation", turn: { ...secondTurn, turnId: "turn_active", baseVersionId: latest.snapshot.id, baseBriefRevision: 2 },
    });
    const historical: TurnInput = { ...secondTurn, turnId: turn.turnId };
    const before = repository.getTrip(credential, active.tripId);
    const revisions = repository.listBriefRevisions(credential, active.tripId);
    const versions = repository.listVersions(credential, active.tripId);
    const run = repository.getRun(credential, active.runId!);
    expect(() => repository.reserveInterpretation(credential, { ...historical, baseVersionId: latest.snapshot.id }))
      .toThrowError(expect.objectContaining({ code: "STALE_BRIEF" }));
    expect(() => repository.reserveInterpretation(credential, { ...historical, baseVersionId: null, baseBriefRevision: 2 }))
      .toThrowError(expect.objectContaining({ code: "STALE_VERSION" }));
    const claim = reserve(repository, credential, historical);
    repository.saveInterpretation(credential, claim, { kind: "history", versionId: first.snapshot.id });
    expect(second.getTrip(credential, active.tripId)).toEqual(before);
    expect(second.listBriefRevisions(credential, active.tripId)).toEqual(revisions);
    expect(second.listVersions(credential, active.tripId)).toEqual(versions);
    expect(second.getRun(credential, active.runId!)).toEqual(run);
  });

  test("saved output survives close/reopen at the exact UTF-8 byte limit", async () => {
    const { repository, second, credential, turn, connect } = await fixture();
    const claim = reserve(repository, credential, turn);
    const output = "\u4e00".repeat(43_690);
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBe(128 * 1024);
    expect(() => repository.saveInterpretation(credential, claim, `${output}a`))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(repository.saveInterpretation(credential, claim, output)).toBe(output);
    repository.close();
    second.close();
    expect(connect().reserveInterpretation(credential, turn)).toEqual({ status: "saved", output });
  });

  test("bounded deep JSON and shared noncyclic values remain lossless", async () => {
    const { repository, second, credential, turn } = await fixture();
    const claim = reserve(repository, credential, turn);
    const leaf = { value: "shared" };
    let output: unknown = [leaf, leaf];
    for (let depth = 0; depth < 1_100; depth++) output = [output];
    const saved = repository.saveInterpretation(credential, claim, output);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(output));
    const replay = second.reserveInterpretation(credential, turn);
    expect(replay.status).toBe("saved");
    if (replay.status !== "saved") throw new Error("Expected saved interpretation");
    expect(JSON.stringify(replay.output)).toBe(JSON.stringify(output));
  });

  test("real foreign and other-Trip references fail without consuming an attempt", async () => {
    const { repository, credential, turn } = await fixture();
    const own = commit(repository, credential, { ...turn, turnId: "turn_own" }, "version_own", 1);
    const otherConversation = repository.createConversation(credential);
    const other = commit(repository, credential, {
      ...turn, conversationId: otherConversation.id, turnId: "turn_other",
    }, "version_other", 1);
    const foreignCredential = repository.createOwner().credential;
    const foreignConversation = repository.createConversation(foreignCredential);
    const foreign = commit(repository, foreignCredential, {
      ...turn, conversationId: foreignConversation.id, turnId: "turn_foreign",
    }, "version_foreign", 1);
    const request = { ...turn, targetTripId: own.accepted.tripId,
      baseVersionId: own.snapshot.id, baseBriefRevision: 1 };
    for (const unrelated of [other, foreign]) {
      expect(() => repository.reserveInterpretation(credential, {
        ...request, targetTripId: unrelated.accepted.tripId,
      })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(() => repository.reserveInterpretation(credential, {
        ...request, baseVersionId: unrelated.snapshot.id,
      })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    }
    expect(() => repository.reserveInterpretation(credential, {
      ...request, unexpected: true,
    } as TurnInput)).toThrow();
    expect(reserve(repository, credential, request).attempt).toBe(1);
  });

  test("saving a live historical claim does not recheck newly advanced mutation bases", async () => {
    const { repository, second, credential, turn } = await fixture();
    const first = commit(repository, credential, { ...turn, turnId: "turn_first" }, "version_first", 1);
    const historical = { ...turn, targetTripId: first.accepted.tripId,
      baseVersionId: first.snapshot.id, baseBriefRevision: 1 };
    const claim = reserve(repository, credential, historical);
    commit(repository, credential, { ...historical, turnId: "turn_next" }, "version_next", 2);
    const before = repository.getTrip(credential, first.accepted.tripId);
    const revisions = repository.listBriefRevisions(credential, first.accepted.tripId);
    const versions = repository.listVersions(credential, first.accepted.tripId);
    repository.saveInterpretation(credential, claim, { kind: "history" });
    expect(second.reserveInterpretation(credential, historical)).toEqual({
      status: "saved", output: { kind: "history" },
    });
    expect(repository.getTrip(credential, first.accepted.tripId)).toEqual(before);
    expect(repository.listBriefRevisions(credential, first.accepted.tripId)).toEqual(revisions);
    expect(repository.listVersions(credential, first.accepted.tripId)).toEqual(versions);
  });

  test.each([
    ["undefined", () => undefined], ["nested undefined", () => ({ value: undefined })],
    ["NaN", () => Number.NaN], ["infinity", () => ({ value: Infinity })],
    ["negative zero", () => -0], ["bigint", () => 1n],
    ["function", () => ({ value: () => 1 })], ["symbol", () => Symbol("hidden")],
    ["Date", () => new Date("2026-09-08T00:00:00.000Z")],
    ["sparse array", () => Array(2)], ["Map", () => new Map([["key", 1]])],
    ["cycle", () => { const value: unknown[] = []; value.push(value); return value; }],
    ["symbol key", () => ({ [Symbol("hidden")]: 1 })],
    ["non-enumerable", () => Object.defineProperty({}, "hidden", { value: 1 })],
    ["accessor", () => Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("Must not run"); } })],
    ["extra array property", () => Object.assign([1], { extra: 2 })],
    ["oversized UTF-8", () => "\u4e00".repeat(44_000)],
  ] as const)("rejects %s output without consuming the saved-output slot", async (_name, makeOutput) => {
    const { repository, second, credential, turn } = await fixture();
    const claim = reserve(repository, credential, turn);
    expect(() => repository.saveInterpretation(credential, claim, makeOutput()))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(second.reserveInterpretation(credential, turn)).toEqual({ status: "busy" });
    expect(repository.saveInterpretation(credential, claim, null)).toBeNull();
    expect(second.reserveInterpretation(credential, turn)).toEqual({ status: "saved", output: null });
  });
});
