import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateLocalSqliteAlphaProfile } from "./local-sqlite-alpha-profile.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profile = JSON.parse(
  readFileSync(
    resolve(workspaceRoot, "release-profiles/local-sqlite-alpha-0.1.0.json"),
    "utf8",
  ),
);
const result = validateLocalSqliteAlphaProfile({
  profile,
  workspaceRoot,
  requireCertified: process.argv.includes("--require-certified"),
});
process.stdout.write(
  `Validated experimental Local SQLite 0.1.0 profile boundary: ${result.allowed} allowed, ${result.componentEvidence} with component evidence, ${result.deferred} deferred, ${result.stableCriteriaPreserved} stable criteria preserved; admission ${result.admission}.\n`,
);
