import { assessRequirements } from "./brief";
import {
  validationReportSchema,
  type BoundaryEndpoint, type BufferCoverage, type DurationProvenance, type EffectiveBuffer,
  type EvidenceFact, type RouteFact, type ScheduleInput, type ScheduledDay,
  type ValidationIssue, type ValidationReport,
} from "./canonical";
import { effectivePolicy, SCHEDULE_POLICY, type EffectiveDayPolicy } from "./policy";

export const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const issue = (code: string, targetId: string, message: string, severity: ValidationIssue["severity"] = "ERROR", disposition: ValidationIssue["disposition"] = "owner_decision", factIds: string[] = []): ValidationIssue =>
  ({ code, severity, field: code.split(".")[0], targetId, message, disposition, factIds });

export function report(issues: readonly ValidationIssue[]): ValidationReport {
  const unique = new Map(issues.map(value => [`${value.code}:${value.targetId}:${value.factIds.join(",")}`, value]));
  const sorted = [...unique.values()].sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code) || a.targetId.localeCompare(b.targetId) || a.factIds.join(",").localeCompare(b.factIds.join(",")));
  const errors = sorted.some(value => value.severity === "ERROR");
  return validationReportSchema.parse({ policyRevision: "validator-mvp-v1", issues: sorted, commitEligible: !errors, degraded: !errors && sorted.some(value => value.severity === "WARNING") });
}

export function calendarDate(start: string | null, dayIndex: number): string | null {
  if (start === null || dayIndex < 1 || dayIndex > 7) return null;
  let [year, month, day] = start.split("-").map(Number);
  for (let step = 1; step < dayIndex; step++) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    day++;
    if (day > length) { day = 1; month++; }
    if (month > 12) { month = 1; year++; }
  }
  return year > 9999 ? null : `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function applicable(fact: EvidenceFact, date: string | null): boolean {
  if (fact.freshness !== "current") return false;
  if (date === null) return fact.applicableFrom === null && fact.applicableThrough === null;
  return (fact.applicableFrom === null || date >= fact.applicableFrom) && (fact.applicableThrough === null || date <= fact.applicableThrough);
}

export function inputIssues(input: ScheduleInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, target: string, message: string) => issues.push(issue(code, target, message, "ERROR", "reject"));
  if (input.typedCommand && (!input.base || ["cancel_run", "retry_run", "regenerate_day"].includes(input.typedCommand.type))) add("command.scheduling_authority", "trip", "Deterministic scheduling authority requires a mutation command and exact base");
  for (const override of input.brief.durationOverrides) if (override.visitId !== undefined &&
    !input.draft.days.some(day => day.visits.some(visit => visit.id === override.visitId && visit.placeId === override.placeId))) {
    add("duration.override_binding", override.visitId, "Visit override must bind its exact existing Visit and Place");
  }
  const assessment = assessRequirements(input.brief, {
    ...input.requirementContext,
    resolvedPlaces: input.places.map(place => ({ placeId: place.id, administrativeAreaId: place.administrativeAreaId })),
    lockedDayIndices: [...new Set([...input.requirementContext.lockedDayIndices, ...(input.base?.itinerary.days.filter(day => day.visits.some(visit => visit.locked)).map(day => day.dayIndex) ?? [])])],
  });
  issues.push(...assessment.blockingIssues.map(value => issue(`requirements.${value.rule}`, value.target, value.message)));
  if (!same(input.policy, SCHEDULE_POLICY)) add("policy.unregistered", "trip", "Policy settings do not match the registered schedule-mvp-v1 revision");
  if (input.draft.briefRevision !== input.brief.revision) add("brief.revision", "trip", "Draft and effective Brief revisions differ");
  if (input.draft.tripId !== input.candidateSet.tripId || input.draft.runId !== input.candidateSet.runId || input.draft.baseVersionId !== input.candidateSet.baseVersionId) add("candidate.scope", "trip", "Candidate set is bound to another Trip, Run or base");
  if ((input.base?.id ?? null) !== input.draft.baseVersionId || (input.base && input.base.tripId !== input.draft.tripId)) add("base.identity", "trip", "Base snapshot identity does not match the draft");
  if (input.scope.kind === "local" && input.base === null) add("scope.base_missing", "trip", "A local change requires its frozen base");
  if (input.base && !same(input.policy, input.base.policy)) add("policy.base_changed", "trip", "Revisions use the frozen base policy");
  if (input.draft.days.length !== assessment.effectiveDayCount) add("days.count", "trip", "Day count must equal the assessed Brief");
  input.draft.days.forEach((day, index) => {
    if (day.dayIndex !== index + 1) add("days.indices", day.id, "Days must be contiguous and 1-based");
    if (day.visits.length === 0 && !input.brief.explicitlyFreeDayIndices.includes(day.dayIndex)) add("days.empty", day.id, "Empty days must be explicitly free");
    if (day.visits.length > 0 && input.brief.explicitlyFreeDayIndices.includes(day.dayIndex)) add("days.free_has_visits", day.id, "An explicitly free day cannot contain attractions");
    if (input.dayModes.filter(value => value.dayId === day.id).length !== 1) add("transport.day_mode", day.id, "Supply exactly one supported mode for each day");
    for (const role of ["start", "end"] as const) {
      const boundary = input.brief.boundaries.find(value => value.dayIndex === day.dayIndex);
      const selectedId = boundary?.[`${role}ReferenceId`];
      const refs = input.brief.references.filter(value => value.role === role && (selectedId ? value.id === selectedId : value.dayIndex === day.dayIndex || value.dayIndex === null));
      if (new Set(refs.map(value => value.placeId)).size > 1) add("boundary.ambiguous_selection", day.id, "Multiple requested boundary Places require an explicit reference selection");
    }
  });
  const unique = (values: readonly string[], code: string) => {
    const seen = new Set<string>();
    for (const value of values) { if (seen.has(value)) add(code, value, "Duplicate stable identity"); seen.add(value); }
  };
  unique(input.draft.days.map(day => day.id), "days.duplicate");
  unique(input.draft.days.flatMap(day => day.visits.map(visit => visit.id)), "visits.duplicate");
  unique(input.visitBindings.map(value => value.visitId), "candidate.duplicate_binding");
  unique(input.routeBindings.map(value => value.segmentId), "route.duplicate_binding");
  unique(input.candidateSet.candidates.map(value => value.id), "candidate.duplicate");
  unique(input.places.map(value => value.id), "place.duplicate_fact");
  unique(input.evidence.map(value => value.id), "evidence.duplicate");
  unique(input.routes.map(value => value.id), "route.duplicate_fact");
  unique(input.durationOptions.map(value => value.id), "duration.duplicate_option");
  unique(input.conditionResolutions.map(value => value.evidenceId), "evidence.duplicate_resolution");
  unique(input.brief.acceptedPolicyOverrides.map(value => value.id), "policy.duplicate_override");
  if (input.scope.kind === "local" && input.base) {
    const changed = new Set(input.scope.dayIds);
    for (const day of input.base.itinerary.days.filter(value => !changed.has(value.id))) {
      const next = input.draft.days.find(value => value.id === day.id);
      if (!next || next.dayIndex !== day.dayIndex || !same(next.visits.map(value => [value.id, value.placeId, value.locked, value.durationOptionId]), day.visits.map(value => [value.id, value.placeId, value.locked, value.durationOptionId])) || next.visits.some(value => value.durationMinutes !== null && value.durationMinutes !== day.visits.find(old => old.id === value.id)?.durationMinutes)) add("scope.draft_changed", day.id, "The supplied draft changes an unscoped base day");
      const oldBrief = input.base.brief;
      const placeIds = new Set(day.visits.map(value => value.placeId));
      const visitIds = new Set(day.visits.map(value => value.id));
      const relevantHard = (brief: ScheduleInput["brief"]) => brief.hardConstraints.filter(value =>
        "dayIndex" in value ? value.dayIndex === day.dayIndex
          : "placeId" in value ? placeIds.has(value.placeId)
            : value.type === "max_walking" || value.type === "transport_modes" || value.type === "unresolved");
      const relevantRefs = (brief: ScheduleInput["brief"]) => brief.references.filter(value => value.dayIndex === null || value.dayIndex === day.dayIndex);
      const relevantOverrides = (brief: ScheduleInput["brief"]) => brief.acceptedPolicyOverrides.filter(value => value.dayIndex === null || value.dayIndex === day.dayIndex);
      const relevantStays = (brief: ScheduleInput["brief"]) => brief.durationOverrides.filter(value => value.visitId === undefined ? placeIds.has(value.placeId) : visitIds.has(value.visitId));
      if (!same(input.brief.destination, oldBrief.destination) || input.brief.startDate !== oldBrief.startDate || input.brief.exactDateVerificationRequired !== oldBrief.exactDateVerificationRequired
        || !same(relevantHard(input.brief), relevantHard(oldBrief)) || !same(relevantRefs(input.brief), relevantRefs(oldBrief))
        || !same(relevantOverrides(input.brief), relevantOverrides(oldBrief)) || !same(relevantStays(input.brief), relevantStays(oldBrief))
        || !same(input.brief.dayWindows.filter(value => value.dayIndex === day.dayIndex), oldBrief.dayWindows.filter(value => value.dayIndex === day.dayIndex))
        || !same(input.brief.boundaries.filter(value => value.dayIndex === day.dayIndex), oldBrief.boundaries.filter(value => value.dayIndex === day.dayIndex))
        || input.dayModes.find(value => value.dayId === day.id)?.mode !== day.mode
        || input.brief.preferences.pace !== oldBrief.preferences.pace) add("scope.pending_requirements", day.id, "Changed accepted requirements affect an unscoped frozen day; resolve scope explicitly");
      for (const resolution of input.base.conditionResolutions.filter(value => day.visits.some(visit => visit.evidenceIds.includes(value.evidenceId)))) if (!input.conditionResolutions.some(value => same(value, resolution))) add("scope.frozen_resolution_missing", resolution.evidenceId, "Retain frozen admission resolutions for unchanged days");
      if (visitIds.size !== day.visits.length) add("scope.invalid_base", day.id, "Frozen day identities are not unique");
      const requireFrozen = <T extends { id: string }>(id: string, current: readonly T[], frozen: readonly T[]) => {
        if (!same(current.find(value => value.id === id), frozen.find(value => value.id === id)) || !current.some(value => value.id === id)) add("scope.frozen_fact_missing", id, "Local input must retain exact frozen facts used by unchanged days");
      };
      for (const visit of day.visits) {
        requireFrozen(visit.placeId, input.places, input.base.places);
        requireFrozen(visit.candidateId, input.candidateSet.candidates, input.base.candidates);
        for (const id of visit.evidenceIds) requireFrozen(id, input.evidence, input.base.evidence);
        if (visit.durationOrigin.durationOptionId !== null) requireFrozen(visit.durationOrigin.durationOptionId, input.durationOptions, input.base.durationOptions);
        if (visit.durationOptionId !== null) requireFrozen(visit.durationOptionId, input.durationOptions, input.base.durationOptions);
      }
      for (const transfer of [...day.legs, ...day.boundaryTransfers]) {
        requireFrozen(transfer.route.id, input.routes, input.base.routes);
        requireFrozen(transfer.route.fromPlaceId, input.places, input.base.places);
        requireFrozen(transfer.route.toPlaceId, input.places, input.base.places);
      }
    }
  }
  if (input.scope.kind === "local") for (const id of input.scope.dayIds) if (!input.draft.days.some(day => day.id === id) && !input.base?.itinerary.days.some(day => day.id === id)) add("scope.unknown_day", id, "Scope must name an existing day");
  for (const mode of input.dayModes) if (!input.draft.days.some(day => day.id === mode.dayId)) add("transport.unknown_day", mode.dayId, "Mode binding names an unsupplied day");
  for (const binding of input.visitBindings) if (!input.draft.days.some(day => day.visits.some(visit => visit.id === binding.visitId))) add("visit.unknown_binding", binding.visitId, "Visit binding is outside the draft");
  const segmentIds = new Set(input.draft.days.flatMap(day => segments(input, day).map(segment => segment.id)));
  for (const binding of input.routeBindings) if (!segmentIds.has(binding.segmentId)) add("route.unknown_binding", binding.segmentId, "Route binding is outside the required segments");
  for (const option of input.durationOptions) {
    const fact = input.evidence.find(value => value.id === option.evidenceId);
    if (!fact || fact.placeId !== option.placeId || fact.revision !== option.evidenceRevision || fact.field !== "stay_duration") add("duration.evidence_binding", option.id, "Duration option must bind its supplied Place/stay Evidence revision");
  }
  for (const fact of input.evidence) if (!input.places.some(place => place.id === fact.placeId)) add("evidence.place_binding", fact.id, "Evidence Place is not supplied");
  for (const route of input.routes) if (!input.places.some(place => place.id === route.fromPlaceId) || !input.places.some(place => place.id === route.toPlaceId)) add("route.place_binding", route.id, "Route endpoints must have supplied grounding");
  const overrideValues = new Map<string, unknown>();
  for (const override of input.brief.acceptedPolicyOverrides) for (const [key, value] of Object.entries(override.settings)) {
    const identity = `${override.dayIndex}:${key}`;
    if (overrideValues.has(identity) && !same(overrideValues.get(identity), value)) add("policy.override_conflict", identity, "Conflicting accepted settings in the same scope require an Owner decision");
    overrideValues.set(identity, value);
  }
  for (const resolution of input.conditionResolutions) {
    const fact = input.evidence.find(value => value.id === resolution.evidenceId && value.revision === resolution.evidenceRevision);
    if (!fact || !["reservation_requirements", "entry_conditions", "accessibility"].includes(fact.field)) add("evidence.resolution_binding", resolution.evidenceId, "Condition resolution must bind to the supplied condition Evidence revision");
  }
  for (const candidate of input.candidateSet.candidates) {
    const place = input.places.find(value => value.id === candidate.placeId);
    if (!place || place.factRevision !== candidate.placeFactRevision) add("candidate.place_revision", candidate.id, "Candidate Place revision is not supplied");
    for (const id of candidate.evidenceIds) if (!input.evidence.some(value => value.id === id && value.placeId === candidate.placeId)) add("candidate.evidence_binding", id, "Candidate Evidence must be supplied and bind to its Place");
    for (const id of candidate.durationOptionIds) if (!input.durationOptions.some(value => value.id === id && value.placeId === candidate.placeId)) add("candidate.duration_binding", id, "Candidate duration option must be supplied and bind to its Place");
  }
  for (const day of input.draft.days) for (const visit of day.visits) {
    const binding = input.visitBindings.find(value => value.visitId === visit.id);
    const candidate = input.candidateSet.candidates.find(value => value.id === binding?.candidateId);
    if (!candidate || candidate.placeId !== visit.placeId) add("visit.candidate_binding", visit.id, "Visit must reference its supplied candidate Place");
    if (visit.durationOptionId !== null && !candidate?.durationOptionIds.includes(visit.durationOptionId)) add("visit.duration_binding", visit.id, "Visit duration option was not supplied for this candidate");
    if (visit.evidenceIds.some(id => !candidate?.evidenceIds.includes(id))) add("visit.evidence_binding", visit.id, "Visit references unsupplied candidate Evidence");
    const previous = input.base?.itinerary.days.flatMap(value => value.visits).find(value => value.id === visit.id);
    const owner = input.brief.durationOverrides.find(value => value.visitId === visit.id && value.placeId === visit.placeId)
      ?? input.brief.durationOverrides.find(value => value.visitId === undefined && value.placeId === visit.placeId);
    if (visit.durationMinutes !== null && visit.durationMinutes !== owner?.durationMinutes && visit.durationMinutes !== previous?.durationMinutes) add("duration.unsupplied_numeric", visit.id, "Draft numerical stays must come from an explicit Owner override or the frozen base");
    if (previous && previous.placeId !== visit.placeId) add("visit.identity_changed", visit.id, "A surviving Visit ID cannot identify a replacement Place");
    if (!previous && input.base?.itinerary.days.some(value => value.visits.some(old => old.placeId === visit.placeId)) && !input.brief.allowedRepeatedPlaceIds.includes(visit.placeId)) add("visit.surviving_id", visit.id, "A surviving planned presence must retain its Visit ID");
  }
  return issues;
}

export type DayRules = {
  policy: EffectiveDayPolicy; date: string | null;
  window: ScheduledDay["window"]; mode: RouteFact["mode"];
  breaks: { id: string; kind: "meal" | "break"; startMinute: number; endMinute: number; origin: "owner" | "policy"; overrideId: string | null }[];
  notices: ValidationIssue[];
};

export function overrideFor(policy: EffectiveDayPolicy, key: keyof EffectiveDayPolicy): string | null {
  return [...policy.overrides].sort((a, b) => Number(a.dayIndex !== null) - Number(b.dayIndex !== null) || a.id.localeCompare(b.id)).filter(value => key in value.settings).at(-1)?.id ?? null;
}

export function dayRules(input: ScheduleInput, day: ScheduleInput["draft"]["days"][number]): DayRules {
  const policy = effectivePolicy(input.policy, input.brief.acceptedPolicyOverrides, input.brief.preferences.pace ?? "balanced", day.dayIndex);
  const explicit = input.brief.dayWindows.filter(value => value.dayIndex === day.dayIndex);
  const windows = [...(explicit.length ? explicit : [policy.window]), ...input.brief.hardConstraints.filter((value): value is Extract<typeof value, { type: "allowed_day_window" }> => value.type === "allowed_day_window" && value.dayIndex === day.dayIndex)];
  const window = { startMinute: Math.max(...windows.map(value => value.startMinute)), endMinute: Math.min(...windows.map(value => value.endMinute)) };
  const notices: ValidationIssue[] = [];
  if (window.startMinute >= window.endMinute) notices.push(issue("window.empty", day.id, "Effective day window has no usable interval"));
  if (window.endMinute > 1439) notices.push(issue("window.same_day", day.id, "The effective window must use the supported same-day clock range"));
  const mode = input.dayModes.find(value => value.dayId === day.id)?.mode ?? "walk";
  if (!input.requirementContext.supportedTransportModes.includes(mode) || input.brief.hardConstraints.some(value => value.type === "transport_modes" && !value.modes.includes(mode))) notices.push(issue("transport.unsupported", day.id, "Day mode violates supported capabilities or hard restrictions"));
  const breaks: DayRules["breaks"] = [];
  const free = input.brief.explicitlyFreeDayIndices.includes(day.dayIndex);
  if (!free) {
    if (policy.lunch.enabled) {
      const end = policy.lunch.startMinute + policy.lunch.durationMinutes;
      if (window.startMinute <= policy.lunch.startMinute && window.endMinute >= end) {
        const overrideId = overrideFor(policy, "lunch");
        breaks.push({ id: "lunch", kind: "meal", startMinute: policy.lunch.startMinute, endMinute: end, origin: overrideId ? "owner" : "policy", overrideId });
      } else notices.push(issue("policy.lunch_omitted", day.id, "Short day window does not contain the full lunch reservation", "ASSUMPTION"));
    }
    for (const value of policy.breaks) breaks.push({ ...value, kind: "break", origin: "owner", overrideId: overrideFor(policy, "breaks") });
  }
  breaks.sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id));
  for (let index = 0; index < breaks.length; index++) {
    if (breaks[index].startMinute < window.startMinute || breaks[index].endMinute > window.endMinute) notices.push(issue("break.outside_window", day.id, "An explicit break lies outside the effective day window"));
    if (index && breaks[index].startMinute < breaks[index - 1].endMinute) notices.push(issue("break.overlap", day.id, "Reserved breaks overlap"));
  }
  return { policy, date: calendarDate(input.brief.startDate, day.dayIndex), window, mode, breaks, notices };
}

export function buffer(coverage: BufferCoverage, allowanceMinutes: number, policyKey: string, overrideId: string | null): EffectiveBuffer {
  const additionalMinutes = overrideId !== null ? allowanceMinutes
    : coverage.status === "excluded" ? allowanceMinutes
    : coverage.status === "included" && coverage.includedMinutes !== null ? Math.max(0, allowanceMinutes - coverage.includedMinutes) : 0;
  return { coverage, allowanceMinutes, additionalMinutes, origin: overrideId ? "owner" : "policy", policyKey, overrideId };
}

export type VisitRules = {
  durationMinutes: number; durationOrigin: DurationProvenance; entryBuffer: EffectiveBuffer;
  openings: { startMinute: number; endMinute: number }[]; latestEntry: number | null;
  evidenceIds: string[]; notices: ValidationIssue[];
};

export function visitRules(input: ScheduleInput, visit: ScheduleInput["draft"]["days"][number]["visits"][number], rules: DayRules): VisitRules {
  const notices: ValidationIssue[] = [];
  const facts = input.evidence.filter(value => value.placeId === visit.placeId);
  const current = facts.filter(value => applicable(value, rules.date));
  const known = current.filter(value => value.status === "known");
  const previous = input.base?.itinerary.days.flatMap(day => day.visits).find(value => value.id === visit.id);
  const owner = input.brief.durationOverrides.find(value => value.visitId === visit.id && value.placeId === visit.placeId)
    ?? input.brief.durationOverrides.find(value => value.visitId === undefined && value.placeId === visit.placeId);
  const binding = input.visitBindings.find(value => value.visitId === visit.id);
  const candidate = input.candidateSet.candidates.find(value => value.id === binding?.candidateId);
  const options = input.durationOptions.filter(value => value.placeId === visit.placeId && candidate?.durationOptionIds.includes(value.id));
  const usable = options.filter(value => value.status === "usable" && value.durationMinutes >= 1 && value.durationMinutes <= 1439 && known.some(fact => fact.id === value.evidenceId && fact.revision === value.evidenceRevision && fact.field === "stay_duration" && fact.value === value.durationMinutes));
  const chosen = visit.durationOptionId === null ? usable.length === 1 ? usable[0] : undefined : usable.find(value => value.id === visit.durationOptionId);
  const excluded: BufferCoverage = { status: "excluded", includedMinutes: null };
  let durationMinutes = rules.policy.stayMinutes;
  const policyOverrideId = overrideFor(rules.policy, "stayMinutes");
  let durationOrigin: DurationProvenance = { origin: policyOverrideId ? "owner" : "policy", evidenceId: null, evidenceRevision: null, durationOptionId: null, policyKey: "stayMinutes", overrideId: policyOverrideId, entryCoverage: excluded };
  if (previous?.locked) {
    durationMinutes = previous.durationMinutes;
    durationOrigin = previous.durationOrigin;
    if (owner && owner.durationMinutes !== durationMinutes) notices.push(issue("lock.duration_override", visit.id, "An Owner duration change cannot overwrite a locked stay"));
  } else if (input.typedCommand && previous && previous.placeId === visit.placeId &&
    !(input.typedCommand.type === "update_visit_duration" && input.typedCommand.visitId === visit.id)) {
    durationMinutes = previous.durationMinutes;
    durationOrigin = previous.durationOrigin;
    if (owner && owner.durationMinutes !== durationMinutes) notices.push(issue("duration.pending_override", visit.id, "Pending stay override cannot silently change a surviving Visit during another Typed Command"));
  } else if (owner || (previous?.durationOrigin.origin === "owner" && previous.placeId === visit.placeId)) {
    durationMinutes = owner?.durationMinutes ?? previous!.durationMinutes;
    durationOrigin = owner ? { origin: "owner", evidenceId: null, evidenceRevision: null, durationOptionId: null, policyKey: null, overrideId: null, entryCoverage: excluded } : previous!.durationOrigin;
  } else if (policyOverrideId !== null) {
    // Accepted structured stay settings are Owner values, above sourced recommendations.
    durationMinutes = rules.policy.stayMinutes;
  } else if (chosen) {
    durationMinutes = chosen.durationMinutes;
    durationOrigin = { origin: "evidence", evidenceId: chosen.evidenceId, evidenceRevision: chosen.evidenceRevision, durationOptionId: chosen.id, policyKey: null, overrideId: null, entryCoverage: chosen.entryCoverage };
  } else {
    if (usable.length > 1 && visit.durationOptionId === null) notices.push(issue("duration.ambiguous_option", visit.id, "Select a supplied sourced duration option before scheduling"));
    notices.push(issue("policy.stay_default", visit.id, `Using the visible ${durationMinutes}-minute policy stay`, "ASSUMPTION"));
  }
  for (const option of options) {
    if (!usable.includes(option)) notices.push(issue("duration.unusable_source", visit.id, "Sourced duration is invalid, stale, unknown or inapplicable", option.requiredMinimum ? "ERROR" : "WARNING", "owner_decision", [option.evidenceId]));
    if (option.requiredMinimum && usable.includes(option) && durationMinutes < option.durationMinutes) notices.push(issue("duration.required_minimum", visit.id, "Planned stay is below a sourced required minimum", "ERROR", "owner_decision", [option.evidenceId]));
  }
  const entryBuffer = buffer(durationOrigin.entryCoverage, rules.policy.entryBufferMinutes, "entryBufferMinutes", overrideFor(rules.policy, "entryBufferMinutes"));
  if (entryBuffer.coverage.status === "unknown" && entryBuffer.overrideId === null) notices.push(issue("buffer.entry_unknown", visit.id, "Entry coverage is unknown; no second allowance added", "WARNING"));
  const required = input.brief.hardConstraints.filter((value): value is Extract<typeof value, { type: "verified_fact" }> => value.type === "verified_fact" && value.placeId === visit.placeId);
  const admissionRequired = input.brief.exactDateVerificationRequired || required.some(value => value.field === "admission");
  const accessRequired = required.some(value => value.field === "accessibility");
  const fields: EvidenceFact["field"][] = ["opening_windows", "closure_dates", "latest_entry", "reservation_requirements", "entry_conditions"];
  for (const field of [...fields, "accessibility" as const]) {
    const needed = field === "accessibility" ? accessRequired : admissionRequired;
    const records = current.filter(value => value.field === field);
    const unknown = records.length === 0 || records.some(value => value.status !== "known");
    if (unknown && (needed || field === "opening_windows")) notices.push(issue(`admission.${field}_unverified`, visit.id, `${field} is not verified for this date`, needed ? "ERROR" : "WARNING", "owner_decision", records.map(value => value.id)));
    for (const fact of records) if (fact.status === "conflicting") notices.push(issue("admission.conflicting", visit.id, "Conflicting admission facts require resolution", "ERROR", "owner_decision", [fact.id]));
  }
  let openings = [{ startMinute: 0, endMinute: 1439 }];
  let latestEntry: number | null = null;
  for (const fact of known) {
    if (fact.field === "opening_windows" && Array.isArray(fact.value)) {
      const windows = fact.value.filter((value): value is { startMinute: number; endMinute: number } => typeof value === "object" && value !== null && "startMinute" in value);
      openings = openings.flatMap(left => windows.map(right => ({ startMinute: Math.max(left.startMinute, right.startMinute), endMinute: Math.min(left.endMinute, right.endMinute) })).filter(value => value.startMinute < value.endMinute));
      if (openings.length === 0) notices.push(issue("admission.closed", visit.id, "Known opening windows provide no permitted stay interval", "ERROR", "owner_decision", [fact.id]));
    }
    if (fact.field === "closure_dates" && rules.date !== null && Array.isArray(fact.value) && fact.value.some(value => value === rules.date)) notices.push(issue("admission.closed", visit.id, "Place is known closed on the planned date", "ERROR", "owner_decision", [fact.id]));
    if (fact.field === "latest_entry" && typeof fact.value === "number") latestEntry = Math.min(latestEntry ?? 1439, fact.value);
    const conditionRequired = (fact.field === "reservation_requirements" && fact.value !== false) || (fact.field === "entry_conditions" && Array.isArray(fact.value) && fact.value.length > 0) || (fact.field === "accessibility" && accessRequired);
    if (conditionRequired) {
      const resolution = input.conditionResolutions.find(value => value.evidenceId === fact.id && value.evidenceRevision === fact.revision)?.status;
      const met = fact.field === "accessibility" && typeof fact.value === "boolean" ? fact.value : resolution === "met";
      if (!met) notices.push(issue("admission.condition_unmet", visit.id, "A known required entry/reservation/accessibility condition is unmet or unresolved", "ERROR", "owner_decision", [fact.id]));
    }
  }
  if (rules.date === null) notices.push(issue("admission.undated", visit.id, "Undated proposal does not assert date-specific availability", "ASSUMPTION"));
  return { durationMinutes, durationOrigin, entryBuffer, openings: openings.sort((a, b) => a.startMinute - b.startMinute), latestEntry, evidenceIds: facts.map(value => value.id).sort(), notices };
}

export type Segment = { id: string; kind: "leg" | "boundary_transfer"; from: BoundaryEndpoint; to: BoundaryEndpoint; fromPlaceId: string; toPlaceId: string };
export function segments(input: ScheduleInput, day: ScheduleInput["draft"]["days"][number]): Segment[] {
  const result: Segment[] = [];
  const refFor = (role: "start" | "end") => {
    const boundary = input.brief.boundaries.find(value => value.dayIndex === day.dayIndex);
    const referenceId = boundary?.[`${role}ReferenceId`];
    return input.brief.references.find(value => value.status === "resolved" && value.role === role && (referenceId ? value.id === referenceId : value.dayIndex === day.dayIndex || value.dayIndex === null))?.placeId ?? null;
  };
  const start = refFor("start"), end = refFor("end");
  const visitEndpoint = (id: string): BoundaryEndpoint => ({ kind: "visit", visitId: id });
  const placeEndpoint = (id: string): BoundaryEndpoint => ({ kind: "place", placeId: id });
  if (day.visits.length === 0) {
    if (start && end) result.push({ id: `boundary_${day.id.slice(4)}-direct`, kind: "boundary_transfer", from: placeEndpoint(start), to: placeEndpoint(end), fromPlaceId: start, toPlaceId: end });
    return result;
  }
  const first = day.visits[0], last = day.visits[day.visits.length - 1];
  if (start) result.push({ id: `boundary_${day.id.slice(4)}-start`, kind: "boundary_transfer", from: placeEndpoint(start), to: visitEndpoint(first.id), fromPlaceId: start, toPlaceId: first.placeId });
  for (let index = 0; index < day.visits.length - 1; index++) {
    const from = day.visits[index], to = day.visits[index + 1];
    result.push({ id: `leg_${from.id.slice(6)}-to-${to.id.slice(6)}`, kind: "leg", from: visitEndpoint(from.id), to: visitEndpoint(to.id), fromPlaceId: from.placeId, toPlaceId: to.placeId });
  }
  if (end) result.push({ id: `boundary_${day.id.slice(4)}-end`, kind: "boundary_transfer", from: visitEndpoint(last.id), to: placeEndpoint(end), fromPlaceId: last.placeId, toPlaceId: end });
  return result;
}

export function identityRoute(segment: Segment, mode: RouteFact["mode"]): RouteFact {
  return { id: `route_identity-${segment.id.replaceAll("_", "-")}`, factRevision: 1, fromPlaceId: segment.fromPlaceId, toPlaceId: segment.toPlaceId, mode, status: "identity", durationMinutes: 0, zeroDurationConfirmed: false, distanceMeters: 0, geometry: null, provider: null, retrievedAt: null, sourceKind: "code_identity", temporalBasis: "identity", freshness: "current", applicability: { date: null, departureWindow: null }, transferCoverage: { status: "excluded", includedMinutes: null }, walking: { durationMinutes: 0, distanceMeters: 0, longestSegmentMinutes: 0 } };
}

export function routeMatches(route: RouteFact, segment: Segment, mode: RouteFact["mode"], date: string | null, departure: number | null): boolean {
  const window = route.applicability.departureWindow;
  return route.freshness === "current"
    && (route.temporalBasis !== "departure_estimate" || (route.applicability.date !== null && window !== null))
    && route.fromPlaceId === segment.fromPlaceId && route.toPlaceId === segment.toPlaceId && route.mode === mode
    && (route.applicability.date === null || route.applicability.date === date)
    && (window === null || (departure !== null && departure >= window.startMinute && departure < window.endMinute));
}
