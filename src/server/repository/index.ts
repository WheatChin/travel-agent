import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { encodeInterpretationOutput } from "./interpretation-ledger";
import {
  turnEventSchema,
  turnInputSchema,
  type GenerationRun,
  type TurnEvent,
  type TurnInput,
} from "@/domain/contracts";
import {
  briefStateSchema,
  committedItinerarySnapshotSchema,
  type BriefState,
  type CommittedItinerarySnapshot,
  type EvidenceFact,
} from "@/domain";

const OWNER_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

export type RepositoryErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "STALE_VERSION"
  | "STALE_BRIEF"
  | "INVALID_STATE"
  | "LEASE_CONFLICT"
  | "VALIDATION_FAILED";

export class RepositoryError extends Error {
  constructor(
    public readonly code: RepositoryErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

export interface OwnerCredential {
  readonly credential: string;
  readonly expiresAt: string;
}

export interface ConversationRecord {
  readonly id: string;
  readonly tripId: string | null;
  readonly createdAt: string;
}

export interface TripRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly currentVersionId: string | null;
  readonly briefRevision: number;
  readonly mutationSequence: number;
  readonly brief: BriefState;
  readonly createdAt: string;
}

export interface AcceptedTurn {
  readonly turnId: string;
  readonly conversationId: string;
  readonly tripId: string;
  readonly runId: string | null;
  readonly kind: "mutation" | "read";
  readonly replayed: boolean;
  readonly versionId?: string;
  readonly noChange?: true;
}

export interface InterpretationClaim {
  readonly conversationId: string;
  readonly turnId: string;
  readonly attempt: 1 | 2;
  readonly leaseExpiresAt: string;
}

export type InterpretationReservation =
  | { readonly status: "accepted"; readonly outcome: AcceptedTurn }
  | { readonly status: "saved"; readonly output: unknown }
  | { readonly status: "busy" | "exhausted" }
  | { readonly status: "reserved"; readonly claim: InterpretationClaim };

interface InterpretationRow {
  canonicalPayload: string;
  attempts: number;
  fence: number;
  leaseExpiresAt: string | null;
  outputJson: string | null;
}

interface InterpretationBinding {
  ownerId: string;
  conversationId: string;
  turnId: string;
  attempt: number;
  fence: number;
  leaseExpiresAt: string;
}

export interface NoChangeOutcome extends AcceptedTurn {
  readonly versionId: string;
  readonly noChange: true;
}

export type NoChangeRequest = Omit<RunClaim, "leaseExpiresAt"> & { readonly versionId: string };

export type CommitVersionRequest = Omit<RunClaim, "leaseExpiresAt"> & {
  readonly snapshot: CommittedItinerarySnapshot;
  readonly commandBrief?: BriefState;
};

export interface MessageRecord {
  readonly turnId: string;
  readonly conversationId: string;
  readonly input: TurnInput["input"];
  readonly createdAt: string;
}

export interface RunClaim {
  readonly runId: string;
  readonly executorId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
}

export interface RunExecutionRecord extends GenerationRun {
  readonly mutationSequence: number;
  readonly fencingToken: number;
  readonly repairCount: number;
  readonly checkpoint: unknown;
  readonly operationIds: unknown;
  readonly attemptCounts: unknown;
  readonly nextRetryAt: string | null;
  readonly retryOfRunId: string | null;
}

export interface RecoverableRunHandle {
  readonly runId: string;
}

export interface TrustedWorkerRepository {
  listRecoverableRuns(): RecoverableRunHandle[];
  claimRun(handle: RecoverableRunHandle, executorId: string, leaseMs?: number): RunClaim;
  renewLease(claim: RunClaim, leaseMs?: number): RunClaim;
  getRunExecution(claim: RunClaim): RunExecutionRecord;
  getRunInput(claim: RunClaim): TurnInput;
  getTrip(claim: RunClaim): TripRecord;
  getVersion(claim: RunClaim, versionId: string): CommittedItinerarySnapshot;
  listEvents(claim: RunClaim, afterSequence?: number): TurnEvent[];
  checkpointRun(claim: RunClaim, request: Omit<CheckpointRequest, "runId" | "executorId" | "fencingToken">): RunExecutionRecord;
  commitVersion(claim: RunClaim, snapshot: CommittedItinerarySnapshot, commandBrief?: BriefState): CommittedItinerarySnapshot;
  completeNoChange(claim: RunClaim, versionId: string): NoChangeOutcome;
  cancelRun(claim: RunClaim, reason: string): GenerationRun;
}

export interface CheckpointRequest {
  readonly runId: string;
  readonly executorId: string;
  readonly fencingToken: number;
  readonly state: GenerationRun["state"];
  readonly checkpoint: unknown;
  readonly operationIds?: unknown;
  readonly attemptCounts?: unknown;
  readonly nextRetryAt?: string | null;
  readonly repairCount: number;
  readonly event: Record<string, unknown>;
}

const TERMINAL_STATES = new Set<GenerationRun["state"]>([
  "completed", "degraded", "failed", "cancelled", "superseded",
]);

const TRANSITIONS: Readonly<Record<GenerationRun["state"], readonly GenerationRun["state"][]>> = {
  accepted: ["checking_requirements", "failed"],
  checking_requirements: ["needs_input", "ready", "failed"],
  needs_input: [],
  ready: ["researching", "resolving_places", "drafting", "failed"],
  researching: ["resolving_places", "failed"],
  resolving_places: ["drafting", "failed"],
  drafting: ["routing", "validating", "failed"],
  routing: ["validating", "failed"],
  validating: ["repairing", "needs_input", "failed"],
  repairing: ["routing", "validating", "needs_input", "failed"],
  completed: [], degraded: [], failed: [], cancelled: [], superseded: [],
};

export interface OpenRepositoryOptions {
  readonly path: string;
  readonly now?: () => Date;
}

function identifier(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function digestCredential(credential: string) {
  return createHash("sha256").update(credential).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function row<T>(statement: StatementSync, ...values: SQLInputValue[]): T | undefined {
  return statement.get(...values) as T | undefined;
}

function parseNullableJson(value: unknown): unknown {
  return value === null || value === undefined ? null : JSON.parse(String(value));
}

export class TripRepository {
  private closed = false;
  // Object identity is the capability: serialized or copied handles never authorize work.
  #workHandles = new WeakMap<RecoverableRunHandle, { ownerId: string; runId: string }>();
  #workClaims = new WeakMap<RunClaim, { ownerId: string; runId: string }>();
  #interpretationClaims = new WeakMap<InterpretationClaim, InterpretationBinding>();

  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  createOwner(): OwnerCredential {
    const credential = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + OWNER_LIFETIME_MS);
    this.database
      .prepare(
        "INSERT INTO owners (id, credential_digest, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(identifier("owner"), digestCredential(credential), createdAt.toISOString(), expiresAt.toISOString());
    return { credential, expiresAt: expiresAt.toISOString() };
  }

  createConversation(credential: string): ConversationRecord {
    const ownerId = this.authorize(credential);
    const record = {
      id: identifier("conversation"),
      tripId: null,
      createdAt: this.now().toISOString(),
    } as const;
    this.database
      .prepare("INSERT INTO conversations (id, owner_id, created_at) VALUES (?, ?, ?)")
      .run(record.id, ownerId, record.createdAt);
    return record;
  }

  listConversations(credential: string): ConversationRecord[] {
    const ownerId = this.authorize(credential);
    return this.database
      .prepare(
        "SELECT id, trip_id AS tripId, created_at AS createdAt FROM conversations WHERE owner_id = ? ORDER BY created_at, id",
      )
      .all(ownerId) as unknown as ConversationRecord[];
  }

  listTrips(credential: string): TripRecord[] {
    const ownerId = this.authorize(credential);
    return this.database
      .prepare("SELECT * FROM trips WHERE owner_id = ? ORDER BY created_at, id")
      .all(ownerId)
      .map((item) => this.parseTrip(item as Record<string, unknown>));
  }

  getTrip(credential: string, tripId: string, versionId?: string): TripRecord & { version?: CommittedItinerarySnapshot } {
    const ownerId = this.authorize(credential);
    const item = row<Record<string, unknown>>(
      this.database.prepare("SELECT * FROM trips WHERE id = ? AND owner_id = ?"),
      tripId,
      ownerId,
    );
    if (!item) throw new RepositoryError("NOT_FOUND");
    const trip = this.parseTrip(item);
    return versionId ? { ...trip, version: this.getVersion(credential, versionId, tripId) } : trip;
  }

  reserveInterpretation(credential: string, rawTurn: TurnInput): InterpretationReservation {
    const ownerId = this.authorize(credential);
    const turn = turnInputSchema.parse(rawTurn);
    if (turn.input.type !== "user_message") throw new RepositoryError("VALIDATION_FAILED");
    const payload = canonicalize(turn);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const conversation = this.getInterpretationConversation(ownerId, turn.conversationId);
      const accepted = row<{ canonicalPayload: string; outcomeJson: string }>(
        this.database.prepare(`SELECT canonical_payload AS canonicalPayload, outcome_json AS outcomeJson
          FROM turns WHERE owner_id = ? AND conversation_id = ? AND id = ?`),
        ownerId, turn.conversationId, turn.turnId,
      );
      if (accepted) {
        if (accepted.canonicalPayload !== payload) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        const outcome = { ...(JSON.parse(accepted.outcomeJson) as AcceptedTurn), replayed: true };
        this.database.exec("COMMIT");
        return { status: "accepted", outcome };
      }
      const previous = this.getInterpretationRow(ownerId, turn.conversationId, turn.turnId);
      if (previous && previous.canonicalPayload !== payload) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
      if (previous?.outputJson !== null && previous?.outputJson !== undefined) {
        const output: unknown = JSON.parse(previous.outputJson);
        this.database.exec("COMMIT");
        return { status: "saved", output };
      }
      this.assertInterpretationReferences(ownerId, conversation.tripId, turn);
      const now = this.now();
      if (previous?.leaseExpiresAt && Date.parse(previous.leaseExpiresAt) > now.getTime()) {
        this.database.exec("COMMIT");
        return { status: "busy" };
      }
      if (previous && previous.attempts >= 2) {
        this.database.exec("COMMIT");
        return { status: "exhausted" };
      }
      const attempt = previous?.attempts === 1 ? 2 : 1;
      const fence = (previous?.fence ?? 0) + 1;
      const leaseExpiresAt = new Date(now.getTime() + 90_000).toISOString();
      const timestamp = now.toISOString();
      this.database.prepare(`INSERT INTO interpretation_ledger
        (owner_id, conversation_id, turn_id, canonical_payload, attempts, fence, lease_expires_at, output_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(owner_id, conversation_id, turn_id) DO UPDATE SET
          attempts = excluded.attempts, fence = excluded.fence,
          lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at`)
        .run(ownerId, turn.conversationId, turn.turnId, payload, attempt, fence, leaseExpiresAt, timestamp, timestamp);
      const claim: InterpretationClaim = Object.freeze({
        conversationId: turn.conversationId, turnId: turn.turnId, attempt, leaseExpiresAt,
      });
      this.database.exec("COMMIT");
      this.#interpretationClaims.set(claim, {
        ownerId, conversationId: turn.conversationId, turnId: turn.turnId, attempt, fence, leaseExpiresAt,
      });
      return { status: "reserved", claim };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  saveInterpretation(credential: string, claim: InterpretationClaim, output: unknown): unknown {
    const ownerId = this.authorize(credential);
    const binding = this.interpretationBinding(ownerId, claim);
    let encoded: string;
    try { encoded = encodeInterpretationOutput(output); }
    catch { throw new RepositoryError("VALIDATION_FAILED"); }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.getInterpretationConversation(ownerId, binding.conversationId);
      const previous = this.assertInterpretationFence(binding);
      if (previous.outputJson !== null) {
        if (previous.outputJson !== encoded) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        const saved: unknown = JSON.parse(previous.outputJson);
        this.database.exec("COMMIT");
        return saved;
      }
      this.assertInterpretationLease(binding, previous);
      this.database.prepare(`UPDATE interpretation_ledger SET output_json = ?, lease_expires_at = NULL, updated_at = ?
        WHERE owner_id = ? AND conversation_id = ? AND turn_id = ? AND fence = ? AND attempts = ?`)
        .run(encoded, this.now().toISOString(), ownerId, binding.conversationId, binding.turnId, binding.fence, binding.attempt);
      this.database.exec("COMMIT");
      return JSON.parse(encoded) as unknown;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  releaseInterpretation(credential: string, claim: InterpretationClaim): void {
    const ownerId = this.authorize(credential);
    const binding = this.interpretationBinding(ownerId, claim);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.getInterpretationConversation(ownerId, binding.conversationId);
      const previous = this.assertInterpretationFence(binding);
      this.assertInterpretationLease(binding, previous);
      this.database.prepare(`UPDATE interpretation_ledger SET lease_expires_at = NULL, updated_at = ?
        WHERE owner_id = ? AND conversation_id = ? AND turn_id = ? AND fence = ? AND attempts = ?`)
        .run(this.now().toISOString(), ownerId, binding.conversationId, binding.turnId, binding.fence, binding.attempt);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private getInterpretationConversation(ownerId: string, conversationId: string) {
    const conversation = row<{ tripId: string | null }>(
      this.database.prepare("SELECT trip_id AS tripId FROM conversations WHERE id = ? AND owner_id = ?"),
      conversationId, ownerId,
    );
    if (!conversation) throw new RepositoryError("NOT_FOUND");
    return conversation;
  }

  private assertInterpretationReferences(ownerId: string, tripId: string | null, turn: TurnInput): void {
    if (tripId === null) {
      if (turn.targetTripId !== null || turn.baseVersionId !== null || turn.resume !== undefined) throw new RepositoryError("NOT_FOUND");
      if (turn.baseBriefRevision !== 0) throw new RepositoryError("STALE_BRIEF");
      return;
    }
    if (turn.targetTripId !== tripId) throw new RepositoryError("NOT_FOUND");
    const trip = this.getTripByOwner(ownerId, tripId);
    if (trip.conversationId !== turn.conversationId) throw new RepositoryError("NOT_FOUND");
    const version = turn.baseVersionId === null ? null : this.getVersionByOwner(ownerId, turn.baseVersionId, tripId);
    if (version && version.conversationId !== turn.conversationId) throw new RepositoryError("NOT_FOUND");
    if (turn.resume) {
      const run = this.getRunRow(ownerId, turn.resume.runId);
      if (run.trip_id !== tripId || run.conversation_id !== turn.conversationId) throw new RepositoryError("NOT_FOUND");
    }
    const brief = row(this.database.prepare("SELECT revision FROM brief_revisions WHERE trip_id = ? AND owner_id = ? AND revision = ?"),
      tripId, ownerId, turn.baseBriefRevision);
    if (!brief) throw new RepositoryError("STALE_BRIEF");
    if (version === null) {
      if (trip.currentVersionId !== null) throw new RepositoryError("STALE_VERSION");
      if (turn.baseBriefRevision !== trip.briefRevision) throw new RepositoryError("STALE_BRIEF");
    } else if (turn.baseBriefRevision < version.briefRevision) {
      throw new RepositoryError("STALE_BRIEF");
    }
  }

  private getInterpretationRow(ownerId: string, conversationId: string, turnId: string) {
    return row<InterpretationRow>(this.database.prepare(`SELECT canonical_payload AS canonicalPayload,
      attempts, fence, lease_expires_at AS leaseExpiresAt, output_json AS outputJson
      FROM interpretation_ledger WHERE owner_id = ? AND conversation_id = ? AND turn_id = ?`),
      ownerId, conversationId, turnId);
  }

  private interpretationBinding(ownerId: string, claim: InterpretationClaim): InterpretationBinding {
    const binding = this.#interpretationClaims.get(claim);
    if (!binding || binding.ownerId !== ownerId || claim.conversationId !== binding.conversationId ||
        claim.turnId !== binding.turnId || claim.attempt !== binding.attempt || claim.leaseExpiresAt !== binding.leaseExpiresAt) {
      throw new RepositoryError("UNAUTHORIZED");
    }
    return binding;
  }

  private assertInterpretationFence(binding: InterpretationBinding): InterpretationRow {
    const previous = this.getInterpretationRow(binding.ownerId, binding.conversationId, binding.turnId);
    if (!previous || previous.fence !== binding.fence || previous.attempts !== binding.attempt) {
      throw new RepositoryError("LEASE_CONFLICT");
    }
    return previous;
  }

  private assertInterpretationLease(binding: InterpretationBinding, previous: InterpretationRow): void {
    if (previous.outputJson !== null || previous.leaseExpiresAt !== binding.leaseExpiresAt ||
        Date.parse(binding.leaseExpiresAt) <= this.now().getTime()) {
      throw new RepositoryError("LEASE_CONFLICT");
    }
  }

  acceptTurn(
    credential: string,
    request: { readonly turn: TurnInput; readonly kind: "mutation" | "read"; readonly brief?: BriefState },
  ): AcceptedTurn {
    const ownerId = this.authorize(credential);
    const turn = turnInputSchema.parse(request.turn);
    if (turn.input.type !== "user_message" && request.brief !== undefined) {
      throw new RepositoryError("VALIDATION_FAILED");
    }
    const payload = canonicalize(turn);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const conversation = row<{ id: string; tripId: string | null }>(
        this.database.prepare(
          "SELECT id, trip_id AS tripId FROM conversations WHERE id = ? AND owner_id = ?",
        ),
        turn.conversationId,
        ownerId,
      );
      if (!conversation) throw new RepositoryError("NOT_FOUND");
      const previous = row<{ canonicalPayload: string; outcomeJson: string }>(
        this.database.prepare(
          "SELECT canonical_payload AS canonicalPayload, outcome_json AS outcomeJson FROM turns WHERE owner_id = ? AND conversation_id = ? AND id = ?",
        ),
        ownerId,
        turn.conversationId,
        turn.turnId,
      );
      if (previous) {
        if (previous.canonicalPayload !== payload) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        this.database.exec("COMMIT");
        return { ...(JSON.parse(previous.outcomeJson) as AcceptedTurn), replayed: true };
      }

      const brief = request.brief === undefined ? undefined : briefStateSchema.parse(request.brief);
      let trip: TripRecord | undefined;
      if (conversation.tripId) trip = this.getTripByOwner(ownerId, conversation.tripId);
      if (request.kind === "mutation") {
        if (!trip) {
          if (
            turn.targetTripId !== null ||
            turn.baseVersionId !== null ||
            turn.baseBriefRevision !== 0 ||
            !brief || brief.revision !== 1
          ) {
            throw new RepositoryError("STALE_BRIEF");
          }
          const createdAt = this.now().toISOString();
          const tripId = identifier("trip");
          this.database
            .prepare(
              "INSERT INTO trips (id, owner_id, conversation_id, current_version_id, brief_revision, mutation_sequence, brief_json, created_at) VALUES (?, ?, ?, NULL, 1, 1, ?, ?)",
            )
            .run(tripId, ownerId, conversation.id, JSON.stringify(brief), createdAt);
          this.database.prepare("INSERT INTO brief_revisions (trip_id, owner_id, revision, brief_json, turn_id, created_at) VALUES (?, ?, 1, ?, ?, ?)")
            .run(tripId, ownerId, JSON.stringify(brief), turn.turnId, createdAt);
          this.database.prepare("UPDATE conversations SET trip_id = ? WHERE id = ?").run(tripId, conversation.id);
          trip = this.getTripByOwner(ownerId, tripId);
        } else {
          if (turn.baseBriefRevision !== trip.briefRevision) throw new RepositoryError("STALE_BRIEF");
          if (turn.targetTripId !== trip.id) throw new RepositoryError("NOT_FOUND");
          if (turn.baseVersionId !== trip.currentVersionId) throw new RepositoryError("STALE_VERSION");
          if (brief && brief.revision !== trip.briefRevision + 1) throw new RepositoryError("STALE_BRIEF");
          const nextBrief = brief ?? trip.brief;
          const nextRevision = nextBrief.revision;
          this.database
            .prepare(
              "UPDATE trips SET brief_revision = ?, mutation_sequence = mutation_sequence + 1, brief_json = ? WHERE id = ? AND owner_id = ?",
            )
            .run(nextRevision, JSON.stringify(nextBrief), trip.id, ownerId);
          if (brief) this.database.prepare("INSERT INTO brief_revisions (trip_id, owner_id, revision, brief_json, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(trip.id, ownerId, nextRevision, JSON.stringify(nextBrief), turn.turnId, this.now().toISOString());
          trip = this.getTripByOwner(ownerId, trip.id);
        }
      } else {
        if (!trip || turn.targetTripId !== trip.id) throw new RepositoryError("NOT_FOUND");
        if (turn.baseVersionId !== null) this.assertOwnedVersion(ownerId, trip.id, turn.baseVersionId);
      }

      const runId = request.kind === "mutation" ? identifier("run") : null;
      const outcome: AcceptedTurn = {
        turnId: turn.turnId,
        conversationId: conversation.id,
        tripId: trip!.id,
        runId,
        kind: request.kind,
        replayed: false,
      };
      const createdAt = this.now().toISOString();
      this.database
        .prepare(
          "INSERT INTO turns (id, owner_id, conversation_id, trip_id, kind, canonical_payload, input_json, outcome_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(turn.turnId, ownerId, conversation.id, trip!.id, request.kind, payload, JSON.stringify(turn.input), JSON.stringify(outcome), createdAt);
      if (runId) {
        const superseded = this.database.prepare(
          "SELECT * FROM runs WHERE trip_id = ? AND state NOT IN ('completed','degraded','failed','cancelled','superseded') ORDER BY created_at, id",
        ).all(trip!.id) as unknown as Array<Record<string, unknown>>;
        this.database
          .prepare(
            "UPDATE runs SET state = 'superseded', lease_expires_at = NULL WHERE trip_id = ? AND state NOT IN ('completed','degraded','failed','cancelled','superseded')",
          )
          .run(trip!.id);
        for (const oldRun of superseded) {
          this.insertRunEvent(oldRun, {
            type: "run.superseded", versionId: oldRun.base_version_id,
            replacementRunId: runId, message: "Run superseded by a newer mutation",
          }, createdAt);
        }
        this.database
          .prepare(
            "INSERT INTO runs (id, owner_id, conversation_id, trip_id, turn_id, base_version_id, base_brief_revision, mutation_sequence, state, fencing_token, repair_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, 0, ?, ?)",
          )
          .run(runId, ownerId, conversation.id, trip!.id, turn.turnId, turn.baseVersionId, trip!.briefRevision, trip!.mutationSequence, createdAt, createdAt);
        this.insertEvent({
          id: identifier("event"), sequence: 1, occurredAt: createdAt, runId, turnId: turn.turnId,
          type: "run.started", versionId: turn.baseVersionId, message: "Run accepted",
        });
      }
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getTurn(credential: string, conversationId: string, turnId: string): AcceptedTurn {
    const ownerId = this.authorize(credential);
    const item = row<{ outcomeJson: string }>(
      this.database.prepare(
        "SELECT outcome_json AS outcomeJson FROM turns WHERE id = ? AND conversation_id = ? AND owner_id = ?",
      ),
      turnId,
      conversationId,
      ownerId,
    );
    if (!item) throw new RepositoryError("NOT_FOUND");
    return JSON.parse(item.outcomeJson) as AcceptedTurn;
  }

  listMessages(credential: string, conversationId: string): MessageRecord[] {
    const ownerId = this.authorize(credential);
    const conversation = row(this.database.prepare("SELECT id FROM conversations WHERE id = ? AND owner_id = ?"), conversationId, ownerId);
    if (!conversation) throw new RepositoryError("NOT_FOUND");
    return (this.database
      .prepare("SELECT id AS turnId, conversation_id AS conversationId, input_json AS inputJson, created_at AS createdAt FROM turns WHERE conversation_id = ? AND owner_id = ? ORDER BY created_at, id")
      .all(conversationId, ownerId) as unknown as Array<{ turnId: string; conversationId: string; inputJson: string; createdAt: string }>).map(({ inputJson, ...item }) => ({ ...item, input: JSON.parse(inputJson) as TurnInput["input"] }));
  }

  getRun(credential: string, runId: string): GenerationRun {
    const ownerId = this.authorize(credential);
    const item = row<Record<string, unknown>>(this.database.prepare("SELECT * FROM runs WHERE id = ? AND owner_id = ?"), runId, ownerId);
    if (!item) throw new RepositoryError("NOT_FOUND");
    return {
      id: String(item.id), conversationId: String(item.conversation_id), tripId: String(item.trip_id),
      turnId: String(item.turn_id), baseVersionId: item.base_version_id === null ? null : String(item.base_version_id),
      baseBriefRevision: Number(item.base_brief_revision), state: item.state as GenerationRun["state"],
    };
  }

  getRunExecution(credential: string, runId: string): RunExecutionRecord {
    const ownerId = this.authorize(credential);
    return this.getRunExecutionByOwner(ownerId, runId);
  }

  private getRunExecutionByOwner(ownerId: string, runId: string): RunExecutionRecord {
    const item = this.getRunRow(ownerId, runId);
    return {
      ...this.runFromRow(item), mutationSequence: Number(item.mutation_sequence),
      fencingToken: Number(item.fencing_token), repairCount: Number(item.repair_count),
      checkpoint: parseNullableJson(item.checkpoint_json), operationIds: parseNullableJson(item.operation_ids_json),
      attemptCounts: parseNullableJson(item.attempt_counts_json),
      nextRetryAt: item.next_retry_at === null ? null : String(item.next_retry_at),
      retryOfRunId: item.retry_of_run_id === null ? null : String(item.retry_of_run_id),
    };
  }

  claimRun(credential: string, runId: string, executorId: string, leaseMs = 30_000): RunClaim {
    const ownerId = this.authorize(credential);
    return this.claimRunByOwner(ownerId, runId, executorId, leaseMs);
  }

  private claimRunByOwner(ownerId: string, runId: string, executorId: string, leaseMs: number): RunClaim {
    if (!executorId.trim() || !Number.isInteger(leaseMs) || leaseMs <= 0) throw new RepositoryError("VALIDATION_FAILED");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.getRunRow(ownerId, runId);
      const state = run.state as GenerationRun["state"];
      if (TERMINAL_STATES.has(state) || state === "needs_input") throw new RepositoryError("INVALID_STATE");
      const now = this.now();
      if (run.next_retry_at !== null && Date.parse(String(run.next_retry_at)) > now.getTime()) throw new RepositoryError("INVALID_STATE");
      if (run.lease_expires_at !== null && Date.parse(String(run.lease_expires_at)) > now.getTime()) {
        throw new RepositoryError("LEASE_CONFLICT");
      }
      const fencingToken = Number(run.fencing_token) + 1;
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      this.database.prepare("UPDATE runs SET executor_id = ?, fencing_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
        .run(executorId, fencingToken, leaseExpiresAt, now.toISOString(), runId, ownerId);
      this.database.exec("COMMIT");
      return { runId, executorId, fencingToken, leaseExpiresAt };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  trustedWorker(): TrustedWorkerRepository {
    const binding = (claim: RunClaim) => {
      const bound = this.#workClaims.get(claim);
      if (!bound) throw new RepositoryError("UNAUTHORIZED");
      return bound;
    };
    const register = (claim: RunClaim, ownerId: string): RunClaim => {
      Object.freeze(claim);
      this.#workClaims.set(claim, { ownerId, runId: claim.runId });
      return claim;
    };
    return Object.freeze({
      listRecoverableRuns: () => {
        const now = this.now().toISOString();
        return (this.database.prepare(`SELECT id AS runId, owner_id AS ownerId FROM runs
          WHERE state NOT IN ('needs_input','completed','degraded','failed','cancelled','superseded')
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at, id`).all(now, now) as unknown as Array<{ runId: string; ownerId: string }>)
          .map(bound => {
            const handle = Object.freeze({ runId: bound.runId });
            this.#workHandles.set(handle, bound);
            return handle;
          });
      },
      claimRun: (handle: RecoverableRunHandle, executorId: string, leaseMs = 30_000) => {
        const bound = this.#workHandles.get(handle);
        if (!bound) throw new RepositoryError("UNAUTHORIZED");
        return register(this.claimRunByOwner(bound.ownerId, bound.runId, executorId, leaseMs), bound.ownerId);
      },
      renewLease: (claim: RunClaim, leaseMs = 30_000) =>
        register(this.renewLeaseByOwner(binding(claim).ownerId, claim, leaseMs), binding(claim).ownerId),
      getRunExecution: (claim: RunClaim) =>
        this.getRunExecutionByOwner(binding(claim).ownerId, binding(claim).runId),
      getRunInput: (claim: RunClaim) => {
        const bound = binding(claim);
        this.database.exec("BEGIN IMMEDIATE");
        try {
          const run = this.getRunRow(bound.ownerId, bound.runId);
          this.assertLease(run, claim.executorId, claim.fencingToken);
          const input = this.getPersistedRunInput(bound.ownerId, run);
          this.database.exec("COMMIT");
          return input;
        } catch (error) { this.database.exec("ROLLBACK"); throw error; }
      },
      getTrip: (claim: RunClaim) => {
        const bound = binding(claim);
        const run = this.getRunRow(bound.ownerId, bound.runId);
        return this.getTripByOwner(bound.ownerId, String(run.trip_id));
      },
      getVersion: (claim: RunClaim, versionId: string) => {
        const bound = binding(claim);
        const run = this.getRunRow(bound.ownerId, bound.runId);
        return this.getVersionByOwner(bound.ownerId, versionId, String(run.trip_id));
      },
      listEvents: (claim: RunClaim, afterSequence = 0) =>
        this.listEventsByOwner(binding(claim).ownerId, binding(claim).runId, afterSequence),
      checkpointRun: (claim: RunClaim, request: Omit<CheckpointRequest, "runId" | "executorId" | "fencingToken">) =>
        this.checkpointRunByOwner(binding(claim).ownerId, { ...request, runId: binding(claim).runId, executorId: claim.executorId, fencingToken: claim.fencingToken }),
      commitVersion: (claim: RunClaim, snapshot: CommittedItinerarySnapshot, commandBrief?: BriefState) =>
        this.commitVersionByOwner(binding(claim).ownerId, { ...claim, snapshot, commandBrief }),
      completeNoChange: (claim: RunClaim, versionId: string) =>
        this.completeNoChangeByOwner(binding(claim).ownerId, { ...claim, versionId }),
      cancelRun: (claim: RunClaim, reason: string) =>
        this.cancelRunByOwner(binding(claim).ownerId, binding(claim).runId, reason, claim),
    });
  }

  listBriefRevisions(credential: string, tripId: string): BriefState[] {
    const ownerId = this.authorize(credential);
    this.getTripByOwner(ownerId, tripId);
    return (this.database.prepare("SELECT brief_json FROM brief_revisions WHERE trip_id = ? AND owner_id = ? ORDER BY revision")
      .all(tripId, ownerId) as unknown as Array<{ brief_json: string }>).map(({ brief_json }) => briefStateSchema.parse(JSON.parse(brief_json)));
  }

  resumeRun(
    credential: string,
    request: { readonly turn: TurnInput; readonly brief?: BriefState },
  ): AcceptedTurn {
    const ownerId = this.authorize(credential);
    const turn = turnInputSchema.parse(request.turn);
    if (!turn.resume) throw new RepositoryError("VALIDATION_FAILED");
    const payload = canonicalize(turn);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = row<{ canonicalPayload: string; outcomeJson: string }>(this.database.prepare(
        "SELECT canonical_payload AS canonicalPayload, outcome_json AS outcomeJson FROM turns WHERE owner_id = ? AND conversation_id = ? AND id = ?",
      ), ownerId, turn.conversationId, turn.turnId);
      if (previous) {
        if (previous.canonicalPayload !== payload) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        this.database.exec("COMMIT");
        return { ...(JSON.parse(previous.outcomeJson) as AcceptedTurn), replayed: true };
      }
      const nextBrief = request.brief === undefined ? undefined : briefStateSchema.parse(request.brief);
      const run = this.getRunRow(ownerId, turn.resume.runId);
      if (run.state !== "needs_input") throw new RepositoryError("INVALID_STATE");
      const trip = this.getTripByOwner(ownerId, String(run.trip_id));
      if (turn.conversationId !== run.conversation_id || turn.targetTripId !== trip.id) throw new RepositoryError("NOT_FOUND");
      if (turn.baseVersionId !== trip.currentVersionId || turn.baseVersionId !== run.base_version_id) throw new RepositoryError("STALE_VERSION");
      if (turn.baseBriefRevision !== trip.briefRevision || Number(run.base_brief_revision) !== trip.briefRevision) throw new RepositoryError("STALE_BRIEF");
      if (Number(run.mutation_sequence) !== trip.mutationSequence) throw new RepositoryError("INVALID_STATE");
      const checkpoint = parseNullableJson(run.checkpoint_json) as { issueRevision?: unknown; resumePhase?: unknown } | null;
      if (!checkpoint || checkpoint.issueRevision !== turn.resume.issueRevision || typeof checkpoint.resumePhase !== "string") {
        throw new RepositoryError("INVALID_STATE");
      }
      const resumePhase = checkpoint.resumePhase as GenerationRun["state"];
      if (TERMINAL_STATES.has(resumePhase) || resumePhase === "needs_input" || !Object.hasOwn(TRANSITIONS, resumePhase)) {
        throw new RepositoryError("INVALID_STATE");
      }
      let briefRevision = trip.briefRevision;
      if (nextBrief) {
        if (nextBrief.revision !== trip.briefRevision + 1) throw new RepositoryError("STALE_BRIEF");
        briefRevision = nextBrief.revision;
        this.database.prepare("UPDATE trips SET brief_revision = ?, brief_json = ? WHERE id = ? AND owner_id = ?")
          .run(briefRevision, JSON.stringify(nextBrief), trip.id, ownerId);
        this.database.prepare("INSERT INTO brief_revisions (trip_id, owner_id, revision, brief_json, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(trip.id, ownerId, briefRevision, JSON.stringify(nextBrief), turn.turnId, this.now().toISOString());
      }
      const outcome: AcceptedTurn = { turnId: turn.turnId, conversationId: turn.conversationId, tripId: trip.id, runId: String(run.id), kind: "mutation", replayed: false };
      const now = this.now().toISOString();
      this.database.prepare("INSERT INTO turns (id, owner_id, conversation_id, trip_id, kind, canonical_payload, input_json, outcome_json, created_at) VALUES (?, ?, ?, ?, 'mutation', ?, ?, ?, ?)")
        .run(turn.turnId, ownerId, turn.conversationId, trip.id, payload, JSON.stringify(turn.input), JSON.stringify(outcome), now);
      this.database.prepare("UPDATE runs SET state = ?, base_brief_revision = ?, executor_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(resumePhase, briefRevision, now, run.id as string);
      this.insertRunEvent(run, { type: "run.started", versionId: run.base_version_id, message: "Run resumed after Owner input" }, now);
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  retryRun(credential: string, request: { readonly turn: TurnInput; readonly budgets: unknown }): AcceptedTurn {
    const ownerId = this.authorize(credential);
    const turn = turnInputSchema.parse(request.turn);
    if (turn.input.type !== "retry_run") throw new RepositoryError("VALIDATION_FAILED");
    const payload = canonicalize(turn);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = row<{ canonicalPayload: string; outcomeJson: string }>(this.database.prepare(
        "SELECT canonical_payload AS canonicalPayload, outcome_json AS outcomeJson FROM turns WHERE owner_id = ? AND conversation_id = ? AND id = ?",
      ), ownerId, turn.conversationId, turn.turnId);
      if (previous) {
        if (previous.canonicalPayload !== payload) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        this.database.exec("COMMIT");
        return { ...(JSON.parse(previous.outcomeJson) as AcceptedTurn), replayed: true };
      }
      if (JSON.stringify(request.budgets) === undefined) throw new RepositoryError("VALIDATION_FAILED");
      const failedRun = this.getRunRow(ownerId, turn.input.runId);
      if (failedRun.state !== "failed") throw new RepositoryError("INVALID_STATE");
      const trip = this.getTripByOwner(ownerId, String(failedRun.trip_id));
      if (turn.conversationId !== trip.conversationId || turn.targetTripId !== trip.id) throw new RepositoryError("NOT_FOUND");
      if (turn.baseVersionId !== trip.currentVersionId) throw new RepositoryError("STALE_VERSION");
      if (turn.baseBriefRevision !== trip.briefRevision) throw new RepositoryError("STALE_BRIEF");
      const mutationSequence = trip.mutationSequence + 1;
      const runId = identifier("run");
      const now = this.now().toISOString();
      const outcome: AcceptedTurn = { turnId: turn.turnId, conversationId: trip.conversationId, tripId: trip.id, runId, kind: "mutation", replayed: false };
      this.database.prepare("UPDATE trips SET mutation_sequence = ? WHERE id = ? AND owner_id = ?").run(mutationSequence, trip.id, ownerId);
      const superseded = this.database.prepare(
        "SELECT * FROM runs WHERE owner_id = ? AND trip_id = ? AND state NOT IN ('completed','degraded','failed','cancelled','superseded') ORDER BY created_at, id",
      ).all(ownerId, trip.id) as unknown as Array<Record<string, unknown>>;
      for (const activeRun of superseded) {
        this.database.prepare("UPDATE runs SET state = 'superseded', executor_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ?")
          .run(now, String(activeRun.id), ownerId);
        this.insertRunEvent(activeRun, { type: "run.superseded", versionId: activeRun.base_version_id,
          replacementRunId: runId, message: "Run superseded by a retry" }, now);
      }
      this.database.prepare("INSERT INTO turns (id, owner_id, conversation_id, trip_id, kind, canonical_payload, input_json, outcome_json, created_at) VALUES (?, ?, ?, ?, 'mutation', ?, ?, ?, ?)")
        .run(turn.turnId, ownerId, trip.conversationId, trip.id, payload, JSON.stringify(turn.input), JSON.stringify(outcome), now);
      this.database.prepare(`INSERT INTO runs (id, owner_id, conversation_id, trip_id, turn_id, base_version_id,
        base_brief_revision, mutation_sequence, state, fencing_token, repair_count, attempt_counts_json,
        retry_of_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, 0, ?, ?, ?, ?)`)
        .run(runId, ownerId, trip.conversationId, trip.id, turn.turnId, turn.baseVersionId, trip.briefRevision,
          mutationSequence, JSON.stringify({ budgets: request.budgets }), String(failedRun.id), now, now);
      this.insertEvent({ id: identifier("event"), sequence: 1, occurredAt: now, runId, turnId: turn.turnId,
        type: "run.started", versionId: turn.baseVersionId, message: "Retry accepted" });
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  renewLease(credential: string, claim: Omit<RunClaim, "leaseExpiresAt">, leaseMs = 30_000): RunClaim {
    const ownerId = this.authorize(credential);
    return this.renewLeaseByOwner(ownerId, claim, leaseMs);
  }

  private renewLeaseByOwner(ownerId: string, claim: Omit<RunClaim, "leaseExpiresAt">, leaseMs: number): RunClaim {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new RepositoryError("VALIDATION_FAILED");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.getRunRow(ownerId, claim.runId);
      this.assertLease(run, claim.executorId, claim.fencingToken);
      const leaseExpiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
      this.database.prepare("UPDATE runs SET lease_expires_at = ?, updated_at = ? WHERE id = ?")
        .run(leaseExpiresAt, this.now().toISOString(), claim.runId);
      this.database.exec("COMMIT");
      return { ...claim, leaseExpiresAt };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  checkpointRun(credential: string, request: CheckpointRequest): RunExecutionRecord {
    const ownerId = this.authorize(credential);
    return this.checkpointRunByOwner(ownerId, request);
  }

  private checkpointRunByOwner(ownerId: string, request: CheckpointRequest): RunExecutionRecord {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.getRunRow(ownerId, request.runId);
      this.assertLease(run, request.executorId, request.fencingToken);
      const previousState = run.state as GenerationRun["state"];
      if (request.event.type === "run.no_change" || request.event.type === "itinerary.completed" ||
        request.event.type === "run.degraded") {
        throw new RepositoryError("INVALID_STATE");
      }
      if (TERMINAL_STATES.has(previousState) || previousState === "needs_input" ||
        (request.state !== previousState && !TRANSITIONS[previousState].includes(request.state))) {
        throw new RepositoryError("INVALID_STATE");
      }
      const oldRepairCount = Number(run.repair_count);
      if (!Number.isInteger(request.repairCount) || request.repairCount < oldRepairCount || request.repairCount > 2) throw new RepositoryError("INVALID_STATE");
      const trip = this.getTripByOwner(ownerId, String(run.trip_id));
      if (trip.mutationSequence !== Number(run.mutation_sequence) || trip.briefRevision !== Number(run.base_brief_revision)) {
        throw new RepositoryError("INVALID_STATE");
      }
      if (trip.currentVersionId !== run.base_version_id) throw new RepositoryError("STALE_VERSION");
      const now = this.now().toISOString();
      this.database.prepare(`UPDATE runs SET state = ?, checkpoint_json = ?, operation_ids_json = ?,
        attempt_counts_json = ?, next_retry_at = ?, repair_count = ?, updated_at = ?,
        lease_expires_at = CASE WHEN ? = 'needs_input' THEN NULL ELSE lease_expires_at END,
        executor_id = CASE WHEN ? = 'needs_input' THEN NULL ELSE executor_id END WHERE id = ?`)
        .run(request.state, JSON.stringify(request.checkpoint),
          request.operationIds === undefined ? run.operation_ids_json as SQLInputValue : JSON.stringify(request.operationIds),
          request.attemptCounts === undefined ? run.attempt_counts_json as SQLInputValue : JSON.stringify(request.attemptCounts),
          request.nextRetryAt === undefined ? run.next_retry_at as SQLInputValue : request.nextRetryAt, request.repairCount, now,
          request.state, request.state, request.runId);
      if (TERMINAL_STATES.has(request.state)) {
        this.database.prepare("UPDATE runs SET executor_id = NULL, lease_expires_at = NULL WHERE id = ?").run(request.runId);
      }
      this.insertRunEvent(run, request.event, now);
      this.database.exec("COMMIT");
      return this.getRunExecutionByOwner(ownerId, request.runId);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  listEvents(credential: string, runId: string, afterSequence = 0): TurnEvent[] {
    const ownerId = this.authorize(credential);
    return this.listEventsByOwner(ownerId, runId, afterSequence);
  }

  private listEventsByOwner(ownerId: string, runId: string, afterSequence: number): TurnEvent[] {
    this.getRunRow(ownerId, runId);
    return (this.database.prepare("SELECT event_json FROM events WHERE run_id = ? AND owner_id = ? AND sequence > ? ORDER BY sequence")
      .all(runId, ownerId, afterSequence) as unknown as Array<{ event_json: string }>).map(({ event_json }) =>
        turnEventSchema.parse(JSON.parse(event_json)));
  }

  cancelRun(credential: string, runId: string, reason: string): GenerationRun {
    const ownerId = this.authorize(credential);
    return this.cancelRunByOwner(ownerId, runId, reason);
  }

  private cancelRunByOwner(ownerId: string, runId: string, reason: string, claim?: RunClaim): GenerationRun {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.getRunRow(ownerId, runId);
      if (claim) this.assertLease(run, claim.executorId, claim.fencingToken);
      if (TERMINAL_STATES.has(run.state as GenerationRun["state"])) throw new RepositoryError("INVALID_STATE");
      const now = this.now().toISOString();
      this.database.prepare("UPDATE runs SET state = 'cancelled', executor_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, runId);
      this.insertRunEvent(run, { type: "run.cancelled", versionId: run.base_version_id, reason, message: reason }, now);
      this.database.exec("COMMIT");
      return this.runFromRow(this.getRunRow(ownerId, runId));
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  putCache(credential: string, namespace: string, key: string, value: unknown): void {
    const ownerId = this.authorize(credential);
    const json = JSON.stringify(value);
    if (json === undefined) throw new RepositoryError("VALIDATION_FAILED");
    this.database.prepare(`INSERT INTO caches (owner_id, namespace, cache_key, value_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, namespace, cache_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(ownerId, namespace, key, json, this.now().toISOString());
  }

  getCache<T = unknown>(credential: string, namespace: string, key: string): T | null {
    const ownerId = this.authorize(credential);
    const item = row<{ valueJson: string }>(this.database.prepare("SELECT value_json AS valueJson FROM caches WHERE owner_id = ? AND namespace = ? AND cache_key = ?"), ownerId, namespace, key);
    return item ? JSON.parse(item.valueJson) as T : null;
  }

  commitVersion(
    credential: string,
    request: CommitVersionRequest,
  ): CommittedItinerarySnapshot {
    const ownerId = this.authorize(credential);
    return this.commitVersionByOwner(ownerId, request);
  }

  private commitVersionByOwner(
    ownerId: string,
    request: CommitVersionRequest,
  ): CommittedItinerarySnapshot {
    const snapshot = committedItinerarySnapshotSchema.parse(request.snapshot);
    const commandBrief = request.commandBrief === undefined ? undefined : briefStateSchema.parse(request.commandBrief);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = row<{ versionJson: string; runId: string; commandBriefJson: string | null }>(
        this.database.prepare("SELECT version_json AS versionJson, run_id AS runId, command_brief_json AS commandBriefJson FROM versions WHERE id = ? AND owner_id = ?"),
        snapshot.id, ownerId,
      );
      if (existing) {
        const persisted = committedItinerarySnapshotSchema.parse(JSON.parse(existing.versionJson));
        if (existing.runId !== request.runId || canonicalize(persisted) !== canonicalize(snapshot) ||
          canonicalize(parseNullableJson(existing.commandBriefJson)) !== canonicalize(commandBrief)) {
          throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        }
        this.database.exec("COMMIT");
        return persisted;
      }
      const run = this.getRunRow(ownerId, request.runId);
      this.assertLease(run, request.executorId, request.fencingToken);
      if (run.state !== "validating") throw new RepositoryError("INVALID_STATE");
      const trip = this.getTripByOwner(ownerId, String(run.trip_id));
      if (Number(run.base_brief_revision) !== trip.briefRevision) throw new RepositoryError("STALE_BRIEF");
      if (commandBrief) {
        const input = this.getPersistedRunInput(ownerId, run);
        if (input.input.type === "user_message" || input.baseVersionId === null) {
          throw new RepositoryError("VALIDATION_FAILED");
        }
        if (commandBrief.revision !== trip.briefRevision + 1) throw new RepositoryError("STALE_BRIEF");
      }
      const committedBrief = commandBrief ?? trip.brief;
      if (
        snapshot.tripId !== trip.id || snapshot.conversationId !== trip.conversationId ||
        snapshot.turnId !== run.turn_id || snapshot.runId !== run.id ||
        snapshot.baseVersionId !== trip.currentVersionId || snapshot.baseVersionId !== run.base_version_id ||
        snapshot.briefRevision !== committedBrief.revision ||
        canonicalize(snapshot.brief) !== canonicalize(committedBrief) ||
        snapshot.brief.revision !== snapshot.briefRevision ||
        snapshot.itinerary.tripId !== snapshot.tripId || snapshot.itinerary.runId !== snapshot.runId ||
        snapshot.itinerary.baseVersionId !== snapshot.baseVersionId || snapshot.itinerary.briefRevision !== snapshot.briefRevision ||
        Number(run.mutation_sequence) !== trip.mutationSequence
      ) throw new RepositoryError("VALIDATION_FAILED");
      const now = this.now().toISOString();
      const terminalState = snapshot.warnings.length ? "degraded" : "completed";
      if (commandBrief) {
        this.database.prepare("INSERT INTO brief_revisions (trip_id, owner_id, revision, brief_json, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(trip.id, ownerId, commandBrief.revision, JSON.stringify(commandBrief), snapshot.turnId, now);
        this.database.prepare("UPDATE trips SET brief_revision = ?, brief_json = ? WHERE id = ? AND owner_id = ?")
          .run(commandBrief.revision, JSON.stringify(commandBrief), trip.id, ownerId);
      }
      this.database.prepare("INSERT INTO versions (id, owner_id, conversation_id, trip_id, run_id, brief_revision, mutation_sequence, version_json, command_brief_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(snapshot.id, ownerId, snapshot.conversationId, snapshot.tripId, snapshot.runId, snapshot.briefRevision, trip.mutationSequence, JSON.stringify(snapshot),
          commandBrief === undefined ? null : JSON.stringify(commandBrief), now);
      this.database.prepare("UPDATE trips SET current_version_id = ? WHERE id = ? AND owner_id = ?").run(snapshot.id, trip.id, ownerId);
      this.database.prepare("UPDATE runs SET state = ?, executor_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(terminalState, now, run.id as string);
      const turn = row<{ outcomeJson: string }>(this.database.prepare("SELECT outcome_json AS outcomeJson FROM turns WHERE id = ? AND conversation_id = ? AND owner_id = ?"), String(run.turn_id), trip.conversationId, ownerId);
      if (!turn) throw new RepositoryError("NOT_FOUND");
      this.database.prepare("UPDATE turns SET outcome_json = ? WHERE id = ? AND conversation_id = ? AND owner_id = ?")
        .run(JSON.stringify({ ...JSON.parse(turn.outcomeJson), versionId: snapshot.id }), String(run.turn_id), trip.conversationId, ownerId);
      this.insertRunEvent(run, snapshot.warnings.length
        ? { type: "run.degraded", versionId: snapshot.id, warnings: snapshot.warnings.map(warning => warning.message), message: "Itinerary committed with warnings" }
        : { type: "itinerary.completed", versionId: snapshot.id, message: "Itinerary committed" }, now);
      this.database.exec("COMMIT");
      return snapshot;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  completeNoChange(credential: string, request: NoChangeRequest): NoChangeOutcome {
    // The deterministic edit planner must establish no_op before calling this operation.
    return this.completeNoChangeByOwner(this.authorize(credential), request);
  }

  private completeNoChangeByOwner(ownerId: string, request: NoChangeRequest): NoChangeOutcome {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.getRunRow(ownerId, request.runId);
      const turn = row<{ outcomeJson: string; canonicalPayload: string; kind: string }>(
        this.database.prepare(`SELECT outcome_json AS outcomeJson, canonical_payload AS canonicalPayload, kind
          FROM turns WHERE owner_id = ? AND conversation_id = ? AND trip_id = ? AND id = ?`),
        ownerId, String(run.conversation_id), String(run.trip_id), String(run.turn_id),
      );
      if (!turn) throw new RepositoryError("NOT_FOUND");
      const saved = JSON.parse(turn.outcomeJson) as AcceptedTurn;
      if (saved.noChange === true) {
        if (run.state !== "completed" || saved.runId !== run.id || saved.turnId !== run.turn_id ||
          saved.conversationId !== run.conversation_id || saved.tripId !== run.trip_id ||
          saved.versionId !== request.versionId || saved.versionId !== run.base_version_id) {
          throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        }
        this.database.exec("COMMIT");
        return { ...saved, noChange: true, versionId: request.versionId, replayed: true };
      }
      this.assertLease(run, request.executorId, request.fencingToken);
      if (run.state !== "ready" || turn.kind !== "mutation") throw new RepositoryError("INVALID_STATE");
      const input = turnInputSchema.parse(JSON.parse(turn.canonicalPayload));
      if (input.input.type === "user_message" || input.baseVersionId === null) throw new RepositoryError("INVALID_STATE");
      const trip = this.getTripByOwner(ownerId, String(run.trip_id));
      if (trip.conversationId !== run.conversation_id || input.conversationId !== trip.conversationId ||
        input.targetTripId !== trip.id || saved.runId !== run.id || saved.turnId !== run.turn_id ||
        saved.tripId !== trip.id || saved.conversationId !== trip.conversationId) {
        throw new RepositoryError("NOT_FOUND");
      }
      if (request.versionId !== trip.currentVersionId || request.versionId !== run.base_version_id ||
        request.versionId !== input.baseVersionId) throw new RepositoryError("STALE_VERSION");
      if (Number(run.mutation_sequence) !== trip.mutationSequence) throw new RepositoryError("INVALID_STATE");
      if (Number(run.base_brief_revision) !== trip.briefRevision || input.baseBriefRevision !== trip.briefRevision) {
        throw new RepositoryError("STALE_BRIEF");
      }
      const base = this.getVersionByOwner(ownerId, request.versionId, trip.id);
      if (base.conversationId !== trip.conversationId) throw new RepositoryError("NOT_FOUND");
      if (base.briefRevision !== trip.briefRevision) throw new RepositoryError("STALE_BRIEF");
      const outcome: NoChangeOutcome = { ...saved, noChange: true, versionId: base.id };
      const now = this.now().toISOString();
      this.database.prepare("UPDATE runs SET state = 'completed', executor_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ?")
        .run(now, request.runId, ownerId);
      this.database.prepare("UPDATE turns SET outcome_json = ? WHERE owner_id = ? AND conversation_id = ? AND trip_id = ? AND id = ?")
        .run(JSON.stringify(outcome), ownerId, trip.conversationId, trip.id, String(run.turn_id));
      this.insertRunEvent(run, { type: "run.no_change", versionId: base.id, message: "Itinerary unchanged" }, now);
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  listVersions(credential: string, tripId: string): CommittedItinerarySnapshot[] {
    const ownerId = this.authorize(credential);
    this.getTripByOwner(ownerId, tripId);
    return (this.database.prepare("SELECT version_json FROM versions WHERE owner_id = ? AND trip_id = ? ORDER BY created_at, id")
      .all(ownerId, tripId) as unknown as Array<{ version_json: string }>).map(({ version_json }) =>
        committedItinerarySnapshotSchema.parse(JSON.parse(version_json)));
  }

  getVersion(credential: string, versionId: string, tripId?: string): CommittedItinerarySnapshot {
    const ownerId = this.authorize(credential);
    return this.getVersionByOwner(ownerId, versionId, tripId);
  }

  private getVersionByOwner(ownerId: string, versionId: string, tripId?: string): CommittedItinerarySnapshot {
    const item = row<{ versionJson: string; tripId: string }>(this.database.prepare("SELECT version_json AS versionJson, trip_id AS tripId FROM versions WHERE id = ? AND owner_id = ?"), versionId, ownerId);
    if (!item || (tripId !== undefined && item.tripId !== tripId)) throw new RepositoryError("NOT_FOUND");
    return committedItinerarySnapshotSchema.parse(JSON.parse(item.versionJson));
  }

  getEvidence(credential: string, versionId: string, evidenceId: string): EvidenceFact {
    const version = this.getVersion(credential, versionId);
    const evidence = version.evidence.find((item) => item.id === evidenceId && version.evidenceIds.includes(item.id));
    if (!evidence) throw new RepositoryError("NOT_FOUND");
    return structuredClone(evidence);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private authorize(credential: string) {
    const owner = row<{ id: string; expiresAt: string }>(
      this.database.prepare(
        "SELECT id, expires_at AS expiresAt FROM owners WHERE credential_digest = ?",
      ),
      digestCredential(credential),
    );
    if (!owner || Date.parse(owner.expiresAt) <= this.now().getTime()) {
      throw new RepositoryError("UNAUTHORIZED");
    }
    return owner.id;
  }

  private getTripByOwner(ownerId: string, tripId: string) {
    const item = row<Record<string, unknown>>(this.database.prepare("SELECT * FROM trips WHERE id = ? AND owner_id = ?"), tripId, ownerId);
    if (!item) throw new RepositoryError("NOT_FOUND");
    return this.parseTrip(item);
  }

  private getRunRow(ownerId: string, runId: string): Record<string, unknown> {
    const item = row<Record<string, unknown>>(this.database.prepare("SELECT * FROM runs WHERE id = ? AND owner_id = ?"), runId, ownerId);
    if (!item) throw new RepositoryError("NOT_FOUND");
    return item;
  }

  private runFromRow(item: Record<string, unknown>): GenerationRun {
    return { id: String(item.id), conversationId: String(item.conversation_id), tripId: String(item.trip_id),
      turnId: String(item.turn_id), baseVersionId: item.base_version_id === null ? null : String(item.base_version_id),
      baseBriefRevision: Number(item.base_brief_revision), state: item.state as GenerationRun["state"] };
  }

  private getPersistedRunInput(ownerId: string, run: Record<string, unknown>): TurnInput {
    const persisted = row<{ canonicalPayload: string }>(this.database.prepare(`
      SELECT t.canonical_payload AS canonicalPayload FROM turns t
      JOIN runs r ON r.owner_id = t.owner_id AND r.conversation_id = t.conversation_id
        AND r.trip_id = t.trip_id AND r.turn_id = t.id
      JOIN trips p ON p.id = r.trip_id AND p.owner_id = r.owner_id AND p.conversation_id = r.conversation_id
      JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id AND c.trip_id = p.id
      WHERE r.id = ? AND r.owner_id = ? AND t.kind = 'mutation'`), String(run.id), ownerId);
    if (!persisted) throw new RepositoryError("NOT_FOUND");
    const input = turnInputSchema.parse(JSON.parse(persisted.canonicalPayload));
    if (input.turnId !== run.turn_id || input.conversationId !== run.conversation_id ||
      (input.targetTripId !== run.trip_id && !(input.targetTripId === null && input.baseVersionId === null)) ||
      input.baseVersionId !== run.base_version_id) throw new RepositoryError("NOT_FOUND");
    return input;
  }

  private assertLease(run: Record<string, unknown>, executorId: string, fencingToken: number) {
    if (run.executor_id !== executorId || Number(run.fencing_token) !== fencingToken || run.lease_expires_at === null || Date.parse(String(run.lease_expires_at)) <= this.now().getTime()) {
      throw new RepositoryError("LEASE_CONFLICT");
    }
  }

  private insertRunEvent(run: Record<string, unknown>, event: Record<string, unknown>, occurredAt: string) {
    const sequence = Number(row<{ sequence: number }>(this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE run_id = ?"), String(run.id))!.sequence);
    this.insertEvent({ ...event, id: identifier("event"), sequence, occurredAt, runId: String(run.id), turnId: String(run.turn_id) });
  }

  private insertEvent(event: unknown) {
    const parsed = turnEventSchema.parse(event);
    const owner = row<{ ownerId: string }>(this.database.prepare("SELECT owner_id AS ownerId FROM runs WHERE id = ?"), parsed.runId);
    if (!owner) throw new RepositoryError("NOT_FOUND");
    this.database.prepare("INSERT INTO events (run_id, owner_id, sequence, event_json) VALUES (?, ?, ?, ?)")
      .run(parsed.runId, owner.ownerId, parsed.sequence, JSON.stringify(parsed));
  }

  private parseTrip(item: Record<string, unknown>): TripRecord {
    return {
      id: String(item.id), conversationId: String(item.conversation_id),
      currentVersionId: item.current_version_id === null ? null : String(item.current_version_id),
      briefRevision: Number(item.brief_revision), mutationSequence: Number(item.mutation_sequence),
      brief: briefStateSchema.parse(JSON.parse(String(item.brief_json))), createdAt: String(item.created_at),
    };
  }

  private assertOwnedVersion(ownerId: string, tripId: string, versionId: string) {
    const item = row(this.database.prepare("SELECT id FROM versions WHERE id = ? AND trip_id = ? AND owner_id = ?"), versionId, tripId, ownerId);
    if (!item) throw new RepositoryError("NOT_FOUND");
  }
}

export function openRepository(options: OpenRepositoryOptions) {
  mkdirSync(path.dirname(path.resolve(options.path)), { recursive: true });
  const database = new DatabaseSync(options.path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (options.path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
  }
  migrate(database);
  return new TripRepository(database, options.now ?? (() => new Date()));
}

function migrate(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY,
      credential_digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id),
      trip_id TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id), current_version_id TEXT,
      brief_revision INTEGER NOT NULL, mutation_sequence INTEGER NOT NULL,
      brief_json TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES owners(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id), trip_id TEXT NOT NULL REFERENCES trips(id),
      kind TEXT NOT NULL CHECK(kind IN ('mutation','read')), canonical_payload TEXT NOT NULL,
      input_json TEXT NOT NULL, outcome_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(owner_id, conversation_id, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brief_revisions (
      trip_id TEXT NOT NULL REFERENCES trips(id), owner_id TEXT NOT NULL REFERENCES owners(id),
      revision INTEGER NOT NULL, brief_json TEXT NOT NULL, turn_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(trip_id, revision)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
      trip_id TEXT NOT NULL REFERENCES trips(id), turn_id TEXT NOT NULL, base_version_id TEXT,
      base_brief_revision INTEGER NOT NULL, mutation_sequence INTEGER NOT NULL, state TEXT NOT NULL,
      fencing_token INTEGER NOT NULL, executor_id TEXT, lease_expires_at TEXT, repair_count INTEGER NOT NULL,
      checkpoint_json TEXT, operation_ids_json TEXT, attempt_counts_json TEXT, next_retry_at TEXT,
      retry_of_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
      trip_id TEXT NOT NULL REFERENCES trips(id), run_id TEXT NOT NULL REFERENCES runs(id), brief_revision INTEGER NOT NULL,
      mutation_sequence INTEGER NOT NULL, version_json TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL REFERENCES runs(id), owner_id TEXT NOT NULL REFERENCES owners(id),
      sequence INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(run_id, sequence)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS caches (
      owner_id TEXT NOT NULL REFERENCES owners(id), namespace TEXT NOT NULL, cache_key TEXT NOT NULL,
      value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, namespace, cache_key)
    ) STRICT;
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!row(database.prepare("SELECT version FROM schema_migrations WHERE version = 2"))) {
      database.exec("ALTER TABLE versions ADD COLUMN command_brief_json TEXT");
      database.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
    }
    if (!row(database.prepare("SELECT version FROM schema_migrations WHERE version = 3"))) {
      database.exec(`CREATE TABLE interpretation_ledger (
        owner_id TEXT NOT NULL REFERENCES owners(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        turn_id TEXT NOT NULL, canonical_payload TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 2),
        fence INTEGER NOT NULL CHECK(fence >= 0),
        lease_expires_at TEXT, output_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, conversation_id, turn_id),
        CHECK(output_json IS NULL OR length(CAST(output_json AS BLOB)) <= 131072),
        CHECK(output_json IS NULL OR lease_expires_at IS NULL)
      ) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`);
    }
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
