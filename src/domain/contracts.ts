import { z } from "zod";

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9]+(?:-[a-z0-9]+)*$`));

const nonEmptyText = z.string().trim().min(1);
const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dateSchema = z.iso.date();
const timestampSchema = z.string().datetime({ offset: true });

export const conversationIdSchema = id("conversation");
export const turnIdSchema = id("turn");
export const tripIdSchema = id("trip");
export const itineraryVersionIdSchema = id("version");
export const runIdSchema = id("run");
export const issueIdSchema = id("issue");
export const placeIdSchema = id("place");
export const visitIdSchema = id("visit");
export const legIdSchema = id("leg");
export const evidenceIdSchema = id("evidence");
export const dayPlanIdSchema = id("day");
export const candidateIdSchema = id("candidate");
export const eventIdSchema = id("event");

export const modelIdentitySchema = z
  .object({
    provider: nonEmptyText,
    model: nonEmptyText,
    promptVersion: nonEmptyText,
  })
  .strict()
  .readonly();

export const tripBriefSchema = z
  .object({
    destination: nonEmptyText,
    dayCount: z.number().int().min(1).max(7),
    dateStart: dateSchema.nullable(),
    hardConstraints: z.array(nonEmptyText).readonly(),
    preferences: z.array(nonEmptyText).readonly(),
    assumptions: z.array(nonEmptyText).readonly(),
  })
  .strict()
  .readonly();

export const coordinatesSchema = z
  .object({
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
    coordinateSystem: z.enum(["GCJ-02", "WGS84"]),
  })
  .strict()
  .readonly();

export const placeSchema = z
  .object({
    id: placeIdSchema,
    name: nonEmptyText,
    district: nonEmptyText,
    description: nonEmptyText,
    imageSrc: nonEmptyText,
    imageAlt: nonEmptyText,
    coordinates: coordinatesSchema.nullable(),
    provenance: z.literal("fixture"),
  })
  .strict()
  .readonly();

export const evidenceSchema = z
  .object({
    id: evidenceIdSchema,
    placeId: placeIdSchema,
    title: nonEmptyText,
    url: z.string().url().nullable(),
    retrievedAt: timestampSchema.nullable(),
    status: z.enum(["fixture", "unknown", "verified"]),
    excerpt: nonEmptyText,
  })
  .strict()
  .readonly();

export const visitSchema = z
  .object({
    id: visitIdSchema,
    placeId: placeIdSchema,
    startTime: clockTimeSchema,
    endTime: clockTimeSchema,
    durationMinutes: z.number().int().positive(),
    locked: z.boolean(),
    evidenceIds: z.array(evidenceIdSchema).readonly(),
  })
  .strict()
  .readonly();

export const transportModeSchema = z.enum([
  "walk",
  "public_transit",
  "taxi",
  "drive",
  "bicycle",
]);

export const legGeometrySchema = z
  .object({
    coordinateSystem: z.enum(["GCJ-02", "WGS84"]),
    path: z.array(coordinatesSchema).min(2).readonly(),
  })
  .strict()
  .readonly();

export const legSchema = z
  .object({
    id: legIdSchema,
    fromVisitId: visitIdSchema,
    toVisitId: visitIdSchema,
    mode: transportModeSchema,
    durationMinutes: z.number().int().positive().nullable(),
    distanceMeters: z.number().int().nonnegative().nullable(),
    geometry: legGeometrySchema.nullable(),
    provenance: z.literal("fixture"),
  })
  .strict()
  .readonly();

export const dayPlanSchema = z
  .object({
    id: dayPlanIdSchema,
    dayIndex: z.number().int().positive(),
    title: nonEmptyText,
    summary: nonEmptyText,
    visits: z.array(visitSchema).readonly(),
    legs: z.array(legSchema).readonly(),
  })
  .strict()
  .readonly();

export const itineraryVersionSchema = z
  .object({
    id: itineraryVersionIdSchema,
    tripId: tripIdSchema,
    conversationId: conversationIdSchema,
    title: nonEmptyText,
    destination: nonEmptyText,
    dateStart: dateSchema.nullable(),
    dayCount: z.number().int().min(1).max(7),
    briefRevision: z.number().int().nonnegative(),
    provenance: z.literal("fixture"),
    days: z.array(dayPlanSchema).min(1).max(7).readonly(),
    places: z.array(placeSchema).readonly(),
    evidence: z.array(evidenceSchema).readonly(),
    assumptions: z.array(nonEmptyText).readonly(),
    warnings: z.array(nonEmptyText).readonly(),
  })
  .strict()
  .readonly();

const removeVisitCommandSchema = z
  .object({ type: z.literal("remove_visit"), visitId: visitIdSchema })
  .strict();
const moveVisitCommandSchema = z
  .object({
    type: z.literal("move_visit"),
    visitId: visitIdSchema,
    toDayId: dayPlanIdSchema,
    toIndex: z.number().int().nonnegative(),
  })
  .strict();
const setVisitLockCommandSchema = z
  .object({
    type: z.literal("set_visit_lock"),
    visitId: visitIdSchema,
    locked: z.boolean(),
  })
  .strict();
const updateVisitDurationCommandSchema = z
  .object({
    type: z.literal("update_visit_duration"),
    visitId: visitIdSchema,
    durationMinutes: z.number().int().positive(),
  })
  .strict();
const updateDayStartTimeCommandSchema = z
  .object({
    type: z.literal("update_day_start_time"),
    dayId: dayPlanIdSchema,
    startTime: clockTimeSchema,
  })
  .strict();
const updateDayTransportModeCommandSchema = z
  .object({
    type: z.literal("update_day_transport_mode"),
    dayId: dayPlanIdSchema,
    mode: transportModeSchema,
  })
  .strict();
const replaceVisitCommandSchema = z
  .object({
    type: z.literal("replace_visit"),
    visitId: visitIdSchema,
    candidateId: candidateIdSchema,
  })
  .strict();
const regenerateDayCommandSchema = z
  .object({ type: z.literal("regenerate_day"), dayId: dayPlanIdSchema })
  .strict();
const cancelRunCommandSchema = z
  .object({ type: z.literal("cancel_run"), runId: runIdSchema })
  .strict();
const retryRunCommandSchema = z
  .object({ type: z.literal("retry_run"), runId: runIdSchema })
  .strict();

export const typedCommandSchema = z.discriminatedUnion("type", [
  removeVisitCommandSchema,
  moveVisitCommandSchema,
  setVisitLockCommandSchema,
  updateVisitDurationCommandSchema,
  updateDayStartTimeCommandSchema,
  updateDayTransportModeCommandSchema,
  replaceVisitCommandSchema,
  regenerateDayCommandSchema,
  cancelRunCommandSchema,
  retryRunCommandSchema,
]);

export const userMessageSchema = z
  .object({ type: z.literal("user_message"), text: nonEmptyText })
  .strict();

export const turnInputSchema = z
  .object({
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    targetTripId: tripIdSchema.nullable(),
    baseVersionId: itineraryVersionIdSchema.nullable(),
    baseBriefRevision: z.number().int().nonnegative(),
    resume: z
      .object({
        runId: runIdSchema,
        issueRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    input: z.union([userMessageSchema, typedCommandSchema]),
  })
  .strict();

export const requirementIssueSchema = z
  .object({
    id: issueIdSchema,
    revision: z.number().int().positive(),
    kind: z.enum(["missing", "ambiguous", "unsupported", "conflict"]),
    field: nonEmptyText,
    message: nonEmptyText,
    blocking: z.boolean(),
    options: z.array(nonEmptyText).readonly(),
  })
  .strict()
  .readonly();

export const runStateSchema = z.enum([
  "accepted",
  "checking_requirements",
  "needs_input",
  "ready",
  "researching",
  "resolving_places",
  "drafting",
  "routing",
  "validating",
  "repairing",
  "completed",
  "degraded",
  "failed",
  "cancelled",
  "superseded",
]);

export const generationRunSchema = z
  .object({
    id: runIdSchema,
    conversationId: conversationIdSchema,
    tripId: tripIdSchema.nullable(),
    turnId: turnIdSchema,
    baseVersionId: itineraryVersionIdSchema.nullable(),
    baseBriefRevision: z.number().int().nonnegative(),
    state: runStateSchema,
  })
  .strict()
  .readonly();

const eventBase = {
  id: eventIdSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  runId: runIdSchema,
  turnId: turnIdSchema,
};

export const turnEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventBase,
      type: z.literal("run.started"),
      versionId: itineraryVersionIdSchema.nullable(),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("requirements.checked"),
      versionId: itineraryVersionIdSchema.nullable(),
      blockingIssueCount: z.number().int().nonnegative(),
      assumptionCount: z.number().int().nonnegative(),
      warningCount: z.number().int().nonnegative(),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("run.needs_input"),
      versionId: itineraryVersionIdSchema.nullable(),
      issueRevision: z.number().int().positive(),
      issues: z.array(requirementIssueSchema).min(1).readonly(),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("research.started"),
      versionId: itineraryVersionIdSchema.nullable(),
      querySummary: nonEmptyText,
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("research.sources_found"),
      versionId: itineraryVersionIdSchema.nullable(),
      evidenceIds: z.array(evidenceIdSchema).readonly(),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("places.resolved"),
      versionId: itineraryVersionIdSchema.nullable(),
      placeIds: z.array(placeIdSchema).readonly(),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("itinerary.drafted"),
      versionId: itineraryVersionIdSchema.nullable(),
      dayCount: z.number().int().min(1).max(7),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("routing.started"),
      versionId: itineraryVersionIdSchema.nullable(),
      legCount: z.number().int().nonnegative(),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("validation.started"),
      versionId: itineraryVersionIdSchema.nullable(),
      attempt: z.number().int().positive(),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("itinerary.repairing"),
      versionId: itineraryVersionIdSchema.nullable(),
      attempt: z.number().int().min(1).max(2),
      rationale: nonEmptyText,
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("itinerary.completed"),
      versionId: itineraryVersionIdSchema,
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("run.no_change"),
      versionId: itineraryVersionIdSchema,
      message: z.literal("Itinerary unchanged"),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("run.degraded"),
      versionId: itineraryVersionIdSchema,
      warnings: z.array(nonEmptyText).min(1).readonly(),
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("run.failed"),
      versionId: itineraryVersionIdSchema.nullable(),
      code: nonEmptyText,
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("run.cancelled"),
      versionId: itineraryVersionIdSchema.nullable(),
      reason: nonEmptyText,
      message: nonEmptyText,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("run.superseded"),
      versionId: itineraryVersionIdSchema.nullable(),
      replacementRunId: runIdSchema,
      message: nonEmptyText,
    })
    .strict(),
]);

export const viewSelectionSchema = z
  .object({
    tripId: tripIdSchema,
    versionId: itineraryVersionIdSchema,
    dayIndex: z.number().int().nonnegative(),
    selectedVisitId: visitIdSchema.nullable(),
    selectedLegId: legIdSchema.nullable(),
    mode: z.enum(["list", "map"]),
  })
  .strict()
  .readonly();

export const tripLibraryItemSchema = z
  .object({
    tripId: tripIdSchema,
    conversationId: conversationIdSchema,
    currentVersionId: itineraryVersionIdSchema,
    title: nonEmptyText,
    destination: nonEmptyText,
    dateStart: dateSchema.nullable(),
    dayCount: z.number().int().min(1).max(7),
    imageSrc: nonEmptyText,
    imageAlt: nonEmptyText,
  })
  .strict()
  .readonly();

export const itineraryReadModelSchema = z
  .object({
    version: itineraryVersionSchema,
    selection: viewSelectionSchema,
  })
  .strict()
  .readonly();

export type ModelIdentity = z.infer<typeof modelIdentitySchema>;
export type TripBrief = z.infer<typeof tripBriefSchema>;
export type Coordinates = z.infer<typeof coordinatesSchema>;
export type Place = z.infer<typeof placeSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Visit = z.infer<typeof visitSchema>;
export type TransportMode = z.infer<typeof transportModeSchema>;
export type LegGeometry = z.infer<typeof legGeometrySchema>;
export type Leg = z.infer<typeof legSchema>;
export type DayPlan = z.infer<typeof dayPlanSchema>;
export type ItineraryVersion = z.infer<typeof itineraryVersionSchema>;
export type TypedCommand = z.infer<typeof typedCommandSchema>;
export type UserMessage = z.infer<typeof userMessageSchema>;
export type TurnInput = z.infer<typeof turnInputSchema>;
export type RequirementIssue = z.infer<typeof requirementIssueSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type GenerationRun = z.infer<typeof generationRunSchema>;
export type TurnEvent = z.infer<typeof turnEventSchema>;
export type ViewSelection = z.infer<typeof viewSelectionSchema>;
export type TripLibraryItem = z.infer<typeof tripLibraryItemSchema>;
export type ItineraryReadModel = z.infer<typeof itineraryReadModelSchema>;
