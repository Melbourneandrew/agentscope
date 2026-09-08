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
    expect(receipt.outputBytes).toBe(23);
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
      outputBytes: 23,
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
      outputBytes: 23,
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
    "active-terminal",
    "credential-prompt",
    "malformed-control",
  ] as const)(
    "rejects terminal semantic state %s as completion",
    async (seed) => {
      await expect(
        executeSelectedPtyTransportForTest(request(), seed),
      ).rejects.toMatchObject({ code: "testkit.pty.transport" });
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

  it("stops input and EOF writes after output-limit authority triggers", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request({ stdoutLimitBytes: 16 }),
      "partial-input-output-limit",
    );
    expect(receipt).toMatchObject({
      eofByteWritten: false,
      finalSnapshot: { semanticState: "output-limit" },
      inputBytesWritten: 2,
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

  it.each(["malformed-exit", "unsupported-signal"] as const)(
    "returns no completion receipt for %s",
    async (seed) => {
      await expect(
        executeSelectedPtyTransportForTest(request(), seed),
      ).rejects.toMatchObject({ code: "testkit.pty.transport" });
    },
  );

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
