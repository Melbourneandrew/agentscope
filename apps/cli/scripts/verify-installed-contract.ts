import assert from "node:assert/strict";
import { createHash } from "node:crypto";

type OutputMode = "human" | "json" | "jsonl";
type PublicRegistration = Readonly<{
  id: string;
  kind: "command" | "group" | "root";
  outputModes: readonly OutputMode[];
  path: readonly string[];
  visibility: "public";
}>;
type Setup = "initialized" | "invalid-configuration" | "none";
type OutputRule = "confirmation" | "help" | OutputMode | "version";
type StateRule = "any" | "capture" | "same-as-before" | "same-as-previous";
export type InstalledCliExecutionMode =
  | "deadline-child"
  | "direct"
  | "pty-narrow"
  | "signal-int"
  | "signal-term"
  | "stdout-closed";
export type InstalledCliContractStep = Readonly<{
  args: readonly string[];
  executionMode: InstalledCliExecutionMode;
  expectedDiagnostic?: string;
  expectedOutputBytes?: number;
  expectedOutputSha256?: string;
  expectedOutcome: "exited" | "timed-out";
  expectedSignal: "SIGKILL" | "SIGTERM" | null;
  expectedStatus: number | null;
  input: string;
  outputRule: OutputRule;
  stateRule: StateRule;
}>;
export type InstalledCliContractCase = Readonly<{
  caseId: string;
  setup: Setup;
  steps: readonly InstalledCliContractStep[];
}>;
export type InstalledCliContractPlan = Readonly<{
  caseIds: readonly string[];
  caseIdsDigest: string;
  cases: readonly InstalledCliContractCase[];
  expectedVersion: string;
  inventoryDigest: string;
  planVersion: 1;
  receiptCaseIds: readonly string[];
  receiptCaseIdsDigest: string;
}>;
export type InstalledCliInvocationResult = Readonly<{
  outcome: "cleanup-failed" | "exited" | "output-limit" | "timed-out";
  signal: "SIGKILL" | "SIGTERM" | null;
  status: number | null;
  stderr: string;
  stdout: string;
  pty?: Readonly<{
    cleanup: "clean" | "residual" | "uncertain";
    initialGeometry: Readonly<{ columns: number; rows: number }>;
    isTTY: true;
    observedGeometry: Readonly<{ columns: number; rows: number }>;
    outputBytes: number;
    outputSha256: string;
    processJoined: boolean;
    residualProcessCount: number;
    terminalInputJoined: boolean;
    terminalOutputJoined: boolean;
    terminalTransportClosed: boolean;
  }>;
}>;
export type InstalledCliContractObservation = Readonly<{
  afterStateDigests: readonly string[];
  beforeStateDigest: string;
  caseId: string;
  results: readonly InstalledCliInvocationResult[];
  setupResult?: InstalledCliInvocationResult;
}>;
export type InstalledCliArtifactIdentity = Readonly<{
  bin: Readonly<Record<string, string>>;
  candidateDigest: string;
  executableRealPath: string;
  installedPackageRootRealPath: string;
  package: string;
  version: string;
}>;
export type InstalledCliContractEvidence = Readonly<{
  candidateDigest: string;
  caseCount: number;
  caseIdsDigest: string;
  inventoryDigest: string;
  package: "agentscope-cli";
  receiptCaseIdsDigest: string;
  receiptCount: number;
  schema: "agentscope.cli.installed-contract-evidence.v2";
  version: string;
}>;

type Invocation = Readonly<{
  args: readonly string[];
  caseId: string;
  expectedDiagnostic?: string;
  expectedStatus?: number;
  mutation?: "allowed";
  prepare?: Exclude<Setup, "none">;
}>;
type CommandContract = Readonly<{
  invocation: Invocation;
  missing?: readonly string[];
}>;

const EXPECTED_PACKAGE = "agentscope-cli";
const EXPECTED_BIN = "agentscope";
const MAXIMUM_OUTPUT_BYTES = 1_048_576;
const requiredArgumentDiagnostic = "cli.input.invalid";
const hash = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const helpOutputSha256: Readonly<Record<string, string>> = Object.freeze({
  root: "sha256:8fcbbfc67bf775d99259cb1270ab792f85de96bffc6c36c1364f7770624ccdb8",
  destination:
    "sha256:1bd5ccfc129547fb896bf0a354abcb2bb45efe67cafdd66a83fec176c1a40e2a",
  doctor:
    "sha256:defeabae71411adbf59381696cf36df8848e305bfb2cba0606351274722dbfc5",
  harness:
    "sha256:faf0119dc935e00e9efd0718f248f5ad9b2791730b5ef3035c21285a1a7b5823",
  init: "sha256:d1d2199fd188799889209dbf44713f6f252c7ec25d1b91fd71d17e2d8ea2b2ff",
  install:
    "sha256:61ea97306951cd84868fd689a95de90d7819f6dbc5d142dde40d73e947225451",
  routing:
    "sha256:901821414f8a421486af7f162d1cd775cd8cc51d2901e3d7ad5f3fe79ca783c2",
  traces:
    "sha256:a73ee0c89ee85050d7a3cbc03a6bf145517b6025ac7808858d6982b6e804a318",
  uninstall:
    "sha256:8d71c41cec15b9968827c0b5a6b0f90bf9ba34a40c13430df4c9f8a7e0656a89",
  "destination.configure":
    "sha256:76fcdef61348679aa22852d3685b0a49fec030ec8628c7c59223e61809a7ce7f",
  "destination.delete":
    "sha256:3aab6441b24b33eb6e8c2db67c80a37b7d81a89ecada1702cee30dace1e66934",
  "destination.inspect":
    "sha256:ef9b8ecaa25900a1eb3da3613abcca9ff72f103abf537d498421193814e91973",
  "destination.list":
    "sha256:7dac30c397a598834ed0a01aa4b629649f294c8bc2a41d52dc43c78f183b472e",
  "destination.recover":
    "sha256:205c9570c327e69a9b6b2454f58d7dd8f3a56fe27959aa1af583fda7c7c1b838",
  "destination.rotate":
    "sha256:5fabbdfe1eab64ae4bae061c00d62c75387107a8fc8ff241315d5c9df8e79674",
  "destination.unconfigure":
    "sha256:ce0f1204caf7aef1e0427bbbe914615846f0aae9e2411e6ebfa400df1182edac",
  "harness.list":
    "sha256:703ef6fb8af2f7133aed09e759750206154649704daaa60c11e7b6416c03a9bd",
  "harness.migrate":
    "sha256:25405b5218594e4883f9cc26957f6197789d2fce55392cf04e639e4834473f77",
  "harness.status":
    "sha256:1122fb4e0337ecdae728b3011446707e632a601d36695539b0ce687fc17cb368",
  "routing.list":
    "sha256:9d44991035520d4ccf06bd64b9ad5b706274af7c4e9c4cfbd691a46136c00d54",
  "routing.set":
    "sha256:5b255d1357d310bc5f8130827860d37b088c046b66aaa997a7538c64470730e0",
  "traces.get":
    "sha256:da7b817cb3d13eeea80eeb27884bb078715b37d4461892fae38a9b1f1328ebe0",
  "traces.search":
    "sha256:e45194440569386d57fea521e74d17d999732802cab9d1552969a959c32746bd",
} satisfies Readonly<Record<string, string>>);
const narrowPtyHelp = Object.freeze({
  bytes: 1_182,
  sha256:
    "sha256:dd9b8aae571f7f55ead503a37bf6ebfe43848f96c2f91396ee19b50d98578639",
});
const helpDigestFor = (registrationId: string): string => {
  const expected = helpOutputSha256[registrationId];
  assert.match(expected ?? "", /^sha256:[0-9a-f]{64}$/u);
  return expected as string;
};
export const validateInstalledCliHelpOutput = (
  registrationId: string,
  output: string,
): void => {
  assert.equal(typeof registrationId, "string");
  assert.equal(typeof output, "string");
  assert.deepEqual(
    Object.keys(helpOutputSha256).sort(),
    expectedPublicCommandInventory.map(({ id }) => id).sort(),
  );
  assert.equal(hash(output), helpDigestFor(registrationId));
};

// This closed projection is development-only oracle input. verify-artifact.mjs
// independently compares it with the production command registry before pack.
export const expectedPublicCommandInventory: readonly PublicRegistration[] =
  Object.freeze(
    (
      [
        {
          id: "root",
          kind: "root",
          path: [],
          outputModes: ["human"],
          visibility: "public",
        },
        {
          id: "destination",
          kind: "group",
          path: ["destination"],
          outputModes: ["human"],
          visibility: "public",
        },
        {
          id: "doctor",
          kind: "command",
          path: ["doctor"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "harness",
          kind: "group",
          path: ["harness"],
          outputModes: ["human"],
          visibility: "public",
        },
        {
          id: "init",
          kind: "command",
          path: ["init"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "install",
          kind: "command",
          path: ["install"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "routing",
          kind: "group",
          path: ["routing"],
          outputModes: ["human"],
          visibility: "public",
        },
        {
          id: "traces",
          kind: "group",
          path: ["traces"],
          outputModes: ["human"],
          visibility: "public",
        },
        {
          id: "uninstall",
          kind: "command",
          path: ["uninstall"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "destination.configure",
          kind: "command",
          path: ["destination", "configure"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "destination.delete",
          kind: "command",
          path: ["destination", "delete"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "destination.inspect",
          kind: "command",
          path: ["destination", "inspect"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "destination.list",
          kind: "command",
          path: ["destination", "list"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "destination.recover",
          kind: "command",
          path: ["destination", "recover"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "destination.rotate",
          kind: "command",
          path: ["destination", "rotate"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "destination.unconfigure",
          kind: "command",
          path: ["destination", "unconfigure"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "harness.list",
          kind: "command",
          path: ["harness", "list"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "harness.migrate",
          kind: "command",
          path: ["harness", "migrate"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "harness.status",
          kind: "command",
          path: ["harness", "status"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "routing.list",
          kind: "command",
          path: ["routing", "list"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "routing.set",
          kind: "command",
          path: ["routing", "set"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "traces.get",
          kind: "command",
          path: ["traces", "get"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
        {
          id: "traces.search",
          kind: "command",
          path: ["traces", "search"],
          outputModes: ["human", "json", "jsonl"],
          visibility: "public",
        },
      ] as const satisfies readonly PublicRegistration[]
    ).map((entry) =>
      Object.freeze({
        ...entry,
        outputModes: Object.freeze(entry.outputModes),
        path: Object.freeze(entry.path),
      }),
    ),
  );

const contracts = Object.freeze({
  doctor: {
    invocation: { args: [], caseId: "doctor.valid", prepare: "initialized" },
  },
  init: { invocation: { args: [], caseId: "init.valid" } },
  install: {
    invocation: {
      args: ["codex"],
      caseId: "install.valid",
      expectedStatus: 3,
      expectedDiagnostic: "harness.adapter-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  uninstall: {
    invocation: {
      args: ["codex"],
      caseId: "uninstall.valid",
      expectedStatus: 3,
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
      expectedStatus: 3,
      expectedDiagnostic: "harness.adapter-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "harness.migrate": {
    invocation: {
      args: ["codex"],
      caseId: "harness.migrate.valid",
      expectedStatus: 3,
      expectedDiagnostic: "harness.adapter-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "destination.configure": {
    invocation: {
      args: ["local-sqlite", "--name", "contract-local"],
      caseId: "destination.configure.valid",
      prepare: "initialized",
    },
    missing: ["local-sqlite"],
  },
  "destination.delete": {
    invocation: {
      args: ["missing-owned-selector"],
      caseId: "destination.delete.valid",
      expectedStatus: 3,
      expectedDiagnostic: "destination.connection-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "destination.recover": {
    invocation: {
      args: [],
      caseId: "destination.recover.valid",
      expectedStatus: 3,
      expectedDiagnostic: "configuration.missing",
      prepare: "initialized",
    },
  },
  "destination.inspect": {
    invocation: {
      args: ["missing-connection"],
      caseId: "destination.inspect.valid",
      expectedStatus: 3,
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
      expectedStatus: 3,
      expectedDiagnostic: "destination.connection-missing",
      prepare: "initialized",
    },
    missing: ["missing-connection", "--slot", "secret-key"],
  },
  "destination.unconfigure": {
    invocation: {
      args: ["missing-connection"],
      caseId: "destination.unconfigure.valid",
      expectedStatus: 3,
      expectedDiagnostic: "destination.connection-missing",
      prepare: "initialized",
    },
    missing: [],
  },
  "traces.search": {
    invocation: {
      args: ["--destination", "missing-connection", "--limit", "50"],
      caseId: "traces.search.valid",
      expectedStatus: 3,
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
      expectedStatus: 3,
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

/* eslint-disable max-params -- the closed driver grammar keeps each expected process observation explicit. */
const makeStep = (
  args: readonly string[],
  expectedStatus: number | null,
  outputRule: OutputRule,
  stateRule: StateRule,
  expectedDiagnostic?: string,
  input = "",
  executionMode: InstalledCliExecutionMode = "direct",
  expectedOutcome: InstalledCliContractStep["expectedOutcome"] = "exited",
  expectedSignal: InstalledCliContractStep["expectedSignal"] = null,
): InstalledCliContractStep =>
  Object.freeze({
    args: Object.freeze([...args]),
    executionMode,
    expectedStatus,
    expectedOutcome,
    expectedSignal,
    ...(expectedDiagnostic === undefined ? {} : { expectedDiagnostic }),
    input,
    outputRule,
    stateRule,
  });
/* eslint-enable max-params */

/* eslint-disable max-lines-per-function -- one closed plan keeps every public command and adversarial case in a reviewable order. */
export const createInstalledCliContractPlan = (
  expectedVersion: string,
  runtime: Readonly<{
    architecture: string;
    modules: string;
    platform: string;
  }>,
): InstalledCliContractPlan => {
  assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  const inventory = expectedPublicCommandInventory;
  const commands = inventory.filter(({ kind }) => kind === "command");
  assert.deepEqual(
    Object.keys(contracts).sort(),
    commands.map(({ id }) => id).sort(),
  );
  const localSqliteCandidateAvailable =
    runtime.platform === "linux" &&
    runtime.architecture === "x64" &&
    runtime.modules === "127";
  const cases: InstalledCliContractCase[] = inventory.map((registration) =>
    Object.freeze({
      caseId: `help.${registration.id}`,
      setup: "none" as const,
      steps: Object.freeze([
        Object.freeze({
          ...makeStep(
            [...registration.path, "--help"],
            0,
            "help",
            "same-as-before",
          ),
          expectedOutputSha256: helpDigestFor(registration.id),
        }),
      ]),
    }),
  );
  for (const registration of commands) {
    const contract = contracts[
      registration.id as keyof typeof contracts
    ] as CommandContract;
    const expectedStatus =
      registration.id === "destination.configure" &&
      !localSqliteCandidateAvailable
        ? 5
        : (contract.invocation.expectedStatus ?? 0);
    const expectedDiagnostic =
      registration.id === "destination.configure" &&
      !localSqliteCandidateAvailable
        ? "destination.lifecycle-unavailable"
        : contract.invocation.expectedDiagnostic;
    for (const mode of registration.outputModes)
      cases.push(
        Object.freeze({
          caseId: `${contract.invocation.caseId}.${mode}`,
          setup: contract.invocation.prepare ?? "none",
          steps: Object.freeze([
            makeStep(
              [
                ...registration.path,
                ...contract.invocation.args,
                "--output",
                mode,
              ],
              expectedStatus,
              mode,
              contract.invocation.mutation === "allowed"
                ? "any"
                : "same-as-before",
              expectedDiagnostic,
            ),
          ]),
        }),
      );
    cases.push(
      Object.freeze({
        caseId: `${registration.id}.unsupported-output`,
        setup: contract.invocation.prepare ?? "none",
        steps: Object.freeze([
          makeStep(
            [
              ...registration.path,
              ...contract.invocation.args,
              "--output",
              "yaml",
            ],
            2,
            "human",
            "same-as-before",
            "cli.output.unsupported",
          ),
        ]),
      }),
    );
    if (contract.missing !== undefined)
      cases.push(
        Object.freeze({
          caseId: `${registration.id}.missing-required`,
          setup: "initialized" as const,
          steps: Object.freeze([
            makeStep(
              [...registration.path, ...contract.missing, "--output", "json"],
              2,
              "json",
              "same-as-before",
              requiredArgumentDiagnostic,
            ),
          ]),
        }),
      );
  }
  cases.push(
    Object.freeze({
      caseId: "root.version",
      setup: "none",
      steps: Object.freeze([
        makeStep(["--version"], 0, "version", "same-as-before"),
      ]),
    }),
  );
  cases.push(
    Object.freeze({
      caseId: "arguments.unicode",
      setup: "none",
      steps: Object.freeze([
        makeStep(
          ["--does-not-exist-测试-é"],
          2,
          "human",
          "same-as-before",
          requiredArgumentDiagnostic,
        ),
      ]),
    }),
    Object.freeze({
      caseId: "terminal.narrow-help",
      setup: "none",
      steps: Object.freeze([
        Object.freeze({
          ...makeStep(
            ["--help"],
            0,
            "help",
            "same-as-before",
            undefined,
            "",
            "pty-narrow",
          ),
          expectedOutputBytes: narrowPtyHelp.bytes,
          expectedOutputSha256: narrowPtyHelp.sha256,
        }),
      ]),
    }),
    Object.freeze({
      caseId: "terminal.broken-pipe",
      setup: "none",
      steps: Object.freeze([
        makeStep(
          ["--version"],
          0,
          "human",
          "same-as-before",
          undefined,
          "",
          "stdout-closed",
        ),
      ]),
    }),
    Object.freeze({
      caseId: "signals.sigint",
      setup: "none",
      steps: Object.freeze([
        makeStep(
          ["init", "--output", "json"],
          130,
          "human",
          "same-as-before",
          undefined,
          "",
          "signal-int",
        ),
      ]),
    }),
    Object.freeze({
      caseId: "signals.sigterm",
      setup: "none",
      steps: Object.freeze([
        makeStep(
          ["init", "--output", "json"],
          143,
          "human",
          "same-as-before",
          undefined,
          "",
          "signal-term",
        ),
      ]),
    }),
    Object.freeze({
      caseId: "deadline.child-lifecycle",
      setup: "none",
      steps: Object.freeze([
        makeStep(
          ["--version"],
          null,
          "human",
          "same-as-before",
          undefined,
          "",
          "deadline-child",
          "timed-out",
          "SIGKILL",
        ),
      ]),
    }),
  );
  for (const [caseId, args] of [
    ["arguments.unknown", ["--does-not-exist-CREDENTIAL_CANARY"]],
    ["arguments.control-character", ["--does-not-exist", "line\nbreak"]],
    ["arguments.oversized", ["--does-not-exist", "x".repeat(8_193)]],
  ] as const)
    cases.push(
      Object.freeze({
        caseId,
        setup: "none",
        steps: Object.freeze([
          makeStep(
            args,
            2,
            "human",
            "same-as-before",
            requiredArgumentDiagnostic,
          ),
        ]),
      }),
    );
  cases.push(
    Object.freeze({
      caseId: "arguments.conflicting-trace-identities",
      setup: "initialized",
      steps: Object.freeze([
        makeStep(
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
          2,
          "json",
          "same-as-before",
          requiredArgumentDiagnostic,
        ),
      ]),
    }),
    Object.freeze({
      caseId: "arguments.duplicate-connection",
      setup: "initialized",
      steps: Object.freeze([
        makeStep(
          ["routing", "set", "duplicate", "duplicate", "--output", "json"],
          2,
          "json",
          "same-as-before",
          "routing.duplicate-connection",
        ),
      ]),
    }),
  );
  for (const [suffix, input] of [
    ["eof", ""],
    ["no", "no\n"],
    ["yes", "yes\n"],
  ] as const)
    cases.push(
      Object.freeze({
        caseId: `confirmation.non-tty-${suffix}-cancel`,
        setup: "none",
        steps: Object.freeze([
          makeStep(
            ["init", "--output", "json"],
            0,
            "confirmation",
            "same-as-before",
            undefined,
            input,
          ),
        ]),
      }),
    );
  cases.push(
    Object.freeze({
      caseId: "state.idempotent-init",
      setup: "none",
      steps: Object.freeze([
        makeStep(["init", "--yes", "--output", "json"], 0, "json", "capture"),
        makeStep(
          ["init", "--yes", "--output", "json"],
          0,
          "json",
          "same-as-previous",
        ),
      ]),
    }),
    Object.freeze({
      caseId: "state.conflicting-invalid-configuration",
      setup: "invalid-configuration",
      steps: Object.freeze([
        makeStep(
          ["init", "--yes", "--output", "json"],
          5,
          "json",
          "same-as-before",
          "configuration.unavailable",
        ),
      ]),
    }),
  );
  const caseIds = cases.map(({ caseId }) => caseId);
  assert.equal(new Set(caseIds).size, caseIds.length);
  assert.ok(caseIds.length > 80);
  const receiptCaseIds = [
    "artifact.install",
    ...cases.flatMap((contractCase) => [
      ...(contractCase.setup === "initialized"
        ? [`${contractCase.caseId}.setup`]
        : []),
      ...contractCase.steps.map(
        (_contractStep, index) => `${contractCase.caseId}.${index}`,
      ),
    ]),
  ];
  assert.equal(new Set(receiptCaseIds).size, receiptCaseIds.length);
  return Object.freeze({
    caseIds: Object.freeze(caseIds),
    caseIdsDigest: hash(JSON.stringify(caseIds)),
    cases: Object.freeze(cases),
    expectedVersion,
    inventoryDigest: hash(JSON.stringify(inventory)),
    planVersion: 1,
    receiptCaseIds: Object.freeze(receiptCaseIds),
    receiptCaseIdsDigest: hash(JSON.stringify(receiptCaseIds)),
  });
};
/* eslint-enable max-lines-per-function */

const exactRecordKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const parseJsonLines = (text: string): readonly Record<string, unknown>[] => {
  assert.notEqual(text, "");
  assert.doesNotMatch(text, /\r/u);
  assert.ok(text.endsWith("\n"));
  const lines = text.slice(0, -1).split("\n");
  assert.ok(lines.every((line) => line !== ""));
  return lines.map((line) => {
    const value: unknown = JSON.parse(line);
    assert.ok(
      typeof value === "object" &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype,
    );
    assert.equal(JSON.stringify(value), line);
    return value as Record<string, unknown>;
  });
};
type MachineAuthority = Readonly<{ command: string; dataSchema: string }>;
type OutputAuthority = Readonly<{ caseOrdinal: number }>;
const machineAuthorities = Object.freeze({
  doctor: {
    command: "agentscope doctor",
    dataSchema: "agentscope.cli.doctor.v1",
  },
  init: { command: "agentscope init", dataSchema: "agentscope.cli.init.v1" },
  "destination.configure": {
    command: "agentscope destination configure",
    dataSchema: "agentscope.cli.destination-configure.v1",
  },
  "destination.list": {
    command: "agentscope destination list",
    dataSchema: "agentscope.cli.destination-list.v1",
  },
  "harness.list": {
    command: "agentscope harness list",
    dataSchema: "agentscope.cli.harness-list.v1",
  },
  "routing.list": {
    command: "agentscope routing list",
    dataSchema: "agentscope.cli.routing-list.v1",
  },
  "routing.set": {
    command: "agentscope routing set",
    dataSchema: "agentscope.cli.routing-set.v1",
  },
} satisfies Readonly<Record<string, MachineAuthority>>);
const registrationForStep = (
  step: InstalledCliContractStep,
): PublicRegistration => {
  const matches = expectedPublicCommandInventory.filter(
    ({ kind, path }) =>
      kind === "command" &&
      path.every((segment, index) => step.args[index] === segment),
  );
  matches.sort((left, right) => right.path.length - left.path.length);
  const registration = matches[0];
  assert.notEqual(registration, undefined);
  return registration as PublicRegistration;
};
const machineAuthorityForStep = (
  step: InstalledCliContractStep,
): MachineAuthority => {
  const registration = registrationForStep(step);
  const authority =
    machineAuthorities[registration.id as keyof typeof machineAuthorities];
  assert.notEqual(authority, undefined);
  return authority;
};
const expectedCommandForStep = (step: InstalledCliContractStep): string => {
  const registration = expectedPublicCommandInventory
    .filter(({ path }) =>
      path.every((segment, index) => step.args[index] === segment),
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (registration === undefined)
    throw new Error("installed command authority missing");
  return `agentscope${registration.path.length === 0 ? "" : ` ${registration.path.join(" ")}`}`;
};
const validateInitializationRecord = (
  value: unknown,
  state: "applied" | "planned",
): void => {
  assert.ok(exactRecordKeys(value, ["action", "destructive", "id", "state"]));
  assert.deepEqual(value, {
    action: "create-configuration",
    destructive: false,
    id: "configuration-create",
    state,
  });
};
const doctorCodes = new Set([
  "doctor.configuration.valid",
  "doctor.configuration.missing",
  "doctor.configuration.invalid",
  "doctor.configuration.unsupported",
  "doctor.configuration.unavailable",
  "doctor.transaction.clean",
  "doctor.transaction.active",
  "doctor.transaction.owner-unknown",
  "doctor.transaction.recoverable",
  "doctor.transaction.reconciliation-required",
  "doctor.transaction.conflict",
  "doctor.transaction.invalid",
  "doctor.transaction.unavailable",
  "doctor.credential-mutation.clean",
  "doctor.credential-mutation.active",
  "doctor.credential-mutation.owner-unknown",
  "doctor.credential-mutation.recoverable",
  "doctor.credential-mutation.reconciliation-required",
  "doctor.credential-mutation.invalid",
  "doctor.credential-mutation.unavailable",
  "doctor.credential.available",
  "doctor.credential.unavailable",
  "doctor.credential.locked",
  "doctor.credential.denied",
  "doctor.credential.missing",
  "doctor.credential.malformed",
  "doctor.operational-state.available",
  "doctor.operational-state.invalid",
  "doctor.operational-state.lock-active",
  "doctor.operational-state.lock-owner-unknown",
  "doctor.operational-state.lock-recoverable",
  "doctor.operational-state.lock-reconciliation-required",
  "doctor.operational-state.lock-invalid",
  "doctor.operational-state.lock-unavailable",
  "doctor.pipeline-health.unavailable",
  "doctor.pipeline-health.absent",
  "doctor.pipeline-health.retained",
  "doctor.harness.unavailable",
  "doctor.harness.installed",
  "doctor.harness.absent",
  "doctor.harness.unsupported",
  "doctor.harness.indeterminate",
  "doctor.hook.ready",
  "doctor.hook.unchanged",
  "doctor.hook.conflict",
  "doctor.hook.unsupported",
  "doctor.hook.recovery-required",
  "doctor.hook.invalid",
  "doctor.hook.unavailable",
  "doctor.destination.available",
  "doctor.destination.unavailable",
  "doctor.destination.probe-unsupported",
  "doctor.destination.local-resource.available",
  "doctor.destination.local-resource.reconciliation-required",
  "doctor.destination.local-resource.recovery-required",
  "doctor.destination.local-resource.unavailable",
  "doctor.git.available",
  "doctor.git.detached",
  "doctor.git.workspace-unavailable",
  "doctor.git.repository-unavailable",
]);
const doctorActions = new Set([
  "none",
  "configure",
  "retry",
  "install-harness",
  "migrate-harness",
  "unlock-credential-store",
  "inspect-credential-mutation",
  "repair-configuration-transaction",
  "repair-operational-state-lock",
  "reconcile-recovery-claim",
  "inspect-configuration-conflict",
  "inspect-destination",
  "recover-local-resource",
]);
const doctorScopes = new Set([
  "configuration",
  "transaction",
  "credential-mutation",
  "credential",
  "operational-state",
  "pipeline-health",
  "harness",
  "hook",
  "destination",
  "git",
]);
const requiredDoctorScopes = Object.freeze([
  "configuration",
  "transaction",
  "credential-mutation",
  "operational-state",
  "pipeline-health",
  "harness",
  "hook",
  "destination",
  "git",
]);
const doctorStates = new Set([
  "valid",
  "missing",
  "invalid",
  "unsupported",
  "unavailable",
  "clean",
  "active",
  "owner-unknown",
  "recoverable",
  "reconciliation-required",
  "conflict",
  "available",
  "locked",
  "denied",
  "malformed",
  "lock-active",
  "lock-owner-unknown",
  "lock-recoverable",
  "lock-reconciliation-required",
  "lock-invalid",
  "lock-unavailable",
  "absent",
  "retained",
  "installed",
  "indeterminate",
  "unchanged",
  "ready",
  "recovery-required",
  "probe-unsupported",
  "detached",
  "workspace-unavailable",
  "repository-unavailable",
]);
const expectedDoctorRecord = Object.freeze({
  findings: Object.freeze(
    [
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
      ]) =>
        Object.freeze({
          code,
          evidence: Object.freeze({
            count,
            freshness,
            lossCount,
            scope,
            state,
            subject: null,
            version: null,
          }),
          severity,
          suggestedAction,
        }),
    ),
  ),
  fixed: false,
  repairs: Object.freeze([]),
  summary: Object.freeze({ errors: 0, information: 4, warnings: 4 }),
});
const validateLocalResourceDoctorEvidence = (value: unknown): void => {
  assert.ok(
    exactRecordKeys(value, [
      "backupState",
      "databaseDerivedRetention",
      "databaseState",
      "lifecycleState",
      "publishedBackupCount",
      "retentionPolicy",
      "sharedLeaseCount",
    ]),
  );
  assert.ok(
    ["available", "reconciliation-required", "unavailable"].includes(
      String(value.backupState),
    ),
  );
  assert.deepEqual(value.databaseDerivedRetention, {
    clockContinuity: "unavailable",
    cutoff: "unavailable",
    payloadBytes: "unavailable",
    rowCount: "unavailable",
  });
  assert.ok(
    ["present", "missing", "unavailable"].includes(String(value.databaseState)),
  );
  assert.ok(
    [
      "clean",
      "busy",
      "reconciliation-required",
      "recovery-required",
      "unavailable",
    ].includes(String(value.lifecycleState)),
  );
  assert.ok(
    value.publishedBackupCount === null ||
      (Number.isSafeInteger(value.publishedBackupCount) &&
        Number(value.publishedBackupCount) >= 0 &&
        Number(value.publishedBackupCount) <= 8),
  );
  assert.ok(
    value.sharedLeaseCount === null ||
      (Number.isSafeInteger(value.sharedLeaseCount) &&
        Number(value.sharedLeaseCount) >= 0 &&
        Number(value.sharedLeaseCount) <= 64),
  );
  assert.ok(
    exactRecordKeys(value.retentionPolicy, [
      "maximumAgeNanoseconds",
      "maximumPayloadBytes",
      "maximumTraceCount",
      "physicalCleanupTrigger",
    ]),
  );
  assert.match(
    String(value.retentionPolicy.maximumAgeNanoseconds),
    /^[1-9][0-9]{0,19}$/u,
  );
  assert.ok(
    Number.isSafeInteger(value.retentionPolicy.maximumPayloadBytes) &&
      Number(value.retentionPolicy.maximumPayloadBytes) > 0 &&
      Number(value.retentionPolicy.maximumPayloadBytes) <= 10 * 1024 ** 3,
  );
  assert.ok(
    Number.isSafeInteger(value.retentionPolicy.maximumTraceCount) &&
      Number(value.retentionPolicy.maximumTraceCount) > 0 &&
      Number(value.retentionPolicy.maximumTraceCount) <= 1_000_000,
  );
  assert.equal(
    value.retentionPolicy.physicalCleanupTrigger,
    "next-authorized-mutation",
  );
};
const validateDoctorRecord = (value: unknown): void => {
  const scopes = new Set<string>();
  for (const finding of expectedDoctorRecord.findings) {
    assert.ok(doctorCodes.has(String(finding.code)));
    assert.ok(doctorActions.has(String(finding.suggestedAction)));
    assert.ok(doctorScopes.has(String(finding.evidence.scope)));
    assert.ok(doctorStates.has(String(finding.evidence.state)));
    scopes.add(String(finding.evidence.scope));
    if (Object.hasOwn(finding.evidence, "localResource"))
      validateLocalResourceDoctorEvidence(
        (finding.evidence as Record<string, unknown>).localResource,
      );
  }
  assert.ok(
    requiredDoctorScopes
      .filter((scope) => scope !== "hook")
      .every((scope) => scopes.has(scope)),
  );
  assert.deepEqual(value, expectedDoctorRecord);
};
const installedContractHome = (caseOrdinal: number): string => {
  assert.ok(Number.isSafeInteger(caseOrdinal) && caseOrdinal >= 0);
  return `/tmp/agentscope-installed-contract/cases/${caseOrdinal}/user home with spaces — 测试`;
};
const validateConfigureRecord = (
  value: unknown,
  outputAuthority: OutputAuthority,
): void => {
  assert.ok(
    exactRecordKeys(value, [
      "applied",
      "connection",
      "generation",
      "plan",
      "state",
    ]),
  );
  assert.equal(value.applied, false);
  assert.equal(value.connection, null);
  assert.equal(value.generation, null);
  assert.equal(value.state, "planned");
  assert.ok(
    exactRecordKeys(value.plan, [
      "destinationType",
      "displayPath",
      "operation",
      "persistentDataNotice",
      "retentionPolicy",
    ]),
  );
  assert.equal(
    value.plan.destinationType,
    "@agentscope/destination-local-sqlite",
  );
  assert.match(String(value.plan.displayPath), /^\/[^\n\r]{1,4095}$/u);
  assert.equal(
    String(value.plan.displayPath).slice(0, -71),
    `${installedContractHome(outputAuthority.caseOrdinal)}/.agentscope/destinations/local-sqlite/`,
  );
  assert.match(
    String(value.plan.displayPath).slice(-71),
    /^sha256-[0-9a-f]{64}$/u,
  );
  assert.equal(value.plan.operation, "configure");
  assert.equal(value.plan.persistentDataNotice, true);
  assert.ok(
    exactRecordKeys(value.plan.retentionPolicy, [
      "maximumAgeNanoseconds",
      "maximumPayloadBytes",
      "maximumTraceCount",
      "physicalCleanupTrigger",
    ]),
  );
  assert.equal(
    value.plan.retentionPolicy.maximumAgeNanoseconds,
    "2592000000000000",
  );
  assert.equal(value.plan.retentionPolicy.maximumPayloadBytes, 1_073_741_824);
  assert.equal(value.plan.retentionPolicy.maximumTraceCount, 100_000);
  assert.equal(
    value.plan.retentionPolicy.physicalCleanupTrigger,
    "next-authorized-mutation",
  );
};
const validateMachinePayload = (
  authority: MachineAuthority,
  records: readonly unknown[],
  outputAuthority: OutputAuthority,
  initializationState: "applied" | "planned" = "planned",
): void => {
  if (
    [
      "agentscope.cli.destination-list.v1",
      "agentscope.cli.harness-list.v1",
      "agentscope.cli.routing-list.v1",
      "agentscope.cli.routing-set.v1",
    ].includes(authority.dataSchema)
  ) {
    assert.deepEqual(records, []);
    return;
  }
  assert.equal(records.length, 1);
  if (authority.dataSchema === "agentscope.cli.init.v1")
    validateInitializationRecord(records[0], initializationState);
  else if (authority.dataSchema === "agentscope.cli.doctor.v1")
    validateDoctorRecord(records[0]);
  else if (authority.dataSchema === "agentscope.cli.destination-configure.v1")
    validateConfigureRecord(records[0], outputAuthority);
  else assert.fail("installed output authority unsupported");
};
const validateMachineResult = (
  records: readonly Record<string, unknown>[],
  mode: "json" | "jsonl",
  authority: MachineAuthority,
  outputAuthority: OutputAuthority,
  initializationState: "applied" | "planned" = "planned",
): void => {
  if (mode === "json") {
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(
      exactRecordKeys(record, [
        "command",
        "completion",
        "dataSchema",
        "records",
        "schema",
      ]),
    );
    assert.equal(record.command, authority.command);
    assert.equal(record.completion, "complete");
    assert.equal(record.dataSchema, authority.dataSchema);
    assert.ok(Array.isArray(record.records));
    assert.equal(record.schema, "agentscope.cli.result.v1");
    validateMachinePayload(
      authority,
      record.records,
      outputAuthority,
      initializationState,
    );
    return;
  }
  const summary = records.at(-1);
  assert.ok(
    exactRecordKeys(summary, [
      "command",
      "completion",
      "count",
      "dataSchema",
      "kind",
      "schema",
    ]),
  );
  assert.equal(summary.command, authority.command);
  assert.equal(summary.completion, "complete");
  assert.equal(summary.count, records.length - 1);
  assert.equal(summary.dataSchema, authority.dataSchema);
  assert.equal(summary.kind, "summary");
  assert.equal(summary.schema, "agentscope.cli.record.v1");
  const payloads: unknown[] = [];
  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index];
    assert.ok(
      exactRecordKeys(record, [
        "command",
        "data",
        "dataSchema",
        "kind",
        "schema",
        "sequence",
      ]),
    );
    assert.equal(record.command, summary.command);
    assert.equal(record.dataSchema, summary.dataSchema);
    assert.equal(record.kind, "data");
    assert.equal(record.schema, "agentscope.cli.record.v1");
    assert.equal(record.sequence, index);
    payloads.push(record.data);
  }
  validateMachinePayload(
    authority,
    payloads,
    outputAuthority,
    initializationState,
  );
};
const validateMachinePlan = (
  text: string,
  mode: "json" | "jsonl",
  authority: MachineAuthority,
  outputAuthority: OutputAuthority,
): void => {
  if (text === "") return;
  const records = parseJsonLines(text);
  if (mode === "json") {
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(
      exactRecordKeys(record, ["command", "dataSchema", "records", "schema"]),
    );
    assert.equal(record.command, authority.command);
    assert.equal(record.dataSchema, authority.dataSchema);
    assert.ok(Array.isArray(record.records));
    assert.equal(record.schema, "agentscope.cli.plan.v1");
    validateMachinePayload(authority, record.records, outputAuthority);
    return;
  }
  const summary = records.at(-1);
  assert.ok(
    exactRecordKeys(summary, [
      "command",
      "count",
      "dataSchema",
      "kind",
      "schema",
    ]),
  );
  assert.equal(summary.command, authority.command);
  assert.equal(summary.count, records.length - 1);
  assert.equal(summary.dataSchema, authority.dataSchema);
  assert.equal(summary.kind, "summary");
  assert.equal(summary.schema, "agentscope.cli.plan-record.v1");
  const payloads: unknown[] = [];
  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index];
    assert.ok(
      exactRecordKeys(record, [
        "command",
        "data",
        "dataSchema",
        "kind",
        "schema",
        "sequence",
      ]),
    );
    assert.equal(record.command, summary.command);
    assert.equal(record.dataSchema, summary.dataSchema);
    assert.equal(record.kind, "plan");
    assert.equal(record.schema, "agentscope.cli.plan-record.v1");
    assert.equal(record.sequence, index);
    payloads.push(record.data);
  }
  validateMachinePayload(authority, payloads, outputAuthority);
};
const validateHumanSuccess = (
  step: InstalledCliContractStep,
  stdout: string,
  stderr: string,
  outputAuthority: OutputAuthority,
): void => {
  assert.equal(stderr, "");
  const command = step.args.filter((argument) => !argument.startsWith("--"));
  const text = stdout;
  if (command[0] === "doctor") {
    assert.equal(
      text,
      "Doctor: 0 error(s), 4 warning(s), 4 informational finding(s).\n" +
        "INFO [doctor.configuration.valid] valid; action=none\n" +
        "INFO [doctor.transaction.clean] clean; action=none\n" +
        "INFO [doctor.credential-mutation.clean] clean; action=none\n" +
        "INFO [doctor.operational-state.available] available; action=none\n" +
        "WARNING [doctor.pipeline-health.absent] absent; action=none\n" +
        "WARNING [doctor.harness.unavailable] unavailable; action=retry\n" +
        "WARNING [doctor.destination.unavailable] unavailable; action=inspect-destination\n" +
        "WARNING [doctor.git.repository-unavailable] repository-unavailable; action=retry\n",
    );
    return;
  }
  if (command[0] === "init") {
    assert.equal(
      text,
      "Initialization plan (no changes applied):\nplanned: create-configuration\n",
    );
    return;
  }
  if (command[0] === "destination" && command[1] === "configure") {
    const prefix = `Local persistence plan: ${installedContractHome(outputAuthority.caseOrdinal)}/.agentscope/destinations/local-sqlite/`;
    assert.ok(text.startsWith(prefix));
    assert.match(
      text.slice(prefix.length),
      /^sha256-[0-9a-f]{64}\nNo changes applied; rerun with --yes after reviewing the plan\.\n$/u,
    );
    return;
  }
  const expected =
    command[0] === "destination" && command[1] === "list"
      ? "No destination connections are configured.\n"
      : command[0] === "harness" && command[1] === "list"
        ? "No first-party harness adapters are registered.\n"
        : (command[0] === "routing" && command[1] === "list") ||
            (command[0] === "routing" && command[1] === "set")
          ? "Delivery is disabled; no destination is selected.\n"
          : undefined;
  assert.notEqual(expected, undefined);
  assert.equal(text, expected);
};
const diagnosticCode = (
  step: InstalledCliContractStep,
  result: InstalledCliInvocationResult,
): string | undefined => {
  const trimmed = result.stderr.trim();
  if (trimmed.startsWith("error ["))
    return /^error \[([a-z0-9.-]+)\]$/u.exec(trimmed)?.[1];
  try {
    const records = parseJsonLines(result.stderr);
    const record = records[0];
    const expectedCategory = new Map<number, string>([
      [2, "usage"],
      [3, "not-found"],
      [4, "conflict"],
      [5, "unavailable"],
      [6, "permission-denied"],
      [70, "internal-error"],
    ]).get(result.status ?? -1);
    if (
      records.length !== 1 ||
      !exactRecordKeys(record, ["category", "code", "command", "schema"]) ||
      ![
        "conflict",
        "internal-error",
        "not-found",
        "permission-denied",
        "unavailable",
        "usage",
      ].includes(String(record.category)) ||
      record.category !== expectedCategory ||
      typeof record.code !== "string" ||
      !/^[a-z0-9.-]+$/u.test(record.code) ||
      record.command !== expectedCommandForStep(step) ||
      record.schema !== "agentscope.cli.diagnostic.v1"
    )
      return undefined;
    return record.code;
  } catch {
    return undefined;
  }
};
const assertOutput = (
  step: InstalledCliContractStep,
  result: InstalledCliInvocationResult,
  version: string,
  outputAuthority: OutputAuthority,
): void => {
  assert.equal(result.outcome, step.expectedOutcome);
  assert.equal(result.signal, step.expectedSignal);
  assert.equal(result.status, step.expectedStatus);
  assert.ok(Buffer.byteLength(result.stdout) <= MAXIMUM_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(result.stderr) <= MAXIMUM_OUTPUT_BYTES);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /node_modules|(?:^|\n)\s*at\s|Error:|CREDENTIAL_CANARY/u,
  );
  if (step.expectedDiagnostic !== undefined)
    assert.equal(diagnosticCode(step, result), step.expectedDiagnostic);
  if (step.executionMode === "pty-narrow") {
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(result.pty, {
      cleanup: "clean",
      initialGeometry: { columns: 40, rows: 12 },
      isTTY: true,
      observedGeometry: { columns: 40, rows: 12 },
      outputBytes: step.expectedOutputBytes,
      outputSha256: step.expectedOutputSha256,
      processJoined: true,
      residualProcessCount: 0,
      terminalInputJoined: true,
      terminalOutputJoined: true,
      terminalTransportClosed: true,
    });
  } else if (step.outputRule === "help") {
    assert.equal(result.stderr, "");
    assert.equal(hash(result.stdout), step.expectedOutputSha256);
  } else if (step.outputRule === "version") {
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, "");
  } else if (step.outputRule === "confirmation") {
    const authority = machineAuthorityForStep(step);
    validateMachineResult(
      parseJsonLines(result.stdout),
      "json",
      authority,
      outputAuthority,
    );
    validateMachinePlan(result.stderr, "json", authority, outputAuthority);
  } else if (
    step.executionMode === "stdout-closed" ||
    step.executionMode === "signal-int" ||
    step.executionMode === "signal-term" ||
    step.executionMode === "deadline-child"
  ) {
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } else if (step.outputRule === "human") {
    if (result.status === 0)
      validateHumanSuccess(step, result.stdout, result.stderr, outputAuthority);
    else {
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^error \[[a-z0-9.-]+\]\n$/u);
    }
  } else if (result.status === 0) {
    const records = parseJsonLines(result.stdout);
    const authority = machineAuthorityForStep(step);
    validateMachineResult(
      records,
      step.outputRule,
      authority,
      outputAuthority,
      step.args.includes("--yes") ? "applied" : "planned",
    );
    validateMachinePlan(
      result.stderr,
      step.outputRule,
      authority,
      outputAuthority,
    );
  } else {
    assert.equal(result.stdout, "");
    assert.notEqual(diagnosticCode(step, result), undefined);
  }
};

/** Development-only oracle seam for artifact-bound causal negatives. */
export const validateInstalledCliInvocationOutputForTest = (
  step: InstalledCliContractStep,
  result: InstalledCliInvocationResult,
  version: string,
  outputAuthority: OutputAuthority,
): void => {
  assertOutput(step, result, version, outputAuthority);
};

export const evaluateInstalledCliContract = (
  plan: InstalledCliContractPlan,
  identity: InstalledCliArtifactIdentity,
  observations: readonly InstalledCliContractObservation[],
): InstalledCliContractEvidence => {
  assert.equal(identity.package, EXPECTED_PACKAGE);
  assert.equal(identity.version, plan.expectedVersion);
  assert.deepEqual(identity.bin, {
    [EXPECTED_BIN]: "./dist/bin/agentscope.js",
  });
  assert.match(identity.candidateDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(identity.installedPackageRootRealPath.startsWith("/"));
  assert.ok(
    identity.executableRealPath.startsWith(
      `${identity.installedPackageRootRealPath}/`,
    ),
  );
  assert.deepEqual(
    observations.map(({ caseId }) => caseId),
    plan.caseIds,
  );
  for (let index = 0; index < plan.cases.length; index += 1) {
    const contractCase = plan.cases[index];
    const observation = observations[index];
    if (contractCase === undefined || observation === undefined)
      throw new Error("agentscope.cli.installed-contract:case-identity");
    try {
      assert.equal(observation.results.length, contractCase.steps.length);
      assert.equal(
        observation.afterStateDigests.length,
        contractCase.steps.length,
      );
      if (contractCase.setup === "initialized") {
        assert.equal(observation.setupResult?.status, 0);
        assert.equal(observation.setupResult.signal, null);
        assertOutput(
          makeStep(["init", "--yes", "--output", "json"], 0, "json", "capture"),
          observation.setupResult,
          plan.expectedVersion,
          { caseOrdinal: index },
        );
      } else assert.equal(observation.setupResult, undefined);
      let previous = observation.beforeStateDigest;
      for (
        let stepIndex = 0;
        stepIndex < contractCase.steps.length;
        stepIndex += 1
      ) {
        const contractStep = contractCase.steps[stepIndex];
        const afterStateDigest: string | undefined =
          observation.afterStateDigests[stepIndex];
        const result = observation.results[stepIndex];
        if (
          contractStep === undefined ||
          afterStateDigest === undefined ||
          result === undefined
        )
          throw new Error("agentscope.cli.installed-contract:step-identity");
        assertOutput(contractStep, result, plan.expectedVersion, {
          caseOrdinal: index,
        });
        if (contractStep.stateRule === "same-as-before")
          assert.equal(afterStateDigest, observation.beforeStateDigest);
        if (contractStep.stateRule === "same-as-previous")
          assert.equal(afterStateDigest, previous);
        previous = afterStateDigest;
      }
    } catch {
      throw new Error(
        `agentscope.cli.installed-contract:${identity.candidateDigest}:${contractCase.caseId}`,
      );
    }
  }
  return Object.freeze({
    candidateDigest: identity.candidateDigest,
    caseCount: plan.caseIds.length,
    caseIdsDigest: plan.caseIdsDigest,
    inventoryDigest: plan.inventoryDigest,
    package: EXPECTED_PACKAGE,
    receiptCaseIdsDigest: plan.receiptCaseIdsDigest,
    receiptCount: plan.receiptCaseIds.length,
    schema: "agentscope.cli.installed-contract-evidence.v2",
    version: plan.expectedVersion,
  });
};
