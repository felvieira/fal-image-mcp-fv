import { createMcpHandler } from "@vercel/mcp-adapter";
import { z } from "zod";
import {
  FAVORITES,
  DEFAULT_MODEL,
  getModel,
  listFavorites,
  formatFavoritesList,
  config as modelsConfig,
} from "@/lib/models";
import { calculateCost, tracker } from "@/lib/pricing";
import { falSubscribe, extractImageUrls, listFalCatalog } from "@/lib/fal";

// ============================================================
// Auth helper — Bearer token simples
// ============================================================
function checkAuth(req: Request): void {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) return; // se não configurou token, libera (útil em dev)
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new Error("Unauthorized — falta header Authorization: Bearer ...");
  }
  const token = auth.replace("Bearer ", "").trim();
  if (token !== expected) throw new Error("Unauthorized — token inválido");
}

// ============================================================
// Handler
// ============================================================

const handler = createMcpHandler(
  (server) => {
    // -------------------------------------------------------
    // TOOL 1: Listar modelos (favoritos + catálogo do fal)
    // -------------------------------------------------------
    server.tool(
      "fal_list_models",
      "Lista os modelos disponíveis. Mostra primeiro os FAVORITOS (do models.json do Felipe), depois opcionalmente busca mais no catálogo do fal. Filtra por modo (t2i, edit ou ambos).",
      {
        mode: z
          .enum(["t2i", "edit", "all"])
          .default("all")
          .describe("Filtra por capacidade: 't2i' = só text-to-image, 'edit' = só image-to-image/edit, 'all' = todos"),
        include_fal_catalog: z
          .boolean()
          .default(false)
          .describe("Se true, busca modelos adicionais no catálogo público do fal.ai (mais lento)"),
        catalog_limit: z.number().min(1).max(50).default(15).describe("Quantos modelos extras buscar no catálogo do fal"),
      },
      async ({ mode, include_fal_catalog, catalog_limit }) => {
        const favLines = formatFavoritesList(mode);
        const favCount = listFavorites(mode).length;

        let extras = "";
        if (include_fal_catalog) {
          const cats =
            mode === "t2i"
              ? ["text-to-image"]
              : mode === "edit"
              ? ["image-to-image", "image-editing"]
              : ["text-to-image", "image-to-image", "image-editing"];

          const all: string[] = [];
          for (const c of cats) {
            const list = await listFalCatalog(c, catalog_limit);
            if (list.length) {
              all.push(`\n[${c}]`);
              for (const m of list) all.push(`  ${m.endpoint_id} — ${m.name}`);
            }
          }
          extras = all.length ? `\n\n📚 Catálogo público do fal:${all.join("\n")}` : "\n\n(catálogo público vazio ou indisponível)";
        }

        return {
          content: [
            {
              type: "text",
              text:
                `⭐ FAVORITOS do Felipe (${favCount} modelos, mode=${mode}):\n` +
                `Default: ${DEFAULT_MODEL}\n\n` +
                favLines +
                extras +
                `\n\nDica: use 'use_case_routing' do models.json pra escolher rápido:\n` +
                Object.entries(modelsConfig.use_case_routing)
                  .map(([k, v]) => `  • ${k} → ${v}`)
                  .join("\n"),
            },
          ],
        };
      }
    );

    // -------------------------------------------------------
    // TOOL 2: Text-to-Image (gerar do zero)
    // -------------------------------------------------------
    server.tool(
      "fal_generate_image",
      "Gera uma imagem do zero a partir de texto. Usa um modelo dos favoritos (passe model_id) ou um endpoint arbitrário do fal (passe endpoint_id direto). SEMPRE mostra o custo da chamada e o acumulado da sessão.",
      {
        prompt: z.string().min(1).describe("Descrição textual da imagem desejada"),
        model_id: z
          .string()
          .optional()
          .describe(`ID do modelo favorito (${Object.keys(FAVORITES).join(", ")}). Default: ${DEFAULT_MODEL}`),
        endpoint_id: z
          .string()
          .optional()
          .describe("Endpoint arbitrário do fal (ex: 'fal-ai/flux/dev'). Use isso se quiser um modelo fora dos favoritos. Tem prioridade sobre model_id."),
        num_images: z.number().min(1).max(4).default(1),
        aspect_ratio: z
          .string()
          .optional()
          .describe("Ex: '1:1', '16:9', '9:16'. Usado por modelos que aceitam aspect_ratio."),
        image_size: z
          .string()
          .optional()
          .describe("Ex: '1024x1024', 'square_hd', 'landscape_16_9'. Usado por modelos que aceitam image_size."),
        quality: z
          .enum(["auto", "low", "medium", "high"])
          .optional()
          .describe("Para modelos com tiers (gpt-image-1/1.5/2/mini). Default varia por modelo."),
        output_format: z.enum(["jpeg", "png", "webp"]).optional(),
        extra_params: z
          .record(z.any())
          .optional()
          .describe("Params extras que vão direto pro body do fal (override). Use pra coisas específicas do modelo (negative_prompt, seed, safety_tolerance, etc)"),
      },
      async (args) => {
        // ----- Resolver modelo + endpoint -----
        let endpoint: string;
        let modelLabel: string;
        let pricingModel: typeof FAVORITES[string] | null = null;

        if (args.endpoint_id) {
          endpoint = args.endpoint_id;
          modelLabel = `[custom] ${args.endpoint_id}`;
        } else {
          const id = args.model_id ?? DEFAULT_MODEL;
          const m = getModel(id);
          if (!m.endpoints.t2i) throw new Error(`Modelo ${id} não suporta text-to-image (sem endpoint t2i).`);
          endpoint = m.endpoints.t2i;
          modelLabel = `${m.name} (${id})`;
          pricingModel = m;
        }

        // ----- Montar input -----
        const input: Record<string, unknown> = {
          prompt: args.prompt,
          num_images: args.num_images,
        };
        if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
        if (args.image_size) input.image_size = args.image_size;
        if (args.quality) input.quality = args.quality;
        if (args.output_format) input.output_format = args.output_format;

        // Mescla defaults do modelo se for favorito
        if (pricingModel?.default_params) {
          for (const [k, v] of Object.entries(pricingModel.default_params)) {
            if (input[k] == null) input[k] = v;
          }
        }
        // Override com extra_params
        if (args.extra_params) Object.assign(input, args.extra_params);

        // ----- Chamar fal -----
        const start = Date.now();
        const { data, request_id } = await falSubscribe(endpoint, input);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);

        // ----- Extrair URLs -----
        const urls = extractImageUrls(data);

        // ----- Calcular custo -----
        let costStr = "Custo: indisponível (modelo fora dos favoritos)";
        if (pricingModel) {
          const cost = calculateCost({
            model: pricingModel,
            mode: "t2i",
            num_images: args.num_images,
            quality: typeof input.quality === "string" ? input.quality : undefined,
            image_size: typeof input.image_size === "string" ? input.image_size : undefined,
          });
          tracker.record(pricingModel.id, "t2i", args.num_images, cost);
          costStr =
            `💰 Custo: $${cost.total_usd.toFixed(4)} ` +
            `($${cost.per_image_usd.toFixed(4)}/img × ${args.num_images}, key=${cost.pricing_key})\n` +
            `   Sessão: $${tracker.total.toFixed(4)} (${tracker.calls.length} chamadas)`;
        }

        return {
          content: [
            {
              type: "text",
              text:
                `✅ Gerou ${urls.length} imagem(ns) em ${elapsed}s\n` +
                `Modelo: ${modelLabel}\n` +
                `Endpoint: ${endpoint}\n` +
                `Request ID: ${request_id}\n` +
                costStr +
                `\n\nURLs:\n${urls.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`,
            },
            ...urls.map((url) => ({
              type: "image" as const,
              data: url,
              mimeType: "image/png" as const,
            })),
          ],
        };
      }
    );

    // -------------------------------------------------------
    // TOOL 3: Image edit (edição com referência)
    // -------------------------------------------------------
    server.tool(
      "fal_edit_image",
      "Edita/transforma uma imagem existente usando texto + imagem de referência. Aceita 1+ URLs como referência (limite varia por modelo). SEMPRE mostra o custo.",
      {
        prompt: z.string().min(1).describe("O que você quer mudar/adicionar/transformar"),
        image_urls: z
          .array(z.string().url())
          .min(1)
          .describe("URL(s) da(s) imagem(ns) de referência. A maioria dos modelos aceita 1; alguns (gemini-25-flash, gpt-image-1-mini/1.5) aceitam até 4."),
        model_id: z
          .string()
          .optional()
          .describe(`ID do modelo favorito que suporta edit (${Object.values(FAVORITES).filter((m) => m.supports.edit).map((m) => m.id).join(", ")})`),
        endpoint_id: z.string().optional().describe("Endpoint arbitrário de edit/image-to-image do fal. Override do model_id."),
        num_images: z.number().min(1).max(4).default(1),
        aspect_ratio: z.string().optional(),
        image_size: z.string().optional(),
        quality: z.enum(["auto", "low", "medium", "high"]).optional(),
        output_format: z.enum(["jpeg", "png", "webp"]).optional(),
        extra_params: z.record(z.any()).optional(),
      },
      async (args) => {
        // ----- Resolver endpoint -----
        let endpoint: string;
        let modelLabel: string;
        let pricingModel: typeof FAVORITES[string] | null = null;

        if (args.endpoint_id) {
          endpoint = args.endpoint_id;
          modelLabel = `[custom] ${args.endpoint_id}`;
        } else {
          const id = args.model_id ?? "gemini-25-flash"; // default sensato pra edit
          const m = getModel(id);
          if (!m.supports.edit || !m.endpoints.edit) throw new Error(`Modelo ${id} não suporta edição de imagem.`);
          endpoint = m.endpoints.edit;
          modelLabel = `${m.name} (${id})`;
          pricingModel = m;
        }

        // ----- Validar quantidade de referências -----
        if (pricingModel?.supports.max_reference_images != null) {
          const max = pricingModel.supports.max_reference_images;
          if (args.image_urls.length > max) {
            throw new Error(
              `Modelo ${pricingModel.id} aceita no máximo ${max} imagem(ns) de referência. Você passou ${args.image_urls.length}.`
            );
          }
        }

        // ----- Montar input -----
        // Convenção do fal: a maioria dos endpoints de edit aceita
        //   - image_url (string)         OU
        //   - image_urls (array)         OU
        //   - reference_images (array)
        // A gente passa os dois formatos mais comuns; o modelo ignora o que não usa.
        const input: Record<string, unknown> = {
          prompt: args.prompt,
          num_images: args.num_images,
        };
        if (args.image_urls.length === 1) {
          input.image_url = args.image_urls[0];
          input.image_urls = args.image_urls;
        } else {
          input.image_urls = args.image_urls;
        }
        if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
        if (args.image_size) input.image_size = args.image_size;
        if (args.quality) input.quality = args.quality;
        if (args.output_format) input.output_format = args.output_format;

        if (pricingModel?.default_params) {
          for (const [k, v] of Object.entries(pricingModel.default_params)) {
            if (input[k] == null) input[k] = v;
          }
        }
        if (args.extra_params) Object.assign(input, args.extra_params);

        // ----- Chamar fal -----
        const start = Date.now();
        const { data, request_id } = await falSubscribe(endpoint, input);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);

        const urls = extractImageUrls(data);

        // ----- Calcular custo -----
        let costStr = "Custo: indisponível (modelo fora dos favoritos)";
        if (pricingModel) {
          const cost = calculateCost({
            model: pricingModel,
            mode: "edit",
            num_images: args.num_images,
            quality: typeof input.quality === "string" ? input.quality : undefined,
            image_size: typeof input.image_size === "string" ? input.image_size : undefined,
          });
          tracker.record(pricingModel.id, "edit", args.num_images, cost);
          costStr =
            `💰 Custo: $${cost.total_usd.toFixed(4)} ` +
            `($${cost.per_image_usd.toFixed(4)}/img × ${args.num_images}, key=${cost.pricing_key})\n` +
            `   Sessão: $${tracker.total.toFixed(4)} (${tracker.calls.length} chamadas)`;
        }

        return {
          content: [
            {
              type: "text",
              text:
                `✅ Editou ${urls.length} imagem(ns) em ${elapsed}s\n` +
                `Modelo: ${modelLabel}\n` +
                `Endpoint: ${endpoint}\n` +
                `Referências: ${args.image_urls.length}\n` +
                `Request ID: ${request_id}\n` +
                costStr +
                `\n\nURLs resultado:\n${urls.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`,
            },
            ...urls.map((url) => ({
              type: "image" as const,
              data: url,
              mimeType: "image/png" as const,
            })),
          ],
        };
      }
    );

    // -------------------------------------------------------
    // TOOL 4: Custo acumulado
    // -------------------------------------------------------
    server.tool(
      "fal_session_cost",
      "Mostra o custo total acumulado nessa sessão + lista as últimas chamadas.",
      {},
      async () => ({
        content: [{ type: "text", text: tracker.format() }],
      })
    );

    // -------------------------------------------------------
    // TOOL 5: Detalhes de um modelo favorito
    // -------------------------------------------------------
    server.tool(
      "fal_model_info",
      "Detalhes de um modelo favorito específico: pricing, capabilities, aspect ratios suportados, defaults.",
      {
        model_id: z.string().describe(`ID do modelo (${Object.keys(FAVORITES).join(", ")})`),
      },
      async ({ model_id }) => {
        const m = getModel(model_id);
        const lines = [
          `📌 ${m.name} (${m.vendor}) — tier ${m.tier}`,
          `ID: ${m.id}`,
          `Docs: ${m.docs}`,
          ``,
          `Endpoints:`,
          m.endpoints.t2i ? `  • t2i: ${m.endpoints.t2i}` : `  • t2i: ❌`,
          m.endpoints.edit ? `  • edit: ${m.endpoints.edit}` : `  • edit: ❌`,
          ``,
          `Use cases: ${m.use_cases.join(", ")}`,
          ``,
          `Pricing:`,
          JSON.stringify(m.pricing, null, 2),
          ``,
          `Supports:`,
          JSON.stringify(m.supports, null, 2),
          ``,
          `Defaults:`,
          JSON.stringify(m.default_params, null, 2),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );
  },
  {
    // capabilities — opcional, fica vazio
  },
  {
    basePath: "/api",
    verboseLogs: false,
    maxDuration: 180,
  }
);

// ============================================================
// Wrapper de auth nos handlers HTTP
// ============================================================

async function withAuth(req: Request, fn: () => Promise<Response>): Promise<Response> {
  try {
    checkAuth(req);
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return fn();
}

export async function GET(req: Request) {
  return withAuth(req, () => handler(req));
}
export async function POST(req: Request) {
  return withAuth(req, () => handler(req));
}
export async function DELETE(req: Request) {
  return withAuth(req, () => handler(req));
}
