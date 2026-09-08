import { describe, expect, it } from "vitest";
import { committedItinerarySnapshotSchema, scheduleInputSchema } from "../src/domain/canonical";
import { scheduleItinerary } from "../src/domain/schedule";
import { validateItinerary } from "../src/domain/validation";
import { committedSnapshotFixture, scheduleFixture } from "./schedule-fixtures";

function localFixture() {
  const input = scheduleFixture();
  const first = committedSnapshotFixture();
  const base = committedItinerarySnapshotSchema.parse({ ...first,
    brief: { ...first.brief, requestedDayCount: 2, explicitlyFreeDayIndices: [2] },
    itinerary: { ...first.itinerary, days: [...first.itinerary.days, {
      ...first.itinerary.days[0], id: "day_free", dayIndex: 2, date: "2026-10-02", explicitlyFree: true,
      window: { startMinute: 540, endMinute: 1080 }, visits: [], legs: [], boundaryTransfers: [], scheduleBlocks: [], notices: [],
    }] },
  });
  return scheduleInputSchema.parse({ ...input, base,
    brief: base.brief,
    draft: { ...input.draft, baseVersionId: base.id, days: [...input.draft.days, { id: "day_free", dayIndex: 2, visits: [] }] },
    candidateSet: { ...input.candidateSet, baseVersionId: base.id },
    dayModes: [...input.dayModes, { dayId: "day_free", mode: "walk" }],
    scope: { kind: "local", dayIds: ["day_free"] },
  });
}

describe("local frozen scope", () => {
  it("preserves the unaffected day's exact content and facts", () => {
    const context = localFixture();
    const result = scheduleItinerary(context);
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    expect(result.itinerary.days[0]).toEqual(context.base!.itinerary.days[0]);
    expect(validateItinerary({ candidate: result.itinerary, context }).commitEligible).toBe(true);
  });

  it("does not replace retained routes with refreshed cache records", () => {
    const input = localFixture();
    const context = scheduleInputSchema.parse({ ...input, routes: [{ ...input.routes[0], factRevision: 2, freshness: "stale" }] });
    const result = scheduleItinerary(context);
    expect(result.status).toBe("blocked");
    expect(result.report.issues.some(issue => issue.code === "scope.frozen_fact_missing")).toBe(true);
  });

  it("rejects out-of-scope ledger or notice changes even if the modified timeline looks valid", () => {
    const context = localFixture();
    const candidate = { ...context.base!.itinerary, baseVersionId: context.base!.id,
      days: context.base!.itinerary.days.map((day, index) => index ? day : { ...day, notices: [] }),
    };
    expect(validateItinerary({ candidate, context }).issues.some(issue => issue.code === "scope.changed_day")).toBe(true);
  });
});
