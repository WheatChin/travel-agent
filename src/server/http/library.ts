import { z } from "zod";
import {
  conversationIdSchema, tripIdSchema, itineraryVersionIdSchema, runIdSchema,
  turnIdSchema, typedCommandSchema, userMessageSchema, generationRunSchema,
} from "@/domain/contracts";
import { briefStateSchema, committedItinerarySnapshotSchema } from "@/domain";
import { RepositoryError, type TripRepository } from "@/server/repository";
import { credentialCookie, errorResponse, readCredential, readMutationJson } from "./security";

export type RuntimeMode = "live" | "fake" | "fixture";

const conversationSchema = z.object({
  id: conversationIdSchema, tripId: tripIdSchema.nullable(), createdAt: z.iso.datetime(),
}).strict();
const tripSchema = z.object({
  id: tripIdSchema, conversationId: conversationIdSchema,
  currentVersionId: itineraryVersionIdSchema.nullable(),
  briefRevision: z.number().int().nonnegative(), brief: briefStateSchema,
  createdAt: z.iso.datetime(),
}).strict();
const messageSchema = z.object({
  turnId: turnIdSchema, conversationId: conversationIdSchema,
  input: z.union([typedCommandSchema, userMessageSchema]), createdAt: z.iso.datetime(),
}).strict();
const emptySchema = z.object({}).strict();
const errors = {
  invalid_credential: [401, "Invalid credential."],
  malformed_input: [400, "Malformed input."],
  not_found: [404, "Resource not found."],
  conflict: [409, "Request conflicts with current state."],
} as const;

class LibraryError extends Error {
  constructor(readonly code: keyof typeof errors) { super(code); }
}

function json(value: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(value, { status, headers: responseHeaders });
}

function failure(error: unknown): Response {
  if (error instanceof RepositoryError) {
    switch (error.code) {
      case "UNAUTHORIZED": error = new LibraryError("invalid_credential"); break;
      case "NOT_FOUND": error = new LibraryError("not_found"); break;
      case "VALIDATION_FAILED": error = new LibraryError("malformed_input"); break;
      case "IDEMPOTENCY_CONFLICT":
      case "STALE_VERSION":
      case "STALE_BRIEF":
      case "INVALID_STATE":
      case "LEASE_CONFLICT": error = new LibraryError("conflict"); break;
    }
  }
  if (error instanceof LibraryError) {
    const [status, message] = errors[error.code];
    return json({ code: error.code, message }, status);
  }
  return errorResponse(error);
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new LibraryError("malformed_input");
  return result.data;
}

function query(request: Request, allowed: readonly string[] = []) {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!allowed.includes(key) || parameters.getAll(key).length !== 1) {
      throw new LibraryError("malformed_input");
    }
  }
  return parameters;
}

function credential(request: Request) {
  const value = readCredential(request);
  if (value === null) throw new LibraryError("invalid_credential");
  return value;
}

function publicTrip(trip: ReturnType<TripRepository["getTrip"]>) {
  // Mutation sequence is an execution fence, not part of the library projection.
  const { id, conversationId, currentVersionId, briefRevision, brief, createdAt } = trip;
  return tripSchema.parse({ id, conversationId, currentVersionId, briefRevision, brief, createdAt });
}

export function createLibraryHandlers(options: {
  repository: () => TripRepository;
  appOrigin: string;
  mode: RuntimeMode;
}) {
  async function boundary(action: () => Response | Promise<Response>) {
    try { return await action(); } catch (error) { return failure(error); }
  }

  return {
    getTrip: (request: Request, tripId: string) => boundary(() => {
      const parameters = query(request, ["versionId"]);
      const token = credential(request);
      const id = input(tripIdSchema, tripId);
      const requestedVersion = parameters.has("versionId")
        ? input(itineraryVersionIdSchema, parameters.get("versionId")) : undefined;
      const repository = options.repository();
      const trip = repository.getTrip(token, id);
      const versionId = requestedVersion ?? trip.currentVersionId;
      const version = versionId === null ? null
        : committedItinerarySnapshotSchema.parse(repository.getVersion(token, versionId, id));
      return json({ trip: publicTrip(trip), version });
    }),
    listVersions: (request: Request, tripId: string) => boundary(() => {
      query(request);
      const token = credential(request);
      const id = input(tripIdSchema, tripId);
      return json({ versions: z.array(committedItinerarySnapshotSchema).parse(options.repository().listVersions(token, id)) });
    }),
    getRun: (request: Request, runId: string) => boundary(() => {
      query(request);
      const token = credential(request);
      const id = input(runIdSchema, runId);
      return json({ run: generationRunSchema.parse(options.repository().getRun(token, id)) });
    }),
    listConversations: (request: Request) => boundary(() => {
      query(request);
      const token = credential(request);
      return json({ conversations: z.array(conversationSchema).parse(options.repository().listConversations(token)) });
    }),
    createConversation: (request: Request) => boundary(async () => {
      query(request);
      input(emptySchema, await readMutationJson(request, options.appOrigin));
      const token = credential(request);
      return json({ conversation: conversationSchema.parse(options.repository().createConversation(token)) }, 201);
    }),
    listMessages: (request: Request, conversationId: string) => boundary(() => {
      query(request);
      const token = credential(request);
      const id = input(conversationIdSchema, conversationId);
      return json({ messages: z.array(messageSchema).parse(options.repository().listMessages(token, id)) });
    }),
    listTrips: (request: Request) => boundary(() => {
      query(request);
      const token = credential(request);
      return json({ trips: options.repository().listTrips(token).map(publicTrip) });
    }),
    bootstrap: (request: Request) => boundary(async () => {
      query(request);
      input(emptySchema, await readMutationJson(request, options.appOrigin));
      const existing = readCredential(request);
      const repository = options.repository();
      const issued = existing === null ? repository.createOwner() : null;
      const token = existing ?? issued!.credential;
      const conversations = z.array(conversationSchema).parse(repository.listConversations(token));
      const trips = repository.listTrips(token).map(publicTrip);
      return json({
        mode: input(z.enum(["live", "fake", "fixture"]), options.mode),
        library: { conversations, trips },
        capabilities: { planning: { status: "unavailable", reason: "integration_unavailable" } },
      }, 200, issued ? { "set-cookie": credentialCookie(issued.credential, new Date(issued.expiresAt)) } : undefined);
    }),
  };
}
