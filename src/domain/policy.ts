import { z } from "zod";
import { transportModeSchema } from "./contracts";

const minute = z.number().int().min(0).max(1439);
const allowance = z.number().int().min(0).max(1439);
const stay = z.number().int().min(1).max(1439);
const limits = z.object({
  visits: z.number().int().nonnegative(),
  walkingMinutes: z.number().int().nonnegative(),
  walkingMeters: z.number().int().nonnegative(),
  longestWalkingMinutes: z.number().int().nonnegative(),
}).strict();
const window = z.object({ startMinute: minute, endMinute: minute }).strict()
  .refine(value => value.startMinute < value.endMinute, "Window must have positive length");
const lunch = z.object({ enabled: z.boolean(), startMinute: minute, durationMinutes: stay }).strict()
  .refine(value => value.startMinute + value.durationMinutes <= 1439, "Lunch must fit within the day");
const rest = z.object({ everyVisits: z.number().int().positive(), durationMinutes: allowance }).strict();
const modeAllowances = z.object({ walk: allowance, bicycle: allowance, public_transit: allowance, taxi: allowance, drive: allowance }).strict();
const breakSchema = z.object({ id: z.string().regex(/^break_[a-z0-9]+(?:-[a-z0-9]+)*$/), startMinute: minute, endMinute: minute }).strict()
  .refine(value => value.startMinute < value.endMinute, "Break must have positive length");

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const policyOverrideSchema = z.object({
  id: z.string().regex(/^override_[a-z0-9]+(?:-[a-z0-9]+)*$/),
  origin: z.literal("owner"),
  dayIndex: z.number().int().min(1).max(7).nullable(),
  settings: z.object({
    stayMinutes: stay.optional(),
    window: window.optional(),
    lunch: lunch.optional(),
    rest: rest.optional(),
    entryBufferMinutes: allowance.optional(),
    transferBufferMinutes: modeAllowances.optional(),
    softLimits: limits.optional(),
    breaks: z.array(breakSchema).optional(),
  }).strict().refine(value => Object.keys(value).length > 0, "Override must contain a setting"),
}).strict().transform(freeze);

export const schedulePolicySchema = z.object({
  id: z.literal("schedule-mvp-v1"),
  source: z.literal("product_policy"),
  fixtureRevision: z.literal("schedule-fixtures-v1"),
  window,
  stayMinutes: z.object({ relaxed: stay, balanced: stay, brisk: stay }).strict(),
  selectionTargets: z.object({ relaxed: z.number().int().positive(), balanced: z.number().int().positive(), brisk: z.number().int().positive() }).strict(),
  softLimits: z.object({ relaxed: limits, balanced: limits, brisk: limits }).strict(),
  lunch,
  rest,
  entryBufferMinutes: allowance,
  transferBufferMinutes: modeAllowances,
  defaultTransportModes: z.array(transportModeSchema).min(1),
}).strict().transform(freeze);

export const effectiveDayPolicySchema = z.object({
  policyVersion: z.literal("schedule-mvp-v1"),
  source: z.literal("product_policy"),
  pace: z.enum(["relaxed", "balanced", "brisk"]),
  window,
  stayMinutes: stay,
  selectionTarget: z.number().int().positive(),
  softLimits: limits,
  lunch,
  rest,
  entryBufferMinutes: allowance,
  transferBufferMinutes: modeAllowances,
  breaks: z.array(breakSchema),
  overrides: z.array(policyOverrideSchema),
}).strict().transform(freeze);

export type SchedulePolicy = z.infer<typeof schedulePolicySchema>;
export type PolicyOverride = z.infer<typeof policyOverrideSchema>;
export type EffectiveDayPolicy = z.infer<typeof effectiveDayPolicySchema>;

export const SCHEDULE_POLICY = schedulePolicySchema.parse({
  id: "schedule-mvp-v1", source: "product_policy", fixtureRevision: "schedule-fixtures-v1",
  window: { startMinute: 540, endMinute: 1080 },
  stayMinutes: { relaxed: 120, balanced: 90, brisk: 60 },
  selectionTargets: { relaxed: 2, balanced: 3, brisk: 4 },
  softLimits: {
    relaxed: { visits: 3, walkingMinutes: 60, walkingMeters: 4000, longestWalkingMinutes: 30 },
    balanced: { visits: 5, walkingMinutes: 120, walkingMeters: 8000, longestWalkingMinutes: 45 },
    brisk: { visits: 7, walkingMinutes: 180, walkingMeters: 12000, longestWalkingMinutes: 60 },
  },
  lunch: { enabled: true, startMinute: 720, durationMinutes: 45 },
  rest: { everyVisits: 2, durationMinutes: 15 },
  entryBufferMinutes: 10,
  transferBufferMinutes: { walk: 0, bicycle: 0, public_transit: 5, taxi: 5, drive: 5 },
  defaultTransportModes: ["walk", "public_transit"],
});

// Internal policy resolution shared by the two pure domain entry points.
export function effectivePolicy(policy: SchedulePolicy, overrides: readonly PolicyOverride[], pace: EffectiveDayPolicy["pace"], dayIndex: number): EffectiveDayPolicy {
  const selected = overrides.filter(value => value.dayIndex === null || value.dayIndex === dayIndex);
  const result = {
    policyVersion: policy.id, source: policy.source, pace, window: policy.window,
    stayMinutes: policy.stayMinutes[pace], selectionTarget: policy.selectionTargets[pace],
    softLimits: policy.softLimits[pace], lunch: policy.lunch, rest: policy.rest,
    entryBufferMinutes: policy.entryBufferMinutes, transferBufferMinutes: policy.transferBufferMinutes,
    breaks: [] as z.infer<typeof breakSchema>[], overrides: selected,
  };
  // Trip settings precede day settings. Conflicting same-scope settings are rejected at the gate.
  for (const override of [...selected].sort((a, b) => Number(a.dayIndex !== null) - Number(b.dayIndex !== null) || a.id.localeCompare(b.id))) Object.assign(result, override.settings);
  return effectiveDayPolicySchema.parse(result);
}
