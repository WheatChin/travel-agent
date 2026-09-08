const ERROR_DEFINITIONS = {
  invalid_origin: [403, "Request origin is not allowed."],
  invalid_credential: [401, "Invalid credential."],
  malformed_input: [400, "Malformed input."],
  unsupported_media_type: [415, "Unsupported media type."],
  unsupported_encoding: [415, "Unsupported content encoding."],
  body_too_large: [413, "Request body is too large."],
  internal_error: [500, "An internal error occurred."],
} as const;

type ErrorCode = keyof typeof ERROR_DEFINITIONS;
const MAX_BODY_BYTES = 65_536;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_NAME = "travel_owner";

class HttpSecurityError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

function requireOrigin(request: Request, appOrigin: string): void {
  let configured: URL;
  try {
    configured = new URL(appOrigin);
  } catch {
    throw new HttpSecurityError("invalid_origin");
  }
  if (
    (configured.protocol !== "http:" && configured.protocol !== "https:") ||
    configured.origin !== appOrigin ||
    request.headers.get("origin") !== appOrigin ||
    request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site"
  ) {
    throw new HttpSecurityError("invalid_origin");
  }
}

async function readBody(request: Request): Promise<Uint8Array> {
  if (!request.body || request.bodyUsed || request.body.locked) {
    throw new HttpSecurityError("malformed_input");
  }
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, length);
      if (value.byteLength > MAX_BODY_BYTES - length) {
        // Cancellation cleanup must not delay the rejection or replace its code.
        void reader.cancel().catch(() => {});
        throw new HttpSecurityError("body_too_large");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch (error) {
    if (error instanceof HttpSecurityError) throw error;
    throw new HttpSecurityError("malformed_input");
  } finally {
    reader.releaseLock();
  }
}

function rejectOwnershipFields(root: Record<string, unknown>): void {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "owner" || key === "ownerId" || key === "owner_id") {
        throw new HttpSecurityError("malformed_input");
      }
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
}

export async function readMutationJson(
  request: Request,
  appOrigin: string,
): Promise<Record<string, unknown>> {
  requireOrigin(request, appOrigin);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/i.test(contentType)) {
    throw new HttpSecurityError("unsupported_media_type");
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    throw new HttpSecurityError("unsupported_encoding");
  }
  const bytes = await readBody(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpSecurityError("malformed_input");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpSecurityError("malformed_input");
  }
  const object = parsed as Record<string, unknown>;
  rejectOwnershipFields(object);
  return object;
}

export function errorResponse(error: unknown): Response {
  const code = error instanceof HttpSecurityError ? error.code : "internal_error";
  const [status, message] = ERROR_DEFINITIONS[code];
  return Response.json(
    { code, message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function readCredential(request: Request): string | null {
  let credential: string | null = null;
  for (const entry of (request.headers.get("cookie") ?? "").split(";")) {
    const part = entry.trimStart();
    const separator = part.indexOf("=");
    const name = (separator < 0 ? part : part.slice(0, separator)).trim();
    if (name !== COOKIE_NAME) continue;
    const value = separator < 0 ? "" : part.slice(separator + 1);
    if (credential !== null || value.length !== 43 || !CREDENTIAL_PATTERN.test(value)) {
      throw new HttpSecurityError("invalid_credential");
    }
    credential = value;
  }
  return credential;
}

export function credentialCookie(credential: string, expiresAt: Date): string {
  if (
    typeof credential !== "string" ||
    credential.length !== 43 ||
    !CREDENTIAL_PATTERN.test(credential) ||
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getUTCFullYear() < 1601 ||
    expiresAt.getUTCFullYear() > 9999
  ) {
    throw new HttpSecurityError("malformed_input");
  }
  return `${COOKIE_NAME}=${credential}; Path=/; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}
