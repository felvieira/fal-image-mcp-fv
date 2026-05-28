import { config } from "./models";

// ============================================================
// Cliente HTTP minimal do fal.ai
// ============================================================
// Usa direto a Queue API (fal.run / queue.fal.run) sem o SDK
// oficial pra manter o bundle pequeno na Vercel.
// Docs: https://fal.ai/docs/documentation/model-apis/inference-methods
// ============================================================

const QUEUE_BASE = config.queue_base_url; // https://queue.fal.run
const SYNC_BASE = config.sync_base_url;   // https://fal.run

/** Resolve a FAL_KEY das env vars suportadas (sem lançar). */
function resolveFalKey(): string | undefined {
  return (
    process.env.FAL_KEY ??
    process.env.FAL_AI_API_KEY ??
    process.env.FAL_API_KEY
  );
}

/** True se há FAL_KEY configurada em runtime — usado pra fail-fast claro. */
function hasFalKey(): boolean {
  return Boolean(resolveFalKey());
}

/** Lê FAL_KEY em runtime (lazy) — falha rápido se ausente na chamada, não no boot. */
function getFalKey(): string {
  const key = resolveFalKey();
  if (!key) {
    throw new Error("FAL_KEY not configured on the server");
  }
  return key;
}

const AUTH_HEADER = () => ({
  Authorization: `Key ${getFalKey()}`,
  "Content-Type": "application/json",
});

// ============================================================
// Anti-SSRF: valida o endpoint controlado pelo usuário
// ============================================================
// O `endpoint` vem da tool do MCP (endpoint_id arbitrário). Sem validação,
// um valor como `../../foo`, uma URL absoluta ou path traversal poderia
// escapar do host do fal. Exige um path relativo do fal, ex:
//   `fal-ai/flux/dev`, `xai/grok-imagine-image`, `openai/gpt-image-2`,
//   `fal-ai/nano-banana/edit`, `.../text-to-image`.
// ============================================================

export function assertValidEndpoint(endpoint: string): void {
  if (!endpoint) {
    throw new Error("[fal-mcp] endpoint inválido: vazio.");
  }
  // path traversal
  if (endpoint.includes("..")) {
    throw new Error("[fal-mcp] endpoint inválido: contém '..'.");
  }
  // sem scheme (http://, https://, etc.) — deve ser path relativo
  if (endpoint.includes("://")) {
    throw new Error("[fal-mcp] endpoint inválido: não pode conter um scheme (://).");
  }
  // sem barra inicial — evita duplicação de host e URLs absolutas de path
  if (endpoint.startsWith("/")) {
    throw new Error("[fal-mcp] endpoint inválido: não pode começar com '/'.");
  }
  // apenas caracteres seguros — barras internas e sufixos como /edit são ok
  if (!/^[A-Za-z0-9/_.-]+$/.test(endpoint)) {
    throw new Error(
      "[fal-mcp] endpoint inválido: apenas [A-Za-z0-9/_.-] são permitidos."
    );
  }
}

// ============================================================
// Sanitiza corpos de erro vindos do upstream (fal)
// ============================================================
// Evita vazar tokens/keys e respostas gigantes pro cliente do MCP.
// Trunca em 500 chars e redige qualquer coisa parecida com bearer/key token.
// ============================================================

export function safeErrBody(text: string): string {
  if (!text) return "";
  const redacted = text
    .replace(/Key\s+[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "[redacted]");
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

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
  // 0. Valida o endpoint (anti-SSRF) e a key ANTES de qualquer fetch —
  //    falha rápido e com mensagem clara em vez de um erro críptico depois.
  assertValidEndpoint(endpoint);
  if (!hasFalKey()) {
    throw new Error("FAL_KEY not configured on the server");
  }

  const pollInterval = opts.pollIntervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 180_000; // 3min
  const started = Date.now();
  const logs: string[] = [];

  // 1. Submete pro queue — endpoint já validado, sem barra inicial duplicada
  const submitUrl = `${QUEUE_BASE}/${endpoint}`;
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: AUTH_HEADER(),
    body: JSON.stringify(input),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`fal submit failed (${submitRes.status}): ${safeErrBody(errText)}`);
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
      throw new Error(`fal status failed (${statusRes.status}): ${safeErrBody(errText)}`);
    }
    const status = (await statusRes.json()) as { status: string; logs?: { message: string }[] };
    if (status.logs?.length) logs.push(...status.logs.map((l) => l.message));

    if (status.status === "COMPLETED") {
      const dataRes = await fetch(response_url, { headers: AUTH_HEADER() });
      if (!dataRes.ok) {
        const errText = await dataRes.text();
        throw new Error(`fal result fetch failed (${dataRes.status}): ${safeErrBody(errText)}`);
      }
      const data = (await dataRes.json()) as FalSubscribeResult;
      return { data, request_id, logs };
    }

    if (status.status === "FAILED" || status.status === "ERROR") {
      throw new Error(`fal job failed: ${safeErrBody(JSON.stringify(status))}`);
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
  // Apenas formatos conhecidos acima. Sem fallback heurístico: varrer todos
  // os campos top-level atrás de qualquer .url pega a URL errada (ex:
  // request.url, seed_url). Se nada bater, retorna vazio em vez de adivinhar.
  return [];
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
  // Fail-fast claro: a catalog API também precisa da key. Lança ANTES do
  // try/catch pra não ser engolido pelo fallback que retorna [].
  if (!hasFalKey()) {
    throw new Error("FAL_KEY not configured on the server");
  }
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
