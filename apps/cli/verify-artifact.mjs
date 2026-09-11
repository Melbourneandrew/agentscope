import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { createPublishManifest } from "./scripts/publish-manifest.mjs";

// AC-INS-001.1 AC-INS-001.2 AC-INS-001.3 AC-INS-001.4 AC-CLI-001.1 AC-CLI-001.2 AC-CLI-001.4 AC-CLI-002.2 AC-DOC-001.7 AC-DOC-002.1 AC-DOC-002.2
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const artifactDirectory = resolve(repositoryRoot, "artifacts/npm");
const stagingRoot = resolve(repositoryRoot, "artifacts/staging/cli");
const installRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "agentscope-cli-install-")),
);
const isolatedHome = join(installRoot, "home");
const npmUserConfig = join(installRoot, "empty-npmrc");
let loopbackServer;
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

function regularFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      assert.equal(metadata.isSymbolicLink(), false);
      if (metadata.isDirectory()) pending.push(path);
      else {
        assert.equal(metadata.isFile(), true);
        files.push(relative(root, path));
      }
    }
  }
  return files.sort();
}

function snapshotSqliteFamily(root) {
  const family = regularFiles(root)
    .filter((path) =>
      ["traces.sqlite", "traces.sqlite-wal", "traces.sqlite-shm"].includes(
        basename(path),
      ),
    )
    .map((path) => {
      const absolutePath = join(root, path);
      const before = lstatSync(absolutePath);
      assert.equal(before.isFile(), true);
      const bytes = readFileSync(absolutePath);
      const after = lstatSync(absolutePath);
      assert.deepEqual(
        {
          device: after.dev,
          inode: after.ino,
          size: after.size,
        },
        {
          device: before.dev,
          inode: before.ino,
          size: before.size,
        },
      );
      return {
        device: after.dev,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        inode: after.ino,
        path,
        size: after.size,
      };
    });
  assert.ok(
    family.some(({ path }) => basename(path) === "traces.sqlite"),
    "configured Local SQLite family must contain traces.sqlite",
  );
  return family;
}

function waitForFile(path, child) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    assert.equal(child.exitCode, null, "loopback server exited early");
    assert.ok(Date.now() < deadline, "loopback server did not become ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
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
    "node_modules/agentscope-cli/package.json",
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
  const oracleSourcePath = resolve(
    packageRoot,
    "scripts/verify-installed-contract.ts",
  );
  const oracleSource = readFileSync(oracleSourcePath, "utf8");
  assert.doesNotMatch(oracleSource, /node:child_process|\bspawn(?:Sync)?\b/u);
  const oracleBuild = await build({
    bundle: true,
    entryPoints: [oracleSourcePath],
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
  });
  assert.equal(oracleBuild.outputFiles.length, 1);
  const oracleModule = await import(
    `data:text/javascript;base64,${Buffer.from(
      oracleBuild.outputFiles[0].text,
    ).toString("base64")}`
  );
  const registryBuild = await build({
    bundle: true,
    format: "esm",
    platform: "node",
    stdin: {
      contents: 'export { commandRegistry } from "./src/command-registry.ts";',
      loader: "ts",
      resolveDir: packageRoot,
      sourcefile: "installed-contract-registry-entry.ts",
    },
    target: "node22",
    write: false,
  });
  assert.equal(registryBuild.outputFiles.length, 1);
  const registryModule = await import(
    `data:text/javascript;base64,${Buffer.from(
      registryBuild.outputFiles[0].text,
    ).toString("base64")}`
  );
  const registryProjection = registryModule.commandRegistry
    .filter(({ visibility }) => visibility === "public")
    .map(({ id, kind, outputModes, path, visibility }) => ({
      id,
      kind,
      path,
      outputModes,
      visibility,
    }));
  assert.deepEqual(
    oracleModule.expectedPublicCommandInventory,
    registryProjection,
  );
  for (const registration of registryProjection) {
    const help = runRaw(executable, [...registration.path, "--help"], {
      cwd: installRoot,
      shell: process.platform === "win32",
    });
    assert.equal(help.status, 0);
    assert.equal(help.stderr, "");
    assert.doesNotThrow(() =>
      oracleModule.validateInstalledCliHelpOutput(registration.id, help.stdout),
    );
    assert.throws(() =>
      oracleModule.validateInstalledCliHelpOutput(
        registration.id,
        "Usage: agentscope\nDocumentation: https://invalid.example/\n",
      ),
    );
    assert.throws(() =>
      oracleModule.validateInstalledCliHelpOutput(
        registration.id,
        help.stdout.replace(
          /\n(?:Arguments|Options|Commands):[\s\S]*?(?=\nDocumentation:)/u,
          "",
        ),
      ),
    );
  }
  const installedContractPlan = oracleModule.createInstalledCliContractPlan(
    installedManifest.version,
    { architecture: "x64", modules: "127", platform: "linux" },
  );
  assert.equal(installedContractPlan.planVersion, 1);
  assert.ok(installedContractPlan.caseIds.length > 80);
  assert.equal(
    new Set(installedContractPlan.caseIds).size,
    installedContractPlan.caseIds.length,
  );
  assert.match(installedContractPlan.caseIdsDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(installedContractPlan.inventoryDigest, /^sha256:[0-9a-f]{64}$/u);
  const ordinal35 = installedContractPlan.cases[35];
  assert.equal(ordinal35.caseId, "install.missing-required");
  assert.deepEqual(installedContractPlan.caseIds.slice(34, 37), [
    "install.unsupported-output",
    "install.missing-required",
    "uninstall.valid.human",
  ]);
  assert.deepEqual(ordinal35.steps, [
    {
      args: ["install", "--output", "json"],
      executionMode: "direct",
      expectedDiagnostic: "cli.usage",
      expectedOutcome: "exited",
      expectedSignal: null,
      expectedStatus: 2,
      input: "",
      outputRule: "json",
      stateRule: "same-as-before",
    },
  ]);
  const ordinal40 = installedContractPlan.cases[40];
  assert.equal(ordinal40.caseId, "uninstall.missing-required");
  assert.deepEqual(installedContractPlan.caseIds.slice(39, 42), [
    "uninstall.unsupported-output",
    "uninstall.missing-required",
    "destination.configure.valid.human",
  ]);
  assert.deepEqual(ordinal40.steps, [
    {
      args: ["uninstall", "--output", "json"],
      executionMode: "direct",
      expectedDiagnostic: "cli.usage",
      expectedOutcome: "exited",
      expectedSignal: null,
      expectedStatus: 2,
      input: "",
      outputRule: "json",
      stateRule: "same-as-before",
    },
  ]);
  const directResult = {
    outcome: "exited",
    signal: null,
    status: 0,
    stderr: "",
    stdout:
      '{"command":"agentscope harness list","completion":"complete","dataSchema":"agentscope.cli.harness-list.v1","records":[],"schema":"agentscope.cli.result.v1"}\n',
  };
  const directStep = {
    args: ["harness", "list", "--output", "json"],
    executionMode: "direct",
    expectedOutcome: "exited",
    expectedSignal: null,
    expectedStatus: 0,
    input: "",
    outputRule: "json",
    stateRule: "same-as-before",
  };
  assert.doesNotThrow(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      directStep,
      directResult,
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  for (const stdout of [
    directResult.stdout.replace(
      '"schema":"agentscope.cli.result.v1"',
      '"schema":"agentscope.cli.result.v1","unexpected":true',
    ),
    directResult.stdout.replace('"records":[]', '"records":[],"records":[]'),
    directResult.stdout.replace("}\n", "} \n"),
    directResult.stdout.replace(
      '"command":"agentscope harness list"',
      '"command":"agentscope doctor"',
    ),
    directResult.stdout.replace(
      '"dataSchema":"agentscope.cli.harness-list.v1"',
      '"dataSchema":"agentscope.cli.forged.v1"',
    ),
    directResult.stdout.replace('"records":[]', '"records":[{"forged":true}]'),
    directResult.stdout.replace(
      '"completion":"complete"',
      '"completion":"partial"',
    ),
  ])
    assert.throws(() =>
      oracleModule.validateInstalledCliInvocationOutputForTest(
        directStep,
        { ...directResult, stdout },
        installedManifest.version,
        { caseOrdinal: 1 },
      ),
    );
  const forgedDoctorStep = {
    ...directStep,
    args: ["doctor", "--output", "json"],
  };
  const forgedDoctorResult = {
    ...directResult,
    stdout: `${JSON.stringify({
      command: "agentscope doctor",
      completion: "complete",
      dataSchema: "agentscope.cli.doctor.v1",
      records: [
        {
          findings: [
            {
              code: "doctor.forged.value",
              evidence: {
                count: null,
                freshness: "current",
                localResource: { arbitrary: "forged.value" },
                lossCount: null,
                scope: "forged",
                state: "forged",
                subject: "/private/forged",
                version: "forged",
              },
              severity: "info",
              suggestedAction: "forged-action",
            },
          ],
          fixed: false,
          repairs: [],
          summary: { errors: 0, information: 1, warnings: 0 },
        },
      ],
      schema: "agentscope.cli.result.v1",
    })}\n`,
  };
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      forgedDoctorStep,
      forgedDoctorResult,
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  const deterministicDoctor = {
    findings: [
      [
        "doctor.configuration.valid",
        null,
        "current",
        null,
        "configuration",
        "valid",
        "info",
        "none",
      ],
      [
        "doctor.transaction.clean",
        null,
        "current",
        null,
        "transaction",
        "clean",
        "info",
        "none",
      ],
      [
        "doctor.credential-mutation.clean",
        null,
        "current",
        null,
        "credential-mutation",
        "clean",
        "info",
        "none",
      ],
      [
        "doctor.operational-state.available",
        null,
        "current",
        null,
        "operational-state",
        "available",
        "info",
        "none",
      ],
      [
        "doctor.pipeline-health.absent",
        0,
        "retained",
        0,
        "pipeline-health",
        "absent",
        "warning",
        "none",
      ],
      [
        "doctor.harness.unavailable",
        0,
        "unavailable",
        null,
        "harness",
        "unavailable",
        "warning",
        "retry",
      ],
      [
        "doctor.destination.unavailable",
        0,
        "unavailable",
        null,
        "destination",
        "unavailable",
        "warning",
        "inspect-destination",
      ],
      [
        "doctor.git.repository-unavailable",
        null,
        "current",
        null,
        "git",
        "repository-unavailable",
        "warning",
        "retry",
      ],
    ].map(
      ([
        code,
        count,
        freshness,
        lossCount,
        scope,
        state,
        severity,
        suggestedAction,
      ]) => ({
        code,
        evidence: {
          count,
          freshness,
          lossCount,
          scope,
          state,
          subject: null,
          version: null,
        },
        severity,
        suggestedAction,
      }),
    ),
    fixed: false,
    repairs: [],
    summary: { errors: 0, information: 4, warnings: 4 },
  };
  for (const mutate of [
    (record) => {
      record.findings[0].severity = "warning";
    },
    (record) => {
      record.findings[1].suggestedAction = "retry";
    },
    (record) => {
      record.findings[2].code = "doctor.credential-mutation.active";
      record.findings[2].evidence.state = "active";
    },
  ]) {
    const record = structuredClone(deterministicDoctor);
    mutate(record);
    assert.throws(() =>
      oracleModule.validateInstalledCliInvocationOutputForTest(
        forgedDoctorStep,
        {
          ...directResult,
          stdout: `${JSON.stringify({
            command: "agentscope doctor",
            completion: "complete",
            dataSchema: "agentscope.cli.doctor.v1",
            records: [record],
            schema: "agentscope.cli.result.v1",
          })}\n`,
        },
        installedManifest.version,
        { caseOrdinal: 1 },
      ),
    );
  }
  const emptyDoctorRecord = {
    findings: [],
    fixed: false,
    repairs: [],
    summary: { errors: 0, information: 0, warnings: 0 },
  };
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      forgedDoctorStep,
      {
        ...directResult,
        stdout: `${JSON.stringify({
          command: "agentscope doctor",
          completion: "complete",
          dataSchema: "agentscope.cli.doctor.v1",
          records: [emptyDoctorRecord],
          schema: "agentscope.cli.result.v1",
        })}\n`,
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      {
        ...forgedDoctorStep,
        args: ["doctor", "--output", "human"],
        outputRule: "human",
      },
      {
        ...directResult,
        stdout:
          "Doctor: 0 error(s), 0 warning(s), 1 informational finding(s).\nINFO [forged.code] forged.state; action=forged.action\n",
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      {
        ...forgedDoctorStep,
        args: ["doctor", "--output", "human"],
        outputRule: "human",
      },
      {
        ...directResult,
        stdout:
          "Doctor: 0 error(s), 0 warning(s), 0 informational finding(s).\n",
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  const humanStep = {
    ...directStep,
    args: ["harness", "list", "--output", "human"],
    outputRule: "human",
  };
  assert.doesNotThrow(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      humanStep,
      {
        ...directResult,
        stdout: "No first-party harness adapters are registered.\n",
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      humanStep,
      {
        ...directResult,
        stdout: "No first-party harness adapters are registered.\nunexpected\n",
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  const configureStep = {
    ...directStep,
    args: [
      "destination",
      "configure",
      "local-sqlite",
      "--name",
      "contract-local",
      "--output",
      "json",
    ],
  };
  const configureResult = {
    ...directResult,
    stdout: `${JSON.stringify({
      command: "agentscope destination configure",
      completion: "complete",
      dataSchema: "agentscope.cli.destination-configure.v1",
      records: [
        {
          applied: false,
          connection: null,
          generation: null,
          plan: {
            destinationType: "@agentscope/destination-local-sqlite",
            displayPath: `/tmp/agentscope-installed-contract/cases/1/user home with spaces — 测试/.agentscope/destinations/local-sqlite/sha256-${"a".repeat(64)}`,
            operation: "configure",
            persistentDataNotice: true,
            retentionPolicy: {
              maximumAgeNanoseconds: "2592000000000000",
              maximumPayloadBytes: 1_073_741_824,
              maximumTraceCount: 100_000,
              physicalCleanupTrigger: "next-authorized-mutation",
            },
          },
          state: "planned",
        },
      ],
      schema: "agentscope.cli.result.v1",
    })}\n`,
  };
  assert.doesNotThrow(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      configureStep,
      configureResult,
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      configureStep,
      {
        ...configureResult,
        stdout: configureResult.stdout.replace("/cases/1/", "/cases/999/"),
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  for (const [expected, replacement] of [
    ["2592000000000000", "1"],
    ["1073741824", "-9007199254740991"],
    ["100000", "-9007199254740991"],
  ])
    assert.throws(() =>
      oracleModule.validateInstalledCliInvocationOutputForTest(
        configureStep,
        {
          ...configureResult,
          stdout: configureResult.stdout.replace(expected, replacement),
        },
        installedManifest.version,
        { caseOrdinal: 1 },
      ),
    );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      {
        ...humanStep,
        args: [
          "destination",
          "configure",
          "local-sqlite",
          "--name",
          "contract-local",
          "--output",
          "human",
        ],
      },
      {
        ...directResult,
        stdout:
          "Local persistence plan: /tmp/agentscope-installed-contract/cases/1/user home with spaces — 测试/.agentscope/destinations/local-sqlite/wrong-name\nNo changes applied; rerun with --yes after reviewing the plan.\n",
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  const diagnosticStep = {
    ...directStep,
    args: ["destination", "inspect", "missing", "--output", "json"],
    expectedDiagnostic: "destination.connection-missing",
    expectedStatus: 3,
    outputRule: "json",
  };
  const diagnosticResult = {
    ...directResult,
    status: 3,
    stdout: "",
    stderr:
      '{"category":"not-found","code":"destination.connection-missing","command":"agentscope destination inspect","schema":"agentscope.cli.diagnostic.v1"}\n',
  };
  assert.doesNotThrow(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      diagnosticStep,
      diagnosticResult,
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      diagnosticStep,
      {
        ...diagnosticResult,
        stderr: diagnosticResult.stderr.replace(
          '"category":"not-found"',
          '"category":"usage"',
        ),
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      diagnosticStep,
      {
        ...diagnosticResult,
        stderr: diagnosticResult.stderr.replace(
          '"schema":"agentscope.cli.diagnostic.v1"',
          '"facts":{"path":"/private/forged","providerBody":"forged"},"schema":"agentscope.cli.diagnostic.v1"',
        ),
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      diagnosticStep,
      {
        ...diagnosticResult,
        stderr: diagnosticResult.stderr.replace(
          '"schema":"agentscope.cli.diagnostic.v1"',
          '"schema":"agentscope.cli.diagnostic.v1","unexpected":true',
        ),
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      diagnosticStep,
      {
        ...diagnosticResult,
        stderr: diagnosticResult.stderr.replace(
          '"command":"agentscope destination inspect"',
          '"command":"agentscope harness list"',
        ),
      },
      installedManifest.version,
      { caseOrdinal: 1 },
    ),
  );
  const executionModes = new Set(
    installedContractPlan.cases.flatMap(({ steps }) =>
      steps.map(({ executionMode }) => executionMode),
    ),
  );
  assert.deepEqual(
    executionModes,
    new Set([
      "deadline-child",
      "direct",
      "pty-narrow",
      "signal-int",
      "signal-term",
      "stdout-closed",
    ]),
  );
  for (const requiredCaseId of [
    "arguments.unicode",
    "deadline.child-lifecycle",
    "signals.sigint",
    "signals.sigterm",
    "terminal.broken-pipe",
    "terminal.narrow-help",
  ])
    assert.ok(installedContractPlan.caseIds.includes(requiredCaseId));
  const installedIdentity = {
    bin: installedManifest.bin,
    candidateDigest: `sha256:${createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex")}`,
    executableRealPath: realpathSync(executable),
    installedPackageRootRealPath: realpathSync(
      join(installRoot, "node_modules/agentscope-cli"),
    ),
    package: installedManifest.name,
    version: installedManifest.version,
  };
  const assertEvaluationFailure = (
    identity,
    observations,
    expected,
    plan = installedContractPlan,
    expectedCaseOrdinal = undefined,
  ) => {
    try {
      oracleModule.evaluateInstalledCliContract(plan, identity, observations);
      assert.fail("installed contract evaluation unexpectedly succeeded");
    } catch (error) {
      assert.equal(
        oracleModule.installedContractEvaluationFailureReason(error),
        expected,
      );
      if (expectedCaseOrdinal !== undefined)
        assert.equal(
          oracleModule.installedContractEvaluationFailureCaseOrdinal(error),
          expectedCaseOrdinal,
        );
    }
  };
  const shapedObservations = installedContractPlan.cases.map(
    (contractCase) => ({
      afterStateDigests: contractCase.steps.map(
        () => `sha256-${"b".repeat(64)}`,
      ),
      beforeStateDigest: `sha256-${"a".repeat(64)}`,
      caseId: contractCase.caseId,
      results: contractCase.steps.map(() => ({
        outcome: "cleanup-failed",
        signal: null,
        status: null,
        stderr: "",
        stdout: "",
      })),
      ...(contractCase.setup === "initialized"
        ? {
            setupResult: {
              outcome: "cleanup-failed",
              signal: null,
              status: null,
              stderr: "",
              stdout: "",
            },
          }
        : {}),
    }),
  );
  assertEvaluationFailure(installedIdentity, [], "missing-ordinal");
  assertEvaluationFailure(
    installedIdentity,
    [...shapedObservations, shapedObservations[0]],
    "unexpected-extra-evidence",
  );
  assertEvaluationFailure(
    installedIdentity,
    shapedObservations.map((observation, index) =>
      index === 1
        ? { ...observation, caseId: shapedObservations[0].caseId }
        : observation,
    ),
    "duplicate-ordinal",
  );
  assertEvaluationFailure(
    installedIdentity,
    shapedObservations.map((observation, index) =>
      index === 0 ? { ...observation, caseId: "unknown" } : observation,
    ),
    "out-of-range-ordinal",
  );
  assertEvaluationFailure(
    installedIdentity,
    [
      shapedObservations[1],
      shapedObservations[0],
      ...shapedObservations.slice(2),
    ],
    "aggregate-count-order-digest",
  );
  assertEvaluationFailure(
    { ...installedIdentity, candidateDigest: "substituted" },
    shapedObservations,
    "inventory-candidate-digest-mismatch",
  );
  assertEvaluationFailure(
    installedIdentity,
    shapedObservations.map((observation, index) =>
      index === 0 ? { ...observation, results: [] } : observation,
    ),
    "per-case-result-count",
  );
  assertEvaluationFailure(
    installedIdentity,
    shapedObservations,
    "per-case-step-receipt-status",
  );
  const beforeDigest = `sha256-${"a".repeat(64)}`;
  const afterDigest = `sha256-${"b".repeat(64)}`;
  const fixtureStep = Object.freeze({
    args: [],
    executionMode: "stdout-closed",
    expectedOutcome: "exited",
    expectedSignal: null,
    expectedStatus: 0,
    input: "",
    outputRule: "human",
    stateRule: "same-as-before",
  });
  const fixtureCase = Object.freeze({
    caseId: "fixture.canonical",
    setup: "none",
    steps: Object.freeze([fixtureStep]),
  });
  const fixturePlan = Object.freeze({
    caseIds: Object.freeze([fixtureCase.caseId]),
    caseIdsDigest: "sha256:fixture-case-ids",
    cases: Object.freeze([fixtureCase]),
    expectedVersion: installedContractPlan.expectedVersion,
    inventoryDigest: "sha256:fixture-inventory",
    planVersion: 1,
    receiptCaseIds: Object.freeze([`${fixtureCase.caseId}.0`]),
    receiptCaseIdsDigest: "sha256:fixture-receipts",
  });
  const canonicalResult = Object.freeze({
    outcome: "exited",
    signal: null,
    status: 0,
    stderr: "",
    stdout: "",
  });
  const canonicalObservation = Object.freeze({
    afterStateDigests: Object.freeze([beforeDigest]),
    beforeStateDigest: beforeDigest,
    caseId: fixtureCase.caseId,
    results: Object.freeze([canonicalResult]),
  });
  assert.deepEqual(
    oracleModule.evaluateInstalledCliContract(fixturePlan, installedIdentity, [
      canonicalObservation,
    ]),
    {
      candidateDigest: installedIdentity.candidateDigest,
      caseCount: 1,
      caseIdsDigest: fixturePlan.caseIdsDigest,
      inventoryDigest: fixturePlan.inventoryDigest,
      package: "agentscope-cli",
      receiptCaseIdsDigest: fixturePlan.receiptCaseIdsDigest,
      receiptCount: 1,
      schema: "agentscope.cli.installed-contract-evidence.v2",
      version: fixturePlan.expectedVersion,
    },
  );
  const symbolResults = [canonicalResult];
  symbolResults[Symbol("extra")] = true;
  const symbolDigests = [beforeDigest];
  symbolDigests[Symbol("extra")] = true;
  const hostileDigestPrototype = [beforeDigest];
  Object.setPrototypeOf(hostileDigestPrototype, {
    every: () => {
      throw new Error("hostile array prototype");
    },
  });
  for (const substitutedObservation of [
    { ...canonicalObservation, unexpected: true },
    { ...canonicalObservation, beforeStateDigest: "sha256:substituted" },
    { ...canonicalObservation, results: {} },
    { ...canonicalObservation, results: symbolResults },
    { ...canonicalObservation, afterStateDigests: symbolDigests },
    { ...canonicalObservation, afterStateDigests: hostileDigestPrototype },
    Object.assign({ ...canonicalObservation }, { [Symbol("extra")]: true }),
    Object.defineProperty({ ...canonicalObservation }, "extra", {
      value: true,
    }),
    Object.defineProperty({ ...canonicalObservation }, "caseId", {
      enumerable: true,
      get: () => fixtureCase.caseId,
    }),
    new Proxy(canonicalObservation, {}),
    new Proxy(canonicalObservation, {
      getOwnPropertyDescriptor: () => {
        throw new Error("substituted observation");
      },
    }),
  ])
    assertEvaluationFailure(
      installedIdentity,
      [substitutedObservation],
      "per-case-observation-shape",
      fixturePlan,
    );
  const symbolObservations = [canonicalObservation];
  symbolObservations[Symbol("extra")] = true;
  for (const substitutedObservations of [
    symbolObservations,
    new Proxy([canonicalObservation], {}),
    new Proxy([canonicalObservation], {
      getOwnPropertyDescriptor: () => {
        throw new Error("substituted observations");
      },
    }),
  ])
    assertEvaluationFailure(
      installedIdentity,
      substitutedObservations,
      "per-case-observation-shape",
      fixturePlan,
    );
  for (const substitutedResult of [
    { ...canonicalResult, unexpected: true },
    { ...canonicalResult, outcome: undefined },
    { ...canonicalResult, status: "0" },
    Object.assign({ ...canonicalResult }, { [Symbol("extra")]: true }),
    Object.defineProperty({ ...canonicalResult }, "extra", { value: true }),
    {
      ...canonicalResult,
      outcome: {
        toString: () => {
          throw new Error("untrusted coercion");
        },
      },
    },
    Object.defineProperty({ ...canonicalResult }, "status", {
      enumerable: true,
      get: () => 0,
    }),
  ])
    assertEvaluationFailure(
      installedIdentity,
      [{ ...canonicalObservation, results: [substitutedResult] }],
      "per-case-step-receipt-shape",
      fixturePlan,
    );
  assertEvaluationFailure(
    installedIdentity,
    [{ ...canonicalObservation, results: [{ ...canonicalResult, status: 1 }] }],
    "per-case-step-receipt-status",
    fixturePlan,
  );
  const sparseResults = [];
  sparseResults.length = 1;
  assertEvaluationFailure(
    installedIdentity,
    [{ ...canonicalObservation, results: sparseResults }],
    "per-case-observation-shape",
    fixturePlan,
  );
  for (const outputRule of [
    "confirmation",
    "help",
    "human",
    "json",
    "jsonl",
    "version",
  ]) {
    const outputCase = Object.freeze({
      ...fixtureCase,
      steps: Object.freeze([Object.freeze({ ...fixtureStep, outputRule })]),
    });
    assertEvaluationFailure(
      installedIdentity,
      [
        {
          ...canonicalObservation,
          results: [{ ...canonicalResult, stdout: "substituted" }],
        },
      ],
      `per-case-step-output-${outputRule}`,
      Object.freeze({ ...fixturePlan, cases: Object.freeze([outputCase]) }),
      0,
    );
  }
  const diagnosticCase = Object.freeze({
    ...fixtureCase,
    steps: Object.freeze([
      Object.freeze({
        ...fixtureStep,
        expectedDiagnostic: "cli.input.invalid",
      }),
    ]),
  });
  assertEvaluationFailure(
    installedIdentity,
    [
      {
        ...canonicalObservation,
        results: [{ ...canonicalResult, stderr: "substituted" }],
      },
    ],
    "per-case-step-output-diagnostic",
    Object.freeze({ ...fixturePlan, cases: Object.freeze([diagnosticCase]) }),
    0,
  );
  assertEvaluationFailure(
    installedIdentity,
    [{ ...canonicalObservation, afterStateDigests: [afterDigest] }],
    "per-case-state-digest",
    fixturePlan,
  );
  const setupCase = Object.freeze({
    caseId: "fixture.setup",
    setup: "initialized",
    steps: Object.freeze([]),
  });
  const setupPlan = Object.freeze({
    ...fixturePlan,
    caseIds: Object.freeze([setupCase.caseId]),
    cases: Object.freeze([setupCase]),
    receiptCaseIds: Object.freeze([]),
  });
  const setupObservation = Object.freeze({
    afterStateDigests: Object.freeze([]),
    beforeStateDigest: beforeDigest,
    caseId: setupCase.caseId,
    results: Object.freeze([]),
    setupResult: canonicalResult,
  });
  assertEvaluationFailure(
    installedIdentity,
    [{ ...setupObservation, setupResult: { ...canonicalResult, extra: true } }],
    "per-case-setup-receipt-shape",
    setupPlan,
  );
  assertEvaluationFailure(
    installedIdentity,
    [{ ...setupObservation, setupResult: { ...canonicalResult, status: 1 } }],
    "per-case-setup-receipt-status",
    setupPlan,
  );
  assertEvaluationFailure(
    installedIdentity,
    [setupObservation],
    "per-case-setup-output",
    setupPlan,
  );
  const ptyDigest = `sha256:${"0".repeat(64)}`;
  const ptyCase = Object.freeze({
    caseId: "fixture.pty",
    setup: "none",
    steps: Object.freeze([
      Object.freeze({
        ...fixtureStep,
        executionMode: "pty-narrow",
        expectedOutputBytes: 0,
        expectedOutputSha256: ptyDigest,
      }),
    ]),
  });
  const ptyPlan = Object.freeze({
    ...fixturePlan,
    caseIds: Object.freeze([ptyCase.caseId]),
    cases: Object.freeze([ptyCase]),
    receiptCaseIds: Object.freeze([`${ptyCase.caseId}.0`]),
  });
  const canonicalPty = Object.freeze({
    cleanup: "clean",
    initialGeometry: Object.freeze({ columns: 40, rows: 12 }),
    isTTY: true,
    observedGeometry: Object.freeze({ columns: 40, rows: 12 }),
    outputBytes: 0,
    outputSha256: ptyDigest,
    processJoined: true,
    residualProcessCount: 0,
    terminalInputJoined: true,
    terminalOutputJoined: true,
    terminalTransportClosed: true,
  });
  const canonicalPtyObservation = Object.freeze({
    ...canonicalObservation,
    caseId: ptyCase.caseId,
    results: Object.freeze([
      Object.freeze({ ...canonicalResult, pty: canonicalPty }),
    ]),
  });
  assert.equal(
    oracleModule.evaluateInstalledCliContract(ptyPlan, installedIdentity, [
      canonicalPtyObservation,
    ]).caseCount,
    1,
  );
  for (const substitutedPtyResult of [
    canonicalResult,
    { ...canonicalResult, pty: { ...canonicalPty, unexpected: true } },
    {
      ...canonicalResult,
      pty: { ...canonicalPty, residualProcessCount: "0" },
    },
  ])
    assertEvaluationFailure(
      installedIdentity,
      [{ ...canonicalPtyObservation, results: [substitutedPtyResult] }],
      "per-case-step-receipt-shape",
      ptyPlan,
    );
  assertEvaluationFailure(
    installedIdentity,
    [
      {
        ...canonicalPtyObservation,
        results: [
          {
            ...canonicalResult,
            pty: {
              ...canonicalPty,
              observedGeometry: { columns: 41, rows: 12 },
            },
          },
        ],
      },
    ],
    "per-case-step-output-pty",
    ptyPlan,
    0,
  );
  const executableOptions = {
    cwd: installRoot,
    shell: process.platform === "win32",
  };
  const ordinal35Home = join(installRoot, "ordinal-35-home");
  mkdirSync(ordinal35Home);
  const ordinal35Options = {
    ...executableOptions,
    env: { HOME: ordinal35Home, USERPROFILE: ordinal35Home },
  };
  run(executable, ["init", "--yes", "--output", "json"], ordinal35Options);
  const snapshotContractHome = (home) =>
    regularFiles(home).map((path) => [
      path,
      lstatSync(join(home, path)).mode & 0o777,
      createHash("sha256")
        .update(readFileSync(join(home, path)))
        .digest("hex"),
    ]);
  const snapshotOrdinal35Home = () => snapshotContractHome(ordinal35Home);
  const ordinal35Before = snapshotOrdinal35Home();
  const ordinal35Result = runRaw(
    executable,
    ordinal35.steps[0].args,
    ordinal35Options,
  );
  assert.equal(ordinal35Result.status, 2);
  assert.equal(ordinal35Result.signal, null);
  assert.equal(ordinal35Result.stdout, "");
  assert.equal(
    ordinal35Result.stderr,
    '{"category":"usage","code":"cli.usage","command":"agentscope","schema":"agentscope.cli.diagnostic.v1"}\n',
  );
  assert.deepEqual(snapshotOrdinal35Home(), ordinal35Before);
  assert.doesNotThrow(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      ordinal35.steps[0],
      {
        outcome: "exited",
        signal: ordinal35Result.signal,
        status: ordinal35Result.status,
        stderr: ordinal35Result.stderr,
        stdout: ordinal35Result.stdout,
      },
      installedManifest.version,
      { caseOrdinal: 35 },
    ),
  );
  for (const [ordinal, expectedStatus, expectedStderr] of [
    [34, 2, "error [cli.output.unsupported]\n"],
    [36, 3, "error [harness.adapter-missing]\n"],
  ]) {
    const adjacentCase = installedContractPlan.cases[ordinal];
    const adjacentBefore = snapshotOrdinal35Home();
    const adjacentResult = runRaw(
      executable,
      adjacentCase.steps[0].args,
      ordinal35Options,
    );
    assert.equal(adjacentResult.status, expectedStatus);
    assert.equal(adjacentResult.signal, null);
    assert.equal(adjacentResult.stdout, "");
    assert.equal(adjacentResult.stderr, expectedStderr);
    assert.deepEqual(snapshotOrdinal35Home(), adjacentBefore);
    assert.doesNotThrow(() =>
      oracleModule.validateInstalledCliInvocationOutputForTest(
        adjacentCase.steps[0],
        {
          outcome: "exited",
          signal: adjacentResult.signal,
          status: adjacentResult.status,
          stderr: adjacentResult.stderr,
          stdout: adjacentResult.stdout,
        },
        installedManifest.version,
        { caseOrdinal: ordinal },
      ),
    );
  }
  const ordinal40Before = snapshotOrdinal35Home();
  const ordinal40Result = runRaw(
    executable,
    ordinal40.steps[0].args,
    ordinal35Options,
  );
  assert.equal(ordinal40Result.status, 2);
  assert.equal(ordinal40Result.signal, null);
  assert.equal(ordinal40Result.stdout, "");
  assert.equal(
    ordinal40Result.stderr,
    '{"category":"usage","code":"cli.usage","command":"agentscope","schema":"agentscope.cli.diagnostic.v1"}\n',
  );
  assert.deepEqual(snapshotOrdinal35Home(), ordinal40Before);
  assert.doesNotThrow(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      ordinal40.steps[0],
      {
        outcome: "exited",
        signal: ordinal40Result.signal,
        status: ordinal40Result.status,
        stderr: ordinal40Result.stderr,
        stdout: ordinal40Result.stdout,
      },
      installedManifest.version,
      { caseOrdinal: 40 },
    ),
  );
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      ordinal40.steps[0],
      {
        outcome: "exited",
        signal: ordinal40Result.signal,
        status: ordinal40Result.status,
        stderr: ordinal40Result.stderr.replace(
          "cli.usage",
          "cli.input.invalid",
        ),
        stdout: ordinal40Result.stdout,
      },
      installedManifest.version,
      { caseOrdinal: 40 },
    ),
  );
  for (const ordinal of [39, 41]) {
    const adjacentCase = installedContractPlan.cases[ordinal];
    const adjacentHome = join(installRoot, `ordinal-${ordinal}-home`);
    mkdirSync(adjacentHome);
    const adjacentOptions = {
      ...executableOptions,
      env: { HOME: adjacentHome, USERPROFILE: adjacentHome },
    };
    run(executable, ["init", "--yes", "--output", "json"], adjacentOptions);
    const adjacentBefore = snapshotContractHome(adjacentHome);
    const adjacentResult = runRaw(
      executable,
      adjacentCase.steps[0].args,
      adjacentOptions,
    );
    assert.deepEqual(snapshotContractHome(adjacentHome), adjacentBefore);
    if (ordinal !== 41 || process.platform === "linux")
      assert.doesNotThrow(() =>
        oracleModule.validateInstalledCliInvocationOutputForTest(
          adjacentCase.steps[0],
          {
            outcome: "exited",
            signal: adjacentResult.signal,
            status: adjacentResult.status,
            stderr: adjacentResult.stderr,
            stdout: adjacentResult.stdout,
          },
          installedManifest.version,
          { caseOrdinal: ordinal },
        ),
      );
    else {
      assert.equal(adjacentResult.status, 5);
      assert.equal(adjacentResult.signal, null);
      assert.equal(adjacentResult.stdout, "");
      assert.equal(
        adjacentResult.stderr,
        "error [destination.lifecycle-unavailable]\n",
      );
    }
  }
  assert.throws(() =>
    oracleModule.validateInstalledCliInvocationOutputForTest(
      ordinal35.steps[0],
      {
        outcome: "exited",
        signal: ordinal35Result.signal,
        status: ordinal35Result.status,
        stderr: ordinal35Result.stderr.replace(
          "cli.usage",
          "cli.input.invalid",
        ),
        stdout: ordinal35Result.stdout,
      },
      installedManifest.version,
      { caseOrdinal: 35 },
    ),
  );
  const installedInternal = join(
    installRoot,
    "node_modules/agentscope-cli/dist/internal",
  );
  const machineEntryPath = join(
    installedInternal,
    "agentscope-hook-machine.js",
  );
  const verifierEntryPath = join(installRoot, "agentscope-hook-verifier.mjs");
  await build({
    bundle: true,
    entryPoints: [
      new URL("src/hook-verifier-child.ts", import.meta.url).pathname,
    ],
    format: "esm",
    outfile: verifierEntryPath,
    platform: "node",
    target: "node22",
  });
  const launcherModule = await import(
    pathToFileURL(join(installedInternal, "agentscope-hook-launcher.js")).href
  );
  const machineModule = await import(
    pathToFileURL(join(installedInternal, "agentscope-hook-machine.js")).href
  );
  assert.deepEqual(Object.keys(machineModule), ["runOwnedHookBootstrap"]);
  const launcherHome = join(installRoot, "launcher-home");
  mkdirSync(join(launcherHome, "bin"), { recursive: true });
  const launcherInput = {
    agentscopeHome: launcherHome,
    harnessType: "@agentscope/harness-artifact-fixture",
    hookDeadlineMilliseconds: 2_000,
    machineEntryPath,
    nodeExecutable: process.execPath,
    platform: "posix",
    releaseIdentity: installedManifest.version,
  };
  if (process.platform === "win32") {
    assert.throws(() =>
      launcherModule.createOwnedHookLauncherArtifacts({
        ...launcherInput,
        platform: "win32",
      }),
    );
  } else {
    const exactShebang = launcherModule.createOwnedHookLauncherArtifacts({
      ...launcherInput,
      nodeExecutable: `/${"x".repeat(123)}`,
    });
    assert.equal(
      exactShebang.launcherBytes.indexOf(10) + 1,
      127,
      "the exact maximum POSIX shebang must remain representable",
    );
    assert.throws(() =>
      launcherModule.createOwnedHookLauncherArtifacts({
        ...launcherInput,
        nodeExecutable: `/${"x".repeat(124)}`,
      }),
    );
    for (const byte of [" ", "\t", "\n", "\r", "\0"])
      assert.throws(() =>
        launcherModule.createOwnedHookLauncherArtifacts({
          ...launcherInput,
          nodeExecutable: `/path${byte}node`,
        }),
      );
    const twoDigitLauncher = launcherModule.createOwnedHookLauncherArtifacts({
      ...launcherInput,
      hookDeadlineMilliseconds: 99,
    });
    writeFileSync(
      twoDigitLauncher.launcherPath,
      twoDigitLauncher.launcherBytes,
      { mode: twoDigitLauncher.mode },
    );
    chmodSync(twoDigitLauncher.launcherPath, twoDigitLauncher.mode);
    writeFileSync(
      twoDigitLauncher.metadataPath,
      twoDigitLauncher.metadataBytes,
    );
    const verifiedTwoDigitLauncher = run(
      process.execPath,
      [verifierEntryPath],
      {
        input: JSON.stringify({
          machineEntryPath,
          nodeExecutable: process.execPath,
          physicalPath: twoDigitLauncher.launcherPath,
          releaseIdentity: installedManifest.version,
        }),
      },
    );
    assert.deepEqual(JSON.parse(verifiedTwoDigitLauncher.stdout), {
      duration: 99,
      harnessType: launcherInput.harnessType,
      homeRoot: launcherHome,
    });
    assert.equal(verifiedTwoDigitLauncher.stderr, "");
    const launcher =
      launcherModule.createOwnedHookLauncherArtifacts(launcherInput);
    writeFileSync(launcher.launcherPath, launcher.launcherBytes, {
      mode: launcher.mode,
    });
    chmodSync(launcher.launcherPath, launcher.mode);
    writeFileSync(launcher.metadataPath, launcher.metadataBytes);
    const hook = run(launcher.launcherPath, [], {
      input: Buffer.from("bounded-artifact-evidence"),
    });
    assert.equal(hook.stdout, "");
    assert.equal(hook.stderr, "");
    const hookWithArguments = run(launcher.launcherPath, [
      "--harness",
      "other",
    ]);
    assert.equal(hookWithArguments.stdout, "");
    assert.equal(hookWithArguments.stderr, "");
  }
  const help = run(executable, ["--help"], executableOptions);
  assert.match(help.stdout, /^Usage: agentscope \[options\]/u);
  assert.match(help.stdout, /Documentation: https:\/\//u);
  assert.equal(help.stderr, "");
  const version = run(executable, ["--version"], executableOptions);
  assert.equal(version.stdout, `${installedManifest.version}\n`);
  assert.equal(version.stderr, "");
  const invalidHomeOptions = {
    ...executableOptions,
    env: { HOME: "relative", USERPROFILE: "relative" },
  };
  const invalidHomeHelp = run(executable, ["--help"], invalidHomeOptions);
  assert.match(invalidHomeHelp.stdout, /^Usage: agentscope \[options\]/u);
  assert.equal(invalidHomeHelp.stderr, "");
  const invalidHomeVersion = run(executable, ["--version"], invalidHomeOptions);
  assert.equal(invalidHomeVersion.stdout, `${installedManifest.version}\n`);
  assert.equal(invalidHomeVersion.stderr, "");
  const invalidHomeDoctor = runRaw(
    executable,
    ["doctor", "--output", "json"],
    invalidHomeOptions,
  );
  assert.equal(invalidHomeDoctor.status, 70);
  assert.equal(invalidHomeDoctor.stdout, "");
  assert.deepEqual(JSON.parse(invalidHomeDoctor.stderr), {
    category: "internal-error",
    code: "cli.internal",
    command: "agentscope doctor",
    schema: "agentscope.cli.diagnostic.v1",
  });
  assert.doesNotMatch(invalidHomeDoctor.stderr, /Error:|\bat\s|node_modules/u);
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
  const doctor = run(
    executable,
    ["doctor", "--fix", "--output", "json"],
    executableOptions,
  );
  const doctorReport = JSON.parse(doctor.stdout);
  assert.equal(doctor.stderr, "");
  assert.equal(doctorReport.command, "agentscope doctor");
  assert.equal(doctorReport.dataSchema, "agentscope.cli.doctor.v1");
  assert.equal(doctorReport.records.length, 1);
  assert.equal(doctorReport.records[0].fixed, false);
  assert.deepEqual(doctorReport.records[0].repairs, []);
  assert.ok(
    doctorReport.records[0].findings.some(
      (finding) => finding.code === "doctor.configuration.missing",
    ),
  );
  for (const code of [
    "doctor.harness.unavailable",
    "doctor.destination.unavailable",
  ])
    assert.ok(
      doctorReport.records[0].findings.some((finding) => finding.code === code),
    );
  assert.doesNotMatch(doctor.stdout, new RegExp(installRoot, "u"));
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
    const traces = runRaw(
      executable,
      ["traces", "search", "--destination", "missing", "--output", mode],
      {
        ...executableOptions,
        env: { HOME: agentscopeHome, USERPROFILE: agentscopeHome },
      },
    );
    assert.equal(traces.status, 3);
    assert.equal(traces.stdout, "");
    assert.deepEqual(JSON.parse(traces.stderr), {
      category: "not-found",
      code: "traces.destination-unknown",
      command: "agentscope traces search",
      schema: "agentscope.cli.diagnostic.v1",
    });
  }
  const langfuseHome = join(installRoot, "agentscope-home-langfuse");
  mkdirSync(langfuseHome);
  const loopbackScript = join(installRoot, "langfuse-loopback.mjs");
  const loopbackReady = join(installRoot, "langfuse-loopback-ready");
  const loopbackLedger = join(installRoot, "langfuse-loopback-ledger.json");
  writeFileSync(
    loopbackScript,
    `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [readyPath, ledgerPath] = process.argv.slice(2);
const server = createServer((request, response) => {
  let bodyBytes = 0;
  request.on("data", (chunk) => { bodyBytes += chunk.byteLength; });
  request.on("end", () => {
    writeFileSync(ledgerPath, JSON.stringify({
      bodyBytes,
      headers: request.headers,
      method: request.method,
      url: request.url,
    }));
    response.writeHead(405, {
      "content-type": "text/plain",
      "x-provider-canary": "discarded-provider-header",
    });
    response.end("discarded-provider-body");
    server.close();
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") process.exit(2);
  writeFileSync(readyPath, String(address.port));
});
setTimeout(() => process.exit(3), 10_000).unref();
`,
  );
  loopbackServer = spawn(
    process.execPath,
    [loopbackScript, loopbackReady, loopbackLedger],
    {
      cwd: installRoot,
      stdio: "ignore",
    },
  );
  waitForFile(loopbackReady, loopbackServer);
  const loopbackPort = Number(readFileSync(loopbackReady, "utf8"));
  assert.ok(Number.isInteger(loopbackPort) && loopbackPort > 0);
  const langfuseEnvironment = {
    HOME: langfuseHome,
    USERPROFILE: langfuseHome,
    LANGFUSE_PUBLIC_KEY: "packed-public-canary",
    LANGFUSE_SECRET_KEY: "packed-secret-canary",
  };
  run(executable, ["init", "--yes", "--output", "json"], {
    ...executableOptions,
    env: langfuseEnvironment,
  });
  const configuredLangfuse = run(
    executable,
    [
      "destination",
      "configure",
      "langfuse",
      "--name",
      "packed-langfuse",
      "--settings",
      `{"endpoint":"http://127.0.0.1:${loopbackPort}","allowInsecureLoopback":true}`,
      "--credential-env",
      "public-key=LANGFUSE_PUBLIC_KEY",
      "secret-key=LANGFUSE_SECRET_KEY",
      "--output",
      "json",
    ],
    { ...executableOptions, env: langfuseEnvironment },
  );
  assert.deepEqual(JSON.parse(configuredLangfuse.stdout).records, [
    {
      connectionId: JSON.parse(configuredLangfuse.stdout).records[0]
        .connectionId,
      destinationType: "@agentscope/destination-langfuse",
      name: "packed-langfuse",
      routed: false,
      settingsVersion: 1,
      transport: "remote",
    },
  ]);
  assert.equal(configuredLangfuse.stderr, "");
  const inspectedLangfuse = run(
    executable,
    ["destination", "inspect", "packed-langfuse", "--output", "json"],
    { ...executableOptions, env: langfuseEnvironment },
  );
  assert.deepEqual(JSON.parse(inspectedLangfuse.stdout).records, [
    {
      connection: JSON.parse(configuredLangfuse.stdout).records[0],
      credentialSlots: ["public-key", "secret-key"],
      documentationPath: "/docs/cli/destination/configure",
      settingKeys: [
        "allowInsecureLoopback",
        "compatibilityManifestId",
        "encoding",
        "endpoint",
        "profileId",
      ],
    },
  ]);
  assert.equal(inspectedLangfuse.stderr, "");
  const langfuseDoctor = run(executable, ["doctor", "--output", "json"], {
    ...executableOptions,
    env: langfuseEnvironment,
  });
  const langfuseDoctorReport = JSON.parse(langfuseDoctor.stdout);
  assert.ok(
    langfuseDoctorReport.records[0].findings.some(
      (finding) => finding.code === "doctor.credential.available",
    ),
  );
  assert.ok(
    langfuseDoctorReport.records[0].findings.some(
      (finding) => finding.code === "doctor.destination.available",
    ),
  );
  const loopbackRequest = JSON.parse(readFileSync(loopbackLedger, "utf8"));
  assert.deepEqual(loopbackRequest, {
    bodyBytes: 0,
    headers: loopbackRequest.headers,
    method: "GET",
    url: "/api/public/otel/v1/traces",
  });
  assert.equal(loopbackRequest.headers.authorization, undefined);
  assert.equal(loopbackRequest.headers.cookie, undefined);
  assert.doesNotMatch(
    JSON.stringify(loopbackRequest),
    /packed-(?:public|secret)-canary/u,
  );
  assert.doesNotMatch(
    `${langfuseDoctor.stdout}${langfuseDoctor.stderr}`,
    /packed-(?:public|secret)-canary|discarded-provider/u,
  );
  if (
    process.platform === "linux" &&
    process.arch === "x64" &&
    process.versions.modules === "127"
  ) {
    const localUserHome = join(installRoot, "local-lifecycle-user-home");
    const localHome = join(localUserHome, ".agentscope");
    mkdirSync(localUserHome);
    const localEnvironment = {
      HOME: localUserHome,
      USERPROFILE: localUserHome,
    };
    run(executable, ["init", "--yes", "--output", "json"], {
      ...executableOptions,
      env: localEnvironment,
    });
    const configurationBeforePlan = readFileSync(
      join(localHome, "config.json"),
    );
    const plannedConfigure = run(
      executable,
      [
        "destination",
        "configure",
        "local-sqlite",
        "--name",
        "packed-local",
        "--output",
        "json",
      ],
      { ...executableOptions, env: localEnvironment },
    );
    assert.deepEqual(JSON.parse(plannedConfigure.stdout).records, [
      {
        applied: false,
        connection: null,
        generation: null,
        plan: JSON.parse(plannedConfigure.stdout).records[0].plan,
        state: "planned",
      },
    ]);
    assert.equal(
      JSON.parse(plannedConfigure.stdout).records[0].plan.operation,
      "configure",
    );
    assert.equal(
      JSON.parse(plannedConfigure.stdout).records[0].plan.retentionPolicy
        .physicalCleanupTrigger,
      "next-authorized-mutation",
    );
    assert.deepEqual(
      readFileSync(join(localHome, "config.json")),
      configurationBeforePlan,
    );
    assert.equal(
      existsSync(join(localHome, "destinations", "local-sqlite")),
      false,
    );
    const configuredLocal = run(
      executable,
      [
        "destination",
        "configure",
        "local-sqlite",
        "--name",
        "packed-local",
        "--yes",
        "--output",
        "json",
      ],
      { ...executableOptions, env: localEnvironment },
    );
    const configuredLocalRecords = JSON.parse(configuredLocal.stdout).records;
    assert.equal(configuredLocalRecords.length, 1);
    const configuredLocalRecord = configuredLocalRecords[0];
    assert.match(
      configuredLocalRecord.connectionId,
      /^destination-connection-v1-[0-9a-f]{64}$/u,
    );
    assert.equal(
      configuredLocalRecord.destinationType,
      "@agentscope/destination-local-sqlite",
    );
    assert.equal(configuredLocalRecord.name, "packed-local");
    assert.equal(configuredLocalRecord.routed, false);
    assert.equal(configuredLocalRecord.settingsVersion, 1);
    assert.equal(configuredLocalRecord.transport, "local");
    assert.deepEqual(configuredLocalRecords, [
      {
        connectionId: configuredLocalRecord.connectionId,
        destinationType: "@agentscope/destination-local-sqlite",
        name: "packed-local",
        routed: false,
        settingsVersion: 1,
        transport: "local",
      },
    ]);
    assert.match(configuredLocal.stderr, /"state":"planned"/u);
    const localDoctor = run(executable, ["doctor", "--output", "json"], {
      ...executableOptions,
      env: localEnvironment,
    });
    const localFinding = JSON.parse(
      localDoctor.stdout,
    ).records[0].findings.find(
      ({ code }) => code === "doctor.destination.local-resource.available",
    );
    assert.ok(localFinding);
    assert.deepEqual(
      localFinding.evidence.localResource.databaseDerivedRetention,
      {
        clockContinuity: "unavailable",
        cutoff: "unavailable",
        payloadBytes: "unavailable",
        rowCount: "unavailable",
      },
    );
    const localNamespace = join(localHome, "destinations", "local-sqlite");
    const configuredDatabaseFamily = snapshotSqliteFamily(localNamespace);
    const plannedUnconfigure = run(
      executable,
      ["destination", "unconfigure", "packed-local", "--output", "json"],
      { ...executableOptions, env: localEnvironment },
    );
    assert.equal(
      JSON.parse(plannedUnconfigure.stdout).records[0].applied,
      false,
    );
    const unconfiguredLocal = run(
      executable,
      [
        "destination",
        "unconfigure",
        "packed-local",
        "--yes",
        "--output",
        "json",
      ],
      { ...executableOptions, env: localEnvironment },
    );
    const retainedSelector = JSON.parse(unconfiguredLocal.stdout).records[0]
      .retainedDeleteSelector;
    assert.match(retainedSelector, /^destination-connection-v1-[0-9a-f]{64}$/u);
    assert.equal(
      JSON.parse(unconfiguredLocal.stdout).records[0].state,
      "retained",
    );
    assert.deepEqual(
      snapshotSqliteFamily(localNamespace),
      configuredDatabaseFamily,
    );
    const plannedDelete = run(
      executable,
      ["destination", "delete", retainedSelector, "--output", "json"],
      { ...executableOptions, env: localEnvironment },
    );
    assert.deepEqual(JSON.parse(plannedDelete.stdout).records[0], {
      applied: false,
      deleted: false,
      plan: JSON.parse(plannedDelete.stdout).records[0].plan,
      selector: retainedSelector,
      state: "planned",
    });
    assert.deepEqual(
      snapshotSqliteFamily(localNamespace),
      configuredDatabaseFamily,
    );
    const deletedLocal = run(
      executable,
      [
        "destination",
        "delete",
        retainedSelector,
        "--confirm",
        "--output",
        "json",
      ],
      { ...executableOptions, env: localEnvironment },
    );
    assert.equal(JSON.parse(deletedLocal.stdout).records[0].deleted, true);
    assert.deepEqual(
      existsSync(localNamespace) ? regularFiles(localNamespace) : [],
      [],
    );
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
    join(installRoot, "node_modules/agentscope-cli/dist/bin/agentscope.js"),
    "utf8",
  );
  assert.doesNotMatch(bundle, /["']workspace:(?!\/\/)/u);
  assert.doesNotMatch(bundle, /from\s+["']@agentscope\//u);
  assert.doesNotMatch(bundle, /require\(["']@agentscope\//u);
  assert.equal(
    existsSync(join(installRoot, "node_modules/@agentscope")),
    false,
  );
  const installedRoot = join(installRoot, "node_modules/agentscope-cli");
  const installedFiles = regularFiles(installedRoot);
  const candidateRoot = join(installedRoot, "dist/internal/local-sqlite");
  assert.deepEqual(regularFiles(join(installedRoot, "dist/bin/migrations")), [
    "0001-initialize.sql",
    "0002-retrieval-indexes.sql",
  ]);
  assert.deepEqual(
    regularFiles(join(installedRoot, "dist/internal/local-sqlite-runtime")),
    [
      "migrations/0001-initialize.sql",
      "migrations/0002-retrieval-indexes.sql",
      "reporter-child.js",
      "reporter-watchdog.js",
      "retriever-child.js",
    ],
  );
  const supportManifestPath = join(
    candidateRoot,
    "records/support-manifest.json",
  );
  const supportManifestBytes = readFileSync(supportManifestPath);
  assert.equal(
    createHash("sha256").update(supportManifestBytes).digest("hex"),
    "587e01fac592f3989b05d634fd8a5a03f1d72bebef3c83da0a22b0ca18d1ff76",
  );
  const supportManifest = JSON.parse(supportManifestBytes);
  assert.equal(
    supportManifest.disposition,
    "proposed-unpublished-execution-eligible",
  );
  assert.equal(supportManifest.nativeBinaries.length, 1);
  assert.equal(supportManifest.supportedPlatforms.length, 1);
  const declaredCandidateFiles = supportManifest.artifactFiles
    .map(({ relativePath }) => relativePath)
    .concat("records/support-manifest.json")
    .sort();
  assert.deepEqual(regularFiles(candidateRoot), declaredCandidateFiles);
  for (const artifact of supportManifest.artifactFiles) {
    const bytes = readFileSync(join(candidateRoot, artifact.relativePath));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      artifact.digest,
    );
  }
  const permittedNative =
    "dist/internal/local-sqlite/native/node127-linux-x64-glibc/agentscope_sqlite.node";
  assert.deepEqual(
    installedFiles.filter((file) => file.endsWith(".node")),
    [permittedNative],
  );
  assert.equal(
    installedFiles.some(
      (file) =>
        file !== permittedNative &&
        /(?:^|\/)(?:binding\.gyp|build|prebuilds?|src)(?:\/|$)/u.test(file),
    ),
    false,
  );
  assert.doesNotMatch(bundle, /node-gyp|binding\.gyp/u);
  assert.deepEqual(bundle.match(/better-sqlite3[^"'\s]*/gu), [
    "better-sqlite3.cjs",
    "better-sqlite3-MIT.txt",
  ]);

  process.stdout.write(
    `Verified clean install of ${basename(tarball)} (${packReport[0].integrity})\n`,
  );
} finally {
  loopbackServer?.kill();
  rmSync(installRoot, { force: true, recursive: true });
}
