import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { commandRegistry } from "../src/command-registry.js";
import type { CommandRegistration } from "../src/command-registry.js";

type Invocation = Readonly<{
  args: readonly string[];
  caseId: string;
  expectedCode?: number;
  expectedDiagnostic?: string;
  input?: string;
  mutation?: "allowed";
  prepare?: "initialized" | "invalid-configuration";
}>;

type CommandContract = Readonly<{
  invocation: Invocation;
  missing?: readonly string[];
}>;

type InvocationResult = Readonly<{
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}>;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MILLISECONDS = 15_000;
const EXPECTED_PACKAGE = "agentscope-cli";
const EXPECTED_BIN = "agentscope";
const requiredArgumentDiagnostic = "cli.input.invalid";
const localSqliteCandidateAvailable =
  process.platform === "linux" &&
  process.arch === "x64" &&
  process.versions.modules === "127";

function parseNamedArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  assert.ok(value, `missing ${name}`);
  return value;
}

const executable = resolve(parseNamedArgument("--executable"));
const tarball = resolve(parseNamedArgument("--tarball"));
const installedPackageRoot = resolve(
  parseNamedArgument("--installed-package-root"),
);
const expectedVersion = parseNamedArgument("--expected-version");
const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));
const candidateDigest = `sha256:${createHash("sha256")
  .update(readFileSync(tarball))
  .digest("hex")}`;

function fail(caseId: string, message: string): never {
  throw new Error(`[${candidateDigest} ${caseId}] ${message}`);
}

function check(caseId: string, operation: () => void): void {
  try {
    operation();
  } catch (error: unknown) {
    fail(caseId, error instanceof Error ? error.message : "unknown failure");
  }
}

function regularFileSnapshot(root: string): readonly string[] {
  if (!existsSync(root)) return Object.freeze([]);
  const rootMetadata = lstatSync(root);
  assert.equal(rootMetadata.isDirectory(), true);
  const pending = [root];
  const records: string[] = [`directory:.:${rootMetadata.mode & 0o777}`];
  while (pending.length > 0) {
    const directory = pending.pop();
    assert.ok(directory);
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      const relativePath = relative(root, path);
      if (metadata.isDirectory()) {
        pending.push(path);
        records.push(`directory:${relativePath}:${metadata.mode & 0o777}`);
      } else {
        assert.equal(metadata.isFile(), true);
        const digest = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
        records.push(
          `${relativePath}:${metadata.mode & 0o777}:${metadata.size}:${digest}`,
        );
      }
    }
  }
  return Object.freeze(records.sort());
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(process.execPath);
  return Object.freeze({
    COLUMNS: "7",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    PATH: nodeDirectory,
    ROWS: "4",
    TMPDIR: join(home, "temporary files"),
    USERPROFILE: home,
  });
}

function invoke(
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  input = "",
): InvocationResult {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    env: environment,
    input,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: process.platform === "win32",
    timeout: PROCESS_TIMEOUT_MILLISECONDS,
  });
  assert.equal(result.error, undefined);
  assert.ok(Buffer.byteLength(result.stdout ?? "") <= MAX_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(result.stderr ?? "") <= MAX_OUTPUT_BYTES);
  return Object.freeze({
    signal: result.signal,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  });
}

function parseJsonLines(text: string): readonly Record<string, unknown>[] {
  return text
    .trimEnd()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function diagnosticCode(result: InvocationResult): string | undefined {
  const trimmed = result.stderr.trim();
  if (trimmed.startsWith("error ["))
    return /^error \[([a-z0-9.-]+)\]$/u.exec(trimmed)?.[1];
  try {
    const records = parseJsonLines(result.stderr);
    if (records.length !== 1) return undefined;
    return typeof records[0]?.code === "string" ? records[0].code : undefined;
  } catch {
    return undefined;
  }
}

function assertMachineOutput(
  caseId: string,
  mode: "json" | "jsonl",
  result: InvocationResult,
): void {
  if (result.status === 0) {
    const records = parseJsonLines(result.stdout);
    assert.ok(records.length > 0);
    if (mode === "json") {
      assert.equal(records.length, 1);
      assert.equal(records[0]?.schema, "agentscope.cli.result.v1");
    } else {
      assert.equal(records.at(-1)?.schema, "agentscope.cli.record.v1");
      assert.equal(records.at(-1)?.kind, "summary");
    }
    for (const record of parseJsonLines(result.stderr))
      assert.match(
        String(record.schema),
        /^agentscope\.cli\.plan(?:-record)?\.v1$/u,
      );
  } else {
    assert.equal(result.stdout, "");
    const diagnostics = parseJsonLines(result.stderr);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.schema, "agentscope.cli.diagnostic.v1");
  }
  check(caseId, () => {
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /node_modules|(?:^|\n)\s*at\s|Error:|CREDENTIAL_CANARY/u,
    );
  });
}

const contracts = Object.freeze({
  doctor: {
    invocation: { args: [], caseId: "doctor.valid", prepare: "initialized" },
  },
  init: { invocation: { args: [], caseId: "init.valid" } },
  install: {
    invocation: {
      args: ["codex"],
      caseId: "install.valid",
      expectedCode: 3,
      expectedDiagnostic: "harness.adapter-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  uninstall: {
    invocation: {
      args: ["codex"],
      caseId: "uninstall.valid",
      expectedCode: 3,
      expectedDiagnostic: "harness.adapter-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "harness.list": {
    invocation: {
      args: [],
      caseId: "harness.list.valid",
      prepare: "initialized",
    },
  },
  "harness.status": {
    invocation: {
      args: ["codex"],
      caseId: "harness.status.valid",
      expectedCode: 3,
      expectedDiagnostic: "harness.adapter-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "harness.migrate": {
    invocation: {
      args: ["codex"],
      caseId: "harness.migrate.valid",
      expectedCode: 3,
      expectedDiagnostic: "harness.adapter-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "destination.configure": {
    invocation: {
      args: ["local-sqlite", "--name", "contract-local"],
      caseId: "destination.configure.valid",
      expectedCode: localSqliteCandidateAvailable ? 0 : 5,
      ...(localSqliteCandidateAvailable
        ? {}
        : { expectedDiagnostic: "destination.lifecycle-unavailable" }),
      prepare: "initialized",
    },
    missing: ["local-sqlite"],
  },
  "destination.delete": {
    invocation: {
      args: ["missing-owned-selector"],
      caseId: "destination.delete.valid",
      expectedCode: 3,
      expectedDiagnostic: "destination.connection-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "destination.recover": {
    invocation: {
      args: [],
      caseId: "destination.recover.valid",
      expectedCode: 3,
      expectedDiagnostic: "configuration.missing",
      prepare: "initialized",
    },
  },
  "destination.inspect": {
    invocation: {
      args: ["missing-connection"],
      caseId: "destination.inspect.valid",
      expectedCode: 3,
      expectedDiagnostic: "destination.connection-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "destination.list": {
    invocation: {
      args: [],
      caseId: "destination.list.valid",
      prepare: "initialized",
    },
  },
  "destination.rotate": {
    invocation: {
      args: [
        "missing-connection",
        "--slot",
        "secret-key",
        "--environment-variable",
        "CREDENTIAL_CANARY",
      ],
      caseId: "destination.rotate.valid",
      expectedCode: 3,
      expectedDiagnostic: "destination.connection-missing",
      prepare: "initialized",
    },
    missing: ["missing-connection", "--slot", "secret-key"],
  },
  "destination.unconfigure": {
    invocation: {
      args: ["missing-connection"],
      caseId: "destination.unconfigure.valid",
      expectedCode: 3,
      expectedDiagnostic: "destination.connection-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "traces.search": {
    invocation: {
      args: ["--destination", "missing-connection", "--limit", "50"],
      caseId: "traces.search.valid",
      expectedCode: 3,
      expectedDiagnostic: "traces.destination-unknown",
      prepare: "initialized",
    },
    missing: [],
  },
  "traces.get": {
    invocation: {
      args: [
        "--destination",
        "missing-connection",
        "--trace-id",
        "0123456789abcdef0123456789abcdef",
      ],
      caseId: "traces.get.valid",
      expectedCode: 3,
      expectedDiagnostic: "traces.destination-unknown",
      prepare: "initialized",
    },
    missing: ["--destination", "missing-connection"],
  },
  "routing.list": {
    invocation: {
      args: [],
      caseId: "routing.list.valid",
      prepare: "initialized",
    },
  },
  "routing.set": {
    invocation: {
      args: [],
      caseId: "routing.set.valid",
      mutation: "allowed",
      prepare: "initialized",
    },
  },
} satisfies Readonly<Record<string, CommandContract>>);

function createCaseRoot(caseId: string): Readonly<{
  cwd: string;
  environment: NodeJS.ProcessEnv;
  home: string;
  stateRoot: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "agentscope CLI contract — 测试 "));
  const home = join(root, "user home with spaces");
  const cwd = join(root, `workspace ${caseId}`);
  mkdirSync(home);
  mkdirSync(cwd);
  const environment = isolatedEnvironment(home);
  mkdirSync(environment.TMPDIR as string);
  return {
    cwd,
    environment,
    home,
    stateRoot: join(home, ".agentscope"),
  };
}

function prepareCase(
  prepare: Invocation["prepare"],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): void {
  if (prepare === undefined) return;
  if (prepare === "invalid-configuration") {
    assert.ok(environment.HOME);
    const agentscopeHome = join(environment.HOME, ".agentscope");
    mkdirSync(agentscopeHome, { recursive: true });
    writeFileSync(join(agentscopeHome, "config.json"), "{invalid");
    return;
  }
  const initialized = invoke(
    ["init", "--yes", "--output", "json"],
    cwd,
    environment,
  );
  assert.equal(initialized.status, 0);
  assert.equal(initialized.signal, null);
}

function runInvocation(
  command: CommandRegistration,
  invocation: Invocation,
  mode: "human" | "json" | "jsonl",
): void {
  const caseId = `${invocation.caseId}.${mode}`;
  const fixture = createCaseRoot(caseId);
  try {
    prepareCase(invocation.prepare, fixture.cwd, fixture.environment);
    const before = regularFileSnapshot(fixture.stateRoot);
    const result = invoke(
      [...command.path, ...invocation.args, "--output", mode],
      fixture.cwd,
      fixture.environment,
      invocation.input,
    );
    check(caseId, () => {
      assert.equal(result.signal, null);
      assert.equal(result.status, invocation.expectedCode ?? 0);
      if (invocation.expectedDiagnostic !== undefined)
        assert.equal(diagnosticCode(result), invocation.expectedDiagnostic);
      if (mode === "human") {
        assert.doesNotMatch(
          `${result.stdout}${result.stderr}`,
          /CREDENTIAL_CANARY|node_modules|(?:^|\n)\s*at\s|Error:/u,
        );
        if (result.status === 0) assert.notEqual(result.stdout, "");
        else {
          assert.equal(result.stdout, "");
          assert.match(result.stderr, /^error \[[a-z0-9.-]+\]\n$/u);
        }
      } else assertMachineOutput(caseId, mode, result);
      if (invocation.mutation !== "allowed")
        assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
    });
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

const publicInventory = commandRegistry.filter(
  (registration) => registration.visibility === "public",
);
const publicCommands = publicInventory.filter(
  (registration) => registration.kind === "command",
);

check("artifact.identity", () => {
  const installedManifest = JSON.parse(
    readFileSync(join(installedPackageRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(installedManifest.name, EXPECTED_PACKAGE);
  assert.equal(installedManifest.version, expectedVersion);
  assert.deepEqual(installedManifest.bin, {
    [EXPECTED_BIN]: "./dist/bin/agentscope.js",
  });
  const realExecutable = realpathSync(executable);
  assert.equal(realExecutable.startsWith(`${repositoryRoot}${sep}`), false);
  assert.equal(
    realExecutable.startsWith(`${realpathSync(installedPackageRoot)}${sep}`),
    true,
  );
  assert.match(candidateDigest, /^sha256:[0-9a-f]{64}$/u);
});

check("inventory.coverage", () => {
  assert.deepEqual(
    Object.keys(contracts).sort(),
    publicCommands.map((registration) => registration.id).sort(),
  );
});

for (const registration of publicInventory) {
  const caseId = `help.${registration.id}`;
  const fixture = createCaseRoot(caseId);
  try {
    const before = regularFileSnapshot(fixture.stateRoot);
    const result = invoke(
      [...registration.path, "--help"],
      fixture.cwd,
      fixture.environment,
    );
    check(caseId, () => {
      assert.equal(result.status, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /^Usage: agentscope/u);
      assert.match(result.stdout, /Documentation: https:\/\//u);
      assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
    });
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

for (const registration of publicCommands) {
  const contract = contracts[
    registration.id as keyof typeof contracts
  ] as CommandContract;
  assert.ok(contract);
  for (const mode of registration.outputModes) {
    assert.notEqual(mode, undefined);
    runInvocation(registration, contract.invocation, mode);
  }
  {
    const caseId = `${registration.id}.unsupported-output`;
    const fixture = createCaseRoot(caseId);
    try {
      prepareCase(
        contract.invocation.prepare,
        fixture.cwd,
        fixture.environment,
      );
      const before = regularFileSnapshot(fixture.stateRoot);
      const result = invoke(
        [...registration.path, ...contract.invocation.args, "--output", "yaml"],
        fixture.cwd,
        fixture.environment,
      );
      check(caseId, () => {
        assert.equal(result.status, 2);
        assert.equal(diagnosticCode(result), "cli.output.unsupported");
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "error [cli.output.unsupported]\n");
        assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
      });
    } finally {
      rmSync(dirname(fixture.home), { force: true, recursive: true });
    }
  }
  if (contract.missing !== undefined) {
    const caseId = `${registration.id}.missing-required`;
    const fixture = createCaseRoot(caseId);
    try {
      prepareCase("initialized", fixture.cwd, fixture.environment);
      const before = regularFileSnapshot(fixture.stateRoot);
      const result = invoke(
        [...registration.path, ...contract.missing, "--output", "json"],
        fixture.cwd,
        fixture.environment,
      );
      check(caseId, () => {
        assert.equal(result.status, 2);
        assert.equal(diagnosticCode(result), requiredArgumentDiagnostic);
        assert.equal(result.stdout, "");
        assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
      });
    } finally {
      rmSync(dirname(fixture.home), { force: true, recursive: true });
    }
  }
}

{
  const caseId = "root.version";
  const fixture = createCaseRoot(caseId);
  try {
    const before = regularFileSnapshot(fixture.stateRoot);
    const result = invoke(["--version"], fixture.cwd, fixture.environment);
    check(caseId, () => {
      assert.equal(result.status, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, `${expectedVersion}\n`);
      assert.equal(result.stderr, "");
      assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
    });
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

const hostileCases: readonly Invocation[] = Object.freeze([
  {
    args: ["--does-not-exist-CREDENTIAL_CANARY"],
    caseId: "arguments.unknown",
    expectedCode: 2,
    expectedDiagnostic: requiredArgumentDiagnostic,
  },
  {
    args: ["--does-not-exist", "line\nbreak"],
    caseId: "arguments.control-character",
    expectedCode: 2,
    expectedDiagnostic: requiredArgumentDiagnostic,
  },
  {
    args: ["--does-not-exist", "x".repeat(8_193)],
    caseId: "arguments.oversized",
    expectedCode: 2,
    expectedDiagnostic: requiredArgumentDiagnostic,
  },
]);

for (const hostile of hostileCases) {
  const fixture = createCaseRoot(hostile.caseId);
  try {
    const before = regularFileSnapshot(fixture.stateRoot);
    const result = invoke(hostile.args, fixture.cwd, fixture.environment);
    check(hostile.caseId, () => {
      assert.equal(result.status, hostile.expectedCode);
      assert.equal(diagnosticCode(result), hostile.expectedDiagnostic);
      assert.equal(result.stdout, "");
      assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
      assert.doesNotMatch(result.stderr, /CREDENTIAL_CANARY|line|break/u);
    });
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

{
  const caseId = "arguments.conflicting-trace-identities";
  const fixture = createCaseRoot(caseId);
  try {
    prepareCase("initialized", fixture.cwd, fixture.environment);
    const before = regularFileSnapshot(fixture.stateRoot);
    const result = invoke(
      [
        "traces",
        "get",
        "--destination",
        "missing",
        "--trace-id",
        "0123456789abcdef0123456789abcdef",
        "--trace-ref",
        '{"traceId":"fedcba9876543210fedcba9876543210"}',
        "--output",
        "json",
      ],
      fixture.cwd,
      fixture.environment,
    );
    check(caseId, () => {
      assert.equal(result.status, 2);
      assert.equal(diagnosticCode(result), requiredArgumentDiagnostic);
      assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
    });
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

{
  const caseId = "arguments.duplicate-connection";
  const fixture = createCaseRoot(caseId);
  try {
    prepareCase("initialized", fixture.cwd, fixture.environment);
    const before = regularFileSnapshot(fixture.stateRoot);
    const result = invoke(
      ["routing", "set", "duplicate", "duplicate", "--output", "json"],
      fixture.cwd,
      fixture.environment,
    );
    check(caseId, () => {
      assert.equal(result.status, 2);
      assert.equal(diagnosticCode(result), "routing.duplicate-connection");
      assert.equal(result.stdout, "");
      assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
    });
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

{
  const caseId = "confirmation.non-tty-eof-cancel";
  const fixture = createCaseRoot(caseId);
  try {
    const before = regularFileSnapshot(fixture.stateRoot);
    for (const input of ["", "no\n", "yes\n"]) {
      const result = invoke(
        ["init", "--output", "json"],
        fixture.cwd,
        fixture.environment,
        input,
      );
      check(caseId, () => {
        assert.equal(result.status, 0);
        const output: unknown = JSON.parse(result.stdout);
        assert.equal(
          (output as { schema: unknown }).schema,
          "agentscope.cli.result.v1",
        );
        assert.equal(result.stderr, "");
        assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
      });
    }
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

{
  const caseId = "state.idempotent-init";
  const fixture = createCaseRoot(caseId);
  try {
    const args = ["init", "--yes", "--output", "json"];
    const first = invoke(args, fixture.cwd, fixture.environment);
    check(caseId, () => {
      assert.equal(first.status, 0);
    });
    const firstState = regularFileSnapshot(fixture.stateRoot);
    const second = invoke(args, fixture.cwd, fixture.environment);
    check(caseId, () => {
      assert.equal(second.status, 0);
      assert.deepEqual(regularFileSnapshot(fixture.stateRoot), firstState);
    });
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

{
  const caseId = "state.conflicting-invalid-configuration";
  const fixture = createCaseRoot(caseId);
  try {
    prepareCase("invalid-configuration", fixture.cwd, fixture.environment);
    const before = regularFileSnapshot(fixture.stateRoot);
    const result = invoke(
      ["init", "--yes", "--output", "json"],
      fixture.cwd,
      fixture.environment,
    );
    check(caseId, () => {
      assert.equal(result.status, 5);
      assert.equal(diagnosticCode(result), "configuration.unavailable");
      assert.deepEqual(regularFileSnapshot(fixture.stateRoot), before);
    });
  } finally {
    rmSync(dirname(fixture.home), { force: true, recursive: true });
  }
}

process.stdout.write(
  `${JSON.stringify({
    candidateDigest,
    caseCount:
      publicInventory.length +
      publicCommands.reduce(
        (count, registration) => {
          const contract = contracts[
            registration.id as keyof typeof contracts
          ] as CommandContract;
          return (
            count +
            registration.outputModes.length +
            (contract.missing === undefined ? 0 : 1)
          );
        },
        hostileCases.length + publicCommands.length + 6,
      ),
    inventoryDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(publicInventory))
      .digest("hex")}`,
    package: EXPECTED_PACKAGE,
    schema: "agentscope.cli.installed-contract-evidence.v1",
    version: expectedVersion,
  })}\n`,
);
