import modelsJson from "@/models.json";

// ============================================================
// Types derived from models.json
// ============================================================

export type ModelId = string;

export type ModelEndpoints = {
  t2i?: string;
  edit?: string;
  bg_remove?: string;
  upscale?: string;
  resize?: string;
  outpaint?: string;
};

export type MegapixelLadder = {
  first_mp: number;
  extra_mp: number;
};

export type ModelPricing = {
  t2i_usd_per_image?: number | Record<string, number>;
  edit_usd_per_image?: number | Record<string, number>;
  /** Flat $/MP or first_mp/extra_mp ladder (flux-2-pro style) */
  t2i_usd_per_megapixel?: number | MegapixelLadder;
  edit_usd_per_megapixel?: number | MegapixelLadder;
  bg_remove_usd_per_image?: number;
  resize_usd_per_image?: number;
  resize_usd_per_image_4k?: number;
  min_vision_fee_usd?: number;
  upscale_usd_per_megapixel?: number;
  upscale_usd_per_compute_second?: number;
  outpaint_usd_per_megapixel?: number | MegapixelLadder;
  pricing_table?: Record<string, unknown>;
  notes?: string;
};

export type ModelSupports = {
  t2i: boolean;
  edit: boolean;
  bg_remove?: boolean;
  upscale?: boolean;
  resize?: boolean;
  outpaint?: boolean;
  aspect_ratios?: string[];
  image_sizes?: string[];
  custom_size?: boolean;
  max_custom_edge_px?: number;
  max_reference_images?: number;
  /** Seedream-style edit ref limit (preferred over max_reference_images when set) */
  max_reference_images_edit?: number;
  negative_prompt?: boolean;
  quality_tiers?: boolean;
  qualities?: string[];
  resolution_tiers?: string[];
  output_formats?: string[];
  num_images_max?: number;
};

export type FavoriteModel = {
  id: ModelId;
  name: string;
  vendor: string;
  endpoints: ModelEndpoints;
  pricing: ModelPricing;
  tier: "$" | "$$" | "$$$";
  use_cases: string[];
  supports: ModelSupports;
  default_params: Record<string, unknown>;
  docs: string;
};

export type ListMode =
  | "t2i"
  | "edit"
  | "bg_remove"
  | "upscale"
  | "resize"
  | "outpaint"
  | "all";

export type ModelsConfig = {
  version: string;
  provider: string;
  queue_base_url: string;
  sync_base_url: string;
  default: ModelId;
  default_text_to_image?: ModelId;
  default_edit_image?: ModelId;
  models: Record<ModelId, FavoriteModel>;
  use_case_routing: Record<string, string>;
  common_aspect_ratios: Record<string, string>;
  auth: {
    header: string;
    env_var: string;
    fallback_env_vars: string[];
  };
};

// ============================================================
// Loader
// ============================================================

export const config = modelsJson as unknown as ModelsConfig;

export const FAVORITES = config.models;
export const DEFAULT_MODEL = config.default;

export function getModel(id: ModelId): FavoriteModel {
  const m = FAVORITES[id];
  if (!m) throw new Error(`Favorite model '${id}' not found. Run fal_list_models to see available models.`);
  return m;
}

export function maxReferenceImages(m: FavoriteModel): number | undefined {
  return m.supports.max_reference_images_edit ?? m.supports.max_reference_images;
}

export function listFavorites(mode: ListMode = "all"): FavoriteModel[] {
  return Object.values(FAVORITES).filter((m) => {
    if (mode === "all") return true;
    if (mode === "t2i") return m.supports.t2i && !!m.endpoints.t2i;
    if (mode === "edit") return m.supports.edit && !!m.endpoints.edit;
    if (mode === "bg_remove") return !!m.supports.bg_remove && !!m.endpoints.bg_remove;
    if (mode === "upscale") return !!m.supports.upscale && !!m.endpoints.upscale;
    if (mode === "resize") return !!m.supports.resize && !!m.endpoints.resize;
    if (mode === "outpaint") return !!m.supports.outpaint && !!m.endpoints.outpaint;
    return true;
  });
}

function priceLabel(m: FavoriteModel): string {
  if (m.supports.t2i) {
    const mp = m.pricing.t2i_usd_per_megapixel;
    const flat = m.pricing.t2i_usd_per_image;
    if (typeof mp === "number") {
      return `$${mp.toFixed(4)}/MP (~$${(mp * 1.05).toFixed(4)}/1024²)`;
    }
    if (mp && typeof mp === "object") {
      return `$${mp.first_mp.toFixed(3)}+$${mp.extra_mp.toFixed(3)}/extra MP`;
    }
    if (typeof flat === "number") return `~$${flat.toFixed(3)}/img`;
    return "variable price (by size/quality)";
  }
  if (m.supports.edit) {
    const mp = m.pricing.edit_usd_per_megapixel;
    const flat = m.pricing.edit_usd_per_image;
    if (typeof mp === "number") {
      return `$${mp.toFixed(4)}/MP (~$${(mp * 1.05).toFixed(4)}/1024²)`;
    }
    if (typeof flat === "number") return `~$${flat.toFixed(3)}/img`;
    return "variable price (by size/quality)";
  }
  if (m.supports.bg_remove) {
    const flat = m.pricing.bg_remove_usd_per_image;
    if (typeof flat === "number") return `~$${flat.toFixed(3)}/img`;
  }
  if (m.supports.upscale) {
    const mp = m.pricing.upscale_usd_per_megapixel;
    if (typeof mp === "number") return `$${mp.toFixed(4)}/MP out`;
    if (m.pricing.upscale_usd_per_compute_second != null) return "variable (compute-time)";
  }
  if (m.supports.resize) {
    const flat = m.pricing.resize_usd_per_image;
    if (typeof flat === "number") return `~$${flat.toFixed(3)}/img`;
  }
  if (m.supports.outpaint) {
    const mp = m.pricing.outpaint_usd_per_megapixel;
    if (mp && typeof mp === "object") {
      return `$${mp.first_mp.toFixed(3)}+$${mp.extra_mp.toFixed(3)}/extra MP`;
    }
    if (typeof mp === "number") return `$${mp.toFixed(4)}/MP`;
  }
  return "variable price (by size/quality)";
}

export function formatFavoritesList(mode: ListMode = "all"): string {
  const list = listFavorites(mode);
  return list
    .map((m) => {
      const caps = [
        m.supports.t2i ? "t2i" : null,
        m.supports.edit ? "edit" : null,
        m.supports.bg_remove ? "bg_remove" : null,
        m.supports.upscale ? "upscale" : null,
        m.supports.resize ? "resize" : null,
        m.supports.outpaint ? "outpaint" : null,
      ]
        .filter(Boolean)
        .join("+");
      return `  ${m.tier} ${m.id} — ${m.name} (${m.vendor}) [${caps}] ${priceLabel(m)}\n     use: ${m.use_cases.slice(0, 2).join(", ")}`;
    })
    .join("\n");
}
