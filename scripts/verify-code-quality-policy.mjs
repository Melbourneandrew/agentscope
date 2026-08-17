import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditCodeQualityPolicy } from "./code-quality-policy.mjs";
import { expectedWorkspacePackages } from "./workspace-packages.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const policy = JSON.parse(
  readFileSync(resolve(workspaceRoot, "quality-policy.json"), "utf8"),
);
const result = auditCodeQualityPolicy({
  workspaceRoot,
  expectedPackages: expectedWorkspacePackages,
  policy,
});
process.stdout.write(
  `Verified code-quality policy for ${result.packageCount} workspaces.\n`,
);
