import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import { types } from "node:util";

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
  ptyAuthorityFailureStage,
  readPtyReconciliationStage,
  trustedErrorCode,
  type PtyReconciliationStage,
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

const readInternal = (name: string): string =>
  readFileSync(new URL(`../internal/${name}`, import.meta.url), "utf8");
const caughtFailure = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
};

type ReapSnapshot = {
  pid: number;
  parentPid: number;
  startIdentity: string;
  state: string;
};
type ReapOperation = (
  processes: readonly ReapSnapshot[],
  root: number,
  deadline: bigint,
  context: object,
  runtime: object,
) => void;
const createPollingFixture = (input: {
  source: string;
  retention: string;
  reap: ReapOperation;
  ordered: (
    processes: readonly ReapSnapshot[],
    root: number,
  ) => readonly ReapSnapshot[];
  identity: ReapSnapshot;
}) => {
  const { source, retention, reap, ordered, identity } = input;
  const loopStart = source.indexOf(
    "    while (\n      safeReflectApply(performanceNow, performance, []) < graceDeadline",
  );
  const residualStart = source.indexOf(
    "    const residual = currentProcessSet();",
    loopStart,
  );
  const pollingBody = transpileModule(
    retention + source.slice(loopStart, residualStart),
    {
      compilerOptions: { target: ScriptTarget.ES2022 },
    },
  ).outputText;
  return async (
    terminalStatus?: "reaped" | "already-absent",
    witness = { now: 0, deadlines: [] as bigint[] },
  ) => {
    let present = true;
    const native = {
      assertNamespaceIdentity: () => undefined,
      readProcess: () => (present ? identity : undefined),
      reapAdoptedZombie: (
        _pid: number,
        _start: string,
        _root: number,
        deadline: bigint,
      ) => {
        witness.deadlines.push(deadline);
        const status =
          witness.deadlines.length > 1
            ? (terminalStatus ?? "not-ready")
            : "not-ready";
        if (status !== "not-ready") present = false;
        return {
          pid: identity.pid,
          startIdentity: identity.startIdentity,
          status,
        };
      },
    };
    const operation = runInNewContext(
      `(async () => { ${pollingBody}\n return currentProcessSet().length; })()`,
      {
        safeReflectApply: Reflect.apply,
        performanceNow: () => witness.now,
        performance: {},
        graceDeadline: 30,
        processRequest: { monotonicShutdownDeadlineMs: 70 },
        containerPollMilliseconds: 10,
        currentProcessSet: () => (present ? [identity] : []),
        nativeShutdownDeadlineNs: 1000n,
        child: { pid: 99 },
        composition: { namespaceIdentity: "owned" },
        runtime: native,
        reapDiagnostic: {},
        reapAdoptedZombies: reap,
        processesDescendantsFirst: ordered,
        signals: [],
        signalExactProcess: () => {
          throw new Error("unexpected-live-process");
        },
        trustedErrorCode,
        readPtyReconciliationStage,
        pumpTransport: () => undefined,
        delay: () => {
          witness.now += 10;
          return Promise.resolve();
        },
        failAfterHandleSettlement: () => {
          throw kernelError(code, "reap-not-ready");
        },
      },
      { timeout: 1000 },
    ) as Promise<number>;
    return {
      result: await operation,
      deadlines: witness.deadlines,
      now: witness.now,
    };
  };
};

const reapFixture = (() => {
  const identity = { pid: 21, parentPid: 1, startIdentity: "21:1", state: "Z" };
  const source = readInternal("headless-supervisor-backend.ts");
  const start = source.indexOf("const exactAdoptedZombieReapReceipt = (");
  const end = source.indexOf("const productionContainerRuntime = (", start);
  const records = source.slice(
    source.indexOf("const ownData = ("),
    source.indexOf("const validScenario = ("),
  );
  const compiled = transpileModule(records + source.slice(start, end), {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const retainStart = source.indexOf(
    "    let authorityFailure: string | undefined;",
  );
  const retainEnd = source.indexOf(
    "    const currentProcessSet =",
    retainStart,
  );
  const retention = transpileModule(source.slice(retainStart, retainEnd), {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const { reap, ordered } = runInNewContext(
    `${compiled}\n({ reap: reapAdoptedZombies, ordered: processesDescendantsFirst });`,
    {
      safeReflectApply: Reflect.apply,
      objectKeys: Object.keys,
      getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      getPrototypeOf: Object.getPrototypeOf,
      objectPrototype: Object.prototype,
      isProxy: types.isProxy,
      fail,
      failObserverIdentity,
    },
    { timeout: 1000 },
  ) as {
    reap: ReapOperation;
    ordered: (
      processes: readonly ReapSnapshot[],
      root: number,
    ) => readonly ReapSnapshot[];
  };

  const observe = (
    receipt: unknown,
    after: typeof identity | undefined,
    thrown?: Error,
    polling = false,
  ) => {
    const diagnostic: { stage?: PtyReconciliationStage } = {};
    let reads = 0;
    const runtime = {
      assertNamespaceIdentity: () => undefined,
      readProcess: () => (reads++ === 0 ? identity : after),
      reapAdoptedZombie: () => {
        if (thrown !== undefined) throw thrown;
        return receipt;
      },
    };
    const error = caughtFailure(() => {
      reap(
        [identity],
        99,
        1000n,
        { namespaceIdentity: "owned", diagnostic, polling },
        runtime,
      );
    });
    const retained = runInNewContext(
      `${retention}\nretainAuthorityFailure(error, 'testkit.headless.observer.reap', stage); [authorityFailure, authorityFailureStage];`,
      {
        error,
        stage: diagnostic.stage,
        trustedErrorCode,
        readPtyReconciliationStage,
      },
      { timeout: 1000 },
    ) as [string | undefined, PtyReconciliationStage | undefined];
    return { error, diagnostic, reads, retained };
  };
  const poll = createPollingFixture({
    source,
    retention,
    reap,
    ordered,
    identity,
  });
  return { observe, poll, identity };
})();

const { observe, identity: reapIdentity } = reapFixture;
describe("same-budget production reap polling", () => {
  it.each(["reaped", "already-absent"] as const)(
    "polls exact not-ready until authenticated %s under the same cutoff",
    async (status) => {
      const result = await reapFixture.poll(status);
      expect(result.result).toBe(0);
      expect(result.deadlines).toEqual([1000n, 1000n]);
      expect(result.now).toBe(20);
    },
  );
  it("keeps permanent not-ready strict after the existing polling cutoff", async () => {
    const witness = { now: 0, deadlines: [] as bigint[] };
    const error = await rejection(reapFixture.poll(undefined, witness));
    expect(trustedErrorCode(error)).toBe(code);
    expect(readPtyReconciliationStage(error)).toBe("reap-not-ready");
    expect(witness.now).toBe(50);
    expect(witness.deadlines).toEqual(Array<bigint>(6).fill(1000n));
  });
  it("does not make a polling not-ready receipt a terminal success", () => {
    const receipt = { pid: 21, startIdentity: "21:1", status: "not-ready" };
    expect(
      observe(receipt, reapIdentity, undefined, true).error,
    ).toBeUndefined();
    expect(trustedErrorCode(observe(receipt, reapIdentity).error)).toBe(
      "testkit.headless.observer.reap",
    );
  });
});
describe("exact production reap refusal boundaries", () => {
  it.each([
    ["reap-receipt", { ...reapIdentity, status: "foreign" }, undefined],
    [
      "reap-not-ready",
      { pid: 21, startIdentity: "21:1", status: "not-ready" },
      undefined,
    ],
    [
      "reap-persisted",
      { pid: 21, startIdentity: "21:1", status: "reaped" },
      reapIdentity,
    ],
    [
      "reap-persisted",
      { pid: 21, startIdentity: "21:1", status: "already-absent" },
      reapIdentity,
    ],
  ] as const)("keeps the existing refusal at %s", (stage, receipt, after) => {
    const result = observe(receipt, after);
    expect(trustedErrorCode(result.error)).toBe(
      "testkit.headless.observer.reap",
    );
    expect(result.diagnostic.stage).toBe(stage);
    expect(result.retained).toEqual(["testkit.headless.observer.reap", stage]);
    expect(
      readPtyReconciliationStage(kernelError(code, result.retained[1])),
    ).toBe(stage);
  });

  it("keeps the exact native-call exception without reflecting it", () => {
    const original = new Error("synthetic");
    Object.defineProperty(original, "message", {
      get: () => {
        throw new Error("private");
      },
    });
    const result = observe(undefined, undefined, original);
    expect(result.error).toBe(original);
    expect(result.diagnostic.stage).toBe("reap-call");
    expect(result.retained).toEqual([
      "testkit.headless.observer.reap",
      "reap-call",
    ]);
    expect(result.reads).toBe(1);
  });

  it.each(["reaped", "already-absent"])(
    "does not classify successful %s",
    (status) => {
      const result = observe(
        { pid: 21, startIdentity: "21:1", status },
        undefined,
      );
      expect(result.error).toBeUndefined();
      expect(result.diagnostic.stage).toBeUndefined();
      expect(result.reads).toBe(2);
    },
  );

  it("refuses a proxy receipt without invoking its getters", () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("private");
        },
      },
    );
    const result = observe(hostile, undefined);
    expect(trustedErrorCode(result.error)).toBe(
      "testkit.headless.observer.reap",
    );
    expect(result.diagnostic.stage).toBe("reap-receipt");
  });

  it("keeps accessor receipt rejection under its original code", () => {
    const receipt = {
      pid: 21,
      startIdentity: "21:1",
      get status(): string {
        throw new Error("private");
      },
    };
    const result = observe(receipt, undefined);
    expect(trustedErrorCode(result.error)).toBe(
      "testkit.headless.kernel.request",
    );
    expect(result.retained).toEqual([
      "testkit.headless.kernel.request",
      undefined,
    ]);
  });

  it("preserves the genuine post-read identity refusal", () => {
    const result = observe(
      { pid: 21, startIdentity: "21:1", status: "reaped" },
      { ...reapIdentity, startIdentity: "21:2" },
    );
    expect(trustedErrorCode(result.error)).toBe(
      "testkit.headless.observer.identity",
    );
    expect(readPtyReconciliationStage(result.error)).toBe(
      "observer-zombie-after",
    );
    expect(result.diagnostic.stage).toBeUndefined();
    expect(result.retained).toEqual([
      "testkit.headless.observer.identity",
      "observer-zombie-after",
    ]);
  });

  it.each([
    "reap-call",
    "reap-receipt",
    "reap-not-ready",
    "reap-persisted",
  ] as const)("admits %s only in the existing deadline registry", (stage) => {
    expect(readPtyReconciliationStage(kernelError(code, stage))).toBe(stage);
    expect(
      readPtyReconciliationStage(
        kernelError("testkit.headless.kernel.request", stage),
      ),
    ).toBeUndefined();
  });
});

describe("exact production reap retention precedence", () => {
  const source = readInternal("headless-supervisor-backend.ts");
  const start = source.indexOf("    let authorityFailure: string | undefined;");
  const end = source.indexOf("    const currentProcessSet =", start);
  const compiled = transpileModule(source.slice(start, end), {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const retain = (error: unknown, stage?: string): readonly unknown[] =>
    runInNewContext(
      `${compiled}\nretainAuthorityFailure(error, 'testkit.headless.observer.reap', stage); [authorityFailure, authorityFailureStage];`,
      { error, stage, trustedErrorCode, readPtyReconciliationStage },
      { timeout: 1000 },
    ) as readonly unknown[];

  it.each(["observer-permission", "observer-zombie-after"] as const)(
    "keeps genuine %s ahead of reap context",
    (stage) => {
      const error = kernelError(
        stage === "observer-permission"
          ? "testkit.headless.observer.read"
          : "testkit.headless.observer.identity",
        stage,
      );
      expect(retain(error, "reap-call")).toEqual([
        trustedErrorCode(error),
        stage,
      ]);
    },
  );
  it("does not relabel genuine unrelated failure", () => {
    expect(
      retain(kernelError("testkit.headless.kernel.request"), "reap-receipt"),
    ).toEqual(["testkit.headless.kernel.request", undefined]);
  });
  it.each([
    undefined,
    null,
    "private",
    new Error("private"),
    new Proxy(
      {},
      {
        get: () => {
          throw new Error("private");
        },
      },
    ),
  ])("does not reflect foreign errors (%#)", (error) => {
    expect(retain(error, "reap-call")).toEqual([
      "testkit.headless.observer.reap",
      "reap-call",
    ]);
    expect(retain(error)).toEqual([
      "testkit.headless.observer.reap",
      undefined,
    ]);
  });
});

describe("authentic observer-code admission", () => {
  it.each([
    ["observer-esrch", true],
    ["observer-permission", true],
    ["observer-stat", true],
    ["observer-namespace", false],
    ["observer-root-reuse", false],
    ["observer-target-reuse", false],
    ["observer-zombie-before", false],
    ["observer-zombie-after", false],
  ] as const)("admits %s only with authentic codes", (stage, read) => {
    const authentic = read
      ? "testkit.headless.observer.read"
      : "testkit.headless.observer.identity";
    const other = read
      ? "testkit.headless.observer.identity"
      : "testkit.headless.observer.read";
    expect(readPtyReconciliationStage(kernelError(authentic, stage))).toBe(
      stage,
    );
    expect(
      readPtyReconciliationStage(kernelError(other, stage)),
    ).toBeUndefined();
    expect(
      readPtyReconciliationStage(
        kernelError(read ? "testkit.headless.kernel.failure" : code, stage),
      ),
    ).toBe(read ? undefined : stage);
  });
});

describe("exact production observer graph leaf", () => {
  it("keeps a mixed missing-parent snapshot rejected with its original code", () => {
    const source = readInternal("headless-supervisor-backend.ts");
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
    const error = caughtFailure(() =>
      order(
        [
          { pid: 21, parentPid: 22, startIdentity: "21:1", state: "R" },
          { pid: 23, parentPid: 1, startIdentity: "23:1", state: "R" },
        ],
        99,
      ),
    );
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
    ["adopted-zombie-reap-failure", "reap-call"],
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
    "reap-call",
    "reap-receipt",
    "reap-not-ready",
    "reap-persisted",
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
    const error = caughtFailure(() => {
      void boundedInvoke(
        () => {
          throw original;
        },
        performance.now() + 1000,
        code,
      );
    });
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
    for (const [suffix, stage] of [
      ["read", "observer-read"],
      ["identity", "observer-identity"],
      ["root", "observer"],
    ] as const)
      expect(
        ptyAuthorityFailureStage(`testkit.headless.observer.${suffix}`),
      ).toBe(stage);
    expect(
      readPtyReconciliationStage(
        kernelError("testkit.headless.kernel.failure", "observer"),
      ),
    ).toBeUndefined();
    for (const [errorCode, stage] of [
      ["testkit.headless.observer.reap", "reap"],
      ["testkit.headless.observer.signal", "signal"],
      ["private-unexpected-code", "authority"],
    ] as const)
      expect(ptyAuthorityFailureStage(errorCode)).toBe(stage);
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
      const publicRejection = (): Promise<unknown> =>
        rejection(
          executeSelectedPtyProcess(
            {} as HeadlessSupervisorCapability,
            request(),
          ),
        );
      for (const stage of [
        "observer",
        "observer-esrch",
        "observer-zombie-before",
        "outer-shutdown",
      ] as const) {
        backendError = kernelError(code, stage);
        const publicError = await publicRejection();
        expect(publicError).not.toBe(backendError);
        expect(trustedErrorCode(publicError)).toBe(code);
        expect(readPtyReconciliationStage(publicError)).toBe(stage);
      }
      backendError = new HeadlessSupervisorError(code);
      const publicError = await publicRejection();
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
