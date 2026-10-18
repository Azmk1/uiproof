import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Benchmark configuration.
 *
 * Separate from both suites on purpose. The unit suite is trimmed for seconds; the browser
 * suite starts a production UIProof server for the console tests. The benchmark needs
 * neither — it drives the engines directly, in one process, with real containers and real
 * Chromium — and it takes as long as ten repairs take, so its timeouts are hours, not
 * seconds.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["benchmark/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
});
