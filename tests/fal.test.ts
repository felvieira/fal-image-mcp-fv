import { describe, it, expect } from "vitest";
import { assertValidEndpoint, safeErrBody, extractImageUrls, isImageAlreadyTransparent } from "@/lib/fal";
import type { FalSubscribeResult } from "@/lib/fal";

// Helpers para montar data URIs de teste com headers reais (sem libs de imagem)
function dataUri(mime: string, bytes: number[]): string {
  const bin = String.fromCharCode(...bytes);
  // btoa existe no runtime do vitest (node 18+/jsdom)
  return `data:${mime};base64,${btoa(bin)}`;
}
// PNG sig + IHDR (len=13, "IHDR", w=1, h=1, bitDepth=8, colorType=N)
function pngHeader(colorType: number): number[] {
  return [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // sig
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // len=13 "IHDR"
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // w=1 h=1
    0x08, colorType, 0x00, 0x00, 0x00,              // bitDepth=8, colorType, comp/filter/interlace
  ];
}

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

// ---------------------------------------------------------------------------
// isImageAlreadyTransparent — header-level detection via data URIs (no network)
// ---------------------------------------------------------------------------
describe("isImageAlreadyTransparent — data URI header detection", () => {
  it("returns true for PNG with RGBA color type (6)", async () => {
    const uri = dataUri("image/png", pngHeader(6));
    expect(await isImageAlreadyTransparent(uri)).toBe(true);
  });

  it("returns true for PNG with grayscale+alpha color type (4)", async () => {
    const uri = dataUri("image/png", pngHeader(4));
    expect(await isImageAlreadyTransparent(uri)).toBe(true);
  });

  it("returns false for PNG with RGB color type (2, no alpha)", async () => {
    const uri = dataUri("image/png", pngHeader(2));
    expect(await isImageAlreadyTransparent(uri)).toBe(false);
  });

  it("returns true for indexed PNG that carries a tRNS chunk", async () => {
    // colorType=3 (indexed) + a tRNS chunk somewhere in the buffer
    const bytes = [...pngHeader(3), 0x00, 0x00, 0x00, 0x01, 0x74, 0x52, 0x4e, 0x53, 0xff];
    expect(await isImageAlreadyTransparent(dataUri("image/png", bytes))).toBe(true);
  });

  it("returns false for JPEG (never has alpha)", async () => {
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0, 0, 0, 0, 0];
    expect(await isImageAlreadyTransparent(dataUri("image/jpeg", bytes))).toBe(false);
  });

  it("returns null for an unrecognised / too-short buffer", async () => {
    expect(await isImageAlreadyTransparent(dataUri("application/octet-stream", [1, 2, 3]))).toBeNull();
  });

  it("returns null for a malformed data URI", async () => {
    expect(await isImageAlreadyTransparent("data:image/png;base64,!!!notbase64!!!")).toBeNull();
  });
});
