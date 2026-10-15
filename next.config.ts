import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright ships its own driver/browser binaries and must not be bundled by the
  // server compiler — it is required at runtime from node_modules instead.
  serverExternalPackages: ["playwright", "playwright-core"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
