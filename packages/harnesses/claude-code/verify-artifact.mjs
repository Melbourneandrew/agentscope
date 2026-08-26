import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const expectedExports = [".", "./testing"];
const actualExports = Object.keys(manifest.exports ?? {}).sort();
if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports))
  throw new Error("claude-code artifact exports changed unexpectedly");

for (const file of ["dist/index.js", "dist/testing.js"])
  if (!existsSync(file)) throw new Error(`missing built entrypoint: ${file}`);

const sortedKeys = (value) => Object.keys(value).sort();
const assertExactKeys = (label, value, expected) => {
  const actual = sortedKeys(value);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
    throw new Error(`${label} exports changed: ${actual.join(",")}`);
};

const rootModule = await import(pathToFileURL(resolve("dist/index.js")).href);
assertExactKeys("production root", rootModule, [
  "CLAUDE_CODE_COMPONENT_VERSION",
  "CLAUDE_CODE_DOCUMENTED_INTERFACES",
  "CLAUDE_CODE_EVIDENCE_SLOT",
  "CLAUDE_CODE_INTERNAL_AUTH_SENTINEL",
  "CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST",
  "CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST",
  "CLAUDE_CODE_LIFECYCLE_EVENTS",
  "CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID",
  "claudeCodeDescriptor",
  "claudeCodeHarnessPackageId",
  "createClaudeCodeExecutionEnvironment",
  "createClaudeCodeInstallationPlanner",
  "inspectClaudeCodePluginOverlap",
  "mapClaudeCodeCapture",
]);

const testingModule = await import(
  pathToFileURL(resolve("dist/testing.js")).href
);
assertExactKeys("testing entrypoint", testingModule, [
  "CLAUDE_CODE_FIXTURE_ID",
  "CLAUDE_CODE_SCENARIO_ID",
  "claudeCodeComponentAdapter",
  "claudeCodeContextEvidence",
  "claudeCodeFixture",
  "claudeCodeScenario",
  "runClaudeCodeHook",
]);

const relativeModulePattern = /(?:from\s*|import\s*)["'](\.[^"']+)["']/gu;
const rootGraph = new Set();
const visit = (file) => {
  const absolute = resolve(file);
  if (rootGraph.has(absolute)) return;
  rootGraph.add(absolute);
  const source = readFileSync(absolute, "utf8");
  for (const match of source.matchAll(relativeModulePattern))
    visit(resolve(dirname(absolute), match[1]));
};
visit("dist/index.js");

const actualGraph = [...rootGraph]
  .map((file) => relative(resolve("dist"), file))
  .sort();
const expectedGraph = [
  "descriptor.js",
  "execution.js",
  "index.js",
  "lifecycle.js",
  "mapping.js",
].sort();
if (JSON.stringify(actualGraph) !== JSON.stringify(expectedGraph))
  throw new Error(`production root graph changed: ${actualGraph.join(",")}`);

console.log("Verified Claude Code production/testing artifact boundary.");
