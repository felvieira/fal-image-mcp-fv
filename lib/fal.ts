import { config } from "./models";

// ============================================================
// Cliente HTTP minimal do fal.ai
// ============================================================
// Usa direto a Queue API (fal.run / queue.fal.run) sem o SDK
// oficial pra manter o bundle pequeno na Vercel.
// Docs: https://fal.ai/docs/documentation/model-apis/inference-methods
// ============================================================

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.warn("[fal-mcp] FAL_KEY não configurada nas env vars.");
}

const QUEUE_BASE = config.queue_base_url; // https://queue.fal.run
const SYNC_BASE = config.sync_base_url;   // https://fal.run

const AUTH_HEADER = () => ({
  Authorization: `Key ${FAL_KEY}`,
  "Content-Type": "application/json",
});

// ============================================================
// Subscribe (síncrono — submete + polla até pronto)
// ============================================================

export type FalSubscribeResult = {
  images?: Array<{ url: string; content_type?: string; width?: number; height?: number }>;
  image?: { url: string };
  output_images?: string[];
  [k: string]: unknown;
};

export async function falSubscribe(
  endpoint: string,
  input: Record<string, unknown>,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<{ data: FalSubscribeResult; request_id: string; logs: string[] }> {
  const pollInterval = opts.pollIntervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 180_000; // 3min
  const started = Date.now();
  const logs: string[] = [];

  // 1. Submete pro queue
  const submitUrl = `${QUEUE_BASE}/${endpoint}`;
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: AUTH_HEADER(),
    body: JSON.stringify(input),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`fal submit failed (${submitRes.status}): ${errText}`);
  }

  const submitJson = (await submitRes.json()) as { request_id: string; status_url: string; response_url: string };
  const { request_id, status_url, response_url } = submitJson;
  logs.push(`Submitted request_id=${request_id}`);

  // 2. Pola status
  while (Date.now() - started < timeout) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const statusRes = await fetch(status_url, { headers: AUTH_HEADER() });
    if (!statusRes.ok) {
      const errText = await statusRes.text();
      throw new Error(`fal status failed (${statusRes.status}): ${errText}`);
    }
    const status = (await statusRes.json()) as { status: string; logs?: { message: string }[] };
    if (status.logs?.length) logs.push(...status.logs.map((l) => l.message));

    if (status.status === "COMPLETED") {
      const dataRes = await fetch(response_url, { headers: AUTH_HEADER() });
      if (!dataRes.ok) {
        const errText = await dataRes.text();
        throw new Error(`fal result fetch failed (${dataRes.status}): ${errText}`);
      }
      const data = (await dataRes.json()) as FalSubscribeResult;
      return { data, request_id, logs };
    }

    if (status.status === "FAILED" || status.status === "ERROR") {
      throw new Error(`fal job failed: ${JSON.stringify(status)}`);
    }
  }

  throw new Error(`fal timeout após ${timeout}ms — request_id=${request_id}`);
}

// ============================================================
// Extrai URLs de imagem do response (formato varia por modelo)
// ============================================================

export function extractImageUrls(data: FalSubscribeResult): string[] {
  if (Array.isArray(data.images) && data.images.length > 0) {
    return data.images.map((i) => i.url).filter(Boolean);
  }
  if (data.image?.url) return [data.image.url];
  if (Array.isArray(data.output_images)) return data.output_images;
  // fallback heurístico — procura qualquer .url em campos top-level
  const out: string[] = [];
  for (const v of Object.values(data)) {
    if (typeof v === "object" && v && "url" in v && typeof (v as any).url === "string") {
      out.push((v as any).url);
    }
  }
  return out;
}

// ============================================================
// Lista dinâmica da catalog API do fal
// ============================================================
// Usa /api/models se disponível. Se falhar, retorna [].
// ============================================================

export type FalCatalogModel = {
  endpoint_id: string;
  name: string;
  category?: string;
  description?: string;
};

export async function listFalCatalog(category?: string, limit = 30): Promise<FalCatalogModel[]> {
  try {
    const url = new URL("https://fal.ai/api/models");
    if (category) url.searchParams.set("category", category);
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url.toString(), { headers: AUTH_HEADER() });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: FalCatalogModel[] };
    return data.models ?? [];
  } catch {
    return [];
  }
}
