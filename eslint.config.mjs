import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Flat config. Linting is being adopted on an existing ~86k LOC codebase, so the
// baseline is deliberately narrow: correctness rules that catch real bugs are
// errors, everything stylistic is left to Prettier and everything merely
// unused is left to tsconfig (noUnusedLocals / noUnusedParameters).
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "dist-cli/**",
      "release/**",
      "artifacts/**",
      "node_modules/**",
      "build/**",
      "mobile/**",
      "cli/kcode-cli.cjs",
      "**/*.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // tsconfig already enforces these with better cross-file accuracy.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",

      // `any` is present in ~25 files today; surface it without blocking CI.
      "@typescript-eslint/no-explicit-any": "warn",

      // Real-bug rules.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-floating-promises": "off", // needs type info; see below
    },
  },

  // Renderer: React + browser globals + the hook rules that are the whole
  // reason for adopting ESLint here.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Node-side code: main process, CLI, build scripts, remote service.
  {
    files: [
      "electron/**/*.ts",
      "cli/**/*.ts",
      "scripts/**/*.mjs",
      "remote/**/*.{ts,mjs}",
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "no-console": "off",
    },
  },

  // Tests lean on loose typing and fixtures.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
