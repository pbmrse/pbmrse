import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://pbmreserves.xyz", changeFrequency: "weekly", priority: 1 }];
}
