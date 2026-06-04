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
// Pre-check de transparência (best-effort, sem libs de imagem)
// ============================================================
// O MCP roda serverless (Node) e recebe a imagem por URL. Pra evitar
// gastar $ removendo fundo de algo que já é transparente, baixamos os
// primeiros bytes e inspecionamos o header:
//   - JPEG (FF D8): nunca tem alpha → opaco.
//   - PNG: byte de color-type no IHDR (offset 25). 6=RGBA, 4=LA → pode ter
//     alpha; tRNS chunk em PNG indexado/paleta também indica transparência.
//   - WebP: chunk "VP8L" (lossless) com bit de alpha, ou "ALPH"/"VP8X" flag.
// Retorna true (provavelmente transparente) | false (opaco) | null (incerto).
// É header-level: detecta CAPACIDADE de alpha, não amostra pixels. Conservador
// — na dúvida (null) deixa seguir pro Pixelcut. Falsos-positivos de "tem canal
// mas é 100% opaco" são possíveis; aceitável porque o lado Python (com Pillow)
// faz o check completo de pixels quando há arquivo local.
// ============================================================

function detectTransparencyFromHeader(buf: Uint8Array): boolean | null {
  if (buf.length < 16) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return false;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  if (isPng) {
    // IHDR color type fica no offset 25 (8 sig + 4 len + 4 "IHDR" + 4 w + 4 h + 1 bitDepth)
    const colorType = buf[25];
    if (colorType === 6 || colorType === 4) return true; // RGBA / grayscale+alpha
    // PNG indexado (3) ou outros: procura um chunk tRNS nos bytes baixados
    if (indexOfChunk(buf, "tRNS") >= 0) return true;
    return false;
  }

  // WebP: "RIFF"...."WEBP"
  const isWebp =
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  if (isWebp) {
    // VP8X com flag de alpha (bit 0x10 no byte de flags) ou chunk ALPH presente
    if (indexOfChunk(buf, "ALPH") >= 0) return true;
    const vp8x = indexOfChunk(buf, "VP8X");
    if (vp8x >= 0 && vp8x + 8 < buf.length) {
      const flags = buf[vp8x + 8];
      return (flags & 0x10) !== 0;
    }
    // VP8L (lossless) byte de flags tem o bit de alpha (0x10) no 5º byte do payload
    const vp8l = indexOfChunk(buf, "VP8L");
    if (vp8l >= 0 && vp8l + 12 < buf.length) {
      return (buf[vp8l + 12] & 0x10) !== 0;
    }
    return null; // VP8 lossy sem ALPH = opaco, mas seja conservador
  }

  return null; // formato desconhecido
}

/** Acha o offset de um chunk FourCC ASCII no buffer (ex: "tRNS", "ALPH"). -1 se ausente. */
function indexOfChunk(buf: Uint8Array, fourcc: string): number {
  const a = fourcc.charCodeAt(0), b = fourcc.charCodeAt(1);
  const c = fourcc.charCodeAt(2), d = fourcc.charCodeAt(3);
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d) return i;
  }
  return -1;
}

/**
 * Baixa os primeiros bytes da imagem e checa se já é transparente.
 * Best-effort: qualquer falha (rede, formato) retorna null (não bloqueia).
 */
export async function isImageAlreadyTransparent(url: string): Promise<boolean | null> {
  // data URI: decodifica direto
  if (url.startsWith("data:")) {
    try {
      const b64 = url.split(",", 2)[1] ?? "";
      const bin = atob(b64);
      const bytes = new Uint8Array(Math.min(bin.length, 65536));
      for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
      return detectTransparencyFromHeader(bytes);
    } catch {
      return null;
    }
  }
  try {
    // Range request — só precisamos do header + chunks iniciais (64KB cobre tRNS/ALPH cedo)
    const res = await fetch(url, { headers: { Range: "bytes=0-65535" } });
    if (!res.ok && res.status !== 206) return null;
    const ab = await res.arrayBuffer();
    return detectTransparencyFromHeader(new Uint8Array(ab));
  } catch {
    return null;
  }
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
