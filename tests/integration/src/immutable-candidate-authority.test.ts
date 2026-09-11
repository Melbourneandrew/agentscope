/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

// The authority is deliberately private integration JavaScript, not a package API.
// @ts-expect-error no declaration file is published for this private module
import * as immutableAuthority from "../immutable-candidate-authority.mjs";
// @ts-expect-error the private fixture adapter has no published declaration
import { runPlatformAdapter } from "../fixtures/process-platform-adapter.mjs";

const {
  assertExactFixtureLedger,
  compileCandidateInventory,
  compileImmutableCandidateHandoff,
  compileInstalledContractFailureReceipt,
  compileInstalledPtyFailureReceipt,
  compileInstalledCliPtyReceipt,
  compileInstalledCliPtyReceiptFromExecution,
  decodeInstalledCliPtyReceipt,
  decodeInstalledContractFailureReceipt,
  decodeInstalledPtyFailureReceipt,
  decodeImmutableCandidateHandoff,
  digestInstalledContractWritableAuthority,
  installedPtyFailurePredicates,
  installedContractFailurePredicates,
  selectedRuntimeFiles,
  validateImmutableScenarioContainer,
  validateInstalledCliBoundary,
} = immutableAuthority;

const hex = (character: string): string => character.repeat(64);
describe("fixture ledger oracle", () => {
  it("executes the adapter through exact zero-byte destination evidence", async () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    const requestJson = vi.fn(
      (input: string, init: { headers?: Record<string, string> } = {}) => {
        const path = new URL(input).pathname;
        const fault = init.headers?.["x-agentscope-fault"];
        return Promise.resolve({
          json: () => {
            if (fault === "malformed")
              return Promise.reject(new Error("fixture malformed"));
            if (path === "/search")
              return Promise.resolve({ traces: [{ traceId }] });
            if (path === `/trace/${traceId}`)
              return Promise.resolve({ traceId });
            return Promise.resolve({});
          },
        });
      },
    );
    const result = await runPlatformAdapter({
      ingestionEndpoint: "http://ingestion",
      modelEndpoint: "http://model",
      publishCheckpoint: vi.fn(),
      requestJson,
      retrievalEndpoint: "http://retrieval",
      routeFixture: { routes: [] },
      scenario: { modelRoutes: [] },
      scenarioId: "fixture-process-smoke",
    });
    expect(result.destinationLedger.retrieval[0]).toMatchObject({
      bodyBytes: 0,
      bodySha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      operation: "health",
    });
    expect(
      result.assertions.every(
        ({ evaluate }: { evaluate: (value: unknown) => boolean }) =>
          evaluate(result),
      ),
    ).toBe(true);
  });

  it("requires independent expected, declared, and observed sequences", () => {
    const expected = [{ method: "POST", routeId: "first" }];
    expect(
      assertExactFixtureLedger(
        expected,
        structuredClone(expected),
        structuredClone(expected),
      ),
    ).toBe(true);
    for (const [declared, observed] of [
      [[], expected],
      [expected, []],
      [
        [{ method: "POST", routeId: "second" }],
        [{ method: "POST", routeId: "second" }],
      ],
      [
        [{ bodyBytes: 4, bodySha256: hex("b"), method: "POST" }],
        [{ bodyBytes: 4, bodySha256: hex("b"), method: "POST" }],
      ],
      [
        [...expected, ...expected],
        [...expected, ...expected],
      ],
    ])
      expect(() =>
        assertExactFixtureLedger(expected, declared, observed),
      ).toThrow("integration.immutable-candidate.fixture-ledger");
  });
});
const candidate = () => ({
  evidenceVersion: 1,
  bundleIdentity: `sha256-${hex("a")}`,
  candidateRevision: "1".repeat(40),
  platform: { os: "linux", architecture: "x64", nodeVersion: "22.23.2" },
  lockfile: {
    fileName: "pnpm-lock.yaml",
    bytes: 3,
    sha256: `sha256-${hex("b")}`,
  },
  artifacts: [
    {
      id: "agentscope-cli",
      kind: "npm-tarball",
      fileName: "agentscope-cli.tgz",
      bytes: 7,
      sha256: `sha256-${hex("c")}`,
    },
  ],
  scenarioNetworkPolicy: "offline-no-package-or-registry-download",
});
const image = () => ({ Id: `sha256:${hex("d")}`, Config: { User: "node" } });
const plan = () => ({ runId: "0123456789abcdef", scenarioId: "codex-smoke" });
const compiled = () =>
  compileImmutableCandidateHandoff({
    candidate: candidate(),
    image: image(),
    plan: plan(),
  });
const expected = () => ({
  candidateBundleIdentity: candidate().bundleIdentity,
  candidateInventorySha256: compileCandidateInventory(candidate()).sha256,
  candidateRoot: "/opt/agentscope/prepared",
  ...plan(),
});
const ptyExpected = () => ({
  candidateBundleIdentity: candidate().bundleIdentity,
  candidateInventorySha256: compileCandidateInventory(candidate()).sha256,
  ...plan(),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const container = (handoff: ReturnType<typeof compiled>): any => ({
  Image: handoff.imageId,
  Config: {
    User: "1000:1000",
    Env: [`AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${handoff.encoded}`],
  },
  HostConfig: {
    ReadonlyRootfs: true,
    NetworkMode: "selected-network",
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1024" },
  },
  Mounts: [],
});
const ptyReceipt = () => ({
  receiptVersion: 1,
  runId: plan().runId,
  scenarioId: plan().scenarioId,
  candidateBundleIdentity: candidate().bundleIdentity,
  candidateInventorySha256: compileCandidateInventory(candidate()).sha256,
  caseId: "installed-cli-version",
  completionKind: "exact-output",
  outcome: "completed",
  semanticState: "active",
  cleanup: "clean",
  isTTY: true,
  eofByteWritten: true,
  processJoined: true,
  terminalInputJoined: true,
  terminalOutputJoined: true,
  terminalTransportClosed: true,
  residualProcessCount: 0,
  initialGeometry: { columns: 40, rows: 12 },
  outputBytes: 42,
  outputSha256: hex("e"),
});
const executionReceipt = () => ({
  receiptVersion: 1,
  runId: plan().runId,
  requestFingerprint: `sha256:${hex("1")}`,
  isTTY: true,
  initialGeometry: { columns: 40, rows: 12 },
  observedGeometry: { columns: 40, rows: 12 },
  observedCanonicalMode: true,
  eofByte: 4,
  eofByteWritten: true,
  inputBytesWritten: 0,
  outcome: "completed",
  outputBytes: 42,
  outputSha256: hex("e"),
  finalSnapshot: {
    semanticState: "active",
    rows: [],
    cursor: { column: 0, row: 0 },
    alternateScreen: false,
    bracketedPaste: false,
    title: "",
  },
  exitCode: 0,
  signal: null,
  cleanup: "clean",
  residualProcessCount: 0,
  processJoined: true,
  terminalInputJoined: true,
  terminalOutputJoined: true,
  terminalTransportClosed: true,
});

// eslint-disable-next-line max-lines-per-function
describe("immutable candidate authority", () => {
  const installedCliFacts = () => ({
    argv: [
      "/opt/agentscope/installed/node_modules/.bin/agentscope",
      "--version",
    ],
    binIsSymlink: true,
    binTarget: "../agentscope-cli/dist/bin/agentscope.js",
    cliDigest: hex("f"),
    cliMode: 0o755,
    cliPrefix: "#!/usr/bin/env node\n",
    expectedDigest: hex("f"),
  });

  it("causally validates the exact installed CLI command boundary", () => {
    expect(validateInstalledCliBoundary(installedCliFacts())).toBe(true);
    expect(
      validateInstalledCliBoundary({
        ...installedCliFacts(),
        argv: [
          "/opt/agentscope/installed/node_modules/.bin/agentscope",
          "--help",
        ],
      }),
    ).toBe(true);
  });

  it.each([
    [
      "global-install link",
      { binTarget: "../node_modules/agentscope-cli/dist/bin/agentscope.js" },
    ],
    [
      "global-install argv",
      { argv: ["/opt/agentscope/installed/bin/agentscope", "--version"] },
    ],
    ["link", { binTarget: "../substituted.js" }],
    ["type", { binIsSymlink: false }],
    ["mode", { cliMode: 0o644 }],
    ["shebang", { cliPrefix: "#!/bin/sh\n" }],
    ["digest", { cliDigest: hex("e") }],
    ["missing argv", { argv: [] }],
    [
      "unknown argv",
      {
        argv: [
          "/opt/agentscope/installed/node_modules/.bin/agentscope",
          "help",
        ],
      },
    ],
    [
      "extra argv",
      {
        argv: [
          "/opt/agentscope/installed/node_modules/.bin/agentscope",
          "--help",
          "--version",
        ],
      },
    ],
  ] as const)(
    "rejects installed CLI %s substitution",
    (_seed, substitution) => {
      expect(() =>
        validateInstalledCliBoundary({
          ...installedCliFacts(),
          ...substitution,
        }),
      ).toThrow("integration.immutable-candidate.authority");
    },
  );
  it("binds a canonical candidate inventory and closed handoff", () => {
    const handoff = compiled();
    expect(
      decodeImmutableCandidateHandoff(handoff.encoded, expected()),
    ).toEqual(expect.objectContaining(expected()));
    expect(selectedRuntimeFiles).toEqual(
      expect.arrayContaining([
        "testkit/bounded-terminal-emulator.js",
        "testkit/pty-terminal-contract.js",
        "testkit/pty-runtime/node127-linux-x64-musl/pty.node",
      ]),
    );
  });

  it.each(["missing", "extra", "malformed", "substituted"] as const)(
    "rejects %s handoff authority",
    (seed) => {
      const handoff = compiled();
      let encoded = handoff.encoded;
      if (seed === "missing") encoded = "";
      if (seed === "malformed") encoded = "not_base64+";
      if (seed === "substituted")
        encoded = compileImmutableCandidateHandoff({
          candidate: candidate(),
          image: image(),
          plan: { ...plan(), scenarioId: "other" },
        }).encoded;
      const expectedRecord = expected() as ReturnType<typeof expected> & {
        extra?: boolean;
      };
      if (seed === "extra") expectedRecord.extra = true;
      expect(() =>
        decodeImmutableCandidateHandoff(encoded, expectedRecord),
      ).toThrow("integration.immutable-candidate.authority");
    },
  );

  it("accepts only the exact read-only selected container and image", () => {
    const handoff = compiled();
    expect(
      validateImmutableScenarioContainer({
        container: container(handoff),
        handoff,
        image: image(),
        networkName: "selected-network",
        tmpfs: container(handoff).HostConfig.Tmpfs,
      }),
    ).toBe(true);
  });

  it("rejects duplicate and non-closed candidate inventory entries", () => {
    const duplicate = candidate();
    duplicate.artifacts.push({
      id: duplicate.artifacts[0]!.id,
      kind: duplicate.artifacts[0]!.kind,
      fileName: duplicate.artifacts[0]!.fileName,
      bytes: duplicate.artifacts[0]!.bytes,
      sha256: duplicate.artifacts[0]!.sha256,
    });
    expect(() => compileCandidateInventory(duplicate)).toThrow(
      "integration.immutable-candidate.authority",
    );
    expect(() =>
      compileCandidateInventory({ ...candidate(), extra: true }),
    ).toThrow("integration.immutable-candidate.authority");
  });

  it.each(["duplicate-id", "count", "bytes", "id", "kind"] as const)(
    "rejects production candidate artifact %s substitution",
    (seed) => {
      const value = candidate();
      if (seed === "duplicate-id")
        value.artifacts.push({
          ...value.artifacts[0]!,
          fileName: "other.tgz",
        });
      if (seed === "count")
        value.artifacts = Array.from({ length: 33 }, (_, index) => ({
          ...value.artifacts[0]!,
          id: `artifact-${index}`,
          fileName: `artifact-${index}.tgz`,
        }));
      if (seed === "bytes") value.artifacts[0]!.bytes = 256 * 1024 * 1024 + 1;
      if (seed === "id") value.artifacts[0]!.id = "other";
      if (seed === "kind") value.artifacts[0]!.kind = "runtime-binary";
      expect(() => compileCandidateInventory(value)).toThrow(
        "integration.immutable-candidate.authority",
      );
    },
  );

  it("accepts exactly one closed installed-CLI PTY completion", () => {
    const compiledReceipt = compileInstalledCliPtyReceipt(ptyReceipt());
    const output = `prefix\nAGENTSCOPE_PTY_RECEIPT=${compiledReceipt.encoded}\nsuffix\n`;
    expect(decodeInstalledCliPtyReceipt(output, ptyExpected())).toEqual(
      compiledReceipt.record,
    );
  });

  it("preserves observed emulator state beside exact-output completion", () => {
    const compiledReceipt = compileInstalledCliPtyReceiptFromExecution({
      receipt: executionReceipt(),
      candidateBundleIdentity: candidate().bundleIdentity,
      candidateInventorySha256: compileCandidateInventory(candidate()).sha256,
      scenarioId: plan().scenarioId,
    });
    expect(compiledReceipt.record).toMatchObject({
      completionKind: "exact-output",
      outcome: "completed",
      semanticState: "active",
    });
    expect(
      decodeInstalledCliPtyReceipt(
        `AGENTSCOPE_PTY_RECEIPT=${compiledReceipt.encoded}`,
        ptyExpected(),
      ),
    ).toEqual(compiledReceipt.record);
  });

  it.each([
    ["completion authority", { completionKind: "semantic-marker" }],
    ["observed semantic state", { semanticState: "completed" }],
  ])("rejects substituted %s", (_label, replacement) => {
    expect(() =>
      compileInstalledCliPtyReceipt({ ...ptyReceipt(), ...replacement }),
    ).toThrow("integration.immutable-candidate.authority");
  });

  it.each([
    "missing",
    "duplicate",
    "malformed",
    "substituted",
    "extra",
  ] as const)("rejects %s installed-CLI completion evidence", (seed) => {
    const value = ptyReceipt() as ReturnType<typeof ptyReceipt> & {
      extra?: boolean;
    };
    if (seed === "substituted") value.outputSha256 = hex("f");
    if (seed === "extra") value.extra = true;
    const encoded =
      seed === "malformed"
        ? "not+base64"
        : Buffer.from(JSON.stringify(value)).toString("base64url");
    const line = `AGENTSCOPE_PTY_RECEIPT=${encoded}`;
    const output =
      seed === "missing"
        ? ""
        : seed === "duplicate"
          ? `${line}\n${line}`
          : line;
    const receiptExpected = ptyExpected();
    if (seed === "substituted") receiptExpected.scenarioId = "other";
    expect(() => decodeInstalledCliPtyReceipt(output, receiptExpected)).toThrow(
      "integration.immutable-candidate.authority",
    );
  });

  it("round-trips every admitted content-free installed-PTY failure", () => {
    const admitted = installedPtyFailurePredicates as Record<
      string,
      readonly string[]
    >;
    for (const [phase, predicates] of Object.entries(admitted)) {
      for (const predicate of predicates) {
        const compiledFailure = compileInstalledPtyFailureReceipt({
          receiptVersion: 1,
          phase,
          predicate,
        });
        expect(
          decodeInstalledPtyFailureReceipt(
            `AGENTSCOPE_PTY_FAILURE=${compiledFailure.encoded}\n`,
          ),
        ).toEqual(compiledFailure.record);
        expect(
          Object.keys(compiledFailure.record as Record<string, unknown>).sort(),
        ).toEqual(["phase", "predicate", "receiptVersion"]);
      }
    }
  });

  it("round-trips every admitted content-free remaining-contract failure", () => {
    const caseAuthority = {
      caseCount: 123,
      caseIdsDigest:
        "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
    };
    const admitted = installedContractFailurePredicates as Record<
      string,
      readonly string[]
    >;
    for (const [phase, predicates] of Object.entries(admitted)) {
      for (const predicate of predicates) {
        const compiledFailure = compileInstalledContractFailureReceipt({
          receiptVersion: 1,
          phase,
          predicate,
          ...(phase === "case-execution"
            ? {
                caseOrdinal: 0,
                contractInventorySha256: caseAuthority.caseIdsDigest,
              }
            : {}),
        });
        expect(
          decodeInstalledContractFailureReceipt(
            `AGENTSCOPE_INSTALLED_CONTRACT_FAILURE=${compiledFailure.encoded}\n`,
            caseAuthority,
          ),
        ).toEqual(compiledFailure.record);
        expect(
          Object.keys(compiledFailure.record as Record<string, unknown>).sort(),
        ).toEqual(
          phase === "case-execution"
            ? [
                "caseOrdinal",
                "contractInventorySha256",
                "phase",
                "predicate",
                "receiptVersion",
              ]
            : ["phase", "predicate", "receiptVersion"],
        );
      }
    }
  });

  it("binds every setup operation to one closed content-free predicate", () => {
    const setupPredicates = [
      "setup-candidate-bin-identity",
      "setup-cwd-env-config",
      "setup-deadline",
      "setup-descriptor-permission",
      "setup-fixture-input-creation",
      "setup-workspace-root-authority",
    ];
    expect(installedContractFailurePredicates["case-execution"]).toEqual(
      expect.arrayContaining(setupPredicates),
    );
    expect(installedContractFailurePredicates["case-execution"]).not.toContain(
      "setup-rejected",
    );
    for (const predicate of setupPredicates) {
      const compiled = compileInstalledContractFailureReceipt({
        caseOrdinal: 0,
        contractInventorySha256:
          "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
        phase: "case-execution",
        predicate,
        receiptVersion: 1,
      });
      expect(
        decodeInstalledContractFailureReceipt(
          `AGENTSCOPE_INSTALLED_CONTRACT_FAILURE=${compiled.encoded}`,
          {
            caseCount: 123,
            caseIdsDigest:
              "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
          },
        ),
      ).toEqual(compiled.record);
    }
    for (const predicate of [
      "setup-rejected",
      "setup-workspace-root-authority-substituted",
      "",
    ])
      expect(() =>
        compileInstalledContractFailureReceipt({
          caseOrdinal: 0,
          contractInventorySha256:
            "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
          phase: "case-execution",
          predicate,
          receiptVersion: 1,
        }),
      ).toThrow("integration.immutable-candidate.authority");
  });

  it("binds closed observer-reap and aggregate-evaluation reasons", () => {
    const observerReasons = [
      "deadline",
      "handle-close",
      "kill",
      "leader-identity",
      "observer-stop-join",
      "output-drain",
      "residual-membership",
      "stop-request",
      "term",
    ].map((reason) => `testkit.headless.observer.reap.${reason}`);
    const evaluationReasons = [
      "aggregate-count-order-digest",
      "duplicate-ordinal",
      "incomplete-observer-terminal-evidence",
      "inventory-candidate-digest-mismatch",
      "missing-ordinal",
      "out-of-range-ordinal",
      "per-case-receipt-shape-status-mismatch",
      "unexpected-extra-evidence",
    ];
    expect(installedContractFailurePredicates["case-execution"]).toEqual(
      expect.arrayContaining(observerReasons),
    );
    expect(installedContractFailurePredicates["case-execution"]).toContain(
      "testkit.headless.observer.reap",
    );
    expect(installedContractFailurePredicates["aggregate-evaluation"]).toEqual(
      evaluationReasons,
    );
    for (const predicate of evaluationReasons)
      expect(
        decodeInstalledContractFailureReceipt(
          `AGENTSCOPE_INSTALLED_CONTRACT_FAILURE=${
            compileInstalledContractFailureReceipt({
              phase: "aggregate-evaluation",
              predicate,
              receiptVersion: 1,
            }).encoded
          }`,
          {
            caseCount: 123,
            caseIdsDigest:
              "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
          },
        ).predicate,
      ).toBe(predicate);
    for (const predicate of [
      "evaluation-rejected",
      "unexpected-extra-evidence-substituted",
      "",
    ])
      expect(() =>
        compileInstalledContractFailureReceipt({
          phase: "aggregate-evaluation",
          predicate,
          receiptVersion: 1,
        }),
      ).toThrow("integration.immutable-candidate.authority");
  });

  it.each([
    "missing",
    "unknown",
    "duplicate",
    "substituted",
    "malformed",
    "extra",
    "late",
  ] as const)("rejects %s remaining-contract failure evidence", (seed) => {
    const value: Record<string, unknown> = {
      caseOrdinal: 0,
      contractInventorySha256:
        "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
      receiptVersion: 1,
      phase: "case-execution",
      predicate: "execution-rejected",
    };
    if (seed === "unknown") value.predicate = "unknown";
    if (seed === "substituted") value.phase = "artifact-install";
    if (seed === "extra") value.detail = "forbidden";
    const encoded =
      seed === "malformed"
        ? "not+base64"
        : Buffer.from(JSON.stringify(value)).toString("base64url");
    const line = `AGENTSCOPE_INSTALLED_CONTRACT_FAILURE=${encoded}`;
    const output =
      seed === "missing"
        ? ""
        : seed === "duplicate"
          ? `${line}\n${line}`
          : seed === "late"
            ? `AGENTSCOPE_PTY_FAILURE=x\n${line}`
            : line;
    expect(() =>
      decodeInstalledContractFailureReceipt(output, {
        caseCount: 123,
        caseIdsDigest:
          "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
      }),
    ).toThrow("integration.immutable-candidate.authority");
  });

  it.each([
    [
      "negative ordinal",
      -1,
      "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
    ],
    [
      "fractional ordinal",
      1.5,
      "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
    ],
    [
      "out-of-range ordinal",
      123,
      "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
    ],
    ["substituted inventory", 0, `sha256:${"0".repeat(64)}`],
  ])(
    "rejects %s remaining-contract case authority",
    (_label, caseOrdinal, contractInventorySha256) => {
      const encoded = Buffer.from(
        JSON.stringify({
          caseOrdinal,
          contractInventorySha256,
          receiptVersion: 1,
          phase: "case-execution",
          predicate: "execution-rejected",
        }),
      ).toString("base64url");
      expect(() =>
        decodeInstalledContractFailureReceipt(
          `AGENTSCOPE_INSTALLED_CONTRACT_FAILURE=${encoded}`,
          {
            caseCount: 123,
            caseIdsDigest:
              "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a",
          },
        ),
      ).toThrow("integration.immutable-candidate.authority");
    },
  );

  it.each([
    [
      "duplicate key",
      '{"receiptVersion":1,"phase":"case-execution","phase":"case-execution","predicate":"execution-rejected"}',
    ],
    [
      "shadow substitution",
      '{"receiptVersion":1,"phase":"artifact-install","phase":"case-execution","predicate":"execution-rejected"}',
    ],
    [
      "alternate key order",
      '{"phase":"case-execution","receiptVersion":1,"predicate":"execution-rejected"}',
    ],
    [
      "whitespace-expanded JSON",
      '{ "receiptVersion": 1, "phase": "case-execution", "predicate": "execution-rejected" }',
    ],
  ])(
    "rejects noncanonical %s remaining-contract bytes",
    (_label, serialized) => {
      const encoded = Buffer.from(serialized).toString("base64url");
      expect(() =>
        decodeInstalledContractFailureReceipt(
          `AGENTSCOPE_INSTALLED_CONTRACT_FAILURE=${encoded}`,
        ),
      ).toThrow("integration.immutable-candidate.authority");
    },
  );

  it.each([
    "missing",
    "unknown",
    "duplicate",
    "substituted",
    "malformed",
    "extra",
    "late",
  ] as const)("rejects %s installed-PTY failure evidence", (seed) => {
    const value: Record<string, unknown> = {
      receiptVersion: 1,
      phase: "installed-cli",
      predicate: "execution-rejected",
    };
    if (seed === "unknown") value.predicate = "unknown";
    if (seed === "substituted") value.phase = "candidate-inventory";
    if (seed === "extra") value.detail = "forbidden";
    const encoded =
      seed === "malformed"
        ? "not+base64"
        : Buffer.from(JSON.stringify(value)).toString("base64url");
    const line = `AGENTSCOPE_PTY_FAILURE=${encoded}`;
    const output =
      seed === "missing"
        ? ""
        : seed === "duplicate"
          ? `${line}\n${line}`
          : seed === "late"
            ? `AGENTSCOPE_PTY_RECEIPT=x\n${line}`
            : line;
    expect(() => decodeInstalledPtyFailureReceipt(output)).toThrow(
      "integration.immutable-candidate.authority",
    );
  });

  it.each([
    [
      "duplicate key",
      '{"receiptVersion":1,"phase":"installed-cli","phase":"installed-cli","predicate":"execution-rejected"}',
    ],
    [
      "shadow substitution",
      '{"receiptVersion":1,"phase":"candidate-inventory","phase":"installed-cli","predicate":"execution-rejected"}',
    ],
    [
      "alternate key order",
      '{"phase":"installed-cli","receiptVersion":1,"predicate":"execution-rejected"}',
    ],
    [
      "whitespace-expanded JSON",
      '{ "receiptVersion": 1, "phase": "installed-cli", "predicate": "execution-rejected" }',
    ],
  ])("rejects noncanonical %s failure bytes", (_label, serialized) => {
    const encoded = Buffer.from(serialized).toString("base64url");
    expect(() =>
      decodeInstalledPtyFailureReceipt(`AGENTSCOPE_PTY_FAILURE=${encoded}`),
    ).toThrow("integration.immutable-candidate.authority");
  });

  it("advances each production failure phase before its owned boundary", () => {
    const runner = readFileSync(resolve(import.meta.dirname, "../runner.mjs"), {
      encoding: "utf8",
    });
    for (const [phase, boundary] of [
      ["candidate-inventory", "const pointer = JSON.parse("],
      ["immutable-candidate", "const encodedImmutableCandidate ="],
      ["installed-cli", "await runInstalledCliPtyProof("],
      ["pty-receipt", "compileInstalledCliPtyReceiptFromExecution("],
    ] as const) {
      const transition = runner.indexOf(`advancePtyFailurePhase("${phase}")`);
      const operation = runner.indexOf(boundary);
      expect(transition).toBeGreaterThanOrEqual(0);
      expect(operation).toBeGreaterThan(transition);
    }
  });

  it("advances remaining-contract phases before their owned boundaries", () => {
    const runner = readFileSync(resolve(import.meta.dirname, "../runner.mjs"), {
      encoding: "utf8",
    });
    for (const [phase, boundary] of [
      ["artifact-install", "rmSync(contractRoot"],
      ["case-execution", "for (let caseIndex = 0;"],
      ["aggregate-evaluation", "evaluateInstalledCliContract("],
      ["receipt-finalization", "const receiptCaseIds ="],
    ] as const) {
      const transition = runner.indexOf(
        `setInstalledContractFailureBoundary(\n  "${phase}"`,
      );
      const compactTransition = runner.indexOf(
        `setInstalledContractFailureBoundary("${phase}"`,
      );
      const operation = runner.indexOf(boundary);
      const transitions = [transition, compactTransition].filter(
        (index) => index >= 0,
      );
      expect(transitions.length).toBeGreaterThan(0);
      expect(operation).toBeGreaterThan(Math.min(...transitions));
    }
    const evidence = runner.indexOf("AGENTSCOPE_INSTALLED_CONTRACT_EVIDENCE=");
    const terminal = runner.indexOf(
      "installedContractFailureTerminal = true",
      evidence,
    );
    const cleanup = runner.indexOf("rmSync(contractRoot", terminal);
    expect(terminal).toBeGreaterThan(evidence);
    expect(cleanup).toBeGreaterThan(terminal);
  });

  it("latches setup predicates adjacent to the real setup operations", () => {
    const runner = readFileSync(resolve(import.meta.dirname, "../runner.mjs"), {
      encoding: "utf8",
    });
    const setup = runner.slice(
      runner.indexOf("const setupDescriptorErrorCodes"),
      runner.indexOf(
        'setInstalledContractFailureBoundary(\n    "case-execution",\n    "state-rejected"',
      ),
    );
    for (const predicate of [
      "setup-candidate-bin-identity",
      "setup-cwd-env-config",
      "setup-deadline",
      "setup-descriptor-permission",
      "setup-fixture-input-creation",
      "setup-workspace-root-authority",
    ])
      expect(runner).toContain(`"${predicate}"`);
    expect(setup).toContain("mkdirSync(caseHome, { recursive: true })");
    expect(setup).toContain(
      "digestInstalledContractWritableAuthority(externalWritableAuthority)",
    );
    expect(setup).toContain("setupFailureCase: caseFailure");
    expect(setup).toContain("setupDescriptorErrorCodes.has(error?.code)");
    const selectedExecution = runner.slice(
      runner.indexOf("request.requestFingerprint ="),
      runner.indexOf("const receipt =", runner.indexOf("const invokeSelected")),
    );
    expect(selectedExecution).toContain(
      "selectedHeadlessExecutionPending = true",
    );
    expect(selectedExecution).toContain(
      "const trace = await executeSelectedHeadlessProcess(",
    );
    expect(selectedExecution).toContain(
      "selectedHeadlessExecutionPending = false",
    );
    expect(
      selectedExecution.indexOf("selectedHeadlessExecutionPending = true"),
    ).toBeGreaterThan(
      selectedExecution.indexOf('"setup-candidate-bin-identity"'),
    );
    expect(setup).toContain("contractCaseExecution: true");
    expect(runner.match(/contractCaseExecution: true/gu)).toHaveLength(2);
  });

  it("arms selected-headless precedence only after local setup validation", async () => {
    const runner = readFileSync(resolve(import.meta.dirname, "../runner.mjs"), {
      encoding: "utf8",
    });
    const receiptAuthorityStart = runner.indexOf(
      "const installedContractFailurePhases =",
    );
    const receiptAuthority = runner.slice(
      receiptAuthorityStart,
      runner.indexOf(
        "if (process.hasUncaughtExceptionCaptureCallback())",
        receiptAuthorityStart,
      ),
    );
    const invocation = runner.slice(
      runner.indexOf("const invokeSelected = async"),
      runner.indexOf("const invokeSelectedNarrowPty"),
    );
    const headlessSource = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../packages/testkit/src/headless-supervisor.ts",
      ),
      "utf8",
    );
    const headlessErrorSource = headlessSource
      .slice(headlessSource.indexOf("export class HeadlessSupervisorError"))
      .replace("export class", "class")
      .replace("  declare public readonly code: string;\n\n", "")
      .replace("public constructor(code: string)", "constructor(code)");
    const exercise = async (mode: "deadline" | "forged" | "selected") => {
      const output: string[] = [];
      const context = {
        TextDecoder,
        TextEncoder,
        compileInstalledContractFailureReceipt: (value: unknown) =>
          compileInstalledContractFailureReceipt(
            JSON.parse(JSON.stringify(value)),
          ),
        fingerprintHeadlessRequest: () => "sha256:fingerprint",
        currentMode: mode,
        headlessCapability: Object.freeze({}),
        headlessShutdownDeadline: mode === "deadline" ? 100 : 100_000,
        installedContractFailurePredicates,
        installedContractReceipts: [],
        performance: { now: () => 100 },
        process: {
          exitCode: undefined as number | undefined,
          stdout: { write: (value: string) => output.push(value) },
        },
        requiredEnvironment: () => "run",
      };
      const execute = runInNewContext(
        `const defineOwnProperty = Object.defineProperty;
${headlessErrorSource}
const executeSelectedHeadlessProcess = () => {
  if (currentMode === "selected") throw new HeadlessSupervisorError("testkit.headless.backend.receipt");
  const error = new Error("forged"); error.code = "testkit.headless.backend.receipt"; throw error;
};
${receiptAuthority}
${invocation}
globalThis.exercise = async (mode) => {
  const caseFailure = Object.freeze({caseCount: 1, caseIdsDigest: "sha256:${hex("a")}", caseOrdinal: 0});
  setInstalledContractFailureBoundary("case-execution", "setup-deadline", caseFailure);
  try {
    await invokeSelected({
      arguments: [], caseId: "case", contractCaseExecution: true,
      cwd: "/work", environment: Object.freeze({}), executable: "/bin/cli",
      setupFailureCase: caseFailure,
    });
  } catch (error) {
    emitInstalledContractFailureReceipt(error);
    return {
      classFrozen: Object.isFrozen(HeadlessSupervisorError),
      pending: selectedHeadlessExecutionPending,
      prototypeFrozen: Object.isFrozen(HeadlessSupervisorError.prototype),
    };
  }
  throw new Error("unexpected success");
};`,
        context,
      ) as (mode: string) => Promise<{
        classFrozen: boolean;
        pending: boolean;
        prototypeFrozen: boolean;
      }>;
      const result = await execute(mode);
      return { output: output.join(""), result };
    };
    const local = await exercise("deadline");
    expect(local.result.pending).toBe(false);
    expect(
      decodeInstalledContractFailureReceipt(local.output, {
        caseCount: 1,
        caseIdsDigest: `sha256:${hex("a")}`,
      }),
    ).toMatchObject({ predicate: "setup-deadline" });
    const selected = await exercise("selected");
    expect(selected.result).toMatchObject({
      classFrozen: true,
      pending: true,
      prototypeFrozen: true,
    });
    expect(
      decodeInstalledContractFailureReceipt(selected.output, {
        caseCount: 1,
        caseIdsDigest: `sha256:${hex("a")}`,
      }),
    ).toMatchObject({ predicate: "testkit.headless.backend.receipt" });
    const forged = await exercise("forged");
    expect(forged.result.pending).toBe(true);
    expect(forged.output).toBe("");
  });

  it("keeps the deadline-child execution timeout separate from one bounded teardown deadline", () => {
    const runner = readFileSync(resolve(import.meta.dirname, "../runner.mjs"), {
      encoding: "utf8",
    });
    const invocationStart = runner.indexOf("const invokeSelected = async");
    const invocationEnd = runner.indexOf(
      "const invokeSelectedNarrowPty",
      invocationStart,
    );
    const invocation = runner.slice(invocationStart, invocationEnd);
    expect(invocation).toContain(
      "constructedAtMs + shutdownTimeoutMilliseconds",
    );
    expect(invocation).toContain(
      "constructedAtMs + executionTimeoutMilliseconds",
    );
    expect(invocation).toContain("monotonicShutdownDeadlineMs - 2_000");
    expect(invocation).toContain("terminationGraceMs: 1_000");
    expect(invocation).not.toContain("setTimeout(");
    const deadlineStart = runner.indexOf('\'trap "" TERM;');
    const deadlineChild = runner.slice(
      deadlineStart,
      runner.indexOf("};\n};", deadlineStart),
    );
    expect(deadlineChild).toContain("executionTimeoutMilliseconds: 250");
    expect(deadlineChild).toContain("shutdownTimeoutMilliseconds: 5_000");
    expect(deadlineChild).toContain('trap "" TERM');
    expect(deadlineChild).toContain("/usr/bin/sleep 60 & wait");
  });

  it("binds the complete installed-contract writable case authority", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentscope-contract-state-"));
    try {
      for (const name of ["home", "temporary", "workspace"])
        mkdirSync(resolve(root, name));
      const input = { excludedPaths: [], roots: [root] };
      const baseline = digestInstalledContractWritableAuthority(input);
      writeFileSync(resolve(root, "workspace/mutation"), "cwd");
      expect(digestInstalledContractWritableAuthority(input)).not.toBe(
        baseline,
      );
      rmSync(resolve(root, "workspace/mutation"));
      const restoredBaseline = digestInstalledContractWritableAuthority(input);
      writeFileSync(resolve(root, "temporary/mutation"), "tmp");
      expect(digestInstalledContractWritableAuthority(input)).not.toBe(
        restoredBaseline,
      );
      rmSync(resolve(root, "temporary/mutation"));
      const identityTarget = resolve(root, "home/identity");
      writeFileSync(identityTarget, "same bytes");
      const identityBaseline = digestInstalledContractWritableAuthority(input);
      const replacement = resolve(root, "home/replacement");
      writeFileSync(replacement, "same bytes");
      renameSync(replacement, identityTarget);
      expect(digestInstalledContractWritableAuthority(input)).not.toBe(
        identityBaseline,
      );
      const metadataBaseline = digestInstalledContractWritableAuthority(input);
      utimesSync(identityTarget, new Date(1_000), new Date(1_000));
      expect(digestInstalledContractWritableAuthority(input)).not.toBe(
        metadataBaseline,
      );
      const sibling = resolve(root, "sibling");
      mkdirSync(sibling);
      const excludingSibling = {
        excludedPaths: [sibling],
        roots: [root],
      };
      const excludedBaseline =
        digestInstalledContractWritableAuthority(excludingSibling);
      writeFileSync(resolve(sibling, "allowed"), "case mutation");
      expect(digestInstalledContractWritableAuthority(excludingSibling)).toBe(
        excludedBaseline,
      );
      writeFileSync(resolve(root, "external-mutation"), "sibling authority");
      expect(
        digestInstalledContractWritableAuthority(excludingSibling),
      ).not.toBe(excludedBaseline);
      rmSync(resolve(root, "external-mutation"));
      const secondRoot = resolve(root, "second-root");
      mkdirSync(secondRoot);
      const completeAuthority = {
        excludedPaths: [],
        roots: [resolve(root, "home"), secondRoot],
      };
      const completeBaseline =
        digestInstalledContractWritableAuthority(completeAuthority);
      writeFileSync(resolve(secondRoot, "sibling-mutation"), "outside case");
      expect(
        digestInstalledContractWritableAuthority(completeAuthority),
      ).not.toBe(completeBaseline);
      symlinkSync(resolve(root, "home"), resolve(root, "workspace/alias"));
      expect(() => digestInstalledContractWritableAuthority(input)).toThrow(
        "integration.immutable-candidate.authority",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
    const runner = readFileSync(resolve(import.meta.dirname, "../runner.mjs"), {
      encoding: "utf8",
    });
    expect(runner).toContain("const stateRoots = writableAuthorityRoots;");
    expect(runner).toContain("excludedPaths: [caseRoot]");
    expect(runner).toContain("/agentscope/admit");
    expect(runner).toContain('requiredEnvironment("AGENTSCOPE_INGESTION_URL")');
    expect(runner).toContain('requiredEnvironment("AGENTSCOPE_RETRIEVAL_URL")');
    expect(runner).toContain(
      'requiredEnvironment("AGENTSCOPE_MODEL_SERVER_URL")',
    );
    const destinationServer = readFileSync(
      resolve(import.meta.dirname, "../destination-server.mjs"),
      "utf8",
    );
    expect(destinationServer).toContain(
      'record(request, Buffer.alloc(0), "health", "accepted")',
    );
    expect(destinationServer).toContain(
      'record(request, Buffer.alloc(0), "oversize", "rejected")',
    );
    expect(destinationServer).toContain('server.on("clientError"');
    expect(destinationServer).toContain("pendingConnectionCount:");
    expect(destinationServer).toContain("pendingSockets.delete(socket)");
    expect(destinationServer).toContain('socket.once("close"');
    expect(destinationServer).not.toContain("settleSocket(request.socket)");
    expect(destinationServer).toContain("if (overflow)");
    expect(destinationServer).toContain("if (!requireRecorded(response");
    expect(destinationServer).toContain('bodySha256: createHash("sha256")');
    expect(destinationServer).toContain(
      '"branch,events,model,redaction,tool,traceId"',
    );
    expect(destinationServer).toContain('.listen(4321, "127.0.0.1")');
    const runScenarios = readFileSync(
      resolve(import.meta.dirname, "../run-scenarios.mjs"),
      "utf8",
    );
    expect(runScenarios).toContain("failureLedgerCaptureSignal()");
    expect(runScenarios).toContain("entriesSha256:");
    expect(runScenarios).not.toContain(
      "modelLedgerArtifact = observed.model.ledger",
    );
    expect(runScenarios).toContain("fixtureLedgerObservations.get(");
    expect(runScenarios).toContain('{ status: "uncertain" }');
    expect(runScenarios).not.toContain(
      "JSON.stringify(result.modelLedger, undefined, 2)",
    );
    expect(runner).not.toContain("/ledger");
    expect(runner).not.toContain(
      'const stateRoot = join(caseHome, ".agentscope");',
    );
  });

  it("retires the npm install probe before writable-root authentication", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentscope-contract-probe-"));
    try {
      const installRoot = resolve(root, "install");
      const installBin = resolve(installRoot, "node_modules/.bin");
      mkdirSync(installBin, { recursive: true });
      symlinkSync(root, resolve(installBin, "agentscope"));
      const input = { excludedPaths: [], roots: [root] };
      expect(() => digestInstalledContractWritableAuthority(input)).toThrow(
        "integration.immutable-candidate.authority",
      );
      rmSync(installRoot, { force: true, recursive: true });
      expect(() =>
        digestInstalledContractWritableAuthority(input),
      ).not.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
    const runner = readFileSync(resolve(import.meta.dirname, "../runner.mjs"), {
      encoding: "utf8",
    });
    const cleanup = runner.indexOf(
      "rmSync(installRoot, { force: true, recursive: true });",
    );
    expect(cleanup).toBeGreaterThan(
      runner.indexOf("JSON.stringify(runtimeInstalledManifest)"),
    );
    expect(cleanup).toBeLessThan(
      runner.indexOf(
        "digestInstalledContractWritableAuthority(externalWritableAuthority)",
      ),
    );
  });

  it("reports only an exact trusted selected-headless failure code", () => {
    const runner = readFileSync(resolve(import.meta.dirname, "../runner.mjs"), {
      encoding: "utf8",
    });
    expect(installedContractFailurePredicates["case-execution"]).not.toContain(
      "execution-rejected",
    );
    expect(installedContractFailurePredicates["case-execution"]).toContain(
      "testkit.headless.observer.reap.observer-stop-join",
    );
    expect(runner).toContain("error instanceof HeadlessSupervisorError");
    expect(runner).toContain(
      '!installedContractFailurePredicates["case-execution"].includes(error.code)',
    );
    expect(runner).toContain("installedContractFailurePredicate = error.code");
    expect(runner).toContain("selectedHeadlessExecutionPending = true");
    expect(runner).toContain("selectedHeadlessExecutionPending = false");
    expect(runner).not.toContain(
      '"case-execution",\n        "execution-rejected"',
    );
  });

  it.each([
    "image",
    "config",
    "user",
    "root-writable",
    "capability",
    "privilege",
    "mount",
    "handoff",
  ] as const)("rejects selected-container %s substitution", (seed) => {
    const handoff = compiled();
    const selected = structuredClone(container(handoff));
    const selectedImage = structuredClone(image());
    if (seed === "image") selected.Image = `sha256:${hex("e")}`;
    if (seed === "config") selectedImage.Config.User = "root";
    if (seed === "user") selected.Config.User = "0:0";
    if (seed === "root-writable") selected.HostConfig.ReadonlyRootfs = false;
    if (seed === "capability") selected.HostConfig.CapDrop = [];
    if (seed === "privilege") selected.HostConfig.SecurityOpt = [];
    if (seed === "mount") selected.Mounts = [{ Type: "bind" }];
    if (seed === "handoff") selected.Config.Env = [];
    expect(() =>
      validateImmutableScenarioContainer({
        container: selected,
        handoff,
        image: selectedImage,
        networkName: "selected-network",
        tmpfs: selected.HostConfig.Tmpfs,
      }),
    ).toThrow("integration.immutable-candidate.authority");
  });
});
