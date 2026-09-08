import {
  generationRunSchema, runIdSchema, turnEventSchema,
  type GenerationRun, type TurnEvent,
} from "@/domain/contracts";
import { RepositoryError } from "@/server/repository";
import { errorResponse, readCredential } from "./security";

export interface ObservationClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

interface EventRepository {
  getRun(credential: string, runId: string): GenerationRun;
  listEventPage(credential: string, runId: string, afterSequence?: number, limit?: number): {
    events: TurnEvent[];
    headSequence: number;
  };
}

const systemClock: ObservationClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const PAGE_SIZE = 16;
const MAX_FRAME_BYTES = 65_536 + 256;
const encoder = new TextEncoder();
const stoppedStates = new Set<GenerationRun["state"]>([
  "completed", "degraded", "failed", "cancelled", "superseded", "needs_input",
]);
const errors = {
  invalid_credential: [401, "Invalid credential."],
  not_found: [404, "Resource not found."],
  malformed_input: [400, "Malformed input."],
  conflict: [409, "Request conflicts with current state."],
} as const;

class ObservationError extends Error {
  constructor(readonly code: keyof typeof errors) { super(code); }
}

function failure(error: unknown): Response {
  if (error instanceof RepositoryError) {
    if (error.code === "UNAUTHORIZED") error = new ObservationError("invalid_credential");
    else if (error.code === "NOT_FOUND") error = new ObservationError("not_found");
  }
  if (error instanceof ObservationError) {
    const [status, message] = errors[error.code];
    return Response.json({ code: error.code, message }, {
      status, headers: { "cache-control": "no-store" },
    });
  }
  return errorResponse(error);
}

function cursor(request: Request) {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (key !== "afterSequence" || parameters.getAll(key).length !== 1) {
      throw new ObservationError("malformed_input");
    }
  }
  const parse = (text: string | null) => {
    if (text === null) return null;
    if (!/^(0|[1-9][0-9]{0,15})$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw new ObservationError("malformed_input");
    }
    return Number(text);
  };
  const header = parse(request.headers.get("last-event-id"));
  const query = parse(parameters.get("afterSequence"));
  if (header !== null && query !== null && header !== query) throw new ObservationError("malformed_input");
  return header ?? query ?? 0;
}

function frame(event: TurnEvent) {
  const bytes = encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error("Event frame limit exceeded.");
  return bytes;
}

export function createEventsHandler(options: {
  repository: () => EventRepository;
  clock?: ObservationClock;
}) {
  const clock = options.clock ?? systemClock;
  return async (request: Request, runId: string): Promise<Response> => {
    try {
      const credential = readCredential(request);
      if (credential === null) throw new ObservationError("invalid_credential");
      if (!runIdSchema.safeParse(runId).success) throw new ObservationError("malformed_input");
      const repository = options.repository();
      let run = generationRunSchema.parse(repository.getRun(credential, runId));
      let afterSequence = cursor(request);

      function readPage() {
        const page = repository.listEventPage(credential!, runId, afterSequence, PAGE_SIZE);
        if (!Number.isSafeInteger(page.headSequence) || page.headSequence < 0 ||
          !Array.isArray(page.events) || page.events.length > PAGE_SIZE) {
          throw new Error("Invalid event page.");
        }
        if (afterSequence > page.headSequence) throw new ObservationError("conflict");
        let previous = afterSequence;
        for (const raw of page.events) {
          const event = turnEventSchema.parse(raw);
          if (event.runId !== runId || !Number.isSafeInteger(event.sequence) ||
            event.sequence <= previous || event.sequence > page.headSequence) {
            throw new Error("Invalid persisted event ordering.");
          }
          frame(event);
          previous = event.sequence;
        }
        return page;
      }

      // Admission reads one bounded page before 200, even when the client never pulls.
      let page = readPage();
      let index = 0;
      let lastActivity = clock.now();
      let closed = false;
      let cancelTimer: (() => void) | undefined;
      let finishPull: (() => void) | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array>;

      function cleanup() {
        closed = true;
        cancelTimer?.();
        cancelTimer = undefined;
        request.signal.removeEventListener("abort", abort);
        page = { events: [], headSequence: afterSequence };
        finishPull?.();
        finishPull = undefined;
      }
      function close() {
        if (closed) return;
        cleanup();
        controller.close();
      }
      function abort() { close(); }

      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) close();
        },
        pull() {
          if (closed) return;
          return new Promise<void>(resolve => {
            finishPull = resolve;
            function deliver(): boolean {
              if (index < page.events.length) {
                // Reauthorize before releasing even a previously buffered page item.
                generationRunSchema.parse(repository.getRun(credential!, runId));
                const event = page.events[index++];
                controller.enqueue(frame(turnEventSchema.parse(event)));
                afterSequence = event.sequence;
                lastActivity = clock.now();
                if (index === page.events.length && stoppedStates.has(run.state) &&
                  afterSequence === page.headSequence) close();
                return true;
              }
              if (stoppedStates.has(run.state) && afterSequence === page.headSequence) {
                close();
                return true;
              }
              return false;
            }
            function completePull() {
              finishPull = undefined;
              resolve();
            }
            function observe() {
              cancelTimer = undefined;
              if (closed) return;
              try {
                // State first: terminal state must never close ahead of its durable event.
                run = generationRunSchema.parse(repository.getRun(credential!, runId));
                page = readPage();
                index = 0;
                if (deliver()) return completePull();
                if (clock.now() - lastActivity >= 15_000) {
                  controller.enqueue(encoder.encode(": keep-alive\n\n"));
                  lastActivity = clock.now();
                  return completePull();
                }
                cancelTimer = clock.schedule(observe, 1_000);
              } catch {
                close();
              }
            }
            try {
              if (deliver()) return completePull();
              if (afterSequence < page.headSequence) observe();
              else cancelTimer = clock.schedule(observe, 1_000);
            } catch {
              close();
            }
          });
        },
        cancel() { if (!closed) cleanup(); },
      }, { highWaterMark: 0 });
      return new Response(stream, { headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      } });
    } catch (error) {
      return failure(error);
    }
  };
}
