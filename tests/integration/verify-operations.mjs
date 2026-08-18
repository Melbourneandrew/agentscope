import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const artifactsRoot = resolve(workspaceRoot, "artifacts/integration");
const runsRoot = resolve(artifactsRoot, "runs");
const sentinel = resolve(
  workspaceRoot,
  "artifacts",
  `integration-host-sentinel-${process.pid}`,
);
const runDirectories = () =>
  new Set(
    existsSync(runsRoot)
      ? readdirSync(runsRoot, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? [entry.name] : [],
        )
      : [],
  );
const runOnce = () =>
  execute(process.execPath, [resolve(integrationRoot, "run-scenarios.mjs")], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      AGENTSCOPE_INTEGRATION_CONCURRENCY: "1",
      AGENTSCOPE_INTEGRATION_TIMEOUT_MS: "300000",
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 6 * 60 * 1000,
  });

mkdirSync(resolve(workspaceRoot, "artifacts"), { recursive: true });
writeFileSync(sentinel, "HOST_SENTINEL\n");
const before = runDirectories();
try {
  await runOnce();
  await Promise.all([runOnce(), runOnce()]);
  const created = [...runDirectories()].filter((name) => !before.has(name));
  if (created.length !== 3 || new Set(created).size !== created.length)
    throw new Error("integration.operations.repetition");
  for (const runId of created) {
    if (!/^[a-f\d]{16}$/u.test(runId))
      throw new Error("integration.operations.repetition");
    const directory = resolve(runsRoot, runId);
    const evidence = JSON.parse(
      readFileSync(resolve(directory, "evidence.json"), "utf8"),
    );
    if (evidence.runId !== runId || evidence.outcome !== "passed")
      throw new Error("integration.operations.repetition");
    for (const fileName of [
      "evidence.json",
      "model-ledger.json",
      "destination-ledger.json",
      "fixture-lifecycle.json",
    ]) {
      const path = resolve(directory, fileName);
      if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024)
        throw new Error("integration.operations.repetition");
    }
  }
  execFileSync(process.execPath, [resolve(integrationRoot, "clean.mjs")], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  if (readFileSync(sentinel, "utf8") !== "HOST_SENTINEL\n")
    throw new Error("integration.operations.sentinel");
  const resources = [
    ["container", "ls", "--all"],
    ["network", "ls"],
    ["image", "ls"],
  ].map(([kind, command, flag]) =>
    execFileSync(
      "docker",
      [
        kind,
        command,
        ...(flag ? [flag] : []),
        "--quiet",
        "--filter",
        "label=com.agentscope.integration=true",
      ],
      { encoding: "utf8" },
    ).trim(),
  );
  if (resources.some(Boolean))
    throw new Error("integration.operations.cleanup");
} finally {
  rmSync(sentinel, { force: true });
}
console.log(
  "Verified sequential and parallel isolation, bounded artifacts, and owned cleanup.",
);
