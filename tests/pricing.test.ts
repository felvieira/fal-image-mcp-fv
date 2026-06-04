import { describe, it, expect } from "vitest";
import { calculateCost, type CostInput } from "@/lib/pricing";
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
