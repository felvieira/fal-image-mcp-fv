import { FavoriteModel, type MegapixelLadder } from "./models";

// ============================================================
// Cost calculator
// ============================================================
// Handles models with fixed pricing (e.g. grok-imagine, gemini-25-flash),
// quality × size tables (gpt-image-*), per-megapixel rates, and
// first_mp/extra_mp ladders (flux-2-pro / outpaint).
// ============================================================

export type CostMode = "t2i" | "edit" | "bg_remove" | "upscale" | "resize" | "outpaint";

export type CostInput = {
  model: FavoriteModel;
  mode: CostMode;
  num_images: number;
  quality?: string;       // "low" | "medium" | "high" | "auto"
  image_size?: string;    // "1024x1024" | "square_hd" | etc.
  aspect_ratio?: string;
  /** Resolution tier for models like gemini-31-flash / gemini-3-pro ("1K","2K",…) */
  resolution?: string;
  custom_size?: { width: number; height: number };
  width?: number;
  height?: number;
  /** Output scale factor for upscalers (default 2) */
  scale?: number;
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
  square_1_1:     [1024, 1024],
  landscape_4_3_alt: [1024, 768],
  portrait_3_4:   [768, 1024],
  portrait_9_16:  [576, 1024],
};

function resolveDims(input: CostInput): [number, number] {
  if (input.width && input.height) return [input.width, input.height];
  if (input.custom_size) return [input.custom_size.width, input.custom_size.height];
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

/**
 * Round megapixels the way fal bills: standard presets near an integer
 * (e.g. 1024x1024 = 1.048576 MP) count as that integer, not ceil.
 */
export function roundUpMegapixels(width: number, height: number, tolerance = 0.05): number {
  const exact = (width * height) / 1_000_000;
  const nearest = Math.round(exact);
  if (nearest >= 1 && Math.abs(exact - nearest) <= tolerance * nearest) {
    return nearest;
  }
  return Math.ceil(exact);
}

function isMegapixelLadder(v: unknown): v is MegapixelLadder {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as MegapixelLadder).first_mp === "number" &&
    typeof (v as MegapixelLadder).extra_mp === "number"
  );
}

function costFromLadder(ladder: MegapixelLadder, width: number, height: number): number {
  const mp = roundUpMegapixels(width, height);
  const extra = Math.max(0, mp - 1);
  return ladder.first_mp + extra * ladder.extra_mp;
}

function missing(model: FavoriteModel, mode: CostMode): CostResult {
  return {
    per_image_usd: 0,
    total_usd: 0,
    pricing_key: "missing",
    notes: `Model ${model.id} has no pricing defined for mode ${mode}.`,
  };
}

export function calculateCost(input: CostInput): CostResult {
  const { model, mode, num_images, quality, image_size } = input;
  const [w, h] = resolveDims(input);

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
    return missing(model, mode);
  }

  if (mode === "resize") {
    const is4k = Math.max(w, h) >= 3840;
    const flat = is4k
      ? (model.pricing.resize_usd_per_image_4k ?? model.pricing.resize_usd_per_image)
      : model.pricing.resize_usd_per_image;
    if (typeof flat !== "number") return missing(model, mode);
    const vision = typeof model.pricing.min_vision_fee_usd === "number"
      ? model.pricing.min_vision_fee_usd
      : 0;
    const per = flat + vision;
    return {
      per_image_usd: per,
      total_usd: per * num_images,
      pricing_key: is4k ? "resize_4k" : "resize_fixed",
      notes: model.pricing.notes,
    };
  }

  if (mode === "upscale") {
    const compute = model.pricing.upscale_usd_per_compute_second;
    if (typeof compute === "number") {
      return {
        per_image_usd: 0,
        total_usd: 0,
        pricing_key: "variable_compute",
        notes:
          model.pricing.notes ??
          "Upscale billed by compute-time — cost unknown until the job finishes.",
      };
    }
    const mpPrice = model.pricing.upscale_usd_per_megapixel;
    if (typeof mpPrice === "number") {
      // Prefer explicit output dims; otherwise assume scale× of a 1024² input.
      const scale = input.scale && input.scale > 0 ? input.scale : 2;
      const outW = input.width && input.height ? w : Math.round(1024 * scale);
      const outH = input.width && input.height ? h : Math.round(1024 * scale);
      const megapixels = (outW * outH) / 1_000_000;
      const per = mpPrice * megapixels;
      return {
        per_image_usd: per,
        total_usd: per * num_images,
        pricing_key: `upscale_mp_${outW}x${outH}`,
        notes: model.pricing.notes,
      };
    }
    return missing(model, mode);
  }

  if (mode === "outpaint") {
    const mp = model.pricing.outpaint_usd_per_megapixel;
    if (isMegapixelLadder(mp)) {
      const per = costFromLadder(mp, w, h);
      return {
        per_image_usd: per,
        total_usd: per * num_images,
        pricing_key: `outpaint_ladder_${w}x${h}`,
        notes: model.pricing.notes,
      };
    }
    if (typeof mp === "number") {
      const megapixels = (w * h) / 1_000_000;
      const per = mp * megapixels;
      return {
        per_image_usd: per,
        total_usd: per * num_images,
        pricing_key: `outpaint_mp_${w}x${h}`,
        notes: model.pricing.notes,
      };
    }
    return missing(model, mode);
  }

  // t2i / edit — per-megapixel (number or first/extra ladder)
  const mpField = mode === "t2i" ? model.pricing.t2i_usd_per_megapixel : model.pricing.edit_usd_per_megapixel;
  if (typeof mpField === "number") {
    const megapixels = (w * h) / 1_000_000;
    const per_image_usd = mpField * megapixels;
    return {
      per_image_usd,
      total_usd: per_image_usd * num_images,
      pricing_key: `per_mp_${w}x${h}`,
      notes: model.pricing.notes,
    };
  }
  if (isMegapixelLadder(mpField)) {
    const per_image_usd = costFromLadder(mpField, w, h);
    return {
      per_image_usd,
      total_usd: per_image_usd * num_images,
      pricing_key: `mp_ladder_${w}x${h}`,
      notes: model.pricing.notes,
    };
  }

  // Structured pricing_table by resolution (gemini-31-flash / gemini-3-pro)
  const tableRoot = model.pricing.pricing_table;
  if (tableRoot && typeof tableRoot === "object") {
    const modeTable = (tableRoot as Record<string, unknown>)[mode];
    if (modeTable && typeof modeTable === "object") {
      // Also accept resolution via image_size when it's a tier like "1K"
      const tier =
        input.resolution ??
        (image_size && !image_size.includes("x") && !IMAGE_SIZE_ENUM_DIMS[image_size]
          ? image_size
          : undefined);
      if (tier && typeof (modeTable as Record<string, unknown>)[tier] === "number") {
        const price = (modeTable as Record<string, number>)[tier];
        return {
          per_image_usd: price,
          total_usd: price * num_images,
          pricing_key: `table_${tier}`,
          notes: model.pricing.notes,
        };
      }
    }
  }

  const pricingField = mode === "t2i" ? model.pricing.t2i_usd_per_image : model.pricing.edit_usd_per_image;

  if (pricingField == null) {
    return missing(model, mode);
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
