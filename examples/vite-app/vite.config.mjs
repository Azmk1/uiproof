import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * A Vite application configured to run inside UIProof's repair sandbox.
 *
 * Two details matter for a container, and both are ordinary configuration rather than
 * test-only hooks:
 *
 *  · **The port and host come from the environment.** A sandbox registers one loopback URL
 *    (`http://127.0.0.1:4199`) and UIProof passes it as `PORT`/`HOST`, so the application
 *    binds where the sandbox expects it — in the container as well as on the host.
 *  · **Every cache lives inside the project.** The dependency volume mounted at
 *    `node_modules` is read-only (the patched application may not rewrite its own
 *    dependencies), so Vite's optimiser cache is redirected to a directory the build may
 *    write: `.vite-cache`, inside the sandbox copy, which is thrown away afterwards. The
 *    `--configLoader runner` flag in `package.json` is the same idea: it loads this file
 *    with Node instead of bundling it into a temporary file under `node_modules`, which a
 *    read-only mount does not permit.
 */
export default defineConfig({
  plugins: [react()],
  cacheDir: ".vite-cache",
  build: { outDir: "dist" },
  preview: {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4199),
    strictPort: true,
  },
});
