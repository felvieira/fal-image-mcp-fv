import { FavoriteModel } from "./models";

// ============================================================
// Calculadora de custo
// ============================================================
// Lida com modelos que têm preço fixo (ex: grok-imagine, gemini-25-flash)
// E com modelos que têm tabela por quality x size (ex: gpt-image-2)
// ============================================================

export type CostInput = {
  model: FavoriteModel;
  mode: "t2i" | "edit";
  num_images: number;
  quality?: string;       // "low" | "medium" | "high" | "auto"
  image_size?: string;    // "1024x1024" | "1024x1536" | "1536x1024" | etc.
  aspect_ratio?: string;  // "1:1" | "16:9" | etc.
  custom_size?: { width: number; height: number };
  // dimensoes explicitas pra modelos por-megapixel (ex: flux-2-flash)
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
 * Tenta encontrar a chave que melhor casa com quality + size
 * na tabela de preços do modelo. Ordem de matching:
 *
 *   "{quality}_{width}x{height}"        ex: high_1024x1536
 *   "{quality}_{shortDim}"               ex: high_1024  (quando size for 1024x*)
 *   "{quality}_other"                    fallback
 *
 * Se nenhum casar, retorna 0 + nota.
 */
function resolveComplexPrice(
  table: Record<string, number>,
  opts: { quality?: string; image_size?: string }
): { price: number; key: string } {
  const quality = (opts.quality ?? "medium").toLowerCase();
  const size = opts.image_size ?? "1024x1024";

  // 1. tenta match exato {quality}_{size}
  const exactKey = `${quality}_${size}`;
  if (table[exactKey] != null) return { price: table[exactKey], key: exactKey };

  // 2. tenta {quality}_1024 (se size é 1024x1024)
  if (size === "1024x1024" && table[`${quality}_1024`] != null) {
    return { price: table[`${quality}_1024`], key: `${quality}_1024` };
  }

  // 3. tenta {quality}_other como fallback
  if (table[`${quality}_other`] != null) {
    return { price: table[`${quality}_other`], key: `${quality}_other` };
  }

  // 4. pega qualquer chave que comece com a quality
  const fallbackKey = Object.keys(table).find((k) => k.startsWith(`${quality}_`));
  if (fallbackKey) return { price: table[fallbackKey], key: fallbackKey };

  // 5. nada bateu — retorna 0
  return { price: 0, key: "unknown" };
}

// Mapa canônico de image_size enum → dimensões (espelha generate.py)
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
  // fallback: assume 1024×1024
  return [1024, 1024];
}

export function calculateCost(input: CostInput): CostResult {
  const { model, mode, num_images, quality, image_size } = input;

  // Caso 0: preço por megapixel (ex: flux-2-flash)
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
      notes: `Modelo ${model.id} não tem pricing definido pra modo ${mode}.`,
    };
  }

  // Caso 1: preço fixo (number)
  if (typeof pricingField === "number") {
    return {
      per_image_usd: pricingField,
      total_usd: pricingField * num_images,
      pricing_key: "fixed",
      notes: model.pricing.notes,
    };
  }

  // Caso 2: tabela complexa (gpt-image-*)
  const { price, key } = resolveComplexPrice(pricingField, { quality, image_size });
  return {
    per_image_usd: price,
    total_usd: price * num_images,
    pricing_key: key,
    notes: model.pricing.notes,
  };
}

// ============================================================
// Acumulador de custo da sessão
// ============================================================
// In-memory; reseta a cada cold start do serverless.
// Pra persistir entre cold starts, troque por Redis/KV depois.
// ============================================================

type CallRecord = {
  ts: number;
  model_id: string;
  mode: "t2i" | "edit";
  num_images: number;
  cost_usd: number;
  pricing_key: string;
};

class SessionTracker {
  total = 0;
  calls: CallRecord[] = [];

  record(model_id: string, mode: "t2i" | "edit", num_images: number, result: CostResult) {
    this.total += result.total_usd;
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
    if (this.calls.length === 0) return "💰 Nenhuma chamada registrada nessa sessão ainda.";
    const lines = this.calls
      .slice(-20) // últimas 20 pra não estourar
      .map((c) => {
        const d = new Date(c.ts).toISOString().substring(11, 19);
        return `  ${d} • ${c.model_id} (${c.mode}, ${c.num_images} img${c.num_images > 1 ? "s" : ""}) — $${c.cost_usd.toFixed(4)}`;
      })
      .join("\n");
    return `💰 Total acumulado: $${this.total.toFixed(4)} (${this.calls.length} chamadas)\n\nÚltimas chamadas:\n${lines}`;
  }

  reset() {
    this.total = 0;
    this.calls = [];
  }
}

// ============================================================
// Registro de trackers POR SESSÃO (não mais singleton global)
// ============================================================
// PORQUÊ: antes existia `export const tracker = new SessionTracker()`,
// um único acumulador compartilhado por TODAS as requisições que caíssem
// na mesma instância "quente" do serverless. Em um MCP público multi-tenant
// isso vaza custo entre usuários — o custo acumulado do usuário A aparecia
// no `fal_session_cost` do usuário B. A palavra "session" era mentira:
// o escopo era global por instância, não por sessão lógica.
//
// Agora cada sessão lógica tem seu próprio SessionTracker, indexado por
// sessionId em um Map module-level. O caller (route.ts) resolve o tracker
// via getTracker(sessionId).
//
// In-memory; reseta a cada cold start do serverless (igual antes).
// Pra persistir entre cold starts, troque o Map por Redis/KV depois.
// ============================================================

const trackers = new Map<string, SessionTracker>();

// Limite best-effort pra evitar crescimento ilimitado de memória ao longo
// da vida de uma instância quente. Não é um LRU real: quando estoura,
// limpamos o Map inteiro. É aceitável porque tudo já é volátil e some no
// próximo cold start de qualquer forma — só protege contra acúmulo de
// sessionIds abandonados numa instância de vida longa.
const MAX_TRACKERS = 500;

export function getTracker(sessionId: string): SessionTracker {
  let t = trackers.get(sessionId);
  if (!t) {
    // guarda de evicção: se o Map estourou, descarta tudo antes de criar
    // o novo tracker (best-effort; reseta no cold start de qualquer jeito).
    if (trackers.size >= MAX_TRACKERS) {
      trackers.clear();
    }
    t = new SessionTracker();
    trackers.set(sessionId, t);
  }
  return t;
}

export { SessionTracker };
