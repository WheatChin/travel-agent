import { z } from "zod";
import { briefStateSchema, type BriefState } from "./brief";
import {
  committedItinerarySnapshotSchema, itineraryDraftSchema, scheduleInputSchema, scheduledItinerarySchema,
  type CommittedItinerarySnapshot, type ScheduledItinerary, type ScheduleInput,
  type ItineraryDraft, type RouteRequirement, type ValidationReport,
} from "./canonical";
import { turnInputSchema, typedCommandSchema, visitIdSchema, type TypedCommand } from "./contracts";
import { scheduleItinerary } from "./schedule";
import { validateItinerary } from "./validation";
import { issue, report, same, segments } from "./scheduling-rules";

export const editContextSchema = z.object({
  turn: turnInputSchema,
  schedule: scheduleInputSchema,
  newVisitId: visitIdSchema.nullable(),
}).strict();
export type EditContext = z.infer<typeof editContextSchema>;
type ProposedEdit = Readonly<{
  changedDayIds: readonly string[];
  commandBrief: BriefState | null;
  scheduleInput: ScheduleInput;
}>;
export type EditPlan =
  | Readonly<{ status: "no_op"; versionId: string }>
  | Readonly<{ status: "rejected"; report: ValidationReport }>
  | (ProposedEdit & Readonly<{ status: "candidate"; itinerary: ScheduledItinerary; report: ValidationReport }>)
  | (ProposedEdit & Readonly<{ status: "route_required"; routeRequirements: readonly RouteRequirement[]; report: ValidationReport }>)
  | Readonly<{ status: "semantic_dispatch"; dayId: string; scheduleInput: ScheduleInput }>
  | Readonly<{ status: "control_dispatch"; command: Extract<TypedCommand, { type: "cancel_run" | "retry_run" }> }>;

export function planTypedEdit(rawBase: CommittedItinerarySnapshot, rawCommand: TypedCommand, rawContext: EditContext): EditPlan {
  const base = committedItinerarySnapshotSchema.parse(rawBase);
  const command = typedCommandSchema.parse(rawCommand);
  const context = editContextSchema.parse(rawContext);
  const supplied = context.schedule;
  const reject = (code: string, target: string, message: string): EditPlan => ({ status: "rejected", report: report([issue(code, target, message)]) });
  if (!same(command, context.turn.input) || context.turn.conversationId !== base.conversationId || context.turn.targetTripId !== base.tripId || context.turn.baseVersionId !== base.id || context.turn.baseBriefRevision !== supplied.brief.revision || !same(supplied.base, base)) return reject("edit.base_binding", base.id, "Command envelope and accepted context must bind this exact base");
  if (supplied.draft.tripId !== base.tripId || supplied.draft.baseVersionId !== base.id || supplied.candidateSet.tripId !== base.tripId || supplied.candidateSet.runId !== supplied.draft.runId || supplied.candidateSet.baseVersionId !== base.id) return reject("edit.context_binding", base.id, "Candidate and Run context must bind the same Trip and base");
  if (command.type === "cancel_run" || command.type === "retry_run") return { status: "control_dispatch", command };
  const allowed = new Set(supplied.scope.kind === "global" ? base.itinerary.days.map(day => day.id) : supplied.scope.dayIds);
  const days: { id: string; dayIndex: number; visits: ItineraryDraft["days"][number]["visits"][number][] }[] = base.itinerary.days.map(day => ({ id: day.id, dayIndex: day.dayIndex, visits: day.visits.map(visit => ({
    id: visit.id, placeId: visit.placeId, durationOptionId: visit.durationOptionId,
    durationMinutes: visit.durationMinutes, locked: visit.locked, evidenceIds: visit.evidenceIds,
  })) }));
  const targetDay = "visitId" in command ? days.find(day => day.visits.some(visit => visit.id === command.visitId)) : days.find(day => "dayId" in command && day.id === command.dayId);
  if (!targetDay) return reject("edit.target_missing", "visitId" in command ? command.visitId : command.dayId, "Command target is absent from the base");
  const visit = "visitId" in command ? targetDay.visits.find(value => value.id === command.visitId) : undefined;
  const changed = new Set([targetDay.id]);
  if (command.type === "move_visit") changed.add(command.toDayId);
  if ([...changed].some(id => !allowed.has(id))) return reject("edit.scope", targetDay.id, "Command must explicitly authorize every affected day");
  if (command.type === "regenerate_day") {
    const { typedCommand: _command, ...semanticInput } = supplied;
    return { status: "semantic_dispatch", dayId: targetDay.id, scheduleInput: scheduleInputSchema.parse({
      ...semanticInput, base, policy: base.policy,
      draft: { ...supplied.draft, briefRevision: supplied.brief.revision, days },
      visitBindings: base.itinerary.days.flatMap(day => day.visits.map(value => ({ visitId: value.id, candidateId: value.candidateId }))),
      dayModes: base.itinerary.days.map(day => ({ dayId: day.id, mode: day.mode })),
      scope: { kind: "local", dayIds: [targetDay.id] },
    }) };
  }
  const noOp = (): EditPlan => supplied.brief.revision !== base.briefRevision || !same(supplied.brief, base.brief)
    ? reject("edit.pending_requirements", base.id, "Pending requirements cannot be completed as an unchanged version")
    : { status: "no_op", versionId: base.id };
  let brief = supplied.brief;
  const must = new Set([
    ...brief.hardConstraints.flatMap(value => value.type === "must_visit" ? [value.placeId] : []),
    ...brief.references.flatMap(value => value.role === "must_visit" && value.placeId !== null ? [value.placeId] : []),
  ]);
  const protectionReport = (target: NonNullable<typeof visit>) => report([
    ...(target.locked ? [issue("edit.locked", target.id, "Explicitly unlock this Visit in a prior successful command")] : []),
    ...(must.has(target.placeId) ? [issue("edit.must_visit", target.id, "Required Visit cannot be removed or replaced")] : []),
    ...brief.hardConstraints.filter(value => value.type === "fixed_visit_start" && value.visitId === target.id)
      .map(value => issue("edit.fixed_visit", value.id, "Resolve the Visit-specific constraint before removal or replacement")),
  ]);
  let bindings = base.itinerary.days.flatMap(day => day.visits.map(value => ({ visitId: value.id, candidateId: value.candidateId })));
  const modes = base.itinerary.days.map(day => ({ dayId: day.id, mode: day.mode }));
  if (command.type === "move_visit" && visit) {
    const destination = days.find(day => day.id === command.toDayId);
    if (!destination) return reject("edit.destination_missing", command.toDayId, "Destination day is absent");
    const remaining = destination.visits.filter(value => value.id !== visit.id);
    if (command.toIndex > remaining.length) return reject("edit.index", visit.id, "Insertion index must address the destination after removal");
    const order = [...remaining.slice(0, command.toIndex), visit, ...remaining.slice(command.toIndex)];
    if (destination === targetDay && same(order, targetDay.visits)) return noOp();
    if (visit.locked) return reject("edit.locked", visit.id, "Explicitly unlock this Visit in a prior successful command");
    targetDay.visits = targetDay.visits.filter(value => value.id !== visit.id);
    destination.visits = order;
  } else if (command.type === "remove_visit" && visit) {
    const protection = protectionReport(visit);
    if (!protection.commitEligible) return { status: "rejected", report: protection };
    targetDay.visits = targetDay.visits.filter(value => value.id !== visit.id);
    brief = briefStateSchema.parse({ ...brief, durationOverrides: brief.durationOverrides.filter(value => value.visitId !== visit.id), excludedPlaceIds: [...new Set([...brief.excludedPlaceIds, visit.placeId])] });
  } else if (command.type === "set_visit_lock" && visit) {
    if (visit.locked === command.locked) return noOp();
    targetDay.visits = targetDay.visits.map(value => value.id === visit.id ? { ...value, locked: command.locked } : value);
  } else if (command.type === "update_visit_duration" && visit) {
    if (visit.durationMinutes === command.durationMinutes) return noOp();
    if (visit.locked) return reject("edit.locked", visit.id, "Locked stay cannot change before explicit unlock");
    if (command.durationMinutes > 1439) return reject("edit.duration_bounds", visit.id, "Stay must be 1 through 1439 minutes");
    targetDay.visits = targetDay.visits.map(value => value.id === visit.id ? { ...value, durationMinutes: command.durationMinutes } : value);
    brief = briefStateSchema.parse({ ...brief, durationOverrides: [...brief.durationOverrides.filter(value => value.visitId !== visit.id), { placeId: visit.placeId, visitId: visit.id, durationMinutes: command.durationMinutes }] });
  } else if (command.type === "update_day_start_time") {
    const [hour, minute] = command.startTime.split(":").map(Number);
    const startMinute = hour * 60 + minute;
    const previous = base.itinerary.days.find(day => day.id === targetDay.id)!;
    if (startMinute === previous.window.startMinute) return noOp();
    if (startMinute >= previous.window.endMinute) return reject("edit.day_window", targetDay.id, "Start must precede the retained day end");
    brief = briefStateSchema.parse({ ...brief, dayWindows: [...brief.dayWindows.filter(value => value.dayIndex !== targetDay.dayIndex), { dayIndex: targetDay.dayIndex, startMinute, endMinute: previous.window.endMinute }] });
  } else if (command.type === "update_day_transport_mode") {
    const previous = modes.find(value => value.dayId === targetDay.id)!;
    if (previous.mode === command.mode) return noOp();
    if (!supplied.requirementContext.supportedTransportModes.includes(command.mode) || brief.hardConstraints.some(value => value.type === "transport_modes" && !value.modes.includes(command.mode))) return reject("edit.transport", targetDay.id, "Mode violates registered capabilities or hard restrictions");
    previous.mode = command.mode;
  } else if (command.type === "replace_visit" && visit) {
    const replacement = supplied.candidateSet.candidates.find(value => value.id === command.candidateId);
    if (!replacement) return reject("edit.candidate_missing", command.candidateId, "Replacement must be a supplied candidate");
    if (replacement.placeId === visit.placeId) return noOp();
    const protection = protectionReport(visit);
    if (!protection.commitEligible) return { status: "rejected", report: protection };
    if (context.newVisitId === null || days.some(day => day.visits.some(value => value.id === context.newVisitId))) return reject("edit.new_visit_id", visit.id, "Replacement requires a fresh caller-supplied Visit ID");
    if (brief.excludedPlaceIds.includes(replacement.placeId) || brief.hardConstraints.some(value => value.type === "excluded_place" && value.placeId === replacement.placeId)) return reject("edit.excluded", replacement.placeId, "Replacement Place is excluded");
    if (days.some(day => day.visits.some(value => value.placeId === replacement.placeId)) && !brief.allowedRepeatedPlaceIds.includes(replacement.placeId)) return reject("edit.repeated", replacement.placeId, "Repeated Place requires explicit acceptance");
    const place = supplied.places.find(value => value.id === replacement.placeId);
    if (!place || brief.destination.status !== "resolved" || place.cityId !== brief.destination.cityId || !brief.destination.administrativeAreaIds.includes(place.administrativeAreaId)) return reject("edit.outside_area", replacement.placeId, "Replacement requires grounding within the approved area");
    const nextVisit = { id: context.newVisitId, placeId: replacement.placeId, durationOptionId: null, durationMinutes: null, locked: false, evidenceIds: replacement.evidenceIds };
    targetDay.visits = targetDay.visits.map(value => value.id === visit.id ? nextVisit : value);
    bindings = [...bindings.filter(value => value.visitId !== visit.id), { visitId: nextVisit.id, candidateId: replacement.id }];
    brief = briefStateSchema.parse({ ...brief, durationOverrides: brief.durationOverrides.filter(value => value.visitId !== visit.id), excludedPlaceIds: [...new Set([...brief.excludedPlaceIds, visit.placeId])] });
  }
  brief = briefStateSchema.parse({ ...brief, explicitlyFreeDayIndices: [...new Set([
    ...brief.explicitlyFreeDayIndices.filter(index => !days.some(day => changed.has(day.id) && day.dayIndex === index)),
    ...days.filter(day => changed.has(day.id) && day.visits.length === 0).map(day => day.dayIndex),
  ])].sort((a, b) => a - b) });
  const commandBrief = same(brief, supplied.brief) ? null : briefStateSchema.parse({ ...brief, revision: supplied.brief.revision + 1 });
  const proposed = commandBrief ?? supplied.brief;
  const draft = itineraryDraftSchema.parse({ kind: "draft", tripId: base.tripId, runId: supplied.draft.runId, baseVersionId: base.id, briefRevision: proposed.revision, days });
  bindings = bindings.filter(value => days.some(day => day.visits.some(visit => visit.id === value.visitId)));
  const preparation = scheduleInputSchema.parse({ ...supplied, typedCommand: command, base, draft, brief: proposed, policy: base.policy, visitBindings: bindings, dayModes: modes, scope: { kind: "local", dayIds: [...changed] } });
  const routeBindings = days.flatMap(day => segments(preparation, day).flatMap(segment => {
    const mode = modes.find(value => value.dayId === day.id)!.mode;
    const old = base.itinerary.days.flatMap(value => [...value.legs, ...value.boundaryTransfers]).find(value => value.id === segment.id && value.route.mode === mode && value.route.fromPlaceId === segment.fromPlaceId && value.route.toPlaceId === segment.toPlaceId);
    const suppliedBinding = supplied.routeBindings.find(value => value.segmentId === segment.id);
    const route = supplied.routes.find(value => value.id === suppliedBinding?.routeFactId && value.mode === mode && value.fromPlaceId === segment.fromPlaceId && value.toPlaceId === segment.toPlaceId)
      ?? supplied.routes.find(value => value.id === old?.route.id);
    return route ? [{ segmentId: segment.id, routeFactId: route.id }] : [];
  }));
  const scheduleInput = scheduleInputSchema.parse({ ...preparation, routeBindings });
  const proposal: ProposedEdit = { changedDayIds: [...changed], commandBrief, scheduleInput };
  if (command.type === "set_visit_lock") {
    if (!same(supplied.brief, base.brief)) return reject("edit.pending_requirements", base.id, "Metadata-only commands cannot reconcile pending travel requirements");
    const itinerary = scheduledItinerarySchema.parse({
      ...base.itinerary, runId: draft.runId, baseVersionId: base.id, briefRevision: proposed.revision,
      days: base.itinerary.days.map(day => ({
        ...day, visits: day.visits.map(value => value.id === command.visitId ? { ...value, locked: command.locked } : value),
      })),
    });
    const metadataInput = scheduleInputSchema.parse({
      ...scheduleInput, places: base.places, evidence: base.evidence, durationOptions: base.durationOptions,
      routes: base.routes, conditionResolutions: base.conditionResolutions,
      candidateSet: { ...scheduleInput.candidateSet, candidates: base.candidates },
    });
    const checked = validateItinerary({ candidate: itinerary, context: metadataInput });
    return checked.commitEligible
      ? { status: "candidate", ...proposal, scheduleInput: metadataInput, itinerary, report: checked }
      : { status: "rejected", report: checked };
  }
  const result = scheduleItinerary(scheduleInput);
  if (result.status === "scheduled") return { status: "candidate", ...proposal, itinerary: result.itinerary, report: result.report };
  if (result.status === "route_required") return { status: "route_required", ...proposal, routeRequirements: result.routeRequirements, report: result.report };
  return { status: "rejected", report: result.report };
}
