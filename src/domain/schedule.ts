import {
  scheduleInputSchema, scheduledItinerarySchema,
  type BoundaryTransfer, type RouteRequirement, type ScheduleBlock, type ScheduleInput,
  type ScheduleResult, type ScheduledDay, type ScheduledLeg, type ScheduledVisit, type ValidationIssue,
} from "./canonical";
import { validateItinerary } from "./validation";
import { buffer, dayRules, identityRoute, inputIssues, issue, overrideFor, report, routeMatches, segments, visitRules, type DayRules, type Segment } from "./scheduling-rules";

export function scheduleItinerary(raw: ScheduleInput): ScheduleResult {
  const input = scheduleInputSchema.parse(raw);
  const issues = inputIssues(input);
  const routeRequirements: RouteRequirement[] = [];
  const days: ScheduledDay[] = [];
  for (const day of input.draft.days) {
    if (input.scope.kind === "local" && !input.scope.dayIds.includes(day.id)) {
      const preserved = input.base?.itinerary.days.find(value => value.id === day.id);
      if (preserved) { days.push(preserved); continue; }
      issues.push(issue("scope.missing_base_day", day.id, "Unscoped day has no frozen base", "ERROR", "reject"));
    }
    const rules = dayRules(input, day);
    const notices: ValidationIssue[] = [...rules.notices];
    const visits: ScheduledVisit[] = [], legs: ScheduledLeg[] = [], boundaryTransfers: BoundaryTransfer[] = [];
    const blocks: ScheduleBlock[] = [];
    const requiredSegments = segments(input, day);
    let cursor = rules.window.startMinute;
    let unresolved = rules.notices.some(value => value.severity === "ERROR");
    let sequence = 0;
    const consumedBreaks = new Set<string>();
    const emit = (kind: ScheduleBlock["kind"], startMinute: number, endMinute: number, data: Partial<ScheduleBlock> = {}) => {
      blocks.push({
        id: `block_${day.id.slice(4)}-${sequence++}`, kind, startMinute, endMinute,
        visitId: null, legId: null, boundaryTransferId: null, origin: "derived",
        policyKey: null, evidenceId: null, evidenceRevision: null,
        routeFactId: null, routeFactRevision: null, overrideId: null, ...data,
      });
    };
    const emitBreak = (reservation: DayRules["breaks"][number]) => {
      emit(reservation.kind, reservation.startMinute, reservation.endMinute, {
        origin: reservation.origin, policyKey: reservation.kind === "meal" ? "lunch" : reservation.id,
        overrideId: reservation.overrideId,
      });
      consumedBreaks.add(reservation.id);
      cursor = reservation.endMinute;
    };
    const advance = (target: number) => {
      for (const reservation of rules.breaks) {
        if (consumedBreaks.has(reservation.id) || reservation.endMinute > target) continue;
        if (reservation.startMinute > cursor) emit("wait", cursor, reservation.startMinute);
        emitBreak(reservation);
      }
      if (target > cursor) emit("wait", cursor, target);
      cursor = target;
    };
    const availableStart = (earliest: number, length: number) => {
      let start = earliest;
      for (const reservation of rules.breaks) if (start < reservation.endMinute && start + length > reservation.startMinute) start = reservation.endMinute;
      return start;
    };
    const place = (kind: ScheduleBlock["kind"], duration: number, data: Partial<ScheduleBlock> = {}): boolean => {
      const start = availableStart(cursor, duration);
      if (start + duration > rules.window.endMinute) {
        notices.push(issue("schedule.window_exceeded", day.id, "Supplied order exceeds the effective day window", "ERROR", "redraft"));
        unresolved = true;
        return false;
      }
      advance(start);
      emit(kind, cursor, cursor + duration, data);
      cursor += duration;
      return true;
    };
    const requireRoute = (segment: Segment, departureMinute: number | null) => {
      if (!routeRequirements.some(value => value.segmentId === segment.id)) routeRequirements.push({ dayId: day.id, segmentId: segment.id, fromPlaceId: segment.fromPlaceId, toPlaceId: segment.toPlaceId, mode: rules.mode, date: rules.date, departureMinute });
    };
    // Inspect every required segment even when an earlier missing duration prevents clocks.
    for (const segment of requiredSegments) {
      if (segment.fromPlaceId === segment.toPlaceId) continue;
      const binding = input.routeBindings.find(value => value.segmentId === segment.id);
      const route = input.routes.find(value => value.id === binding?.routeFactId);
      if (!route || route.status === "unknown") {
        notices.push(issue("route.duration_missing", segment.id, "Required route duration is unknown; feasibility remains unverified", "ERROR", "retry"));
        requireRoute(segment, null);
      } else if (route.status === "unreachable") notices.push(issue("route.unreachable", segment.id, "Required transfer is known unreachable", "ERROR", "owner_decision", [route.id]));
      else if (route.freshness !== "current") {
        notices.push(issue("route.freshness", segment.id, "New planning requires current route facts", "ERROR", "reroute", [route.id]));
        requireRoute(segment, null);
      }
      if (route?.temporalBasis === "current_estimate") notices.push(issue("route.current_estimate", segment.id, "Current route estimate is not a guarantee of future-date availability", "WARNING", "owner_decision", [route.id]));
    }
    const transfer = (segment: Segment | undefined) => {
      if (!segment || unresolved) return;
      const binding = input.routeBindings.find(value => value.segmentId === segment.id);
      const route = segment.fromPlaceId === segment.toPlaceId ? identityRoute(segment, rules.mode) : input.routes.find(value => value.id === binding?.routeFactId);
      if (!route || route.durationMinutes === null || !["confirmed", "identity"].includes(route.status)) { unresolved = true; return; }
      const departure = availableStart(cursor, route.durationMinutes);
      if (!routeMatches(route, segment, rules.mode, rules.date, departure)) {
        notices.push(issue("route.applicability", segment.id, "Route no longer matches endpoints, mode, date or departure context", "ERROR", "reroute", [route.id]));
        requireRoute(segment, departure);
        unresolved = true;
        return;
      }
      const transferBuffer = buffer(route.transferCoverage, route.status === "identity" ? 0 : rules.policy.transferBufferMinutes[rules.mode], "transferBufferMinutes", route.status === "identity" ? null : overrideFor(rules.policy, "transferBufferMinutes"));
      if (transferBuffer.coverage.status === "unknown" && transferBuffer.overrideId === null) notices.push(issue("buffer.transfer_unknown", segment.id, "Transfer coverage is unknown; no second allowance added", "WARNING", "owner_decision", [route.id]));
      const reference = segment.kind === "leg" ? { legId: segment.id } : { boundaryTransferId: segment.id };
      if (!place(segment.kind, route.durationMinutes, { ...reference, origin: route.status === "identity" ? "derived" : "provider", routeFactId: route.id, routeFactRevision: route.factRevision })) return;
      if (segment.kind === "leg" && segment.from.kind === "visit" && segment.to.kind === "visit") legs.push({ id: segment.id, fromVisitId: segment.from.visitId, toVisitId: segment.to.visitId, route, transferBuffer });
      else boundaryTransfers.push({ id: segment.id, from: segment.from, to: segment.to, route, transferBuffer });
      if (transferBuffer.additionalMinutes > 0) place("transfer_buffer", transferBuffer.additionalMinutes, { ...reference, origin: transferBuffer.origin, policyKey: transferBuffer.policyKey, overrideId: transferBuffer.overrideId, routeFactId: route.id, routeFactRevision: route.factRevision });
    };
    if (day.visits.length === 0) transfer(requiredSegments[0]);
    else transfer(requiredSegments.find(value => value.from.kind === "place"));
    for (let index = 0; index < day.visits.length; index++) {
      const visit = day.visits[index];
      const requirements = visitRules(input, visit, rules);
      notices.push(...requirements.notices);
      if (unresolved || requirements.notices.some(value => value.severity === "ERROR")) { unresolved = true; continue; }
      const fixed = input.brief.hardConstraints.find(value => value.type === "fixed_visit_start" && value.visitId === visit.id);
      const fixedStart = fixed?.type === "fixed_visit_start" ? fixed.startMinute : null;
      const length = requirements.entryBuffer.additionalMinutes + requirements.durationMinutes;
      let start: number | null = null;
      for (const opening of requirements.openings) {
        const earliest = Math.max(cursor, rules.window.startMinute, opening.startMinute);
        const proposed = fixedStart === null ? availableStart(earliest, length) : fixedStart - requirements.entryBuffer.additionalMinutes;
        if (proposed < earliest || proposed + length > Math.min(opening.endMinute, rules.window.endMinute)) continue;
        if (rules.breaks.some(value => proposed < value.endMinute && proposed + length > value.startMinute)) continue;
        if (requirements.latestEntry !== null && proposed + requirements.entryBuffer.additionalMinutes > requirements.latestEntry) continue;
        start = proposed;
        break;
      }
      if (start === null) {
        const fixedBreak = fixedStart !== null && rules.breaks.some(value => fixedStart - requirements.entryBuffer.additionalMinutes < value.endMinute && fixedStart + requirements.durationMinutes > value.startMinute);
        notices.push(issue(fixedBreak ? "schedule.fixed_break_conflict" : "schedule.visit_placement", visit.id, fixedBreak ? "Fixed Visit overlaps an editable reserved break; explicitly change the break or fixed start" : "This supplied order cannot place the stay and entry allowance within the known windows and fixed constraints", "ERROR", fixedStart === null ? "redraft" : "owner_decision"));
        unresolved = true;
        continue;
      }
      advance(start);
      if (requirements.entryBuffer.additionalMinutes > 0) {
        emit("entry_buffer", cursor, cursor + requirements.entryBuffer.additionalMinutes, { visitId: visit.id, origin: requirements.entryBuffer.origin, policyKey: "entryBufferMinutes", overrideId: requirements.entryBuffer.overrideId });
        cursor += requirements.entryBuffer.additionalMinutes;
      }
      const visitStart = cursor;
      emit("visit", cursor, cursor + requirements.durationMinutes, {
        visitId: visit.id, origin: requirements.durationOrigin.origin, policyKey: requirements.durationOrigin.policyKey,
        overrideId: requirements.durationOrigin.overrideId, evidenceId: requirements.durationOrigin.evidenceId, evidenceRevision: requirements.durationOrigin.evidenceRevision,
      });
      cursor += requirements.durationMinutes;
      const binding = input.visitBindings.find(value => value.visitId === visit.id);
      const candidate = input.candidateSet.candidates.find(value => value.id === binding?.candidateId);
      if (!candidate) { unresolved = true; continue; }
      visits.push({ ...visit, candidateId: candidate.id, placeFactRevision: candidate.placeFactRevision, durationMinutes: requirements.durationMinutes, durationOrigin: requirements.durationOrigin, entryBuffer: requirements.entryBuffer, evidenceIds: requirements.evidenceIds, startMinute: visitStart, endMinute: cursor });
      if (index + 1 < day.visits.length) {
        if ((index + 1) % rules.policy.rest.everyVisits === 0 && rules.policy.rest.durationMinutes > 0) {
          const overrideId = overrideFor(rules.policy, "rest");
          place("rest", rules.policy.rest.durationMinutes, { visitId: visit.id, origin: overrideId ? "owner" : "policy", policyKey: "rest", overrideId });
        }
        transfer(requiredSegments.find(value => value.kind === "leg" && value.from.kind === "visit" && value.from.visitId === visit.id));
      }
    }
    if (day.visits.length > 0) transfer(requiredSegments.find(value => value.to.kind === "place"));
    if (!unresolved) {
      const lastBreak = rules.breaks.at(-1);
      if (lastBreak && lastBreak.endMinute > cursor) advance(lastBreak.endMinute);
      days.push({ id: day.id, dayIndex: day.dayIndex, date: rules.date, timeZone: input.brief.destination.status === "resolved" ? input.brief.destination.timeZone : "Asia/Shanghai",
        explicitlyFree: input.brief.explicitlyFreeDayIndices.includes(day.dayIndex), window: rules.window, mode: rules.mode, effectivePolicy: rules.policy,
        visits, legs, boundaryTransfers, scheduleBlocks: blocks, notices: report(notices).issues });
    }
    issues.push(...notices);
  }
  const blocked = (): ScheduleResult => ({
    status: routeRequirements.length > 0 && !issues.some(value => value.severity === "ERROR" && !value.code.startsWith("route.")) ? "route_required" : "blocked",
    draft: input.draft, report: report(issues), routeRequirements,
  });
  if (issues.some(value => value.severity === "ERROR") || days.length !== input.draft.days.length) return blocked();
  const candidate = scheduledItinerarySchema.safeParse({
    schemaVersion: "canonical-v2", kind: "scheduled", tripId: input.draft.tripId, runId: input.draft.runId,
    baseVersionId: input.draft.baseVersionId, briefRevision: input.brief.revision, policyVersion: input.policy.id, days,
  });
  if (!candidate.success) {
    issues.push(issue("schedule.invalid_candidate", "trip", "Forward placement did not produce a valid canonical schedule", "ERROR", "reject"));
    return blocked();
  }
  const validation = validateItinerary({ candidate: candidate.data, context: input });
  issues.push(...validation.issues);
  if (!validation.commitEligible) return blocked();
  return { status: "scheduled", itinerary: candidate.data, report: report(issues) };
}
