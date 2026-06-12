import modelsJson from "@/models.json";

type Model = {
  id: string;
  name: string;
  vendor: string;
  tier: string;
  pricing: {
    t2i_usd_per_image?: number | Record<string, number>;
    edit_usd_per_image?: number | Record<string, number>;
    t2i_usd_per_megapixel?: number;
    bg_remove_usd_per_image?: number;
    notes?: string;
  };
  use_cases: string[];
  supports: { t2i: boolean; edit: boolean; bg_remove?: boolean };
};

const config = modelsJson as unknown as {
  default_text_to_image: string;
  default_edit_image: string;
  models: Record<string, Model>;
  use_case_routing: Record<string, string>;
};

function priceLabel(m: Model): string {
  const mp = m.pricing.t2i_usd_per_megapixel;
  if (typeof mp === "number") return `$${mp.toFixed(4)}/MP`;
  const flat = m.pricing.t2i_usd_per_image;
  if (typeof flat === "number") return `$${flat.toFixed(3)}/img`;
  const bgRemove = m.pricing.bg_remove_usd_per_image;
  if (typeof bgRemove === "number") return `$${bgRemove.toFixed(3)}/img`;
  return "tiered";
}

const s = {
  page: { maxWidth: 760, margin: "0 auto", padding: "40px 20px 80px" } as React.CSSProperties,
  badge: { display: "inline-block", background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "2px 10px", fontSize: 13, color: "#888", marginBottom: 16 } as React.CSSProperties,
  h1: { fontSize: "clamp(28px,5vw,48px)", fontWeight: 700, lineHeight: 1.15, margin: "0 0 16px" } as React.CSSProperties,
  accent: { color: "#7c6df8" },
  lead: { fontSize: 18, color: "#aaa", margin: "0 0 32px", lineHeight: 1.6 } as React.CSSProperties,
  btnRow: { display: "flex", gap: 12, flexWrap: "wrap" as const, marginBottom: 48 },
  btnPrimary: { display: "inline-block", background: "#7c6df8", color: "#fff", borderRadius: 8, padding: "12px 24px", fontWeight: 600, fontSize: 15, textDecoration: "none" } as React.CSSProperties,
  btnSecondary: { display: "inline-block", background: "#1a1a1a", color: "#ededed", border: "1px solid #333", borderRadius: 8, padding: "12px 24px", fontWeight: 600, fontSize: 15, textDecoration: "none" } as React.CSSProperties,
  section: { marginBottom: 56 } as React.CSSProperties,
  h2: { fontSize: 24, fontWeight: 700, marginBottom: 16, borderBottom: "1px solid #222", paddingBottom: 8 } as React.CSSProperties,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 16 } as React.CSSProperties,
  card: { background: "#111", border: "1px solid #222", borderRadius: 10, padding: "16px 20px" } as React.CSSProperties,
  cardTitle: { fontWeight: 700, marginBottom: 4, fontSize: 15 } as React.CSSProperties,
  cardDesc: { color: "#888", fontSize: 13, lineHeight: 1.5 } as React.CSSProperties,
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 14 },
  th: { textAlign: "left" as const, padding: "8px 12px", borderBottom: "1px solid #222", color: "#888", fontWeight: 500 },
  td: { padding: "8px 12px", borderBottom: "1px solid #1a1a1a", verticalAlign: "top" as const },
  pre: { background: "#111", border: "1px solid #222", borderRadius: 8, padding: "16px 20px", overflowX: "auto" as const, fontSize: 13, lineHeight: 1.6 } as React.CSSProperties,
  code: { fontFamily: "monospace" },
  chip: { display: "inline-block", background: "#1f1a3a", color: "#a89cf0", borderRadius: 4, padding: "1px 7px", fontSize: 12, marginRight: 4 } as React.CSSProperties,
  chipGreen: { display: "inline-block", background: "#0f2a1a", color: "#4ade80", borderRadius: 4, padding: "1px 7px", fontSize: 12, marginRight: 4 } as React.CSSProperties,
};

export default function Home() {
  const models = Object.values(config.models);
  const defaultT2I = config.default_text_to_image;
  const defaultEdit = config.default_edit_image;

  return (
    <main style={s.page}>
      {/* Hero */}
      <div style={s.badge}>MCP · fal.ai · Vercel</div>
      <h1 style={s.h1}>
        Generate images from{" "}
        <span style={s.accent}>Claude & Cursor</span>
      </h1>
      <p style={s.lead}>
        One-click deploy → connect to any MCP client → generate images with 9 curated
        fal.ai models, per-call cost tracking, and background removal.
        <br />
        Text-to-image from <strong style={{ color: "#ededed" }}>$0.002/image</strong>.
      </p>
      <div style={s.btnRow}>
        <a
          href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffelvieira%2Ffal-image-mcp-fv&env=FAL_KEY,MCP_BEARER_TOKEN&envDescription=FAL_KEY%20from%20fal.ai%20dashboard.%20MCP_BEARER_TOKEN%20is%20a%20random%20string%20you%20generate.&envLink=https%3A%2F%2Fgithub.com%2Ffelvieira%2Ffal-image-mcp-fv%23env-vars"
          style={s.btnPrimary}
        >
          ▲ Deploy to Vercel
        </a>
        <a href="https://github.com/felvieira/fal-image-mcp-fv" style={s.btnSecondary}>
          GitHub →
        </a>
      </div>

      {/* Features */}
      <section style={s.section}>
        <h2 style={s.h2}>Features</h2>
        <div style={s.grid}>
          {[
            ["9 curated models", "flux-2-flash, grok-imagine, gemini-25-flash, gpt-image-* — configured in models.json"],
            ["Per-call cost tracking", "Every tool call reports the exact USD cost and the running session total."],
            ["Background removal", "Pixelcut integration with pre-flight transparency check — skips the call if the image is already transparent."],
            ["Dynamic catalog", "Search the full fal.ai public catalog for models outside the favorites list."],
            ["Secure by default", "Fail-closed Bearer auth, constant-time compare, anti-SSRF endpoint validation, per-session spend cap."],
            ["One-click deploy", "Vercel button — set two env vars and you're live in < 2 minutes."],
          ].map(([title, desc]) => (
            <div key={title} style={s.card}>
              <div style={s.cardTitle}>{title}</div>
              <div style={s.cardDesc}>{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Models table */}
      <section style={s.section}>
        <h2 style={s.h2}>Models</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>ID</th>
                <th style={s.th}>Model</th>
                <th style={s.th}>Price</th>
                <th style={s.th}>Caps</th>
                <th style={s.th}>Use for</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td style={s.td}>
                    <code style={s.code}>{m.id}</code>
                    {m.id === defaultT2I && (
                      <> <span style={s.chipGreen}>t2i default</span></>
                    )}
                    {m.id === defaultEdit && (
                      <> <span style={s.chip}>edit default</span></>
                    )}
                  </td>
                  <td style={{ ...s.td, color: "#ccc" }}>{m.name}<br /><span style={{ color: "#666", fontSize: 12 }}>{m.vendor}</span></td>
                  <td style={s.td}>{m.tier} {priceLabel(m)}</td>
                  <td style={s.td}>
                    {m.supports.t2i && <span style={s.chipGreen}>t2i</span>}
                    {m.supports.edit && <span style={s.chip}>edit</span>}
                    {m.supports.bg_remove && <span style={s.chip}>bg-remove</span>}
                  </td>
                  <td style={{ ...s.td, color: "#888", fontSize: 13 }}>{m.use_cases.slice(0, 2).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Connect snippets */}
      <section style={s.section}>
        <h2 style={s.h2}>Connect</h2>
        <p style={{ color: "#888", marginBottom: 16 }}>After deploying, connect your MCP client:</p>

        <p style={{ fontWeight: 600, marginBottom: 8 }}>Claude Code</p>
        <pre style={s.pre}><code>{`claude mcp add --transport http fal-image \\
  https://<your-deploy>.vercel.app/api/mcp \\
  --header "Authorization: Bearer <your MCP_BEARER_TOKEN>"`}</code></pre>

        <p style={{ fontWeight: 600, margin: "24px 0 8px" }}>Cursor (mcp.json)</p>
        <pre style={s.pre}><code>{`{
  "mcpServers": {
    "fal-image": {
      "url": "https://<your-deploy>.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer <your MCP_BEARER_TOKEN>" }
    }
  }
}`}</code></pre>

        <p style={{ fontWeight: 600, margin: "24px 0 8px" }}>claude.ai</p>
        <pre style={s.pre}><code>{`Settings → Connectors → Add custom connector
URL: https://<your-deploy>.vercel.app/api/mcp
Header: Authorization: Bearer <your MCP_BEARER_TOKEN>`}</code></pre>
      </section>

      {/* Tools */}
      <section style={s.section}>
        <h2 style={s.h2}>Tools</h2>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Tool</th>
              <th style={s.th}>What it does</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["fal_list_models", "Lists favorites + (optional) fal catalog, filters by mode"],
              ["fal_generate_image", "Text-to-image on any favorite or custom endpoint"],
              ["fal_edit_image", "Edit with 1+ reference images"],
              ["fal_remove_background", "Remove background → transparent PNG (Pixelcut). Skips already-transparent images."],
              ["fal_session_cost", "Accumulated cost + call history for this session"],
              ["fal_model_info", "Details (pricing, supports, defaults) for one favorite"],
            ].map(([tool, desc]) => (
              <tr key={tool}>
                <td style={s.td}><code style={s.code}>{tool}</code></td>
                <td style={{ ...s.td, color: "#aaa" }}>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Known limitations */}
      <section style={s.section}>
        <h2 style={s.h2}>Known limitations</h2>
        <ul style={{ color: "#888", lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
          <li><strong style={{ color: "#ccc" }}>tracker is in-memory</strong> — session cost resets on every serverless cold start. Wire Redis/Upstash KV into <code style={s.code}>lib/pricing.ts</code> to persist.</li>
          <li><strong style={{ color: "#ccc" }}>Non-favorite models don&apos;t compute cost</strong> — passing a custom <code style={s.code}>endpoint_id</code> shows &quot;Cost: unavailable&quot;. Add the model to <code style={s.code}>models.json</code> to cover it.</li>
          <li><strong style={{ color: "#ccc" }}>Simple auth</strong> — single bearer token. For multi-user setups, wire OAuth.</li>
        </ul>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid #222", paddingTop: 24, color: "#555", fontSize: 13 }}>
        <p>
          MIT License ·{" "}
          <a href="https://github.com/felvieira/fal-image-mcp-fv" style={{ color: "#7c6df8" }}>
            GitHub
          </a>{" "}
          · Built by{" "}
          <a href="https://github.com/felvieira" style={{ color: "#7c6df8" }}>
            Felipe Vieira
          </a>
        </p>
      </footer>
    </main>
  );
}
