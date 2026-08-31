import { spawn } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = resolve(workspaceRoot, "scripts/__tests__");
const configPath = resolve(workspaceRoot, "vitest.config.ts");
const vitestPath = realpathSync(
  resolve(
    dirname(fileURLToPath(import.meta.resolve("vitest"))),
    "../vitest.mjs",
  ),
);

export const processAuthorityFiles = Object.freeze([
  "code-quality-policy.test.mjs",
  "validation-lease.test.mjs",
  "prepush.test.mjs",
]);

export const purePolicyFiles = Object.freeze([
  "acceptance-evidence.test.mjs",
  "crabbox-coordinator-plan.test.mjs",
  "crabbox-coordinator-profile.test.mjs",
  "crabbox-coordinator-retirement-profile.test.mjs",
  "release-lane-substrate.test.mjs",
  "restricted-import-policy.test.mjs",
  "review-skill.test.mjs",
  "workspace-dependency-policy.test.mjs",
  "workspace-policy-runner.test.mjs",
  "workspace-target-policy.test.mjs",
]);

const classificationsByName = new Map([
  ...purePolicyFiles.map((name) => [name, "pure"]),
  ...processAuthorityFiles.map((name) => [name, "authority"]),
]);
const forwardedSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const pureWorkerCeiling = 2;

function fail(message) {
  throw new Error(`workspace-policy scheduling rejected: ${message}`);
}

export function discoverWorkspacePolicyInventory(root = testRoot) {
  const canonicalRoot = realpathSync(root);
  const inventory = [];
  for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith(".test.mjs")) continue;
    if (!entry.isFile())
      fail(`test entry is not a regular file: ${entry.name}`);
    const path = resolve(canonicalRoot, entry.name);
    if (realpathSync(path) !== path)
      fail(`test path is not canonical: ${entry.name}`);
    inventory.push(entry.name);
  }
  return Object.freeze(inventory.sort());
}

export function classifyWorkspacePolicyInventory(inventory) {
  return inventory.map((name) => {
    const classification = classificationsByName.get(name);
    if (classification === undefined)
      fail(`test has no reviewed classification: ${name}`);
    return { classification, name };
  });
}

export function createWorkspacePolicyPlan(inventory, classifications) {
  if (!Array.isArray(inventory) || !Array.isArray(classifications))
    fail("inventory and classifications must be arrays");
  const expected = new Set();
  for (const name of inventory) {
    if (
      typeof name !== "string" ||
      !name.endsWith(".test.mjs") ||
      basename(name) !== name
    )
      fail("inventory contains an invalid test name");
    if (expected.has(name)) fail(`duplicate inventory entry: ${name}`);
    expected.add(name);
  }
  const classified = new Set();
  const pure = [];
  const authority = [];
  for (const record of classifications) {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.name !== "string"
    )
      fail("classification record is malformed");
    if (!expected.has(record.name))
      fail(`classification names an unknown test: ${record.name}`);
    if (classified.has(record.name))
      fail(`duplicate classification: ${record.name}`);
    classified.add(record.name);
    const expectedClassification = classificationsByName.get(record.name);
    if (expectedClassification === undefined)
      fail(`test has no reviewed classification: ${record.name}`);
    if (record.classification !== expectedClassification)
      fail(
        `test classification disagrees with reviewed policy: ${record.name}`,
      );
    if (record.classification === "pure") {
      pure.push(record.name);
    } else if (record.classification === "authority")
      authority.push(record.name);
    else fail(`unknown classification for ${record.name}`);
  }
  for (const name of expected)
    if (!classified.has(name)) fail(`missing classification: ${name}`);
  const authorityOrder = processAuthorityFiles.filter((name) =>
    authority.includes(name),
  );
  if (authorityOrder.length !== authority.length)
    fail("authority classification is outside the closed authority set");
  return Object.freeze({
    authority: Object.freeze(authorityOrder),
    pure: Object.freeze(pure.sort()),
  });
}

export function createVitestInvocation(files, workerCeiling = 1) {
  if (!Array.isArray(files) || files.length === 0)
    fail("a Vitest child requires at least one test file");
  if (!Number.isSafeInteger(workerCeiling) || workerCeiling < 1)
    fail("a Vitest child requires a positive worker ceiling");
  const paths = files.map((name) => {
    if (!classificationsByName.has(name))
      fail(`test has no reviewed classification: ${name}`);
    return resolve(testRoot, name);
  });
  return Object.freeze({
    arguments: Object.freeze([
      vitestPath,
      "run",
      "--config",
      configPath,
      "--maxWorkers",
      String(workerCeiling),
      ...paths,
    ]),
    executable: process.execPath,
  });
}

function childEnvironment() {
  const environment = {};
  for (const key of [
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SHELL",
    "SYSTEMROOT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USERPROFILE",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function executeVitestInvocation(
  invocation,
  spawnChild = spawn,
  signalHost = process,
) {
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawnChild(invocation.executable, invocation.arguments, {
      cwd: workspaceRoot,
      detached: signalHost.platform !== "win32",
      env: childEnvironment(),
      shell: false,
      stdio: "inherit",
    });
    let terminal = false;
    let failure;
    const handlers = new Map();
    const removeHandlers = () => {
      for (const [signal, handler] of handlers) signalHost.off(signal, handler);
      handlers.clear();
    };
    const terminate = (signal) => {
      if (terminal || child.pid === undefined) return;
      try {
        signalHost.kill(
          signalHost.platform === "win32" ? child.pid : -child.pid,
          signal,
        );
      } catch (error) {
        if (error?.code === "ESRCH") return;
        failure ??= error;
        try {
          child.kill("SIGKILL");
        } catch (killError) {
          failure ??= killError;
        }
      }
    };
    for (const signal of forwardedSignals) {
      const handler = () => terminate(signal);
      handlers.set(signal, handler);
      signalHost.on(signal, handler);
    }
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      terminal = true;
      removeHandlers();
      if (failure !== undefined) {
        rejectExecution(failure);
        return;
      }
      resolveExecution(
        Object.freeze({ code: code ?? 1, signal: signal ?? undefined }),
      );
    });
  });
}

export function publishTerminalOutcome(outcome, processHost = process) {
  if (outcome.signal !== undefined) {
    processHost.kill(processHost.pid, outcome.signal);
    return;
  }
  processHost.exitCode = outcome.code;
}

export async function runWorkspacePolicyPlan(
  plan,
  execute = executeVitestInvocation,
) {
  const batches = [
    ...(plan.pure.length > 0
      ? [{ files: plan.pure, workers: pureWorkerCeiling }]
      : []),
    ...plan.authority.map((name) => ({ files: [name], workers: 1 })),
  ];
  for (const batch of batches) {
    const outcome = await execute(
      createVitestInvocation(batch.files, batch.workers),
    );
    if (outcome.code !== 0 || outcome.signal !== undefined) return outcome;
  }
  return Object.freeze({ code: 0, signal: undefined });
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length !== 0) fail("caller arguments are not accepted");
  const inventory = discoverWorkspacePolicyInventory();
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  return runWorkspacePolicyPlan(plan);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const outcome = await main();
    publishTerminalOutcome(outcome);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
