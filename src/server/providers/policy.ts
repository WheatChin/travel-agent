const BUDGET_POLICY_ID = "provider-budget-mvp-v1";
const FRESHNESS_POLICY_ID = "fact-freshness-mvp-v1";

export type Reservation =
  | Readonly<{ kind: "search" | "fetch"; operationId: string; researchRound: 0 | 1 }>
  | Readonly<{ kind: "poi" | "route"; operationId: string }>
  | Readonly<{ kind: "model" | "repair" | "classification"; operationId: string; outputTokens: number }>;

export type BudgetState = Readonly<{
  policyId: typeof BUDGET_POLICY_ID;
  scope: "run" | "classification";
  attempts: readonly Reservation[];
}>;

type DenialCode =
  | "malformed_state"
  | "invalid_reservation"
  | "attempts_exhausted"
  | "budget_exhausted";

export type ReservationResult =
  | Readonly<{ ok: true; state: BudgetState; attempt: 1 | 2 }>
  | Readonly<{ ok: false; code: DenialCode }>;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validReservation(value: unknown, scope: BudgetState["scope"]): value is Reservation {
  if (!record(value) || typeof value.operationId !== "string" ||
    value.operationId.length === 0 || value.operationId.trim() !== value.operationId) return false;
  if (scope === "classification" && value.kind !== "classification") return false;
  if (scope === "run" && value.kind === "classification") return false;
  switch (value.kind) {
    case "search":
    case "fetch":
      return exactKeys(value, ["kind", "operationId", "researchRound"]) &&
        (value.researchRound === 0 || value.researchRound === 1);
    case "poi":
    case "route":
      return exactKeys(value, ["kind", "operationId"]);
    case "model":
    case "repair":
    case "classification":
      return exactKeys(value, ["kind", "operationId", "outputTokens"]) &&
        typeof value.outputTokens === "number" &&
        Number.isSafeInteger(value.outputTokens) && value.outputTokens > 0 &&
        value.outputTokens <= (value.kind === "classification" ? 1024 : 4096);
    default:
      return false;
  }
}

function denialFor(attempts: readonly Reservation[], next: Reservation): DenialCode | null {
  const sameOperation = attempts.filter((entry) => entry.operationId === next.operationId);
  if (sameOperation.some((entry) => entry.kind !== next.kind ||
    ("researchRound" in entry && "researchRound" in next &&
      entry.researchRound !== next.researchRound))) return "invalid_reservation";
  if (sameOperation.length >= 2) return "attempts_exhausted";

  const count = (kind: Reservation["kind"]) => attempts.filter((entry) => entry.kind === kind).length;
  switch (next.kind) {
    case "search":
      return count("search") >= 4 ? "budget_exhausted" : null;
    case "fetch":
      return count("fetch") >= 8 ? "budget_exhausted" : null;
    case "poi":
      return count("poi") >= 40 ? "budget_exhausted" : null;
    case "route":
      return count("route") >= 96 ? "budget_exhausted" : null;
    case "classification":
      return count("classification") >= 2 ? "budget_exhausted" : null;
    case "model":
    case "repair": {
      const tokens = attempts.reduce((total, entry) =>
        total + ("outputTokens" in entry ? entry.outputTokens : 0), 0);
      const repairOperations = new Set(attempts
        .filter((entry) => entry.kind === "repair")
        .map((entry) => entry.operationId));
      return count("model") + count("repair") >= 12 ||
        tokens + next.outputTokens > 32_768 ||
        (next.kind === "repair" && !repairOperations.has(next.operationId) &&
          repairOperations.size >= 2)
        ? "budget_exhausted" : null;
    }
  }
}

function validState(value: unknown): value is BudgetState {
  if (!record(value) || !exactKeys(value, ["policyId", "scope", "attempts"]) ||
    value.policyId !== BUDGET_POLICY_ID ||
    (value.scope !== "run" && value.scope !== "classification") ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > (value.scope === "classification" ? 2 : 160)) return false;
  // Revalidate the bounded ledger, including per-operation and cumulative limits.
  const accepted: Reservation[] = [];
  for (const entry of value.attempts) {
    if (!validReservation(entry, value.scope) || denialFor(accepted, entry)) return false;
    accepted.push(entry);
  }
  return true;
}

/** Only for a genuinely new Run or classification submission, never recovery,
 * clarification, or an existing Turn replay. This does not persist anything. */
export function createBudget(scope: BudgetState["scope"]): BudgetState {
  if (scope !== "run" && scope !== "classification") throw new TypeError("Invalid budget scope.");
  return Object.freeze({ policyId: BUDGET_POLICY_ID, scope, attempts: Object.freeze([]) });
}

/**
 * Proposes one transport attempt from caller-supplied, already-persisted state.
 * The caller MUST durably persist the returned state with an atomic version/
 * ownership check BEFORE transport. Concurrent proposals are not independent
 * grants. A crash after reservation still consumes that attempt.
 *
 * Reuse the logical operation ID for retry/schema correction. At most two unique
 * repair operations are allowed, each with at most two transport attempts.
 * Every repair attempt consumes model-call and requested-token allowances;
 * retrying a repair does not consume another logical repair. Classification has its own
 * submission-scoped state. Research round 0 is initial and 1 is the sole
 * supplementary round; issuing fresh IDs never replenishes any allowance.
 * No persistence, transport, authorization, retry execution, or reset occurs here.
 */
export function reserveAttempt(state: unknown, reservation: unknown): ReservationResult {
  if (!validState(state)) return Object.freeze({ ok: false, code: "malformed_state" });
  if (!validReservation(reservation, state.scope)) {
    return Object.freeze({ ok: false, code: "invalid_reservation" });
  }
  const denial = denialFor(state.attempts, reservation);
  if (denial) return Object.freeze({ ok: false, code: denial });
  const attempt = state.attempts.some((entry) => entry.operationId === reservation.operationId) ? 2 : 1;
  const attempts = Object.freeze([...state.attempts, reservation].map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({
    ok: true,
    attempt,
    state: Object.freeze({ policyId: BUDGET_POLICY_ID, scope: state.scope, attempts }),
  });
}

export type ProviderFailure =
  | Readonly<{ kind: "transport"; transient: boolean }>
  | Readonly<{ kind: "http"; status: number; retryAfter?: string | null }>
  | Readonly<{ kind: "auth" | "capability" | "malformed" | "known_unreachable" |
      "schema_invalid" | "refusal" | "empty" | "incomplete" }>;

export type RetryDecision =
  | Readonly<{ retry: true; delayMs: number; nextRetryAt: number }>
  | Readonly<{ retry: false; reason: "invalid_input" | "attempts_exhausted" |
      "non_retryable" | "rate_limited" }>;

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    Math.abs(value) <= 8_640_000_000_000_000;
}

function retryDelay(value: string | null | undefined, now: number): number {
  if (value == null) return 1000;
  const text = value.trim();
  if (/^[0-9]+$/.test(text)) return Number(text) * 1000;
  // Normalize the three HTTP-date forms before strict calendar validation.
  let canonical = text;
  const oldDate = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([0-9]{2})-([A-Z][a-z]{2})-([0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) GMT$/.exec(text);
  const asciiDate = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ([ 0-9][0-9]) ([0-9]{2}:[0-9]{2}:[0-9]{2}) ([0-9]{4})$/.exec(text);
  if (oldDate) {
    const currentYear = new Date(now).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + Number(oldDate[4]);
    const fiftyYearsLater = new Date(now);
    fiftyYearsLater.setUTCFullYear(currentYear + 50);
    if (Date.parse(`${oldDate[2]} ${oldDate[3]} ${year} ${oldDate[5]} GMT`) > fiftyYearsLater.getTime()) {
      year -= 100;
    }
    canonical = `${oldDate[1].slice(0, 3)}, ${oldDate[2]} ${oldDate[3]} ${year} ${oldDate[5]} GMT`;
  } else if (asciiDate) {
    canonical = `${asciiDate[1]}, ${asciiDate[3].trim().padStart(2, "0")} ${asciiDate[2]} ${asciiDate[5]} ${asciiDate[4]} GMT`;
  }
  const parsed = Date.parse(canonical);
  if (Number.isFinite(parsed) && new Date(parsed).toUTCString() === canonical) {
    return Math.max(0, parsed - now);
  }
  return 1000;
}

/**
 * Uses normalized failures and a supplied epoch-millisecond clock. Never sleeps
 * or retries. Persist nextRetryAt and reserve attempt two before its transport.
 * Schema correction is an explicit task action, not a transport retry.
 */
export function decideRetry(failure: ProviderFailure, attempt: number, now: number): RetryDecision {
  if (!timestamp(now) || (attempt !== 1 && attempt !== 2) || !record(failure)) {
    return { retry: false, reason: "invalid_input" };
  }
  if (failure.kind === "http" && (!Number.isInteger(failure.status) ||
    failure.status < 100 || failure.status > 599 ||
    (failure.retryAfter != null && typeof failure.retryAfter !== "string"))) {
    return { retry: false, reason: "invalid_input" };
  }
  if (attempt === 2) return { retry: false, reason: "attempts_exhausted" };
  const transient = (failure.kind === "transport" && failure.transient === true) ||
    (failure.kind === "http" && (failure.status === 408 || failure.status === 429 ||
      failure.status >= 500));
  if (!transient) return { retry: false, reason: "non_retryable" };
  const delayMs = retryDelay(failure.kind === "http" ? failure.retryAfter : null, now);
  if (delayMs > 30_000) return { retry: false, reason: "rate_limited" };
  if (!timestamp(now + delayMs)) return { retry: false, reason: "invalid_input" };
  return { retry: true, delayMs, nextRetryAt: now + delayMs };
}

const FRESHNESS_TTLS = {
  poi: 7 * 24 * 60 * 60 * 1000,
  opening_windows: 24 * 60 * 60 * 1000,
  closure_dates: 24 * 60 * 60 * 1000,
  latest_entry: 24 * 60 * 60 * 1000,
  reservation_requirements: 24 * 60 * 60 * 1000,
  entry_conditions: 24 * 60 * 60 * 1000,
  accessibility: 24 * 60 * 60 * 1000,
  planned_stay: 30 * 24 * 60 * 60 * 1000,
  walk_route: 24 * 60 * 60 * 1000,
  bicycle_route: 24 * 60 * 60 * 1000,
  transit_route: 15 * 60 * 1000,
  taxi_route: 15 * 60 * 1000,
  drive_route: 15 * 60 * 1000,
} as const;

export type FreshnessInput = Readonly<{
  kind: keyof typeof FRESHNESS_TTLS;
  retrievedAt: number | null;
  now: number;
  applicability: "applicable" | "inapplicable" | "unknown";
  conflicting: boolean;
}>;

export type FreshnessAssessment =
  | Readonly<{ current: true; policyId: typeof FRESHNESS_POLICY_ID }>
  | Readonly<{ current: false; policyId: typeof FRESHNESS_POLICY_ID;
      reason: "invalid_input" | "unknown_retrieval" | "future_retrieval" |
        "conflicting" | "not_applicable" | "stale" }>;

/**
 * Cache eligibility for NEW planning only, never a reevaluation of immutable
 * historical snapshots. Times are epoch milliseconds. "applicable" must already
 * include source/date, exact endpoint/mode and departure-context checks.
 * Unknown applicability is not affirmative evidence, including undated trips.
 * current=true does not establish source entailment, truth, or verified facts;
 * those remain independent gates. No source or historical record is mutated.
 */
export function assessFreshness(input: FreshnessInput): FreshnessAssessment {
  const denied = (reason: Extract<FreshnessAssessment, { current: false }>["reason"]): FreshnessAssessment =>
    ({ current: false, policyId: FRESHNESS_POLICY_ID, reason });
  if (!record(input) || !Object.hasOwn(FRESHNESS_TTLS, input.kind) ||
    !timestamp(input.now) || typeof input.conflicting !== "boolean" ||
    !["applicable", "inapplicable", "unknown"].includes(input.applicability)) {
    return denied("invalid_input");
  }
  if (!timestamp(input.retrievedAt)) return denied("unknown_retrieval");
  if (input.retrievedAt > input.now) return denied("future_retrieval");
  if (input.conflicting) return denied("conflicting");
  if (input.applicability !== "applicable") return denied("not_applicable");
  if (input.now - input.retrievedAt > FRESHNESS_TTLS[input.kind]) return denied("stale");
  return { current: true, policyId: FRESHNESS_POLICY_ID };
}
