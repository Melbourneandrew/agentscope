import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

const internalPackageBoundary = (groups, message) => [
  "error",
  { patterns: [{ group: groups, message }] },
];

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/out/**",
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.nx/**",
      ".beads/**",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: { globals: globals.node },
    plugins: { "import-x": importX },
    rules: {
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "import-x": importX },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
      "no-console": "error",
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}", "**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    files: ["packages/core/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": internalPackageBoundary(
        [
          "@agentscope/harness-*",
          "@agentscope/reporter-*",
          "@agentscope/destination-*",
          "@agentscope/cli",
        ],
        "Core is the lower-level shared layer; it must not import harness, destination, or CLI packages.",
      ),
    },
  },
  {
    files: [
      "packages/harness-*/src/**/*.{ts,tsx}",
      "packages/harnesses/*/src/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": internalPackageBoundary(
        ["@agentscope/reporter-*", "@agentscope/destination-*"],
        "Harnesses collect and normalize native evidence; they must not import destinations/reporters.",
      ),
    },
  },
  {
    files: [
      "packages/reporter-*/src/**/*.{ts,tsx}",
      "packages/destination-*/src/**/*.{ts,tsx}",
      "packages/destinations/*/src/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": internalPackageBoundary(
        ["@agentscope/harness-*"],
        "Destinations/reporters consume canonical traces; they must not import harness packages.",
      ),
    },
  },
  {
    files: ["apps/cli/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": internalPackageBoundary(
        ["@agentscope/*/src/*", "@agentscope/*/*/src/*"],
        "The CLI is the composition root: it may import first-party package public exports, never package internals.",
      ),
    },
  },
  eslintConfigPrettier,
);
