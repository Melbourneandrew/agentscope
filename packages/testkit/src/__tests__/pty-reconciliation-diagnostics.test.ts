import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";

import { transpileModule, ScriptTarget } from "typescript";

import { describe, expect, it, vi } from "vitest";

import { HeadlessSupervisorError } from "../headless-supervisor.js";
import type { HeadlessSupervisorCapability } from "../headless-supervisor.js";
import type { SelectedPtyExecutionRequest } from "../pty-terminal-contract.js";
import { executeSelectedPtyTransportForTest } from "../internal/headless-supervisor-backend.js";
import type * as Backend from "../internal/headless-supervisor-backend.js";
import {
  kernelError,
  fail,
  failObserverIdentity,
  failObserverRead,
  observerReadFailureStage,
  ptyAuthorityFailureStage,
  readPtyReconciliationStage,
  trustedErrorCode,
} from "../internal/kernel-errors.js";
import {
  boundedInvoke,
  terminalOf,
  terminalSnapshot,
} from "../internal/kernel-promise.js";

const code = "testkit.headless.reconciliation.deadline";
const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const request = (): SelectedPtyExecutionRequest => {
  const now = performance.now();
  return {
    completion: { kind: "semantic-marker" },
    readiness: { kind: "semantic-marker" },
    interaction: {
      trigger: "semantic-ready",
      actions: [
        { action: "input", byteLength: 4, inputSha256: digest("yes\n") },
        { action: "eof" },
      ],
    },
    initialGeometry: { columns: 40, rows: 12 },
    interpreter: { path: "/usr/local/bin/node", sha256: digest("node") },
    process: {
      runId: "0123456789abcdef",
      requestFingerprint: `sha256:${digest("diagnostic-request")}`,
      executable: "/scenario/installed-cli-driver",
      arguments: ["narrow-terminal"],
      cwd: "/scenario",
      environment: { LANG: "C.UTF-8" },
      stdin: new TextEncoder().encode("yes\n"),
      stdoutLimitBytes: 4096,
      stderrLimitBytes: 4096,
      monotonicStartupDeadlineMs: now + 500,
      monotonicExecutionDeadlineMs: now + 600,
      monotonicShutdownDeadlineMs: now + 1000,
      terminationGraceMs: 50,
    },
    scriptSha256: digest("driver"),
  };
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected-rejection");
    },
    (error: unknown) => error,
  );

describe("exact production proc-reader diagnostic leaves", () => {
  it.each([
    ["ENOENT", undefined],
    ["ESRCH", "observer-esrch"],
    ["EACCES", "observer-permission"],
    ["EPERM", "observer-permission"],
    ["EIO", "observer-io"],
    ["unexpected", "observer-read"],
    ["malformed", "observer-stat"],
    ["valid", undefined],
  ] as const)(
    "preserves the existing %s disposition and fixed leaf",
    (kind, leaf) => {
      const source = readFileSync(
        new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("const readProcessSnapshot = (");
      const end = source.indexOf("const assertNamespaceIdentity =", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const compiled = transpileModule(source.slice(start, end), {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText;
      const read = runInNewContext(
        `${compiled}\nreadProcessSnapshot;`,
        {
          readFileSync: () => {
            if (kind === "valid")
              return `67 (fixture) S 1 ${"0 ".repeat(17)}123`;
            if (kind === "malformed") return "private malformed process data";
            throw Object.assign(new Error("private syscall detail"), {
              code: kind,
            });
          },
          numberIsSafeInteger: Number.isSafeInteger,
          fail,
          failObserverRead,
          observerReadFailureStage,
          trustedErrorCode,
          readPtyReconciliationStage,
        },
        { timeout: 1000 },
      ) as (pid: number) => unknown;
      if (kind === "ENOENT") expect(read(67)).toBeUndefined();
      else if (kind === "valid")
        expect(read(67)).toEqual({
          pid: 67,
          parentPid: 1,
          startIdentity: "67:123",
          state: "S",
        });
      else {
        let error: unknown;
        try {
          read(67);
        } catch (caught) {
          error = caught;
        }
        expect(trustedErrorCode(error)).toBe("testkit.headless.observer.read");
        expect(readPtyReconciliationStage(error)).toBe(leaf);
        expect(JSON.stringify(error)).not.toContain("private");
      }
    },
  );

  it("admits leaves only with their existing authentic observer codes", () => {
    for (const stage of [
      "observer-esrch",
      "observer-permission",
      "observer-stat",
    ] as const) {
      expect(
        readPtyReconciliationStage(
          kernelError("testkit.headless.observer.read", stage),
        ),
      ).toBe(stage);
      expect(
        readPtyReconciliationStage(
          kernelError("testkit.headless.observer.identity", stage),
        ),
      ).toBeUndefined();
      expect(
        readPtyReconciliationStage(
          kernelError("testkit.headless.kernel.failure", stage),
        ),
      ).toBeUndefined();
    }
    for (const stage of [
      "observer-namespace",
      "observer-root-reuse",
      "observer-target-reuse",
      "observer-zombie-before",
      "observer-zombie-after",
    ] as const) {
      expect(
        readPtyReconciliationStage(
          kernelError("testkit.headless.observer.identity", stage),
        ),
      ).toBe(stage);
      expect(
        readPtyReconciliationStage(
          kernelError("testkit.headless.observer.read", stage),
        ),
      ).toBeUndefined();
      expect(readPtyReconciliationStage(kernelError(code, stage))).toBe(stage);
    }
  });
});

describe("exact production observer graph leaf", () => {
  it("keeps a mixed missing-parent snapshot rejected with its original code", () => {
    const source = readFileSync(
      new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const processesDescendantsFirst = (");
    const end = source.indexOf("const reapAdoptedZombies =", start);
    expect(end).toBeGreaterThan(start);
    const compiled = transpileModule(source.slice(start, end), {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const order = runInNewContext(
      `${compiled}\nprocessesDescendantsFirst;`,
      { failObserverIdentity },
      { timeout: 1000 },
    ) as (processes: unknown, root: number) => unknown;
    let error: unknown;
    try {
      order(
        [
          { pid: 21, parentPid: 22, startIdentity: "21:1", state: "R" },
          { pid: 23, parentPid: 1, startIdentity: "23:1", state: "R" },
        ],
        99,
      );
    } catch (caught) {
      error = caught;
    }
    expect(trustedErrorCode(error)).toBe("testkit.headless.observer.identity");
    expect(readPtyReconciliationStage(error)).toBe("observer-graph");
  });
});

describe("private reconciliation provenance", () => {
  it.each([
    ["identity-substitution", "observer-target-reuse"],
    ["observer-failure", "observer-read"],
    ["observer-esrch-failure", "observer-esrch"],
    ["signal-failure", "signal"],
    ["adopted-zombie-reap-failure", "reap"],
    ["residual", "residual"],
    ["output-join-failure", "output-join"],
    ["close-failure", "transport-close"],
  ] as const)(
    "retains the existing %s rejection with its stage",
    async (seed, stage) => {
      const error = await rejection(
        executeSelectedPtyTransportForTest(request(), seed),
      );
      expect(error).toMatchObject({ code });
      expect(trustedErrorCode(error)).toBe(code);
      expect(readPtyReconciliationStage(error)).toBe(stage);
      expect(JSON.stringify(error)).not.toContain(stage);
    },
  );

  it("does not alter a completed positive receipt", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      request(),
      "clean",
    );
    expect(receipt).toMatchObject({
      outcome: "completed",
      cleanup: "clean",
      processJoined: true,
    });
    expect(receipt).not.toHaveProperty("stage");
  });

  it("keeps the selected wrapper's original shutdown conversion primary", async () => {
    const now = performance.now();
    const original = request();
    const selectedRequest = {
      ...original,
      process: {
        ...original.process,
        monotonicStartupDeadlineMs: now + 40,
        monotonicExecutionDeadlineMs: now + 60,
        monotonicShutdownDeadlineMs: now + 100,
        terminationGraceMs: 10,
      },
    };
    const error = await rejection(
      executeSelectedPtyTransportForTest(
        selectedRequest,
        "shutdown-deadline-crossing",
      ),
    );
    expect(trustedErrorCode(error)).toBe(code);
    expect(readPtyReconciliationStage(error)).toBe("outer-shutdown");
  });
});

describe("kernel promise diagnostic ordering", () => {
  it.each([
    "child-join",
    "output-join",
    "transport-close",
    "outer-shutdown",
  ] as const)(
    "keeps authenticated %s across ordinary promise rewraps",
    async (stage) => {
      const original = kernelError(code, stage);
      const error = await rejection(
        boundedInvoke(
          () => Promise.reject(original),
          performance.now() + 1000,
          code,
        ),
      );
      expect(error).not.toBe(original);
      expect(trustedErrorCode(error)).toBe(code);
      expect(readPtyReconciliationStage(error)).toBe(stage);
    },
  );

  it("keeps authentic synchronous failure provenance", () => {
    const original = kernelError(code, "observer");
    let error: unknown;
    try {
      void boundedInvoke(
        () => {
          throw original;
        },
        performance.now() + 1000,
        code,
      );
    } catch (caught) {
      error = caught;
    }
    expect(trustedErrorCode(error)).toBe(code);
    expect(readPtyReconciliationStage(error)).toBe("observer");
  });

  it.each(["reject", "resolve"] as const)(
    "does not promote a late %s after the timer wins",
    async (kind) => {
      let resolve!: (value: string) => void;
      let reject!: (error: unknown) => void;
      const work = new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const result = boundedInvoke(
        () => work,
        performance.now() + 20,
        code,
        "outer-shutdown",
      );
      const snapshot = terminalSnapshot(result);
      const error = await rejection(result);
      expect(readPtyReconciliationStage(error)).toBe("outer-shutdown");
      if (kind === "reject") reject(kernelError(code, "observer"));
      else resolve("late-clean-receipt");
      await terminalOf(work);
      expect(await rejection(result)).toBe(error);
      expect(snapshot()).toEqual({ ok: false, error });
      expect(readPtyReconciliationStage(error)).toBe("outer-shutdown");
    },
  );

  it("does not admit an operation after the original deadline", () => {
    let calls = 0;
    expect(() =>
      boundedInvoke(
        () => {
          calls += 1;
          return Promise.resolve("unexpected");
        },
        performance.now() - 1,
        code,
        "child-join",
      ),
    ).toThrow(code);
    expect(calls).toBe(0);
  });
});

describe("kernel diagnostic authenticity", () => {
  it("rejects spoofed errors without reading hostile properties", () => {
    const original = kernelError(code, "observer");
    const hostile = Object.create(null) as object;
    Object.defineProperty(hostile, "code", {
      get: () => {
        throw new Error("private-content");
      },
    });
    const values: unknown[] = [
      new HeadlessSupervisorError(code),
      { code, stage: "observer" },
      { ...original },
      hostile,
      new Proxy(original, {
        get: () => {
          throw new Error("private-content");
        },
      }),
      null,
      code,
    ];
    for (const value of values) {
      expect(trustedErrorCode(value)).toBeUndefined();
      expect(readPtyReconciliationStage(value)).toBeUndefined();
    }
  });

  it("keeps captured registry methods despite prototype substitution", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const get = WeakMap.prototype.get;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const set = WeakMap.prototype.set;
    let observedCode: string | undefined;
    let observedStage: string | undefined;
    try {
      WeakMap.prototype.get = () => {
        throw new Error("substituted");
      };
      WeakMap.prototype.set = () => {
        throw new Error("substituted");
      };
      const error = kernelError(code, "signal");
      observedCode = trustedErrorCode(error);
      observedStage = readPtyReconciliationStage(error);
    } finally {
      WeakMap.prototype.get = get;
      WeakMap.prototype.set = set;
    }
    expect(observedCode).toBe(code);
    expect(observedStage).toBe("signal");
  });

  it("keeps diagnostics closed and absent on other rejection codes", () => {
    expect(ptyAuthorityFailureStage("testkit.headless.observer.read")).toBe(
      "observer-read",
    );
    expect(ptyAuthorityFailureStage("testkit.headless.observer.identity")).toBe(
      "observer-identity",
    );
    expect(ptyAuthorityFailureStage("testkit.headless.observer.root")).toBe(
      "observer",
    );
    expect(
      readPtyReconciliationStage(
        kernelError("testkit.headless.kernel.failure", "observer"),
      ),
    ).toBeUndefined();
    expect(ptyAuthorityFailureStage("testkit.headless.observer.reap")).toBe(
      "reap",
    );
    expect(ptyAuthorityFailureStage("testkit.headless.observer.signal")).toBe(
      "signal",
    );
    expect(ptyAuthorityFailureStage("private-unexpected-code")).toBe(
      "authority",
    );
  });
});

describe("public selected PTY diagnostic consumer", () => {
  it("preserves only authentic provenance across the actual public rewrap", async () => {
    let backendError = new Error("test-backend-not-configured");
    vi.doMock("../internal/headless-supervisor-backend.js", async () => ({
      ...(await vi.importActual<typeof Backend>(
        "../internal/headless-supervisor-backend.js",
      )),
      executeSelectedPtyProcessWithCapability: () =>
        Promise.reject(backendError),
    }));
    try {
      const { executeSelectedPtyProcess } =
        await import("../headless-supervisor-kernel.js");
      for (const stage of [
        "observer",
        "observer-esrch",
        "observer-zombie-before",
        "outer-shutdown",
      ] as const) {
        backendError = kernelError(code, stage);
        const publicError = await rejection(
          executeSelectedPtyProcess(
            {} as HeadlessSupervisorCapability,
            request(),
          ),
        );
        expect(publicError).not.toBe(backendError);
        expect(trustedErrorCode(publicError)).toBe(code);
        expect(readPtyReconciliationStage(publicError)).toBe(stage);
      }
      backendError = new HeadlessSupervisorError(code);
      const publicError = await rejection(
        executeSelectedPtyProcess(
          {} as HeadlessSupervisorCapability,
          request(),
        ),
      );
      expect(trustedErrorCode(publicError)).toBe(
        "testkit.headless.kernel.failure",
      );
      expect(readPtyReconciliationStage(publicError)).toBeUndefined();
    } finally {
      vi.doUnmock("../internal/headless-supervisor-backend.js");
      vi.resetModules();
    }
  });
});
