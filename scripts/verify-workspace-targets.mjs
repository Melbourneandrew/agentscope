import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedWorkspacePackages } from "./workspace-packages.mjs";
import {
  auditWorkspaceTargets,
  mandatoryWorkspaceTargets,
} from "./workspace-target-policy.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const audited = auditWorkspaceTargets({
  workspaceRoot,
  expectedPackages: expectedWorkspacePackages,
});

for (const workspace of audited) {
  process.stdout.write(
    `target-audit ${workspace.name} (${workspace.path}): ${mandatoryWorkspaceTargets.join(", ")}\n`,
  );
}
process.stdout.write(`Verified targets for ${audited.length} workspaces.\n`);
