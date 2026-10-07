import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  classifyCodexTraceGetFailure,
  codexTraceGetChildFailureCategory,
  codexTraceSearchChildFailureCategory,
} from "../codex-runtime-evidence.mjs";
// Private integration JavaScript has no package declaration surface.
// @ts-expect-error no declaration file is published for this private module
import * as authority from "../immutable-candidate-authority.mjs";
import {
  compileCapabilityManifest,
  type CapabilityManifest,
} from "./manifest.js";

const root = resolve(import.meta.dirname, "..");
const { decodeInteractiveFailureExitCode, encodeInteractiveFailureExitCode } =
  authority as unknown as {
    decodeInteractiveFailureExitCode: (
      code: number,
      scenario: string,
    ) => string | undefined;
    encodeInteractiveFailureExitCode: (
      predicate: string,
      scenario: string,
    ) => number | undefined;
  };
const diagnostic = (preparation: boolean) =>
  Buffer.from(
    `${JSON.stringify({
      category: "unavailable",
      code: "traces.unavailable",
      command: "agentscope traces get",
      schema: "agentscope.cli.diagnostic.v1",
      facts: {
        retrieverPreparationFailed: preparation,
        retrieverInvocationFailed: !preparation,
      },
    })}\n`,
  );
const observe = (stderr: Buffer, changes = {}) => ({
  code: 5,
  deadlineExpired: false,
  signal: null,
  stderrBytes: stderr.length,
  stdoutBytes: 0,
  maximumBytes: 1024 * 1024,
  stderr,
  stdout: Buffer.alloc(0),
  ...changes,
});

describe("prospective trace-get failure phase (never acceptance)", () => {
  it.each([true, false])(
    "projects only complementary owned booleans: %s",
    (preparation) => {
      const phase = preparation ? "prepare-retriever" : "invoke-get";
      expect(
        codexTraceGetChildFailureCategory(observe(diagnostic(preparation))),
      ).toBe(phase);
      const withRetry = Buffer.from(
        diagnostic(preparation)
          .toString()
          .replace('"facts":{', '"facts":{"retryAfterMilliseconds":250,'),
      );
      expect(codexTraceGetChildFailureCategory(observe(withRetry))).toBe(phase);
      expect(
        classifyCodexTraceGetFailure(
          `integration.codex.trace-get-child-${phase}`,
        ),
      ).toBe(`child-${phase}`);
    },
  );
  it("keeps every old trace-get ordinal and appends only two diagnoses", () => {
    const prior = [
      "locator-input",
      "child-spawn",
      "child-deadline",
      "child-signal",
      "child-exit",
      "child-output-limit",
      "terminal-deadline",
      "machine-output",
      "record-count",
      "locator-result",
      "unclassified",
    ];
    for (const [index, kind] of prior.entries()) {
      const name = `integration.fixture.codex-verify-trace-get-${kind}`;
      expect(
        encodeInteractiveFailureExitCode(name, "codex-tui-trace-smoke"),
      ).toBe(177 + index);
      expect(
        decodeInteractiveFailureExitCode(177 + index, "codex-tui-trace-smoke"),
      ).toBe(name);
    }
    for (const [index, phase] of [
      "prepare-retriever",
      "invoke-get",
    ].entries()) {
      const name = `integration.fixture.codex-verify-trace-get-child-${phase}`;
      expect(
        encodeInteractiveFailureExitCode(name, "codex-tui-trace-smoke"),
      ).toBe(188 + index);
      expect(
        decodeInteractiveFailureExitCode(188 + index, "codex-tui-trace-smoke"),
      ).toBe(name);
      expect(
        encodeInteractiveFailureExitCode(name, "unrelated"),
      ).toBeUndefined();
    }
  });
});

describe("trace-get refusal and outcome precedence", () => {
  it("discards malformed, duplicate, substituted and canary-bearing output", () => {
    const good = diagnostic(true).toString();
    const canary = "TRACE_GET_SECRET_CANARY";
    const cases = [
      Buffer.alloc(0),
      Buffer.from(canary),
      Buffer.from("x".repeat(4097)),
      Buffer.from(good.trimEnd()),
      Buffer.from(`\uFEFF${good}`),
      Buffer.from([0xff]),
      Buffer.from(
        good.replace(
          '"category":"unavailable"',
          '"category":"foreign","category":"unavailable"',
        ),
      ),
      Buffer.from(
        good.replace(
          '"retrieverPreparationFailed":true',
          '"retrieverPreparationFailed":true,"retrieverPreparationFailed":true',
        ),
      ),
      Buffer.from(good.replace('"unavailable"', '"unknown"')),
      Buffer.from(
        good.replace('"agentscope traces get"', '"agentscope traces search"'),
      ),
      Buffer.from(good.replace('"agentscope.cli.diagnostic.v1"', '"foreign"')),
      Buffer.from(good.replace('"retrieverPreparationFailed":true,', "")),
      Buffer.from(
        good.replace(
          '"retrieverInvocationFailed":false',
          '"retrieverInvocationFailed":true',
        ),
      ),
      Buffer.from(
        good.replace(
          '"retrieverPreparationFailed":true',
          '"retrieverPreparationFailed":false',
        ),
      ),
      Buffer.from(
        good.replace('"facts":{', '"facts":{"retryAfterMilliseconds":-1,'),
      ),
      Buffer.from(
        good.replace(
          '"facts":{',
          '"facts":{"retryAfterMilliseconds":"canary",',
        ),
      ),
      Buffer.from(
        good.replace('"facts":{', '"facts":{"retryAfterMilliseconds":1e400,'),
      ),
      Buffer.from(
        good.replace(
          '"retrieverPreparationFailed":true',
          `"retrieverPreparationFailed":"${canary}"`,
        ),
      ),
      Buffer.from(
        good.replace(
          '"retrieverPreparationFailed":true',
          `"unknown":"${canary}","retrieverPreparationFailed":true`,
        ),
      ),
    ];
    for (const stderr of cases) {
      const result = codexTraceGetChildFailureCategory(observe(stderr));
      expect(result).toBe("exit");
      expect(result.includes(canary)).toBe(false);
    }
  });
  it("preserves terminal outcome and byte-accounting precedence", () => {
    const stderr = diagnostic(true);
    for (const changes of [
      { code: 1 },
      { stdout: Buffer.from("canary"), stdoutBytes: 6 },
      { stderrBytes: stderr.length - 1 },
    ])
      expect(codexTraceGetChildFailureCategory(observe(stderr, changes))).toBe(
        "exit",
      );
    expect(
      codexTraceGetChildFailureCategory(
        observe(stderr, { deadlineExpired: true }),
      ),
    ).toBe("deadline");
    expect(
      codexTraceGetChildFailureCategory(observe(stderr, { signal: "SIGKILL" })),
    ).toBe("signal");
    expect(
      codexTraceGetChildFailureCategory(observe(stderr, { maximumBytes: 1 })),
    ).toBe("output-limit");
  });
});

const actualRun = (primary?: Error) => {
  const source = readFileSync(resolve(root, "codex-pty-scenario.mjs"), "utf8");
  const start = source.indexOf("const run = (executable");
  const end = source.indexOf("const agentscope =", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const child = Object.assign(new EventEmitter(), {
    pid: 100,
    stdout: Object.assign(new EventEmitter(), { destroy: () => {} }),
    stderr: Object.assign(new EventEmitter(), { destroy: () => {} }),
    kill: () => {},
  });
  let remainingCalls = 0,
    timerBudget = 0,
    cleared = false;
  const context = {
    Buffer,
    process: { env: {} },
    maximumOutput: 1024 * 1024,
    bootNow: () => 100,
    spawn: () => child,
    remaining: () => {
      if (++remainingCalls === 2 && primary) throw primary;
    },
    setTimeout: (_callback: () => void, budget: number) => {
      timerBudget = budget;
      return 1;
    },
    clearTimeout: () => {
      cleared = true;
    },
    codexTraceGetChildFailureCategory,
    codexTraceSearchChildFailureCategory,
    codexTraceSearchUnavailable: () => false,
    codexTraceSearchTimedOut: () => false,
    invoke: undefined as undefined | (() => Promise<unknown>),
  };
  runInNewContext(
    `${source.slice(start, end)}\ninvoke = () => run("closed", [], {monotonicDeadline: 600, traceGetDiagnostic: true});`,
    context,
  );
  return {
    context,
    child,
    run: () => context.invoke?.(),
    facts: () => ({ remainingCalls, timerBudget, cleared }),
  };
};

describe("actual collected-child failure wiring", () => {
  it("rejects the child with only a fixed phase and the original finite budget", async () => {
    const fixture = actualRun();
    const completion = fixture.run();
    fixture.child.stderr.emit("data", diagnostic(false));
    fixture.child.emit("close", 5, null);
    await expect(completion).rejects.toThrow(
      "integration.codex.trace-get-child-invoke-get",
    );
    expect(fixture.facts()).toEqual({
      remainingCalls: 2,
      timerBudget: 500,
      cleared: true,
    });
  });
  it("preserves an original cutoff failure by exact identity", async () => {
    const primary = new Error("synthetic-cutoff");
    const fixture = actualRun(primary);
    const completion = fixture.run();
    fixture.child.stderr.emit("data", diagnostic(true));
    fixture.child.emit("close", 5, null);
    await expect(completion).rejects.toBe(primary);
    expect(fixture.facts()).toEqual({
      remainingCalls: 2,
      timerBudget: 500,
      cleared: true,
    });
  });
});

const runtimeClosure = (omitHelper = false) => {
  const manifest = compileCapabilityManifest(
    JSON.parse(
      readFileSync(resolve(root, "capability-manifest.json"), "utf8"),
    ) as CapabilityManifest,
  );
  const scenario = manifest.scenarios.find(
    ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
  );
  if (!scenario) throw new Error("missing-codex-scenario");
  const files = new Map(
    scenario.runtimeArtifacts
      .filter(
        ({ destination }) =>
          !omitHelper || destination !== "codex-trace-child-diagnostics.mjs",
      )
      .map((artifact) => [artifact.destination, artifact.source]),
  );
  for (const [destination, source] of files) {
    if (source.kind !== "integration") continue;
    const ast = ts.createSourceFile(
      destination,
      readFileSync(resolve(root, source.path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of ast.statements) {
      if (
        (!ts.isImportDeclaration(statement) &&
          !ts.isExportDeclaration(statement)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const edge = statement.moduleSpecifier.text;
      if (edge.startsWith("./") && !files.has(edge.slice(2)))
        throw new Error("runtime-helper-missing");
    }
  }
};

describe("actual manifest-selected static runtime closure", () => {
  it("stages the private helper through existing authenticated sources and COPY", () => {
    expect(() => {
      runtimeClosure();
    }).not.toThrow();
    const staging = readFileSync(resolve(root, "run-scenarios.mjs"), "utf8");
    expect(staging).toContain(
      "for (const artifact of scenario.runtimeArtifacts)",
    );
    expect(staging).toContain("`runtime/${artifact.destination}`");
    expect(staging).toContain('"COPY runtime ./runtime"');
  });
  it("causally rejects omitting the extracted helper", () => {
    expect(() => {
      runtimeClosure(true);
    }).toThrow("runtime-helper-missing");
  });
});
