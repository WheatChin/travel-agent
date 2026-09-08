import { z } from "zod";

import { placeIdSchema, transportModeSchema } from "./contracts";
import { policyOverrideSchema } from "./policy";

const text = z.string().trim().min(1);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]+(?:-[a-z0-9]+)*$`));
const date = z.iso.date();
const minute = z.number().int().min(0).max(1440);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const candidateSchema = z.object({ placeId: placeIdSchema, label: text }).strict().readonly();
const destinationSchema = z.discriminatedUnion("status", [
  z.object({ query: text.nullable(), status: z.literal("missing"), candidates: z.tuple([]) }).strict(),
  z.object({ query: text, status: z.literal("unresolved"), candidates: z.array(candidateSchema).readonly() }).strict(),
  z.object({ query: text, status: z.literal("ambiguous"), candidates: z.array(candidateSchema).min(2).readonly() }).strict(),
  z.object({ query: text, status: z.literal("resolved"), candidates: z.array(candidateSchema).readonly(), cityId: id("city"), administrativeAreaIds: z.array(id("area")).min(1).readonly(), timeZone: text }).strict(),
]);
const referenceSchema = z.object({
  id: id("reference"), role: z.enum(["must_visit", "start", "end"]), query: text,
  status: z.enum(["unresolved", "ambiguous", "resolved"]), placeId: placeIdSchema.nullable(),
  candidates: z.array(candidateSchema).readonly(), dayIndex: z.number().int().positive().nullable(),
}).strict().readonly();

export const hardConstraintSchema = z.discriminatedUnion("type", [
  z.object({ id: id("constraint"), type: z.literal("must_visit"), placeId: placeIdSchema }).strict(),
  z.object({ id: id("constraint"), type: z.literal("excluded_place"), placeId: placeIdSchema }).strict(),
  z.object({ id: id("constraint"), type: z.literal("fixed_visit_start"), visitId: id("visit"), dayIndex: z.number().int().positive(), startMinute: minute }).strict(),
  z.object({ id: id("constraint"), type: z.literal("allowed_day_window"), dayIndex: z.number().int().positive(), startMinute: minute, endMinute: minute }).strict(),
  z.object({ id: id("constraint"), type: z.literal("verified_fact"), placeId: placeIdSchema, field: z.enum(["admission", "accessibility"]) }).strict(),
  z.object({ id: id("constraint"), type: z.literal("max_walking"), durationMinutes: z.number().int().positive().nullable(), distanceMeters: z.number().int().positive().nullable() }).strict(),
  z.object({ id: id("constraint"), type: z.literal("visit_count"), dayIndex: z.number().int().positive(), minimum: z.number().int().nonnegative().nullable(), maximum: z.number().int().nonnegative().nullable() }).strict(),
  z.object({ id: id("constraint"), type: z.literal("max_visits"), dayIndex: z.number().int().positive(), count: z.number().int().nonnegative() }).strict(),
  z.object({ id: id("constraint"), type: z.literal("transport_modes"), modes: z.array(transportModeSchema).min(1).readonly() }).strict(),
  z.object({ id: id("constraint"), type: z.literal("unresolved"), description: text }).strict(),
]).transform(deepFreeze);

export const assumptionSchema = z.object({ key: text, field: text, dayIndex: z.number().int().positive().nullable(), value: z.union([text, z.number(), z.boolean(), z.array(text)]), policyVersion: text, ownerOverridden: z.boolean() }).strict().readonly().transform(deepFreeze);
const boundarySchema = z.object({ dayIndex: z.number().int().positive(), startRequired: z.boolean(), startReferenceId: id("reference").nullable(), endRequired: z.boolean(), endReferenceId: id("reference").nullable() }).strict().readonly();
const durationOverrideSchema = z.object({ placeId: placeIdSchema, visitId: id("visit").optional(), durationMinutes: z.number().int().min(1).max(1439) }).strict().readonly();
const preferencesSchema = z.object({ pace: z.enum(["relaxed", "balanced", "brisk"]).nullable(), transportModes: z.array(transportModeSchema).readonly(), interests: z.array(text).readonly(), companions: text.nullable() }).strict().readonly();
const dayWindowsSchema = z.array(z.object({ dayIndex: z.number().int().positive(), startMinute: minute, endMinute: minute }).strict().readonly()).readonly();
const boundariesSchema = z.array(boundarySchema).readonly();
const durationOverridesSchema = z.array(durationOverrideSchema).superRefine((values, ctx) => {
  const bindings = new Map<string, typeof values[number]>();
  for (const [index, value] of values.entries()) {
    const key = value.visitId === undefined ? `place:${value.placeId}` : `visit:${value.visitId}`;
    const previous = bindings.get(key);
    if (previous && (previous.placeId !== value.placeId || previous.durationMinutes !== value.durationMinutes)) {
      ctx.addIssue({ code: "custom", path: [index], message: "Contradictory duration overrides for the same binding" });
    }
    bindings.set(key, value);
  }
}).readonly();
const placeIdsSchema = z.array(placeIdSchema).readonly();
const dayIndicesSchema = z.array(z.number().int().positive()).readonly();
const policyOverridesSchema = z.array(policyOverrideSchema).readonly();
const assumptionsSchema = z.array(assumptionSchema).readonly();

export const briefStateSchema = z.object({
  revision: z.number().int().nonnegative(), destination: destinationSchema,
  requestedDayCount: z.number().int().nullable(), startDate: date.nullable(), endDate: date.nullable(),
  exactDateVerificationRequired: z.boolean(), references: z.array(referenceSchema).readonly(),
  hardConstraints: z.array(hardConstraintSchema).readonly(),
  preferences: preferencesSchema, dayWindows: dayWindowsSchema,
  boundaries: boundariesSchema, durationOverrides: durationOverridesSchema,
  allowedRepeatedPlaceIds: placeIdsSchema, explicitlyFreeDayIndices: dayIndicesSchema,
  excludedPlaceIds: placeIdsSchema, acceptedPolicyOverrides: policyOverridesSchema, assumptions: assumptionsSchema,
}).strict().readonly().transform(deepFreeze);

const patchable = <T extends z.ZodType>(schema: T) => z.discriminatedUnion("operation", [z.object({ operation: z.literal("set"), value: schema }).strict(), z.object({ operation: z.literal("clear") }).strict()]);
export const briefPatchSchema = z.object({
  destination: patchable(destinationSchema).optional(), requestedDayCount: patchable(z.number().int()).optional(), startDate: patchable(date).optional(), endDate: patchable(date).optional(),
  exactDateVerificationRequired: patchable(z.boolean()).optional(), references: patchable(z.array(referenceSchema).readonly()).optional(), hardConstraints: patchable(z.array(hardConstraintSchema).readonly()).optional(),
  preferences: patchable(preferencesSchema).optional(), dayWindows: patchable(dayWindowsSchema).optional(), boundaries: patchable(boundariesSchema).optional(),
  durationOverrides: patchable(durationOverridesSchema).optional(), allowedRepeatedPlaceIds: patchable(placeIdsSchema).optional(), explicitlyFreeDayIndices: patchable(dayIndicesSchema).optional(),
  excludedPlaceIds: patchable(placeIdsSchema).optional(), acceptedPolicyOverrides: patchable(policyOverridesSchema).optional(), assumptions: patchable(assumptionsSchema).optional(),
}).strict().readonly().transform(deepFreeze);

export type BriefState = z.infer<typeof briefStateSchema>;
export type BriefPatch = z.infer<typeof briefPatchSchema>;
export type RequirementContext = Readonly<{ issueRevision: number; supportedCityIds: readonly string[]; supportedTransportModes: readonly z.infer<typeof transportModeSchema>[]; lockedDayIndices: readonly number[]; resolvedPlaces: readonly Readonly<{ placeId: string; administrativeAreaId: string }>[] }>;
export type CanonicalRequirementIssue = Readonly<{ id: string; revision: number; kind: "missing" | "ambiguous" | "unsupported" | "conflict"; field: string; rule: string; target: string; message: string; blocking: true; options: readonly string[] }>;
export type RequirementAssessment = Readonly<{ blockingIssues: readonly CanonicalRequirementIssue[]; assumptions: BriefState["assumptions"]; warnings: readonly string[]; effectiveDayCount: number | null; effectiveEndDate: string | null }>;

const leapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthDays = (year: number, month: number) => [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

// Gregorian calendar ordinals, not elapsed time or UTC timestamps.
function calendarOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  let ordinal = 365 * year + Math.floor((year + 3) / 4) - Math.floor((year + 99) / 100) + Math.floor((year + 399) / 400) + day;
  for (let previous = 1; previous < month; previous++) ordinal += monthDays(year, previous);
  return ordinal;
}

function inferredEndDate(start: string | null, count: number | null): string | null {
  if (start === null || count === null || count < 1 || count > 7) return null;
  let [year, month, day] = start.split("-").map(Number);
  // Count is checked before iteration, so unsupported requests never expand.
  for (let remaining = count - 1; remaining > 0; remaining--) {
    day++;
    if (day > monthDays(year, month)) { day = 1; month++; }
    if (month > 12) { month = 1; year++; }
  }
  if (year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const cleared: Record<keyof Omit<BriefState, "revision">, unknown> = { destination: { query: null, status: "missing", candidates: [] }, requestedDayCount: null, startDate: null, endDate: null, exactDateVerificationRequired: false, references: [], hardConstraints: [], preferences: { pace: null, transportModes: [], interests: [], companions: null }, dayWindows: [], boundaries: [], durationOverrides: [], allowedRepeatedPlaceIds: [], explicitlyFreeDayIndices: [], excludedPlaceIds: [], acceptedPolicyOverrides: [], assumptions: [] };

export function reduceBrief(current: BriefState, patch: BriefPatch): { brief: BriefState; conflicts: readonly CanonicalRequirementIssue[] } {
  const next: Record<string, unknown> = { ...current };
  for (const [key, change] of Object.entries(patch)) next[key] = change.operation === "set" ? change.value : cleared[key as keyof typeof cleared];
  return { brief: briefStateSchema.parse(next), conflicts: [] };
}

export function assessRequirements(brief: BriefState, context: RequirementContext): RequirementAssessment {
  const issues: CanonicalRequirementIssue[] = [];
  const add = (rule: string, field: string, target: string, kind: CanonicalRequirementIssue["kind"], message: string, options: readonly string[] = []) => {
    if (issues.some(issue => issue.rule === rule && issue.target === target && issue.field === field)) return;
    issues.push({ id: `issue_${rule.replaceAll(".", "-")}-${target.replaceAll("_", "-")}`, revision: context.issueRevision, kind, field, rule, target, message, blocking: true, options });
  };
  if (brief.destination.status === "missing") add("destination.missing", "destination", "trip", "missing", "Destination is required");
  else if (brief.destination.status === "unresolved") add("destination.unresolved", "destination", "trip", "missing", "Destination must be resolved");
  else if (brief.destination.status === "ambiguous") add("destination.ambiguous", "destination", "trip", "ambiguous", "Destination is ambiguous", brief.destination.candidates.map(x => x.label));
  else if (brief.destination.status === "resolved" && !context.supportedCityIds.includes(brief.destination.cityId)) add("destination.unsupported", "destination", brief.destination.cityId, "unsupported", "Destination is outside supported scope");
  if (brief.requestedDayCount === null && !(brief.startDate && brief.endDate)) add("duration.missing", "duration", "trip", "missing", "Trip duration is required");
  let rangeDays: number | null = null;
  if (brief.startDate && brief.endDate && brief.startDate <= brief.endDate) {
    rangeDays = calendarOrdinal(brief.endDate) - calendarOrdinal(brief.startDate) + 1;
  }
  const effectiveDayCount = brief.requestedDayCount ?? rangeDays;
  const effectiveEndDate = brief.endDate ?? inferredEndDate(brief.startDate, brief.requestedDayCount);
  if (brief.startDate !== null && brief.endDate === null && brief.requestedDayCount !== null && brief.requestedDayCount >= 1 && brief.requestedDayCount <= 7 && effectiveEndDate === null) add("dates.unsupported_range", "dates", "trip", "unsupported", "Effective end date exceeds the supported calendar range");
  if ([effectiveDayCount, rangeDays].some(count => count !== null && (count < 1 || count > 7))) add("duration.unsupported", "duration", "trip", "unsupported", "Trip must be one to seven days");
  if (brief.exactDateVerificationRequired && (!brief.startDate || !effectiveEndDate)) add("dates.required_for_exact_verification", "dates", "trip", "missing", "Exact-date verification requires dates");
  if (brief.startDate && brief.endDate && brief.startDate > brief.endDate) add("dates.reversed", "dates", "trip", "conflict", "End date precedes start date");
  if (rangeDays !== null && brief.requestedDayCount !== null && rangeDays !== brief.requestedDayCount) add("dates.day_count_disagrees", "dates", "trip", "conflict", "Date range and day count disagree");
  for (const window of brief.dayWindows) if (window.startMinute >= window.endMinute) add("day_window.invalid", "dayWindows", `day-${window.dayIndex}`, "conflict", "Day window must end after it starts");
  for (const boundary of brief.boundaries) {
    if (boundary.startRequired && boundary.startReferenceId === null) add("boundary.start_missing", "boundaries", `day-${boundary.dayIndex}`, "missing", "Required daily start Place is missing");
    if (boundary.endRequired && boundary.endReferenceId === null) add("boundary.end_missing", "boundaries", `day-${boundary.dayIndex}`, "missing", "Required daily end Place is missing");
    for (const role of ["start", "end"] as const) {
      const referenceId = boundary[`${role}ReferenceId`];
      if (referenceId === null) continue;
      const reference = brief.references.find(item => item.id === referenceId);
      if (!reference || reference.status === "unresolved") add(`boundary.${role}_unresolved`, "boundaries", referenceId, "missing", `Requested ${role} Place is unresolved`, reference?.candidates.map(item => item.label) ?? []);
      else if (reference.status === "ambiguous") add(`boundary.${role}_ambiguous`, "boundaries", referenceId, "ambiguous", `Requested ${role} Place is ambiguous`, reference.candidates.map(item => item.label));
      if (reference && (reference.role !== role || (reference.dayIndex !== null && reference.dayIndex !== boundary.dayIndex))) add(`boundary.${role}_reference_mismatch`, "boundaries", `${referenceId}-day-${boundary.dayIndex}`, "conflict", "Boundary reference belongs to a different role or day");
    }
  }
  const windows = [
    ...brief.dayWindows,
    ...brief.hardConstraints.filter((item): item is Extract<BriefState["hardConstraints"][number], { type: "allowed_day_window" }> => item.type === "allowed_day_window"),
  ];
  const windowIntersections = new Map<number, { startMinute: number; endMinute: number }>();
  for (const window of windows) {
    if (window.startMinute >= window.endMinute) continue;
    const existing = windowIntersections.get(window.dayIndex);
    windowIntersections.set(window.dayIndex, {
      startMinute: Math.max(existing?.startMinute ?? 0, window.startMinute),
      endMinute: Math.min(existing?.endMinute ?? 1440, window.endMinute),
    });
  }
  for (const [day, window] of windowIntersections) if (window.startMinute >= window.endMinute) add("day_window.conflict", "dayWindows", `day-${day}`, "conflict", "Requested day windows do not intersect");
  const fixedStarts = new Map<string, { dayIndex: number; startMinute: number }>();
  for (const constraint of brief.hardConstraints) {
    if (constraint.type === "unresolved") add("hard_constraint.unsupported", "hardConstraints", constraint.id, "unsupported", "Hard Constraint is not enforceable");
    if (constraint.type === "transport_modes") for (const mode of constraint.modes) if (!context.supportedTransportModes.includes(mode)) add("transport.unsupported", "hardConstraints", mode, "unsupported", "Transport capability is unsupported");
    if (constraint.type === "allowed_day_window" && constraint.startMinute >= constraint.endMinute) add("hard_window.invalid", "hardConstraints", constraint.id, "conflict", "Allowed day window must end after it starts");
    if (constraint.type === "fixed_visit_start") {
      const window = windowIntersections.get(constraint.dayIndex);
      if (window && (constraint.startMinute < window.startMinute || constraint.startMinute >= window.endMinute)) add("fixed_visit.outside_window", "hardConstraints", constraint.id, "conflict", "Fixed Visit start is outside its allowed day window");
      const existing = fixedStarts.get(constraint.visitId);
      if (existing && (existing.dayIndex !== constraint.dayIndex || existing.startMinute !== constraint.startMinute)) add("fixed_visit.conflict", "hardConstraints", constraint.visitId, "conflict", "The same Visit has contradictory fixed starts");
      fixedStarts.set(constraint.visitId, constraint);
    }
  }
  for (const ref of brief.references) {
    const prefix = ref.role === "must_visit" ? "must_visit." : `boundary.${ref.role}_`;
    const field = ref.role === "must_visit" ? "references" : "boundaries";
    const grounded = context.resolvedPlaces.find(place => place.placeId === ref.placeId);
    if (ref.status === "ambiguous") add(`${prefix}ambiguous`, field, ref.id, "ambiguous", `Requested ${ref.role === "must_visit" ? "must-visit" : ref.role} Place is ambiguous`, ref.candidates.map(x => x.label));
    else if (ref.status === "unresolved" || !grounded) add(`${prefix}unresolved`, field, ref.id, "missing", `Requested ${ref.role === "must_visit" ? "must-visit" : ref.role} Place is unresolved`, ref.candidates.map(x => x.label));
    if (ref.status === "resolved" && grounded && brief.destination.status === "resolved" && !brief.destination.administrativeAreaIds.includes(grounded.administrativeAreaId)) add("place.outside_allowed_area", "references", ref.id, "conflict", "Requested Place is outside the allowed destination area");
  }
  const must = new Set([
    ...brief.hardConstraints.filter((x): x is Extract<typeof x, { type: "must_visit" }> => x.type === "must_visit").map(x => x.placeId),
    ...brief.references.flatMap(ref => ref.role === "must_visit" && ref.status === "resolved" && ref.placeId !== null ? [ref.placeId] : []),
  ]);
  for (const constraint of brief.hardConstraints) if (constraint.type === "must_visit" || constraint.type === "verified_fact") {
    const grounded = context.resolvedPlaces.find(place => place.placeId === constraint.placeId);
    if (!grounded) add("place.unresolved", "hardConstraints", constraint.id, "missing", "Required Place has no backing grounding facts");
    else if (brief.destination.status === "resolved" && !brief.destination.administrativeAreaIds.includes(grounded.administrativeAreaId)) add("place.outside_allowed_area", "hardConstraints", constraint.id, "conflict", "Required Place is outside the allowed destination area");
  }
  const excluded = new Set([...brief.excludedPlaceIds, ...brief.hardConstraints.filter((x): x is Extract<typeof x, { type: "excluded_place" }> => x.type === "excluded_place").map(x => x.placeId)]);
  for (const place of must) if (excluded.has(place)) add("place.must_visit_excluded", "hardConstraints", place, "conflict", "Place is both required and excluded");
  const density = new Map<number, { minimum: number; maximum: number | null }>();
  for (const constraint of brief.hardConstraints) if (constraint.type === "visit_count" || constraint.type === "max_visits") {
    const bounds = density.get(constraint.dayIndex) ?? { minimum: 0, maximum: null };
    const maximum = constraint.type === "max_visits" ? constraint.count : constraint.maximum;
    density.set(constraint.dayIndex, {
      minimum: Math.max(bounds.minimum, constraint.type === "visit_count" ? constraint.minimum ?? 0 : 0),
      maximum: maximum === null ? bounds.maximum : bounds.maximum === null ? maximum : Math.min(bounds.maximum, maximum),
    });
  }
  for (const [day, bounds] of density) if (bounds.maximum !== null && bounds.minimum > bounds.maximum) add("density.conflict", "hardConstraints", `day-${day}`, "conflict", "Requested density exceeds hard visit limit");
  if (effectiveDayCount !== null && effectiveDayCount >= 1 && effectiveDayCount <= 7) {
    for (const day of context.lockedDayIndices) if (day > effectiveDayCount) add("duration.locked_day_removed", "duration", `day-${day}`, "conflict", "Shortening would remove a locked day");
    for (const constraint of brief.hardConstraints) if (constraint.type === "fixed_visit_start" && constraint.dayIndex > effectiveDayCount) add("fixed_visit.day_removed", "hardConstraints", constraint.id, "conflict", "Fixed Visit requires a day outside the retained Trip");
    for (const reference of brief.references) if (reference.dayIndex !== null && reference.dayIndex > effectiveDayCount) add("reference.day_removed", "references", reference.id, "conflict", "Requested Place requires a day outside the retained Trip");
  }
  issues.sort((a, b) => a.field.localeCompare(b.field) || a.rule.localeCompare(b.rule) || a.target.localeCompare(b.target));
  const generated = [...brief.assumptions];
  const assume = (key: string, field: string, value: string | number | boolean | string[]) => {
    if (!generated.some(item => item.field === field)) generated.push({ key, field, dayIndex: null, value, policyVersion: "schedule-mvp-v1", ownerOverridden: false });
  };
  if (!brief.startDate && !brief.endDate) assume("dates-undated", "dates", "undated proposal");
  if (brief.dayWindows.length === 0) assume("day-window-default", "dayWindows", "09:00-18:00");
  if (brief.preferences.pace === null) assume("pace-balanced", "preferences.pace", "balanced");
  if (brief.preferences.transportModes.length === 0) assume("transport-default", "preferences.transportModes", ["walk", "public_transit"]);
  if (brief.preferences.companions === null) assume("companions-unspecified", "preferences.companions", "unspecified");
  assume("budget-unspecified", "budget", "unspecified");
  assume("meals-time-only", "meals", "time reservations only");
  assume("lodging-not-generated", "lodging", "not generated");
  if (brief.boundaries.length === 0 && !brief.references.some(reference => reference.role === "start" || reference.role === "end")) assume("boundaries-attractions-only", "boundaries", "starts at the first attraction and ends at the last; airport/hotel transfers are not included");
  return deepFreeze({ blockingIssues: issues, assumptions: generated, warnings: [], effectiveDayCount, effectiveEndDate });
}
