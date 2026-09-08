import { z } from "zod";

import {
  candidateIdSchema,
  conversationIdSchema,
  coordinatesSchema,
  dayPlanIdSchema,
  evidenceIdSchema,
  itineraryVersionIdSchema,
  legIdSchema,
  placeIdSchema,
  runIdSchema,
  transportModeSchema,
  tripIdSchema,
  turnIdSchema,
  typedCommandSchema,
  visitIdSchema,
} from "./contracts";
import { assumptionSchema, briefStateSchema } from "./brief";
import { effectiveDayPolicySchema, schedulePolicySchema } from "./policy";

const text = z.string().trim().min(1);
const revision = z.number().int().positive();
const date = z.iso.date();
const timestamp = z.string().datetime({ offset: true });
const minute = z.number().int().min(0).max(1439);
const localId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9]+(?:-[a-z0-9]+)*$`));

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const groundedPlaceSchema = z
  .object({
    id: placeIdSchema,
    factRevision: revision,
    provider: text,
    providerPlaceId: text,
    name: text,
    cityId: localId("city"),
    administrativeAreaId: localId("area"),
    coordinates: coordinatesSchema,
  })
  .strict()
  .readonly().transform(deepFreeze);

const evidenceWindowSchema = z.object({ startMinute: minute, endMinute: minute }).strict()
  .refine(window => window.startMinute < window.endMinute, { message: "Opening windows must end after they start" });

const evidenceValueSchema = z.union([
  text,
  z.boolean(),
  z.number().finite(),
  z.array(text).readonly(),
  z.array(evidenceWindowSchema).readonly(),
]);

const isMinute = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439;
const isWindows = (value: unknown) => z.array(evidenceWindowSchema).safeParse(value).success;

export const evidenceFactSchema = z
  .object({
    id: evidenceIdSchema,
    revision,
    placeId: placeIdSchema,
    field: z.enum([
      "opening_windows",
      "closure_dates",
      "latest_entry",
      "reservation_requirements",
      "entry_conditions",
      "accessibility",
      "stay_duration",
    ]),
    value: evidenceValueSchema.nullable(),
    excerpt: text.nullable(),
    sourceUrl: z.url().nullable(),
    retrievedAt: timestamp.nullable(),
    applicableFrom: date.nullable(),
    applicableThrough: date.nullable(),
    status: z.enum(["known", "unknown", "conflicting"]),
    freshness: z.enum(["current", "stale", "not_applicable"]),
    sourceKind: z.enum(["external", "synthetic_fixture"]),
  })
  .strict()
  .superRefine((fact, ctx) => {
    if (fact.applicableFrom !== null && fact.applicableThrough !== null && fact.applicableFrom > fact.applicableThrough) {
      ctx.addIssue({ code: "custom", path: ["applicableThrough"], message: "Evidence applicability must not end before it starts" });
    }
    if (fact.status === "known" && fact.sourceKind === "external") {
      if (fact.sourceUrl === null) ctx.addIssue({ code: "custom", path: ["sourceUrl"], message: "Known external facts require a source URL" });
      if (fact.retrievedAt === null) ctx.addIssue({ code: "custom", path: ["retrievedAt"], message: "Known external facts require retrieval time" });
    }
    if (fact.status === "unknown" && fact.value !== null) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Unknown facts cannot carry a value" });
    }
    if (fact.status === "known" || fact.value !== null) {
      const valid =
        (fact.field === "opening_windows" && isWindows(fact.value)) ||
        (fact.field === "closure_dates" && Array.isArray(fact.value) && fact.value.every(value => typeof value === "string" && date.safeParse(value).success)) ||
        (fact.field === "latest_entry" && isMinute(fact.value)) ||
        (fact.field === "reservation_requirements" && (typeof fact.value === "boolean" || typeof fact.value === "string")) ||
        (fact.field === "entry_conditions" && Array.isArray(fact.value) && fact.value.every(value => typeof value === "string")) ||
        (fact.field === "accessibility" && (typeof fact.value === "boolean" || typeof fact.value === "string" || (Array.isArray(fact.value) && fact.value.every(value => typeof value === "string")))) ||
        (fact.field === "stay_duration" && typeof fact.value === "number" && Number.isInteger(fact.value) && fact.value > 0 && fact.value < 1440);
      if (!valid) ctx.addIssue({ code: "custom", path: ["value"], message: `Evidence value is incompatible with ${fact.field}` });
    }
  })
  .readonly().transform(deepFreeze);

export const groundedCandidateSchema = z
  .object({
    id: candidateIdSchema,
    placeId: placeIdSchema,
    placeFactRevision: revision,
    evidenceIds: z.array(evidenceIdSchema).readonly(),
    durationOptionIds: z.array(localId("duration")).readonly(),
  })
  .strict()
  .readonly().transform(deepFreeze);

const draftVisitObjectSchema = z.object({
    id: visitIdSchema,
    placeId: placeIdSchema,
    durationOptionId: localId("duration").nullable(),
    durationMinutes: z.number().int().positive().nullable(),
    locked: z.boolean(),
    evidenceIds: z.array(evidenceIdSchema).readonly(),
  }).strict();
const draftVisitSchema = draftVisitObjectSchema.readonly();

const draftDaySchema = z
  .object({ id: dayPlanIdSchema, dayIndex: z.number().int().positive(), visits: z.array(draftVisitSchema).readonly() })
  .strict()
  .readonly();

export const itineraryDraftSchema = z
  .object({
    kind: z.literal("draft"),
    tripId: tripIdSchema,
    runId: runIdSchema,
    baseVersionId: itineraryVersionIdSchema.nullable(),
    briefRevision: z.number().int().nonnegative(),
    days: z.array(draftDaySchema).min(1).max(7).readonly(),
  })
  .strict()
  .readonly().transform(deepFreeze);

export const bufferCoverageSchema = z.object({
  status: z.enum(["included", "excluded", "unknown"]),
  includedMinutes: z.number().int().nonnegative().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status !== "included" && value.includedMinutes !== null) ctx.addIssue({ code: "custom", message: "Only included coverage can specify included minutes" });
}).transform(deepFreeze);

export const effectiveBufferSchema = z.object({
  coverage: bufferCoverageSchema,
  allowanceMinutes: z.number().int().nonnegative(),
  additionalMinutes: z.number().int().nonnegative(),
  origin: z.enum(["owner", "policy"]),
  policyKey: text,
  overrideId: localId("override").nullable(),
}).strict().transform(deepFreeze);

export const durationOptionSchema = z.object({
  id: localId("duration"), placeId: placeIdSchema,
  evidenceId: evidenceIdSchema, evidenceRevision: revision,
  durationMinutes: z.number().int(),
  status: z.enum(["usable", "unusable"]),
  requiredMinimum: z.boolean(), entryCoverage: bufferCoverageSchema,
}).strict().transform(deepFreeze);

export const durationProvenanceSchema = z.object({
  origin: z.enum(["owner", "evidence", "policy"]),
  evidenceId: evidenceIdSchema.nullable(), evidenceRevision: revision.nullable(),
  durationOptionId: localId("duration").nullable(), policyKey: text.nullable(),
  overrideId: localId("override").nullable(), entryCoverage: bufferCoverageSchema,
}).strict().superRefine((value, ctx) => {
  const sourced = value.origin === "evidence";
  if (sourced ? value.evidenceId === null || value.evidenceRevision === null || value.durationOptionId === null || value.policyKey !== null || value.overrideId !== null
    : value.evidenceId !== null || value.evidenceRevision !== null || value.durationOptionId !== null) ctx.addIssue({ code: "custom", message: "Duration origin fields must identify exactly the claimed authority" });
  if (value.origin === "policy" && (value.policyKey !== "stayMinutes" || value.overrideId !== null)) ctx.addIssue({ code: "custom", message: "Policy stay must name the registered setting without an Owner override" });
}).transform(deepFreeze);

export const conditionResolutionSchema = z.object({
  evidenceId: evidenceIdSchema, evidenceRevision: revision,
  status: z.enum(["met", "unmet", "unknown"]),
}).strict().transform(deepFreeze);

export const routeFactSchema = z.object({
  id: localId("route"), factRevision: revision,
  fromPlaceId: placeIdSchema, toPlaceId: placeIdSchema,
  mode: transportModeSchema,
  status: z.enum(["confirmed", "unknown", "unreachable", "identity"]),
  durationMinutes: z.number().int().nonnegative().nullable(),
  zeroDurationConfirmed: z.boolean(),
  distanceMeters: z.number().int().nonnegative().nullable(),
  geometry: z.object({ coordinateSystem: z.enum(["GCJ-02", "WGS84"]), path: z.array(coordinatesSchema).min(2) }).strict().nullable(),
  provider: text.nullable(), retrievedAt: timestamp.nullable(),
  sourceKind: z.enum(["external", "synthetic_fixture", "code_identity"]),
  temporalBasis: z.enum(["time_independent", "departure_estimate", "current_estimate", "identity"]),
  freshness: z.enum(["current", "stale", "unknown"]),
  applicability: z.object({
    date: date.nullable(),
    departureWindow: z.object({ startMinute: minute, endMinute: minute }).strict().refine(value => value.startMinute < value.endMinute).nullable(),
  }).strict(),
  transferCoverage: bufferCoverageSchema,
  walking: z.object({
    durationMinutes: z.number().int().nonnegative().nullable(),
    distanceMeters: z.number().int().nonnegative().nullable(),
    longestSegmentMinutes: z.number().int().nonnegative().nullable(),
  }).strict(),
}).strict().superRefine((route, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (route.temporalBasis === "time_independent" && !["walk", "bicycle"].includes(route.mode)) invalid("Only walking and bicycle routes can claim time independence");
  if (route.temporalBasis === "departure_estimate" && (route.applicability.date === null || route.applicability.departureWindow === null)) invalid("Departure estimates require a date and departure window");
  if (route.status === "identity") {
    if (route.temporalBasis !== "identity" || route.freshness !== "current" || route.applicability.date !== null || route.applicability.departureWindow !== null || route.transferCoverage.status !== "excluded" || route.transferCoverage.includedMinutes !== null || route.zeroDurationConfirmed) invalid("Identity transfers have explicit timeless current code provenance and no included allowance");
    if (route.fromPlaceId !== route.toPlaceId || route.durationMinutes !== 0 || route.distanceMeters !== 0 || route.geometry !== null || route.sourceKind !== "code_identity" || route.provider !== null || route.retrievedAt !== null || route.walking.durationMinutes !== 0 || route.walking.distanceMeters !== 0 || route.walking.longestSegmentMinutes !== 0) invalid("Identity routes must be exact same-Place code-derived zero transfers");
  } else {
    if (route.temporalBasis === "identity") invalid("Only exact identity routes may claim identity temporal provenance");
    if (route.sourceKind === "code_identity") invalid("Provider routes cannot claim code identity");
    if (route.status === "confirmed" && (route.durationMinutes === null || route.provider === null)) invalid("Confirmed routes require provider and duration");
    if (route.status === "confirmed" && route.sourceKind === "external" && route.retrievedAt === null) invalid("External routes require retrieval provenance");
    if (route.durationMinutes === 0 && !route.zeroDurationConfirmed) invalid("Zero route duration must be provider confirmed");
    if (route.status !== "confirmed" && route.durationMinutes !== null) invalid("Unknown or unreachable routes cannot carry a confirmed duration");
  }
  if (route.geometry && route.geometry.path.some(point => point.coordinateSystem !== route.geometry!.coordinateSystem)) invalid("Geometry coordinate systems must agree");
}).transform(deepFreeze);

export const validationIssueSchema = z.object({
  code: text, severity: z.enum(["ERROR", "WARNING", "ASSUMPTION"]),
  field: text, targetId: text, message: text,
  disposition: z.enum(["owner_decision", "redraft", "reroute", "retry", "reject"]),
  factIds: z.array(text),
}).strict().transform(deepFreeze);

export const validationReportSchema = z.object({
  policyRevision: z.literal("validator-mvp-v1"),
  issues: z.array(validationIssueSchema),
  commitEligible: z.boolean(), degraded: z.boolean(),
}).strict().superRefine((report, ctx) => {
  const hasErrors = report.issues.some(issue => issue.severity === "ERROR");
  const hasWarnings = report.issues.some(issue => issue.severity === "WARNING");
  if (report.commitEligible !== !hasErrors || report.degraded !== (!hasErrors && hasWarnings)) ctx.addIssue({ code: "custom", message: "Report eligibility must reflect every issue severity" });
}).transform(deepFreeze);

export const scheduledVisitSchema = draftVisitObjectSchema.extend({
  candidateId: candidateIdSchema, placeFactRevision: revision,
  durationMinutes: z.number().int().min(1).max(1439),
  durationOrigin: durationProvenanceSchema,
  entryBuffer: effectiveBufferSchema,
  startMinute: minute, endMinute: minute,
}).strict().transform(deepFreeze);

export const scheduledLegSchema = z.object({
  id: legIdSchema, fromVisitId: visitIdSchema, toVisitId: visitIdSchema,
  route: routeFactSchema, transferBuffer: effectiveBufferSchema,
}).strict().transform(deepFreeze);

export const boundaryEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visit"), visitId: visitIdSchema }).strict(),
  z.object({ kind: z.literal("place"), placeId: placeIdSchema }).strict(),
]).transform(deepFreeze);

export const boundaryTransferSchema = z.object({
  id: localId("boundary"),
  from: boundaryEndpointSchema,
  to: boundaryEndpointSchema,
  route: routeFactSchema, transferBuffer: effectiveBufferSchema,
}).strict().transform(deepFreeze);

export const scheduleBlockSchema = z.object({
  id: localId("block"),
  kind: z.enum(["visit", "leg", "boundary_transfer", "meal", "rest", "break", "entry_buffer", "transfer_buffer", "wait"]),
  startMinute: minute,
  endMinute: minute,
  visitId: visitIdSchema.nullable(),
  legId: legIdSchema.nullable(),
  boundaryTransferId: localId("boundary").nullable(),
  origin: z.enum(["owner", "policy", "evidence", "provider", "derived"]),
  policyKey: text.nullable(),
  evidenceId: evidenceIdSchema.nullable(),
  evidenceRevision: revision.nullable(),
  routeFactId: localId("route").nullable(),
  routeFactRevision: revision.nullable(),
  overrideId: localId("override").nullable(),
}).strict().transform(deepFreeze);

export const scheduledDaySchema = z.object({
  id: dayPlanIdSchema,
  dayIndex: z.number().int().positive(),
  date: date.nullable(), timeZone: text, explicitlyFree: z.boolean(),
  window: z.object({ startMinute: minute, endMinute: minute }).strict(),
  mode: transportModeSchema, effectivePolicy: effectiveDayPolicySchema,
  visits: z.array(scheduledVisitSchema).readonly(),
  legs: z.array(scheduledLegSchema).readonly(),
  boundaryTransfers: z.array(boundaryTransferSchema).readonly(),
  scheduleBlocks: z.array(scheduleBlockSchema).readonly(),
  notices: z.array(validationIssueSchema),
}).strict().transform(deepFreeze);

export const scheduledItinerarySchema = z.object({
  schemaVersion: z.literal("canonical-v2"),
  kind: z.literal("scheduled"),
  tripId: tripIdSchema,
  runId: runIdSchema,
  baseVersionId: itineraryVersionIdSchema.nullable(),
  briefRevision: z.number().int().nonnegative(),
  policyVersion: z.literal("schedule-mvp-v1"),
  days: z.array(scheduledDaySchema).min(1).max(7).readonly(),
}).strict().readonly().transform(deepFreeze);

export const committedItinerarySnapshotSchema = z.object({
  schemaVersion: z.literal("canonical-v2"),
  kind: z.literal("committed"),
  id: itineraryVersionIdSchema,
  tripId: tripIdSchema,
  conversationId: conversationIdSchema,
  turnId: turnIdSchema,
  runId: runIdSchema,
  baseVersionId: itineraryVersionIdSchema.nullable(),
  briefRevision: z.number().int().nonnegative(),
  committedAt: timestamp,
  mutationOrigin: z.enum(["generation", "natural_language_revision", "typed_command"]),
  policyVersion: z.literal("schedule-mvp-v1"),
  policy: schedulePolicySchema,
  validationPolicyRevision: z.literal("validator-mvp-v1"),
  validationReport: validationReportSchema,
  brief: briefStateSchema,
  itinerary: scheduledItinerarySchema,
  places: z.array(groundedPlaceSchema).readonly(),
  evidence: z.array(evidenceFactSchema).readonly(),
  evidenceIds: z.array(evidenceIdSchema).readonly(),
  candidates: z.array(groundedCandidateSchema),
  durationOptions: z.array(durationOptionSchema),
  routes: z.array(routeFactSchema),
  conditionResolutions: z.array(conditionResolutionSchema),
  assumptions: z.array(assumptionSchema).readonly(),
  warnings: z.array(validationIssueSchema).readonly(),
}).strict().superRefine((snapshot, ctx) => {
  const invalid = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const unique = (values: readonly { id: string }[], field: string) => {
    if (new Set(values.map(value => value.id)).size !== values.length) invalid([field], "Frozen fact identities must be unique");
  };
  for (const field of ["places", "evidence", "candidates", "durationOptions", "routes"] as const) unique(snapshot[field], field);
  const places = new Map(snapshot.places.map(value => [value.id, value]));
  const evidence = new Map(snapshot.evidence.map(value => [value.id, value]));
  const candidates = new Map(snapshot.candidates.map(value => [value.id, value]));
  const options = new Map(snapshot.durationOptions.map(value => [value.id, value]));
  const routes = new Map(snapshot.routes.map(value => [value.id, value]));
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const warningIssues = snapshot.validationReport.issues.filter(value => value.severity === "WARNING");
  if (!equal(snapshot.warnings, warningIssues)) invalid(["warnings"], "Snapshot warnings must equal the validation report warnings");
  if (snapshot.policy.id !== snapshot.policyVersion || snapshot.itinerary.policyVersion !== snapshot.policyVersion || snapshot.validationReport.policyRevision !== snapshot.validationPolicyRevision) invalid(["policyVersion"], "Snapshot policy and validator revisions must agree");
  for (const fact of snapshot.evidence) if (!places.has(fact.placeId)) invalid(["evidence"], "Evidence Place must be frozen");
  for (const candidate of snapshot.candidates) {
    if (places.get(candidate.placeId)?.factRevision !== candidate.placeFactRevision) invalid(["candidates"], "Candidate Place revision must be frozen");
    if (new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length || candidate.evidenceIds.some(id => evidence.get(id)?.placeId !== candidate.placeId)) invalid(["candidates"], "Candidate Evidence must uniquely reference its frozen Place facts");
    if (new Set(candidate.durationOptionIds).size !== candidate.durationOptionIds.length || candidate.durationOptionIds.some(id => options.get(id)?.placeId !== candidate.placeId)) invalid(["candidates"], "Candidate duration options must uniquely reference its Place");
  }
  for (const option of snapshot.durationOptions) {
    const fact = evidence.get(option.evidenceId);
    if (!places.has(option.placeId) || !fact || fact.placeId !== option.placeId || fact.revision !== option.evidenceRevision || fact.field !== "stay_duration") invalid(["durationOptions"], "Duration options require their exact frozen Place and stay Evidence revision");
    if (option.status === "usable" && (fact?.status !== "known" || fact.value !== option.durationMinutes || option.durationMinutes < 1 || option.durationMinutes > 1439)) invalid(["durationOptions"], "Usable sourced durations require a matching bounded known value");
  }
  if (new Set(snapshot.conditionResolutions.map(value => value.evidenceId)).size !== snapshot.conditionResolutions.length) invalid(["conditionResolutions"], "Condition resolutions must be unique");
  for (const resolution of snapshot.conditionResolutions) {
    const fact = evidence.get(resolution.evidenceId);
    if (!fact || fact.revision !== resolution.evidenceRevision || !["entry_conditions", "reservation_requirements", "accessibility"].includes(fact.field)) invalid(["conditionResolutions"], "Resolution must bind its exact frozen condition revision");
  }
  for (const route of snapshot.routes) if (!places.has(route.fromPlaceId) || !places.has(route.toPlaceId)) invalid(["routes"], "Route endpoints require frozen grounded Places");
  for (const reference of snapshot.brief.references) if (reference.status === "resolved" && !places.has(reference.placeId ?? "")) invalid(["brief", "references"], "Resolved references require frozen grounding");
  for (const override of snapshot.brief.durationOverrides) if (override.visitId !== undefined &&
    !snapshot.itinerary.days.some(day => day.visits.some(visit => visit.id === override.visitId && visit.placeId === override.placeId))) {
    invalid(["brief", "durationOverrides"], "Visit duration override must bind an existing Visit and its exact Place");
  }
  const scheduleIds = new Set<string>();
  const register = (id: string) => {
    if (scheduleIds.has(id)) invalid(["itinerary"], "Schedule identities must be unique");
    scheduleIds.add(id);
  };
  if (!snapshot.validationReport.commitEligible) ctx.addIssue({ code: "custom", path: ["validationReport"], message: "A snapshot with validation errors cannot commit" });
  if (snapshot.itinerary.baseVersionId !== snapshot.baseVersionId) ctx.addIssue({ code: "custom", path: ["baseVersionId"], message: "Parent version references must agree" });
  if (snapshot.itinerary.tripId !== snapshot.tripId) ctx.addIssue({ code: "custom", path: ["itinerary", "tripId"], message: "Scheduled itinerary must belong to the snapshot Trip" });
  if (snapshot.itinerary.runId !== snapshot.runId) ctx.addIssue({ code: "custom", path: ["itinerary", "runId"], message: "Scheduled itinerary must belong to the snapshot Run" });
  if (snapshot.itinerary.briefRevision !== snapshot.briefRevision || snapshot.brief.revision !== snapshot.briefRevision) ctx.addIssue({ code: "custom", path: ["briefRevision"], message: "Snapshot, Brief, and itinerary revisions must agree" });
  const indexed = [...snapshot.evidenceIds].sort();
  const frozen = snapshot.evidence.map(fact => fact.id).sort();
  if (indexed.length !== new Set(indexed).size || indexed.length !== frozen.length || indexed.some((value, index) => value !== frozen[index])) ctx.addIssue({ code: "custom", path: ["evidenceIds"], message: "Evidence IDs must exactly index frozen Evidence facts" });
  const frozenIds = new Set(snapshot.evidenceIds);
  for (const [dayIndex, day] of snapshot.itinerary.days.entries()) {
    register(day.id);
    if (day.dayIndex !== dayIndex + 1) invalid(["itinerary", "days", dayIndex], "Day indices must be contiguous");
    if (day.effectivePolicy.policyVersion !== snapshot.policyVersion || day.effectivePolicy.overrides.some(value => !snapshot.brief.acceptedPolicyOverrides.some(accepted => equal(value, accepted)))) invalid(["itinerary", "days", dayIndex, "effectivePolicy"], "Effective policy overrides must be accepted in the frozen Brief");
    const visits = new Map(day.visits.map(value => [value.id, value]));
    const transfers = new Map([...day.legs, ...day.boundaryTransfers].map(value => [value.id, value]));
    for (const visit of day.visits) {
      register(visit.id);
      const candidate = candidates.get(visit.candidateId);
      if (!candidate || candidate.placeId !== visit.placeId || candidate.placeFactRevision !== visit.placeFactRevision) invalid(["itinerary", "days", dayIndex, "visits"], "Visit must bind a frozen candidate and Place revision");
      if (visit.durationOptionId !== null && !candidate?.durationOptionIds.includes(visit.durationOptionId)) invalid(["itinerary"], "Visit duration option is not bound to its candidate");
      if (visit.evidenceIds.some(id => evidence.get(id)?.placeId !== visit.placeId)) invalid(["itinerary"], "Visit Evidence belongs to another Place");
      const origin = visit.durationOrigin;
      if (origin.origin === "evidence") {
        const option = options.get(origin.durationOptionId ?? "");
        if (!option || !candidate?.durationOptionIds.includes(option.id) || option.placeId !== visit.placeId || option.durationMinutes !== visit.durationMinutes || option.evidenceId !== origin.evidenceId || option.evidenceRevision !== origin.evidenceRevision || !equal(option.entryCoverage, origin.entryCoverage)) invalid(["itinerary"], "Sourced stay provenance must close over its exact frozen duration option");
      }
    }
    for (const transfer of transfers.values()) {
      register(transfer.id);
      if (transfer.route.durationMinutes === null || !["confirmed", "identity"].includes(transfer.route.status)) invalid(["itinerary"], "A committed timeline cannot contain unknown or unreachable route time");
      if (!equal(routes.get(transfer.route.id), transfer.route)) invalid(["itinerary"], "Every embedded route must equal its frozen fact revision");
      if ("fromVisitId" in transfer) {
        if (visits.get(transfer.fromVisitId)?.placeId !== transfer.route.fromPlaceId || visits.get(transfer.toVisitId)?.placeId !== transfer.route.toPlaceId) invalid(["itinerary"], "Leg endpoints must bind their day Visits and route Places");
      } else {
        const endpointPlace = (endpoint: z.infer<typeof boundaryEndpointSchema>) => endpoint.kind === "place" ? places.get(endpoint.placeId)?.id : visits.get(endpoint.visitId)?.placeId;
        if (endpointPlace(transfer.from) !== transfer.route.fromPlaceId || endpointPlace(transfer.to) !== transfer.route.toPlaceId) invalid(["itinerary"], "Boundary endpoints must bind grounded Places or day Visits");
      }
    }
    for (const block of day.scheduleBlocks) {
      register(block.id);
      if (block.visitId !== null && !visits.has(block.visitId)) invalid(["itinerary"], "Block Visit must exist in the same day");
      if (block.legId !== null && !day.legs.some(value => value.id === block.legId)) invalid(["itinerary"], "Block Leg must exist in the same day");
      if (block.boundaryTransferId !== null && !day.boundaryTransfers.some(value => value.id === block.boundaryTransferId)) invalid(["itinerary"], "Block boundary transfer must exist in the same day");
      if (block.routeFactId !== null && routes.get(block.routeFactId)?.factRevision !== block.routeFactRevision) invalid(["itinerary"], "Block route revision must be frozen");
      if (block.evidenceId !== null && evidence.get(block.evidenceId)?.revision !== block.evidenceRevision) invalid(["itinerary"], "Block Evidence revision must be frozen");
      if (block.overrideId !== null && !snapshot.brief.acceptedPolicyOverrides.some(value => value.id === block.overrideId)) invalid(["itinerary"], "Block policy override must be accepted");
    }
    for (const [visitIndex, visit] of day.visits.entries()) for (const evidenceId of visit.evidenceIds) if (!frozenIds.has(evidenceId)) ctx.addIssue({ code: "custom", path: ["itinerary", "days", dayIndex, "visits", visitIndex, "evidenceIds"], message: `Evidence reference ${evidenceId} is absent from frozen Evidence` });
    for (const [blockIndex, block] of day.scheduleBlocks.entries()) if (block.evidenceId !== null && !frozenIds.has(block.evidenceId)) ctx.addIssue({ code: "custom", path: ["itinerary", "days", dayIndex, "scheduleBlocks", blockIndex, "evidenceId"], message: `Evidence reference ${block.evidenceId} is absent from frozen Evidence` });
  }
}).readonly().transform(deepFreeze);

export type GroundedPlace = z.infer<typeof groundedPlaceSchema>;
export type EvidenceFact = z.infer<typeof evidenceFactSchema>;
export type GroundedCandidate = z.infer<typeof groundedCandidateSchema>;
export type ItineraryDraft = z.infer<typeof itineraryDraftSchema>;
export type ScheduledItinerary = z.infer<typeof scheduledItinerarySchema>;
export type CommittedItinerarySnapshot = z.infer<typeof committedItinerarySnapshotSchema>;
export type DurationOption = z.infer<typeof durationOptionSchema>;
export type DurationProvenance = z.infer<typeof durationProvenanceSchema>;
export type BufferCoverage = z.infer<typeof bufferCoverageSchema>;
export type EffectiveBuffer = z.infer<typeof effectiveBufferSchema>;
export type RouteFact = z.infer<typeof routeFactSchema>;
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export type ValidationReport = z.infer<typeof validationReportSchema>;
export type ScheduledDay = z.infer<typeof scheduledDaySchema>;
export type ScheduledVisit = z.infer<typeof scheduledVisitSchema>;
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;
export type ScheduledLeg = z.infer<typeof scheduledLegSchema>;
export type BoundaryTransfer = z.infer<typeof boundaryTransferSchema>;
export type BoundaryEndpoint = z.infer<typeof boundaryEndpointSchema>;

export const scheduleInputSchema = z.object({
  typedCommand: typedCommandSchema.optional(),
  draft: itineraryDraftSchema, brief: briefStateSchema, policy: schedulePolicySchema,
  requirementContext: z.object({
    issueRevision: z.number().int().nonnegative(),
    supportedCityIds: z.array(localId("city")),
    supportedTransportModes: z.array(transportModeSchema),
    lockedDayIndices: z.array(z.number().int().positive()),
    resolvedPlaces: z.array(z.object({ placeId: placeIdSchema, administrativeAreaId: localId("area") }).strict()),
  }).strict(),
  candidateSet: z.object({
    tripId: tripIdSchema, runId: runIdSchema, baseVersionId: itineraryVersionIdSchema.nullable(),
    candidates: z.array(groundedCandidateSchema),
  }).strict(),
  visitBindings: z.array(z.object({ visitId: visitIdSchema, candidateId: candidateIdSchema }).strict()),
  places: z.array(groundedPlaceSchema), evidence: z.array(evidenceFactSchema),
  durationOptions: z.array(durationOptionSchema), routes: z.array(routeFactSchema),
  routeBindings: z.array(z.object({ segmentId: text, routeFactId: localId("route") }).strict()),
  conditionResolutions: z.array(conditionResolutionSchema),
  dayModes: z.array(z.object({ dayId: dayPlanIdSchema, mode: transportModeSchema }).strict()),
  base: committedItinerarySnapshotSchema.nullable(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }).strict(),
    z.object({ kind: z.literal("local"), dayIds: z.array(dayPlanIdSchema).min(1) }).strict(),
  ]),
}).strict().transform(deepFreeze);

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export type ValidationInput = Readonly<{ candidate: unknown; context: ScheduleInput }>;
export type RouteRequirement = Readonly<{
  dayId: string; segmentId: string; fromPlaceId: string; toPlaceId: string;
  mode: RouteFact["mode"]; date: string | null; departureMinute: number | null;
}>;
export type ScheduleResult =
  | Readonly<{ status: "scheduled"; itinerary: ScheduledItinerary; report: ValidationReport }>
  | Readonly<{ status: "blocked" | "route_required"; draft: ItineraryDraft; report: ValidationReport; routeRequirements: readonly RouteRequirement[] }>;
