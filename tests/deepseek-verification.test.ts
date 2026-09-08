import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  runDeepSeekTask,
  type DeepSeekDependencies,
  type DeepSeekTask,
} from "../src/server/providers/deepseek";

const SENTINEL = "independent-secret-sentinel";
const resultSchema = z.strictObject({ placeId: z.literal("place_supplied") });
const task: DeepSeekTask<z.infer<typeof resultSchema>> = {
  operationId: "operation-independent",
  kind: "model",
  outputTokens: 256,
  instructions: "Return only a supplied Place ID.",
  data: { placeIds: ["place_supplied"] },
  schema: resultSchema,
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: '{"placeId":"place_supplied"}' },
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    ...overrides,
  };
}

function dependencies(fetch: DeepSeekDependencies["fetch"]): DeepSeekDependencies {
  return {
    config: {
      origin: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: SENTINEL,
    },
    reserve: async () => ({ ok: true }),
    fetch,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("independent DeepSeek closed output handling", () => {
  it.each([
    [429, "2", { delayMs: 2_000 }],
    [503, "Wed, 02 Jan 2030 03:04:15 GMT", { delayMs: 10_000 }],
    [429, "31", "rate_limited"],
    [401, "2", "not_retryable"],
    [429, SENTINEL, { delayMs: 1_000 }],
  ] as const)("returns only normalized retry guidance for HTTP %i", async (status, retryAfter, retryHint) => {
    const reserve = vi.fn<DeepSeekDependencies["reserve"]>(async () => ({ ok: true }));
    const fetch = vi.fn<DeepSeekDependencies["fetch"]>(async () => new Response(SENTINEL, {
      status,
      headers: { "retry-after": retryAfter, "x-provider-secret": SENTINEL },
    }));
    const result = await runDeepSeekTask(task, {
      ...dependencies(fetch), reserve,
      clock: () => Date.parse("2030-01-02T03:04:05Z"),
    });

    expect(result).toMatchObject({ ok: false, status, retryHint });
    expect(result).not.toHaveProperty("nextRetryAt");
    expect(result).not.toHaveProperty("retryAfter");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, 1.5, 8_640_000_000_000_001])(
    "rejects invalid injected clock %s before durable reservation",
    async now => {
      const reserve = vi.fn<DeepSeekDependencies["reserve"]>(async () => ({ ok: true }));
      const fetch = vi.fn<DeepSeekDependencies["fetch"]>(async () => Response.json(envelope()));
      const result = await runDeepSeekTask(task, {
        ...dependencies(fetch), reserve, clock: () => now,
      });

      expect(result).toMatchObject({ ok: false, code: "invalid_input" });
      expect(reserve).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["refusal", { refusal: SENTINEL }, "refused"],
    ["legacy function call", { function_call: { name: "leak", arguments: SENTINEL } }, "tool_calls"],
  ])("rejects %s without returning provider content", async (_label, messageOverride, code) => {
    const body = envelope();
    const choice = body.choices[0];
    const response = Response.json({
      ...body,
      choices: [{ ...choice, message: { ...choice.message, ...messageOverride } }],
    });

    const result = await runDeepSeekTask(task, dependencies(async () => response));
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("omits usage whose token arithmetic is inconsistent", async () => {
    const response = Response.json(envelope({
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 99 },
    }));

    await expect(runDeepSeekTask(task, dependencies(async () => response))).resolves.toEqual({
      ok: true,
      data: { placeId: "place_supplied" },
    });
  });

  it("cancels a finite late response when injected transport ignores deadline abort", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope())));
        controller.close();
      },
      cancel() { cancelled = true; },
    });
    const fetch = vi.fn<DeepSeekDependencies["fetch"]>(() => new Promise(resolve => {
      setTimeout(() => resolve(new Response(stream, {
        headers: { "content-type": "application/json" },
      })), 20);
    }));

    const pending = runDeepSeekTask(task, {
      ...dependencies(fetch),
      deadlineMs: 5,
    });
    await vi.advanceTimersByTimeAsync(6);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "deadline" });
    await vi.advanceTimersByTimeAsync(20);

    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
