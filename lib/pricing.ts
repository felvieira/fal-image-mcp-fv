import { FavoriteModel } from "./models";

// ============================================================
// Cost calculator
// ============================================================
// Handles models with fixed pricing (e.g. grok-imagine, gemini-25-flash)
// and models with a quality × size pricing table (e.g. gpt-image-2).
// ============================================================

export type CostMode = "t2i" | "edit" | "bg_remove";

export type CostInput = {
  model: FavoriteModel;
  mode: CostMode;
  num_images: number;
  quality?: string;       // "low" | "medium" | "high" | "auto"
  image_size?: string;    // "1024x1024" | "1024x1536" | "1536x1024" | etc.
  aspect_ratio?: string;  // "1:1" | "16:9" | etc.
  custom_size?: { width: number; height: number };
  width?: number;
  height?: number;
};

export type CostResult = {
  per_image_usd: number;
  total_usd: number;
  pricing_key: string;
  notes?: string;
};

/**
 * Tries to find the best matching key for quality + size in the model's
 * pricing table. Matching order:
 *
 *   "{quality}_{width}x{height}"   e.g. high_1024x1536
 *   "{quality}_{shortDim}"          e.g. high_1024  (when size is 1024x1024)
 *   "{quality}_other"               fallback
 *
 * Returns 0 + note if nothing matches.
 */
function resolveComplexPrice(
  table: Record<string, number>,
  opts: { quality?: string; image_size?: string }
): { price: number; key: string } {
  const quality = (opts.quality ?? "medium").toLowerCase();
  const size = opts.image_size ?? "1024x1024";

  const exactKey = `${quality}_${size}`;
  if (table[exactKey] != null) return { price: table[exactKey], key: exactKey };

  if (size === "1024x1024" && table[`${quality}_1024`] != null) {
    return { price: table[`${quality}_1024`], key: `${quality}_1024` };
  }

  if (table[`${quality}_other`] != null) {
    return { price: table[`${quality}_other`], key: `${quality}_other` };
  }

  const fallbackKey = Object.keys(table).find((k) => k.startsWith(`${quality}_`));
  if (fallbackKey) return { price: table[fallbackKey], key: fallbackKey };

  return { price: 0, key: "unknown" };
}

// Canonical image_size enum → dimensions map (mirrors generate.py)
const IMAGE_SIZE_ENUM_DIMS: Record<string, [number, number]> = {
  square_hd:      [1024, 1024],
  square:         [512,  512],
  portrait_4_3:   [768,  1024],
  portrait_16_9:  [576,  1024],
  landscape_4_3:  [1024, 768],
  landscape_16_9: [1024, 576],
};

function resolveDims(input: CostInput): [number, number] {
  if (input.width && input.height) return [input.width, input.height];
  const sz = input.image_size;
  if (sz) {
    if (sz in IMAGE_SIZE_ENUM_DIMS) return IMAGE_SIZE_ENUM_DIMS[sz];
    if (sz.includes("x")) {
      const [w, h] = sz.split("x").map(Number);
      if (w && h) return [w, h];
    }
  }
  return [1024, 1024];
}

export function calculateCost(input: CostInput): CostResult {
  const { model, mode, num_images, quality, image_size } = input;

  if (mode === "bg_remove") {
    const flat = model.pricing.bg_remove_usd_per_image;
    if (typeof flat === "number") {
      return {
        per_image_usd: flat,
        total_usd: flat * num_images,
        pricing_key: "bg_remove_fixed",
        notes: model.pricing.notes,
      };
    }
    return {
      per_image_usd: 0,
      total_usd: 0,
      pricing_key: "missing",
      notes: `Model ${model.id} has no pricing defined for background removal.`,
    };
  }

  // Per-megapixel pricing (e.g. flux-2-flash)
  const mpPrice = (model.pricing as Record<string, unknown>)[
    mode === "t2i" ? "t2i_usd_per_megapixel" : "edit_usd_per_megapixel"
  ];
  if (typeof mpPrice === "number") {
    const [w, h] = resolveDims(input);
    const megapixels = (w * h) / 1_000_000;
    const per_image_usd = mpPrice * megapixels;
    return {
      per_image_usd,
      total_usd: per_image_usd * num_images,
      pricing_key: `per_mp_${w}x${h}`,
      notes: model.pricing.notes,
    };
  }

  const pricingField = mode === "t2i" ? model.pricing.t2i_usd_per_image : model.pricing.edit_usd_per_image;

  if (pricingField == null) {
    return {
      per_image_usd: 0,
      total_usd: 0,
      pricing_key: "missing",
      notes: `Model ${model.id} has no pricing defined for mode ${mode}.`,
    };
  }

  // Fixed flat price
  if (typeof pricingField === "number") {
    return {
      per_image_usd: pricingField,
      total_usd: pricingField * num_images,
      pricing_key: "fixed",
      notes: model.pricing.notes,
    };
  }

  // Complex quality × size table (gpt-image-*)
  const { price, key } = resolveComplexPrice(pricingField, { quality, image_size });
  return {
    per_image_usd: price,
    total_usd: price * num_images,
    pricing_key: key,
    notes: model.pricing.notes,
  };
}

// ============================================================
// Per-session cost accumulator
// ============================================================
// In-memory; resets on every serverless cold start.
// To persist across cold starts, swap the Map for Redis/Upstash KV.
// ============================================================

type CallRecord = {
  ts: number;
  model_id: string;
  mode: CostMode;
  num_images: number;
  cost_usd: number;
  pricing_key: string;
};

class SessionTracker {
  total = 0;
  calls: CallRecord[] = [];

  record(model_id: string, mode: CostMode, num_images: number, result: CostResult) {
    // Per-session spend cap: check BEFORE mutating state to avoid a
    // check-after-act race under concurrent requests on the same warm
    // serverless instance. Compute what the new total would be and only
    // commit (push + add) if it stays within the cap. If it would exceed
    // the cap, throw immediately without touching `total` or `calls` —
    // since nothing was applied yet, there is nothing to roll back.
    const cap = parseFloat(process.env.MAX_SESSION_USD ?? "");
    const prospectiveTotal = this.total + result.total_usd;
    if (!isNaN(cap) && prospectiveTotal > cap) {
      throw new Error(
        `Session spend cap reached ($${cap.toFixed(2)}). ` +
        `Current session total: $${this.total.toFixed(4)}. ` +
        `Set MAX_SESSION_USD env var higher or start a new session.`
      );
    }
    this.total = prospectiveTotal;
    this.calls.push({
      ts: Date.now(),
      model_id,
      mode,
      num_images,
      cost_usd: result.total_usd,
      pricing_key: result.pricing_key,
    });
  }

  format(): string {
    if (this.calls.length === 0) return "💰 No calls recorded in this session yet.";
    const lines = this.calls
      .slice(-20)
      .map((c) => {
        const d = new Date(c.ts).toISOString().substring(11, 19);
        return `  ${d} • ${c.model_id} (${c.mode}, ${c.num_images} img${c.num_images > 1 ? "s" : ""}) — $${c.cost_usd.toFixed(4)}`;
      })
      .join("\n");
    return `💰 Session total: $${this.total.toFixed(4)} (${this.calls.length} calls)\n\nRecent calls:\n${lines}`;
  }

  reset() {
    this.total = 0;
    this.calls = [];
  }
}

// ============================================================
// Per-session tracker registry
// ============================================================
// Each logical session gets its own SessionTracker, keyed by sessionId.
// Previously a single global tracker was shared across all requests in a
// warm serverless instance — that leaked cost data between users.
// ============================================================

const trackers = new Map<string, SessionTracker>();

// Best-effort eviction guard to prevent unbounded memory growth in long-lived
// warm instances. Not a real LRU: when the limit is hit, we clear the whole
// Map. Acceptable because everything is already volatile and gone on cold start.
const MAX_TRACKERS = 500;

export function getTracker(sessionId: string): SessionTracker {
  let t = trackers.get(sessionId);
  if (!t) {
    if (trackers.size >= MAX_TRACKERS) {
      trackers.clear();
    }
    t = new SessionTracker();
    trackers.set(sessionId, t);
  }
  return t;
}

export { SessionTracker };
