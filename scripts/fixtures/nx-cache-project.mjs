import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function createNxCacheFixture(root) {
  for (const name of ["dependency", "consumer"]) {
    mkdirSync(join(root, `packages/${name}/src`), { recursive: true });
    writeFileSync(
      join(root, `packages/${name}/src/value.txt`),
      `${name}-one\n`,
    );
    writeFileSync(
      join(root, `packages/${name}/package.json`),
      JSON.stringify({
        name: `@fixture/${name}`,
        version: "1.0.0",
        scripts: {
          build: `node ../../task.mjs ${name} build`,
          coverage: `node ../../task.mjs ${name} coverage`,
        },
        ...(name === "consumer"
          ? { dependencies: { "@fixture/dependency": "workspace:*" } }
          : {}),
      }),
    );
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "cache-fixture",
      private: true,
      version: "1.0.0",
      packageManager: "npm@10.9.2",
      workspaces: ["packages/*"],
    }),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "cache-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "cache-fixture",
          version: "1.0.0",
          workspaces: ["packages/*"],
        },
        "packages/dependency": {
          name: "@fixture/dependency",
          version: "1.0.0",
        },
        "packages/consumer": {
          name: "@fixture/consumer",
          version: "1.0.0",
          dependencies: { "@fixture/dependency": "workspace:*" },
        },
      },
    }),
  );
  writeFileSync(join(root, "root-policy.txt"), "policy-one\n");
  writeFileSync(join(root, ".gitignore"), ".nx\nobservations\nuntracked\n");
  writeFileSync(
    join(root, "nx.json"),
    JSON.stringify({
      neverConnectToCloud: true,
      namedInputs: {
        default: [
          "{projectRoot}/src/**/*",
          "{projectRoot}/package.json",
          "sharedGlobals",
        ],
        production: ["default"],
        sharedGlobals: [
          "{workspaceRoot}/task.mjs",
          "{workspaceRoot}/root-policy.txt",
          "{workspaceRoot}/package-lock.json",
        ],
        runtimeEnvironment: [{ env: "CACHE_RUNTIME" }],
      },
      targetDefaults: {
        build: {
          cache: true,
          dependsOn: ["^build"],
          inputs: ["production", "^production", "runtimeEnvironment"],
          outputs: ["{projectRoot}/dist"],
        },
        coverage: {
          cache: false,
          inputs: ["default", "^production", "runtimeEnvironment"],
        },
      },
    }),
  );
  writeFileSync(
    join(root, "task.mjs"),
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const [name, target] = process.argv.slice(2);
const root = process.cwd().endsWith(name) ? resolve(process.cwd(), "../..") : process.cwd();
const project = resolve(root, "packages", name);
const source = resolve(project, "src/value.txt");
const value = existsSync(source) ? readFileSync(source, "utf8") : "missing\\n";
mkdirSync(resolve(root, "observations"), { recursive: true });
appendFileSync(resolve(root, "observations", name + "-" + target), "executed\\n");
mkdirSync(resolve(root, "untracked"), { recursive: true });
writeFileSync(resolve(root, "untracked", name), "not-a-declared-output\\n");
if (target === "build") {
  mkdirSync(resolve(project, "dist"), { recursive: true });
  writeFileSync(resolve(project, "dist/result.txt"), value);
}
`,
  );
  return root;
}

export function executionCount(root, name, target = "build") {
  const path = join(root, "observations", `${name}-${target}`);
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").length
    : 0;
}

export function replaceFixtureInput(path, value) {
  const previous = readFileSync(path, "utf8");
  const previousMtime = statSync(path).mtimeMs;
  assert.notEqual(value, previous);
  assert.equal(Buffer.byteLength(value), Buffer.byteLength(previous));
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, value);
  renameSync(replacement, path);
  const nextMtimeSeconds = Math.floor(previousMtime / 1_000) + 1;
  utimesSync(path, nextMtimeSeconds, nextMtimeSeconds);
  assert.ok(statSync(path).mtimeMs > previousMtime);
}

export function localNxEnvironment(runtime) {
  const environment = { ...process.env };
  for (const name of [
    "NX_SKIP_NX_CACHE",
    "NX_DISABLE_NX_CACHE",
    "NX_TASKS_RUNNER",
  ]) {
    delete environment[name];
  }
  return {
    ...environment,
    CACHE_RUNTIME: runtime,
    NX_DAEMON: "false",
    NX_NO_CLOUD: "true",
    // This closed fixture has no custom plugins. Keep built-in graph loading
    // in-process: plugin-worker startup is not part of the cache contract.
    // Real Nx commands, hashing, cache and output restoration stay enabled.
    NX_ISOLATE_PLUGINS: "false",
  };
}
