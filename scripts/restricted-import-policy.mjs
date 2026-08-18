import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const restrictedSpecifiers = [
  "@agentscope/protocol/core-finalization",
  "@agentscope/destinations-core/lifecycle-sink",
  "@agentscope/destinations-core/core-orchestration",
];
const destinationTestingSpecifier = "@agentscope/destinations-core/testing";
const testSource = /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[^.]+$/u;
const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const ignoredDirectories = new Set([
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const sourceFiles = (root) => {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name))
          pending.push(join(directory, entry.name));
      } else if (entry.isFile() && sourceExtension.test(entry.name)) {
        files.push(join(directory, entry.name));
      }
    }
  }
  return files;
};

export const auditCoreFinalizationImports = (
  workspaceRoot,
  expectedPackages,
) => {
  for (const [packagePath, packageName] of expectedPackages) {
    if (packageName === "@agentscope/core") continue;
    const root = join(workspaceRoot, packagePath);
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const restrictedSpecifier of restrictedSpecifiers)
        if (source.includes(restrictedSpecifier))
          throw new Error(
            `${restrictedSpecifier} is Core-only; forbidden import in ${relative(workspaceRoot, file)}`,
          );
      if (
        source.includes(destinationTestingSpecifier) &&
        packageName !== "@agentscope/testkit" &&
        !testSource.test(relative(workspaceRoot, file))
      )
        throw new Error(
          `${destinationTestingSpecifier} is test-only; forbidden import in ${relative(workspaceRoot, file)}`,
        );
    }
  }
};
