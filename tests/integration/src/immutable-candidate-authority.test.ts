/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The authority is deliberately private integration JavaScript, not a package API.
// @ts-expect-error no declaration file is published for this private module
import * as immutableAuthority from "../immutable-candidate-authority.mjs";

const {
  compileCandidateInventory,
  compileImmutableCandidateHandoff,
  codexProjectionFailureDiagnostic,
  codexUninstallFailureDiagnostic,
  decodeCodexJoinDeadlineExitCode,
  decodeInteractiveFailureExitCode,
  decodeInteractivePtyReceipt,
  decodeImmutableCandidateHandoff,
  encodeInteractiveFailureExitCode,
  encodeCodexJoinDeadlineExitCode,
  extractInteractiveChildDiagnostic,
  extractUntrustedCodexJoinHint,
  extractUntrustedCodexTraceHint,
  interactivePtyEnvelopeDeadlineMatches,
  interactivePtyEnvelopeRejectionCode,
  interactivePtyActionPrefixDiagnostic,
  interactivePtyIdleObservationDiagnostic,
  interactivePtyIdleAtTitleDiagnostic,
  interactivePtyExecutionReserveMilliseconds,
  interactivePtyObservedActionsMatch,
  interactivePtyArtifactReadinessMatches,
  interactivePtyArtifactRejectionCode,
  interactivePtyReceiptFailed,
  interactivePtyReceiptAuthorityMatches,
  interactivePtyReceiptRejectionCode,
  parseCodexMachineOutput,
  readBoundedInteractiveFailureMarker,
  selectInteractiveExecutionFailurePredicate,
  selectInteractiveFailureDiagnostic,
  untrustedCodexTraceHint,
  selectedRuntimeFiles,
  validateImmutableScenarioContainer,
} = immutableAuthority;

const hex = (character: string): string => character.repeat(64);

const completed = {
  outcome: "completed",
  finalSnapshot: { semanticState: "completed" },
  exitCode: 0,
  signal: null,
  cleanup: "clean",
  residualProcessCount: 0,
  processJoined: true,
  terminalInputJoined: true,
  terminalOutputJoined: true,
  terminalTransportClosed: true,
};

describe("Codex machine-output failure containment", () => {
  const command = "agentscope uninstall";
  const valid = Buffer.from(
    JSON.stringify({
      command,
      completion: "complete",
      records: [{ ok: true }],
    }),
  );

  it("returns only records from one valid closed envelope", () => {
    expect(parseCodexMachineOutput(valid, command)).toEqual([{ ok: true }]);
  });

  it.each([
    ["invalid-utf8", Buffer.from([0xff])],
    ["invalid-json", Buffer.from("not-json")],
    [
      "missing-records",
      Buffer.from(JSON.stringify({ command, completion: "complete" })),
    ],
    [
      "wrong-command",
      Buffer.from(
        JSON.stringify({
          command: "other",
          completion: "complete",
          records: [],
        }),
      ),
    ],
    ["oversized", Buffer.alloc(1024 * 1024 + 1)],
    ["wrong-type", "not-a-buffer"],
  ] as const)(
    "collapses %s output to one content-free code",
    (_label, bytes) => {
      expect(() => parseCodexMachineOutput(bytes, command)).toThrow(
        "integration.codex.cli-output",
      );
    },
  );
});

describe("interactive PTY artifact diagnostics", () => {
  it("requires readiness for success but retains a false observation for a settled failure", () => {
    const unreadyFailure = {
      ...completed,
      outcome: "deadline",
      finalSnapshot: { semanticState: "active" },
      readinessObserved: false,
    };
    expect(interactivePtyArtifactReadinessMatches(unreadyFailure, true)).toBe(
      true,
    );
    expect(interactivePtyArtifactReadinessMatches(unreadyFailure)).toBe(false);
    expect(
      interactivePtyArtifactReadinessMatches(
        { ...completed, readinessObserved: false },
        true,
      ),
    ).toBe(false);
    for (const invalid of [undefined, null, 0, "false"])
      expect(
        interactivePtyArtifactReadinessMatches(
          { ...unreadyFailure, readinessObserved: invalid },
          true,
        ),
      ).toBe(false);
  });
  it("classifies only the first failed artifact field without emitting its content", () => {
    const predicates = {
      "process-fingerprint": () => true,
      "input-bytes": () => true,
      "input-digest": () => true,
      readiness: () => true,
      interpreter: () => true,
      "script-digest": () => true,
    };
    expect(interactivePtyArtifactRejectionCode(predicates)).toBeNull();
    for (const field of Object.keys(predicates))
      expect(
        interactivePtyArtifactRejectionCode({
          ...predicates,
          [field]: () => false,
        }),
      ).toBe(field);
    expect(
      interactivePtyArtifactRejectionCode({
        ...predicates,
        "input-bytes": () => false,
        readiness: () => false,
      }),
    ).toBe("input-bytes");
  });
});

describe("untrusted Codex trace hint transport", () => {
  it.each([
    "hook-deadline",
    "reporter-child",
    "search-child-deadline",
    "search-child-exit-5",
    "search-child-exit-other",
    "search-child-signal",
    "search-child-output-limit",
    "search-hook-log",
    "search-other",
  ])("extracts one closed content-free hint: %s", (hint) => {
    const line = `integration.runner.untrusted-trace-hint:${hint}\n`;
    expect(extractUntrustedCodexTraceHint(line)).toBe(hint);
    for (const output of [
      `${line}${line}`,
      `${line}integration.runner.untrusted-trace-hint:other\n`,
      `x:${line}`,
      `integration.runner.untrusted-trace-hint:${hint}-extra\n`,
      `integration.runner.untrusted-trace-hint:${hint}:secret\n`,
    ])
      expect(extractUntrustedCodexTraceHint(output)).toBeUndefined();
  });
  it("rejects non-text and oversized attached output", () => {
    expect(extractUntrustedCodexTraceHint(undefined)).toBeUndefined();
    expect(
      extractUntrustedCodexTraceHint("x".repeat(16 * 1024 * 1024 + 1)),
    ).toBeUndefined();
  });
});

describe("interactive PTY receipt settlement", () => {
  it("admits retained success evidence only for an exact completed receipt", () => {
    expect(interactivePtyReceiptFailed(completed)).toBe(false);
  });

  it.each([92, 93])(
    "classifies a semantically complete fixture exit %i as failure before success evidence",
    (exitCode) => {
      expect(
        interactivePtyReceiptFailed({
          ...completed,
          outcome: "exited-nonzero",
          exitCode,
        }),
      ).toBe(true);
    },
  );

  it("rejects conflicting terminal status despite semantic completion", () => {
    expect(interactivePtyReceiptFailed({ ...completed, exitCode: 92 })).toBe(
      true,
    );
    expect(interactivePtyReceiptFailed({ ...completed, signal: 9 })).toBe(true);
  });

  it("accepts a late non-completed receipt only for failure diagnosis with every authority check", () => {
    const checks = {
      envelope: true,
      process: true,
      geometry: true,
      artifact: true,
      fingerprint: true,
    };
    const lateFailure = {
      ...completed,
      outcome: "deadline",
      exitCode: 32,
      finalSnapshot: { semanticState: "active" },
      returnedAtMs: 150,
      request: { process: { monotonicShutdownDeadlineMs: 100 } },
    };
    expect(
      interactivePtyReceiptAuthorityMatches(lateFailure, checks, true),
    ).toBe(true);
    expect(interactivePtyReceiptAuthorityMatches(lateFailure, checks)).toBe(
      false,
    );
    for (const key of [
      "fingerprint",
      "geometry",
      "artifact",
      "process",
      "envelope",
    ] as const)
      expect(
        interactivePtyReceiptAuthorityMatches(
          lateFailure,
          { ...checks, [key]: false },
          true,
        ),
      ).toBe(false);
    const timelySuccess = {
      ...completed,
      returnedAtMs: 50,
      request: { process: { monotonicShutdownDeadlineMs: 100 } },
    };
    expect(interactivePtyReceiptAuthorityMatches(timelySuccess, checks)).toBe(
      true,
    );
    expect(
      interactivePtyReceiptAuthorityMatches(timelySuccess, checks, true),
    ).toBe(false);
  });
});

describe("interactive PTY action prefix diagnostics", () => {
  it("emits only bounded counts for an authenticated failed-action prefix", () => {
    const requested = [
      { action: "resize" },
      { action: "input", secret: "never-print" },
      { action: "wait-for-semantic-completion" },
    ];
    expect(
      interactivePtyActionPrefixDiagnostic({
        actions: requested.slice(0, 2),
        request: { interaction: { actions: requested } },
      }),
    ).toBe("integration.isolation.pty-action-prefix:2/3");
    expect(
      interactivePtyActionPrefixDiagnostic({
        actions: [{ action: "input" }],
        request: { interaction: { actions: requested } },
      }),
    ).toBeUndefined();
    expect(
      interactivePtyActionPrefixDiagnostic({
        actions: [],
        request: {
          interaction: {
            actions: Array.from({ length: 33 }, () => ({ action: "input" })),
          },
        },
      }),
    ).toBeUndefined();
  });

  it("prints only closed post-submission idle categories from a failed receipt", () => {
    const receipt = {
      request: {
        readiness: { kind: "challenge-styled-text" },
        interaction: {
          actions: [{ action: "wait-for-post-submission-idle-prompt" }],
        },
      },
      postSubmissionIdleDiagnostic: "response-not-observed",
      postSubmissionIdleAtTitleDiagnostic: "idle-ready",
    };
    expect(interactivePtyIdleObservationDiagnostic(receipt)).toBe(
      "integration.isolation.pty-idle-diagnostic:response-not-observed",
    );
    expect(interactivePtyIdleAtTitleDiagnostic(receipt)).toBe(
      "integration.isolation.pty-idle-at-title:idle-ready",
    );
    for (const category of [
      "idle-revoked-screen",
      "idle-revoked-alternate-screen-enter",
      "idle-revoked-alternate-screen-exit",
      "idle-revoked-autowrap-enable",
      "idle-revoked-autowrap-disable",
      "idle-revoked-scroll-region",
      "idle-revoked-screen-edit",
    ])
      expect(
        interactivePtyIdleAtTitleDiagnostic({
          ...receipt,
          postSubmissionIdleAtTitleDiagnostic: category,
        }),
      ).toBe(`integration.isolation.pty-idle-at-title:${category}`);
    for (const substituted of [
      "terminal-content\nspoofed-output",
      "\u001b[31mredacted\u001b[0m",
      { toString: () => "secret" },
      null,
      undefined,
    ])
      expect(
        interactivePtyIdleObservationDiagnostic({
          ...receipt,
          postSubmissionIdleDiagnostic: substituted,
        }),
      ).toBe("integration.isolation.pty-idle-diagnostic:missing-or-invalid");
    for (const substituted of [
      "terminal-content\nspoofed-output",
      "\u001b[31mredacted\u001b[0m",
      { toString: () => "secret" },
      null,
      undefined,
    ])
      expect(
        interactivePtyIdleAtTitleDiagnostic({
          ...receipt,
          postSubmissionIdleAtTitleDiagnostic: substituted,
        }),
      ).toBe("integration.isolation.pty-idle-at-title:missing-or-invalid");
    expect(
      interactivePtyIdleObservationDiagnostic({
        ...receipt,
        request: {
          ...receipt.request,
          readiness: { kind: "semantic-marker" },
        },
      }),
    ).toBeUndefined();
  });
});

describe("Codex trace cutoff ordering", () => {
  it("keeps the selected PTY alive through the actual Codex trace cutoff", () => {
    expect(
      interactivePtyExecutionReserveMilliseconds("codex-tui-trace-smoke"),
    ).toBe(5_000);
    for (const other of ["fixture-process-interactive", "", undefined])
      expect(interactivePtyExecutionReserveMilliseconds(other)).toBe(5_000);

    const integrationRoot = resolve(import.meta.dirname, "..");
    const runner = readFileSync(join(integrationRoot, "runner.mjs"), "utf8");
    const controller = readFileSync(
      join(integrationRoot, "run-scenarios.mjs"),
      "utf8",
    );
    const fixture = readFileSync(
      join(integrationRoot, "codex-pty-scenario.mjs"),
      "utf8",
    );
    const runnerReserve = runner.match(
      /AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS: String\(headlessOuterDeadline - ([\d_]+)\)/u,
    )?.[1];
    const controllerReserve = controller.match(
      /AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS: String\(\s*outerMonotonicDeadlineMs - ([\d_]+),?\s*\)/u,
    )?.[1];
    const traceReserve = fixture.match(
      /const traceDeadline = deadline - ([\d_]+);/u,
    )?.[1];
    expect(runnerReserve).toBeDefined();
    expect(controllerReserve).toBe(runnerReserve);
    expect(traceReserve).toBeDefined();
    const traceCutoffReserve =
      Number(runnerReserve?.replaceAll("_", "")) +
      Number(traceReserve?.replaceAll("_", ""));
    expect(traceCutoffReserve).toBe(8_000);
    expect(
      traceCutoffReserve -
        interactivePtyExecutionReserveMilliseconds("codex-tui-trace-smoke"),
    ).toBeGreaterThanOrEqual(3_000);
  });
});

describe("interactive PTY action matching", () => {
  it("requires full successful PTY actions but an exact failure prefix", () => {
    const expected = [
      { action: "resize" },
      { action: "input" },
      { action: "wait-for-semantic-completion" },
      { action: "input" },
    ];
    expect(interactivePtyObservedActionsMatch(expected, expected)).toBe(true);
    expect(
      interactivePtyObservedActionsMatch(expected.slice(0, 2), expected),
    ).toBe(false);
    expect(
      interactivePtyObservedActionsMatch(expected.slice(0, 2), expected, true),
    ).toBe(true);
    expect(interactivePtyObservedActionsMatch([], expected, true)).toBe(true);
    expect(
      interactivePtyObservedActionsMatch([{ action: "input" }], expected, true),
    ).toBe(false);
    expect(
      interactivePtyObservedActionsMatch(
        [...expected, { action: "input" }],
        expected,
        true,
      ),
    ).toBe(false);
    expect(interactivePtyObservedActionsMatch(null, expected, true)).toBe(
      false,
    );
    expect(interactivePtyObservedActionsMatch([null], expected, true)).toBe(
      false,
    );
  });
});

describe("interactive PTY receipt rejection diagnostics", () => {
  it("uses closed envelope field names and stops at the first failed field", () => {
    const calls: string[] = [];
    const fields = [
      "identity",
      "deadline",
      "completion",
      "readiness",
      "trigger",
      "requested-actions",
      "observed-actions",
      "terminal-action",
      "tty",
      "canonical-mode",
    ];
    const predicates = Object.fromEntries(
      fields.map((field) => [
        field,
        () => {
          calls.push(field);
          return field !== "readiness";
        },
      ]),
    );
    expect(interactivePtyEnvelopeRejectionCode(predicates)).toBe("readiness");
    expect(calls).toEqual(["identity", "deadline", "completion", "readiness"]);
    expect(interactivePtyEnvelopeRejectionCode({})).toBe("identity");
    const passing = Object.fromEntries(
      fields.map((field) => [field, () => true]),
    );
    expect(interactivePtyEnvelopeRejectionCode(passing)).toBeNull();
    for (const field of fields)
      expect(
        interactivePtyEnvelopeRejectionCode({
          ...passing,
          [field]: () => false,
        }),
      ).toBe(field);
  });

  it("keeps a late exact envelope only for failure diagnosis", () => {
    expect(interactivePtyEnvelopeDeadlineMatches(100, 100, 99)).toBe(true);
    expect(interactivePtyEnvelopeDeadlineMatches(100, 100, 100)).toBe(false);
    expect(interactivePtyEnvelopeDeadlineMatches(100, 100, 101)).toBe(false);
    expect(interactivePtyEnvelopeDeadlineMatches(100, 100, 101, true)).toBe(
      true,
    );
    expect(interactivePtyEnvelopeDeadlineMatches(99, 100, 101, true)).toBe(
      false,
    );
    expect(interactivePtyEnvelopeDeadlineMatches(101, 100, 101, true)).toBe(
      false,
    );
  });

  it("classifies rejected receipt authority with closed content-free codes", () => {
    const checks = {
      envelope: true,
      process: true,
      geometry: true,
      artifact: true,
      fingerprint: true,
    };
    const failed = {
      ...completed,
      outcome: "deadline",
      finalSnapshot: { semanticState: "active" },
    };
    expect(interactivePtyReceiptRejectionCode(failed, checks, true)).toBeNull();
    expect(interactivePtyReceiptRejectionCode(completed, checks, true)).toBe(
      "terminal-state",
    );
    for (const key of Object.keys(checks))
      expect(
        interactivePtyReceiptRejectionCode(
          failed,
          { ...checks, [key]: false },
          true,
        ),
      ).toBe(key);
    expect(
      interactivePtyReceiptRejectionCode(
        failed,
        {
          ...checks,
          envelope: false,
          fingerprint: false,
        },
        true,
      ),
    ).toBe("envelope");
    expect(
      interactivePtyReceiptRejectionCode(
        { ...completed, finalSnapshot: null },
        checks,
        true,
      ),
    ).toBe("terminal-state");
  });
});

describe("interactive failure diagnostic precedence", () => {
  it("retains an exact fixture cause ahead of the last progress phase", () => {
    expect(
      selectInteractiveFailureDiagnostic(
        "integration.fixture.codex-model-gate-arm-control",
        "integration.fixture.codex-model-gate-arm-start",
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("integration.fixture.codex-model-gate-arm-control");
    expect(
      selectInteractiveFailureDiagnostic(
        "integration.fixture.codex-not-allowlisted",
        "integration.fixture.codex-model-gate-arm-health-pending",
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("integration.fixture.codex-model-gate-arm-health-pending");
    expect(
      selectInteractiveFailureDiagnostic(
        undefined,
        undefined,
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("testkit.pty.receipt-terminal");
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
describe("immutable candidate authority", () => {
  it("binds a canonical candidate inventory and closed handoff", () => {
    const handoff = compiled();
    expect(
      decodeImmutableCandidateHandoff(handoff.encoded, expected()),
    ).toEqual(expect.objectContaining(expected()));
    expect(selectedRuntimeFiles).toEqual(
      expect.arrayContaining([
        "testkit/bounded-terminal-emulator.js",
        "testkit/pty-terminal-contract.js",
        "testkit/pty-runtime/node127-linux-x64-glibc/pty.node",
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

describe("interactive PTY receipt transport", () => {
  const line = (value: unknown) =>
    `AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

  it("accepts exactly one canonical bounded receipt record", () => {
    expect(decodeInteractivePtyReceipt(line({ receiptVersion: 1 }))).toEqual({
      receiptVersion: 1,
    });
  });

  it.each([
    "",
    `${line({ receiptVersion: 1 })}\n${line({ receiptVersion: 1 })}`,
    `${line({ receiptVersion: 1 })}\n${line({ receiptVersion: 2 })}`,
    "AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=***",
    `AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=${Buffer.from('{ "receiptVersion": 1 }').toString("base64url")}`,
  ])(
    "rejects missing, duplicate, malformed, or noncanonical records",
    (value) => {
      expect(() => decodeInteractivePtyReceipt(value)).toThrow(
        "integration.immutable-candidate.authority",
      );
    },
  );
});

describe("interactive PTY failure diagnostic provenance", () => {
  it("never reports a spoofed Codex subtype from stdout or another scenario", () => {
    const specific =
      "integration.fixture.codex-tui-join-deadline-session-end-completed";
    expect(
      selectInteractiveExecutionFailurePredicate(
        specific,
        undefined,
        "codex-tui-trace-smoke",
      ),
    ).toBe("child-failure");
    expect(
      selectInteractiveExecutionFailurePredicate(
        specific,
        undefined,
        "fixture-process-interactive",
      ),
    ).toBe("child-failure");
    expect(
      selectInteractiveExecutionFailurePredicate(
        specific,
        specific,
        "fixture-process-interactive",
      ),
    ).toBe("child-failure");
    expect(
      selectInteractiveExecutionFailurePredicate(
        "integration.runner.fixture-failed",
        specific,
        "codex-tui-trace-smoke",
      ),
    ).toBe(specific);
  });
});

describe("interactive PTY failure diagnostic transport", () => {
  it("uses a disjoint authenticated exit-code range for join classifications", () => {
    const generic = "integration.fixture.codex-tui-join-deadline";
    for (const [index, state] of [
      "log-unavailable",
      "hook-log-invalid",
      "stop-unseen",
      "stop-active",
      "stop-completed",
      "session-end-active",
      "session-end-completed",
    ].entries()) {
      const specific = `${generic}-${state}`;
      expect(encodeCodexJoinDeadlineExitCode(state)).toBe(32 + index);
      expect(decodeCodexJoinDeadlineExitCode(32 + index)).toBe(specific);
      expect(
        encodeInteractiveFailureExitCode(specific, "codex-tui-trace-smoke"),
      ).toBe(32 + index);
      expect(
        decodeInteractiveFailureExitCode(32 + index, "codex-tui-trace-smoke"),
      ).toBe(specific);
      expect(encodeInteractiveFailureExitCode(specific)).toBeUndefined();
      expect(
        encodeInteractiveFailureExitCode(
          specific,
          "fixture-process-interactive",
        ),
      ).toBeUndefined();
      expect(decodeInteractiveFailureExitCode(32 + index)).toBeUndefined();
      expect(
        decodeInteractiveFailureExitCode(
          32 + index,
          "fixture-process-interactive",
        ),
      ).toBeUndefined();
      expect(
        extractInteractiveChildDiagnostic(
          `integration.runner.interactive-diagnostic:${specific}\n`,
        ),
      ).toBe(specific);
    }
    for (const untrusted of [
      undefined,
      "success",
      "session-end-completed-extra",
    ])
      expect(encodeCodexJoinDeadlineExitCode(untrusted)).toBeUndefined();
    for (const unreserved of [undefined, 1, 31, 39, 63, 92, 126, 1.5])
      expect(decodeCodexJoinDeadlineExitCode(unreserved)).toBeUndefined();
  });

  it.each([
    "integration.fixture.codex-tui-exit-published",
    "integration.fixture.codex-tui-joined",
  ])("preserves one post-completion failure witness: %s", (diagnostic) => {
    expect(
      selectInteractiveFailureDiagnostic(
        undefined,
        diagnostic,
        "testkit.pty.receipt-terminal",
      ),
    ).toBe(diagnostic);
    const exitCode = encodeInteractiveFailureExitCode(diagnostic);
    expect(exitCode).toEqual(expect.any(Number));
    expect(exitCode).toBeLessThanOrEqual(134);
    expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
    expect(
      extractInteractiveChildDiagnostic(
        `integration.runner.interactive-diagnostic:${diagnostic}\n`,
      ),
    ).toBe(diagnostic);
  });

  it.each([
    "integration.fixture.codex-tui-join-deadline",
    "integration.fixture.codex-tui-child-rejected",
  ])(
    "transports a join failure through an authenticated exit code: %s",
    (diagnostic) => {
      const exitCode = encodeInteractiveFailureExitCode(diagnostic);
      expect(exitCode).toEqual(expect.any(Number));
      expect(exitCode).toBeLessThanOrEqual(125);
      expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
      expect(
        selectInteractiveFailureDiagnostic(
          undefined,
          diagnostic,
          "testkit.pty.receipt-terminal",
        ),
      ).toBe("testkit.pty.receipt-terminal");
      expect(
        selectInteractiveFailureDiagnostic(
          diagnostic,
          "integration.fixture.codex-tui-exit-published",
          "testkit.pty.receipt-terminal",
        ),
      ).toBe("integration.fixture.codex-tui-exit-published");
      expect(
        selectInteractiveFailureDiagnostic(undefined, undefined, diagnostic),
      ).toBeUndefined();
      expect(
        extractInteractiveChildDiagnostic(
          `integration.runner.interactive-diagnostic:${diagnostic}\n`,
        ),
      ).toBe(diagnostic);
    },
  );
});

describe("interactive trace failure-marker transport", () => {
  it.each([
    "integration.fixture.codex-trace-await-hook-deadline",
    "integration.fixture.codex-trace-await-reporter-child",
    "integration.fixture.codex-trace-await-search-child-deadline",
    "integration.fixture.codex-trace-await-search-child-exit-5",
    "integration.fixture.codex-trace-await-search-hook-log",
    "integration.fixture.codex-trace-await-search-other",
  ])("does not promote a candidate-writable trace hint: %s", (diagnostic) => {
    expect(
      selectInteractiveFailureDiagnostic(
        diagnostic,
        "integration.fixture.codex-trace-search",
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("integration.fixture.codex-trace-search");
    expect(encodeInteractiveFailureExitCode(diagnostic)).toBeUndefined();
    expect(
      extractInteractiveChildDiagnostic(
        `integration.runner.interactive-diagnostic:${diagnostic}\n`,
      ),
    ).toBeUndefined();
    expect(untrustedCodexTraceHint(diagnostic)).toBe(
      diagnostic.slice("integration.fixture.codex-trace-await-".length),
    );
  });
  for (const marker of [
    "integration.fixture.codex-trace-await-other-child",
    "integration.fixture.codex-trace-await-hook-extra",
    "integration.fixture.codex-trace-await-hook",
    "integration.fixture.codex-trace-search",
    undefined,
  ])
    it(`rejects a substituted untrusted trace hint: ${marker}`, () => {
      expect(untrustedCodexTraceHint(marker)).toBeUndefined();
    });
});

describe("Codex uninstall failure diagnostic transport", () => {
  it.each([
    ["integration.codex.child", "child", 142],
    ["integration.codex.child-deadline", "child-deadline", 143],
    ["integration.codex.deadline", "deadline", 144],
    ["integration.codex.trace-deadline", "trace-deadline", 145],
    ["integration.codex.cli-output", "cli-output", 146],
    ["integration.codex.uninstall", "result", 147],
  ] as const)(
    "maps only the exact owned uninstall failure %s",
    (error, category, expectedExitCode) => {
      const diagnostic = `integration.fixture.codex-verify-uninstall-${category}`;
      expect(codexUninstallFailureDiagnostic(error)).toBe(diagnostic);
      const exitCode = encodeInteractiveFailureExitCode(diagnostic);
      expect(exitCode).toBe(expectedExitCode);
      expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
    },
  );

  it.each([
    undefined,
    null,
    "integration.codex.child:stderr",
    "integration.codex.uninstall\nsecret",
    "integration.codex.other",
  ])("rejects unowned uninstall error content: %s", (error) => {
    expect(codexUninstallFailureDiagnostic(error)).toBeUndefined();
  });
});

describe("interactive PTY failure exit-code transport", () => {
  it.each([
    [
      "integration.codex.adapter-observation",
      "integration.fixture.codex-verify-adapter-observation",
      135,
    ],
    ...[
      "scenario",
      "hook-mediation",
      "stimulus",
      "model-request",
      "trace",
      "lifecycle",
    ].map((predicate, index) => [
      `integration.codex.oracle-${predicate}`,
      `integration.fixture.codex-verify-oracle-${predicate}`,
      136 + index,
    ]),
  ])(
    "maps only exact owned projection failure %s",
    (error, diagnostic, expectedExitCode) => {
      expect(codexProjectionFailureDiagnostic(error)).toBe(diagnostic);
      const exitCode = encodeInteractiveFailureExitCode(diagnostic);
      expect(exitCode).toBe(expectedExitCode);
      expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
    },
  );

  it.each([
    undefined,
    null,
    "integration.codex.oracle-other",
    "integration.codex.oracle-trace:raw-content",
    "integration.codex.adapter-observation\nsecret",
    "integration.codex.oracle-__proto__",
  ])("does not export an unowned projection error: %s", (error) => {
    expect(codexProjectionFailureDiagnostic(error)).toBeUndefined();
  });
  it("round-trips one exact allowlisted runner diagnostic through a reserved exit code", () => {
    const diagnostic = "integration.fixture.codex-model-request";
    const exitCode = encodeInteractiveFailureExitCode(diagnostic);
    expect(exitCode).toEqual(expect.any(Number));
    expect(exitCode).toBeGreaterThanOrEqual(64);
    expect(exitCode).toBeLessThanOrEqual(125);
    expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
  });

  it.each([
    ["config", 126],
    ["gate", 127],
    ["trace-get", 128],
    ["correlation", 129],
    ["doctor", 130],
    ["uninstall", 131],
    ["status", 132],
    ["projection", 133],
    ["evidence", 134],
  ] as const)(
    "transports only the closed post-trace checkpoint %s at exit code %i",
    (checkpoint, exitCode) => {
      const diagnostic = `integration.fixture.codex-verify-${checkpoint}`;
      expect(encodeInteractiveFailureExitCode(diagnostic)).toBe(exitCode);
      expect(decodeInteractiveFailureExitCode(exitCode)).toBe(diagnostic);
    },
  );

  it.each([
    undefined,
    "integration.fixture.codex-not-allowlisted",
    "testkit.pty.transport.semantic-nonzero",
  ])("refuses to encode an unapproved diagnostic: %s", (diagnostic) => {
    expect(encodeInteractiveFailureExitCode(diagnostic)).toBeUndefined();
  });

  it.each([undefined, 1, 31, 39, 63, 148, 1.5])(
    "refuses to decode an unreserved exit code: %s",
    (exitCode) => {
      expect(decodeInteractiveFailureExitCode(exitCode)).toBeUndefined();
    },
  );

  it("extracts one exact allowlisted runner diagnostic from attach output", () => {
    expect(
      extractInteractiveChildDiagnostic(
        "prefix\nintegration.runner.interactive-diagnostic:integration.fixture.codex-model-request\nsuffix\n",
      ),
    ).toBe("integration.fixture.codex-model-request");
  });

  it("transports model-gate arm diagnostics without consuming an exit-code slot", () => {
    const diagnostic =
      "integration.fixture.codex-model-gate-arm-session-start-missing";
    expect(encodeInteractiveFailureExitCode(diagnostic)).toBeUndefined();
    expect(
      extractInteractiveChildDiagnostic(
        `integration.runner.interactive-diagnostic:${diagnostic}\n`,
      ),
    ).toBe(diagnostic);
  });

  it.each([
    "",
    "integration.runner.interactive-diagnostic:integration.fixture.codex-model-request\nintegration.runner.interactive-diagnostic:integration.fixture.codex-tui-start\n",
    "integration.runner.interactive-diagnostic:integration.fixture.codex-not-allowlisted\n",
    "x:integration.runner.interactive-diagnostic:integration.fixture.codex-model-request\n",
  ])("rejects missing, duplicate, unapproved, or non-line records", (value) => {
    expect(extractInteractiveChildDiagnostic(value)).toBeUndefined();
  });
});

describe("untrusted Codex join hints", () => {
  it("reads only a bounded no-follow marker as untrusted data", () => {
    const ledger = mkdtempSync(join(tmpdir(), "agentscope-join-hint-"));
    const marker = join(ledger, "interactive-failure.txt");
    const payload = join(ledger, "payload.txt");
    const value = "integration.fixture.codex-tui-join-deadline-stop-active\n";
    try {
      expect(readBoundedInteractiveFailureMarker(ledger)).toBeUndefined();
      writeFileSync(payload, value);
      symlinkSync(payload, marker);
      expect(readBoundedInteractiveFailureMarker(ledger)).toBeUndefined();
      rmSync(marker);
      writeFileSync(marker, "x".repeat(129));
      expect(readBoundedInteractiveFailureMarker(ledger)).toBeUndefined();
      writeFileSync(marker, value);
      expect(readBoundedInteractiveFailureMarker(ledger)).toBe(value.trim());
      writeFileSync(marker, `${value}extra`);
      expect(readBoundedInteractiveFailureMarker(ledger)).toBeUndefined();
    } finally {
      rmSync(ledger, { recursive: true, force: true });
    }
  });

  it("never promotes a candidate-writable specific marker into authority", () => {
    const specific =
      "integration.fixture.codex-tui-join-deadline-session-end-completed";
    expect(
      selectInteractiveFailureDiagnostic(
        specific,
        undefined,
        "testkit.pty.receipt-terminal",
      ),
    ).toBe("testkit.pty.receipt-terminal");
    expect(
      selectInteractiveFailureDiagnostic(specific, undefined, specific),
    ).toBeUndefined();
    expect(decodeInteractiveFailureExitCode(38, "codex-tui-trace-smoke")).toBe(
      specific,
    );
  });

  it("extracts only one closed content-free research hint", () => {
    const line = "integration.runner.untrusted-join-hint:stop-active\n";
    expect(extractUntrustedCodexJoinHint(line)).toBe("stop-active");
    for (const output of [
      `${line}${line}`,
      "integration.runner.untrusted-join-hint:arbitrary\n",
      "integration.runner.untrusted-join-hint:stop-active-extra\n",
      "integration.runner.untrusted-join-hint:stop-active:secret\n",
    ])
      expect(extractUntrustedCodexJoinHint(output)).toBeUndefined();
  });
});
