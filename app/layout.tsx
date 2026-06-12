import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "fal-image-mcp — fal.ai image generation for Claude, Cursor & MCP clients",
  description:
    "Remote MCP server. Generate images from any MCP client (Claude, Cursor, Claude Code) using fal.ai models. Deploy to Vercel in one click.",
  keywords: ["mcp", "model context protocol", "fal.ai", "image generation", "claude", "cursor", "anthropic"],
  authors: [{ name: "Felipe Vieira", url: "https://github.com/felvieira" }],
  openGraph: {
    title: "fal-image-mcp — Generate images from Claude & Cursor",
    description:
      "Remote MCP server for fal.ai. 9 curated image models, per-call cost tracking, one-click Vercel deploy.",
    type: "website",
    url: "https://github.com/felvieira/fal-image-mcp-fv",
    images: [
      {
        url: "https://opengraph.githubassets.com/1/felvieira/fal-image-mcp-fv",
        width: 1200,
        height: 600,
        alt: "fal-image-mcp",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "fal-image-mcp — Generate images from Claude & Cursor",
    description: "Remote MCP server for fal.ai. 9 curated models, cost tracking, one-click Vercel deploy.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif", background: "#0a0a0a", color: "#ededed" }}>
        {children}
      </body>
    </html>
  );
}
