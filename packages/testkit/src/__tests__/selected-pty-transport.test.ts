import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";

import { ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

import { BoundedTerminalEmulator } from "../bounded-terminal-emulator.js";
import {
  kernelError,
  readPtySemanticFailure,
  readPtyExitSignal,
  readPtyReconciliationStage,
  trustedErrorCode,
} from "../internal/kernel-errors.js";
import { boundedInvoke } from "../internal/kernel-promise.js";
import type { HeadlessExecutionRequest } from "../headless-supervisor-contract.js";
import { executeSelectedPtyProcess } from "../headless-supervisor-kernel.js";
import type { HeadlessSupervisorCapability } from "../headless-supervisor.js";
import type { SelectedPtyExecutionRequest } from "../pty-terminal-contract.js";
import {
  classifyCheckpointTopologyForTest,
  executeSelectedPtyTransportForTest,
  validateSelectedContainerFilesystemFactsForTest,
  validateSelectedContainerPrincipalFactsForTest,
} from "../internal/headless-supervisor-backend.js";

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

type CheckpointFacade = {
  releaseFrozenProcessSet: (
    namespace: string,
    set: readonly object[],
    pid: number,
    notify: boolean,
  ) => void;
};
type CheckpointProduction = {
  create: (authority: object, deadline: number) => CheckpointFacade;
  publish: (
    runtime: CheckpointFacade,
    request: object,
    root: object,
    set: readonly object[],
  ) => void;
};

describe("actual production checkpoint resume composition", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    "resumes without an undeclared root signal (protected callback=%s, substituted identity=%s)",
    (protectedCallback, substitutedIdentity) => {
      const source = readFileSync(
        new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
        "utf8",
      );
      const releaseStart = source.indexOf(
        "const releaseFrozenContainerProcessSet =",
      );
      const releaseEnd = source.indexOf("const delay =", releaseStart);
      const facadeStart = source.indexOf("const productionPtyRuntime =");
      const facadeEnd = source.indexOf(
        "/* eslint-enable max-lines-per-function */",
        facadeStart,
      );
      const publishStart = source.indexOf(
        "const publishTopologyCheckpointIfSelected =",
      );
      const publishEnd = source.indexOf("const armSelectedPty =", publishStart);
      for (const [start, end] of [
        [releaseStart, releaseEnd],
        [facadeStart, facadeEnd],
        [publishStart, publishEnd],
      ] as const) {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
      }
      const root = { pid: 2, parentPid: 1, startIdentity: "2:10", state: "T" },
        child = { pid: 3, parentPid: 2, startIdentity: "3:11", state: "T" };
      const processes = Object.freeze([root, child]);
      const signals: { pid: number; signal: string }[] = [],
        publications: unknown[][] = [];
      const compiled = transpileModule(
        `${source.slice(releaseStart, releaseEnd)}\n${source.slice(facadeStart, facadeEnd)}\n${source.slice(publishStart, publishEnd)}\n({ create: productionPtyRuntime, publish: publishTopologyCheckpointIfSelected });`,
        { compilerOptions: { target: ScriptTarget.ES2022 } },
      ).outputText;
      const production = runInNewContext(compiled, {
        assertNamespaceIdentity: (namespace: string) => {
          expect(namespace).toBe("held-namespace");
        },
        readProcessSnapshot: (pid: number) => {
          const entry = processes.find((value) => value.pid === pid);
          return substitutedIdentity && entry
            ? { ...entry, startIdentity: "substituted" }
            : entry;
        },
        process: {
          kill: (pid: number, signal: string) => signals.push({ pid, signal }),
        },
        fail: (code: string) => {
          throw new Error(code);
        },
      }) as CheckpointProduction;
      const authority = {
        assertFile: () => undefined,
        assertRuntime: () => undefined,
        ...(protectedCallback
          ? {
              publishTopologyCheckpoint: (...args: unknown[]) =>
                publications.push(args),
            }
          : {}),
      };
      const runtime = production.create(authority, 1000);
      if (substitutedIdentity) {
        expect(() => {
          runtime.releaseFrozenProcessSet(
            "held-namespace",
            processes,
            root.pid,
            true,
          );
        }).toThrow("testkit.headless.observer.identity");
        expect(signals).toEqual([]);
        expect(publications).toEqual([]);
        return;
      }
      runtime.releaseFrozenProcessSet(
        "held-namespace",
        processes,
        root.pid,
        true,
      );
      production.publish(
        runtime,
        { readiness: { challenge: "a".repeat(64) } },
        root,
        processes,
      );
      expect(publications).toEqual(
        protectedCallback ? [["a".repeat(64), root, processes]] : [],
      );
      expect(signals).toEqual([
        { pid: child.pid, signal: "SIGCONT" },
        { pid: root.pid, signal: "SIGCONT" },
      ]);
      if (protectedCallback) {
        expect(() => {
          production.publish(runtime, { readiness: {} }, root, processes);
        }).toThrow("testkit.pty.checkpoint-witness");
        expect(publications).toHaveLength(1);
      }
    },
  );
});

const compiledManifestRequest = (
  scenarioId: "codex-tui-trace-smoke" | "claude-interactive-trace-smoke",
): SelectedPtyExecutionRequest => {
  const integration = new URL(
    "../../../../tests/integration/",
    import.meta.url,
  );
  const compilerSource = readFileSync(
    new URL("src/interactive-pty-actions.ts", integration),
    "utf8",
  );
  const canonicalSource = readFileSync(
    new URL("src/canonical.ts", integration),
    "utf8",
  );
  const compilerStart = compilerSource.indexOf("const claudeChallenge =");
  const freezeStart = canonicalSource.indexOf("export const deepFreeze =");
  expect(compilerStart).toBeGreaterThan(0);
  expect(freezeStart).toBeGreaterThan(0);
  const code = transpileModule(
    `${canonicalSource.slice(freezeStart).replace("export const", "const")}\n${compilerSource.slice(compilerStart).replace("export const", "const")}`,
    { compilerOptions: { target: ScriptTarget.ES2022 } },
  ).outputText;
  const compile = runInNewContext(
    `${code}\ncompileInteractivePtyActions;`,
    { Buffer, createHash },
    { timeout: 1_000 },
  ) as (
    scenario: object,
    input: Uint8Array,
  ) => SelectedPtyExecutionRequest["interaction"]["actions"];
  const manifest = JSON.parse(
    readFileSync(new URL("capability-manifest.json", integration), "utf8"),
  ) as {
    scenarios: { scenarioId: string; terminalInputBase64: string }[];
  };
  const scenario = manifest.scenarios.find(
    (entry) => entry.scenarioId === scenarioId,
  );
  if (scenario === undefined) throw new Error("test.compiler.scenario");
  const challenge = "a".repeat(64);
  const stdin = new Uint8Array(
    Buffer.concat([
      Buffer.from(`${challenge}\n`),
      Buffer.from(scenario.terminalInputBase64, "base64"),
    ]),
  );
  const now = performance.now();
  const styledReadiness = protocolPromptRequest().readiness;
  if (styledReadiness.kind !== "challenge-styled-text")
    throw new Error("test.compiler.readiness");
  return {
    ...request({
      stdin,
      monotonicStartupDeadlineMs: now + 5_000,
      monotonicExecutionDeadlineMs: now + 10_000,
      monotonicShutdownDeadlineMs: now + 15_000,
    }),
    readiness:
      scenarioId === "claude-interactive-trace-smoke"
        ? { kind: "challenge-marker", challenge }
        : {
            ...styledReadiness,
            postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
          },
    interaction: {
      trigger: "immediate",
      // Move the genuine compiler output back to this realm; the production
      // snapshot requires its ordinary host array, not a VM prototype.
      actions: structuredClone(compile(scenario, stdin)),
    },
  };
};

const actualImmutablePrincipalProfile = (
  scenarioId: string,
  poisonIncludes = false,
): "ordinary" | "codex-controller" => {
  const source = readFileSync(
    new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
    "utf8",
  );
  const authorityStart = source.indexOf(
    "const createImmutableCandidateAuthority =",
  );
  const start = source.indexOf("  const profile =", authorityStart);
  const end = source.indexOf("  const initial =", start);
  expect(authorityStart).toBeGreaterThan(0);
  expect(start).toBeGreaterThan(authorityStart);
  expect(end).toBeGreaterThan(start);
  const profile: unknown = runInNewContext(
    `${poisonIncludes ? "Array.prototype.includes = () => true;" : ""}${source.slice(start, end)}; profile`,
    {
      record: { scenarioId },
    },
  );
  if (profile !== "ordinary" && profile !== "codex-controller")
    throw new Error("test.profile.invalid");
  return profile;
};

it("classifies only exact frozen checkpoint topology facts", () => {
  const root = { pid: 21, parentPid: 1, startIdentity: "21:1", state: "T" };
  const descendant = {
    pid: 22,
    parentPid: 21,
    startIdentity: "22:1",
    state: "T",
  };
  expect(classifyCheckpointTopologyForTest([root, descendant], root)).toBe(
    "matched",
  );
  expect(classifyCheckpointTopologyForTest([descendant], root)).toBe(
    "root-missing",
  );
  expect(classifyCheckpointTopologyForTest([root], root)).toBe(
    "nonroot-missing",
  );
  expect(
    classifyCheckpointTopologyForTest(
      [root, { ...descendant, startIdentity: root.startIdentity }],
      root,
    ),
  ).toBe("identity-conflict");
  expect(
    classifyCheckpointTopologyForTest(
      [{ ...root, state: "Z" }, descendant],
      root,
    ),
  ).toBe("root-missing");
});
// eslint-disable-next-line @typescript-eslint/unbound-method -- hostile-prototype test invokes this exact method with Reflect.apply
const originalTerminalSnapshot = BoundedTerminalEmulator.prototype.snapshot;
const request = (
  overrides: Partial<HeadlessExecutionRequest> = {},
): SelectedPtyExecutionRequest => {
  const now = performance.now();
  return {
    completion: { kind: "semantic-marker" },
    readiness: { kind: "semantic-marker" },
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
describe("fixed extended-CSI selected transport refusals", () => {
  const executeWithControl = async (sequence: string) => {
    vi.resetModules();
    const { BoundedTerminalEmulator: Terminal } =
      await import("../bounded-terminal-emulator.js");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoke captured method with its exact emulator receiver
    const write = Terminal.prototype.write;
    let inserted = false;
    const spy = vi
      .spyOn(Terminal.prototype, "write")
      .mockImplementation(function (this: BoundedTerminalEmulator, chunk) {
        if (!inserted) {
          inserted = true;
          Reflect.apply(write, this, [new TextEncoder().encode(sequence)]);
        }
        Reflect.apply(write, this, [chunk]);
      });
    try {
      const { executeSelectedPtyTransportForTest: execute } =
        await import("../internal/headless-supervisor-backend.js");
      return await execute(request(), "clean");
    } finally {
      expect(inserted).toBe(true);
      spy.mockRestore();
    }
  };
  it.each([
    1, 2, 3, 4, 5, 6, 8, 9, 10, 13, 14, 18, 19, 30, 35, 38, 40, 41, 42, 43, 44,
    45, 46, 47, 66, 67, 69, 80, 95, 1000, 1001, 1002, 1003, 1005, 1006, 1010,
    1011, 1014, 1015, 1016, 1020, 1021, 1022, 1023, 1034, 1035, 1036, 1037,
    1039, 1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1050, 1051,
    1052, 1053, 1060, 1061, 2001, 2002, 2003, 2005, 2006,
  ])(
    "retains documented rejected mode %s through actual selected transport",
    async (mode) => {
      for (const final of ["h", "l"])
        await expect(
          executeWithControl(`\u001b[?${mode}${final}`),
        ).rejects.toMatchObject({
          code: `testkit.pty.transport.semantic-unsupported-extended-csi-private-mode-${mode}`,
        });
    },
  );
  it.each([
    ["\u001b[>c", "secondary-device-attributes"],
    ["\u001b[=c", "tertiary-device-attributes"],
    ["\u001b[>q", "xterm-version"],
    ["\u001b[?4g", "key-modifier-query"],
    ["\u001b[1 p", "intermediate"],
    ["\u001b[>32u", "keyboard-shape"],
    ["\u001b[>4;1m", "modifier-shape"],
    ["\u001b[?9999h", "private-mode-unlisted"],
    ["\u001b[<3p", "residual-shape"],
  ])(
    "retains fixed refused family %j through actual selected transport",
    async (sequence, reason) => {
      await expect(executeWithControl(sequence)).rejects.toMatchObject({
        code: `testkit.pty.transport.semantic-unsupported-extended-csi-${reason}`,
      });
    },
  );
  it("preserves earlier malformed priority and residual refusal", async () => {
    await expect(
      executeWithControl("\u0000\u001b[?1000h"),
    ).rejects.toMatchObject({
      code: "testkit.pty.transport.semantic-malformed-ground-control-0",
    });
    await expect(executeWithControl("\u001b[>1c")).rejects.toMatchObject({
      code: "testkit.pty.transport.semantic-unsupported-extended-csi-residual-shape",
    });
  });
});
describe("fixed ground-control selected transport refusals", () => {
  const executeWithControl = async (point: number) => {
    vi.resetModules();
    const { BoundedTerminalEmulator: Terminal } =
      await import("../bounded-terminal-emulator.js");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoke the captured method with its exact emulator receiver
    const write = Terminal.prototype.write;
    let inserted = false;
    const spy = vi
      .spyOn(Terminal.prototype, "write")
      .mockImplementation(function (this: BoundedTerminalEmulator, chunk) {
        if (!inserted) {
          inserted = true;
          Reflect.apply(write, this, [new Uint8Array([point])]);
        }
        Reflect.apply(write, this, [chunk]);
      });
    try {
      const { executeSelectedPtyTransportForTest: execute } =
        await import("../internal/headless-supervisor-backend.js");
      return await execute(request(), "clean");
    } finally {
      expect(inserted).toBe(true);
      spy.mockRestore();
    }
  };
  it("completes the actual selected transport after documented SI to default ASCII G0", async () => {
    await expect(executeWithControl(15)).resolves.toMatchObject({
      outcome: "completed",
      terminalInputJoined: true,
      terminalOutputJoined: true,
    });
  });
  it.each([
    0, 1, 2, 3, 4, 5, 6, 11, 12, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28,
    29, 30, 31, 127,
  ])(
    "preserves rejected control %s from the real emulator through selected transport",
    async (point) => {
      await expect(executeWithControl(point)).rejects.toMatchObject({
        code: `testkit.pty.transport.semantic-malformed-ground-control-${point}`,
      });
    },
  );
});
describe("private terminal semantic refusal facts", () => {
  it("retains final state/input facts from the actual synthetic backend", async () => {
    const selected = request({ stdin: new Uint8Array() });
    try {
      await executeSelectedPtyTransportForTest(
        {
          ...selected,
          interaction: {
            trigger: "semantic-ready",
            actions: [{ action: "wait-for-semantic-completion" }],
          },
        },
        "missing-completion",
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: "testkit.pty.transport.semantic-incomplete",
      });
      expect(readPtySemanticFailure(error)).toEqual({
        finalSemanticState: "ready",
        inputJoined: false,
        readinessObserved: true,
        allInputBytesWritten: true,
      });
      return;
    }
    throw new Error("expected refusal");
  });
  it.each(["sync", "async"])(
    "preserves private facts through the existing %s promise remint",
    async (kind) => {
      const facts = {
        finalSemanticState: "active" as const,
        inputJoined: false,
        readinessObserved: false,
        allInputBytesWritten: false,
      };
      const original = kernelError(
        "testkit.pty.transport.semantic-incomplete",
        undefined,
        facts,
      );
      const work =
        kind === "sync"
          ? () => {
              throw original;
            }
          : () => Promise.reject(original);
      try {
        await boundedInvoke(
          work,
          performance.now() + 1000,
          "testkit.headless.shutdown.deadline",
        );
      } catch (error) {
        expect(trustedErrorCode(error)).toBe(original.code);
        expect(readPtySemanticFailure(error)).toEqual(facts);
        return;
      }
      throw new Error("expected refusal");
    },
  );
  it.each([false, true])(
    "preserves private facts through the actual production wrapper catch (exit=%s)",
    async (exit) => {
      const facts = {
        finalSemanticState: "ready" as const,
        inputJoined: true,
        readinessObserved: true,
        allInputBytesWritten: false,
      };
      const original = kernelError(
        exit
          ? "testkit.pty.transport.exit"
          : "testkit.pty.transport.semantic-incomplete",
        undefined,
        facts,
        exit ? 1 : undefined,
      );
      const source = readFileSync(
        new URL("../headless-supervisor-kernel.ts", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("export const executeSelectedPtyProcess =");
      expect(start).toBeGreaterThan(0);
      const compiled = transpileModule(
        `${source.slice(start + 7)}; executeSelectedPtyProcess`,
        { compilerOptions: { target: ScriptTarget.ES2022 } },
      ).outputText;
      const execute = runInNewContext(compiled, {
        executeSelectedPtyProcessWithCapability: () => Promise.reject(original),
        kernelError,
        readHeadlessSupervisorKernelErrorCode: trustedErrorCode,
        readPtyReconciliationStage,
        readPtySemanticFailure,
        readPtyExitSignal,
      }) as (...args: unknown[]) => Promise<unknown>;
      try {
        await execute({}, {}, {});
      } catch (error) {
        expect(trustedErrorCode(error)).toBe(original.code);
        expect(readPtySemanticFailure(error)).toEqual(exit ? undefined : facts);
        expect(readPtyExitSignal(error)).toBe(exit ? 1 : undefined);
        return;
      }
      throw new Error("expected refusal");
    },
  );
});
describe("private signal guard is fixed at module initialization", () => {
  it.each([
    ["sync", false],
    ["async", false],
    ["sync", true],
    ["async", true],
  ] as const)(
    "preserves authentic %s settlement under post-import Number substitution (permissive=%s)",
    async (kind, permissive) => {
      const original = kernelError(
        "testkit.pty.transport.exit",
        undefined,
        undefined,
        1,
      );
      const guard = Number.isSafeInteger;
      Number.isSafeInteger = permissive
        ? () => true
        : () => {
            throw new Error("PRIVATE");
          };
      try {
        expect(
          readPtyExitSignal(
            kernelError(original.code, undefined, undefined, 1.5),
          ),
        ).toBeUndefined();
        const work =
          kind === "sync"
            ? () => {
                throw original;
              }
            : () => Promise.reject(original);
        const deadline = performance.now() + 1000;
        const error: unknown = await Promise.resolve()
          .then(() =>
            boundedInvoke(work, deadline, "testkit.headless.shutdown.deadline"),
          )
          .catch((failure: unknown) => failure);
        expect(performance.now()).toBeLessThan(deadline);
        expect(trustedErrorCode(error)).toBe(original.code);
        expect(readPtyExitSignal(error)).toBe(1);
      } finally {
        Number.isSafeInteger = guard;
      }
    },
  );
});
describe("private unsupported exit signal facts", () => {
  it("preserves the unsupported signal in the existing backend launch catch", () => {
    const original = kernelError(
      "testkit.pty.transport.exit",
      undefined,
      undefined,
      1,
    );
    const source = readFileSync(
      new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
      "utf8",
    );
    const entry = source.indexOf(
      "export const executeSelectedPtyProcessWithCapability =",
    );
    const start = source.indexOf("} catch (error: unknown) {", entry);
    const end = source.indexOf(
      "\n    }\n    assertPtyReceiptBinding(receipt",
      start,
    );
    expect(entry).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(entry);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start + "} catch (error: unknown) {".length, end);
    const reject = runInNewContext(`() => { ${body} }`, {
      error: original,
      trustedErrorCode,
      readPtyReconciliationStage,
      readPtySemanticFailure,
      readPtyExitSignal,
      remaining: () => 1,
      stableRequest: { process: { monotonicShutdownDeadlineMs: 1 } },
      fail: (...args: Parameters<typeof kernelError>) => {
        throw kernelError(...args);
      },
    }) as () => unknown;
    try {
      reject();
    } catch (error) {
      expect(trustedErrorCode(error)).toBe(original.code);
      expect(readPtyExitSignal(error)).toBe(1);
      return;
    }
    throw new Error("expected refusal");
  });
  it("retains only genuine unsupported exit signals", () => {
    const code = "testkit.pty.transport.exit";
    for (const signal of [1, 3, 64])
      expect(
        readPtyExitSignal(kernelError(code, undefined, undefined, signal)),
      ).toBe(signal);
    let traps = 0;
    const forged = Object.defineProperty(new Error(code), "exitSignal", {
      get() {
        traps++;
        throw new Error("PRIVATE");
      },
    });
    const proxy = new Proxy(kernelError(code, undefined, undefined, 1), {
      get() {
        traps++;
        throw new Error("PRIVATE");
      },
    });
    for (const value of [
      forged,
      proxy,
      Object.assign(new Error(code), { exitSignal: 1 }),
    ])
      expect(readPtyExitSignal(value)).toBeUndefined();
    for (const signal of [0, 2, 9, 15, -1, 65, 1.5, NaN])
      expect(
        readPtyExitSignal(kernelError(code, undefined, undefined, signal)),
      ).toBeUndefined();
    expect(
      readPtyExitSignal(
        kernelError("testkit.pty.request", undefined, undefined, 1),
      ),
    ).toBeUndefined();
    expect(traps).toBe(0);
  });
  it.each(["sync", "async"])(
    "preserves the unsupported signal through the %s promise remint",
    async (kind) => {
      const original = kernelError(
        "testkit.pty.transport.exit",
        undefined,
        undefined,
        1,
      );
      const work =
        kind === "sync"
          ? () => {
              throw original;
            }
          : () => Promise.reject(original);
      const error: unknown = await Promise.resolve()
        .then(() =>
          boundedInvoke(
            work,
            performance.now() + 1000,
            "testkit.headless.shutdown.deadline",
          ),
        )
        .catch((failure: unknown) => failure);
      expect(trustedErrorCode(error)).toBe(original.code);
      expect(readPtyExitSignal(error)).toBe(1);
    },
  );
});
describe("private terminal facts reject substituted metadata", () => {
  it("snapshots only exact scalar data and ignores forged error fields", () => {
    const facts = {
      finalSemanticState: "ready" as const,
      inputJoined: true,
      readinessObserved: true,
      allInputBytesWritten: true,
    };
    const genuine = kernelError(
      "testkit.pty.transport.semantic-incomplete",
      undefined,
      facts,
    );
    facts.inputJoined = false;
    expect(readPtySemanticFailure(genuine)?.inputJoined).toBe(true);
    expect(Object.isFrozen(readPtySemanticFailure(genuine))).toBe(true);
    let traps = 0;
    const accessor = Object.defineProperty({ ...facts }, "inputJoined", {
      get() {
        traps++;
        throw new Error("PRIVATE");
      },
    });
    const proxy = new Proxy(facts, {
      ownKeys() {
        traps++;
        throw new Error("PRIVATE");
      },
    });
    for (const candidate of [
      accessor,
      proxy,
      { ...facts, extra: true },
      { ...facts, finalSemanticState: "completed" },
      { ...facts, inputJoined: 1 },
      { ...facts, readinessObserved: 1 },
      { ...facts, allInputBytesWritten: 1 },
      null,
    ]) {
      const error: unknown = Reflect.apply(kernelError, undefined, [
        "testkit.pty.transport.semantic-incomplete",
        undefined,
        candidate,
      ]);
      expect(trustedErrorCode(error)).toBe(
        "testkit.pty.transport.semantic-incomplete",
      );
      expect(readPtySemanticFailure(error)).toBeUndefined();
    }
    expect(
      readPtySemanticFailure(
        Object.assign(new Error(genuine.message), { semanticFailure: facts }),
      ),
    ).toBeUndefined();
    expect(
      readPtySemanticFailure(
        new Proxy(genuine, {
          get() {
            traps++;
            throw new Error("PRIVATE");
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      readPtySemanticFailure(
        kernelError("testkit.pty.request", undefined, facts),
      ),
    ).toBeUndefined();
    expect(traps).toBe(0);
  });
});

const protocolPromptRequest = (): SelectedPtyExecutionRequest => {
  const challenge = "a".repeat(64);
  const challengeInput = new TextEncoder().encode(`${challenge}\n`);
  const prompt = new TextEncoder().encode(
    "\u001b[200~Reply with one short confirmation and do not use tools.\u001b[201~",
  );
  const enter = new TextEncoder().encode("\u001b[13u");
  const stdin = new Uint8Array(
    Buffer.concat([challengeInput, prompt, enter, Buffer.from([4])]),
  );
  const inputAction = (bytes: Uint8Array) => ({
    action: "input" as const,
    byteLength: bytes.length,
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return {
    ...request({ stdin }),
    readiness: {
      kind: "challenge-styled-text",
      challenge,
      text: "›",
      requiredText: "Ask Codex to do anything",
      requiredTerminalProtocol: "csi-u-flags-7-query-v1",
      bold: true,
      dim: false,
    },
    interaction: {
      trigger: "immediate",
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        inputAction(challengeInput),
        {
          action: "checkpoint-process-topology",
          topology: "root-with-contained-process-set",
        },
        inputAction(prompt),
        inputAction(enter),
        { action: "wait-for-semantic-completion" },
        inputAction(stdin.subarray(stdin.length - 1)),
      ],
    },
  };
};

const postSubmissionRequest = (
  selected: SelectedPtyExecutionRequest = protocolPromptRequest(),
): SelectedPtyExecutionRequest => {
  const now = performance.now();
  return {
    ...selected,
    readiness: {
      ...selected.readiness,
      postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${"a".repeat(64)}`,
    } as SelectedPtyExecutionRequest["readiness"],
    process: {
      ...selected.process,
      monotonicStartupDeadlineMs: now + 5_000,
      monotonicExecutionDeadlineMs: now + 10_000,
      monotonicShutdownDeadlineMs: now + 15_000,
    },
    interaction: {
      ...selected.interaction,
      actions: [
        ...selected.interaction.actions.slice(0, -1),
        { action: "wait-for-post-submission-idle-prompt" },
        selected.interaction.actions.at(-1)!,
      ],
    },
  };
};

const boundedNegativePostSubmissionRequest =
  (): SelectedPtyExecutionRequest => {
    const selected = postSubmissionRequest();
    const now = performance.now();
    return {
      ...selected,
      process: {
        ...selected.process,
        monotonicStartupDeadlineMs: now + 1_000,
        monotonicExecutionDeadlineMs: now + 3_000,
        monotonicShutdownDeadlineMs: now + 5_000,
      },
    };
  };

// eslint-disable-next-line max-lines-per-function
describe("selected PTY transport", () => {
  it("completes the genuine Claude compiler plan through a submitted challenge title", async () => {
    const selected = compiledManifestRequest("claude-interactive-trace-smoke");
    const now = performance.now();
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...selected,
        process: {
          ...selected.process,
          monotonicStartupDeadlineMs: now + 500,
          monotonicExecutionDeadlineMs: now + 1_000,
          monotonicShutdownDeadlineMs: now + 2_000,
        },
      },
      "challenge-marker-title",
    );
    expect(receipt).toMatchObject({
      outcome: "completed",
      cleanup: "clean",
      readinessObserved: true,
      finalSnapshot: { semanticState: "completed" },
    });
    expect(receipt.actions.map(({ action }) => action)).toEqual(
      selected.interaction.actions.map(({ action }) => action),
    );
    expect(receipt.inputBytesWritten).toBe(selected.process.stdin.length);
  });

  it.each(["codex-tui-trace-smoke", "claude-interactive-trace-smoke"] as const)(
    "snapshots the genuine %s compiler request before cancellation",
    async (scenarioId) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        executeSelectedPtyTransportForTest(
          compiledManifestRequest(scenarioId),
          "clean",
          { signal: controller.signal },
        ),
      ).rejects.toThrow("testkit.headless.aborted");
    },
  );

  it.each([
    ["claude-interactive-trace-smoke", "newline", Buffer.from("\n")],
    ["claude-interactive-trace-smoke", "arbitrary byte", Buffer.from("x")],
    ["claude-interactive-trace-smoke", "empty", Buffer.from([])],
    ["claude-interactive-trace-smoke", "two CR bytes", Buffer.from("\r\r")],
    [
      "claude-interactive-trace-smoke",
      "malformed CSI-u",
      Buffer.from("\x1b[13~"),
    ],
    ["codex-tui-trace-smoke", "CR instead of CSI-u", Buffer.from("\r")],
    ["codex-tui-trace-smoke", "malformed CSI-u", Buffer.from("\x1b[13~")],
  ] as const)(
    "rejects %s compiler submission replaced with %s",
    async (scenarioId, _label, submission) => {
      const selected = compiledManifestRequest(scenarioId);
      const promptAction = selected.interaction.actions[3];
      const submitAction = selected.interaction.actions[4];
      if (promptAction?.action !== "input" || submitAction?.action !== "input")
        throw new Error("test.compiler.actions");
      const start = 65 + promptAction.byteLength;
      const stdin = new Uint8Array(
        Buffer.concat([
          Buffer.from(selected.process.stdin.subarray(0, start)),
          submission,
          Buffer.from(
            selected.process.stdin.subarray(start + submitAction.byteLength),
          ),
        ]),
      );
      const controller = new AbortController();
      controller.abort();
      await expect(
        executeSelectedPtyTransportForTest(
          {
            ...selected,
            process: { ...selected.process, stdin },
            interaction: {
              ...selected.interaction,
              actions: selected.interaction.actions.map((action, index) =>
                index === 4
                  ? {
                      action: "input" as const,
                      byteLength: submission.length,
                      inputSha256: createHash("sha256")
                        .update(submission)
                        .digest("hex"),
                    }
                  : action,
              ),
            },
          },
          "clean",
          { signal: controller.signal },
        ),
      ).rejects.toThrow("testkit.pty.request");
    },
  );

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

  it("retains the unsupported signal without admitting a completion receipt", async () => {
    const error: unknown = await executeSelectedPtyTransportForTest(
      request(),
      "unsupported-signal",
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "testkit.pty.transport.exit" });
    expect(readPtyExitSignal(error)).toBe(1);
  });
  const controllerPrincipalFacts = () => {
    const ordinary = principalFacts();
    return {
      ...ordinary,
      profile: "codex-controller" as const,
      uid: 0,
      euid: 0,
      gid: 0,
      egid: 0,
      groups: [0],
      status: ordinary.status
        .replaceAll("1000", "0")
        .replaceAll("CapEff:\t0000000000000000", "CapEff:\t00000000000000e3")
        .replaceAll("CapPrm:\t0000000000000000", "CapPrm:\t00000000000000e3")
        .replaceAll("CapBnd:\t0000000000000000", "CapBnd:\t00000000000000e3"),
    };
  };

  // eslint-disable-next-line max-lines-per-function -- one challenge-gated checkpoint lifecycle
  it("rejects a fixed readiness marker before the per-run challenge", async () => {
    const challenge = "a".repeat(64);
    const challengeInput = new TextEncoder().encode(`${challenge}\n\u0004`);
    const now = performance.now();
    const challengeRequest: SelectedPtyExecutionRequest = {
      ...request({
        stdin: challengeInput,
        monotonicStartupDeadlineMs: now + 500,
        monotonicExecutionDeadlineMs: now + 1_000,
        monotonicShutdownDeadlineMs: now + 2_000,
      }),
      readiness: { kind: "challenge-marker", challenge },
      interaction: {
        trigger: "immediate",
        actions: [
          {
            action: "input",
            byteLength: 65,
            inputSha256: createHash("sha256")
              .update(challengeInput.subarray(0, 65))
              .digest("hex"),
          },
          {
            action: "checkpoint-process-topology",
            topology: "root-with-contained-process-set",
          },
          { action: "wait-for-semantic-completion" },
          {
            action: "input",
            byteLength: 1,
            inputSha256: createHash("sha256")
              .update(challengeInput.subarray(65))
              .digest("hex"),
          },
        ],
      },
    };
    const prompt = new TextEncoder().encode(
      "\u001b[200~Reply with one short confirmation and do not use tools.\u001b[201~",
    );
    const enter = new TextEncoder().encode("\u001b[13u");
    const promptInput = new Uint8Array(
      Buffer.concat([
        Buffer.from(challengeInput.subarray(0, 65)),
        Buffer.from(prompt),
        Buffer.from(enter),
        Buffer.from([4]),
      ]),
    );
    const promptAction = {
      action: "input" as const,
      byteLength: prompt.length,
      inputSha256: createHash("sha256").update(prompt).digest("hex"),
    };
    const enterAction = {
      action: "input" as const,
      byteLength: enter.length,
      inputSha256: createHash("sha256").update(enter).digest("hex"),
    };
    const promptRequest: SelectedPtyExecutionRequest = {
      ...challengeRequest,
      process: { ...challengeRequest.process, stdin: promptInput },
      readiness: {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "Ask Codex to do anything",
        requiredTerminalProtocol: "csi-u-flags-7-query-v1",
        bold: true,
        dim: false,
      },
      interaction: {
        trigger: "immediate",
        actions: [
          { action: "resize", geometry: { columns: 100, rows: 30 } },
          challengeRequest.interaction.actions[0]!,
          challengeRequest.interaction.actions[1]!,
          promptAction,
          enterAction,
          { action: "wait-for-semantic-completion" },
          {
            action: "input",
            byteLength: 1,
            inputSha256: createHash("sha256")
              .update(promptInput.subarray(promptInput.length - 1))
              .digest("hex"),
          },
        ],
      },
    };
    const executeChallengeCase = (
      selected: SelectedPtyExecutionRequest,
      seed: Parameters<typeof executeSelectedPtyTransportForTest>[1],
    ) => {
      const caseNow = performance.now();
      return executeSelectedPtyTransportForTest(
        {
          ...selected,
          process: {
            ...selected.process,
            monotonicStartupDeadlineMs: caseNow + 5_000,
            monotonicExecutionDeadlineMs: caseNow + 10_000,
            monotonicShutdownDeadlineMs: caseNow + 15_000,
          },
        },
        seed,
      );
    };

    await expect(
      executeChallengeCase(promptRequest, "clean"),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "input", byteLength: prompt.length },
        { action: "input", byteLength: enter.length },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: promptInput.length,
      outcome: "completed",
      readinessObserved: true,
      checkpointProgressDiagnostic: "advanced",
      challengedReadinessProgress: {
        marker: true,
        synchronizedFrame: true,
        styledGlyph: true,
        requiredText: true,
        terminalProtocol: "complete",
        protocolRejectionKind: "none",
        protocolRejectedAtPhase: null,
        protocolRejectedStep: null,
        protocolRejectedModePrefix: null,
        protocolRejectedModeValue: null,
        readinessEverObserved: true,
        screenRevoked: false,
      },
    });
    const markerPromptRequest: SelectedPtyExecutionRequest = {
      ...promptRequest,
      readiness: { kind: "challenge-marker", challenge },
    };
    await expect(
      executeChallengeCase(markerPromptRequest, "challenge-marker-prompt"),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "input", byteLength: prompt.length },
        { action: "input", byteLength: enter.length },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: promptInput.length,
      outcome: "completed",
      readinessObserved: true,
    });
    const topologyPromptRequest: SelectedPtyExecutionRequest = {
      ...promptRequest,
      readiness: { kind: "challenge-process-topology", challenge },
    };
    await expect(
      executeChallengeCase(topologyPromptRequest, "challenge-marker-prompt"),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "input", byteLength: prompt.length },
        { action: "input", byteLength: enter.length },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: promptInput.length,
      outcome: "completed",
      readinessObserved: true,
    });
    const fragmentedTopologyReceipt = await executeChallengeCase(
      topologyPromptRequest,
      "fragmented-output",
    );
    expect(
      fragmentedTopologyReceipt.actions.map(({ action }) => action),
    ).toContain("checkpoint-process-topology");
    expect(fragmentedTopologyReceipt.readinessObserved).toBe(true);
    await expect(
      executeChallengeCase(topologyPromptRequest, "fixed-readiness-spoof"),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        { action: "input", byteLength: 65 },
      ],
      inputBytesWritten: 65,
      outcome: "input-incomplete",
      readinessObserved: false,
    });
    await expect(
      executeChallengeCase(topologyPromptRequest, "checkpoint-missing-process"),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        { action: "input", byteLength: 65 },
      ],
      inputBytesWritten: 65,
      outcome: "input-incomplete",
      readinessObserved: false,
    });
    await expect(
      executeChallengeCase(promptRequest, "readiness-revoked-after-input"),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "input", byteLength: prompt.length },
        { action: "input", byteLength: enter.length },
        { action: "wait-for-semantic-completion" },
      ],
      inputBytesWritten: 65 + prompt.length + enter.length,
      outcome: "input-incomplete",
      readinessObserved: false,
    });
    const resizeRevocationRequest: SelectedPtyExecutionRequest = {
      ...promptRequest,
      interaction: {
        ...promptRequest.interaction,
        actions: [
          ...promptRequest.interaction.actions.slice(0, 6),
          { action: "resize", geometry: { columns: 10, rows: 30 } },
          promptRequest.interaction.actions[6]!,
        ],
      },
    };
    await expect(
      executeChallengeCase(resizeRevocationRequest, "clean"),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize", geometry: { columns: 100, rows: 30 } },
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "input", byteLength: prompt.length },
        { action: "input", byteLength: enter.length },
        { action: "wait-for-semantic-completion" },
        { action: "resize", geometry: { columns: 10, rows: 30 } },
      ],
      inputBytesWritten: promptInput.length - 1,
      outcome: "input-incomplete",
      readinessObserved: false,
    });
    for (const actions of [
      [
        challengeRequest.interaction.actions[0]!,
        promptAction,
        enterAction,
        challengeRequest.interaction.actions[1]!,
        { action: "wait-for-semantic-completion" as const },
        promptRequest.interaction.actions[6]!,
      ],
      [
        challengeRequest.interaction.actions[0]!,
        challengeRequest.interaction.actions[1]!,
        { action: "wait-for-semantic-completion" as const },
        promptAction,
        enterAction,
        promptRequest.interaction.actions[6]!,
      ],
    ])
      await expect(
        executeChallengeCase(
          {
            ...promptRequest,
            interaction: { trigger: "immediate", actions },
          },
          "clean",
        ),
      ).rejects.toThrow("testkit.pty.request");

    await expect(
      executeChallengeCase(challengeRequest, "fixed-readiness-spoof"),
    ).resolves.toMatchObject({
      actions: [{ action: "input", byteLength: 65 }],
      inputBytesWritten: 65,
      outcome: "input-incomplete",
      readinessObserved: false,
    });
    await expect(
      executeChallengeCase(challengeRequest, "completion-before-readiness"),
    ).resolves.toMatchObject({
      actions: [
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: 66,
      outcome: "completed",
      readinessObserved: true,
    });
    for (const seed of ["checkpoint-missing-process"] as const)
      await expect(
        executeChallengeCase(challengeRequest, seed),
      ).resolves.toMatchObject({
        actions: [{ action: "input", byteLength: 65 }],
        inputBytesWritten: 65,
        outcome: "input-incomplete",
      });
    await expect(
      executeChallengeCase(challengeRequest, "checkpoint-process-churn"),
    ).resolves.toMatchObject({
      actions: [{ action: "input", byteLength: 65 }],
      inputBytesWritten: 65,
      outcome: "transport-failed",
    });
    await expect(
      executeChallengeCase(
        challengeRequest,
        "checkpoint-transient-extra-process",
      ),
    ).resolves.toMatchObject({
      actions: [
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: 66,
      outcome: "completed",
      readinessObserved: true,
    });
    await expect(
      executeChallengeCase(challengeRequest, "checkpoint-extra-process"),
    ).resolves.toMatchObject({
      actions: [
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: 66,
      outcome: "completed",
      readinessObserved: true,
    });
    await expect(
      executeChallengeCase(challengeRequest, "checkpoint-owned-sidecar"),
    ).resolves.toMatchObject({
      actions: [
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: 66,
      outcome: "completed",
      readinessObserved: true,
    });
    await expect(
      executeChallengeCase(challengeRequest, "checkpoint-owned-descendant"),
    ).resolves.toMatchObject({
      actions: [
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: 66,
      outcome: "completed",
      readinessObserved: true,
    });
    for (const seed of [
      "checkpoint-observer-delay",
      "checkpoint-observer-delay-mismatch",
    ] as const) {
      const delayedAt = performance.now();
      await expect(
        executeSelectedPtyTransportForTest(
          {
            ...challengeRequest,
            process: {
              ...challengeRequest.process,
              monotonicStartupDeadlineMs: delayedAt + 50,
              monotonicExecutionDeadlineMs: delayedAt + 100,
              monotonicShutdownDeadlineMs: delayedAt + 500,
            },
          },
          seed,
        ),
      ).resolves.toMatchObject({
        actions: [{ action: "input", byteLength: 65 }],
        cleanup: "clean",
        inputBytesWritten: 65,
        outcome: "transport-failed",
        residualProcessCount: 0,
      });
    }
  }, 60_000);

  it.each([
    "terminal-query-handshake",
    "terminal-query-partial",
    "terminal-query-blocked",
    "terminal-prompt-partial",
    "terminal-redraw-enter-fragmented",
    "keyboard-protocol-readiness-before",
    "keyboard-protocol-readiness-before-blocked",
    "keyboard-protocol-same-burst",
  ] as const)(
    "settles terminal reply transport %s",
    async (seed) => {
      const selected = protocolPromptRequest();
      const now = performance.now();
      await expect(
        executeSelectedPtyTransportForTest(
          {
            ...selected,
            process: {
              ...selected.process,
              monotonicStartupDeadlineMs: now + 5_000,
              monotonicExecutionDeadlineMs: now + 10_000,
              monotonicShutdownDeadlineMs: now + 15_000,
            },
          },
          seed,
        ),
      ).resolves.toMatchObject({
        actions: [
          { action: "resize", geometry: { columns: 100, rows: 30 } },
          { action: "input", byteLength: 65 },
          { action: "checkpoint-process-topology" },
          { action: "input", byteLength: 67 },
          { action: "input", byteLength: 5 },
          { action: "wait-for-semantic-completion" },
          { action: "input", byteLength: 1 },
        ],
        inputBytesWritten: 138,
        outcome: "completed",
        readinessObserved: true,
        terminalInputJoined: true,
      });
    },
    20_000,
  );

  it.each([
    "terminal-post-completion-idle",
    "terminal-title-completion-after-idle",
    "terminal-post-submission-readiness-revoked",
    "terminal-idle-before-completion-marker",
  ] as const)("waits for a fresh bounded idle prompt: %s", async (seed) => {
    const selected = protocolPromptRequest();
    const gated = postSubmissionRequest(selected);
    const completed = await executeSelectedPtyTransportForTest(gated, seed);
    expect(completed).toMatchObject({
      outcome: "completed",
      cleanup: "clean",
      inputBytesWritten: 138,
      postSubmissionIdleDiagnostic: "idle-ready",
    });
    if (seed === "terminal-post-completion-idle")
      expect(completed.postSubmissionIdleAtTitleDiagnostic).toBe(
        "title-not-observed",
      );
    if (seed === "terminal-title-completion-after-idle")
      expect(completed.postSubmissionIdleAtTitleDiagnostic).toBe("idle-ready");
    expect(completed.actions.map(({ action }) => action)).toEqual([
      "resize",
      "input",
      "checkpoint-process-topology",
      "input",
      "input",
      "wait-for-semantic-completion",
      "wait-for-post-submission-idle-prompt",
      "input",
    ]);
  });

  it("stops before post-turn input when the synthetic terminal closes", async () => {
    const selected = protocolPromptRequest();
    const gated = postSubmissionRequest(selected);
    const stale = await executeSelectedPtyTransportForTest(
      gated,
      "terminal-preenter-frame-late-close",
    );
    expect(stale.actions.map(({ action }) => action)).not.toContain(
      "wait-for-post-submission-idle-prompt",
    );
    expect(stale.inputBytesWritten).toBe(137);
    expect(stale.postSubmissionIdleDiagnostic).not.toBe("idle-ready");
    expect(stale.cleanup).toBe("clean");
  });

  it("rejects substituted post-turn readiness and action order", async () => {
    const selected = protocolPromptRequest();
    const gated = postSubmissionRequest(selected);
    for (const readiness of [
      selected.readiness,
      {
        ...gated.readiness,
        postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${"b".repeat(64)}`,
      },
    ])
      await expect(
        executeSelectedPtyTransportForTest(
          { ...gated, readiness },
          "terminal-post-completion-idle",
        ),
      ).rejects.toMatchObject({ code: "testkit.pty.request" });
    for (const actions of [
      [
        { action: "wait-for-post-submission-idle-prompt" as const },
        ...selected.interaction.actions,
      ],
      [
        ...gated.interaction.actions.slice(0, -1),
        { action: "wait-for-post-submission-idle-prompt" as const },
        selected.interaction.actions.at(-1)!,
      ],
    ])
      await expect(
        executeSelectedPtyTransportForTest(
          { ...gated, interaction: { ...gated.interaction, actions } },
          "terminal-post-completion-idle",
        ),
      ).rejects.toMatchObject({ code: "testkit.pty.request" });
    await expect(
      executeSelectedPtyTransportForTest(
        {
          ...gated,
          readiness: { kind: "semantic-marker" },
        },
        "terminal-post-completion-idle",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.request" });
  });

  it("does not admit an absent post-submission response", async () => {
    const missingIdle = await executeSelectedPtyTransportForTest(
      boundedNegativePostSubmissionRequest(),
      "terminal-post-submission-idle-missing",
    );
    expect(missingIdle.finalSnapshot.semanticState).toBe("completed");
    const actions = missingIdle.actions.map(({ action }) => action);
    expect(actions.slice(0, 5)).toEqual([
      "resize",
      "input",
      "checkpoint-process-topology",
      "input",
      "input",
    ]);
    // Completion may precede a causally post-input semantic wait; neither
    // observation admits an idle response.
    expect(
      actions.length === 5 ||
        (actions.length === 6 && actions[5] === "wait-for-semantic-completion"),
    ).toBe(true);
    expect(missingIdle.inputBytesWritten).toBe(137);
    expect(missingIdle.postSubmissionIdleDiagnostic).toBe(
      "response-not-observed",
    );
  }, 10_000);

  it.each([
    "terminal-preenter-buffered-idle",
    "terminal-response-after-idle-frame",
  ] as const)(
    "does not admit buffered idle evidence: %s",
    async (seed) => {
      const buffered = await executeSelectedPtyTransportForTest(
        boundedNegativePostSubmissionRequest(),
        seed,
      );
      expect(buffered.actions.map(({ action }) => action)).not.toContain(
        "wait-for-post-submission-idle-prompt",
      );
      expect(buffered.inputBytesWritten).toBe(137);
    },
    10_000,
  );

  it("does not submit the prompt without a drained live terminal", async () => {
    const selected = protocolPromptRequest();
    const now = performance.now();
    await expect(
      executeSelectedPtyTransportForTest(
        {
          ...selected,
          process: {
            ...selected.process,
            monotonicStartupDeadlineMs: now + 5_000,
            monotonicExecutionDeadlineMs: now + 10_000,
            monotonicShutdownDeadlineMs: now + 15_000,
          },
        },
        "terminal-no-prompt",
      ),
    ).rejects.toMatchObject({
      code: "testkit.pty.transport.semantic-incomplete",
    });
  }, 20_000);

  it.each([
    "keyboard-protocol-missing",
    "keyboard-protocol-substituted",
    "keyboard-protocol-out-of-order",
    "keyboard-protocol-after-readiness",
    "keyboard-protocol-reset",
    "keyboard-protocol-ris",
  ] as const)(
    "rejects terminal protocol negative %s",
    async (seed) => {
      const selected = protocolPromptRequest();
      const now = performance.now();
      const rejected = await executeSelectedPtyTransportForTest(
        {
          ...selected,
          process: {
            ...selected.process,
            monotonicStartupDeadlineMs: now + 5_000,
            monotonicExecutionDeadlineMs: now + 10_000,
            monotonicShutdownDeadlineMs: now + 15_000,
          },
        },
        seed,
      );
      expect(rejected).toMatchObject({
        actions: [
          { action: "resize", geometry: { columns: 100, rows: 30 } },
          { action: "input", byteLength: 65 },
          ...(seed === "keyboard-protocol-after-readiness"
            ? [{ action: "checkpoint-process-topology" }]
            : []),
        ],
        inputBytesWritten: 65,
        outcome: "input-incomplete",
      });
      if (seed === "keyboard-protocol-missing")
        expect(rejected.checkpointProgressDiagnostic).toBe("no-live-readiness");
      if (seed === "keyboard-protocol-after-readiness")
        expect(rejected.checkpointProgressDiagnostic).toBe("advanced");
    },
    20_000,
  );

  it("admits exact CSI-u Enter after the complete bracketed paste", async () => {
    const selected = protocolPromptRequest();
    const now = performance.now();
    await expect(
      executeSelectedPtyTransportForTest(
        {
          ...selected,
          process: {
            ...selected.process,
            monotonicStartupDeadlineMs: now + 5_000,
            monotonicExecutionDeadlineMs: now + 10_000,
            monotonicShutdownDeadlineMs: now + 15_000,
          },
        },
        "clean",
      ),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize" },
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "input", byteLength: 67 },
        { action: "input", byteLength: 5 },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
    });
  }, 20_000);

  it("rejects a combined prompt and CSI-u Enter request grammar", async () => {
    const selected = protocolPromptRequest();
    const promptAction = selected.interaction.actions[3];
    const enterAction = selected.interaction.actions[4];
    expect(promptAction?.action).toBe("input");
    expect(enterAction?.action).toBe("input");
    if (promptAction?.action !== "input" || enterAction?.action !== "input")
      throw new Error("test fixture");
    const submission = selected.process.stdin.subarray(
      65,
      65 + promptAction.byteLength + enterAction.byteLength,
    );
    const combined = {
      ...selected,
      interaction: {
        ...selected.interaction,
        actions: [
          ...selected.interaction.actions.slice(0, 3),
          {
            action: "input" as const,
            byteLength: submission.length,
            inputSha256: createHash("sha256").update(submission).digest("hex"),
          },
          ...selected.interaction.actions.slice(5),
        ],
      },
    };
    await expect(
      executeSelectedPtyTransportForTest(combined, "clean"),
    ).rejects.toThrow("testkit.pty.request");
  });

  it("does not reuse prompt Enter pacing after semantic completion", async () => {
    const selected = protocolPromptRequest();
    const postCompletion = Buffer.concat([
      Buffer.from("x"),
      Buffer.from("\u001b[13u"),
    ]);
    const stdin = new Uint8Array(
      Buffer.concat([
        Buffer.from(selected.process.stdin.subarray(0, -1)),
        postCompletion,
      ]),
    );
    const inputAction = (bytes: Uint8Array) => ({
      action: "input" as const,
      byteLength: bytes.length,
      inputSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const postWaitRequest: SelectedPtyExecutionRequest = {
      ...selected,
      process: { ...selected.process, stdin },
      interaction: {
        ...selected.interaction,
        actions: [
          ...selected.interaction.actions.slice(0, -1),
          inputAction(postCompletion.subarray(0, 1)),
          inputAction(postCompletion.subarray(1)),
        ],
      },
    };
    const now = performance.now();
    await expect(
      executeSelectedPtyTransportForTest(
        {
          ...postWaitRequest,
          process: {
            ...postWaitRequest.process,
            monotonicStartupDeadlineMs: now + 5_000,
            monotonicExecutionDeadlineMs: now + 10_000,
            monotonicShutdownDeadlineMs: now + 15_000,
          },
        },
        "terminal-post-wait-pacing",
      ),
    ).resolves.toMatchObject({
      actions: [
        { action: "resize" },
        { action: "input", byteLength: 65 },
        { action: "checkpoint-process-topology" },
        { action: "input", byteLength: 67 },
        { action: "input", byteLength: 5 },
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: 138,
      outcome: "input-incomplete",
      terminalInputJoined: false,
    });
  }, 20_000);

  it.each([
    ["raw carriage return", Buffer.from("\r")],
    ["substituted CSI-u", Buffer.from("\u001b[13~")],
  ])("rejects %s as the Enter action", async (_name, suffix) => {
    const selected = protocolPromptRequest();
    const promptAction = selected.interaction.actions[3];
    const enterAction = selected.interaction.actions[4];
    expect(promptAction?.action).toBe("input");
    expect(enterAction?.action).toBe("input");
    if (promptAction?.action !== "input" || enterAction?.action !== "input")
      throw new Error("test fixture");
    const stdin = new Uint8Array(
      Buffer.concat([
        Buffer.from(
          selected.process.stdin.subarray(0, 65 + promptAction.byteLength),
        ),
        suffix,
        Buffer.from(
          selected.process.stdin.subarray(
            65 + promptAction.byteLength + enterAction.byteLength,
          ),
        ),
      ]),
    );
    const substituted: SelectedPtyExecutionRequest = {
      ...selected,
      process: { ...selected.process, stdin },
      interaction: {
        ...selected.interaction,
        actions: [
          ...selected.interaction.actions.slice(0, 4),
          {
            action: "input",
            byteLength: suffix.length,
            inputSha256: createHash("sha256").update(suffix).digest("hex"),
          },
          ...selected.interaction.actions.slice(5),
        ],
      },
    };
    await expect(
      executeSelectedPtyTransportForTest(substituted, "clean"),
    ).rejects.toThrow("testkit.pty.request");
  });

  it("causally validates the selected immutable principal record", () => {
    expect(
      validateSelectedContainerPrincipalFactsForTest(principalFacts()),
    ).toBe(true);
  });

  it("admits only the exact Codex controller capability set", () => {
    const controller = controllerPrincipalFacts();
    expect(validateSelectedContainerPrincipalFactsForTest(controller)).toBe(
      true,
    );
    expect(() =>
      validateSelectedContainerPrincipalFactsForTest({
        ...controller,
        status: controller.status.replace(
          "CapBnd:\t00000000000000e3",
          "CapBnd:\t00000000000000e2",
        ),
      }),
    ).toThrow("testkit.pty.immutable-candidate");
    expect(() =>
      validateSelectedContainerPrincipalFactsForTest({
        ...controller,
        groups: [0, 1000],
      }),
    ).toThrow("testkit.pty.immutable-candidate");
  });

  it("keeps exact profile selection independent of ambient array includes", () => {
    for (const scenarioId of [
      "codex-tui-trace-smoke",
      "claude-interactive-trace-smoke",
    ])
      expect(actualImmutablePrincipalProfile(scenarioId, true)).toBe(
        "codex-controller",
      );
    expect(actualImmutablePrincipalProfile("fixture-process-smoke", true)).toBe(
      "ordinary",
    );
  });

  it.each(["codex-tui-trace-smoke", "claude-interactive-trace-smoke"])(
    "binds actual %s selection to the exact admitted controller principal",
    (scenarioId) => {
      const controller = {
        ...controllerPrincipalFacts(),
        profile: actualImmutablePrincipalProfile(scenarioId),
      };
      expect(validateSelectedContainerPrincipalFactsForTest(controller)).toBe(
        true,
      );
      for (const status of [
        controller.status.replace(
          "CapBnd:\t00000000000000e3",
          "CapBnd:\t00000000000000e2",
        ),
        controller.status.replace(
          "CapEff:\t00000000000000e3",
          "CapEff:\t00000000000000e7",
        ),
        controller.status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
      ])
        expect(() =>
          validateSelectedContainerPrincipalFactsForTest({
            ...controller,
            status,
          }),
        ).toThrow("testkit.pty.immutable-candidate");
      expect(() =>
        validateSelectedContainerPrincipalFactsForTest({
          ...controller,
          groups: [0, 1000],
        }),
      ).toThrow("testkit.pty.immutable-candidate");
    },
  );
  it.each([
    "fixture-process-smoke",
    "fixture-process-interactive",
    "claude-interactive-trace-smoke-extra",
  ])(
    "keeps actual %s selection ordinary and rejects a root substitution",
    (scenarioId) => {
      const profile = actualImmutablePrincipalProfile(scenarioId);
      expect(profile).toBe("ordinary");
      expect(
        validateSelectedContainerPrincipalFactsForTest({
          ...principalFacts(),
          profile,
        }),
      ).toBe(true);
      expect(() =>
        validateSelectedContainerPrincipalFactsForTest({
          ...controllerPrincipalFacts(),
          profile,
        }),
      ).toThrow("testkit.pty.immutable-candidate");
    },
  );

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

  it("admits a raw-mode TUI when no canonical EOF action is requested", async () => {
    const base = request();
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...base,
        interaction: {
          trigger: "semantic-ready",
          actions: [base.interaction.actions[0]!],
        },
      },
      "mode-substitution",
    );
    expect(receipt).toMatchObject({
      observedCanonicalMode: false,
      outcome: "completed",
      terminalInputJoined: true,
    });
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

  it("applies the immediate action before reading fast exact output", async () => {
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
      "immediate-output",
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
    [
      "active-terminal",
      "testkit.pty.transport.semantic-missing-readiness-with-output",
    ],
    [
      "missing-ready",
      "testkit.pty.transport.semantic-missing-readiness-with-output",
    ],
    [
      "silent-terminal",
      "testkit.pty.transport.semantic-missing-readiness-no-output",
    ],
    ["credential-prompt", "testkit.pty.transport.semantic-credential-prompt"],
    [
      "malformed-control",
      "testkit.pty.transport.semantic-malformed-trailing-control",
    ],
    [
      "unsupported-control",
      "testkit.pty.transport.semantic-unsupported-extended-csi-private-mode-unlisted",
    ],
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

  it("does not accept a completion marker while the preceding input is blocked", async () => {
    expect(
      await executeSelectedPtyTransportForTest(
        {
          ...request(),
          interaction: {
            trigger: "semantic-ready",
            actions: [
              {
                action: "input",
                byteLength: 4,
                inputSha256:
                  "5040625b1fb6fa4af07226683f6e6003b29e5e70b16f8cfb24be7a752393f0ee",
              },
              { action: "wait-for-semantic-completion" },
              { action: "eof" },
            ],
          },
        },
        "blocked-input-completion",
      ),
    ).toMatchObject({
      actions: [],
      inputBytesWritten: 0,
      outcome: "input-incomplete",
      terminalInputJoined: false,
    });
  });

  it("waits for terminal output between readiness-gated input segments", async () => {
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
      "paced-input",
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

  it("waits for semantic completion before applying a terminal action", async () => {
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...request(),
        interaction: {
          trigger: "semantic-ready",
          actions: [
            {
              action: "input",
              byteLength: 4,
              inputSha256:
                "5040625b1fb6fa4af07226683f6e6003b29e5e70b16f8cfb24be7a752393f0ee",
            },
            { action: "wait-for-semantic-completion" },
            { action: "eof" },
          ],
        },
      },
      "post-input-completion",
    );
    expect(receipt).toMatchObject({
      outcome: "completed",
      actions: [
        { action: "input" },
        { action: "wait-for-semantic-completion" },
        { action: "eof" },
      ],
      terminalInputJoined: true,
    });
  });

  it("admits one Ctrl-D after independently observing completion then readiness", async () => {
    const ctrlD = new Uint8Array([4]);
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...request({ stdin: ctrlD }),
        interaction: {
          trigger: "semantic-ready",
          actions: [
            { action: "wait-for-semantic-completion" },
            {
              action: "input",
              byteLength: 1,
              inputSha256: createHash("sha256").update(ctrlD).digest("hex"),
            },
          ],
        },
      },
      "completion-before-readiness",
    );

    expect(receipt).toMatchObject({
      actions: [
        { action: "wait-for-semantic-completion" },
        { action: "input", byteLength: 1 },
      ],
      inputBytesWritten: 1,
      outcome: "completed",
      readinessObserved: true,
      terminalInputJoined: true,
    });
  });

  it.each([
    ["readinessObserved", "missing-ready"],
    ["completionObserved", "missing-completion"],
    ["snapshot", "missing-completion"],
  ] as const)(
    "does not trust caller-substituted emulator %s marker authority",
    async (method, seed) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        BoundedTerminalEmulator.prototype,
        method,
      )!;
      const replacement =
        method === "snapshot"
          ? function (this: BoundedTerminalEmulator) {
              const observed = Reflect.apply(
                originalTerminalSnapshot,
                this,
                [],
              );
              return { ...observed, semanticState: "completed" };
            }
          : () => true;
      Object.defineProperty(BoundedTerminalEmulator.prototype, method, {
        ...descriptor,
        value: replacement,
      });
      try {
        const selected =
          method === "readinessObserved"
            ? request()
            : {
                ...request({ stdin: new Uint8Array() }),
                interaction: {
                  trigger: "semantic-ready" as const,
                  actions: [
                    { action: "wait-for-semantic-completion" as const },
                  ],
                },
              };
        await expect(
          executeSelectedPtyTransportForTest(selected, seed),
        ).rejects.toMatchObject({
          code:
            method === "readinessObserved"
              ? "testkit.pty.transport.semantic-missing-readiness-with-output"
              : "testkit.pty.transport.semantic-incomplete",
        });
      } finally {
        Object.defineProperty(
          BoundedTerminalEmulator.prototype,
          method,
          descriptor,
        );
      }
    },
  );

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

  it("applies readiness-gated input before a fast completion burst", async () => {
    const input = new Uint8Array([12]);
    const now = performance.now();
    const receipt = await executeSelectedPtyTransportForTest(
      {
        ...request({
          stdin: input,
          // This case proves ordering, not deadline expiry. Keep its absolute
          // authority distinct from the deliberately short deadline cases so
          // coverage instrumentation cannot turn scheduler delay into a
          // different semantic test.
          monotonicStartupDeadlineMs: now + 1_000,
          monotonicExecutionDeadlineMs: now + 2_000,
          monotonicShutdownDeadlineMs: now + 4_000,
        }),
        interaction: {
          trigger: "semantic-ready",
          actions: [
            {
              action: "input",
              byteLength: 1,
              inputSha256:
                "ef6cbd2161eaea7943ce8693b9824d23d1793ffb1c0fca05b600d3899b44c977",
            },
            { action: "wait-for-semantic-completion" },
            { action: "interrupt-byte", byte: 3 },
          ],
        },
      },
      "readiness-burst",
    );
    expect(receipt).toMatchObject({
      outcome: "completed",
      actions: [
        { action: "input", byteLength: 1 },
        { action: "wait-for-semantic-completion" },
        { action: "interrupt-byte", byte: 3 },
      ],
    });
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
          readiness: {
            kind: "styled-text-after-completion",
            text: "two",
            bold: true,
            dim: false,
          },
        },
        "clean",
      ),
    ).rejects.toMatchObject({ code: "testkit.pty.request" });
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
