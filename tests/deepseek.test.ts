import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  runDeepSeekTask,
  type DeepSeekDependencies,
  type DeepSeekTask,
} from "../src/server/providers/deepseek";

const SENTINEL = "synthetic-test-only-not-a-provider-key";
const schema = z.strictObject({ placeId: z.literal("supplied-place") });
const task: DeepSeekTask<z.infer<typeof schema>> = {
  operationId: "operation-1",
  kind: "model",
  outputTokens: 4096,
  instructions: "Select only the supplied Place ID.",
  data: { placeIds: ["supplied-place"] },
  schema,
};

function envelope(content = '{"placeId":"supplied-place"}', finishReason = "stop") {
  return {
    choices: [{
      finish_reason: finishReason,
      message: { role: "assistant", content, reasoning_content: SENTINEL },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
}

function setup(response: () => Response = () => Response.json(envelope())) {
  const reserve = vi.fn<DeepSeekDependencies["reserve"]>(async () => ({ ok: true }));
  const fetch = vi.fn<DeepSeekDependencies["fetch"]>(async () => response());
  const dependencies: DeepSeekDependencies = {
    config: { origin: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKey: SENTINEL },
    reserve,
    fetch,
  };
  return { dependencies, reserve, fetch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DeepSeek admission and exact transport", () => {
  it("awaits durable reservation before exactly one configured JSON request", async () => {
    const { dependencies, reserve, fetch } = setup();
    reserve.mockImplementation(async (reservation) => {
      expect(reservation).toEqual({ operationId: "operation-1", kind: "model", outputTokens: 4096 });
      await Promise.resolve();
      expect(fetch).not.toHaveBeenCalled();
      return { ok: true };
    });
    const result = await runDeepSeekTask(task, dependencies);
    expect(result).toEqual({
      ok: true,
      data: { placeId: "supplied-place" },
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0][0];
    expect(request.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    expect(request.headers.get("authorization")).toBe(`Bearer ${SENTINEL}`);
    const body = await request.json();
    expect(body).toEqual({
      model: "deepseek-v4-flash", max_tokens: 4096, stream: false,
      response_format: { type: "json_object" }, thinking: { type: "disabled" },
      messages: [
        { role: "system", content: expect.stringContaining("JSON") },
        { role: "user", content: '{"placeIds":["supplied-place"]}' },
      ],
    });
    expect(body.messages[0].content).toContain(task.instructions);
    expect(body.messages[0].content).toContain("untrusted");
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it.each([
    [{ origin: undefined }, "configuration"],
    [{ model: undefined }, "configuration"],
    [{ apiKey: undefined }, "configuration"],
    [{ apiKey: "" }, "configuration"],
    [{ apiKey: "bad\nheader" }, "configuration"],
    [{ apiKey: `${SENTINEL}\n` }, "configuration"],
    [{ origin: "https://api.deepseek.com/" }, "capability"],
    [{ origin: "https://evil.example" }, "capability"],
    [{ model: "different-model" }, "capability"],
  ] as const)("rejects configuration %j before reservation", async (changes, code) => {
    const { dependencies, reserve, fetch } = setup();
    const result = await runDeepSeekTask(task, {
      ...dependencies, config: { ...dependencies.config, ...changes },
    });
    expect(result).toMatchObject({ ok: false, code });
    expect(reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 4097, Number.NaN, 1.5])("rejects invalid token budget %s", async (outputTokens) => {
    const { dependencies, reserve, fetch } = setup();
    expect(await runDeepSeekTask({ ...task, outputTokens }, dependencies))
      .toMatchObject({ ok: false, code: "invalid_input" });
    expect(reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reserves classification separately at 1024 and rejects 1025 tokens", async () => {
    const { dependencies, reserve, fetch } = setup();
    expect(await runDeepSeekTask({ ...task, kind: "classification", outputTokens: 1024 }, dependencies))
      .toMatchObject({ ok: true });
    expect(reserve).toHaveBeenCalledWith({
      operationId: "operation-1", kind: "classification", outputTokens: 1024,
    });
    expect(await runDeepSeekTask({ ...task, kind: "classification", outputTokens: 1025 }, dependencies))
      .toMatchObject({ ok: false, code: "invalid_input" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds serialized messages by UTF-8 bytes without truncating facts", async () => {
    const { dependencies, reserve, fetch } = setup();
    const result = await runDeepSeekTask({ ...task, data: { text: "\u754c".repeat(44_000) } }, dependencies);
    expect(result).toMatchObject({ ok: false, code: "input_too_large" });
    expect(reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts exactly 128 KiB of serialized messages and rejects one byte more", async () => {
    const { dependencies, reserve, fetch } = setup();
    await runDeepSeekTask({ ...task, data: "" }, dependencies);
    const outbound = await fetch.mock.calls[0][0].json();
    const overhead = new TextEncoder().encode(JSON.stringify(outbound.messages)).byteLength;
    const exactData = "a".repeat(128 * 1024 - overhead);
    expect(await runDeepSeekTask({ ...task, data: exactData }, dependencies)).toMatchObject({ ok: true });
    expect(await runDeepSeekTask({ ...task, data: `${exactData}a` }, dependencies))
      .toMatchObject({ ok: false, code: "input_too_large" });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { value: undefined }, { value: Number.NaN }, { value: 1n }])(
    "rejects non-JSON task data before reservation", async (data) => {
      const { dependencies, reserve, fetch } = setup();
      expect(await runDeepSeekTask({ ...task, data }, dependencies))
        .toMatchObject({ ok: false, code: "invalid_input" });
      expect(reserve).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("returns closed reservation denials and failures without fetching", async () => {
    const { dependencies, reserve, fetch } = setup();
    reserve.mockResolvedValueOnce({ ok: false });
    expect(await runDeepSeekTask(task, dependencies)).toMatchObject({ ok: false, code: "reservation_denied" });
    reserve.mockRejectedValueOnce(new Error(SENTINEL));
    const result = await runDeepSeekTask(task, dependencies);
    expect(result).toMatchObject({ ok: false, code: "reservation_failed" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks cancellation before and after the durable reservation", async () => {
    const { dependencies, reserve, fetch } = setup();
    const pre = new AbortController();
    pre.abort(SENTINEL);
    expect(await runDeepSeekTask(task, { ...dependencies, signal: pre.signal }))
      .toMatchObject({ ok: false, code: "cancelled" });
    expect(reserve).not.toHaveBeenCalled();
    const post = new AbortController();
    reserve.mockImplementationOnce(async () => {
      post.abort(SENTINEL);
      return { ok: true };
    });
    expect(await runDeepSeekTask(task, { ...dependencies, signal: post.signal }))
      .toMatchObject({ ok: false, code: "cancelled" });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("DeepSeek closed output and failure handling", () => {
  const now = Date.parse("2030-01-02T03:04:05Z");

  it.each([
    [429, "0", { delayMs: 0 }],
    [429, "2", { delayMs: 2000 }],
    [503, "30", { delayMs: 30_000 }],
    [429, "Wed, 02 Jan 2030 03:04:15 GMT", { delayMs: 10_000 }],
    [429, "Wed, 02 Jan 2030 03:04:04 GMT", { delayMs: 0 }],
    [429, "31", "rate_limited"],
    [503, "Wed, 02 Jan 2030 03:04:36 GMT", "rate_limited"],
    [429, SENTINEL, { delayMs: 1000 }],
    [503, null, { delayMs: 1000 }],
    [401, "2", "not_retryable"],
    [400, "2", "not_retryable"],
  ] as const)("normalizes HTTP %i Retry-After %s without retrying", async (status, header, retryHint) => {
    const { dependencies, reserve, fetch } = setup(() => new Response(SENTINEL, {
      status, headers: header === null ? {} : { "retry-after": header },
    }));
    const result = await runDeepSeekTask(task, { ...dependencies, clock: () => now });
    expect(result).toEqual({
      ok: false,
      code: status === 401 ? "authentication" : status === 429 ? "rate_limit" : "http_failure",
      message: status === 401 ? "Provider authentication was denied."
        : status === 429 ? "The provider rate limit was reached."
        : "The provider returned an unsuccessful HTTP status.",
      status,
      retryHint,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, Infinity, -Infinity, 1.5, 8_640_000_000_000_001])(
    "rejects malformed clock value %s before reservation", async (value) => {
      const { dependencies, reserve, fetch } = setup();
      expect(await runDeepSeekTask(task, { ...dependencies, clock: () => value }))
        .toMatchObject({ ok: false, code: "invalid_input" });
      expect(reserve).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("redacts a throwing clock before reservation", async () => {
    const { dependencies, reserve, fetch } = setup();
    const result = await runDeepSeekTask(task, {
      ...dependencies, clock: () => { throw new Error(SENTINEL); },
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses response-time epoch milliseconds for date hints", async () => {
    const { dependencies, fetch } = setup(() => new Response(null, {
      status: 429, headers: { "retry-after": "Wed, 02 Jan 2030 03:04:15 GMT" },
    }));
    const clock = vi.fn(() => now + 5000).mockReturnValueOnce(now);
    expect(await runDeepSeekTask(task, { ...dependencies, clock }))
      .toMatchObject({ retryHint: { delayMs: 5000 } });
    expect(clock).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("defaults the epoch clock to Date.now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { dependencies, fetch } = setup(() => new Response(null, {
      status: 429, headers: { "retry-after": "Wed, 02 Jan 2030 03:04:15 GMT" },
    }));
    expect(await runDeepSeekTask(task, dependencies))
      .toMatchObject({ retryHint: { delayMs: 10_000 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [401, "authentication"], [403, "authentication"], [429, "rate_limit"],
    [400, "http_failure"], [500, "http_failure"], [302, "http_failure"],
  ] as const)("redacts HTTP %i without a retry", async (status, code) => {
    const { dependencies, fetch } = setup(() => new Response(SENTINEL, {
      status, headers: { "x-secret": SENTINEL },
    }));
    const result = await runDeepSeekTask(task, dependencies);
    expect(result).toMatchObject({ ok: false, code, status });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["length", "incomplete"], ["content_filter", "refused"],
    ["tool_calls", "tool_calls"], ["insufficient_system_resource", "terminal_failure"],
  ] as const)("does not accept finish reason %s", async (reason, code) => {
    const { dependencies } = setup(() => Response.json(envelope(SENTINEL, reason)));
    const result = await runDeepSeekTask(task, dependencies);
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it.each([
    ["", "empty_output"], ["   ", "empty_output"], ["{broken", "malformed_output"],
    ['prefix {"placeId":"supplied-place"} suffix', "malformed_output"],
    ['{"placeId":"invented"}', "schema_failure"],
    ['{"placeId":"supplied-place","extra":"secret"}', "schema_failure"],
  ] as const)("rejects invalid assistant content %s", async (content, code) => {
    const { dependencies } = setup(() => Response.json(envelope(content)));
    expect(await runDeepSeekTask(task, dependencies)).toMatchObject({ ok: false, code });
  });

  it.each([
    { choices: [] },
    { choices: [...envelope().choices, ...envelope().choices] },
    { choices: [{ finish_reason: "stop", message: { role: "user", content: "{}" } }] },
  ])("rejects malformed envelopes", async (body) => {
    const { dependencies } = setup(() => Response.json(body));
    expect(await runDeepSeekTask(task, dependencies)).toMatchObject({ ok: false, code: "malformed_output" });
  });

  it("rejects tool calls even when finish reason is stop", async () => {
    const body = envelope();
    const { dependencies } = setup(() => Response.json({
      ...body,
      choices: [{
        ...body.choices[0],
        message: { ...body.choices[0].message, tool_calls: [{ function: { arguments: SENTINEL } }] },
      }],
    }));
    const result = await runDeepSeekTask(task, dependencies);
    expect(result).toMatchObject({ ok: false, code: "tool_calls" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("omits malformed usage instead of exposing arbitrary provider metadata", async () => {
    const { dependencies } = setup(() => Response.json({
      ...envelope(), usage: { prompt_tokens: -1, completion_tokens: SENTINEL, total_tokens: 20 },
    }));
    expect(await runDeepSeekTask(task, dependencies))
      .toEqual({ ok: true, data: { placeId: "supplied-place" } });
  });

  it("returns fixed schema failure even when custom schema validation throws secrets", async () => {
    const { dependencies } = setup();
    const throwingSchema = z.unknown().transform(() => { throw new Error(SENTINEL); });
    const result = await runDeepSeekTask({ ...task, schema: throwingSchema }, dependencies);
    expect(result).toMatchObject({ ok: false, code: "schema_failure" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("rejects invalid UTF-8, malformed JSON and non-JSON media", async () => {
    for (const response of [
      new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }),
      new Response("{broken", { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "text/html" } }),
    ]) {
      const { dependencies } = setup(() => response);
      expect(await runDeepSeekTask(task, dependencies))
        .toMatchObject({ ok: false, code: "malformed_output" });
    }
  });
});

describe("bounded response consumption and deadline cleanup", () => {
  it("accepts a genuine cross-realm Uint8Array subview", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(envelope()));
    const chunk: Uint8Array = runInNewContext(
      "Uint8Array.from(bytes).subarray(1, bytes.length - 1)",
      { bytes: [0xff, ...encoded, 0xff] },
    );
    expect(chunk instanceof Uint8Array).toBe(false);
    expect(ArrayBuffer.isView(chunk)).toBe(true);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const { dependencies, fetch } = setup(() => new Response(stream, {
      headers: { "content-type": "application/json" },
    }));
    expect(await runDeepSeekTask(task, dependencies)).toEqual({
      ok: true, data: { placeId: "supplied-place" },
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    });
    expect(pulls).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it.each([
    ["string", () => "{}"],
    ["array", () => [123, 125]],
    ["ArrayBuffer", () => new ArrayBuffer(2)],
    ["DataView", () => new DataView(new ArrayBuffer(2))],
    ["Uint16Array", () => new Uint16Array([123, 125])],
    ["Int8Array", () => new Int8Array([123, 125])],
    ["Uint8ClampedArray", () => new Uint8ClampedArray([123, 125])],
    ["spoofed object", () => ({ [Symbol.toStringTag]: "Uint8Array", byteLength: 2 })],
    ["spoofed typed array", () => Object.defineProperty(new Uint16Array([123, 125]),
      Symbol.toStringTag, { value: "Uint8Array" })],
  ] as const)("rejects non-byte chunk %s and cancels the finite stream", async (_name, makeChunk) => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(makeChunk());
        if (pulls >= 2) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const { dependencies } = setup(() => new Response(stream, {
      headers: { "content-type": "application/json" },
    }));
    expect(await runDeepSeekTask(task, dependencies))
      .toMatchObject({ ok: false, code: "malformed_output" });
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("accepts exactly 1 MiB despite a forged large Content-Length", async () => {
    const json = JSON.stringify(envelope());
    const bytes = new TextEncoder().encode(json);
    const body = `${json}${" ".repeat(1024 * 1024 - bytes.byteLength)}`;
    const { dependencies } = setup(() => new Response(body, {
      headers: { "content-type": "application/json", "content-length": "99999999" },
    }));
    expect(await runDeepSeekTask(task, dependencies)).toMatchObject({ ok: true });
  });

  it("cancels oversized bytes without trusting Content-Length or awaiting cancellation cleanup", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(600_000));
        if (pulls === 3) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const { dependencies } = setup(() => new Response(stream, {
      headers: { "content-type": "application/json", "content-length": "2" },
    }));
    expect(await runDeepSeekTask(task, dependencies))
      .toMatchObject({ ok: false, code: "response_too_large" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
    expect(stream.locked).toBe(false);
  });

  it("rejects excessive empty chunks with a finite producer", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array());
        if (pulls === 16_386) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const { dependencies } = setup(() => new Response(stream, { headers: { "content-type": "application/json" } }));
    expect(await runDeepSeekTask(task, dependencies))
      .toMatchObject({ ok: false, code: "response_chunk_limit" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(16_384);
    expect(stream.locked).toBe(false);
  });

  it("enforces a short deadline even when transport ignores its abort signal", async () => {
    vi.useFakeTimers();
    const { dependencies, fetch } = setup();
    fetch.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve(Response.json(envelope())), 100);
    }));
    const pending = runDeepSeekTask(task, { ...dependencies, deadlineMs: 10 });
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(11);
    const metDeadline = settled;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, code: "deadline" });
    expect(metDeadline).toBe(true);
    expect(fetch.mock.calls[0][0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the deadline to a pending body read and releases its lock", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { closeTimer = setTimeout(() => controller.close(), 100); },
      cancel() { cancelled = true; clearTimeout(closeTimer); },
    });
    const { dependencies } = setup(() => new Response(stream, { headers: { "content-type": "application/json" } }));
    const pending = runDeepSeekTask(task, { ...dependencies, deadlineMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, code: "deadline" });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight body read without returning the caller reason", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { closeTimer = setTimeout(() => controller.close(), 100); },
      cancel() { cancelled = true; clearTimeout(closeTimer); },
    });
    const caller = new AbortController();
    const { dependencies } = setup(() => new Response(stream, {
      headers: { "content-type": "application/json" },
    }));
    const pending = runDeepSeekTask(task, { ...dependencies, signal: caller.signal, deadlineMs: 50 });
    setTimeout(() => caller.abort(SENTINEL), 10);
    await vi.advanceTimersByTimeAsync(11);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the caller listener and deadline timer on success", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const { dependencies } = setup();
    expect(await runDeepSeekTask(task, { ...dependencies, signal: caller.signal })).toMatchObject({ ok: true });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("redacts transport exceptions", async () => {
    const { dependencies, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error(SENTINEL));
    const result = await runDeepSeekTask(task, dependencies);
    expect(result).toMatchObject({ ok: false, code: "transport" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
