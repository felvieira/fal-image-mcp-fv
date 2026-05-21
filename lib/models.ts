import modelsJson from "@/models.json";

// ============================================================
// Tipos baseados no seu models.json
// ============================================================

export type ModelId = string;

export type ModelEndpoints = {
  t2i?: string;
  edit?: string;
};

export type ModelPricing = {
  t2i_usd_per_image?: number | Record<string, number>;
  edit_usd_per_image?: number | Record<string, number>;
  notes?: string;
};

export type ModelSupports = {
  t2i: boolean;
  edit: boolean;
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
  if (!m) throw new Error(`Modelo favorito '${id}' não existe. Use fal_list_models pra ver os disponíveis.`);
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
      const p = m.pricing.t2i_usd_per_image;
      const priceStr =
        typeof p === "number"
          ? `~$${p.toFixed(3)}/img`
          : "preço variável (por size/quality)";
      const caps = [
        m.supports.t2i ? "t2i" : null,
        m.supports.edit ? "edit" : null,
      ]
        .filter(Boolean)
        .join("+");
      return `  ${m.tier} ${m.id} — ${m.name} (${m.vendor}) [${caps}] ${priceStr}\n     use: ${m.use_cases.slice(0, 2).join(", ")}`;
    })
    .join("\n");
}
