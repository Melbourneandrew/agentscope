import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditCoverageRatchet } from "./code-quality-policy.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baseArgument = process.argv.find((argument) =>
  argument.startsWith("--base="),
);
const base = baseArgument?.slice("--base=".length);
if (!base)
  throw new Error("Usage: verify-coverage-ratchet.mjs --base=<git-ref>");

const current = JSON.parse(
  readFileSync(resolve(workspaceRoot, "quality-policy.json"), "utf8"),
);
let baselineText;
try {
  baselineText = execFileSync("git", ["show", `${base}:quality-policy.json`], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch {
  process.stdout.write(
    `No quality-policy.json exists at ${base}; accepting the initial reviewed baseline.\n`,
  );
  process.exit(0);
}
auditCoverageRatchet(current, JSON.parse(baselineText));
process.stdout.write(`Coverage thresholds do not decrease from ${base}.\n`);
