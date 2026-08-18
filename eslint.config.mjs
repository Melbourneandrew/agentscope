import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

const internalPackageBoundary = (groups, message) => [
  "error",
  { patterns: [{ group: groups, message }] },
];

const packageRoleBoundary = (
  allowed,
  message,
  allowCoreFinalization = false,
  allowDestinationOrchestration = false,
) => [
  "error",
  {
    patterns: [
      ...(!allowCoreFinalization
        ? [
            {
              group: ["@agentscope/protocol/core-finalization"],
              message:
                "Only Core may import the Protocol finalization authority.",
            },
          ]
        : []),
      ...(!allowDestinationOrchestration
        ? [
            {
              group: ["@agentscope/destinations-core/core-orchestration"],
              message:
                "Only Core may import destination orchestration authority.",
            },
          ]
        : []),
      {
        group: ["@agentscope/*/src/**", "@agentscope/*/*/src/**"],
        message:
          "Import another workspace only through an exported public entry point.",
      },
      {
        group: [
          "@agentscope/**",
          ...allowed.flatMap((name) => [`!${name}`, `!${name}/**`]),
        ],
        message,
      },
    ],
  },
];

const productionComplexityRules = {
  complexity: ["error", 30],
  "max-depth": ["error", 4],
  "max-lines-per-function": [
    "error",
    { max: 120, skipBlankLines: true, skipComments: true },
  ],
  "max-params": ["error", 5],
};

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/out/**",
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.nx/**",
      "packages/protocol/src/generated/otlp/**",
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
      ...productionComplexityRules,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
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
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/only-throw-error": "error",
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
      "no-restricted-imports": internalPackageBoundary(
        [
          "@agentscope/*/src/**",
          "@agentscope/*/*/src/**",
          "@agentscope/protocol/core-finalization",
          "@agentscope/destinations-core/core-orchestration",
        ],
        "Import another workspace only through an exported public entry point.",
      ),
      "no-console": "error",
      ...productionComplexityRules,
    },
  },
  {
    files: ["packages/protocol/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": packageRoleBoundary(
        [],
        "Protocol is the dependency root and must not import another Agentscope package.",
      ),
    },
  },
  {
    files: ["packages/core/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": packageRoleBoundary(
        ["@agentscope/protocol", "@agentscope/destinations-core"],
        "Core is the lower-level shared layer; it must not import harness, destination, or CLI packages.",
        true,
        true,
      ),
    },
  },
  {
    files: ["packages/destinations/core/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": packageRoleBoundary(
        ["@agentscope/protocol"],
        "Destination Core may depend only on Protocol.",
      ),
    },
  },
  {
    files: [
      "packages/harness-*/src/**/*.{ts,tsx}",
      "packages/harnesses/*/src/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": packageRoleBoundary(
        [
          "@agentscope/protocol",
          "@agentscope/core/harness-capture",
          "@agentscope/harnesses-core",
        ],
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
      "no-restricted-imports": packageRoleBoundary(
        ["@agentscope/protocol", "@agentscope/destinations-core"],
        "Destinations/reporters consume canonical traces; they must not import harness packages.",
      ),
    },
  },
  {
    files: ["packages/harnesses/core/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": packageRoleBoundary(
        ["@agentscope/protocol"],
        "Harness Core may depend only on Protocol.",
      ),
    },
  },
  {
    files: ["packages/testkit/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": packageRoleBoundary(
        [
          "@agentscope/protocol",
          "@agentscope/destinations-core",
          "@agentscope/harnesses-core",
        ],
        "Testkit may depend only on test-safe family contracts and Protocol.",
      ),
    },
  },
  {
    files: ["apps/cli/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": internalPackageBoundary(
        [
          "@agentscope/*/src/**",
          "@agentscope/*/*/src/**",
          "@agentscope/core/harness-capture",
          "@agentscope/protocol/core-finalization",
          "@agentscope/destinations-core/core-orchestration",
        ],
        "The CLI is the composition root: it may import first-party package public exports, never package internals or the transient harness-capture boundary.",
      ),
    },
  },
  eslintConfigPrettier,
);
