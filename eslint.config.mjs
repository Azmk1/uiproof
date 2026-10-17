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
    // Generated comparison artifacts never need linting.
    ".uiproof/**",
    // The packaged CLI bundle `pnpm pack` builds from src — generated, not source.
    "dist/**",
  ]),
]);

export default eslintConfig;
