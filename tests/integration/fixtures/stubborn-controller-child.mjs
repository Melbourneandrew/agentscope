import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const evidencePath = process.env.AGENTSCOPE_SUPERVISOR_EVIDENCE;
if (evidencePath === undefined)
  throw new Error("integration.supervisor.evidence-required");
const descendant = spawn(
  "/bin/sh",
  ["-c", 'trap "" TERM; while :; do sleep 1; done'],
  { stdio: "ignore" },
);
if (!Number.isSafeInteger(descendant.pid) || descendant.pid < 1)
  throw new Error("integration.supervisor.fixture");
writeFileSync(evidencePath, String(descendant.pid));
process.exit(1);
