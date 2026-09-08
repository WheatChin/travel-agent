import { describe, expect, it } from "vitest";

import {
  assessFreshness,
  createBudget,
  decideRetry,
  reserveAttempt,
  type BudgetState,
  type Reservation,
} from "../src/server/providers/policy";

const NOW = Date.parse("2030-01-02T03:04:05Z");

function accept(state: BudgetState, reservation: Reservation): BudgetState {
  const result = reserveAttempt(state, reservation);
  if (!result.ok) throw new Error(`Expected reservation, received ${result.code}`);
  return result.state;
}

describe("independent cumulative provider budgets", () => {
  it("retains every consumed model allowance after recovered invalid JSON output", () => {
    let state = createBudget("run");
    for (let operation = 0; operation < 4; operation += 1) {
      const reservation = {
        kind: "model",
        operationId: `model-json-${operation}`,
        outputTokens: 4_096,
      } as const;
      state = accept(state, reservation);
      state = accept(state, reservation);
    }

    const recovered = JSON.parse(JSON.stringify(state)) as unknown;
    expect(reserveAttempt(recovered, {
      kind: "model",
      operationId: "model-after-recovery",
      outputTokens: 1,
    })).toEqual({ ok: false, code: "budget_exhausted" });
    expect(state.attempts).toHaveLength(8);
  });

  it("rejects rebinding a logical operation ID to another kind or research round", () => {
    const routed = accept(createBudget("run"), {
      kind: "route",
      operationId: "operation-bound",
    });
    expect(reserveAttempt(routed, {
      kind: "poi",
      operationId: "operation-bound",
    })).toEqual({ ok: false, code: "invalid_reservation" });

    const searched = accept(createBudget("run"), {
      kind: "search",
      operationId: "operation-search",
      researchRound: 0,
    });
    expect(reserveAttempt(searched, {
      kind: "search",
      operationId: "operation-search",
      researchRound: 1,
    })).toEqual({ ok: false, code: "invalid_reservation" });
  });

  it("accounts for two logical repairs with two transport attempts each", () => {
    let state = createBudget("run");
    for (const operationId of ["repair-first", "repair-second"]) {
      const reservation = { kind: "repair", operationId, outputTokens: 1_024 } as const;
      const first = reserveAttempt(state, reservation);
      expect(first).toMatchObject({ ok: true, attempt: 1 });
      if (!first.ok) throw new Error("Expected first repair transport attempt");
      const second = reserveAttempt(first.state, reservation);
      expect(second).toMatchObject({ ok: true, attempt: 2 });
      if (!second.ok) throw new Error("Expected second repair transport attempt");
      state = second.state;
    }

    expect(state.attempts).toHaveLength(4);
    expect(reserveAttempt(state, {
      kind: "repair",
      operationId: "repair-third",
      outputTokens: 1,
    })).toEqual({ ok: false, code: "budget_exhausted" });
  });

  it("allows only one supplementary research round within the cumulative search cap", () => {
    let state = createBudget("run");
    for (const reservation of [
      { kind: "search", operationId: "search-initial-a", researchRound: 0 },
      { kind: "search", operationId: "search-initial-b", researchRound: 0 },
      { kind: "search", operationId: "search-supplement-a", researchRound: 1 },
      { kind: "search", operationId: "search-supplement-b", researchRound: 1 },
    ] as const) {
      state = accept(state, reservation);
    }

    expect(reserveAttempt(state, {
      kind: "search",
      operationId: "search-supplement-extra",
      researchRound: 1,
    })).toEqual({ ok: false, code: "budget_exhausted" });
    expect(reserveAttempt(createBudget("run"), {
      kind: "search",
      operationId: "search-round-two",
      researchRound: 2,
    })).toEqual({ ok: false, code: "invalid_reservation" });
  });
});

describe("independent retry terminal outcomes", () => {
  it.each([
    [{ kind: "transport", transient: true } as const, 2, "attempts_exhausted"],
    [{ kind: "http", status: 429, retryAfter: "31" } as const, 1, "rate_limited"],
    [{ kind: "auth" } as const, 1, "non_retryable"],
    [{ kind: "capability" } as const, 1, "non_retryable"],
    [{ kind: "known_unreachable" } as const, 1, "non_retryable"],
    [{ kind: "schema_invalid" } as const, 1, "non_retryable"],
    [{ kind: "refusal" } as const, 1, "non_retryable"],
    [{ kind: "empty" } as const, 1, "non_retryable"],
    [{ kind: "incomplete" } as const, 1, "non_retryable"],
  ])("returns terminal reason %s for %j", (failure, attempt, reason) => {
    expect(decideRetry(failure, attempt, NOW)).toEqual({ retry: false, reason });
  });

  it("rejects malformed retry inputs without manufacturing a retry time", () => {
    expect(decideRetry({ kind: "http", status: 600 }, 1, NOW))
      .toEqual({ retry: false, reason: "invalid_input" });
    expect(decideRetry({ kind: "transport", transient: true }, 3, NOW))
      .toEqual({ retry: false, reason: "invalid_input" });
  });
});

describe("independent fact freshness admission", () => {
  it.each([
    "opening_windows",
    "closure_dates",
    "latest_entry",
    "reservation_requirements",
    "entry_conditions",
    "accessibility",
  ] as const)("applies the explicit 24-hour boundary to %s", kind => {
    const input = {
      kind,
      retrievedAt: NOW - 86_400_000,
      now: NOW,
      applicability: "applicable",
      conflicting: false,
    } as const;
    expect(assessFreshness(input)).toEqual({
      current: true,
      policyId: "fact-freshness-mvp-v1",
    });
    expect(assessFreshness({ ...input, retrievedAt: input.retrievedAt - 1 })).toEqual({
      current: false,
      reason: "stale",
      policyId: "fact-freshness-mvp-v1",
    });
  });

  it.each([
    [null, "applicable", false, "unknown_retrieval"],
    [NOW + 1, "applicable", false, "future_retrieval"],
    [NOW, "applicable", true, "conflicting"],
    [NOW, "unknown", false, "not_applicable"],
    [NOW, "inapplicable", false, "not_applicable"],
  ] as const)(
    "rejects retrieval/applicability evidence with reason %s/%s/%s",
    (retrievedAt, applicability, conflicting, reason) => {
      expect(assessFreshness({
        kind: "opening_windows",
        retrievedAt,
        now: NOW,
        applicability,
        conflicting,
      })).toEqual({ current: false, reason, policyId: "fact-freshness-mvp-v1" });
    },
  );
});
