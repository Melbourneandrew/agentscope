import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type { HeadlessExecutionRequest } from "../headless-supervisor-contract.js";
import { executeSelectedPtyProcess } from "../headless-supervisor-kernel.js";
import type { HeadlessSupervisorCapability } from "../headless-supervisor.js";
import type { SelectedPtyExecutionRequest } from "../pty-terminal-contract.js";
import {
  executeSelectedPtyTransportForTest,
  validateSelectedContainerFilesystemFactsForTest,
  validateSelectedContainerPrincipalFactsForTest,
} from "../internal/headless-supervisor-backend.js";

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const request = (
  overrides: Partial<HeadlessExecutionRequest> = {},
): SelectedPtyExecutionRequest => {
  const now = performance.now();
  return {
    completion: { kind: "semantic-marker" },
    interaction: {
      trigger: "semantic-ready",
      actions: [
        {
          action: "input",
          byteLength: 4,
          inputSha256:
            "5040625b1fb6fa4af07226683f6e6003b29e5e70b16f8cfb24be7a752393f0ee",
        },
        { action: "eof" },
      ],
    },
    initialGeometry: { columns: 40, rows: 12 },
    interpreter: {
      path: "/usr/local/bin/node",
      sha256: createHash("sha256").update("node-interpreter").digest("hex"),
    },
    process: {
      runId: "0123456789abcdef",
      requestFingerprint: sha256("selected-pty-request"),
      executable: "/scenario/installed-cli-driver",
      arguments: ["narrow-terminal"],
      cwd: "/scenario",
      environment: { LANG: "C.UTF-8" },
      stdin: new Uint8Array([121, 101, 115, 10]),
      stdoutLimitBytes: 4_096,
      stderrLimitBytes: 4_096,
      monotonicStartupDeadlineMs: now + 100,
      monotonicExecutionDeadlineMs: now + 200,
      monotonicShutdownDeadlineMs: now + 700,
      terminationGraceMs: 50,
      ...overrides,
    },
    scriptSha256: createHash("sha256")
      .update("installed-cli-driver")
      .digest("hex"),
  };
};

// eslint-disable-next-line max-lines-per-function
describe("selected PTY transport", () => {
  const principalFacts = () => ({
    uid: 1000,
    euid: 1000,
    gid: 1000,
    egid: 1000,
    groups: [1000],
    status: [
      "Uid:\t1000\t1000\t1000\t1000",
      "Gid:\t1000\t1000\t1000\t1000",
      "CapEff:\t0000000000000000",
      "CapPrm:\t0000000000000000",
      "CapInh:\t0000000000000000",
      "CapAmb:\t0000000000000000",
      "CapBnd:\t0000000000000000",
      "NoNewPrivs:\t1",
      "",
    ].join("\n"),
  });

  it("causally validates the selected immutable principal record", () => {
    expect(
      validateSelectedContainerPrincipalFactsForTest(principalFacts()),
    ).toBe(true);
  });

  it.each(["uid", "gid", "groups", "status"] as const)(
    "rejects causal immutable principal %s substitution",
    (seed) => {
      const facts = principalFacts();
      if (seed === "uid") facts.uid = 0;
      if (seed === "gid") facts.gid = 0;
      if (seed === "groups") facts.groups = [1000, 1001];
      if (seed === "status")
        facts.status = facts.status.replace(
          "CapBnd:\t0000000000000000",
          "CapBnd:\t0000000000000001",
        );
      expect(() =>
        validateSelectedContainerPrincipalFactsForTest(facts),
      ).toThrow("testkit.pty.immutable-candidate");
    },
  );

  it("causally validates selected immutable file and procfs facts", () => {
    expect(validateSelectedContainerFilesystemFactsForTest({})).toBe(true);
  });

  it.each([
    [
      "mount-rw",
      { mountinfo: "7 1 0:1 / /selected rw - overlay overlay rw\n" },
    ],
    [
      "mount-duplicate",
      {
        mountinfo:
          "7 1 0:1 / /a ro - overlay overlay ro\n7 1 0:1 / /b ro - overlay overlay ro\n",
      },
    ],
    ["mount-malformed", { mountinfo: "invalid\n" }],
    ["fd-missing", { fdinfo: "flags:\t0\n" }],
    ["fd-duplicate", { fdinfo: "mnt_id:\t7\nmnt_id:\t7\n" }],
    ["fd-mismatch", { fdinfo: "mnt_id:\t8\n" }],
    ["symlink", { isFile: false }],
    ["link-substitution", { linkPath: "/selected/other" }],
    ["device-substitution", { after: { dev: 2, ino: 2, size: 3 } }],
    ["inode-substitution", { after: { dev: 1, ino: 3, size: 3 } }],
    ["size-substitution", { after: { dev: 1, ino: 2, size: 4 } }],
    ["same-inode-mutation", { digest: "b".repeat(64) }],
  ] as const)("rejects causal immutable filesystem %s", (_seed, facts) => {
    expect(() =>
      validateSelectedContainerFilesystemFactsForTest(facts),
    ).toThrow("testkit.pty.immutable-candidate");
  });
  it("binds real PTY geometry and returns only bounded semantic evidence", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "clean",
    );
    expect(receipt).toMatchObject({
      receiptVersion: 1,
      isTTY: true,
      initialGeometry: { columns: 40, rows: 12 },
      observedGeometry: { columns: 40, rows: 12 },
      observedCanonicalMode: true,
      eofByte: 4,
      eofByteWritten: true,
      inputBytesWritten: 4,
      outcome: "completed",
      cleanup: "clean",
      processJoined: true,
      residualProcessCount: 0,
      terminalInputJoined: true,
      terminalOutputJoined: true,
      terminalTransportClosed: true,
    });
    expect(receipt.outputBytes).toBe(43);
    expect(receipt.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("ready");
  });

  it.each([
    ["geometry-substitution", "testkit.pty.geometry"],
    ["mode-substitution", "testkit.pty.geometry"],
    ["identity-substitution", "testkit.headless.reconciliation.deadline"],
    ["observer-failure", "testkit.headless.reconciliation.deadline"],
    ["residual", "testkit.headless.reconciliation.deadline"],
    ["root-missing", "testkit.headless.observer.root"],
    ["signal-failure", "testkit.headless.reconciliation.deadline"],
  ] as const)("fails closed for %s", async (seed, code) => {
    await expect(
      executeSelectedPtyTransportForTest(request(), seed),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    "immutable-capability",
    "immutable-device-inode",
    "immutable-mount-id",
    "immutable-mount-rw",
    "immutable-no-new-privileges",
    "immutable-principal",
    "immutable-symlink",
  ] as const)(
    "rejects immutable-candidate authority substitution %s",
    async (seed) => {
      await expect(
        executeSelectedPtyTransportForTest(request(), seed),
      ).rejects.toMatchObject({ code: "testkit.pty.immutable-candidate" });
    },
  );

  it("admits exact output as completion without a fabricated marker", async () => {
    const output = Buffer.from("ready");
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...request(),
        completion: {
          kind: "exact-output",
          outputBytes: output.length,
          outputSha256: createHash("sha256").update(output).digest("hex"),
        },
        interaction: { trigger: "immediate", actions: [{ action: "eof" }] },
        process: { ...request().process, stdin: new Uint8Array() },
      },
      "active-terminal",
    );
    expect(receipt).toMatchObject({
      outcome: "completed",
      finalSnapshot: { semanticState: "active" },
      outputBytes: output.length,
    });
  });

  it("drains fragmented terminal output through the exact EIO witness", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "fragmented-output",
    );
    expect(receipt).toMatchObject({
      outcome: "completed",
      outputBytes: 43,
      terminalOutputJoined: true,
      terminalTransportClosed: true,
    });
  });

  it("drains output that becomes readable only after child terminal", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "late-tail",
    );
    expect(receipt).toMatchObject({
      outcome: "completed",
      outputBytes: 43,
      terminalOutputJoined: true,
    });
  });

  it("does not let a late abort rewrite an authenticated child terminal", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 15);
    try {
      const receipt = await executeSelectedPtyTransportForTest(
        request(),
        "late-tail",
        { signal: controller.signal },
      );
      expect(receipt).toMatchObject({ outcome: "completed", signal: null });
    } finally {
      clearTimeout(timer);
    }
  });

  it.each([
    ["active-terminal", "testkit.pty.transport.semantic-missing-readiness"],
    ["missing-ready", "testkit.pty.transport.semantic-missing-readiness"],
    ["credential-prompt", "testkit.pty.transport.semantic-credential-prompt"],
    ["malformed-control", "testkit.pty.transport.semantic-malformed-control"],
  ] as const)(
    "rejects terminal semantic state %s as completion",
    async (seed, code) => {
      await expect(
        executeSelectedPtyTransportForTest(request(), seed),
      ).rejects.toMatchObject({ code });
    },
  );

  it("orders partial input completion before its authenticated EOF byte", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "partial-input",
    );
    expect(receipt).toMatchObject({
      eofByteWritten: true,
      inputBytesWritten: 4,
      outcome: "completed",
      terminalInputJoined: true,
    });
  });

  it("applies a readiness-gated resize before segmented input and EOF", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...request(),
        interaction: {
          trigger: "semantic-ready",
          actions: [
            { action: "resize", geometry: { columns: 80, rows: 24 } },
            {
              action: "input",
              byteLength: 2,
              inputSha256:
                "ee425df98582637bac95ed97cbf450c593d75e34cf832fd8acb5913392c52dd8",
            },
            {
              action: "input",
              byteLength: 2,
              inputSha256:
                "cbc80bb5c0c0f8944bf73b3a429505ac5cde16644978bc9a1e74c5755f8ca556",
            },
            { action: "eof" },
          ],
        },
      },
      "clean",
    );
    expect(receipt).toMatchObject({
      observedGeometry: { columns: 80, rows: 24 },
      outcome: "completed",
      actions: [
        { action: "resize", geometry: { columns: 80, rows: 24 } },
        { action: "input", byteLength: 2 },
        { action: "input", byteLength: 2 },
        { action: "eof" },
      ],
    });
  });

  it("does not dispatch the validated action plan through ambient array hooks", async () => {
    const now = performance.now();
    const selected = {
      ...request({
        stdin: new Uint8Array(),
        monotonicStartupDeadlineMs: now + 500,
        monotonicExecutionDeadlineMs: now + 2_000,
        monotonicShutdownDeadlineMs: now + 2_500,
      }),
      interaction: {
        trigger: "semantic-ready" as const,
        actions: [
          ...Array.from({ length: 63 }, () => ({
            action: "resize" as const,
            geometry: { columns: 80, rows: 24 },
          })),
          { action: "eof" as const },
        ],
      },
    };
    const priorNumeric = Object.getOwnPropertyDescriptor(Array.prototype, "63");
    let numericSetterCalls = 0;
    let receipt;
    let failure: unknown;
    try {
      Object.defineProperty(Array.prototype, "63", {
        configurable: true,
        set: () => {
          numericSetterCalls += 1;
        },
      });
      try {
        receipt = await executeSelectedPtyTransportForTest(selected, "clean");
      } catch (error) {
        failure = error;
      }
    } finally {
      if (priorNumeric === undefined)
        Reflect.deleteProperty(Array.prototype, "63");
      else Object.defineProperty(Array.prototype, "63", priorNumeric);
    }
    expect(failure).toBeUndefined();
    expect(numericSetterCalls).toBe(0);
    expect(receipt).toMatchObject({ outcome: "completed" });
  });

  it.each(["push", "some", "reduce"] as const)(
    "rejects an own %s method on the action collection",
    async (name) => {
      const selected = request();
      Object.defineProperty(selected.interaction.actions, name, {
        value: () => [{ action: "signal", signal: "SIGKILL" }],
      });
      await expect(
        executeSelectedPtyTransportForTest(selected, "clean"),
      ).rejects.toMatchObject({ code: "testkit.pty.request" });
    },
  );

  it("rejects symbol-keyed action authority", async () => {
    const selected = request();
    Object.defineProperty(selected.interaction.actions[0]!, Symbol("hidden"), {
      value: { action: "signal", signal: "SIGKILL" },
    });
    await expect(
      executeSelectedPtyTransportForTest(selected, "clean"),
    ).rejects.toMatchObject({ code: "testkit.pty.request" });
  });

  it("applies a readiness-gated interrupt byte without retaining its bytes", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...request({ stdin: new Uint8Array() }),
        interaction: {
          trigger: "semantic-ready",
          actions: [{ action: "interrupt-byte", byte: 3 }],
        },
      },
      "clean",
    );
    expect(receipt).toMatchObject({
      outcome: "completed",
      actions: [{ action: "interrupt-byte", byte: 3 }],
    });
    expect(JSON.stringify(receipt)).not.toContain("stdin");
  });

  it("signals the authenticated selected root from the action plan", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...request({ stdin: new Uint8Array() }),
        interaction: {
          trigger: "semantic-ready",
          actions: [{ action: "signal", signal: "SIGINT" }],
        },
      },
      "clean",
    );
    expect(receipt).toMatchObject({
      outcome: "signaled",
      signal: "SIGINT",
      actions: [{ action: "signal", signal: "SIGINT" }],
      processJoined: true,
    });
  });

  it.each([
    "descriptor-closure",
    "descriptor-reuse",
    "descriptor-substitution",
  ] as const)("rejects authenticated descriptor %s", async (seed) => {
    await expect(
      executeSelectedPtyTransportForTest(request(), seed),
    ).rejects.toMatchObject({ code: "testkit.pty.runtime.identity" });
  });

  it("does not claim completion when the EOF byte cannot be written", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "eof-failure",
    );
    expect(receipt).toMatchObject({
      cleanup: "clean",
      eofByteWritten: false,
      outcome: "transport-failed",
      terminalInputJoined: false,
    });
  });

  it.each(["transport-failure", "close-failure"] as const)(
    "returns no evidence when %s prevents terminal proof",
    async (seed) => {
      await expect(
        executeSelectedPtyTransportForTest(request(), seed),
      ).rejects.toMatchObject({
        code: "testkit.headless.reconciliation.deadline",
      });
    },
  );

  it("bounds terminal output and joins the selected process authority", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request({ stdoutLimitBytes: 16 }),
      "output-limit",
    );
    expect(receipt).toMatchObject({
      cleanup: "clean",
      exitCode: null,
      finalSnapshot: { semanticState: "output-limit" },
      outcome: "output-limit",
      processJoined: true,
      signal: "SIGTERM",
    });
  });

  it("does not begin input before readiness when output-limit triggers", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request({ stdoutLimitBytes: 16 }),
      "partial-input-output-limit",
    );
    expect(receipt).toMatchObject({
      eofByteWritten: false,
      finalSnapshot: { semanticState: "output-limit" },
      inputBytesWritten: 0,
      outcome: "output-limit",
      terminalInputJoined: false,
    });
  });

  it("stops input and EOF writes after the execution deadline triggers", async () => {
    const now = performance.now();
    const receipt = await executeSelectedPtyTransportForTest(
      request({
        monotonicStartupDeadlineMs: now + 20,
        monotonicExecutionDeadlineMs: now + 40,
        monotonicShutdownDeadlineMs: now + 300,
        terminationGraceMs: 20,
      }),
      "partial-input-timeout",
    );
    expect(receipt).toMatchObject({
      eofByteWritten: false,
      inputBytesWritten: 2,
      outcome: "timeout",
      terminalInputJoined: false,
    });
  });

  it("applies the one absolute deadline and terminates a hung PTY process", async () => {
    const now = performance.now();
    const receipt = await executeSelectedPtyTransportForTest(
      request({
        monotonicStartupDeadlineMs: now + 20,
        monotonicExecutionDeadlineMs: now + 40,
        monotonicShutdownDeadlineMs: now + 300,
        terminationGraceMs: 20,
      }),
      "timeout",
    );
    expect(receipt).toMatchObject({
      cleanup: "clean",
      exitCode: null,
      outcome: "timeout",
      processJoined: true,
      signal: "SIGTERM",
    });
  });

  it("escalates a TERM-resistant PTY process to KILL and joins it", async () => {
    const now = performance.now();
    const receipt = await executeSelectedPtyTransportForTest(
      request({
        monotonicStartupDeadlineMs: now + 20,
        monotonicExecutionDeadlineMs: now + 40,
        monotonicShutdownDeadlineMs: now + 300,
        terminationGraceMs: 20,
      }),
      "kill-escalation",
    );
    expect(receipt).toMatchObject({
      cleanup: "clean",
      exitCode: null,
      outcome: "timeout",
      processJoined: true,
      residualProcessCount: 0,
      signal: "SIGKILL",
      terminalOutputJoined: true,
      terminalTransportClosed: true,
    });
  });

  it("rejects a child admitted after the absolute startup deadline", async () => {
    const now = performance.now();
    await expect(
      executeSelectedPtyTransportForTest(
        request({
          monotonicStartupDeadlineMs: now + 10,
          monotonicExecutionDeadlineMs: now + 100,
          monotonicShutdownDeadlineMs: now + 400,
        }),
        "startup-delay",
      ),
    ).rejects.toMatchObject({ code: "testkit.headless.startup.deadline" });
  });

  it("admits no action when readiness observation crosses the execution deadline", async () => {
    const now = performance.now();
    const receipt = await executeSelectedPtyTransportForTest(
      request({
        monotonicStartupDeadlineMs: now + 10,
        monotonicExecutionDeadlineMs: now + 30,
        monotonicShutdownDeadlineMs: now + 300,
      }),
      "action-deadline-crossing",
    );
    expect(receipt).toMatchObject({
      actions: [],
      inputBytesWritten: 0,
      outcome: "timeout",
      terminalInputJoined: false,
    });
  });

  it("distinguishes a represented nonzero child exit", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "nonzero-exit",
    );
    expect(receipt).toMatchObject({
      exitCode: 7,
      outcome: "exited-nonzero",
      signal: null,
    });
  });

  it.each([
    ["malformed-exit", "testkit.pty.transport"],
    ["unsupported-signal", "testkit.pty.transport.exit"],
  ] as const)("returns no completion receipt for %s", async (seed, code) => {
    await expect(
      executeSelectedPtyTransportForTest(request(), seed),
    ).rejects.toMatchObject({ code });
  });

  it("aborts and joins the same selected PTY authority", async () => {
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort();
    });
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "timeout",
      { signal: controller.signal },
    );
    expect(receipt).toMatchObject({
      cleanup: "clean",
      outcome: "aborted",
      processJoined: true,
      signal: "SIGTERM",
    });
  });

  it("does not let callers mint selected PTY authority", async () => {
    await expect(
      executeSelectedPtyProcess({} as HeadlessSupervisorCapability, request()),
    ).rejects.toMatchObject({ code: "testkit.headless.capability" });
  });

  it("rejects extra request fields and substituted geometry", async () => {
    const valid = request();
    await expect(
      executeSelectedPtyTransportForTest(
        { ...valid, extra: true } as SelectedPtyExecutionRequest,
        "clean",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.request" });
    await expect(
      executeSelectedPtyTransportForTest(
        { ...valid, initialGeometry: { columns: 0, rows: 12 } },
        "clean",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.geometry" });
    await expect(
      executeSelectedPtyTransportForTest(
        { ...valid, scriptSha256: "0" },
        "clean",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.runtime.identity" });
    await expect(
      executeSelectedPtyTransportForTest(
        {
          ...valid,
          interaction: {
            trigger: "immediate",
            actions: [
              {
                action: "input",
                byteLength: 4,
                inputSha256:
                  "5040625b1fb6fa4af07226683f6e6003b29e5e70b16f8cfb24be7a752393f0ee",
              },
              { action: "eof" },
            ],
          },
        },
        "clean",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.request" });
    await expect(
      executeSelectedPtyTransportForTest(
        {
          ...valid,
          interpreter: { ...valid.interpreter, extra: true },
        } as SelectedPtyExecutionRequest,
        "clean",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.runtime.identity" });
  });

  it("loads the authenticated native object through its held procfs descriptor", () => {
    const source = readFileSync(
      new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("safeReflectApply(processDlopen, process");
    expect(source).toContain("`/proc/self/fd/${descriptor}`");
    expect(source).not.toContain("requireAuthority(path)");
  });
});
