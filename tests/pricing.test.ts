import { describe, it, expect, afterEach } from "vitest";
import { calculateCost, SessionTracker, getTracker, type CostInput, type CostResult } from "@/lib/pricing";
import type { FavoriteModel } from "@/lib/models";
import modelsJson from "@/models.json";

// ---------------------------------------------------------------------------
// Fixtures — cast from the real models.json so tests track reality
// ---------------------------------------------------------------------------
const models = modelsJson.models as unknown as Record<string, FavoriteModel>;

const gemini25Flash = models["gemini-25-flash"];   // flat $0.039
const gptImage2     = models["gpt-image-2"];       // complex table, t2i only
const gptImage1Mini = models["gpt-image-1-mini"];  // complex table with _1024 / _other keys
const flux2Flash    = models["flux-2-flash"];       // per-megapixel
const grokImagine   = models["grok-imagine"];       // flat t2i + edit
const pixelcutBg    = models["pixelcut-bg-remove"];  // flat bg_remove $0.016

// ---------------------------------------------------------------------------
// 1. Fixed (flat) pricing — gemini-25-flash
// ---------------------------------------------------------------------------
describe("calculateCost — fixed pricing (gemini-25-flash)", () => {
  it("returns correct per_image_usd and total for 1 image", () => {
    const result = calculateCost({
      model: gemini25Flash,
      mode: "t2i",
      num_images: 1,
    });
    expect(result.per_image_usd).toBeCloseTo(0.039, 6);
    expect(result.total_usd).toBeCloseTo(0.039, 6);
    expect(result.pricing_key).toBe("fixed");
  });

  it("scales total_usd linearly for 3 images", () => {
    const result = calculateCost({
      model: gemini25Flash,
      mode: "t2i",
      num_images: 3,
    });
    expect(result.per_image_usd).toBeCloseTo(0.039, 6);
    expect(result.total_usd).toBeCloseTo(0.039 * 3, 6);
    expect(result.pricing_key).toBe("fixed");
  });

  it("edit mode also uses flat $0.039", () => {
    const result = calculateCost({
      model: gemini25Flash,
      mode: "edit",
      num_images: 2,
    });
    expect(result.per_image_usd).toBeCloseTo(0.039, 6);
    expect(result.total_usd).toBeCloseTo(0.039 * 2, 6);
    expect(result.pricing_key).toBe("fixed");
  });
});

// ---------------------------------------------------------------------------
// 2. Complex table — exact match: gpt-image-2 high + 1024x1024 → high_1024x1024 = 0.211
// ---------------------------------------------------------------------------
describe("calculateCost — complex table exact match (gpt-image-2)", () => {
  it("resolves high_1024x1024 = $0.211", () => {
    const result = calculateCost({
      model: gptImage2,
      mode: "t2i",
      num_images: 1,
      quality: "high",
      image_size: "1024x1024",
    });
    expect(result.per_image_usd).toBeCloseTo(0.211, 6);
    expect(result.total_usd).toBeCloseTo(0.211, 6);
    expect(result.pricing_key).toBe("high_1024x1024");
  });

  it("resolves medium_1024x1024 = $0.053", () => {
    const result = calculateCost({
      model: gptImage2,
      mode: "t2i",
      num_images: 2,
      quality: "medium",
      image_size: "1024x1024",
    });
    expect(result.per_image_usd).toBeCloseTo(0.053, 6);
    expect(result.total_usd).toBeCloseTo(0.053 * 2, 6);
    expect(result.pricing_key).toBe("medium_1024x1024");
  });

  it("resolves low_3840x2160 = $0.012", () => {
    const result = calculateCost({
      model: gptImage2,
      mode: "t2i",
      num_images: 1,
      quality: "low",
      image_size: "3840x2160",
    });
    expect(result.per_image_usd).toBeCloseTo(0.012, 6);
    expect(result.pricing_key).toBe("low_3840x2160");
  });
});

// ---------------------------------------------------------------------------
// 3. Complex table — {quality}_1024 fallback
//    gpt-image-1-mini has `high_1024` but NOT `high_1024x1024`
//    so size="1024x1024" must fall through to the _1024 key.
// ---------------------------------------------------------------------------
describe("calculateCost — {quality}_1024 fallback (gpt-image-1-mini)", () => {
  it("resolves high_1024 = $0.036 when size is 1024x1024", () => {
    const result = calculateCost({
      model: gptImage1Mini,
      mode: "t2i",
      num_images: 1,
      quality: "high",
      image_size: "1024x1024",
    });
    expect(result.per_image_usd).toBeCloseTo(0.036, 6);
    expect(result.pricing_key).toBe("high_1024");
  });

  it("resolves medium_1024 = $0.011 when size is 1024x1024", () => {
    const result = calculateCost({
      model: gptImage1Mini,
      mode: "t2i",
      num_images: 1,
      quality: "medium",
      image_size: "1024x1024",
    });
    expect(result.per_image_usd).toBeCloseTo(0.011, 6);
    expect(result.pricing_key).toBe("medium_1024");
  });
});

// ---------------------------------------------------------------------------
// 4. Complex table — {quality}_other fallback
//    gpt-image-1-mini high + non-1024 size → high_other = $0.052
// ---------------------------------------------------------------------------
describe("calculateCost — {quality}_other fallback (gpt-image-1-mini)", () => {
  it("resolves high_other = $0.052 for 1536x1024", () => {
    const result = calculateCost({
      model: gptImage1Mini,
      mode: "t2i",
      num_images: 1,
      quality: "high",
      image_size: "1536x1024",
    });
    expect(result.per_image_usd).toBeCloseTo(0.052, 6);
    expect(result.pricing_key).toBe("high_other");
  });

  it("resolves low_other = $0.006 for 1024x1536", () => {
    const result = calculateCost({
      model: gptImage1Mini,
      mode: "t2i",
      num_images: 1,
      quality: "low",
      image_size: "1024x1536",
    });
    expect(result.per_image_usd).toBeCloseTo(0.006, 6);
    expect(result.pricing_key).toBe("low_other");
  });
});

// ---------------------------------------------------------------------------
// 5. Complex table — startsWith fallback then unknown → price 0
//    Use a quality that has NO matching key in the table at all.
// ---------------------------------------------------------------------------
describe("calculateCost — unknown quality → pricing_key 'unknown'", () => {
  it("returns price 0 and key 'unknown' for unrecognised quality", () => {
    const result = calculateCost({
      model: gptImage1Mini,
      mode: "t2i",
      num_images: 1,
      quality: "ultra",   // no 'ultra_*' keys in the table
      image_size: "1024x1024",
    });
    expect(result.per_image_usd).toBe(0);
    expect(result.total_usd).toBe(0);
    expect(result.pricing_key).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 6. Missing mode pricing — gpt-image-2 has no edit pricing
// ---------------------------------------------------------------------------
describe("calculateCost — missing pricing for mode", () => {
  it("returns pricing_key 'missing' and total 0 for gpt-image-2 edit mode", () => {
    const result = calculateCost({
      model: gptImage2,
      mode: "edit",
      num_images: 2,
    });
    expect(result.per_image_usd).toBe(0);
    expect(result.total_usd).toBe(0);
    expect(result.pricing_key).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// 7. Default quality/size behaviour
//    resolveComplexPrice defaults to quality="medium", size="1024x1024"
//    gpt-image-1-mini medium + 1024x1024 → medium_1024 = $0.011
// ---------------------------------------------------------------------------
describe("calculateCost — default quality and size", () => {
  it("defaults to quality=medium, size=1024x1024 when omitted", () => {
    const result = calculateCost({
      model: gptImage1Mini,
      mode: "t2i",
      num_images: 1,
      // quality and image_size intentionally omitted
    });
    expect(result.per_image_usd).toBeCloseTo(0.011, 6);
    expect(result.pricing_key).toBe("medium_1024");
  });
});

// ---------------------------------------------------------------------------
// 8. Per-megapixel pricing — flux-2-flash
// ---------------------------------------------------------------------------
describe("calculateCost — per-megapixel pricing (flux-2-flash)", () => {
  it("computes cost for 1024x1024 at $0.005/MP", () => {
    const result = calculateCost({
      model: flux2Flash,
      mode: "t2i",
      num_images: 1,
      width: 1024,
      height: 1024,
    });
    // 1024*1024 / 1_000_000 = 1.048576 MP  =>  0.005 * 1.048576 ≈ 0.00524288
    const expectedPerImage = 0.005 * (1024 * 1024) / 1_000_000;
    expect(result.per_image_usd).toBeCloseTo(expectedPerImage, 8);
    expect(result.total_usd).toBeCloseTo(expectedPerImage, 8);
    expect(result.pricing_key).toBe("per_mp_1024x1024");
  });

  it("scales total_usd for multiple images", () => {
    const result = calculateCost({
      model: flux2Flash,
      mode: "t2i",
      num_images: 4,
      width: 800,
      height: 450,
    });
    const expectedPerImage = 0.005 * (800 * 450) / 1_000_000;
    expect(result.per_image_usd).toBeCloseTo(expectedPerImage, 8);
    expect(result.total_usd).toBeCloseTo(expectedPerImage * 4, 8);
  });

  it("resolves 'square_hd' image_size enum to 1024x1024 via IMAGE_SIZE_ENUM_DIMS", () => {
    const result = calculateCost({
      model: flux2Flash,
      mode: "t2i",
      num_images: 1,
      image_size: "square_hd",
    });
    const expectedPerImage = 0.005 * (1024 * 1024) / 1_000_000;
    expect(result.per_image_usd).toBeCloseTo(expectedPerImage, 8);
    expect(result.pricing_key).toBe("per_mp_1024x1024");
  });

  it("resolves 'landscape_4_3' image_size enum to 1024x768 via IMAGE_SIZE_ENUM_DIMS", () => {
    const result = calculateCost({
      model: flux2Flash,
      mode: "t2i",
      num_images: 1,
      image_size: "landscape_4_3",
    });
    const expectedPerImage = 0.005 * (1024 * 768) / 1_000_000;
    expect(result.per_image_usd).toBeCloseTo(expectedPerImage, 8);
    expect(result.pricing_key).toBe("per_mp_1024x768");
  });
});

// ---------------------------------------------------------------------------
// 9. Flat edit pricing — grok-imagine
// ---------------------------------------------------------------------------
describe("calculateCost — flat edit pricing (grok-imagine)", () => {
  it("returns $0.022 per image for edit mode", () => {
    const result = calculateCost({
      model: grokImagine,
      mode: "edit",
      num_images: 1,
    });
    expect(result.per_image_usd).toBeCloseTo(0.022, 6);
    expect(result.pricing_key).toBe("fixed");
  });
});

// ---------------------------------------------------------------------------
// 10. Background removal — pixelcut-bg-remove flat $0.016
// ---------------------------------------------------------------------------
describe("calculateCost — background removal (pixelcut-bg-remove)", () => {
  it("returns $0.016 per image for bg_remove mode", () => {
    const result = calculateCost({
      model: pixelcutBg,
      mode: "bg_remove",
      num_images: 1,
    });
    expect(result.per_image_usd).toBeCloseTo(0.016, 6);
    expect(result.total_usd).toBeCloseTo(0.016, 6);
    expect(result.pricing_key).toBe("bg_remove_fixed");
  });

  it("scales total_usd linearly for 3 images", () => {
    const result = calculateCost({
      model: pixelcutBg,
      mode: "bg_remove",
      num_images: 3,
    });
    expect(result.total_usd).toBeCloseTo(0.016 * 3, 6);
    expect(result.pricing_key).toBe("bg_remove_fixed");
  });

  it("returns pricing_key 'missing' when a model lacks bg_remove pricing", () => {
    const result = calculateCost({
      model: gemini25Flash,   // no bg_remove_usd_per_image
      mode: "bg_remove",
      num_images: 1,
    });
    expect(result.per_image_usd).toBe(0);
    expect(result.total_usd).toBe(0);
    expect(result.pricing_key).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// 11. SessionTracker — accumulation, spend cap, and the race-condition fix
// ---------------------------------------------------------------------------
// The cap check in `record()` must compute the prospective total BEFORE
// mutating `total`/`calls`, and throw without touching state if the
// prospective total would exceed MAX_SESSION_USD. These tests pin that
// contract directly against the just-fixed implementation.
// ---------------------------------------------------------------------------
function makeCost(total_usd: number): CostResult {
  return { per_image_usd: total_usd, total_usd, pricing_key: "fixed" };
}

describe("SessionTracker.record — accumulation", () => {
  it("accumulates cost and call count across multiple calls", () => {
    const tracker = new SessionTracker();
    tracker.record("model-a", "t2i", 1, makeCost(0.05));
    tracker.record("model-b", "edit", 2, makeCost(0.03));

    expect(tracker.total).toBeCloseTo(0.08, 8);
    expect(tracker.calls.length).toBe(2);
    expect(tracker.calls[0].model_id).toBe("model-a");
    expect(tracker.calls[1].model_id).toBe("model-b");
  });
});

describe("SessionTracker.record — spend cap (MAX_SESSION_USD)", () => {
  const ORIGINAL = process.env.MAX_SESSION_USD;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAX_SESSION_USD;
    else process.env.MAX_SESSION_USD = ORIGINAL;
  });

  it("throws when a call would push the total past the cap", () => {
    process.env.MAX_SESSION_USD = "0.10";
    const tracker = new SessionTracker();
    tracker.record("model-a", "t2i", 1, makeCost(0.05));

    expect(() => tracker.record("model-b", "t2i", 1, makeCost(0.06))).toThrow(/spend cap/i);
  });

  it("does NOT mutate .total or .calls when the cap rejects a call", () => {
    process.env.MAX_SESSION_USD = "0.10";
    const tracker = new SessionTracker();
    tracker.record("model-a", "t2i", 1, makeCost(0.05));

    const totalBefore = tracker.total;
    const callsLengthBefore = tracker.calls.length;

    expect(() => tracker.record("model-b", "t2i", 1, makeCost(0.06))).toThrow();

    // State must be left exactly as it was before the rejected call —
    // this is the exact race-condition fix (check-before-act, no rollback needed).
    expect(tracker.total).toBe(totalBefore);
    expect(tracker.calls.length).toBe(callsLengthBefore);
  });

  it("succeeds for a call that lands exactly on the cap", () => {
    process.env.MAX_SESSION_USD = "0.10";
    const tracker = new SessionTracker();
    tracker.record("model-a", "t2i", 1, makeCost(0.04));

    // 0.04 + 0.06 = 0.10 exactly → prospectiveTotal > cap is false → must succeed
    expect(() => tracker.record("model-b", "t2i", 1, makeCost(0.06))).not.toThrow();
    expect(tracker.total).toBeCloseTo(0.10, 8);
    expect(tracker.calls.length).toBe(2);
  });

  it("succeeds for calls within the cap and only rejects the one that exceeds it", () => {
    process.env.MAX_SESSION_USD = "1.00";
    const tracker = new SessionTracker();

    tracker.record("model-a", "t2i", 1, makeCost(0.40));
    tracker.record("model-b", "t2i", 1, makeCost(0.40));
    expect(tracker.total).toBeCloseTo(0.80, 8);

    // 0.80 + 0.30 = 1.10 > 1.00 → must reject
    expect(() => tracker.record("model-c", "t2i", 1, makeCost(0.30))).toThrow(/spend cap/i);
    expect(tracker.total).toBeCloseTo(0.80, 8);
    expect(tracker.calls.length).toBe(2);
  });

  it("does not enforce a cap when MAX_SESSION_USD is unset/invalid", () => {
    delete process.env.MAX_SESSION_USD;
    const tracker = new SessionTracker();
    expect(() => tracker.record("model-a", "t2i", 1, makeCost(999))).not.toThrow();
    expect(tracker.total).toBe(999);
  });
});

describe("SessionTracker.reset", () => {
  it("clears total and calls", () => {
    const tracker = new SessionTracker();
    tracker.record("model-a", "t2i", 1, makeCost(0.05));
    tracker.reset();
    expect(tracker.total).toBe(0);
    expect(tracker.calls).toEqual([]);
  });
});

describe("SessionTracker.format", () => {
  it("returns the 'no calls' message when empty", () => {
    const tracker = new SessionTracker();
    expect(tracker.format()).toMatch(/no calls recorded/i);
  });

  it("includes the total and call count when calls exist", () => {
    const tracker = new SessionTracker();
    tracker.record("model-a", "t2i", 1, makeCost(0.05));
    tracker.record("model-b", "edit", 1, makeCost(0.03));

    const text = tracker.format();
    expect(text).toContain("$0.0800");
    expect(text).toContain("2 calls");
    expect(text).toContain("model-a");
    expect(text).toContain("model-b");
  });
});

// ---------------------------------------------------------------------------
// 12. getTracker — per-session registry
// ---------------------------------------------------------------------------
describe("getTracker", () => {
  it("returns the SAME instance for the same sessionId", () => {
    const id = `session-${Math.random()}`;
    const t1 = getTracker(id);
    const t2 = getTracker(id);
    expect(t1).toBe(t2);
  });

  it("returns a DIFFERENT instance for a different sessionId", () => {
    const t1 = getTracker(`session-a-${Math.random()}`);
    const t2 = getTracker(`session-b-${Math.random()}`);
    expect(t1).not.toBe(t2);
  });

  it("state recorded via one call to getTracker(id) is visible via a second call with the same id", () => {
    const id = `session-${Math.random()}`;
    getTracker(id).record("model-a", "t2i", 1, makeCost(0.02));
    expect(getTracker(id).total).toBeCloseTo(0.02, 8);
  });
});
