import { config } from "./models";


// ============================================================
// Anti-SSRF: valida URLs externas antes de fetch server-side
// ============================================================

/** Returns true if the URL is safe to fetch server-side (no SSRF). */
function isSafeExternalUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  const BLOCKED = [
    /^localhost$/,
    /^127\./,
    /^0\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^\[?::1\]?$/,
    /^\[?fc[0-9a-f]{2}:/,
    /^\[?fe80:/,
  ];
  return !BLOCKED.some((re) => re.test(host));
}

// ============================================================
// Minimal fal.ai HTTP client
// ============================================================
// Uses the Queue API (fal.run / queue.fal.run) directly, without
// the official SDK, to keep the Vercel bundle small.
// Docs: https://fal.ai/docs/documentation/model-apis/inference-methods
// ============================================================

const QUEUE_BASE = config.queue_base_url; // https://queue.fal.run

/** Resolves FAL_KEY from supported env vars (non-throwing). */
function resolveFalKey(): string | undefined {
  return (
    process.env.FAL_KEY ??
    process.env.FAL_AI_API_KEY ??
    process.env.FAL_API_KEY
  );
}

/** True if a FAL_KEY is configured at runtime — used for early fail-fast. */
function hasFalKey(): boolean {
  return Boolean(resolveFalKey());
}

/** Reads FAL_KEY at runtime (lazy) — fails fast if missing on call, not at boot. */
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
// Anti-SSRF: validates the user-controlled endpoint
// ============================================================
// The `endpoint` comes from the MCP tool (arbitrary endpoint_id). Without
// validation, a value like `../../foo`, an absolute URL, or a path traversal
// could escape the fal host. Requires a relative fal path, e.g.:
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
  // no scheme (http://, https://, etc.) — must be a relative path
  if (endpoint.includes("://")) {
    throw new Error("[fal-mcp] endpoint inválido: não pode conter um scheme (://).");
  }
  // no leading slash — avoids host duplication and absolute path URLs
  if (endpoint.startsWith("/")) {
    throw new Error("[fal-mcp] endpoint inválido: não pode começar com '/'.");
  }
  // only safe characters — internal slashes and suffixes like /edit are allowed
  if (!/^[A-Za-z0-9/_.-]+$/.test(endpoint)) {
    throw new Error(
      "[fal-mcp] endpoint inválido: apenas [A-Za-z0-9/_.-] são permitidos."
    );
  }
}

// ============================================================
// Sanitizes error bodies from upstream (fal)
// ============================================================
// Prevents leaking tokens/keys and huge responses to the MCP client.
// Truncates to 500 chars and redacts anything resembling a bearer/key token.
// ============================================================

export function safeErrBody(text: string): string {
  if (!text) return "";
  const redacted = text
    .replace(/Key\s+[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "[redacted]");
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

// ============================================================
// Subscribe (synchronous — submit + poll until done)
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
): Promise<{ data: FalSubscribeResult; request_id: string }> {
  // 0. Validate the endpoint (anti-SSRF) and the key BEFORE any fetch —
  //    fail fast with a clear message instead of a cryptic error later.
  assertValidEndpoint(endpoint);
  if (!hasFalKey()) {
    throw new Error("FAL_KEY not configured on the server");
  }

  const pollInterval = opts.pollIntervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 180_000; // 3min
  const started = Date.now();
  // 1. Submit to the queue — endpoint already validated, no leading slash duplicate
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
  // 2. Poll status
  while (Date.now() - started < timeout) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const statusRes = await fetch(status_url, { headers: AUTH_HEADER() });
    if (!statusRes.ok) {
      const errText = await statusRes.text();
      throw new Error(`fal status failed (${statusRes.status}): ${safeErrBody(errText)}`);
    }
    const status = (await statusRes.json()) as { status: string; logs?: { message: string }[] };
    if (status.status === "COMPLETED") {
      const dataRes = await fetch(response_url, { headers: AUTH_HEADER() });
      if (!dataRes.ok) {
        const errText = await dataRes.text();
        throw new Error(`fal result fetch failed (${dataRes.status}): ${safeErrBody(errText)}`);
      }
      const data = (await dataRes.json()) as FalSubscribeResult;
      return { data, request_id };
    }

    if (status.status === "FAILED" || status.status === "ERROR") {
      throw new Error(`fal job failed: ${safeErrBody(JSON.stringify(status))}`);
    }
  }

  throw new Error(`fal timeout após ${timeout}ms — request_id=${request_id}`);
}

// ============================================================
// Transparency pre-check (best-effort, no image libraries)
// ============================================================
// The MCP runs serverless (Node) and receives the image by URL. To avoid
// spending money removing the background of an already-transparent image,
// we download the first bytes and inspect the header:
//   - JPEG (FF D8): never has alpha → opaque.
//   - PNG: color-type byte in IHDR (offset 25). 6=RGBA, 4=LA → may have
//     alpha; a tRNS chunk in an indexed/palette PNG also signals transparency.
//   - WebP: "VP8L" (lossless) chunk with alpha bit, or "ALPH"/"VP8X" flag.
// Returns true (probably transparent) | false (opaque) | null (uncertain).
// Header-level: detects alpha CAPABILITY, does not sample pixels. Conservative
// — on doubt (null) lets the Pixelcut call proceed. False-positives ("has alpha
// channel but is 100% opaque") are possible; acceptable because the Python side
// (Pillow) does a full pixel check when a local file is available.
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
    // IHDR color type is at offset 25 (8 sig + 4 len + 4 "IHDR" + 4 w + 4 h + 1 bitDepth)
    const colorType = buf[25];
    if (colorType === 6 || colorType === 4) return true; // RGBA / grayscale+alpha
    // Indexed PNG (3) or others: look for a tRNS chunk in the downloaded bytes
    if (indexOfChunk(buf, "tRNS") >= 0) return true;
    return false;
  }

  // WebP: "RIFF"...."WEBP"
  const isWebp =
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  if (isWebp) {
    // VP8X with alpha flag (bit 0x10 in the flags byte) or ALPH chunk present
    if (indexOfChunk(buf, "ALPH") >= 0) return true;
    const vp8x = indexOfChunk(buf, "VP8X");
    if (vp8x >= 0 && vp8x + 8 < buf.length) {
      const flags = buf[vp8x + 8];
      return (flags & 0x10) !== 0;
    }
    // VP8L (lossless) flags byte has the alpha bit (0x10) in the 5th byte of the payload
    const vp8l = indexOfChunk(buf, "VP8L");
    if (vp8l >= 0 && vp8l + 12 < buf.length) {
      return (buf[vp8l + 12] & 0x10) !== 0;
    }
    return null; // VP8 lossy without ALPH = opaque, but stay conservative
  }

  return null; // unknown format
}

/** Finds the offset of an ASCII FourCC chunk in the buffer (e.g. "tRNS", "ALPH"). Returns -1 if absent. */
function indexOfChunk(buf: Uint8Array, fourcc: string): number {
  const a = fourcc.charCodeAt(0), b = fourcc.charCodeAt(1);
  const c = fourcc.charCodeAt(2), d = fourcc.charCodeAt(3);
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d) return i;
  }
  return -1;
}

/**
 * Downloads the first bytes of the image and checks whether it is already transparent.
 * Best-effort: any failure (network, format) returns null (does not block the call).
 */
export async function isImageAlreadyTransparent(url: string): Promise<boolean | null> {
  // data URI: decode inline
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
  // Anti-SSRF: silently skip private/loopback URLs
  if (!isSafeExternalUrl(url)) return null;
  try {
    // Range request — we only need the header + initial chunks (64 KB covers tRNS/ALPH early)
    const res = await fetch(url, { headers: { Range: "bytes=0-65535" } });
    if (!res.ok && res.status !== 206) return null;
    const ab = await res.arrayBuffer();
    return detectTransparencyFromHeader(new Uint8Array(ab));
  } catch {
    return null;
  }
}

// ============================================================
// Extract image URLs + MIME types from a fal response
// ============================================================
// Format varies by model. Propagates the real content_type when available.
// ============================================================

export type ImageResult = { url: string; mimeType: string };

function mimeFromUrl(url: string): string {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  return "image/png";
}

export function extractImageUrls(data: FalSubscribeResult): ImageResult[] {
  if (Array.isArray(data.images) && data.images.length > 0) {
    return data.images
      .filter((i) => Boolean(i.url))
      .map((i) => ({ url: i.url, mimeType: i.content_type ?? mimeFromUrl(i.url) }));
  }
  if (data.image?.url) {
    return [{ url: data.image.url, mimeType: mimeFromUrl(data.image.url) }];
  }
  if (Array.isArray(data.output_images)) {
    return (data.output_images as string[]).map((url) => ({ url, mimeType: mimeFromUrl(url) }));
  }
  // Only the known formats above. No heuristic fallback: scanning all
  // top-level fields for any .url would pick the wrong URL (e.g.
  // request.url, seed_url). If nothing matches, return empty instead of guessing.
  return [];
}

// ============================================================
// Dynamic listing from the fal catalog API
// ============================================================
// Uses /api/models if available. Falls back to [] on any failure.
// ============================================================

export type FalCatalogModel = {
  endpoint_id: string;
  name: string;
  category?: string;
  description?: string;
};

export async function listFalCatalog(category?: string, limit = 30): Promise<FalCatalogModel[]> {
  // Clear fail-fast: the catalog API also requires the key. Throws BEFORE the
  // try/catch so the error is not swallowed by the fallback that returns [].
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
