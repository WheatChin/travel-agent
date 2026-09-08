import {
  scheduleInputSchema, scheduledItinerarySchema,
  type ScheduleBlock, type ValidationInput, type ValidationIssue, type ValidationReport,
} from "./canonical";
import { buffer, dayRules, identityRoute, inputIssues, issue, overrideFor, report, routeMatches, same, segments, visitRules } from "./scheduling-rules";

// This inspector reads the supplied ledger. It never generates a replacement schedule.
export function validateItinerary(raw: ValidationInput): ValidationReport {
  const input = scheduleInputSchema.parse(raw.context);
  if (input.typedCommand?.type === "set_visit_lock") {
    const command = input.typedCommand;
    const base = input.base;
    const parsed = scheduledItinerarySchema.safeParse(raw.candidate);
    if (!base || !parsed.success) return report([issue("command.metadata_base", command.visitId, "Metadata command requires an exact canonical base and candidate")]);
    const candidate = parsed.data;
    const issues: ValidationIssue[] = [];
    const check = (ok: boolean, code: string) => {
      if (!ok) issues.push(issue(code, command.visitId, "Lock command may change only the requested Visit lock metadata"));
    };
    const targetDay = base.itinerary.days.find(day => day.visits.some(visit => visit.id === command.visitId));
    check(!!targetDay, "command.target_missing");
    check(input.scope.kind === "local" && input.scope.dayIds.length === 1 && input.scope.dayIds[0] === targetDay?.id, "command.metadata_scope");
    check(candidate.tripId === base.tripId && candidate.tripId === input.draft.tripId &&
      candidate.baseVersionId === base.id && input.draft.baseVersionId === base.id &&
      candidate.runId === input.draft.runId && candidate.briefRevision === base.briefRevision &&
      input.draft.briefRevision === base.briefRevision &&
      input.candidateSet.tripId === base.tripId && input.candidateSet.runId === candidate.runId &&
      input.candidateSet.baseVersionId === base.id, "command.metadata_identity");
    check(same(input.brief, base.brief) && same(input.policy, base.policy) &&
      candidate.policyVersion === base.itinerary.policyVersion, "command.metadata_policy");
    const expectedDays = base.itinerary.days.map(day => ({
      ...day, visits: day.visits.map(visit => visit.id === command.visitId ? { ...visit, locked: command.locked } : visit),
    }));
    check(same(candidate.days, expectedDays), "command.metadata_content");
    check(same(input.draft.days, expectedDays.map(day => ({
      id: day.id, dayIndex: day.dayIndex, visits: day.visits.map(visit => ({
        id: visit.id, placeId: visit.placeId, durationOptionId: visit.durationOptionId,
        durationMinutes: visit.durationMinutes, locked: visit.locked, evidenceIds: visit.evidenceIds,
      })),
    }))), "command.metadata_draft");
    for (const field of ["places", "evidence", "durationOptions", "routes", "conditionResolutions"] as const) {
      check(same(input[field], base[field]), "command.metadata_facts");
    }
    check(same(input.candidateSet.candidates, base.candidates), "command.metadata_candidates");
    check(same(input.visitBindings, expectedDays.flatMap(day => day.visits.map(visit => ({
      visitId: visit.id, candidateId: visit.candidateId,
    })))) && same(input.dayModes, expectedDays.map(day => ({ dayId: day.id, mode: day.mode }))), "command.metadata_bindings");
    // Reuse the frozen historical assessment only after exact content/fact checks.
    // This does not reinterpret a stale route as fresh for a newly planned trip.
    return report([...base.validationReport.issues, ...issues]);
  }
  const issues: ValidationIssue[] = inputIssues(input);
  const add = (code: string, target: string, message: string, severity: ValidationIssue["severity"] = "ERROR") =>
    issues.push(issue(code, target, message, severity, severity === "ERROR" ? "reject" : "owner_decision"));
  const parsed = scheduledItinerarySchema.safeParse(raw.candidate);
  if (!parsed.success) return report([...issues, issue("candidate.schema", "trip", "Candidate violates the strict canonical schedule contract", "ERROR", "reject")]);
  const candidate = parsed.data;
  for (const key of ["tripId", "runId", "baseVersionId", "briefRevision"] as const) {
    if (candidate[key] !== input.draft[key]) add("candidate.identity", key, "Candidate metadata differs from the authorized draft");
  }
  if (candidate.policyVersion !== input.policy.id) add("policy.revision", "trip", "Candidate policy revision differs");
  if (!same(candidate.days.map(day => [day.id, day.dayIndex]), input.draft.days.map(day => [day.id, day.dayIndex]))) add("days.identity", "trip", "Candidate must retain exactly the supplied days and indices");
  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) add("identity.duplicate", id, "Canonical schedule identities must be unique");
    ids.add(id);
  };
  const allVisits = candidate.days.flatMap(day => day.visits);
  const command = input.typedCommand;
  if (command) for (const visit of allVisits) {
    const previous = input.base?.itinerary.days.flatMap(day => day.visits).find(value => value.id === visit.id);
    if (command.type === "update_visit_duration" && command.visitId === visit.id) {
      if (visit.durationMinutes !== command.durationMinutes || visit.durationOrigin.origin !== "owner" ||
          !input.brief.durationOverrides.some(value => value.visitId === visit.id && value.placeId === visit.placeId && value.durationMinutes === command.durationMinutes)) {
        add("command.duration_target", visit.id, "Explicit stay command requires its exact Visit override and Owner provenance");
      }
    } else if (previous && (visit.placeId !== previous.placeId || visit.durationMinutes !== previous.durationMinutes ||
        !same(visit.durationOrigin, previous.durationOrigin))) {
      add("command.surviving_duration", visit.id, "Deterministic edits retain surviving Place, stay and frozen provenance");
    }
  }
  const excluded = new Set([...input.brief.excludedPlaceIds, ...input.brief.hardConstraints.flatMap(value => value.type === "excluded_place" ? [value.placeId] : [])]);
  const must = new Set([
    ...input.brief.hardConstraints.flatMap(value => value.type === "must_visit" ? [value.placeId] : []),
    ...input.brief.references.flatMap(value => value.role === "must_visit" && value.placeId !== null ? [value.placeId] : []),
  ]);
  for (const id of must) if (!allVisits.some(visit => visit.placeId === id)) add("place.must_visit", id, "Required Place is absent");
  const seenPlaces = new Set<string>();
  for (const visit of allVisits) {
    if (excluded.has(visit.placeId)) add("place.excluded", visit.id, "Excluded Place is present");
    if (seenPlaces.has(visit.placeId) && !input.brief.allowedRepeatedPlaceIds.includes(visit.placeId)) add("place.repeated", visit.id, "Repeated Place is not explicitly allowed");
    seenPlaces.add(visit.placeId);
  }
  for (const ref of input.brief.references) if (ref.role === "must_visit" && ref.dayIndex !== null && !candidate.days.some(day => day.dayIndex === ref.dayIndex && day.visits.some(visit => visit.placeId === ref.placeId))) add("place.required_day", ref.id, "Required Place is absent from its requested day");
  for (const constraint of input.brief.hardConstraints) if (constraint.type === "fixed_visit_start") {
    if (!candidate.days.some(day => day.dayIndex === constraint.dayIndex && day.visits.some(visit => visit.id === constraint.visitId && visit.startMinute === constraint.startMinute))) add("visit.fixed_start", constraint.visitId, "Fixed Visit must exist at its exact day and time");
  }
  for (const baseDay of input.base?.itinerary.days ?? []) {
    const nextDay = candidate.days.find(day => day.id === baseDay.id);
    if (input.scope.kind === "local" && !input.scope.dayIds.includes(baseDay.id) && !same(baseDay, nextDay)) add("scope.changed_day", baseDay.id, "Unscoped canonical day must remain byte-for-byte unchanged");
    const locked = baseDay.visits.filter(visit => visit.locked);
    const survivors = nextDay?.visits.filter(visit => locked.some(old => old.id === visit.id)) ?? [];
    if (!same(locked.map(visit => visit.id), survivors.map(visit => visit.id))) add("lock.order", baseDay.id, "Locked Visits must remain in their day and pairwise order");
    for (const previous of locked) {
      const next = nextDay?.visits.find(visit => visit.id === previous.id);
      if (!next || !next.locked || next.placeId !== previous.placeId || next.durationMinutes !== previous.durationMinutes || !same(next.durationOrigin, previous.durationOrigin)) add("lock.changed", previous.id, "Lock preserves Place, day, stay and original provenance");
    }
  }
  for (const day of candidate.days) {
    unique(day.id);
    const draftDay = input.draft.days.find(value => value.id === day.id);
    if (!draftDay) { add("days.unsupplied", day.id, "Candidate contains an unsupplied day"); continue; }
    const frozenDay = input.scope.kind === "local" && !input.scope.dayIds.includes(day.id) ? input.base?.itinerary.days.find(value => value.id === day.id) : undefined;
    // Unchanged local days retain their admission and temporal assessment. Their
    // exact canonical bytes were checked above; new facts cannot rewrite history.
    if (frozenDay && same(day, frozenDay)) {
      issues.push(...frozenDay.notices);
      for (const value of [...day.visits, ...day.legs, ...day.boundaryTransfers, ...day.scheduleBlocks]) unique(value.id);
      continue;
    }
    const rules = dayRules(input, draftDay);
    issues.push(...rules.notices);
    const destination = input.brief.destination;
    if (day.date !== rules.date || day.timeZone !== (destination.status === "resolved" ? destination.timeZone : null) || !same(day.window, rules.window) || day.mode !== rules.mode || !same(day.effectivePolicy, rules.policy)) add("day.effective_policy", day.id, "Day date, window, mode and effective policy must match the accepted context");
    if (day.explicitlyFree !== input.brief.explicitlyFreeDayIndices.includes(day.dayIndex)) add("day.free_flag", day.id, "Free-day flag differs from the accepted Brief");
    if (!same(day.visits.map(visit => visit.id), draftDay.visits.map(visit => visit.id))) add("visit.order", day.id, "Candidate must retain supplied Visit order");
    const blocks = day.scheduleBlocks;
    const consumed = new Set<ScheduleBlock>();
    const take = (kind: ScheduleBlock["kind"], target: string, predicate: (block: ScheduleBlock) => boolean, count = 1) => {
      const found = blocks.filter(block => block.kind === kind && predicate(block));
      if (found.length !== count) add(`ledger.${kind}`, target, `Expected exactly ${count} ${kind} block(s)`);
      for (const block of found) consumed.add(block);
      return found[0];
    };
    const check = (ok: boolean, code: string, target: string) => { if (!ok) add(code, target, "Ledger timing, references or provenance disagree with authoritative inputs"); };
    let cursor = day.window.startMinute;
    for (const block of blocks) {
      unique(block.id);
      check(block.startMinute === cursor && block.endMinute >= block.startMinute && block.startMinute >= day.window.startMinute && block.endMinute <= day.window.endMinute, "ledger.timeline", block.id);
      if (block.startMinute === block.endMinute && block.kind !== "leg" && block.kind !== "boundary_transfer") add("ledger.empty_block", block.id, "Only confirmed zero transfers may occupy an empty interval");
      cursor = block.endMinute;
      if (block.kind === "wait") {
        consumed.add(block);
        check(block.origin === "derived" && block.visitId === null && block.legId === null && block.boundaryTransferId === null && block.policyKey === null && block.evidenceId === null && block.evidenceRevision === null && block.routeFactId === null && block.routeFactRevision === null && block.overrideId === null, "ledger.wait", block.id);
      }
    }
    for (const visit of day.visits) {
      unique(visit.id);
      const source = draftDay.visits.find(value => value.id === visit.id);
      if (!source) { add("visit.unsupplied", visit.id, "Visit identity is not supplied"); continue; }
      const expected = visitRules(input, source, rules);
      issues.push(...expected.notices);
      const binding = input.visitBindings.find(value => value.visitId === visit.id);
      const grounded = input.candidateSet.candidates.find(value => value.id === binding?.candidateId);
      check(visit.placeId === source.placeId && visit.locked === source.locked && visit.durationOptionId === source.durationOptionId && visit.candidateId === grounded?.id && visit.placeFactRevision === grounded?.placeFactRevision && same(visit.evidenceIds, expected.evidenceIds), "visit.binding", visit.id);
      const place = input.places.find(value => value.id === visit.placeId);
      check(!!place && destination.status === "resolved" && place.cityId === destination.cityId && destination.administrativeAreaIds.includes(place.administrativeAreaId), "place.scope", visit.id);
      check(visit.durationMinutes === expected.durationMinutes && same(visit.durationOrigin, expected.durationOrigin) && same(visit.entryBuffer, expected.entryBuffer), "visit.duration_provenance", visit.id);
      check(visit.endMinute - visit.startMinute === visit.durationMinutes, "ledger.visit", visit.id);
      const stay = take("visit", visit.id, block => block.visitId === visit.id);
      if (stay) check(stay.startMinute === visit.startMinute && stay.endMinute === visit.endMinute && stay.origin === expected.durationOrigin.origin && stay.policyKey === expected.durationOrigin.policyKey && stay.overrideId === expected.durationOrigin.overrideId && stay.evidenceId === expected.durationOrigin.evidenceId && stay.evidenceRevision === expected.durationOrigin.evidenceRevision, "ledger.visit", visit.id);
      const entry = take("entry_buffer", visit.id, block => block.visitId === visit.id, expected.entryBuffer.additionalMinutes > 0 ? 1 : 0);
      if (entry) check(entry.endMinute === visit.startMinute && entry.endMinute - entry.startMinute === expected.entryBuffer.additionalMinutes && entry.origin === expected.entryBuffer.origin && entry.policyKey === "entryBufferMinutes" && entry.overrideId === expected.entryBuffer.overrideId, "ledger.entry_buffer", visit.id);
      const arrival = visit.startMinute - expected.entryBuffer.additionalMinutes;
      check(expected.openings.some(window => arrival >= window.startMinute && visit.endMinute <= window.endMinute) && (expected.latestEntry === null || visit.startMinute <= expected.latestEntry), "admission.window", visit.id);
      const index = day.visits.indexOf(visit);
      const needsRest = index + 1 < day.visits.length && (index + 1) % rules.policy.rest.everyVisits === 0 && rules.policy.rest.durationMinutes > 0;
      const rest = take("rest", visit.id, block => block.visitId === visit.id, needsRest ? 1 : 0);
      if (rest) {
        const overrideId = overrideFor(rules.policy, "rest");
        check(rest.startMinute >= visit.endMinute && rest.endMinute - rest.startMinute === rules.policy.rest.durationMinutes && rest.origin === (overrideId ? "owner" : "policy") && rest.policyKey === "rest" && rest.overrideId === overrideId, "ledger.rest", visit.id);
      }
    }
    for (const reservation of rules.breaks) {
      const block = take(reservation.kind, day.id, value => value.policyKey === (reservation.kind === "meal" ? "lunch" : reservation.id));
      if (block) check(block.startMinute === reservation.startMinute && block.endMinute === reservation.endMinute && block.origin === reservation.origin && block.overrideId === reservation.overrideId, "ledger.reservation", block.id);
    }
    const required = segments(input, draftDay);
    const supplied = [...day.legs, ...day.boundaryTransfers];
    if (!same(supplied.map(value => value.id).sort(), required.map(value => value.id).sort())) add("route.segment_set", day.id, "Exactly the required adjacency and boundary transfers must be present");
    const walking = { minutes: 0, meters: 0, longest: 0, unknownMinutes: false, unknownMeters: false, unknownLongest: false };
    for (const segment of required) {
      const actual = supplied.find(value => value.id === segment.id);
      if (!actual) continue;
      unique(actual.id);
      const binding = input.routeBindings.find(value => value.segmentId === segment.id);
      const fact = segment.fromPlaceId === segment.toPlaceId ? identityRoute(segment, rules.mode) : input.routes.find(value => value.id === binding?.routeFactId);
      check(!!fact && same(actual.route, fact), "route.fact_binding", segment.id);
      if ("fromVisitId" in actual) check(segment.kind === "leg" && segment.from.kind === "visit" && segment.to.kind === "visit" && actual.fromVisitId === segment.from.visitId && actual.toVisitId === segment.to.visitId, "route.endpoints", segment.id);
      else check(segment.kind === "boundary_transfer" && same(actual.from, segment.from) && same(actual.to, segment.to), "route.endpoints", segment.id);
      const block = take(segment.kind, segment.id, value => segment.kind === "leg" ? value.legId === segment.id : value.boundaryTransferId === segment.id);
      if (!fact) continue;
      if (fact.temporalBasis === "current_estimate") issues.push(issue("route.current_estimate", segment.id, "Current route estimate is not a guarantee of future-date availability", "WARNING", "owner_decision", [fact.id]));
      if (fact.freshness !== "current") issues.push(issue("route.freshness", segment.id, "New planning requires current route facts", "ERROR", "reroute", [fact.id]));
      const expectedBuffer = buffer(fact.transferCoverage, fact.status === "identity" ? 0 : rules.policy.transferBufferMinutes[rules.mode], "transferBufferMinutes", fact.status === "identity" ? null : overrideFor(rules.policy, "transferBufferMinutes"));
      check(same(actual.transferBuffer, expectedBuffer), "route.buffer_provenance", segment.id);
      check((fact.status === "confirmed" || fact.status === "identity") && fact.durationMinutes !== null, "route.duration_missing", segment.id);
      if (fact.status === "unreachable") add("route.unreachable", segment.id, "Required transfer is known unreachable");
      if (block) {
        check(routeMatches(fact, segment, rules.mode, rules.date, block.startMinute), "route.applicability", segment.id);
        check(block.endMinute - block.startMinute === fact.durationMinutes && block.routeFactId === fact.id && block.routeFactRevision === fact.factRevision && block.origin === (fact.status === "identity" ? "derived" : "provider"), "ledger.route", segment.id);
        const from = segment.from.kind === "visit" ? day.visits.find(value => value.id === (segment.from.kind === "visit" ? segment.from.visitId : "")) : null;
        const to = segment.to.kind === "visit" ? day.visits.find(value => value.id === (segment.to.kind === "visit" ? segment.to.visitId : "")) : null;
        const rest = from ? blocks.find(value => value.kind === "rest" && value.visitId === from.id) : null;
        check((!from || block.startMinute >= (rest?.endMinute ?? from.endMinute)) && (!to || block.endMinute <= to.startMinute - to.entryBuffer.additionalMinutes), "route.order", segment.id);
      }
      const extra = take("transfer_buffer", segment.id, value => segment.kind === "leg" ? value.legId === segment.id : value.boundaryTransferId === segment.id, expectedBuffer.additionalMinutes > 0 ? 1 : 0);
      if (extra) check(!!block && extra.startMinute >= block.endMinute && extra.endMinute - extra.startMinute === expectedBuffer.additionalMinutes && extra.origin === expectedBuffer.origin && extra.policyKey === expectedBuffer.policyKey && extra.overrideId === expectedBuffer.overrideId && extra.routeFactId === fact.id && extra.routeFactRevision === fact.factRevision, "ledger.transfer_buffer", segment.id);
      if (extra && segment.to.kind === "visit") {
        const nextId = segment.to.visitId;
        const next = day.visits.find(value => value.id === nextId);
        check(!!next && extra.endMinute <= next.startMinute - next.entryBuffer.additionalMinutes, "route.buffer_order", segment.id);
      }
      if (expectedBuffer.coverage.status === "unknown" && expectedBuffer.overrideId === null) add("buffer.transfer_unknown", segment.id, "Transfer coverage is unknown; no second allowance added", "WARNING");
      if (fact.status !== "identity" && (!fact.geometry || fact.distanceMeters === null)) add("route.geometry_distance_missing", segment.id, "Confirmed time has incomplete geometry or distance; do not invent missing display data", "WARNING");
      if (fact.geometry) {
        const from = input.places.find(value => value.id === segment.fromPlaceId);
        const to = input.places.find(value => value.id === segment.toPlaceId);
        check(from?.coordinates.coordinateSystem === fact.geometry.coordinateSystem && to?.coordinates.coordinateSystem === fact.geometry.coordinateSystem, "route.coordinate_system", segment.id);
      }
      walking.minutes += fact.walking.durationMinutes ?? 0;
      walking.meters += fact.walking.distanceMeters ?? 0;
      walking.longest = Math.max(walking.longest, fact.walking.longestSegmentMinutes ?? 0);
      walking.unknownMinutes ||= fact.walking.durationMinutes === null;
      walking.unknownMeters ||= fact.walking.distanceMeters === null;
      walking.unknownLongest ||= fact.walking.longestSegmentMinutes === null;
    }
    for (const block of blocks) {
      if (!consumed.has(block)) add("ledger.extra_block", block.id, "Unaccounted or fabricated schedule block");
      const visitBlock = ["visit", "entry_buffer", "rest"].includes(block.kind);
      check((visitBlock || block.visitId === null) && (["leg", "transfer_buffer"].includes(block.kind) || block.legId === null) && (["boundary_transfer", "transfer_buffer"].includes(block.kind) || block.boundaryTransferId === null), "ledger.references", block.id);
      if (block.kind !== "visit") check(block.evidenceId === null && block.evidenceRevision === null, "ledger.evidence_origin", block.id);
      if (!["leg", "boundary_transfer", "transfer_buffer"].includes(block.kind)) check(block.routeFactId === null && block.routeFactRevision === null, "ledger.route_origin", block.id);
      if (["leg", "boundary_transfer"].includes(block.kind)) check(block.policyKey === null && block.overrideId === null, "ledger.provider_origin", block.id);
      if (block.kind === "transfer_buffer") check((block.legId === null) !== (block.boundaryTransferId === null), "ledger.references", block.id);
    }
    // Check semantic ledger order separately from clock overlap. Reserved breaks
    // and explicit waiting may intervene, but cannot reorder work.
    const actualOrder = blocks.filter(block => !["wait", "meal", "break"].includes(block.kind)).map(block =>
      `${block.kind}:${block.visitId ?? block.legId ?? block.boundaryTransferId}`);
    const expectedOrder: string[] = [];
    const appendTransfer = (id: string | undefined) => {
      if (!id) return;
      const segment = required.find(value => value.id === id);
      const value = supplied.find(value => value.id === id);
      if (segment) expectedOrder.push(`${segment.kind}:${id}`);
      if (value && value.transferBuffer.additionalMinutes > 0) expectedOrder.push(`transfer_buffer:${id}`);
    };
    if (!day.visits.length) appendTransfer(required[0]?.id);
    else appendTransfer(required.find(value => value.from.kind === "place")?.id);
    day.visits.forEach((visit, index) => {
      if (visit.entryBuffer.additionalMinutes > 0) expectedOrder.push(`entry_buffer:${visit.id}`);
      expectedOrder.push(`visit:${visit.id}`);
      if (index + 1 < day.visits.length) {
        if ((index + 1) % rules.policy.rest.everyVisits === 0 && rules.policy.rest.durationMinutes > 0) expectedOrder.push(`rest:${visit.id}`);
        appendTransfer(required.find(value => value.from.kind === "visit" && value.from.visitId === visit.id && value.kind === "leg")?.id);
      }
    });
    if (day.visits.length) appendTransfer(required.find(value => value.to.kind === "place")?.id);
    check(same(actualOrder, expectedOrder), "ledger.semantic_order", day.id);
    for (const wait of blocks.filter(value => value.kind === "wait")) {
      const following = blocks[blocks.indexOf(wait) + 1];
      if (!following) { add("ledger.unjustified_wait", wait.id, "Trailing idle time is not a required operation"); continue; }
      if (following.kind === "meal" || following.kind === "break") continue;
      let earliest = wait.startMinute;
      let length = following.endMinute - following.startMinute;
      const visit = following.visitId === null ? undefined : day.visits.find(value => value.id === following.visitId);
      if (visit && (following.kind === "visit" || following.kind === "entry_buffer")) {
        const source = draftDay.visits.find(value => value.id === visit.id);
        if (!source) continue;
        const expected = visitRules(input, source, rules);
        const fixed = input.brief.hardConstraints.find(value => value.type === "fixed_visit_start" && value.visitId === visit.id);
        length = expected.durationMinutes + expected.entryBuffer.additionalMinutes;
        const starts = expected.openings.flatMap(window => {
          let start = Math.max(wait.startMinute, window.startMinute);
          if (fixed?.type === "fixed_visit_start") start = fixed.startMinute - expected.entryBuffer.additionalMinutes;
          for (const reservation of rules.breaks) if (start < reservation.endMinute && start + length > reservation.startMinute) start = reservation.endMinute;
          return start >= wait.startMinute && start >= window.startMinute && start + length <= window.endMinute && (expected.latestEntry === null || start + expected.entryBuffer.additionalMinutes <= expected.latestEntry) ? [start] : [];
        });
        earliest = starts.length ? Math.min(...starts) : -1;
      } else {
        for (const reservation of rules.breaks) if (earliest < reservation.endMinute && earliest + length > reservation.startMinute) earliest = reservation.endMinute;
      }
      check(following.startMinute === earliest, "ledger.unjustified_wait", wait.id);
    }
    for (const constraint of input.brief.hardConstraints) {
      if (constraint.type === "max_walking") {
        if (constraint.durationMinutes !== null && (walking.unknownMinutes || walking.minutes > constraint.durationMinutes)) add("walking.hard_minutes", day.id, "Walking duration cap is exceeded or cannot be verified");
        if (constraint.distanceMeters !== null && (walking.unknownMeters || walking.meters > constraint.distanceMeters)) add("walking.hard_distance", day.id, "Walking distance cap is exceeded or cannot be verified");
      }
      if (constraint.type === "visit_count" && constraint.dayIndex === day.dayIndex && ((constraint.minimum !== null && day.visits.length < constraint.minimum) || (constraint.maximum !== null && day.visits.length > constraint.maximum))) add("visits.hard_count", day.id, "Explicit Visit-count bounds are violated");
      if (constraint.type === "max_visits" && constraint.dayIndex === day.dayIndex && day.visits.length > constraint.count) add("visits.hard_count", day.id, "Explicit Visit maximum is violated");
    }
    const limits = rules.policy.softLimits;
    if (day.visits.length > limits.visits) add("pace.visit_count", day.id, "Visit count exceeds the selected soft pace ceiling", "WARNING");
    if (walking.minutes > limits.walkingMinutes || walking.meters > limits.walkingMeters || walking.longest > limits.longestWalkingMinutes) add("pace.walking", day.id, "Walking exceeds selected soft pace limits", "WARNING");
    if (walking.unknownMinutes || walking.unknownMeters || walking.unknownLongest) add("walking.components_unknown", day.id, "Some provider walking components are unknown", "WARNING");
  }
  return report(issues);
}
