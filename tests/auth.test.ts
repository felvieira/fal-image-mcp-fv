import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkAuth, AuthError } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/mcp", { headers });
}

// ---------------------------------------------------------------------------
// Env save/restore — critical to avoid test bleed
// ---------------------------------------------------------------------------

let savedToken: string | undefined;
let savedAllowNoAuth: string | undefined;

beforeEach(() => {
  savedToken = process.env.MCP_BEARER_TOKEN;
  savedAllowNoAuth = process.env.MCP_ALLOW_NO_AUTH;
  // Start clean
  delete process.env.MCP_BEARER_TOKEN;
  delete process.env.MCP_ALLOW_NO_AUTH;
});

afterEach(() => {
  // Restore original values
  if (savedToken === undefined) {
    delete process.env.MCP_BEARER_TOKEN;
  } else {
    process.env.MCP_BEARER_TOKEN = savedToken;
  }
  if (savedAllowNoAuth === undefined) {
    delete process.env.MCP_ALLOW_NO_AUTH;
  } else {
    process.env.MCP_ALLOW_NO_AUTH = savedAllowNoAuth;
  }
});

// ---------------------------------------------------------------------------
// 1. Fail-closed: token unset + no escape hatch → 503
// ---------------------------------------------------------------------------
describe("checkAuth — fail-closed (no token, no escape hatch)", () => {
  it("throws AuthError with status 503 when MCP_BEARER_TOKEN is unset", () => {
    const req = makeRequest();
    expect(() => checkAuth(req)).toThrowError(AuthError);
    try {
      checkAuth(req);
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(503);
    }
  });

  it("throws even with a valid-looking Authorization header when token is unset", () => {
    const req = makeRequest({ Authorization: "Bearer sometoken" });
    expect(() => checkAuth(req)).toThrowError(AuthError);
    try {
      checkAuth(req);
    } catch (e) {
      expect((e as AuthError).status).toBe(503);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Dev escape hatch: token unset + MCP_ALLOW_NO_AUTH=true → pass through
// ---------------------------------------------------------------------------
describe("checkAuth — dev escape hatch", () => {
  it("does NOT throw when MCP_ALLOW_NO_AUTH=true and token is unset", () => {
    process.env.MCP_ALLOW_NO_AUTH = "true";
    const req = makeRequest();
    expect(() => checkAuth(req)).not.toThrow();
  });

  it("still throws when MCP_ALLOW_NO_AUTH='1' (not exactly 'true')", () => {
    process.env.MCP_ALLOW_NO_AUTH = "1";
    const req = makeRequest();
    expect(() => checkAuth(req)).toThrowError(AuthError);
  });

  it("still throws when MCP_ALLOW_NO_AUTH='TRUE' (case-sensitive)", () => {
    process.env.MCP_ALLOW_NO_AUTH = "TRUE";
    const req = makeRequest();
    expect(() => checkAuth(req)).toThrowError(AuthError);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing header → 401
// ---------------------------------------------------------------------------
describe("checkAuth — missing Authorization header", () => {
  it("throws AuthError 401 when no Authorization header is present", () => {
    process.env.MCP_BEARER_TOKEN = "supersecret";
    const req = makeRequest();
    try {
      checkAuth(req);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed header → 401
// ---------------------------------------------------------------------------
describe("checkAuth — malformed Authorization header", () => {
  it("throws 401 for 'Basic foo' scheme", () => {
    process.env.MCP_BEARER_TOKEN = "supersecret";
    const req = makeRequest({ Authorization: "Basic foo" });
    try {
      checkAuth(req);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(401);
    }
  });

  it("throws 401 for 'Token foo' scheme", () => {
    process.env.MCP_BEARER_TOKEN = "supersecret";
    const req = makeRequest({ Authorization: "Token foo" });
    try {
      checkAuth(req);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
    }
  });

  it("throws 401 when Authorization header is just 'Bearer' with no token", () => {
    process.env.MCP_BEARER_TOKEN = "supersecret";
    // "Bearer " with trailing space and no value → trim() → empty string
    const req = makeRequest({ Authorization: "Bearer " });
    try {
      checkAuth(req);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Wrong token → 401
// ---------------------------------------------------------------------------
describe("checkAuth — wrong token", () => {
  it("throws AuthError 401 for a completely different token", () => {
    process.env.MCP_BEARER_TOKEN = "correct-token";
    const req = makeRequest({ Authorization: "Bearer wrong-token" });
    try {
      checkAuth(req);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(401);
    }
  });

  it("throws 401 for a shorter wrong token (no length side-channel assertion — just correctness)", () => {
    process.env.MCP_BEARER_TOKEN = "correct-token";
    const req = makeRequest({ Authorization: "Bearer x" });
    try {
      checkAuth(req);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
    }
  });

  it("throws 401 for a longer wrong token", () => {
    process.env.MCP_BEARER_TOKEN = "correct-token";
    const req = makeRequest({ Authorization: "Bearer " + "x".repeat(100) });
    try {
      checkAuth(req);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Correct token → no throw
// ---------------------------------------------------------------------------
describe("checkAuth — correct token", () => {
  it("does NOT throw when Bearer token matches MCP_BEARER_TOKEN", () => {
    process.env.MCP_BEARER_TOKEN = "my-valid-token-123";
    const req = makeRequest({ Authorization: "Bearer my-valid-token-123" });
    expect(() => checkAuth(req)).not.toThrow();
  });

  it("does NOT throw for a token with special URL-safe chars", () => {
    const token = "tok_1234567890abcdef-ABCDEF.xyzXYZ";
    process.env.MCP_BEARER_TOKEN = token;
    const req = makeRequest({ Authorization: `Bearer ${token}` });
    expect(() => checkAuth(req)).not.toThrow();
  });

  it("trims trailing whitespace from provided token and still matches", () => {
    // The source does `.trim()` on the extracted token
    process.env.MCP_BEARER_TOKEN = "trimmed-token";
    const req = makeRequest({ Authorization: "Bearer trimmed-token   " });
    expect(() => checkAuth(req)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. AuthError class shape
// ---------------------------------------------------------------------------
describe("AuthError", () => {
  it("has name 'AuthError'", () => {
    const e = new AuthError("msg", 401);
    expect(e.name).toBe("AuthError");
  });

  it("is an instance of Error", () => {
    const e = new AuthError("msg", 401);
    expect(e).toBeInstanceOf(Error);
  });

  it("defaults status to 401", () => {
    const e = new AuthError("msg");
    expect(e.status).toBe(401);
  });

  it("stores custom status", () => {
    const e = new AuthError("msg", 503);
    expect(e.status).toBe(503);
  });
});
