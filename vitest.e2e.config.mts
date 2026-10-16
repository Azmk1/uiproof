import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Browser suite configuration.
 *
 * The suite drives a real production server (`next start`) against a throwaway data
 * directory, so it runs without file parallelism and with generous timeouts: every
 * comparison genuinely launches Chromium and diffs a megapixel image.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    globalSetup: ["e2e/support/setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
});
