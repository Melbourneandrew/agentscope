import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateAcceptanceEvidence } from "./acceptance-evidence.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(
  readFileSync(resolve(workspaceRoot, "acceptance-evidence.json"), "utf8"),
);
const result = validateAcceptanceEvidence({
  manifest,
  requireVerified: process.argv.includes("--require-verified"),
  requirementsDirectory: resolve(
    workspaceRoot,
    "apps/docs/content/docs/requirements",
  ),
  workspaceRoot,
});

process.stdout.write(
  `Verified acceptance coverage: ${result.mandatory} mandatory, ${result.verified} verified, ${result.planned} planned.\n`,
);
