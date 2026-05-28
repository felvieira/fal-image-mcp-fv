import { createHash, timingSafeEqual } from "crypto";

// ============================================================
// Auth module — hardened Bearer token verification
//
// Security properties:
//   1. Fail-closed: missing MCP_BEARER_TOKEN → 503, never silently open
//   2. Constant-time compare: both tokens are SHA-256 hashed before
//      timingSafeEqual, so the 32-byte digests are always the same length
//      regardless of the actual token length — no length side-channel.
// ============================================================

let _warnedNoAuth = false;

/** Structured error that carries an HTTP status code so callers can map it. */
export class AuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/** SHA-256 digest of a string as a Buffer (32 bytes, fixed length). */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Validates the Authorization: Bearer <token> header on a request.
 *
 * Throws AuthError on any failure — callers should never silently swallow it.
 *
 * Fail-closed rules:
 *   - MCP_BEARER_TOKEN unset/empty AND MCP_ALLOW_NO_AUTH !== "true"  → 503
 *   - MCP_BEARER_TOKEN unset/empty AND MCP_ALLOW_NO_AUTH === "true"  → allow (dev escape hatch, warns once)
 *   - Missing/malformed Authorization header                          → 401
 *   - Token mismatch (constant-time sha256 compare)                  → 401
 */
export function checkAuth(req: Request): void {
  const expected = process.env.MCP_BEARER_TOKEN;

  if (!expected) {
    // Explicit dev escape hatch — must be set to the exact string "true"
    if (process.env.MCP_ALLOW_NO_AUTH === "true") {
      if (!_warnedNoAuth) {
        console.warn(
          "[auth] WARNING: MCP_BEARER_TOKEN is not set and MCP_ALLOW_NO_AUTH=true. " +
            "The server is running WITHOUT authentication. Never use this in production."
        );
        _warnedNoAuth = true;
      }
      return;
    }

    // Fail-closed: misconfigured server must not expose itself
    throw new AuthError(
      "Server misconfigured: MCP_BEARER_TOKEN not set",
      503
    );
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or malformed Authorization header", 401);
  }

  const provided = authHeader.slice("Bearer ".length).trim();

  // Constant-time comparison via SHA-256 digests.
  // Both sides are hashed to a fixed 32-byte buffer before timingSafeEqual,
  // which means:
  //   (a) timingSafeEqual never throws due to length mismatch, and
  //   (b) the comparison time does not reveal the actual token length.
  const expectedDigest = digest(expected);
  const providedDigest = digest(provided);

  if (!timingSafeEqual(expectedDigest, providedDigest)) {
    throw new AuthError("Invalid token", 401);
  }
}

/**
 * Wraps an HTTP handler with auth enforcement.
 *
 * Returns a JSON error response on AuthError (with the correct HTTP status),
 * or a generic 500 on unexpected errors (internals are never leaked).
 * On success, delegates to `fn`.
 */
export async function withAuth(
  req: Request,
  fn: () => Promise<Response>
): Promise<Response> {
  try {
    checkAuth(req);
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Unexpected error — don't leak internals
    console.error("[auth] Unexpected error during auth check:", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return fn();
}
