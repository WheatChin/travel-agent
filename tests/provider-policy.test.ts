import { describe, expect, it } from "vitest";

import {
  assessFreshness,
  createBudget,
  decideRetry,
  reserveAttempt,
  type BudgetState,
  type Reservation,
} from "../src/server/providers/policy";

function accept(state: BudgetState, reservation: Reservation): BudgetState {
  const result = reserveAttempt(state, reservation);
  if (!result.ok) throw new Error(`Unexpected denial: ${result.code}`);
  return result.state;
}

describe("immutable provider budget reservations", () => {
  it.each([
    ["search", 4],
    ["fetch", 8],
    ["poi", 40],
    ["route", 96],
  ] as const)("permits exactly the %s ceiling of %i attempts", (kind, limit) => {
    let state = createBudget("run");
    for (let index = 0; index < limit; index += 1) {
      state = accept(state, {
        kind, operationId: `operation-${index}`,
        ...(kind === "search" || kind === "fetch" ? { researchRound: 0 } : {}),
      } as Reservation);
    }
    const before = JSON.stringify(state);
    const denied = reserveAttempt(state, {
      kind, operationId: "overflow",
      ...(kind === "search" || kind === "fetch" ? { researchRound: 0 } : {}),
    });
    expect(denied).toEqual({ ok: false, code: "budget_exhausted" });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("allows twelve model calls but never a thirteenth", () => {
    let state = createBudget("run");
    for (let index = 0; index < 12; index += 1) {
      state = accept(state, { kind: "model", operationId: `model-${index}`, outputTokens: 1 });
    }
    expect(reserveAttempt(state, { kind: "model", operationId: "extra", outputTokens: 1 }))
      .toEqual({ ok: false, code: "budget_exhausted" });
  });

  it("counts requested tokens cumulatively, including retries, through recovery", () => {
    let state = createBudget("run");
    for (let index = 0; index < 8; index += 1) {
      state = accept(state, {
        kind: "model", operationId: `model-${Math.floor(index / 2)}`, outputTokens: 4096,
      });
    }
    const recovered: unknown = JSON.parse(JSON.stringify(state));
    expect(reserveAttempt(recovered, { kind: "model", operationId: "extra", outputTokens: 1 }))
      .toEqual({ ok: false, code: "budget_exhausted" });
    expect(state.attempts).toHaveLength(8);
  });

  it("caps each model request and each logical operation independently", () => {
    const initial = createBudget("run");
    expect(reserveAttempt(initial, { kind: "model", operationId: "m", outputTokens: 4097 }))
      .toEqual({ ok: false, code: "invalid_reservation" });
    const request = { kind: "model", operationId: "m", outputTokens: 4096 } as const;
    const first = accept(initial, request);
    const second = reserveAttempt(first, request);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("Expected second attempt");
    expect(second.attempt).toBe(2);
    expect(reserveAttempt(second.state, request))
      .toEqual({ ok: false, code: "attempts_exhausted" });
    expect(initial.attempts).toHaveLength(0);
    expect(first.attempts).toHaveLength(1);
    expect(Object.isFrozen(second.state)).toBe(true);
    expect(Object.isFrozen(second.state.attempts)).toBe(true);
    expect(Object.isFrozen(second.state.attempts[0])).toBe(true);
  });

  it("allows two logical repairs with two attempts each and charges every token", () => {
    let state = createBudget("run");
    for (const index of [0, 1, 0, 1]) {
      state = accept(state, { kind: "repair", operationId: `repair-${index}`, outputTokens: 4096 });
    }
    expect(state.attempts).toHaveLength(4);
    const recovered: unknown = JSON.parse(JSON.stringify(state));
    expect(reserveAttempt(recovered, { kind: "repair", operationId: "repair-0", outputTokens: 1 }))
      .toEqual({ ok: false, code: "attempts_exhausted" });
    const before = JSON.stringify(state);
    expect(reserveAttempt(state, { kind: "repair", operationId: "repair-3", outputTokens: 1 }))
      .toEqual({ ok: false, code: "budget_exhausted" });
    expect(JSON.stringify(state)).toBe(before);
    for (let index = 0; index < 4; index += 1) {
      state = accept(state, { kind: "model", operationId: `m-${index}`, outputTokens: 4096 });
    }
    expect(reserveAttempt(state, { kind: "model", operationId: "extra", outputTokens: 1 }))
      .toEqual({ ok: false, code: "budget_exhausted" });
  });

  it("keeps repair retries inside the shared twelve-model-call ceiling", () => {
    let state = createBudget("run");
    for (const operationId of ["repair-1", "repair-2", "repair-1", "repair-2"]) {
      state = accept(state, { kind: "repair", operationId, outputTokens: 1 });
    }
    for (let index = 0; index < 8; index += 1) {
      state = accept(state, { kind: "model", operationId: `model-${index}`, outputTokens: 1 });
    }
    expect(state.attempts).toHaveLength(12);
    expect(reserveAttempt(state, { kind: "model", operationId: "thirteenth", outputTokens: 1 }))
      .toEqual({ ok: false, code: "budget_exhausted" });
  });

  it("denies a repair retry once other model calls have exhausted the shared ceiling", () => {
    let state = accept(createBudget("run"), {
      kind: "repair", operationId: "repair-1", outputTokens: 1,
    });
    for (let index = 0; index < 11; index += 1) {
      state = accept(state, { kind: "model", operationId: `model-${index}`, outputTokens: 1 });
    }
    expect(reserveAttempt(state, { kind: "repair", operationId: "repair-1", outputTokens: 1 }))
      .toEqual({ ok: false, code: "budget_exhausted" });
  });

  it("keeps classification separate at two calls of at most 1024 tokens", () => {
    const initial = createBudget("classification");
    expect(reserveAttempt(initial, { kind: "classification", operationId: "c", outputTokens: 1025 }))
      .toEqual({ ok: false, code: "invalid_reservation" });
    const first = accept(initial, { kind: "classification", operationId: "c", outputTokens: 1024 });
    const second = accept(first, { kind: "classification", operationId: "c", outputTokens: 1024 });
    expect(reserveAttempt(second, { kind: "classification", operationId: "other", outputTokens: 1 }))
      .toEqual({ ok: false, code: "budget_exhausted" });
    expect(reserveAttempt(initial, { kind: "model", operationId: "m", outputTokens: 1 }))
      .toEqual({ ok: false, code: "invalid_reservation" });
    expect(reserveAttempt(createBudget("run"), {
      kind: "classification", operationId: "c", outputTokens: 1,
    })).toEqual({ ok: false, code: "invalid_reservation" });
  });

  it("allows one supplementary research round without resetting search consumption", () => {
    let state = createBudget("run");
    for (let index = 0; index < 4; index += 1) {
      state = accept(state, {
        kind: "search", operationId: `s-${index}`, researchRound: index < 2 ? 0 : 1,
      });
    }
    expect(reserveAttempt(state, { kind: "search", operationId: "extra", researchRound: 1 }))
      .toEqual({ ok: false, code: "budget_exhausted" });
    expect(reserveAttempt(createBudget("run"), {
      kind: "search", operationId: "round-2", researchRound: 2,
    })).toEqual({ ok: false, code: "invalid_reservation" });
    expect(reserveAttempt(state, { kind: "fetch", operationId: "s-0", researchRound: 0 }))
      .toEqual({ ok: false, code: "invalid_reservation" });
  });

  it.each([
    null, {}, { policyId: "unknown", scope: "run", attempts: [] },
    { policyId: "provider-budget-mvp-v1", scope: "run", attempts: [], remaining: 999 },
    { policyId: "provider-budget-mvp-v1", scope: "run", attempts: [
      { kind: "model", operationId: "bad", outputTokens: -1 },
    ] },
    { policyId: "provider-budget-mvp-v1", scope: "run", attempts: [
      { kind: "route", operationId: "r" }, { kind: "route", operationId: "r" },
      { kind: "route", operationId: "r" },
    ] },
  ])("rejects malformed persisted state without mutation", (state) => {
    const before = JSON.stringify(state);
    expect(reserveAttempt(state, { kind: "route", operationId: "new" }))
      .toEqual({ ok: false, code: "malformed_state" });
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid requested token count %s", (outputTokens) => {
      expect(reserveAttempt(createBudget("run"), { kind: "model", operationId: "m", outputTokens }))
        .toEqual({ ok: false, code: "invalid_reservation" });
    },
  );

  it("rejects persisted ledgers already over a ceiling", () => {
    const state = {
      policyId: "provider-budget-mvp-v1", scope: "run",
      attempts: Array.from({ length: 5 }, (_, index) => ({
        kind: "search", operationId: `s-${index}`, researchRound: 0,
      })),
    };
    expect(reserveAttempt(state, { kind: "route", operationId: "r" }))
      .toEqual({ ok: false, code: "malformed_state" });
  });

  it("copies proposals without freezing or retaining caller-owned entries", () => {
    const reservation = { kind: "route", operationId: "original" };
    const result = reserveAttempt(createBudget("run"), reservation);
    if (!result.ok) throw new Error("Expected reservation");
    reservation.operationId = "changed";
    expect(result.state.attempts[0].operationId).toBe("original");
    expect(Object.isFrozen(reservation)).toBe(false);
  });
});

const NOW = Date.parse("2030-01-02T03:04:05Z");

describe("pure retry decisions", () => {
  it.each([408, 429, 500, 503, 599])("retries status %i once with default delay", (status) => {
    expect(decideRetry({ kind: "http", status }, 1, NOW))
      .toEqual({ retry: true, delayMs: 1000, nextRetryAt: NOW + 1000 });
  });

  it("retries transient transport failure but never starts attempt three", () => {
    expect(decideRetry({ kind: "transport", transient: true }, 1, NOW).retry).toBe(true);
    expect(decideRetry({ kind: "transport", transient: true }, 2, NOW))
      .toEqual({ retry: false, reason: "attempts_exhausted" });
  });

  it.each([
    { kind: "auth" }, { kind: "capability" }, { kind: "malformed" },
    { kind: "known_unreachable" }, { kind: "schema_invalid" },
    { kind: "transport", transient: false },
    { kind: "http", status: 401 }, { kind: "http", status: 403 },
    { kind: "http", status: 404 }, { kind: "http", status: 200 },
  ] as const)("does not retry normalized permanent failure %j", (failure) => {
    expect(decideRetry(failure, 1, NOW)).toEqual({ retry: false, reason: "non_retryable" });
  });

  it.each([
    ["0", 0], ["30", 30_000], ["2", 2000],
    ["Wed, 02 Jan 2030 03:04:15 GMT", 10_000],
    ["Wednesday, 02-Jan-30 03:04:15 GMT", 10_000],
    ["Wed Jan  2 03:04:15 2030", 10_000],
    ["Wed, 02 Jan 2030 03:04:00 GMT", 0],
    ["garbage", 1000], ["-1", 1000], ["1.5", 1000],
    ["2030-01-02T03:04:15Z", 1000],
    ["Wed, 31 Feb 2030 03:04:15 GMT", 1000],
  ])("interprets Retry-After %s using supplied time", (retryAfter, delayMs) => {
    expect(decideRetry({ kind: "http", status: 429, retryAfter }, 1, NOW))
      .toEqual({ retry: true, delayMs, nextRetryAt: NOW + delayMs });
  });

  it.each(["31", "999999999999999999999", "Wed, 02 Jan 2030 03:04:36 GMT"])(
    "returns rate-limit outcome instead of truncating delay %s", (retryAfter) => {
      expect(decideRetry({ kind: "http", status: 429, retryAfter }, 1, NOW))
        .toEqual({ retry: false, reason: "rate_limited" });
    },
  );

  it("rejects invalid clock, attempt, and HTTP status", () => {
    expect(decideRetry({ kind: "http", status: 429 }, 0, NOW).retry).toBe(false);
    expect(decideRetry({ kind: "http", status: 429 }, 1, Number.NaN).retry).toBe(false);
    expect(decideRetry({ kind: "http", status: 999 }, 1, NOW).retry).toBe(false);
  });
});

describe("new-planning fact freshness", () => {
  it.each([
    ["poi", 604_800_000], ["entry_conditions", 86_400_000],
    ["opening_windows", 86_400_000], ["closure_dates", 86_400_000],
    ["latest_entry", 86_400_000], ["reservation_requirements", 86_400_000],
    ["accessibility", 86_400_000], ["planned_stay", 2_592_000_000],
    ["walk_route", 86_400_000], ["bicycle_route", 86_400_000],
    ["transit_route", 900_000], ["taxi_route", 900_000], ["drive_route", 900_000],
  ] as const)("honors the inclusive %s TTL", (kind, ttl) => {
    const input = { kind, retrievedAt: NOW - ttl, now: NOW, applicability: "applicable", conflicting: false } as const;
    expect(assessFreshness(input)).toEqual({ current: true, policyId: "fact-freshness-mvp-v1" });
    expect(assessFreshness({ ...input, retrievedAt: input.retrievedAt - 1 }))
      .toEqual({ current: false, reason: "stale", policyId: "fact-freshness-mvp-v1" });
  });

  it.each([
    [null, "unknown_retrieval"], [Number.NaN, "unknown_retrieval"],
    [NOW + 1, "future_retrieval"],
  ] as const)("rejects unknown or future retrieval %s", (retrievedAt, reason) => {
    expect(assessFreshness({
      kind: "poi", retrievedAt, now: NOW, applicability: "applicable", conflicting: false,
    })).toEqual({ current: false, reason, policyId: "fact-freshness-mvp-v1" });
  });

  it("does not infer applicability, resolve conflicts, or mutate historical data", () => {
    const historical = Object.freeze({
      kind: "entry_conditions", retrievedAt: NOW, now: NOW,
      applicability: "unknown", conflicting: false,
    } as const);
    expect(assessFreshness(historical).current).toBe(false);
    expect(assessFreshness({ ...historical, applicability: "inapplicable" }).current).toBe(false);
    expect(assessFreshness({ ...historical, applicability: "applicable", conflicting: true }).current).toBe(false);
    expect(historical.applicability).toBe("unknown");
    expect(historical.retrievedAt).toBe(NOW);
  });
});
