import modelsJson from "@/models.json";

// ============================================================
// Types derived from models.json
// ============================================================

export type ModelId = string;

export type ModelEndpoints = {
  t2i?: string;
  edit?: string;
  bg_remove?: string;
};

export type ModelPricing = {
  t2i_usd_per_image?: number | Record<string, number>;
  edit_usd_per_image?: number | Record<string, number>;
  /** Price per megapixel — used by models like flux-2-flash ($0.005/MP) */
  t2i_usd_per_megapixel?: number;
  edit_usd_per_megapixel?: number;
  /** Flat price per image for background removal (e.g. pixelcut-bg-remove $0.016) */
  bg_remove_usd_per_image?: number;
  notes?: string;
};

export type ModelSupports = {
  t2i: boolean;
  edit: boolean;
  bg_remove?: boolean;
  aspect_ratios?: string[];
  image_sizes?: string[];
  custom_size?: boolean;
  max_custom_edge_px?: number;
  max_reference_images?: number;
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

export type ModelsConfig = {
  version: string;
  provider: string;
  queue_base_url: string;
  sync_base_url: string;
  default: ModelId;
  default_text_to_image?: ModelId;
  default_edit_image?: ModelId;
  models: Record<ModelId, FavoriteModel>;
  use_case_routing: Record<string, ModelId>;
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

export function listFavorites(mode: "t2i" | "edit" | "all" = "all"): FavoriteModel[] {
  return Object.values(FAVORITES).filter((m) => {
    if (mode === "all") return true;
    if (mode === "t2i") return m.supports.t2i && !!m.endpoints.t2i;
    if (mode === "edit") return m.supports.edit && !!m.endpoints.edit;
    return true;
  });
}

export function formatFavoritesList(mode: "t2i" | "edit" | "all" = "all"): string {
  const list = listFavorites(mode);
  return list
    .map((m) => {
      // Supports: flat/img, per-megapixel, complex table
      let priceStr: string;
      if (m.supports.t2i) {
        const mp = m.pricing.t2i_usd_per_megapixel;
        const flat = m.pricing.t2i_usd_per_image;
        if (typeof mp === "number") {
          priceStr = `$${mp.toFixed(4)}/MP (~$${(mp * 1.05).toFixed(4)}/1024²)`;
        } else if (typeof flat === "number") {
          priceStr = `~$${flat.toFixed(3)}/img`;
        } else {
          priceStr = "variable price (by size/quality)";
        }
      } else if (m.supports.edit) {
        const mp = m.pricing.edit_usd_per_megapixel;
        const flat = m.pricing.edit_usd_per_image;
        if (typeof mp === "number") {
          priceStr = `$${mp.toFixed(4)}/MP (~$${(mp * 1.05).toFixed(4)}/1024²)`;
        } else if (typeof flat === "number") {
          priceStr = `~$${flat.toFixed(3)}/img`;
        } else {
          priceStr = "variable price (by size/quality)";
        }
      } else if (m.supports.bg_remove) {
        const flat = m.pricing.bg_remove_usd_per_image;
        if (typeof flat === "number") {
          priceStr = `~$${flat.toFixed(3)}/img`;
        } else {
          priceStr = "variable price (by size/quality)";
        }
      } else {
        priceStr = "variable price (by size/quality)";
      }
      const caps = [
        m.supports.t2i ? "t2i" : null,
        m.supports.edit ? "edit" : null,
        m.supports.bg_remove ? "bg_remove" : null,
      ]
        .filter(Boolean)
        .join("+");
      return `  ${m.tier} ${m.id} — ${m.name} (${m.vendor}) [${caps}] ${priceStr}\n     use: ${m.use_cases.slice(0, 2).join(", ")}`;
    })
    .join("\n");
}
