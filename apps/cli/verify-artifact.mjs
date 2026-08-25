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
  const executableOptions = {
    cwd: installRoot,
    shell: process.platform === "win32",
  };
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
    "07059633fd124a278d16a1421d3dbd27f5778b1b26f5fecca9f24f27addedd2d",
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
