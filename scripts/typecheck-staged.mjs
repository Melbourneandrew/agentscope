import { spawnSync } from "node:child_process";

const staged = spawnSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { encoding: "utf8" },
);
if (staged.status !== 0) {
  process.stderr.write(staged.stderr);
  process.exit(staged.status ?? 1);
}
const files = staged.stdout.split("\0").filter(Boolean);
if (files.length === 0) {
  process.stdout.write("No staged files require type checking.\n");
  process.exit(0);
}
const result = spawnSync(
  "pnpm",
  ["exec", "nx", "affected", "-t", "typecheck", `--files=${files.join(",")}`],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
