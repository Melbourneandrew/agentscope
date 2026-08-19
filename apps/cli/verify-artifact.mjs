import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublishManifest } from "./scripts/publish-manifest.mjs";

// AC-INS-001.1 AC-INS-001.2 AC-INS-001.3 AC-INS-001.4 AC-CLI-001.1 AC-CLI-001.2 AC-CLI-001.4 AC-CLI-002.2
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const artifactDirectory = resolve(repositoryRoot, "artifacts/npm");
const stagingRoot = resolve(repositoryRoot, "artifacts/staging/cli");
const installRoot = mkdtempSync(join(tmpdir(), "agentscope-cli-install-"));
const isolatedHome = join(installRoot, "home");
const npmUserConfig = join(installRoot, "empty-npmrc");
mkdirSync(artifactDirectory, { recursive: true });

function runRaw(command, arguments_, options = {}) {
  const { env, ...spawnOptions } = options;
  return spawnSync(command, arguments_, {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      npm_config_cache: join(installRoot, "npm-cache"),
      npm_config_userconfig: npmUserConfig,
      ...env,
    },
    ...spawnOptions,
  });
}

function run(command, arguments_, options = {}) {
  const result = runRaw(command, arguments_, options);
  assert.equal(
    result.status,
    0,
    `${command} ${arguments_.join(" ")} failed:\n${result.stdout}${result.stderr}`,
  );
  return result;
}

try {
  mkdirSync(isolatedHome);
  writeFileSync(npmUserConfig, "");
  run(process.execPath, [resolve(packageRoot, "build.mjs")]);
  rmSync(stagingRoot, { force: true, recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  cpSync(resolve(packageRoot, "dist"), resolve(stagingRoot, "dist"), {
    recursive: true,
  });
  const developmentManifest = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  );
  const publishManifest = createPublishManifest(developmentManifest);
  writeFileSync(
    resolve(stagingRoot, "package.json"),
    `${JSON.stringify(publishManifest, undefined, 2)}\n`,
  );
  const packResult = run("npm", [
    "pack",
    stagingRoot,
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    artifactDirectory,
  ]);
  const packReport = JSON.parse(packResult.stdout);
  assert.equal(packReport.length, 1);
  const tarball = join(artifactDirectory, packReport[0].filename);
  assert.ok(existsSync(tarball));

  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      tarball,
    ],
    { cwd: installRoot },
  );

  const installedPackage = join(
    installRoot,
    "node_modules/@agentscope/cli/package.json",
  );
  const installedManifest = JSON.parse(readFileSync(installedPackage, "utf8"));
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [dependency, version] of Object.entries(
      installedManifest[field] ?? {},
    )) {
      assert.doesNotMatch(dependency, /^@agentscope\//u);
      assert.doesNotMatch(String(version), /^workspace:/u);
    }
  }
  assert.equal(installedManifest.devDependencies, undefined);
  assert.equal(installedManifest.scripts, undefined);

  const executable = join(
    installRoot,
    "node_modules/.bin",
    process.platform === "win32" ? "agentscope.cmd" : "agentscope",
  );
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  const executableOptions = {
    cwd: installRoot,
    shell: process.platform === "win32",
  };
  const help = run(executable, ["--help"], executableOptions);
  assert.match(help.stdout, /^Usage: agentscope \[options\]/u);
  assert.match(help.stdout, /Documentation: https:\/\//u);
  assert.equal(help.stderr, "");
  const version = run(executable, ["--version"], executableOptions);
  assert.equal(version.stdout, `${installedManifest.version}\n`);
  assert.equal(version.stderr, "");
  const harnesses = run(
    executable,
    ["harness", "list", "--output", "json"],
    executableOptions,
  );
  assert.deepEqual(JSON.parse(harnesses.stdout), {
    command: "agentscope harness list",
    completion: "complete",
    dataSchema: "agentscope.cli.harness-list.v1",
    records: [],
    schema: "agentscope.cli.result.v1",
  });
  assert.equal(harnesses.stderr, "");
  for (const mode of ["json", "jsonl"]) {
    const agentscopeHome = join(installRoot, `agentscope-home-${mode}`);
    mkdirSync(agentscopeHome);
    const initialized = run(executable, ["init", "--yes", "--output", mode], {
      ...executableOptions,
      env: { HOME: agentscopeHome, USERPROFILE: agentscopeHome },
    });
    const planRecords = initialized.stderr
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const resultRecords = initialized.stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (mode === "json") {
      assert.equal(planRecords.length, 1);
      assert.equal(planRecords[0].schema, "agentscope.cli.plan.v1");
      assert.equal(resultRecords.length, 1);
      assert.equal(resultRecords[0].schema, "agentscope.cli.result.v1");
    } else {
      assert.deepEqual(
        planRecords.map((record) => [record.schema, record.kind]),
        [
          ["agentscope.cli.plan-record.v1", "plan"],
          ["agentscope.cli.plan-record.v1", "summary"],
        ],
      );
      assert.deepEqual(
        resultRecords.map((record) => [record.schema, record.kind]),
        [
          ["agentscope.cli.record.v1", "data"],
          ["agentscope.cli.record.v1", "summary"],
        ],
      );
    }
  }
  const invalid = runRaw(
    executable,
    ["--does-not-exist-CANARY_SECRET"],
    executableOptions,
  );
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, "error [cli.input.invalid]\n");
  assert.doesNotMatch(invalid.stderr, /CANARY|Error:|\bat\s/u);
  const unsafe = runRaw(
    executable,
    ["--does-not-exist", "CANARY\nSECRET"],
    executableOptions,
  );
  assert.equal(unsafe.status, 2);
  assert.equal(unsafe.stdout, "");
  assert.equal(unsafe.stderr, "error [cli.input.invalid]\n");

  const bundle = readFileSync(
    join(installRoot, "node_modules/@agentscope/cli/dist/bin/agentscope.js"),
    "utf8",
  );
  assert.doesNotMatch(bundle, /workspace:/u);
  assert.doesNotMatch(bundle, /from\s+["']@agentscope\//u);
  assert.doesNotMatch(bundle, /require\(["']@agentscope\//u);
  assert.deepEqual(readdirSync(join(installRoot, "node_modules/@agentscope")), [
    "cli",
  ]);

  process.stdout.write(
    `Verified clean install of ${basename(tarball)} (${packReport[0].integrity})\n`,
  );
} finally {
  rmSync(installRoot, { force: true, recursive: true });
}
