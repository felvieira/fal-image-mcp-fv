import { describe, it, expect } from "vitest";
import { assertValidEndpoint, safeErrBody, extractImageUrls } from "@/lib/fal";
import type { FalSubscribeResult } from "@/lib/fal";

// ---------------------------------------------------------------------------
// assertValidEndpoint
// ---------------------------------------------------------------------------
describe("assertValidEndpoint — valid endpoints", () => {
  const valid = [
    "fal-ai/flux/dev",
    "xai/grok-imagine-image",
    "openai/gpt-image-2",
    "fal-ai/gpt-image-1.5/edit",
    "fal-ai/flux-2/flash",
    "fal-ai/nano-banana/edit",
    "fal-ai/gpt-image-1/text-to-image",
  ];

  it.each(valid)("accepts %s", (endpoint) => {
    expect(() => assertValidEndpoint(endpoint)).not.toThrow();
  });
});

describe("assertValidEndpoint — invalid endpoints", () => {
  it("rejects empty string", () => {
    expect(() => assertValidEndpoint("")).toThrow();
  });

  it("rejects path traversal with ..", () => {
    expect(() => assertValidEndpoint("../etc/passwd")).toThrow();
  });

  it("rejects absolute URL with https://", () => {
    expect(() => assertValidEndpoint("https://evil.com/x")).toThrow();
  });

  it("rejects URL with other scheme ://", () => {
    expect(() => assertValidEndpoint("ftp://host/path")).toThrow();
  });

  it("rejects path starting with /", () => {
    expect(() => assertValidEndpoint("/leading-slash")).toThrow();
  });

  it("rejects string with space", () => {
    expect(() => assertValidEndpoint("has space")).toThrow();
  });

  it("rejects string with semicolon", () => {
    expect(() => assertValidEndpoint("semi;colon")).toThrow();
  });

  it("rejects string with @", () => {
    expect(() => assertValidEndpoint("user@host/path")).toThrow();
  });

  it("rejects string with #", () => {
    expect(() => assertValidEndpoint("fal-ai/flux#fragment")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// safeErrBody
// ---------------------------------------------------------------------------
describe("safeErrBody — token redaction", () => {
  it("redacts Key token", () => {
    const result = safeErrBody("Authorization failed: Key abc123def456");
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("abc123def456");
  });

  it("redacts Bearer token", () => {
    const result = safeErrBody("Auth error: Bearer xyz.123-foo");
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("xyz.123-foo");
  });

  it("redacts Bearer token with dots and hyphens", () => {
    const result = safeErrBody("token=Bearer eyJhbGc.eyJzdWI.SflKxwRJSMeKKF2QT4fwpM");
    expect(result).toContain("[redacted]");
    expect(result).not.toMatch(/eyJhbGc/);
  });

  it("does not alter clean text", () => {
    const result = safeErrBody("Internal server error: model not found");
    expect(result).toBe("Internal server error: model not found");
  });
});

describe("safeErrBody — truncation", () => {
  it("truncates a 1000-char string to at most ~505 chars (500 + ellipsis)", () => {
    const long = "x".repeat(1000);
    const result = safeErrBody(long);
    // 500 chars of content + "…" (1 char) = 501 max
    expect(result.length).toBeLessThanOrEqual(505);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not truncate a 499-char string", () => {
    const short = "a".repeat(499);
    const result = safeErrBody(short);
    expect(result).toBe(short);
    expect(result.endsWith("…")).toBe(false);
  });

  it("returns empty string for empty input", () => {
    expect(safeErrBody("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractImageUrls
// ---------------------------------------------------------------------------
describe("extractImageUrls", () => {
  it("extracts urls from images array", () => {
    const data: FalSubscribeResult = {
      images: [{ url: "https://cdn.fal.ai/a.jpg" }, { url: "https://cdn.fal.ai/b.jpg" }],
    };
    expect(extractImageUrls(data)).toEqual([
      "https://cdn.fal.ai/a.jpg",
      "https://cdn.fal.ai/b.jpg",
    ]);
  });

  it("extracts url from single image object", () => {
    const data: FalSubscribeResult = {
      image: { url: "https://cdn.fal.ai/c.jpg" },
    };
    expect(extractImageUrls(data)).toEqual(["https://cdn.fal.ai/c.jpg"]);
  });

  it("extracts urls from output_images array", () => {
    const data: FalSubscribeResult = {
      output_images: ["https://cdn.fal.ai/d.jpg", "https://cdn.fal.ai/e.jpg"],
    };
    expect(extractImageUrls(data)).toEqual([
      "https://cdn.fal.ai/d.jpg",
      "https://cdn.fal.ai/e.jpg",
    ]);
  });

  it("returns [] for an unknown top-level url field (no heuristic fallback)", () => {
    // A field like `request.url` should NOT be returned — the source
    // intentionally removed the blind heuristic fallback.
    const data: FalSubscribeResult = {
      foo: { url: "should-not-be-grabbed" },
    } as FalSubscribeResult;
    expect(extractImageUrls(data)).toEqual([]);
  });

  it("returns [] for empty object", () => {
    expect(extractImageUrls({} as FalSubscribeResult)).toEqual([]);
  });

  it("prefers images array over image object when both present", () => {
    const data: FalSubscribeResult = {
      images: [{ url: "https://cdn.fal.ai/a.jpg" }],
      image: { url: "https://cdn.fal.ai/c.jpg" },
    };
    expect(extractImageUrls(data)).toEqual(["https://cdn.fal.ai/a.jpg"]);
  });

  it("filters falsy urls from images array", () => {
    const data: FalSubscribeResult = {
      images: [{ url: "https://cdn.fal.ai/a.jpg" }, { url: "" }],
    };
    const result = extractImageUrls(data);
    expect(result).toEqual(["https://cdn.fal.ai/a.jpg"]);
    expect(result).toHaveLength(1);
  });
});
