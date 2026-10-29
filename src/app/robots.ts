import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: "https://pbmreserves.xyz/sitemap.xml",
    host: "https://pbmreserves.xyz",
  };
}
