import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  releaseEntryPoints,
  validateOfflineReleasePolicy,
} from "./release-lane/offline-policy.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = validateOfflineReleasePolicy({
  workspaceRoot,
  workflowPath: ".github/workflows/release-candidate-rehearsal.yml",
  scriptPaths: releaseEntryPoints,
});
process.stdout.write(
  `Verified offline release-lane authority: ${JSON.stringify(result)}\n`,
);
