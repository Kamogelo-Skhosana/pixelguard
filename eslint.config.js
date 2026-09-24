// ESLint flat config (ESLint 9+). Ticket: P003
// Formatting is handled by Prettier; eslint-config-prettier (last in the
// list) turns off any ESLint rules that would conflict with it.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow intentionally unused args/vars when prefixed with "_"
      // (used by not-yet-implemented ticket stubs).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettierConfig
);
