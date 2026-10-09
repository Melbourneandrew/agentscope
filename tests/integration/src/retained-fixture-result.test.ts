/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import {
  existsSync,
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";
import { leakedChildReadinessWasObserved } from "./substrate-certification.js";

// The reader is private integration JavaScript, not a package API.
// @ts-expect-error no declaration file is published for this private module
import { readRetainedFixtureOutput } from "../retained-fixture-result.mjs";

const roots: string[] = [];
const scenarioId = "fixture-process-smoke";
const record = (encodedEvidence = "exact_evidence") =>
  `${JSON.stringify({
    encodedEvidence,
    evidenceVersion: 1,
    scenarioId,
  })}\n`;
const createRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-retained-result-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
};
const writeResult = (path: string, content = record()) => {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
};

const producerTail = (invalidLifecycle = false) => {
  const root = createRoot();
  const source = readFileSync(
    join(import.meta.dirname, "../platform-fixture.mjs"),
    "utf8",
  );
  const start = source.indexOf("const processEvidence = {");
  expect(start).toBeGreaterThan(0);
  const oracle = readFileSync(
    join(import.meta.dirname, "../process-platform-oracle.mjs"),
    "utf8",
  );
  const authority = runInNewContext(
    `${oracle.replaceAll("export const ", "const ")}; ({assertProcessFixtureEvidence, requiredLifecycle, requiredEventKinds, expectedIngestion, expectedRetrieval})`,
    { Buffer },
  ) as {
    assertProcessFixtureEvidence: (value: unknown, input: unknown) => void;
    requiredLifecycle: string[];
    requiredEventKinds: string[];
    expectedIngestion: [string, string, string, number, string][];
    expectedRetrieval: [string, string, string, number, string][];
  };
  const rows = (entries: typeof authority.expectedIngestion) =>
    entries.map(([operation, method, path, bodyBytes, outcome]) => ({
      operation,
      method,
      path,
      bodyBytes,
      outcome,
    }));
  const child = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: () => undefined,
    destroy: () => undefined,
  });
  let spawned = 0;
  const timers = new Map<object, () => void>();
  const lines: string[] = [];
  const result = runInNewContext(`(async () => { ${source.slice(start)} })()`, {
    Buffer,
    createHash,
    basename,
    join,
    writeFileSync,
    scenarioId,
    artifactPath: "CLI.tgz",
    observedLifecycle: invalidLifecycle ? [] : authority.requiredLifecycle,
    partial: {
      eventKinds: authority.requiredEventKinds,
      modelLedger: {
        ledgerVersion: 1,
        scenarioId,
        entries: [
          {
            routeId: "unmatched",
            provider: "none",
            method: "GET",
            path: "/agentscope-unmatched",
            bodyBytes: 0,
          },
        ],
      },
      destinationLedger: {
        ledgerVersion: 1,
        scenarioId,
        ingestion: rows(authority.expectedIngestion),
        retrieval: rows(authority.expectedRetrieval),
      },
    },
    assertProcessFixtureEvidence: authority.assertProcessFixtureEvidence,
    routeFixture: { routes: [] },
    scenario: { scenarioId, modelRoutes: [] },
    substrateCertificationCase: "leaked-child",
    certificationReadiness: null,
    randomBytes: () => Buffer.alloc(16, 0xab),
    ledgerHome: root,
    interactive: false,
    trafficEvidence: (value: unknown) => value,
    process: { execPath: "selected-node" },
    console: { log: (value: string) => lines.push(value) },
    spawn: (executable: string, arguments_: string[]) => {
      expect(executable).toBe("selected-node");
      expect(arguments_).toEqual([
        "/opt/agentscope/fixtures/substrate-negative-process.mjs",
        "leaked-child",
        "ab".repeat(16),
      ]);
      spawned++;
      return Object.assign(child, { stdout, unref: () => undefined });
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      expect(milliseconds).toBe(5_000);
      const id = {};
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: object) => timers.delete(id),
  }) as Promise<void>;
  return { root, result, stdout, child, timers, lines, spawned: () => spawned };
};

describe("actual producer tail retains only after strict readiness", () => {
  it("holds publication until exact split readiness, then the real reader authenticates", async () => {
    const f = producerTail();
    expect(f.spawned()).toBe(1);
    expect(existsSync(join(f.root, "fixture-result.json"))).toBe(false);
    expect(existsSync(join(f.root, "fixture-lifecycle.json"))).toBe(false);
    expect(f.lines).toEqual([]);
    f.stdout.emit("data", "AGENTSCOPE_NEGATIVE_READY=");
    expect(existsSync(join(f.root, "fixture-result.json"))).toBe(false);
    f.stdout.emit("data", `${"ab".repeat(16)}\n`);
    await f.result;
    expect(f.timers.size).toBe(0);
    expect(
      String(
        readRetainedFixtureOutput(
          join(f.root, "fixture-result.json"),
          scenarioId,
        ),
      ).trim(),
    ).toBe(f.lines[0]);
    expect(f.lines[0]).toContain("AGENTSCOPE_FIXTURE_RESULT=");
  });
  it.each(["error", "exit", "timeout", "oversized", "mismatch"])(
    "does not publish after %s readiness refusal",
    async (kind) => {
      const f = producerTail();
      const refused = expect(f.result).rejects.toThrow();
      if (kind === "timeout") {
        for (const callback of f.timers.values()) callback();
        f.timers.clear();
      } else if (kind === "oversized" || kind === "mismatch") {
        f.stdout.emit(
          "data",
          kind === "oversized" ? "X".repeat(100) : "PRIVATE wrong readiness",
        );
        // Existing source leaves mismatch pending until its original timeout.
        for (const callback of f.timers.values()) callback();
        f.timers.clear();
      } else f.child.emit(kind, new Error("synthetic readiness refusal"));
      await refused;
      expect(f.timers.size).toBe(0);
      expect(f.lines).toEqual([]);
      expect(() =>
        readRetainedFixtureOutput(
          join(f.root, "fixture-result.json"),
          scenarioId,
        ),
      ).toThrow("integration.runner.fixture-result");
    },
  );
  it("strict oracle rejects before spawn and exclusive writer never replaces existing bytes", async () => {
    const invalid = producerTail(true);
    await expect(invalid.result).rejects.toThrow(
      "integration.fixture.oracle-lifecycle",
    );
    expect(invalid.spawned()).toBe(0);
    expect(invalid.timers.size).toBe(0);
    const f = producerTail();
    writeResult(join(f.root, "fixture-result.json"), "existing owned bytes");
    const refused = expect(f.result).rejects.toThrow();
    f.stdout.emit("data", `AGENTSCOPE_NEGATIVE_READY=${"ab".repeat(16)}\n`);
    await refused;
    expect(readFileSync(join(f.root, "fixture-result.json"), "utf8")).toBe(
      "existing owned bytes",
    );
    expect(f.lines).toEqual([]);
    expect(f.timers.size).toBe(0);
  });
});

const returnedHeadlessFixture = async (
  certificationCase: string,
  outcome: string,
  retainedStatus: "complete" | "partial" | "absent" | "malformed",
  observationSinkFails = false,
) => {
  const root = createRoot();
  const path = join(root, "fixture-result.json");
  const readiness = {
    readinessVersion: 1,
    certificationCase: "leaked-child",
    challengeSha256: `sha256:${"a".repeat(64)}`,
  };
  const encode = (status: string) =>
    Buffer.from(
      JSON.stringify({
        resultStatus: status,
        certificationReadiness: status === "complete" ? readiness : null,
      }),
    ).toString("base64url");
  if (retainedStatus === "malformed") writeResult(path, "{}");
  else if (retainedStatus !== "absent")
    writeResult(path, record(encode(retainedStatus)));
  const trace = {
    runId: "owned-run",
    requestFingerprint: "owned-request",
    returnedAtMs: 100,
    result: {
      stdout: Buffer.from(`AGENTSCOPE_FIXTURE_RESULT=${encode("partial")}\n`),
      outcome,
      exitCode: outcome === "exited" ? 0 : null,
      cleanup: outcome === "exited" ? "clean" : "residual",
      termRequested: outcome !== "exited",
      killRequested: outcome !== "exited",
    },
    observation: {},
  };
  const source = readFileSync(
    join(import.meta.dirname, "../runner.mjs"),
    "utf8",
  );
  const start = source.indexOf(
    "    const trace = await executeSelectedHeadlessProcess(",
  );
  const end = source.indexOf("\n  }\n} catch (error) {", start);
  const observationStart = source.indexOf(
    '\nif (\n  scenario.executionMode === "headless" &&\n  substrateCertificationCase === "leaked-child"\n) {',
    end,
  );
  const observationEnd = source.indexOf(
    "const fixtureResult =",
    observationStart,
  );
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(observationStart).toBeGreaterThan(end);
  expect(observationEnd).toBeGreaterThan(observationStart);
  const receipts: string[] = [];
  let reads = 0;
  const helperStart = source.indexOf("const recoverRetainedFixtureOutput =");
  const helperEnd = source.indexOf("\ntry {", helperStart);
  expect(helperStart).toBeGreaterThan(0);
  expect(helperEnd).toBeGreaterThan(helperStart);
  const result = (await runInNewContext(
    `(async () => { let fixtureOutput; let fixtureFailure; let recoveryAttempted = false; let recoverySucceeded = false; let recoveryStage = null; ${source.slice(helperStart, helperEnd)} ${source.slice(start, end)}; const originalFailure = fixtureFailure; ${source.slice(observationStart, observationEnd)}; return {fixtureOutput, fixtureFailure, originalFailure}; })()`,
    {
      executeSelectedHeadlessProcess: () => Promise.resolve(trace),
      headlessCapability: {},
      request: {},
      TextDecoder,
      Buffer,
      console: {
        log: (line: string) => {
          if (
            observationSinkFails &&
            line.startsWith("AGENTSCOPE_RETAINED_RECOVERY=")
          )
            throw new Error("PRIVATE optional sink");
          receipts.push(line);
        },
      },
      headlessOuterDeadline: 150,
      now: 1,
      headlessTranslationBootAt: 1,
      headlessTranslationLocalAt: 1,
      serializedProcessRequest: { fixed: "actual-request" },
      substrateCertificationCase: certificationCase,
      scenario: { executionMode: "headless" },
      requiredEnvironment: () => "a".repeat(16),
      join,
      ledger: root,
      scenarioId,
      readRetainedFixtureOutput: (
        resultPath: string,
        selectedScenarioId: string,
        test: undefined,
        observer: (stage: string) => void,
      ) => {
        reads++;
        return readRetainedFixtureOutput(
          resultPath,
          selectedScenarioId,
          test,
          observer,
        );
      },
    },
  )) as {
    fixtureOutput: string;
    fixtureFailure?: Error;
    originalFailure?: Error;
  };
  const observed = JSON.parse(
    Buffer.from(
      result.fixtureOutput.trim().slice("AGENTSCOPE_FIXTURE_RESULT=".length),
      "base64url",
    ).toString("utf8"),
  ) as { resultStatus: string; certificationReadiness: unknown };
  return { result, observed, reads, receipts, trace };
};

describe("actual runner failed-return retained readiness", () => {
  it("keeps identical original failure and recovered evidence when optional sink throws", async () => {
    const f = await returnedHeadlessFixture(
      "leaked-child",
      "cleanup-failed",
      "complete",
      true,
    );
    expect(f.result.fixtureFailure).toBe(f.result.originalFailure);
    expect(f.observed.resultStatus).toBe("complete");
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts.join("")).not.toContain("PRIVATE");
  });
  it("recovers authenticated complete readiness without changing failed receipt or outcome", async () => {
    const f = await returnedHeadlessFixture(
      "leaked-child",
      "cleanup-failed",
      "complete",
    );
    expect(f.reads).toBe(1);
    expect(f.receipts[1]).toBe(
      `AGENTSCOPE_RETAINED_RECOVERY=${JSON.stringify({ runId: "a".repeat(16), recoveryAttempted: true, recoverySucceeded: true, recoveryStage: null })}`,
    );
    expect(f.result.fixtureFailure?.message).toBe(
      "integration.runner.fixture-failed",
    );
    expect(
      leakedChildReadinessWasObserved({
        fixtureCaptured: true,
        fixtureResultStatus: f.observed.resultStatus,
        certificationReadiness: f.observed.certificationReadiness,
      }),
    ).toBe(true);
    const receipt = JSON.parse(
      Buffer.from(
        f.receipts[0]!.slice("AGENTSCOPE_HEADLESS_RECEIPT=".length),
        "base64url",
      ).toString("utf8"),
    ) as {
      outcome: string;
      cleanup: string;
      termRequested: boolean;
      killRequested: boolean;
    };
    expect(receipt).toMatchObject({
      outcome: "cleanup-failed",
      cleanup: "residual",
      termRequested: true,
      killRequested: true,
    });
  });

  it.each(["partial", "absent", "malformed"] as const)(
    "cannot manufacture readiness from %s retained evidence",
    async (status) => {
      const f = await returnedHeadlessFixture(
        "leaked-child",
        "timed-out",
        status,
      );
      expect(f.reads).toBe(1);
      expect(f.receipts[1]).toContain(
        `"recoverySucceeded":${status === "partial"}`,
      );
      expect(f.receipts[1]).toContain(
        `"recoveryStage":${status === "absent" ? '"open"' : status === "malformed" ? '"envelope"' : "null"}`,
      );
      expect(f.result.fixtureFailure?.message).toBe(
        "integration.runner.fixture-failed",
      );
      expect(
        leakedChildReadinessWasObserved({
          fixtureCaptured: true,
          fixtureResultStatus: f.observed.resultStatus,
          certificationReadiness: f.observed.certificationReadiness,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["none", "cleanup-failed"],
    ["leaked-child", "exited"],
  ])("does not recover for case %s outcome %s", async (caseName, outcome) => {
    const f = await returnedHeadlessFixture(caseName, outcome, "complete");
    expect(f.reads).toBe(0);
    if (caseName === "leaked-child")
      expect(f.receipts[1]).toContain('"recoveryAttempted":false');
    else expect(f.receipts).toHaveLength(1);
    expect(f.observed.resultStatus).toBe("partial");
    if (outcome === "exited") expect(f.result.fixtureFailure).toBeUndefined();
    else
      expect(f.result.fixtureFailure?.message).toBe(
        "integration.runner.fixture-failed",
      );
  });
});

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("retained fixture-result authority", () => {
  it.each(["open", "status", "read", "identity", "envelope"] as const)(
    "observes only the fixed %s refusal boundary, preserving rejection when observer throws",
    (stage) => {
      const root = createRoot();
      const path = join(root, "fixture-result.json");
      if (stage !== "open")
        writeResult(path, stage === "envelope" ? "{}" : record());
      if (stage === "status") chmodSync(path, 0o644);
      const alter =
        stage === "read"
          ? () => {
              writeResult(path, "x".repeat(1024 * 1024 + 1));
            }
          : stage === "identity"
            ? () => {
                renameSync(path, join(root, "renamed.json"));
              }
            : undefined;
      const observed: string[] = [];
      expect(() =>
        readRetainedFixtureOutput(path, scenarioId, alter, (value: string) => {
          observed.push(value);
          throw new Error("PRIVATE observer");
        }),
      ).toThrow("integration.runner.fixture-result");
      expect(observed).toEqual([stage]);
      expect(observed.join("")).not.toContain("PRIVATE");
    },
  );
  it("does not observe a refusal for authenticated successful bytes", () => {
    const path = join(createRoot(), "fixture-result.json");
    writeResult(path);
    const observed: string[] = [];
    expect(
      readRetainedFixtureOutput(
        path,
        scenarioId,
        undefined,
        (value: string) => {
          observed.push(value);
        },
      ),
    ).toBe("AGENTSCOPE_FIXTURE_RESULT=exact_evidence\n");
    expect(observed).toEqual([]);
  });
  it("rejects absent or malformed success evidence", () => {
    const path = join(createRoot(), "fixture-result.json");
    expect(() => readRetainedFixtureOutput(path, scenarioId)).toThrow(
      "integration.runner.fixture-result",
    );
    writeResult(path, '{"evidenceVersion":1}\n');
    expect(() => readRetainedFixtureOutput(path, scenarioId)).toThrow(
      "integration.runner.fixture-result",
    );
  });

  it("reads exact bounded evidence through one authenticated descriptor", () => {
    const path = join(createRoot(), "fixture-result.json");
    writeResult(path);
    expect(readRetainedFixtureOutput(path, scenarioId)).toBe(
      "AGENTSCOPE_FIXTURE_RESULT=exact_evidence\n",
    );
  });

  it("rejects symlink and hardlink identities", () => {
    const root = createRoot();
    const source = join(root, "source.json");
    writeResult(source);
    const symlink = join(root, "symlink.json");
    symlinkSync(source, symlink);
    expect(() => readRetainedFixtureOutput(symlink, scenarioId)).toThrow(
      "integration.runner.fixture-result",
    );
    const hardlink = join(root, "hardlink.json");
    linkSync(source, hardlink);
    expect(() => readRetainedFixtureOutput(source, scenarioId)).toThrow(
      "integration.runner.fixture-result",
    );
  });

  it("bounds bytes even when the file grows after authentication", () => {
    const path = join(createRoot(), "fixture-result.json");
    writeResult(path);
    expect(() =>
      readRetainedFixtureOutput(path, scenarioId, () => {
        writeResult(path, "x".repeat(1024 * 1024 + 1));
      }),
    ).toThrow("integration.runner.fixture-result");
  });

  it("rejects a path replacement after descriptor authentication", () => {
    const root = createRoot();
    const path = join(root, "fixture-result.json");
    const opened = join(root, "opened.json");
    writeResult(path);
    expect(() =>
      readRetainedFixtureOutput(path, scenarioId, () => {
        renameSync(path, opened);
        writeResult(path, record("substituted_evidence"));
      }),
    ).toThrow("integration.runner.fixture-result");
  });
});
