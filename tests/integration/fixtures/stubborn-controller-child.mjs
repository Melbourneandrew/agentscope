import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const escapeUnit = process.env.AGENTSCOPE_SUPERVISOR_ESCAPE_UNIT;
const escapeEvidence = process.env.AGENTSCOPE_SUPERVISOR_ESCAPE_EVIDENCE;
if ((escapeUnit === undefined) !== (escapeEvidence === undefined))
  throw new Error("integration.supervisor.escape-pair");
if (escapeUnit !== undefined) {
  if (!/^agentscope-escape-[a-f0-9]{32}\.service$/u.test(escapeUnit))
    throw new Error("integration.supervisor.escape-unit");
  const closedEnvironment = { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" };
  const systemUnit = spawnSync(
    "/usr/bin/sudo",
    [
      "-n",
      "--",
      "/usr/bin/systemd-run",
      `--unit=${escapeUnit}`,
      "--service-type=exec",
      "--property=RemainAfterExit=yes",
      "--",
      "/bin/sh",
      "-c",
      'trap "" TERM; while :; do sleep 1; done',
    ],
    { env: closedEnvironment, stdio: "ignore", timeout: 5_000 },
  );
  const userUnit = spawnSync(
    "/usr/bin/systemd-run",
    [
      "--user",
      `--unit=${escapeUnit}`,
      "--service-type=exec",
      "--property=RemainAfterExit=yes",
      "--",
      "/bin/sh",
      "-c",
      'trap "" TERM; while :; do sleep 1; done',
    ],
    { env: closedEnvironment, stdio: "ignore", timeout: 5_000 },
  );
  const cgroupMigration = spawnSync(
    "/bin/sh",
    ["-c", 'printf "%s" "$$" > /sys/fs/cgroup/cgroup.procs'],
    { env: closedEnvironment, stdio: "ignore", timeout: 5_000 },
  );
  writeFileSync(
    escapeEvidence,
    JSON.stringify({
      cgroupMigration: cgroupMigration.status === 0,
      systemUnit: systemUnit.status === 0,
      userUnit: userUnit.status === 0,
    }),
    { mode: 0o600 },
  );
}

const evidencePath = process.env.AGENTSCOPE_SUPERVISOR_EVIDENCE;
if (evidencePath === undefined)
  throw new Error("integration.supervisor.evidence-required");
const descendant = spawn(
  "/bin/sh",
  ["-c", 'trap "" TERM; while :; do sleep 1; done'],
  {
    detached: process.env.AGENTSCOPE_SUPERVISOR_DETACHED === "true",
    stdio: "ignore",
  },
);
if (!Number.isSafeInteger(descendant.pid) || descendant.pid < 1)
  throw new Error("integration.supervisor.fixture");
writeFileSync(evidencePath, String(descendant.pid));
process.exit(Number(process.env.AGENTSCOPE_SUPERVISOR_LEADER_EXIT ?? "1"));
