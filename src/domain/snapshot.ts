import { z } from "zod";
import { briefStateSchema, type BriefState } from "./brief";
import {
  committedItinerarySnapshotSchema, scheduleInputSchema, scheduledItinerarySchema,
  type CommittedItinerarySnapshot, type ValidationReport,
} from "./canonical";
import { itineraryVersionIdSchema, turnInputSchema } from "./contracts";
import { editContextSchema, planTypedEdit } from "./edits";
import { issue, report, same } from "./scheduling-rules";
import { validateItinerary } from "./validation";

export const snapshotInputSchema = z.object({
  versionId: itineraryVersionIdSchema,
  committedAt: z.string().datetime({ offset: true }),
  turn: turnInputSchema,
  context: scheduleInputSchema,
  candidate: z.unknown(),
  commandBrief: briefStateSchema.optional(),
  editContext: editContextSchema.optional(),
}).strict();
export type SnapshotInput = z.infer<typeof snapshotInputSchema>;
export type SnapshotResult =
  | Readonly<{ status: "rejected"; report: ValidationReport }>
  | Readonly<{ status: "ready"; snapshot: CommittedItinerarySnapshot; commandBrief?: BriefState }>;

// The caller owns authorization and commit atomicity; this boundary owns exact
// candidate validation and freezes only caller-supplied facts and identities.
export function buildSnapshot(raw: SnapshotInput): SnapshotResult {
  const input = snapshotInputSchema.parse(raw);
  const { context, turn } = input;
  const reject = (code: string, message: string): SnapshotResult => ({
    status: "rejected", report: report([issue(code, context.draft.tripId, message)]),
  });
  if (turn.targetTripId !== context.draft.tripId ||
      turn.baseVersionId !== context.draft.baseVersionId ||
      context.base?.id === input.versionId ||
      (context.base !== null && (context.base.id !== turn.baseVersionId ||
        context.base.tripId !== turn.targetTripId ||
        context.base.conversationId !== turn.conversationId))) {
    return reject("snapshot.identity", "Snapshot and accepted Turn must bind the same Trip and exact parent");
  }
  let commandBrief: BriefState | undefined;
  if (turn.input.type !== "user_message") {
    if (!context.base || !input.editContext || !same(turn, input.editContext.turn) ||
        context.draft.runId !== input.editContext.schedule.draft.runId) {
      return reject("snapshot.command_context", "Typed mutation requires its accepted deterministic edit context");
    }
    const plan = planTypedEdit(context.base, turn.input, input.editContext);
    if (plan.status === "semantic_dispatch") {
      if (input.commandBrief !== undefined || !same(context.brief, input.editContext.schedule.brief) ||
          context.typedCommand !== undefined ||
          context.scope.kind !== "local" || !same(context.scope.dayIds, [plan.dayId]) ||
          !same(context.base, input.editContext.schedule.base) ||
          !same(context.policy, context.base.policy)) {
        return reject("snapshot.semantic_scope", "Regeneration must retain accepted Brief, base policy and dispatched scope");
      }
    } else {
      if (plan.status !== "candidate") {
        return reject("snapshot.command_not_ready", "No-op, blocked and dispatch-only commands cannot commit a snapshot");
      }
      if (!same(plan.scheduleInput, context) || !same(plan.itinerary, input.candidate) ||
          !same(plan.commandBrief ?? undefined, input.commandBrief)) {
        return reject("snapshot.command_delta", "Candidate and tentative Brief must equal the deterministic command proposal");
      }
      commandBrief = plan.commandBrief ?? undefined;
    }
  } else if (input.commandBrief !== undefined || input.editContext !== undefined || context.typedCommand !== undefined) {
    return reject("snapshot.unexpected_command", "Natural-language planning cannot supply a Typed Command proposal");
  }
  const acceptedRevision = input.editContext?.schedule.brief.revision ?? context.brief.revision;
  if (turn.baseBriefRevision !== acceptedRevision ||
      context.brief.revision !== acceptedRevision + (commandBrief ? 1 : 0) ||
      (commandBrief !== undefined && !same(commandBrief, context.brief))) {
    return reject("snapshot.brief_revision", "Proposal uses current revision plus one only for changed command Brief content");
  }
  const validationReport = validateItinerary({ candidate: input.candidate, context });
  if (!validationReport.commitEligible) return { status: "rejected", report: validationReport };
  // Identity transfers may be derived by scheduling. Their complete, independently
  // checked embedded facts are included alongside supplied routes, never replaced.
  const candidate = scheduledItinerarySchema.parse(input.candidate);
  const routes = [...context.routes];
  for (const day of candidate.days) for (const transfer of [...day.legs, ...day.boundaryTransfers]) {
    const existing = routes.find(route => route.id === transfer.route.id);
    if (existing && !same(existing, transfer.route)) return reject("snapshot.route_revision", "Embedded route differs from the supplied frozen revision");
    if (!existing) routes.push(transfer.route);
  }
  const parsed = committedItinerarySnapshotSchema.safeParse({
    schemaVersion: "canonical-v2", kind: "committed", id: input.versionId,
    tripId: context.draft.tripId, conversationId: turn.conversationId, turnId: turn.turnId,
    runId: context.draft.runId, baseVersionId: context.draft.baseVersionId,
    briefRevision: context.brief.revision, committedAt: input.committedAt,
    mutationOrigin: turn.input.type !== "user_message" ? "typed_command" : context.base ? "natural_language_revision" : "generation",
    policyVersion: context.policy.id, policy: context.policy,
    validationPolicyRevision: validationReport.policyRevision, validationReport,
    brief: context.brief, itinerary: candidate,
    places: context.places, evidence: context.evidence,
    evidenceIds: context.evidence.map(fact => fact.id),
    candidates: context.candidateSet.candidates, durationOptions: context.durationOptions,
    routes, conditionResolutions: context.conditionResolutions,
    assumptions: context.brief.assumptions,
    warnings: validationReport.issues.filter(value => value.severity === "WARNING"),
  });
  if (!parsed.success) return reject("snapshot.closure", "Proposed snapshot fails strict canonical identity or frozen reference closure");
  return commandBrief === undefined
    ? { status: "ready", snapshot: parsed.data }
    : { status: "ready", snapshot: parsed.data, commandBrief };
}
