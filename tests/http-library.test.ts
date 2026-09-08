// @vitest-environment node

import { afterEach, describe, expect, test, vi } from "vitest";
import { createLibraryHandlers } from "@/server/http/library";
import { openRepository, type TripRepository } from "@/server/repository";
import { generationRunSchema } from "@/domain/contracts";
import { committedSnapshotFixture, scheduleFixture } from "./schedule-fixtures";

const origin = "http://127.0.0.1:3000";
const repositories: TripRepository[] = [];

function setup(now?: () => Date) {
  const repository = openRepository({ path: ":memory:", now });
  repositories.push(repository);
  const handlers = createLibraryHandlers({ repository: () => repository, appOrigin: origin, mode: "live" });
  return { repository, handlers };
}

function request(path: string, cookie?: string, body?: unknown) {
  return new Request(`${origin}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { origin, "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function seed(repository: TripRepository, credential: string) {
  const conversation = repository.createConversation(credential);
  function commit(turnId: string, versionId: string, baseVersionId: string | null, tripId: string | null) {
    const accepted = repository.acceptTurn(credential, {
      kind: "mutation", ...(tripId === null ? { brief: scheduleFixture().brief } : {}),
      turn: { conversationId: conversation.id, turnId, targetTripId: tripId, baseVersionId,
        baseBriefRevision: tripId === null ? 0 : 1, input: { type: "user_message", text: "Plan this trip." } },
    });
    const claim = repository.claimRun(credential, accepted.runId!, "http-test");
    for (const state of ["checking_requirements", "ready", "drafting", "validating"] as const) {
      repository.checkpointRun(credential, { ...claim, state, checkpoint: {}, repairCount: 0,
        event: { type: "run.started", versionId: null, message: state } });
    }
    const fixture = committedSnapshotFixture();
    const snapshot = repository.commitVersion(credential, { ...claim, snapshot: {
      ...fixture, id: versionId, tripId: accepted.tripId, conversationId: conversation.id,
      turnId, runId: accepted.runId!, baseVersionId,
      mutationOrigin: baseVersionId === null ? "generation" : "natural_language_revision",
      itinerary: { ...fixture.itinerary, tripId: accepted.tripId, runId: accepted.runId!, baseVersionId },
    } });
    return { accepted, snapshot };
  }
  const first = commit("turn_http-first", "version_http-first", null, null);
  const second = commit("turn_http-second", "version_http-second", first.snapshot.id, first.accepted.tripId);
  return { conversation, first, second, tripId: first.accepted.tripId };
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("HTTP identity and library", () => {
  test("redacts malformed repository output as an internal error, not a client error", async () => {
    const { repository, handlers } = setup();
    const cookie = `travel_owner=${repository.createOwner().credential}`;
    const payload = "malformed-public-record-marker";
    const spy = vi.spyOn(repository, "listConversations").mockReturnValueOnce([
      { id: payload, tripId: null, createdAt: "2026-09-08T00:00:00.000Z" },
    ]);
    try {
      const response = await handlers.listConversations(request("conversations", cookie));
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        code: "internal_error", message: "An internal error occurred.",
      });
      expect(text).not.toContain(payload);
      expect(text).not.toContain("ZodError");
    } finally {
      spy.mockRestore();
    }
  });

  test("reads current and immutable historical snapshots plus only the public Run", async () => {
    const { repository, handlers } = setup();
    const { credential } = repository.createOwner();
    const cookie = `travel_owner=${credential}`;
    const { conversation, first, second, tripId } = seed(repository, credential);
    const current = await handlers.getTrip(request(`trips/${tripId}`, cookie), tripId);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ trip: { id: tripId, currentVersionId: second.snapshot.id }, version: second.snapshot });
    const history = await handlers.getTrip(request(`trips/${tripId}?versionId=${first.snapshot.id}`, cookie), tripId);
    expect(await history.json()).toMatchObject({ version: first.snapshot });
    const versions = await handlers.listVersions(request("versions", cookie), tripId);
    expect(await versions.json()).toEqual({ versions: [first.snapshot, second.snapshot] });
    expect(repository.getTrip(credential, tripId).currentVersionId).toBe(second.snapshot.id);
    const run = await handlers.getRun(request("run", cookie), second.accepted.runId!);
    const body = await run.json();
    expect(body).toEqual({ run: repository.getRun(credential, second.accepted.runId!) });
    expect(generationRunSchema.safeParse(body.run).success).toBe(true);
    const messages = await handlers.listMessages(request("messages", cookie), conversation.id);
    expect(await messages.json()).toEqual({ messages: repository.listMessages(credential, conversation.id) });
    const library = await handlers.bootstrap(request("bootstrap", cookie, {}));
    const libraryBody = await library.json();
    expect(libraryBody.library.trips).toHaveLength(1);
    expect(libraryBody.library.conversations).toEqual(repository.listConversations(credential));
    for (const response of [current, history, versions, run, messages, library]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const text = JSON.stringify({ body, libraryBody });
    for (const forbidden of [credential, '"ownerId"', '"credential"', '"fencingToken"', '"checkpoint"', '"mutationSequence"']) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("returns a null snapshot for an accepted Trip before its first commit", async () => {
    const { repository, handlers } = setup();
    const { credential } = repository.createOwner();
    const conversation = repository.createConversation(credential);
    const turn = repository.acceptTurn(credential, { kind: "mutation", brief: scheduleFixture().brief,
      turn: { conversationId: conversation.id, turnId: "turn_pending", targetTripId: null,
        baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "Plan." } } });
    const response = await handlers.getTrip(request("trip", `travel_owner=${credential}`), turn.tripId);
    expect(await response.json()).toMatchObject({ trip: { currentVersionId: null }, version: null });
  });

  test("denies all foreign resources exactly like absent resources, including history selectors", async () => {
    const { repository, handlers } = setup();
    const owner = repository.createOwner();
    const other = repository.createOwner();
    const cookie = `travel_owner=${other.credential}`;
    const { conversation, first, tripId } = seed(repository, owner.credential);
    const responses = [
      await handlers.listMessages(request("messages", cookie), conversation.id),
      await handlers.listMessages(request("messages", cookie), "conversation_missing"),
      await handlers.getTrip(request("trip", cookie), tripId),
      await handlers.getTrip(request("trip", cookie), "trip_missing"),
      await handlers.listVersions(request("versions", cookie), tripId),
      await handlers.getRun(request("run", cookie), first.accepted.runId!),
      await handlers.getRun(request("run", cookie), "run_missing"),
      await handlers.getTrip(request(`trip?versionId=${first.snapshot.id}`, cookie), tripId),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "not_found", message: "Resource not found." });
    }
    expect(await (await handlers.listTrips(request("trips", cookie))).json()).toEqual({ trips: [] });
    expect(await (await handlers.listConversations(request("conversations", cookie))).json()).toEqual({ conversations: [] });
    const ownConversation = repository.createConversation(other.credential);
    const ownTurn = repository.acceptTurn(other.credential, { kind: "mutation", brief: scheduleFixture().brief,
      turn: { conversationId: ownConversation.id, turnId: "turn_own", targetTripId: null,
        baseVersionId: null, baseBriefRevision: 0, input: { type: "user_message", text: "My trip." } } });
    const foreignVersion = await handlers.getTrip(
      request(`trip?versionId=${first.snapshot.id}`, cookie), ownTurn.tripId,
    );
    expect(foreignVersion.status).toBe(404);
    expect(await foreignVersion.json()).toEqual({ code: "not_found", message: "Resource not found." });
  });

  test("requires a cookie on every protected operation", async () => {
    const { handlers } = setup();
    for (const response of [
      await handlers.listConversations(request("conversations")),
      await handlers.createConversation(request("conversations", undefined, {})),
      await handlers.listMessages(request("messages"), "conversation_missing"),
      await handlers.listTrips(request("trips")),
      await handlers.getTrip(request("trip"), "trip_missing"),
      await handlers.listVersions(request("versions"), "trip_missing"),
      await handlers.getRun(request("run"), "run_missing"),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("rejects noncanonical IDs and unknown or repeated query parameters", async () => {
    const { repository, handlers } = setup();
    const cookie = `travel_owner=${repository.createOwner().credential}`;
    for (const response of [
      await handlers.getTrip(request("trip", cookie), "trip_bad_id"),
      await handlers.getRun(request("run", cookie), "run_bad_id"),
      await handlers.listMessages(request("messages", cookie), "conversation_bad_id"),
      await handlers.listVersions(request("versions", cookie), "trip_bad_id"),
      await handlers.getTrip(request("trip?versionId=version_bad_id", cookie), "trip_valid"),
      await handlers.getTrip(request("trip?versionId=", cookie), "trip_valid"),
      await handlers.getTrip(request("trip?versionId=version_a&versionId=version_a", cookie), "trip_valid"),
      await handlers.getTrip(request("trip?ownerId=owner_other", cookie), "trip_valid"),
      await handlers.listTrips(request("trips?extra=1", cookie)),
      await handlers.listConversations(request("conversations?extra=1", cookie)),
      await handlers.listMessages(request("messages?extra=1", cookie), "conversation_valid"),
      await handlers.listVersions(request("versions?extra=1", cookie), "trip_valid"),
      await handlers.getRun(request("run?extra=1", cookie), "run_valid"),
      await handlers.bootstrap(request("bootstrap?extra=1", undefined, {})),
      await handlers.createConversation(request("conversations?extra=1", cookie, {})),
    ]) {
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "malformed_input", message: "Malformed input." });
    }
  });

  test("redacts unavailable database errors and reports explicit demo modes without provider success", async () => {
    const { repository, handlers } = setup();
    const cookie = `travel_owner=${repository.createOwner().credential}`;
    repository.close();
    const failure = await handlers.listTrips(request("trips", cookie));
    expect(failure.status).toBe(500);
    expect(failure.headers.get("cache-control")).toBe("no-store");
    expect(await failure.json()).toEqual({ code: "internal_error", message: "An internal error occurred." });
    for (const mode of ["fake", "fixture"] as const) {
      const db = setup().repository;
      const demo = createLibraryHandlers({ repository: () => db, appOrigin: origin, mode });
      expect(await (await demo.bootstrap(request("bootstrap", undefined, {}))).json()).toEqual({
        mode, library: { conversations: [], trips: [] },
        capabilities: { planning: { status: "unavailable", reason: "integration_unavailable" } },
      });
    }
  });

  test("keeps the existing identity and reads its created Conversation", async () => {
    const { handlers } = setup();
    const bootstrap = await handlers.bootstrap(request("bootstrap", undefined, {}));
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    const created = await handlers.createConversation(request("conversations", cookie, {}));
    expect(created.status).toBe(201);
    const { conversation } = await created.json();
    const repeated = await handlers.bootstrap(request("bootstrap", cookie, {}));
    expect(repeated.headers.get("set-cookie")).toBeNull();
    expect(await repeated.json()).toMatchObject({ library: { conversations: [conversation], trips: [] } });
    expect(await (await handlers.listConversations(request("conversations", cookie))).json())
      .toEqual({ conversations: [conversation] });
    expect(await (await handlers.listMessages(request("messages", cookie), conversation.id)).json())
      .toEqual({ messages: [] });
    expect(await (await handlers.listTrips(request("trips", cookie))).json()).toEqual({ trips: [] });
  });

  test("never replaces malformed, unknown, duplicate or expired credentials", async () => {
    let clock = new Date("2026-09-08T00:00:00.000Z");
    const { repository, handlers } = setup(() => clock);
    const owner = repository.createOwner();
    const unknown = setup().repository.createOwner();
    clock = new Date(owner.expiresAt);
    for (const cookie of [
      "travel_owner=bad", `travel_owner=${unknown.credential}`, `travel_owner=${owner.credential}`,
      `travel_owner=${owner.credential}; travel_owner=${owner.credential}`,
    ]) {
      const response = await handlers.bootstrap(request("bootstrap", cookie, {}));
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "invalid_credential", message: "Invalid credential." });
    }
  });

  test("rejects extra body fields before creating a Conversation and admits only same-origin JSON", async () => {
    const { repository, handlers } = setup();
    const { credential } = repository.createOwner();
    const cookie = `travel_owner=${credential}`;
    for (const body of [{ extra: true }, { ownerId: "forged" }, [], null]) {
      expect((await handlers.createConversation(request("conversations", cookie, body))).status).toBe(400);
      expect((await handlers.bootstrap(request("bootstrap", undefined, body))).status).toBe(400);
    }
    const foreign = new Request(`${origin}/api/conversations`, {
      method: "POST", headers: { origin: "https://foreign.example", "content-type": "application/json", cookie },
      body: "{}",
    });
    expect((await handlers.createConversation(foreign)).status).toBe(403);
    expect(repository.listConversations(credential)).toEqual([]);
  });

  test("bootstraps an empty live library without claiming planning capability or exposing identity", async () => {
    const { handlers } = setup();
    const response = await handlers.bootstrap(request("bootstrap", undefined, {}));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toMatch(
      /^travel_owner=[A-Za-z0-9_-]{43}; Path=\/; Expires=.+; HttpOnly; Secure; SameSite=Strict$/,
    );
    expect(await response.json()).toEqual({
      mode: "live", library: { conversations: [], trips: [] },
      capabilities: { planning: { status: "unavailable", reason: "integration_unavailable" } },
    });
  });
});
