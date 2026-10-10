import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "**/dist-*/**",
      "node_modules",
      "**/*.d.ts",
      "eslint.config.js",
      "vitest.config.ts",
      "**/*.mjs",
      "**/*.cjs",
      "**/build.config.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Type-aware linting needs a tsconfig, and script files are not part of
    // any project. Without this override the typed rules throw while loading
    // and abort the entire run.
    //
    // Test doubles also have shapes the source rules assume away: adapter
    // stubs must be async to satisfy the interface, and fetch/WebSocket
    // mocks resolve without awaiting anything.
    files: ["**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
);
