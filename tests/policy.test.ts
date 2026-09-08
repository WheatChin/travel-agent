import { describe, expect, it } from "vitest";
import { schedulePolicySchema, SCHEDULE_POLICY, policyOverrideSchema } from "../src/domain/policy";

describe("schedule-mvp-v1 policy", () => {
  it("pins the approved product defaults, not external travel facts", () => {
    expect(SCHEDULE_POLICY.source).toBe("product_policy");
    expect(SCHEDULE_POLICY.stayMinutes).toEqual({ relaxed: 120, balanced: 90, brisk: 60 });
    expect(SCHEDULE_POLICY.lunch).toEqual({ enabled: true, startMinute: 720, durationMinutes: 45 });
    expect(SCHEDULE_POLICY.rest).toEqual({ everyVisits: 2, durationMinutes: 15 });
    expect(SCHEDULE_POLICY.entryBufferMinutes).toBe(10);
    expect(SCHEDULE_POLICY.transferBufferMinutes).toEqual({ walk: 0, bicycle: 0, public_transit: 5, taxi: 5, drive: 5 });
    expect(Object.isFrozen(SCHEDULE_POLICY.lunch)).toBe(true);
  });

  it("requires explicit override origin, scope and supported settings", () => {
    expect(policyOverrideSchema.safeParse("disable lunch").success).toBe(false);
    expect(policyOverrideSchema.safeParse({ id: "override_lunch", origin: "owner", dayIndex: 1, settings: { lunch: { enabled: false, startMinute: 720, durationMinutes: 45 } } }).success).toBe(true);
    expect(policyOverrideSchema.safeParse({ id: "override_stay", origin: "owner", dayIndex: null, settings: { stayMinutes: 0 } }).success).toBe(false);
    expect(schedulePolicySchema.safeParse({ ...SCHEDULE_POLICY, speedKph: 5 }).success).toBe(false);
  });
});
