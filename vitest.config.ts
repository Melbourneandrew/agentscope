import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = import.meta.dirname;
const packagePath = process.cwd().startsWith(`${workspaceRoot}/`)
  ? process.cwd().slice(workspaceRoot.length + 1)
  : "";
const policy = JSON.parse(
  readFileSync(resolve(workspaceRoot, "quality-policy.json"), "utf8"),
) as {
  packages: Record<
    string,
    {
      coverage?: {
        statements: number;
        branches: number;
        functions: number;
        lines: number;
      };
    }
  >;
};
const thresholds = policy.packages[packagePath]?.coverage;

export default defineConfig({
  root: process.cwd(),
  test: {
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "src/**/__tests__/**/*.{ts,tsx}",
      "scripts/__tests__/**/*.test.mjs",
    ],
    exclude: ["**/dist/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/**/__tests__/**",
        "src/**/*.d.ts",
      ],
      thresholds,
    },
  },
});
