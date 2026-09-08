import { describe, expect, it } from "vitest";

import {
  credentialCookie,
  errorResponse,
  readCredential,
  readMutationJson,
} from "../src/server/http/security";

const APP_ORIGIN = "https://travel.example";
const CREDENTIAL = "aZ09_-abcdefghijklmnopqrstuvwxyzABCDEFGHIJK";

async function responseFor(action: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    await action();
  } catch (error) {
    const response = errorResponse(error);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    return response;
  }
  throw new Error("Expected action to fail");
}

function mutationRequest(body: BodyInit | null, headers: HeadersInit = {}): Request {
  return new Request(`${APP_ORIGIN}/api/turns`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("HTTP mutation security", () => {
  it("reads streamed JSON only for the exact configured origin", async () => {
    const request = new Request(`${APP_ORIGIN}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"input":"Beijing"}'));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readMutationJson(request, APP_ORIGIN)).resolves.toEqual({
      input: "Beijing",
    });
  });

  it("returns a redacted forbidden response for an origin mismatch", async () => {
    const request = new Request(`${APP_ORIGIN}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });

    let caught: unknown;
    try {
      await readMutationJson(request, APP_ORIGIN);
    } catch (error) {
      caught = error;
    }

    const response = errorResponse(caught);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "invalid_origin",
      message: "Request origin is not allowed.",
    });
  });

  it.each([
    "https://travel.example/",
    "https://travel.example/path",
    "https://travel.example?query=1",
    "https://travel.example#fragment",
    "https://name:secret@travel.example",
    "ftp://travel.example",
  ])("rejects invalid configured origin %s", async (configuredOrigin) => {
    const response = await responseFor(() =>
      readMutationJson(mutationRequest("{}"), configuredOrigin),
    );
    expect(response.status).toBe(403);
  });

  it("rejects cross-site Fetch Metadata and permits absent metadata with exact Origin", async () => {
    const crossSite = await responseFor(() =>
      readMutationJson(mutationRequest("{}", { "sec-fetch-site": "cross-site" }), APP_ORIGIN),
    );
    expect(crossSite.status).toBe(403);
    await expect(readMutationJson(mutationRequest("{}"), APP_ORIGIN)).resolves.toEqual({});
  });

  it.each([null, "null", `${APP_ORIGIN}/`, "http://travel.example",
    `${APP_ORIGIN}:443`, `${APP_ORIGIN}, https://evil.example`])(
    "rejects missing or non-exact request Origin %s", async (origin) => {
      const request = mutationRequest("{}");
      if (origin === null) request.headers.delete("origin");
      else request.headers.set("origin", origin);
      expect((await responseFor(() => readMutationJson(request, APP_ORIGIN))).status).toBe(403);
    },
  );

  it.each([
    ["text/plain", 415, "unsupported_media_type"],
    ["application/json; charset=iso-8859-1", 415, "unsupported_media_type"],
    ["application/json; charset=utf-8; charset=utf-8", 415, "unsupported_media_type"],
    ["application/json; extra=value", 415, "unsupported_media_type"],
    ["application/json, text/plain", 415, "unsupported_media_type"],
  ])("rejects unsupported content type %s", async (contentType, status, code) => {
    const response = await responseFor(() =>
      readMutationJson(mutationRequest("{}", { "content-type": contentType }), APP_ORIGIN),
    );
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
  });

  it("accepts optional UTF-8 charset and rejects encoded bodies", async () => {
    await expect(
      readMutationJson(
        mutationRequest("{}", { "content-type": "Application/JSON; Charset=UTF-8" }),
        APP_ORIGIN,
      ),
    ).resolves.toEqual({});
    const response = await responseFor(() =>
      readMutationJson(mutationRequest("{}", { "content-encoding": "gzip" }), APP_ORIGIN),
    );
    expect(response.status).toBe(415);
    expect((await response.json()).code).toBe("unsupported_encoding");
  });

  it("enforces 65536 actual bytes without trusting Content-Length", async () => {
    const exact = `{"value":"${"a".repeat(65_524)}"}`;
    await expect(
      readMutationJson(mutationRequest(exact, { "content-length": "999999" }), APP_ORIGIN),
    ).resolves.toEqual({ value: "a".repeat(65_524) });

    const forgedSmall = mutationRequest(`{"value":"${"界".repeat(22_000)}"}`, {
      "content-length": "2",
    });
    const response = await responseFor(() => readMutationJson(forgedSmall, APP_ORIGIN));
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("body_too_large");
  });

  it("cancels the request reader as soon as streamed bytes overflow", async () => {
    let cancelled = false;
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount >= 3) {
          controller.close();
          return;
        }
        pullCount += 1;
        controller.enqueue(new Uint8Array(40_000));
        if (pullCount === 3) {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const response = await responseFor(() =>
      readMutationJson(mutationRequest(stream), APP_ORIGIN),
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pullCount).toBeLessThanOrEqual(2);
  });

  it("rejects one byte over the limit with no Content-Length", async () => {
    const response = await responseFor(() =>
      readMutationJson(mutationRequest(`{"value":"${"a".repeat(65_525)}"}`), APP_ORIGIN),
    );
    expect(response.status).toBe(413);
  });

  it("rejects missing bodies and redacts finite stream failures", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`secret=${CREDENTIAL}`));
      },
    });
    for (const body of [null, stream]) {
      const response = await responseFor(() =>
        readMutationJson(mutationRequest(body), APP_ORIGIN),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "malformed_input",
        message: "Malformed input.",
      });
    }
  });

  it("rejects a missing JSON content type", async () => {
    const request = mutationRequest("{}");
    request.headers.delete("content-type");
    expect((await responseFor(() => readMutationJson(request, APP_ORIGIN))).status).toBe(415);
  });

  it("rejects malformed UTF-8 and malformed JSON as bad requests", async () => {
    const malformedUtf8 = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]);
    for (const body of [malformedUtf8, "{not-json}"]) {
      const response = await responseFor(() =>
        readMutationJson(mutationRequest(body), APP_ORIGIN),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("malformed_input");
    }
  });

  it("decodes a multibyte character split across finite stream chunks", async () => {
    const bytes = new TextEncoder().encode('{"value":"\u754c"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 11));
        controller.enqueue(bytes.slice(11));
        controller.close();
      },
    });
    await expect(readMutationJson(mutationRequest(stream), APP_ORIGIN))
      .resolves.toEqual({ value: "\u754c" });
  });

  it("handles deeply nested JSON without recursive stack exhaustion", async () => {
    const prefix = '{"nested":'.repeat(5_000);
    const suffix = "}".repeat(5_000);
    await expect(readMutationJson(mutationRequest(`${prefix}{}${suffix}`), APP_ORIGIN))
      .resolves.toBeTypeOf("object");
    const response = await responseFor(() =>
      readMutationJson(mutationRequest(`${prefix}{"owner":"forged"}${suffix}`), APP_ORIGIN),
    );
    expect(response.status).toBe(400);
  });

  it.each([
    "null",
    "true",
    "42",
    '"text"',
    "[]",
    '{"owner":"forged"}',
    '{"nested":{"ownerId":"forged"}}',
    '{"items":[{"owner_id":"forged"}]}',
    '{"nested":{"\\u006fwner":"forged"}}',
  ])("rejects non-object JSON and recursively forged ownership: %s", async (body) => {
    const response = await responseFor(() =>
      readMutationJson(mutationRequest(body), APP_ORIGIN),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("malformed_input");
  });
});

describe("opaque Owner credential cookie", () => {
  it("distinguishes an absent credential from a valid opaque credential", () => {
    expect(readCredential(new Request(APP_ORIGIN))).toBeNull();
    expect(
      readCredential(new Request(APP_ORIGIN, { headers: { cookie: `other=x; travel_owner=${CREDENTIAL}` } })),
    ).toBe(CREDENTIAL);
  });

  it.each([
    "travel_owner=short",
    "travel_owner",
    "travel_owner=",
    `travel_owner="${CREDENTIAL}"`,
    `travel_owner=%61${CREDENTIAL.slice(1)}`,
    `travel_owner=${CREDENTIAL.slice(1)}`,
    `travel_owner=${CREDENTIAL}a`,
    `travel_owner=${CREDENTIAL}=`,
    `travel_owner=${CREDENTIAL}; travel_owner=${CREDENTIAL}`,
    `travel_owner=${CREDENTIAL}; travel_owner=short`,
  ])("rejects invalid or duplicate credential cookies: %s", async (cookie) => {
    const response = await responseFor(() =>
      readCredential(new Request(APP_ORIGIN, { headers: { cookie } })),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("invalid_credential");
  });

  it("serializes a host-only hardened cookie with the supplied expiration", () => {
    expect(credentialCookie(CREDENTIAL, new Date("2030-01-02T03:04:05.000Z"))).toBe(
      `travel_owner=${CREDENTIAL}; Path=/; Expires=Wed, 02 Jan 2030 03:04:05 GMT; HttpOnly; Secure; SameSite=Strict`,
    );
  });

  it("rejects credential and expiration values that could produce unsafe headers", async () => {
    for (const action of [
      () => credentialCookie(`${CREDENTIAL}\r\nX-Leak: yes`, new Date("2030-01-02T03:04:05Z")),
      () => credentialCookie(`${CREDENTIAL}\n`, new Date("2030-01-02T03:04:05Z")),
      () => credentialCookie(CREDENTIAL, new Date(Number.NaN)),
    ]) {
      const response = await responseFor(action);
      expect(response.status).toBe(400);
    }
  });
});

describe("HTTP security errors", () => {
  it("does not trust a caller-supplied error code", async () => {
    const response = errorResponse({ code: "invalid_origin", message: CREDENTIAL });
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "internal_error",
      message: "An internal error occurred.",
    });
  });
  it("redacts arbitrary secret-bearing errors as a fixed no-store internal error", async () => {
    const response = errorResponse(new Error(`credential=${CREDENTIAL}`));
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toBe('{"code":"internal_error","message":"An internal error occurred."}');
    expect(text).not.toContain(CREDENTIAL);
  });
});
