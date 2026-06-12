# fal-image-mcp-fv

Remote **MCP server** for [fal.ai](https://fal.ai) image models. Connect it to Claude, Cursor, or any MCP client and generate images with curated favorites, dynamic catalog search, and per-call cost tracking.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffelvieira%2Ffal-image-mcp-fv&env=FAL_KEY,MCP_BEARER_TOKEN&envDescription=FAL_KEY%20from%20fal.ai%20dashboard.%20MCP_BEARER_TOKEN%20is%20a%20random%20string%20you%20generate.&envLink=https%3A%2F%2Fgithub.com%2Ffelvieira%2Ffal-image-mcp-fv%23env-vars)

## Features

- **9 curated image models** ready to go (configurable in `models.json`): `flux-2-flash`, `grok-imagine`, `gemini-25-flash`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-2`, `gemini-3-pro`, `pixelcut-bg-remove`
- **Dynamic catalog search** for any other fal.ai model
- **Per-call cost calculation** — handles complex pricing tables (quality × size)
- **Session cost accumulator** — see total spend per session
- **Separate tools** for text-to-image and edit (filters compatible models)

## Stack

- Next.js 15 (App Router) + TypeScript
- `@vercel/mcp-adapter` (Streamable HTTP transport)
- No heavy SDK — calls fal Queue API directly via `fetch`

## Exposed tools

| Tool                  | What it does                                                  |
| --------------------- | ------------------------------------------------------------- |
| `fal_list_models`     | Lists favorites + (optional) fal catalog, filters by mode     |
| `fal_generate_image`  | Text-to-image on any favorite or custom endpoint              |
| `fal_edit_image`      | Edit with 1+ reference images                                 |
| `fal_remove_background` | Remove background → transparent cutout (Pixelcut). Skips already-transparent images to save cost (`force` to override) |
| `fal_session_cost`    | Accumulated cost + call history                               |
| `fal_model_info`      | Details (pricing, supports, defaults) for one favorite        |

## Quick deploy (recommended)

Click the **Deploy with Vercel** button above. Vercel will prompt you for two env vars:

- `FAL_KEY` — get one at https://fal.ai/dashboard/keys
- `MCP_BEARER_TOKEN` — any random string (used to authenticate MCP requests). Generate one with `openssl rand -hex 32` or just type something long.

After deploy, your MCP endpoint will be at `https://<your-deploy>.vercel.app/api/mcp`.

## Manual setup (local dev or custom host)

```bash
git clone https://github.com/felvieira/fal-image-mcp-fv.git
cd fal-image-mcp-fv
npm install
cp .env.example .env.local
# edit .env.local with your FAL_KEY and a MCP_BEARER_TOKEN
npm run dev
# server running at http://localhost:3000/api/mcp
```

For production hosting on your own Vercel:

```bash
npm i -g vercel
vercel
# accept defaults
# set env vars at https://vercel.com/<you>/<project>/settings/environment-variables
vercel --prod
```

## Env vars

| Name                | Required | What it is                                                              |
| ------------------- | -------- | ----------------------------------------------------------------------- |
| `FAL_KEY`           | yes      | Your fal.ai API key (https://fal.ai/dashboard/keys)                     |
| `MCP_BEARER_TOKEN`  | yes      | Random string — clients pass it as `Authorization: Bearer <token>`      |

## Connecting clients

### claude.ai

1. Settings → Connectors → **Add custom connector**
2. URL: `https://<your-deploy>.vercel.app/api/mcp`
3. Custom header: `Authorization: Bearer <your MCP_BEARER_TOKEN>`
4. Save → Enable

### Claude Code

```bash
claude mcp add --transport http fal-image \
  https://<your-deploy>.vercel.app/api/mcp \
  --header "Authorization: Bearer <your MCP_BEARER_TOKEN>"
```

### Cursor

`mcp.json`:

```json
{
  "mcpServers": {
    "fal-image": {
      "url": "https://<your-deploy>.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer <your MCP_BEARER_TOKEN>"
      }
    }
  }
}
```

## Usage examples (after connecting)

> "List the edit models I have as favorites"
→ `fal_list_models({ mode: "edit" })`

> "Generate a cinematic hero cover for a blog post about AI"
→ `fal_generate_image({ prompt: "...", model_id: "gemini-25-flash", aspect_ratio: "16:9" })`
→ Cost: $0.0390 (session: $0.0390)

> "Take this photo [URL] and make it watercolor style"
→ `fal_edit_image({ prompt: "watercolor painting style", image_urls: ["..."], model_id: "gemini-25-flash" })`
→ Cost: $0.0390 (session: $0.0780)

> "Remove the background from this product photo [URL]"
→ `fal_remove_background({ image_url: "..." })`
→ Transparent PNG cutout · Cost: $0.0160 (session: $0.0940)
→ (if the image already looks transparent, it's skipped to save ~$0.016 — pass `force: true` to remove anyway)

> "How much have I spent so far?"
→ `fal_session_cost` → 💰 Total: $0.0940, 3 calls

> "Show me gpt-image-2 details"
→ `fal_model_info({ model_id: "gpt-image-2" })`

## Updating the favorite models list

Edit `models.json` in the repo root. After editing, redeploy:

```bash
vercel --prod
```

## How cost calculation works

`calculateCost` in `lib/pricing.ts` handles:

1. **Fixed price** (number): `grok-imagine` → $0.020/img, `gemini-25-flash` → $0.039/img
2. **Pricing table by quality × size** (object):
   - Tries to match `{quality}_{width}x{height}` (e.g. `high_1024x1536`)
   - Falls back to `{quality}_1024` if size is 1024×1024
   - Falls back to `{quality}_other`
   - Returns 0 + note if nothing matches

Models with complex pricing: `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`.

## Cost per model (quick reference)

| Model             | Tier | t2i fixed | edit fixed | Notes                                       |
| ----------------- | ---- | --------- | ---------- | ------------------------------------------- |
| grok-imagine      | $    | $0.020    | $0.022     | Cheapest; varied aspect ratios              |
| gemini-25-flash   | $    | $0.039    | $0.039     | Default; up to 4 refs in edit               |
| gpt-image-1-mini  | $    | varies    | varies     | low_1024 = $0.005; very cheap in low        |
| gpt-image-1.5     | $$$  | varies    | varies     | high_1024 = $0.133; high_1024x1536 = $0.200 |
| gpt-image-1       | $$$  | varies    | varies     | legacy; prefer 1.5/mini                     |
| gpt-image-2       | $$$  | varies    | ❌         | t2i only; 4K = $0.401 in high               |
| gemini-3-pro      | $$$  | $0.150    | $0.150     | Nano Banana Pro; 4K doubles                 |
| flux-2-flash      | $    | $0.005/MP | ❌         | Cheapest t2i; ~$0.002–0.012/img depending on size |
| pixelcut-bg-remove | $   | ❌        | ❌         | bg removal only: $0.016/img |

## Known limitations

- **`tracker` is in-memory**: session cost resets on every serverless cold start. To persist, wire Redis/Upstash KV into `lib/pricing.ts`.
- **Non-favorite models don't compute cost**: when you pass an `endpoint_id` directly, you'll see "Cost: unavailable". To cover it, add the model to `models.json`.
- **Simple auth**: single bearer token. For multi-user, wire OAuth.

## License

MIT — see [LICENSE](./LICENSE).

## Author

Felipe Vieira ([@felvieira](https://github.com/felvieira))
