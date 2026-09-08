// @vitest-environment node

import { afterEach, describe, expect, test, vi } from "vitest";
import { createEventsHandler, type ObservationClock } from "@/server/http/events";
import { openRepository, type TripRepository } from "@/server/repository";
import { committedSnapshotFixture, scheduleFixture } from "./schedule-fixtures";

const repositories: TripRepository[] = [];

class ManualClock implements ObservationClock {
  time = Date.parse("2026-09-08T00:00:00.000Z");
  private task: { at: number; callback: () => void } | null = null;
  now = () => this.time;
  schedule = (callback: () => void, delay: number) => {
    if (this.task) throw new Error("More than one observation timer.");
    const task = { at: this.time + delay, callback };
    this.task = task;
    return () => { if (this.task === task) this.task = null; };
  };
  get pending() { return this.task === null ? 0 : 1; }
  tick(milliseconds = 1_000) {
    this.time += milliseconds;
    const task = this.task;
    if (task && task.at <= this.time) {
      this.task = null;
      task.callback();
    }
  }
}

function setup() {
  const clock = new ManualClock();
  const repository = openRepository({ path: ":memory:", now: () => new Date(clock.now()) });
  repositories.push(repository);
  const { credential, expiresAt } = repository.createOwner();
  const conversation = repository.createConversation(credential);
  const accepted = repository.acceptTurn(credential, { kind: "mutation", brief: scheduleFixture().brief,
    turn: { conversationId: conversation.id, turnId: "turn_events", targetTripId: null,
      baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan." } } });
  const runId = accepted.runId!;
  const handle = createEventsHandler({ repository: () => repository, clock });
  function request(query = "", headers: HeadersInit = {}, signal?: AbortSignal) {
    const values = new Headers(headers);
    if (!values.has("cookie")) values.set("cookie", `travel_owner=${credential}`);
    return new Request(`http://127.0.0.1:3000/api/runs/${runId}/events${query}`, { headers: values, signal });
  }
  return { clock, repository, credential, expiresAt, conversation, accepted, runId, handle, request };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
});

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let index = 0; index < 20 && !done; index++) await Promise.resolve();
  if (!done) throw new Error("Expected finite stream progress.");
  return promise;
}

async function readFinite(response: Response, maximum = 40) {
  const reader = response.body!.getReader();
  let text = "";
  try {
    for (let index = 0; index < maximum; index++) {
      const item = await settled(reader.read());
      if (item.done) return text;
      text += new TextDecoder().decode(item.value);
    }
    throw new Error("Finite event read bound exceeded.");
  } finally {
    await reader.cancel();
  }
}

describe("HTTP durable event observation", () => {
  test("rejects ambiguous and noncanonical cursors, and returns conflict for an ahead cursor", async () => {
    const s = setup();
    for (const value of ["", "-1", "01", "+1", "1.0", "1e2", " 1", "9007199254740992", "event_one"]) {
      for (const response of [
        await s.handle(s.request(`?afterSequence=${encodeURIComponent(value)}`), s.runId),
        // Headers trim outer whitespace, so exercise it through query only.
        ...(value === " 1" ? [] : [await s.handle(s.request("", { "last-event-id": value }), s.runId)]),
      ]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ code: "malformed_input", message: "Malformed input." });
      }
    }
    for (const response of [
      await s.handle(s.request("?afterSequence=0&afterSequence=0"), s.runId),
      await s.handle(s.request("?unknown=0"), s.runId),
      await s.handle(s.request("?afterSequence=0", { "last-event-id": "1" }), s.runId),
      await s.handle(s.request("", { "last-event-id": "0, 0" }), s.runId),
      await s.handle(s.request(), "run_bad_id"),
    ]) expect(response.status).toBe(400);
    expect((await s.handle(s.request("?afterSequence=9007199254740991"), s.runId)).status).toBe(409);
    expect(s.clock.pending).toBe(0);
  });

  test("drains more than one bounded page in sequence before terminal closure", async () => {
    const s = setup();
    const claim = s.repository.claimRun(s.credential, s.runId, "events-test");
    for (let index = 0; index < 18; index++) {
      s.repository.checkpointRun(s.credential, { ...claim, state: "checking_requirements",
        checkpoint: {}, repairCount: 0,
        event: { type: "requirements.checked", versionId: null, blockingIssueCount: 0,
          assumptionCount: 0, warningCount: 0, message: "Requirements checked" } });
    }
    s.repository.cancelRun(s.credential, s.runId, "Stop");
    const response = await s.handle(s.request(), s.runId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const text = await readFinite(response);
    expect([...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1])))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(text).toContain("event: run.cancelled\n");
    expect(text).not.toContain(s.credential);
    expect(text).not.toContain("checkpoint");
    expect(s.clock.pending).toBe(0);
  });

  test("resumes without duplicates and accepts agreeing header/query cursors", async () => {
    const s = setup();
    s.repository.cancelRun(s.credential, s.runId, "Stop");
    const response = await s.handle(s.request("?afterSequence=1", { "last-event-id": "1" }), s.runId);
    const text = await readFinite(response);
    expect([...text.matchAll(/^id: (\d+)$/gm)].map(match => match[1])).toEqual(["2"]);
    expect(await readFinite(await s.handle(s.request("?afterSequence=2"), s.runId))).toBe("");
    expect(s.clock.pending).toBe(0);
  });

  test("drains needs_input and no-change without changing their Runs", async () => {
    const s = setup();
    const claim = s.repository.claimRun(s.credential, s.runId, "needs-input");
    s.repository.checkpointRun(s.credential, { ...claim, state: "checking_requirements", checkpoint: {},
      repairCount: 0, event: { type: "run.started", versionId: null, message: "Checking" } });
    s.repository.checkpointRun(s.credential, { ...claim, state: "needs_input",
      checkpoint: { issueRevision: 1, resumePhase: "checking_requirements" }, repairCount: 0,
      event: { type: "run.needs_input", versionId: null, issueRevision: 1,
        issues: [{ id: "issue_destination", revision: 1, kind: "missing", field: "destination",
          message: "Choose destination", blocking: true, options: ["Beijing"] }], message: "Input needed" } });
    const text = await readFinite(await s.handle(s.request(), s.runId));
    expect(text).toContain("event: run.needs_input\n");
    expect(s.repository.getRun(s.credential, s.runId).state).toBe("needs_input");

    const n = setup();
    const seedClaim = n.repository.claimRun(n.credential, n.runId, "seed");
    for (const state of ["checking_requirements", "ready", "drafting", "validating"] as const) {
      n.repository.checkpointRun(n.credential, { ...seedClaim, state, checkpoint: {}, repairCount: 0,
        event: { type: "run.started", versionId: null, message: state } });
    }
    const fixture = committedSnapshotFixture();
    const version = n.repository.commitVersion(n.credential, { ...seedClaim, snapshot: {
      ...fixture, tripId: n.accepted.tripId, conversationId: n.conversation.id,
      turnId: n.accepted.turnId, runId: n.runId,
      itinerary: { ...fixture.itinerary, tripId: n.accepted.tripId, runId: n.runId },
    } });
    const command = n.repository.acceptTurn(n.credential, { kind: "mutation",
      turn: { conversationId: n.conversation.id, turnId: "turn_no-change", targetTripId: n.accepted.tripId,
        baseVersionId: version.id, baseBriefRevision: 1,
        input: { type: "update_day_transport_mode", dayId: "day_one", mode: "walk" } } });
    const commandClaim = n.repository.claimRun(n.credential, command.runId!, "no-change");
    for (const state of ["checking_requirements", "ready"] as const) {
      n.repository.checkpointRun(n.credential, { ...commandClaim, state, checkpoint: {}, repairCount: 0,
        event: { type: "run.started", versionId: null, message: state } });
    }
    n.repository.completeNoChange(n.credential, { ...commandClaim, versionId: version.id });
    const result = await readFinite(await n.handle(n.request(), command.runId!));
    expect(result).toContain("event: run.no_change\n");
    expect(result).toContain('"message":"Itinerary unchanged"');
    expect(result).toContain(`"versionId":"${version.id}"`);
    expect(n.repository.listVersions(n.credential, n.accepted.tripId)).toEqual([version]);
    expect(n.clock.pending).toBe(0);
  });

  test("checks ownership before invalid cursors and never starts an unauthorized stream", async () => {
    const s = setup();
    const other = s.repository.createOwner();
    for (const [cookie, status] of [
      ["", 401], ["travel_owner=invalid", 401], [`travel_owner=${other.credential}`, 404],
    ] as const) {
      const response = await s.handle(s.request("?afterSequence=bad", { cookie }), s.runId);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(s.clock.pending).toBe(0);
    }
  });
});
