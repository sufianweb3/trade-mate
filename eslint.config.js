import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "release/**",
      "**/release/**",
      "**/dist-electron/**",
      "**/staging/**",
      "**/.cache/**",
      "**/out/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  {
    // Rule from CLAUDE.md: no paper/live branching outside execution/.
    files: ["apps/agent/src/**/*.ts"],
    ignores: ["apps/agent/src/execution/**", "apps/agent/src/demo/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "BinaryExpression[operator=/^[!=]==$/] > Literal[value='paper']",
          message: "Mode branching belongs in execution/ only (one engine, two adapters).",
        },
      ],
    },
  },
);
