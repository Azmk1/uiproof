import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Screenshots are run-scoped PNGs streamed from the local artifact API.
      // next/image would add a second optimiser pass over an already-final image.
      "@next/next/no-img-element": "off",
    },
  },
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // A separate Vite application with its own manifest, lockfile and preview server, used as a
    // repair fixture. It is not a Next.js project, so the Next.js rules (no-html-link-for-pages
    // among them) do not describe it: its router is the browser's, and `<a href>` is the route
    // change. `examples/next-app` deliberately stays linted — those rules do apply to it.
    "examples/vite-app/**",
    // Generated comparison artifacts never need linting.
    ".uiproof/**",
    // The packaged CLI bundle `pnpm pack` builds from src — generated, not source.
    "dist/**",
  ]),
]);

export default eslintConfig;
