import { describe, expect, it } from "vitest";

import {
  itineraryReadModelSchema,
  itineraryVersionSchema,
  turnEventSchema,
  turnInputSchema,
  typedCommandSchema,
  viewSelectionSchema,
} from "../src/domain/contracts";
import { beijingFixture } from "../src/fixtures/beijing";

const baseline = {
  conversationId: "conversation_beijing-cultural",
  turnId: "turn_example-1",
  targetTripId: "trip_beijing-cultural",
  baseVersionId: "version_beijing-3day-v1",
  baseBriefRevision: 1,
} as const;

const eventBase = {
  id: "event_example-1",
  sequence: 1,
  occurredAt: "2026-09-08T10:00:00+08:00",
  runId: "run_example-1",
  turnId: "turn_example-1",
} as const;

describe("Beijing fixture", () => {
  it("has the exact stable top-level shape and parses as an itinerary version", () => {
    expect(itineraryVersionSchema.parse(beijingFixture)).toEqual(beijingFixture);
    expect(Object.keys(beijingFixture)).toEqual([
      "id",
      "tripId",
      "conversationId",
      "title",
      "destination",
      "dateStart",
      "dayCount",
      "briefRevision",
      "provenance",
      "days",
      "places",
      "evidence",
      "assumptions",
      "warnings",
    ]);
    expect(beijingFixture.days).toHaveLength(3);
    expect(beijingFixture.places).toHaveLength(6);
    expect(beijingFixture.days.map((day) => day.dayIndex)).toEqual([1, 2, 3]);
    expect(beijingFixture.days[2]?.title).toBe("园林与遗址");
    expect(beijingFixture.days.every((day) => day.visits.length >= 2)).toBe(true);
  });

  it("is deeply frozen", () => {
    const pending: unknown[] = [beijingFixture];

    while (pending.length > 0) {
      const value = pending.pop();
      if (value !== null && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        pending.push(...Object.values(value));
      }
    }

    expect(
      Reflect.set(beijingFixture as unknown as Record<string, unknown>, "title", "changed"),
    ).toBe(false);
    expect(beijingFixture.title).toBe("北京三日文化之旅");
  });

  it("does not claim provider-confirmed coordinates, routes, or evidence", () => {
    expect(beijingFixture.places.every((place) => place.coordinates === null)).toBe(true);
    expect(
      beijingFixture.days
        .flatMap((day) => day.legs)
        .every(
          (leg) =>
            leg.durationMinutes === null &&
            leg.distanceMeters === null &&
            leg.geometry === null &&
            leg.provenance === "fixture",
        ),
    ).toBe(true);
    expect(
      beijingFixture.evidence.every(
        (evidence) =>
          evidence.status === "fixture" &&
          evidence.url === null &&
          evidence.retrievedAt === null,
      ),
    ).toBe(true);
  });

  it("rejects malformed IDs and unknown snapshot fields", () => {
    expect(
      itineraryVersionSchema.safeParse({ ...beijingFixture, id: "not-an-id" }).success,
    ).toBe(false);
    expect(
      itineraryVersionSchema.safeParse({ ...beijingFixture, ownerId: "owner_forged" })
        .success,
    ).toBe(false);
  });

  it("rejects calendar-invalid ISO dates", () => {
    expect(
      itineraryVersionSchema.safeParse({ ...beijingFixture, dateStart: "2026-13-01" })
        .success,
    ).toBe(false);
    expect(
      itineraryVersionSchema.safeParse({ ...beijingFixture, dateStart: "2025-02-29" })
        .success,
    ).toBe(false);
    expect(
      itineraryVersionSchema.safeParse({ ...beijingFixture, dateStart: "2028-02-29" })
        .success,
    ).toBe(true);
  });
});

describe("Typed Commands", () => {
  const commands = [
    { type: "remove_visit", visitId: "visit_forbidden-city" },
    {
      type: "move_visit",
      visitId: "visit_forbidden-city",
      toDayId: "day_beijing-2",
      toIndex: 1,
    },
    { type: "set_visit_lock", visitId: "visit_forbidden-city", locked: true },
    {
      type: "update_visit_duration",
      visitId: "visit_forbidden-city",
      durationMinutes: 120,
    },
    { type: "update_day_start_time", dayId: "day_beijing-1", startTime: "08:30" },
    {
      type: "update_day_transport_mode",
      dayId: "day_beijing-1",
      mode: "public_transit",
    },
    {
      type: "replace_visit",
      visitId: "visit_forbidden-city",
      candidateId: "candidate_palace-museum-alternative",
    },
    { type: "regenerate_day", dayId: "day_beijing-2" },
    { type: "cancel_run", runId: "run_example-1" },
    { type: "retry_run", runId: "run_example-1" },
  ] as const;

  it.each(commands)("accepts $type", (command) => {
    expect(typedCommandSchema.safeParse(command).success).toBe(true);
  });

  it("rejects malformed payloads, unknown command fields, and unsupported commands", () => {
    expect(
      typedCommandSchema.safeParse({
        type: "update_visit_duration",
        visitId: "visit_forbidden-city",
        durationMinutes: 0,
      }).success,
    ).toBe(false);
    expect(
      typedCommandSchema.safeParse({
        type: "remove_visit",
        visitId: "visit_forbidden-city",
        ownerId: "owner_forged",
      }).success,
    ).toBe(false);
    expect(typedCommandSchema.safeParse({ type: "book_hotel" }).success).toBe(false);
  });
});

describe("Turn envelope", () => {
  it("accepts a command with the required client-observed baseline", () => {
    expect(
      turnInputSchema.safeParse({
        ...baseline,
        input: { type: "remove_visit", visitId: "visit_forbidden-city" },
      }).success,
    ).toBe(true);
  });

  it("requires both version and Brief revision baseline fields", () => {
    const { baseVersionId: _version, ...withoutVersion } = baseline;
    const { baseBriefRevision: _revision, ...withoutRevision } = baseline;

    expect(
      turnInputSchema.safeParse({
        ...withoutVersion,
        input: { type: "remove_visit", visitId: "visit_forbidden-city" },
      }).success,
    ).toBe(false);
    expect(
      turnInputSchema.safeParse({
        ...withoutRevision,
        input: { type: "remove_visit", visitId: "visit_forbidden-city" },
      }).success,
    ).toBe(false);
  });

  it("allows the explicit null creation baseline", () => {
    expect(
      turnInputSchema.safeParse({
        ...baseline,
        targetTripId: null,
        baseVersionId: null,
        baseBriefRevision: 0,
        input: { type: "user_message", text: "请规划北京三日游" },
      }).success,
    ).toBe(true);
  });

  it("rejects client Owner injection", () => {
    expect(
      turnInputSchema.safeParse({
        ...baseline,
        ownerId: "owner_forged",
        input: { type: "remove_visit", visitId: "visit_forbidden-city" },
      }).success,
    ).toBe(false);
  });
});

describe("SSE Turn events", () => {
  it("accepts no-change completion only with an existing version and fixed safe message", () => {
    const event = {
      ...eventBase, type: "run.no_change",
      versionId: "version_beijing-3day-v1", message: "Itinerary unchanged",
    };
    expect(turnEventSchema.parse(event)).toEqual(event);
    for (const invalid of [
      { ...event, versionId: null },
      { ...event, versionId: undefined },
      { ...event, message: "A new itinerary was generated" },
      { ...event, rawReasoning: "untrusted output" },
    ]) {
      expect(turnEventSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts discriminated event payloads with event-specific fields", () => {
    const events = [
      {
        ...eventBase,
        type: "run.started",
        versionId: null,
        message: "已开始规划。",
      },
      {
        ...eventBase,
        type: "requirements.checked",
        versionId: null,
        blockingIssueCount: 0,
        assumptionCount: 2,
        warningCount: 1,
        message: "需求检查完成。",
      },
      {
        ...eventBase,
        type: "run.needs_input",
        versionId: null,
        issueRevision: 1,
        issues: [
          {
            id: "issue_destination-1",
            revision: 1,
            kind: "missing",
            field: "destination",
            message: "请选择目的地。",
            blocking: true,
            options: [],
          },
        ],
        message: "需要补充目的地。",
      },
      {
        ...eventBase,
        type: "research.started",
        versionId: null,
        querySummary: "北京文化景点",
        message: "正在查找北京文化景点。",
      },
      {
        ...eventBase,
        type: "research.sources_found",
        versionId: null,
        evidenceIds: ["evidence_forbidden-city-fixture"],
        message: "已找到相关资料。",
      },
      {
        ...eventBase,
        type: "places.resolved",
        versionId: null,
        placeIds: ["place_forbidden-city"],
        message: "地点已确认。",
      },
      {
        ...eventBase,
        type: "itinerary.drafted",
        versionId: null,
        dayCount: 3,
        message: "三日行程草案已生成。",
      },
      {
        ...eventBase,
        type: "routing.started",
        versionId: null,
        legCount: 3,
        message: "正在查询行程路段。",
      },
      {
        ...eventBase,
        type: "validation.started",
        versionId: null,
        attempt: 1,
        message: "正在检查行程。",
      },
      {
        ...eventBase,
        type: "itinerary.repairing",
        versionId: null,
        attempt: 1,
        rationale: "第二天安排过密，正在调整。",
        message: "正在调整行程。",
      },
      {
        ...eventBase,
        type: "itinerary.completed",
        versionId: "version_beijing-3day-v1",
        message: "行程已完成。",
      },
      {
        ...eventBase,
        type: "run.degraded",
        versionId: "version_beijing-3day-v1",
        warnings: ["部分路线几何信息不可用。"],
        message: "行程已完成，但存在待确认信息。",
      },
      {
        ...eventBase,
        type: "run.failed",
        versionId: null,
        code: "fixture_rejected",
        message: "演示修改被拒绝。",
      },
      {
        ...eventBase,
        type: "run.cancelled",
        versionId: "version_beijing-3day-v1",
        reason: "旅行者取消了演示修改。",
        message: "修改已取消。",
      },
      {
        ...eventBase,
        type: "run.superseded",
        versionId: "version_beijing-3day-v1",
        replacementRunId: "run_example-2",
        message: "已有更新的规划任务。",
      },
    ];

    for (const event of events) {
      expect(turnEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("rejects missing event-specific fields", () => {
    expect(
      turnEventSchema.safeParse({
        ...eventBase,
        type: "requirements.checked",
        versionId: null,
        assumptionCount: 0,
        warningCount: 0,
        message: "需求检查完成。",
      }).success,
    ).toBe(false);
    expect(
      turnEventSchema.safeParse({
        ...eventBase,
        type: "itinerary.completed",
        versionId: null,
        message: "行程已完成。",
      }).success,
    ).toBe(false);
  });

  it("rejects raw reasoning and invented percentage fields", () => {
    expect(
      turnEventSchema.safeParse({
        ...eventBase,
        type: "research.started",
        versionId: null,
        querySummary: "北京文化景点",
        message: "正在查找北京文化景点。",
        rawReasoning: "hidden chain of thought",
      }).success,
    ).toBe(false);
    expect(
      turnEventSchema.safeParse({
        ...eventBase,
        type: "routing.started",
        versionId: null,
        legCount: 3,
        message: "正在查询行程路段。",
        percentage: 60,
      }).success,
    ).toBe(false);
  });
});

describe("Read model and selection", () => {
  const selection = {
    tripId: beijingFixture.tripId,
    versionId: beijingFixture.id,
    dayIndex: 0,
    selectedVisitId: null,
    selectedLegId: null,
    mode: "list",
  } as const;

  it("allows day zero for overview and shares one version", () => {
    expect(viewSelectionSchema.safeParse(selection).success).toBe(true);
    expect(
      itineraryReadModelSchema.safeParse({ version: beijingFixture, selection }).success,
    ).toBe(true);
  });

  it("rejects invalid selection enums and unknown fields", () => {
    expect(viewSelectionSchema.safeParse({ ...selection, dayIndex: -1 }).success).toBe(false);
    expect(viewSelectionSchema.safeParse({ ...selection, mode: "timeline" }).success).toBe(
      false,
    );
    expect(viewSelectionSchema.safeParse({ ...selection, ownerId: "owner_forged" }).success).toBe(
      false,
    );
  });
});
