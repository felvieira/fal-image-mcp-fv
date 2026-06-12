import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://fal-image-mcp-fv.vercel.app/sitemap.xml",
  };
}
