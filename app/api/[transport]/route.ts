import { createMcpHandler } from "@vercel/mcp-adapter";
import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import { z } from "zod";
import {
  FAVORITES,
  DEFAULT_MODEL,
  getModel,
  listFavorites,
  formatFavoritesList,
  config as modelsConfig,
} from "@/lib/models";
import { calculateCost, getTracker, type CostMode } from "@/lib/pricing";
import { falSubscribe, extractImageUrls, listFalCatalog, assertValidEndpoint, isImageAlreadyTransparent } from "@/lib/fal";
import { withAuth } from "@/lib/auth";

// ============================================================
// Per-session context
// ============================================================
// server.tool callbacks don't receive the raw Request, so they can't read a
// session id directly. We stash it in AsyncLocalStorage in the HTTP handler
// wrapper and read it back inside the tools (cost tracking is per-session).
// ============================================================

const sessionCtx = new AsyncLocalStorage<{ sessionId: string }>();

/**
 * Derives a stable session id from the request:
 *   1. `mcp-session-id` header if present (the MCP transport sets this)
 *   2. otherwise a sha256 hash of the `authorization` header (per-token bucket)
 *   3. otherwise the literal "anon"
 */
function sessionIdFromReq(req: Request): string {
  const explicit = req.headers.get("mcp-session-id");
  if (explicit) return explicit;

  const auth = req.headers.get("authorization");
  if (auth) return createHash("sha256").update(auth, "utf8").digest("hex");

  return "anon";
}

/** Resolves the SessionTracker for the current AsyncLocalStorage context. */
function currentTracker() {
  const sessionId = sessionCtx.getStore()?.sessionId ?? "anon";
  return getTracker(sessionId);
}

// ============================================================
// DRY helpers — shared by fal_generate_image and fal_edit_image
// ============================================================

type FavModel = typeof FAVORITES[string];

/** Builds the base fal payload, merging the model's default params. */
function buildFalInput(
  prompt: string,
  num_images: number,
  modelDef: FavModel | null,
  opts: {
    aspect_ratio?: string;
    image_size?: string;
    quality?: string;
    output_format?: string;
    extra_params?: Record<string, unknown>;
  }
): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt, num_images };
  if (opts.aspect_ratio) input.aspect_ratio = opts.aspect_ratio;
  if (opts.image_size) input.image_size = opts.image_size;
  if (opts.quality) input.quality = opts.quality;
  if (opts.output_format) input.output_format = opts.output_format;
  // Merge model defaults (without overwriting anything already set)
  if (modelDef?.default_params) {
    for (const [k, v] of Object.entries(modelDef.default_params)) {
      if (input[k] == null) input[k] = v;
    }
  }
  // Explicit caller overrides win
  if (opts.extra_params) Object.assign(input, opts.extra_params);
  return input;
}

/** Computes cost, records it on the per-session tracker, returns a formatted string. */
function recordAndFormatCost(
  modelDef: FavModel | null,
  mode: CostMode,
  num_images: number,
  input: Record<string, unknown>
): string {
  if (!modelDef) return "Cost: unavailable (model is outside the favorites list)";
  const cost = calculateCost({
    model: modelDef,
    mode,
    num_images,
    quality: typeof input.quality === "string" ? input.quality : undefined,
    image_size: typeof input.image_size === "string" ? input.image_size : undefined,
  });
  const tracker = currentTracker();
  tracker.record(modelDef.id, mode, num_images, cost);
  return (
    `💰 Cost: $${cost.total_usd.toFixed(4)} ` +
    `($${cost.per_image_usd.toFixed(4)}/img × ${num_images}, key=${cost.pricing_key})\n` +
    `   Session: $${tracker.total.toFixed(4)} (${tracker.calls.length} calls)`
  );
}

/** Infers an image MIME type from the URL extension, defaulting to image/png. */
function mimeFromUrl(url: string): string {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  return "image/png";
}

// ============================================================
// Handler
// ============================================================

const handler = createMcpHandler(
  (server) => {
    // -------------------------------------------------------
    // TOOL 1: List models (favorites + fal catalog)
    // -------------------------------------------------------
    server.tool(
      "fal_list_models",
      "Lists the available image models. Shows the FAVORITES first (from the curated models.json), then optionally fetches more from the public fal.ai catalog. Filter by mode (t2i, edit, or all).",
      {
        mode: z
          .enum(["t2i", "edit", "all"])
          .default("all")
          .describe("Filter by capability: 't2i' = text-to-image only, 'edit' = image-to-image/edit only, 'all' = everything"),
        include_fal_catalog: z
          .boolean()
          .default(false)
          .describe("If true, also fetch additional models from the public fal.ai catalog (slower)"),
        catalog_limit: z.number().min(1).max(50).default(15).describe("How many extra models to fetch from the fal catalog"),
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
          extras = all.length ? `\n\n📚 Public fal catalog:${all.join("\n")}` : "\n\n(public catalog empty or unavailable)";
        }

        return {
          content: [
            {
              type: "text",
              text:
                `⭐ FAVORITES (${favCount} models, mode=${mode}):\n` +
                `Default: ${DEFAULT_MODEL}\n\n` +
                favLines +
                extras +
                `\n\nTip: use 'use_case_routing' from models.json to pick quickly:\n` +
                Object.entries(modelsConfig.use_case_routing)
                  .map(([k, v]) => `  • ${k} → ${v}`)
                  .join("\n"),
            },
          ],
        };
      }
    );

    // -------------------------------------------------------
    // TOOL 2: Text-to-Image (generate from scratch)
    // -------------------------------------------------------
    server.tool(
      "fal_generate_image",
      "Generates an image from scratch out of a text prompt. Uses a favorite model (pass model_id) or an arbitrary fal endpoint (pass endpoint_id directly). ALWAYS reports the call cost and the running session total.",
      {
        prompt: z.string().min(1).describe("Text description of the desired image"),
        model_id: z
          .string()
          .optional()
          .describe(`Favorite model ID (${Object.keys(FAVORITES).join(", ")}). Default: ${DEFAULT_MODEL}`),
        endpoint_id: z
          .string()
          .optional()
          .describe("Arbitrary fal endpoint (e.g. 'fal-ai/flux/dev'). Use this for a model outside the favorites. Takes priority over model_id."),
        num_images: z.number().min(1).max(4).default(1).describe("Number of images to generate (1-4)"),
        aspect_ratio: z
          .string()
          .optional()
          .describe("E.g. '1:1', '16:9', '9:16'. Used by models that accept aspect_ratio."),
        image_size: z
          .string()
          .optional()
          .describe("E.g. '1024x1024', 'square_hd', 'landscape_16_9'. Used by models that accept image_size."),
        quality: z
          .enum(["auto", "low", "medium", "high"])
          .optional()
          .describe("For models with quality tiers (gpt-image-1/1.5/2/mini). Default varies by model."),
        output_format: z.enum(["jpeg", "png", "webp"]).optional().describe("Output image format. Used by models that accept output_format."),
        extra_params: z
          .record(z.any())
          .optional()
          .describe("Extra params passed straight into the fal request body (override). Use for model-specific options (negative_prompt, seed, safety_tolerance, etc)."),
      },
      async (args) => {
        // ----- Resolve model + endpoint -----
        let endpoint: string;
        let modelLabel: string;
        let pricingModel: typeof FAVORITES[string] | null = null;

        if (args.endpoint_id) {
          endpoint = args.endpoint_id;
          modelLabel = `[custom] ${args.endpoint_id}`;
        } else {
          const id = args.model_id ?? DEFAULT_MODEL;
          const m = getModel(id);
          if (!m.endpoints.t2i) throw new Error(`Model ${id} does not support text-to-image (no t2i endpoint).`);
          endpoint = m.endpoints.t2i;
          modelLabel = `${m.name} (${id})`;
          pricingModel = m;
        }

        // ----- Anti-SSRF: validate the (possibly user-supplied) endpoint -----
        assertValidEndpoint(endpoint);

        // ----- Build input -----
        const input = buildFalInput(args.prompt, args.num_images, pricingModel, {
          aspect_ratio: args.aspect_ratio,
          image_size: args.image_size,
          quality: args.quality,
          output_format: args.output_format,
          extra_params: args.extra_params,
        });

        // ----- Call fal -----
        const start = Date.now();
        const { data, request_id } = await falSubscribe(endpoint, input);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);

        // ----- Extract URLs + cost -----
        const urls = extractImageUrls(data);
        const costStr = recordAndFormatCost(pricingModel, "t2i", args.num_images, input);

        return {
          content: [
            {
              type: "text",
              text:
                `✅ Generated ${urls.length} image(s) in ${elapsed}s\n` +
                `Model: ${modelLabel}\n` +
                `Endpoint: ${endpoint}\n` +
                `Request ID: ${request_id}\n` +
                costStr +
                `\n\nURLs:\n${urls.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`,
            },
            ...urls.map((url) => ({
              type: "image" as const,
              data: url,
              mimeType: mimeFromUrl(url),
            })),
          ],
        };
      }
    );

    // -------------------------------------------------------
    // TOOL 3: Image edit (edit with a reference image)
    // -------------------------------------------------------
    server.tool(
      "fal_edit_image",
      "Edits/transforms an existing image using a text prompt + reference image(s). Accepts 1+ reference URLs (the limit varies by model). ALWAYS reports the cost.",
      {
        prompt: z.string().min(1).describe("What you want to change/add/transform"),
        image_urls: z
          .array(z.string().url())
          .min(1)
          .describe("URL(s) of the reference image(s). Most models accept 1; some (gemini-25-flash, gpt-image-1-mini/1.5) accept up to 4."),
        model_id: z
          .string()
          .optional()
          .describe(`Favorite model ID that supports editing (${Object.values(FAVORITES).filter((m) => m.supports.edit).map((m) => m.id).join(", ")})`),
        endpoint_id: z.string().optional().describe("Arbitrary fal edit/image-to-image endpoint. Overrides model_id."),
        num_images: z.number().min(1).max(4).default(1).describe("Number of output images to generate (1-4)"),
        aspect_ratio: z.string().optional().describe("E.g. '1:1', '16:9', '9:16'. Used by models that accept aspect_ratio."),
        image_size: z.string().optional().describe("E.g. '1024x1024', 'square_hd', 'landscape_16_9'. Used by models that accept image_size."),
        quality: z.enum(["auto", "low", "medium", "high"]).optional().describe("For models with quality tiers. Default varies by model."),
        output_format: z.enum(["jpeg", "png", "webp"]).optional().describe("Output image format. Used by models that accept output_format."),
        extra_params: z.record(z.any()).optional().describe("Extra params passed straight into the fal request body (override). Use for model-specific options."),
      },
      async (args) => {
        // ----- Resolve endpoint -----
        let endpoint: string;
        let modelLabel: string;
        let pricingModel: typeof FAVORITES[string] | null = null;

        if (args.endpoint_id) {
          endpoint = args.endpoint_id;
          modelLabel = `[custom] ${args.endpoint_id}`;
        } else {
          const id = args.model_id ?? (modelsConfig.default_edit_image ?? "gemini-25-flash");
          const m = getModel(id);
          if (!m.supports.edit || !m.endpoints.edit) throw new Error(`Model ${id} does not support image editing.`);
          endpoint = m.endpoints.edit;
          modelLabel = `${m.name} (${id})`;
          pricingModel = m;
        }

        // ----- Anti-SSRF: validate the (possibly user-supplied) endpoint -----
        assertValidEndpoint(endpoint);

        // ----- Validate the number of reference images -----
        if (pricingModel?.supports.max_reference_images != null) {
          const max = pricingModel.supports.max_reference_images;
          if (args.image_urls.length > max) {
            throw new Error(
              `Model ${pricingModel.id} accepts at most ${max} reference image(s). You passed ${args.image_urls.length}.`
            );
          }
        }

        // ----- Build input -----
        // fal convention: edit endpoints accept image_url (string) OR image_urls (array).
        // We send both when there's a single ref; models ignore the format they don't use.
        const input = buildFalInput(args.prompt, args.num_images, pricingModel, {
          aspect_ratio: args.aspect_ratio,
          image_size: args.image_size,
          quality: args.quality,
          output_format: args.output_format,
          extra_params: args.extra_params,
        });
        if (args.image_urls.length === 1) {
          input.image_url = args.image_urls[0];
        }
        input.image_urls = args.image_urls;

        // ----- Call fal -----
        const start = Date.now();
        const { data, request_id } = await falSubscribe(endpoint, input);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);

        // ----- Extract URLs + cost -----
        const urls = extractImageUrls(data);
        const costStr = recordAndFormatCost(pricingModel, "edit", args.num_images, input);

        return {
          content: [
            {
              type: "text",
              text:
                `✅ Edited into ${urls.length} image(s) in ${elapsed}s\n` +
                `Model: ${modelLabel}\n` +
                `Endpoint: ${endpoint}\n` +
                `References: ${args.image_urls.length}\n` +
                `Request ID: ${request_id}\n` +
                costStr +
                `\n\nResult URLs:\n${urls.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`,
            },
            ...urls.map((url) => ({
              type: "image" as const,
              data: url,
              mimeType: mimeFromUrl(url),
            })),
          ],
        };
      }
    );

    // -------------------------------------------------------
    // TOOL 3b: Background removal (cutout)
    // -------------------------------------------------------
    server.tool(
      "fal_remove_background",
      "Removes the background from an image, returning a transparent cutout (PNG/rgba by default). Powered by Pixelcut — ideal for product photos and e-commerce. Takes a single image URL (no prompt). ALWAYS reports the cost.",
      {
        image_url: z.string().url().describe("URL of the image to remove the background from (JPEG or PNG)."),
        model_id: z
          .string()
          .optional()
          .describe(`Favorite model ID that supports bg removal. Default: ${modelsConfig.use_case_routing?.remove_background_DEFAULT ?? "pixelcut-bg-remove"}`),
        endpoint_id: z.string().optional().describe("Arbitrary fal background-removal endpoint. Overrides model_id."),
        output_format: z
          .enum(["rgba", "alpha", "zip"])
          .optional()
          .describe("rgba = transparent PNG (default), alpha = mask only, zip = packaged result."),
        force: z
          .boolean()
          .default(false)
          .describe("If false (default), skips the paid call when the image already looks transparent (saves ~$0.016). Set true to remove anyway."),
        extra_params: z.record(z.any()).optional().describe("Extra params passed straight into the fal request body (override)."),
      },
      async (args) => {
        // ----- Resolve endpoint -----
        let endpoint: string;
        let modelLabel: string;
        let pricingModel: typeof FAVORITES[string] | null = null;

        if (args.endpoint_id) {
          endpoint = args.endpoint_id;
          modelLabel = `[custom] ${args.endpoint_id}`;
        } else {
          const id = args.model_id ?? (modelsConfig.use_case_routing?.remove_background_DEFAULT ?? "pixelcut-bg-remove");
          const m = getModel(id);
          if (!m.supports.bg_remove || !m.endpoints.bg_remove) {
            throw new Error(`Model ${id} does not support background removal.`);
          }
          endpoint = m.endpoints.bg_remove;
          modelLabel = `${m.name} (${id})`;
          pricingModel = m;
        }

        // ----- Anti-SSRF: validate the (possibly user-supplied) endpoint -----
        assertValidEndpoint(endpoint);

        // ----- Pre-check: skip the paid call if the image is already transparent -----
        if (!args.force) {
          const transparent = await isImageAlreadyTransparent(args.image_url);
          if (transparent === true) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `⏭️  Skipped background removal — the image already looks transparent ` +
                    `(saved ~$0.016).\n` +
                    `Model would have been: ${modelLabel}\n` +
                    `Pass force: true to remove anyway.\n\n` +
                    `Image: ${args.image_url}`,
                },
                {
                  type: "image" as const,
                  data: args.image_url,
                  mimeType: mimeFromUrl(args.image_url),
                },
              ],
            };
          }
        }

        // ----- Build input -----
        const input: Record<string, unknown> = { image_url: args.image_url };
        if (args.output_format) input.output_format = args.output_format;
        if (pricingModel?.default_params) {
          for (const [k, v] of Object.entries(pricingModel.default_params)) {
            if (input[k] == null) input[k] = v;
          }
        }
        if (args.extra_params) Object.assign(input, args.extra_params);

        // ----- Call fal -----
        const start = Date.now();
        const { data, request_id } = await falSubscribe(endpoint, input);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);

        // ----- Extract URLs + cost -----
        const urls = extractImageUrls(data);
        const costStr = recordAndFormatCost(pricingModel, "bg_remove", 1, input);

        return {
          content: [
            {
              type: "text",
              text:
                `✅ Removed background in ${elapsed}s\n` +
                `Model: ${modelLabel}\n` +
                `Endpoint: ${endpoint}\n` +
                `Request ID: ${request_id}\n` +
                costStr +
                `\n\nResult URLs:\n${urls.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`,
            },
            ...urls.map((url) => ({
              type: "image" as const,
              data: url,
              mimeType: mimeFromUrl(url),
            })),
          ],
        };
      }
    );

    // -------------------------------------------------------
    // TOOL 4: Accumulated session cost
    // -------------------------------------------------------
    server.tool(
      "fal_session_cost",
      "Shows the total cost accumulated in this session plus a list of the most recent calls.",
      {},
      async () => ({
        content: [{ type: "text", text: currentTracker().format() }],
      })
    );

    // -------------------------------------------------------
    // TOOL 5: Details of a favorite model
    // -------------------------------------------------------
    server.tool(
      "fal_model_info",
      "Details of a specific favorite model: pricing, capabilities, supported aspect ratios, and defaults.",
      {
        model_id: z.string().describe(`Model ID (${Object.keys(FAVORITES).join(", ")})`),
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
    // capabilities — optional, left empty
  },
  {
    basePath: "/api",
    verboseLogs: false,
    maxDuration: 180,
  }
);

// ============================================================
// HTTP handlers — auth first, then run the MCP handler inside a
// per-session AsyncLocalStorage context so tools can read the session id.
// ============================================================

export async function GET(req: Request) {
  return withAuth(req, () => sessionCtx.run({ sessionId: sessionIdFromReq(req) }, () => handler(req)));
}
export async function POST(req: Request) {
  return withAuth(req, () => sessionCtx.run({ sessionId: sessionIdFromReq(req) }, () => handler(req)));
}
export async function DELETE(req: Request) {
  return withAuth(req, () => sessionCtx.run({ sessionId: sessionIdFromReq(req) }, () => handler(req)));
}
