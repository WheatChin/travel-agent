import { briefStateSchema } from "../src/domain/brief";
import { committedItinerarySnapshotSchema, scheduledItinerarySchema, scheduleInputSchema, type ScheduleInput, type ScheduleBlock } from "../src/domain/canonical";
import { SCHEDULE_POLICY } from "../src/domain/policy";

export function scheduleFixture(): ScheduleInput {
  return scheduleInputSchema.parse({
    brief: briefStateSchema.parse({
      revision: 1, destination: { status: "resolved", query: "Beijing", candidates: [], cityId: "city_beijing", administrativeAreaIds: ["area_beijing"], timeZone: "Asia/Shanghai" },
      requestedDayCount: 1, startDate: "2026-10-01", endDate: null, exactDateVerificationRequired: false,
      references: [], hardConstraints: [],
      preferences: { pace: "balanced", transportModes: ["walk"], interests: [], companions: null },
      dayWindows: [{ dayIndex: 1, startMinute: 540, endMinute: 720 }], boundaries: [],
      durationOverrides: [{ placeId: "place_one", durationMinutes: 60 }, { placeId: "place_two", durationMinutes: 60 }],
      allowedRepeatedPlaceIds: [], explicitlyFreeDayIndices: [], excludedPlaceIds: [], acceptedPolicyOverrides: [], assumptions: [],
    }),
    draft: { kind: "draft", tripId: "trip_test", runId: "run_test", baseVersionId: null, briefRevision: 1, days: [{
      id: "day_one", dayIndex: 1, visits: ["one", "two"].map(name => ({
        id: `visit_${name}`, placeId: `place_${name}`, durationOptionId: null, durationMinutes: null, locked: false, evidenceIds: [`evidence_${name}`],
      })),
    }] },
    policy: SCHEDULE_POLICY,
    requirementContext: { issueRevision: 1, supportedCityIds: ["city_beijing"], supportedTransportModes: ["walk", "public_transit"], lockedDayIndices: [], resolvedPlaces: [] },
    candidateSet: { tripId: "trip_test", runId: "run_test", baseVersionId: null, candidates: ["one", "two"].map(name => ({
      id: `candidate_${name}`, placeId: `place_${name}`, placeFactRevision: 1, evidenceIds: [`evidence_${name}`], durationOptionIds: [],
    })) },
    visitBindings: ["one", "two"].map(name => ({ visitId: `visit_${name}`, candidateId: `candidate_${name}` })),
    places: ["one", "two"].map((name, index) => ({
      id: `place_${name}`, factRevision: 1, provider: "synthetic-test", providerPlaceId: name, name,
      cityId: "city_beijing", administrativeAreaId: "area_beijing",
      coordinates: { longitude: 116.4 + index / 100, latitude: 39.9, coordinateSystem: "GCJ-02" },
    })),
    evidence: ["one", "two"].map(name => ({
      id: `evidence_${name}`, revision: 1, placeId: `place_${name}`, field: "opening_windows",
      value: [{ startMinute: 0, endMinute: 1439 }], excerpt: "Synthetic all-day opening fixture",
      sourceUrl: null, retrievedAt: null, applicableFrom: null, applicableThrough: null, status: "known", freshness: "current", sourceKind: "synthetic_fixture",
    })),
    durationOptions: [], conditionResolutions: [],
    routes: [{
      id: "route_one-two", factRevision: 1, fromPlaceId: "place_one", toPlaceId: "place_two",
      mode: "walk", status: "confirmed", durationMinutes: 20, zeroDurationConfirmed: false, distanceMeters: 1000,
      geometry: { coordinateSystem: "GCJ-02", path: [
        { longitude: 116.4, latitude: 39.9, coordinateSystem: "GCJ-02" },
        { longitude: 116.41, latitude: 39.9, coordinateSystem: "GCJ-02" },
      ] },
      provider: "synthetic-test", retrievedAt: null, sourceKind: "synthetic_fixture",
      temporalBasis: "time_independent", freshness: "current",
      applicability: { date: "2026-10-01", departureWindow: null },
      transferCoverage: { status: "excluded", includedMinutes: null },
      walking: { durationMinutes: 20, distanceMeters: 1000, longestSegmentMinutes: 20 },
    }],
    routeBindings: [{ segmentId: "leg_one-to-two", routeFactId: "route_one-two" }],
    dayModes: [{ dayId: "day_one", mode: "walk" }], base: null, scope: { kind: "global" },
  });
}

// Independent arithmetic fixture: no scheduler or validator is used to construct it.
export function scheduledFixture() {
  const input = scheduleFixture();
  const notice = { code: "policy.lunch_omitted", severity: "ASSUMPTION", field: "policy", targetId: "day_one", message: "Short day window does not contain the full lunch reservation", disposition: "owner_decision", factIds: [] } as const;
  const excluded = { status: "excluded", includedMinutes: null } as const;
  const entry = { coverage: excluded, allowanceMinutes: 10, additionalMinutes: 10, origin: "policy", policyKey: "entryBufferMinutes", overrideId: null } as const;
  const origin = { origin: "owner", evidenceId: null, evidenceRevision: null, durationOptionId: null, policyKey: null, overrideId: null, entryCoverage: excluded } as const;
  const block = (id: string, kind: ScheduleBlock["kind"], startMinute: number, endMinute: number, extra: Partial<ScheduleBlock>) => ({
    id, kind, startMinute, endMinute, visitId: null, legId: null, boundaryTransferId: null,
    origin: "derived", policyKey: null, evidenceId: null, evidenceRevision: null,
    routeFactId: null, routeFactRevision: null, overrideId: null, ...extra,
  });
  return scheduledItinerarySchema.parse({
    schemaVersion: "canonical-v2", kind: "scheduled",
    tripId: input.draft.tripId, runId: input.draft.runId, baseVersionId: null,
    briefRevision: 1, policyVersion: input.policy.id,
    days: [{
      id: "day_one", dayIndex: 1, date: "2026-10-01", timeZone: "Asia/Shanghai", explicitlyFree: false,
      window: { startMinute: 540, endMinute: 720 }, mode: "walk",
      effectivePolicy: {
        policyVersion: input.policy.id, source: input.policy.source, pace: "balanced", window: input.policy.window,
        stayMinutes: 90, selectionTarget: 3, softLimits: input.policy.softLimits.balanced,
        lunch: input.policy.lunch, rest: input.policy.rest, entryBufferMinutes: 10,
        transferBufferMinutes: input.policy.transferBufferMinutes, breaks: [], overrides: [],
      },
      visits: input.draft.days[0].visits.map((visit, index) => ({
        ...visit, candidateId: input.visitBindings[index].candidateId, placeFactRevision: 1,
        durationMinutes: 60, durationOrigin: origin, entryBuffer: entry,
        startMinute: index === 0 ? 550 : 640, endMinute: index === 0 ? 610 : 700,
      })),
      legs: [{
        id: "leg_one-to-two", fromVisitId: "visit_one", toVisitId: "visit_two", route: input.routes[0],
        transferBuffer: { coverage: excluded, allowanceMinutes: 0, additionalMinutes: 0, origin: "policy", policyKey: "transferBufferMinutes", overrideId: null },
      }],
      boundaryTransfers: [],
      scheduleBlocks: [
        block("block_one-0", "entry_buffer", 540, 550, { visitId: "visit_one", origin: "policy", policyKey: "entryBufferMinutes" }),
        block("block_one-1", "visit", 550, 610, { visitId: "visit_one", origin: "owner" }),
        block("block_one-2", "leg", 610, 630, { legId: "leg_one-to-two", origin: "provider", routeFactId: "route_one-two", routeFactRevision: 1 }),
        block("block_one-3", "entry_buffer", 630, 640, { visitId: "visit_two", origin: "policy", policyKey: "entryBufferMinutes" }),
        block("block_one-4", "visit", 640, 700, { visitId: "visit_two", origin: "owner" }),
      ],
      notices: [notice],
    }],
  });
}

export function committedSnapshotFixture() {
  const input = scheduleFixture();
  const itinerary = scheduledFixture();
  return committedItinerarySnapshotSchema.parse({
    schemaVersion: "canonical-v2", kind: "committed", id: "version_test",
    tripId: input.draft.tripId, conversationId: "conversation_test", turnId: "turn_test",
    runId: input.draft.runId, baseVersionId: null, briefRevision: 1,
    committedAt: "2026-09-08T12:00:00+08:00", mutationOrigin: "generation",
    policyVersion: input.policy.id, policy: input.policy, validationPolicyRevision: "validator-mvp-v1",
    validationReport: { policyRevision: "validator-mvp-v1", issues: itinerary.days[0].notices, commitEligible: true, degraded: false },
    brief: input.brief, itinerary, places: input.places, evidence: input.evidence,
    evidenceIds: input.evidence.map(fact => fact.id), candidates: input.candidateSet.candidates,
    durationOptions: input.durationOptions, routes: input.routes, conditionResolutions: [],
    assumptions: [], warnings: [],
  });
}
