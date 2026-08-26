import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const expectedExports = [".", "./testing"];
const actualExports = Object.keys(manifest.exports ?? {}).sort();
if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports))
  throw new Error("claude-code artifact exports changed unexpectedly");

for (const file of ["dist/index.js", "dist/testing.js"])
  if (!existsSync(file)) throw new Error(`missing built entrypoint: ${file}`);

const root = readFileSync("dist/index.js", "utf8");
for (const testOnlyExport of [
  "CLAUDE_CODE_FIXTURE_ID",
  "claudeCodeComponentAdapter",
  "claudeCodeFixture",
  "claudeCodeScenario",
])
  if (root.includes(testOnlyExport))
    throw new Error(`test-only export escaped through root: ${testOnlyExport}`);

console.log("Verified Claude Code production/testing artifact boundary.");
