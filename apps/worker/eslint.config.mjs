import globals from "globals";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The worker is Node, and render.ts also contains code that Playwright
    // runs inside the page, which is genuinely a browser.
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
]);
