import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  transpileModule,
  ScriptTarget,
  createSourceFile,
  ScriptKind,
  isImportDeclaration,
  isExportDeclaration,
  isStringLiteral,
  isCallExpression,
  SyntaxKind,
  type Node,
  forEachChild,
} from "typescript";
import { describe, expect, it } from "vitest";
import { kernelError, trustedErrorCode } from "../internal/kernel-errors.js";
import type { SelectedPtyExecutionReceipt } from "../pty-terminal-contract.js";
import { executeSelectedPtyTransportForTest } from "../internal/headless-supervisor-backend.js";
import {
  classifyPtyPumpFailure,
  exactPtyExit,
  exactPtyObservation,
  exactPtyRead,
  exactPtyWrite,
} from "../internal/pty-transport-observations.js";

const backend = readFileSync(
  new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
  "utf8",
);
const integration = new URL("../../../../tests/integration/", import.meta.url);
type PumpDiagnostic = NonNullable<
  SelectedPtyExecutionReceipt["pumpFailureDiagnostic"]
>;
type ProjectedReceipt = {
  outcome: string;
  checkpointProgressDiagnostic: string | null;
  pumpFailureDiagnostic?: PumpDiagnostic | null;
};

describe("first owned PTY pump diagnostic", () => {
  it.each([
    ["testkit.headless.observer.read", "observer-read"],
    ["testkit.headless.observer.identity", "observer-identity"],
    ["testkit.pty.transport", "transport"],
    ["testkit.pty.geometry", "geometry"],
    ["testkit.pty.checkpoint-witness", "checkpoint-witness"],
    ["testkit.headless.execution.deadline", "execution-deadline"],
    ["testkit.headless.kernel.failure", "unknown"],
  ])("maps only registered %s", (code, category) => {
    expect(classifyPtyPumpFailure(kernelError(code))).toBe(category);
  });

  it("does not inspect caller error properties or canaries", () => {
    let reads = 0;
    const hostile = Object.defineProperties(
      {},
      Object.fromEntries(
        ["message", "code", "cause"].map((key) => [
          key,
          {
            get: () => {
              reads++;
              throw new Error("private-canary");
            },
          },
        ]),
      ),
    );
    for (const error of [
      hostile,
      new Proxy(
        {},
        {
          get: () => {
            reads++;
            throw new Error("private-canary");
          },
        },
      ),
      { code: "testkit.pty.transport" },
      null,
    ])
      expect(classifyPtyPumpFailure(error)).toBe("unknown");
    expect(reads).toBe(0);
  });

  it.each([false, true])(
    "latches the first catch; original cutoff exhausted=%s",
    (exhausted) => {
      const start = backend.indexOf("if (pumpFailureDiagnostic === undefined)");
      const end =
        backend.indexOf("transportError = true;", start) +
        "transportError = true;".length;
      expect(start).toBeGreaterThan(0);
      const code = transpileModule(
        `let pumpFailureDiagnostic; let transportError = false;
      const observe = (error, pumpOperation) => { ${backend.slice(start, end)} };
      observe(first, 'checkpoint-freeze'); observe(second, 'read');
      ({pumpFailureDiagnostic, transportError});`,
        { compilerOptions: { target: ScriptTarget.ES2022 } },
      ).outputText;
      let clockReads = 0;
      const result = runInNewContext(
        code,
        {
          first: kernelError("testkit.headless.observer.read"),
          second: kernelError("testkit.pty.transport"),
          safeReflectApply: Reflect.apply,
          freeze: Object.freeze,
          classifyPtyPumpFailure,
          performance: {},
          performanceNow: () => {
            clockReads++;
            return exhausted ? 101 : 99;
          },
          processRequest: { monotonicExecutionDeadlineMs: 100 },
        },
        { timeout: 1000 },
      ) as { transportError: boolean; pumpFailureDiagnostic: PumpDiagnostic };
      expect(result.transportError).toBe(true);
      expect(result.pumpFailureDiagnostic).toEqual({
        operation: "checkpoint-freeze",
        category: "observer-read",
        originalExecutionDeadlineExhausted: exhausted,
      });
      expect(Object.isFrozen(result.pumpFailureDiagnostic)).toBe(true);
      expect(clockReads).toBe(1);
    },
  );
});

describe("actual selected pump operation placement", () => {
  it("retains the first failed freeze without changing outcome or cleanup", async () => {
    const challenge = "a".repeat(64);
    const stdin = new TextEncoder().encode(`${challenge}\n\u0004`);
    const digest = (value: string | Uint8Array): string =>
      createHash("sha256").update(value).digest("hex");
    const now = performance.now();
    const receipt = await executeSelectedPtyTransportForTest(
      {
        completion: { kind: "semantic-marker" },
        readiness: { kind: "challenge-marker", challenge },
        initialGeometry: { columns: 40, rows: 12 },
        interpreter: {
          path: "/usr/local/bin/node",
          sha256: digest("node-interpreter"),
        },
        scriptSha256: digest("installed-cli-driver"),
        interaction: {
          trigger: "immediate",
          actions: [
            {
              action: "input",
              byteLength: 65,
              inputSha256: digest(stdin.subarray(0, 65)),
            },
            {
              action: "checkpoint-process-topology",
              topology: "root-with-contained-process-set",
            },
            { action: "wait-for-semantic-completion" },
            {
              action: "input",
              byteLength: 1,
              inputSha256: digest(stdin.subarray(65)),
            },
          ],
        },
        process: {
          runId: "0123456789abcdef",
          requestFingerprint: `sha256:${digest("selected-pty-request")}`,
          executable: "/scenario/installed-cli-driver",
          arguments: ["narrow-terminal"],
          cwd: "/scenario",
          environment: { LANG: "C.UTF-8" },
          stdin,
          stdoutLimitBytes: 4096,
          stderrLimitBytes: 4096,
          monotonicStartupDeadlineMs: now + 500,
          monotonicExecutionDeadlineMs: now + 1000,
          monotonicShutdownDeadlineMs: now + 2000,
          terminationGraceMs: 50,
        },
      },
      "checkpoint-process-churn",
    );
    expect(receipt).toMatchObject({
      outcome: "transport-failed",
      cleanup: "clean",
      processJoined: true,
      inputBytesWritten: 65,
      pumpFailureDiagnostic: {
        operation: "checkpoint-freeze",
        category: "unknown",
        originalExecutionDeadlineExhausted: false,
      },
    });
    expect(Object.isFrozen(receipt.pumpFailureDiagnostic)).toBe(true);
    expect(JSON.stringify(receipt.pumpFailureDiagnostic)).not.toContain(
      "testkit.",
    );
  });
});

describe("extracted exact transport validators", () => {
  it("preserves valid observation identities and rejects wrong shapes", () => {
    const exit = { code: 0, signal: 0 };
    const geometry = { columns: 40, rows: 12 };
    const observation = {
      ...geometry,
      isTTY: true,
      canonical: true,
      eofByte: 4,
    };
    const read = { status: "data" as const, bytes: Buffer.from("a") };
    const write = { status: "complete" as const, bytesWritten: 1 };
    expect(exactPtyExit(exit)).toBe(exit);
    expect(exactPtyObservation(observation, geometry, true)).toBe(observation);
    expect(exactPtyRead(read)).toBe(read);
    expect(exactPtyWrite(write, 1)).toBe(write);
    for (const invoke of [
      () => exactPtyExit({ code: 1, signal: 1 }),
      () =>
        exactPtyObservation(
          { ...observation, canonical: false },
          geometry,
          true,
        ),
      () => exactPtyRead({ status: "data", bytes: Buffer.alloc(4097) }),
      () => exactPtyWrite({ status: "partial", bytesWritten: 1 }, 1),
    ])
      expect(invoke).toThrow();
  });

  it("rejects proxies and accessor observations without invoking them", () => {
    let reads = 0;
    const geometry = { columns: 40, rows: 12 };
    const validators = [
      (value: unknown) => exactPtyExit(value as never),
      (value: unknown) => exactPtyObservation(value as never, geometry, true),
      (value: unknown) => exactPtyRead(value as never),
      (value: unknown) => exactPtyWrite(value as never, 1),
    ];
    const hostile = Object.defineProperty({ status: "data" }, "bytes", {
      get: () => {
        reads++;
        throw new Error("private-canary");
      },
    });
    for (const value of [
      hostile,
      new Proxy(
        {},
        {
          get: () => {
            reads++;
            throw new Error("private-canary");
          },
        },
      ),
    ]) {
      for (const validate of validators) {
        try {
          validate(value);
          throw new Error("unexpected acceptance");
        } catch (error) {
          expect(trustedErrorCode(error)).toBeDefined();
        }
      }
    }
    expect(reads).toBe(0);
  });
});

describe("content-free receipt projection and actual runtime closure", () => {
  it("keeps v4 unchanged and validates v5 without metadata retention", () => {
    const source = readFileSync(
      new URL("codex-pty-research.mjs", integration),
      "utf8",
    );
    const start = source.indexOf("const receiptOutcomes =");
    const end = source.indexOf("export const codexPtyResearchHints", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const pure = source.slice(start, end);
    const { project, valid } = runInNewContext(
      `${pure.replaceAll("export const", "const")} ({project:projectUntrustedCodexPtyReceipt,valid:validUntrustedCodexPtyReceipt});`,
      { Object, Reflect },
      { timeout: 1000 },
    ) as {
      project: (
        receipt: unknown,
        version?: number,
      ) => ProjectedReceipt | undefined;
      valid: (receipt: unknown, version?: number) => boolean;
    };
    const diagnostic = {
      operation: "read",
      category: "unknown",
      originalExecutionDeadlineExhausted: false,
    };
    const receipt = {
      outcome: "transport-failed",
      pumpFailureDiagnostic: diagnostic,
      raw: "private-canary",
    };
    expect(project(receipt)).toEqual({
      outcome: "transport-failed",
      checkpointProgressDiagnostic: null,
    });
    const projected = project(receipt, 5);
    // The retained packet is parsed JSON, not a VM-realm object identity.
    expect(valid(JSON.parse(JSON.stringify(projected)), 5)).toBe(true);
    expect(valid(projected, 4)).toBe(false);
    expect(JSON.stringify(projected)).not.toContain("private-canary");
    expect(
      project({ outcome: "timeout" }, 5)?.pumpFailureDiagnostic,
    ).toBeNull();
    for (const changed of [
      { ...diagnostic, category: "private-canary" },
      { ...diagnostic, operation: "private-canary" },
      { ...diagnostic, originalExecutionDeadlineExhausted: 1 },
      { ...diagnostic, raw: "private-canary" },
      Object.defineProperty({ ...diagnostic }, "operation", {
        get: () => {
          throw new Error("private-canary");
        },
      }),
    ])
      expect(
        project({ ...receipt, pumpFailureDiagnostic: changed }, 5),
      ).toBeUndefined();
    expect(valid({ ...projected, pumpFailureDiagnostic: undefined }, 5)).toBe(
      false,
    );
  });
});

describe("same runner optional-field projection", () => {
  it.each([false, true])(
    "preserves fixed fields, absence and read counts: present=%s",
    (present) => {
      const source = readFileSync(new URL("runner.mjs", integration), "utf8");
      const names = [
        "pumpFailureDiagnostic",
        "challengedReadinessProgress",
        "checkpointProgressDiagnostic",
        "postSubmissionIdleDiagnostic",
        "postSubmissionIdleAtTitleDiagnostic",
      ];
      expect(
        [
          ...source.matchAll(/\.\.\.optionalReceiptDiagnostic\("([^"]+)"\)/gu),
        ].map((match) => match[1]),
      ).toEqual(names);
      let reads = 0;
      const observation = present
        ? Object.freeze({ observed: true })
        : undefined;
      const receipt = Object.defineProperties(
        {},
        Object.fromEntries(
          names.map((name) => [
            name,
            {
              get: () => {
                reads++;
                return observation;
              },
            },
          ]),
        ),
      );
      const start = source.indexOf("    const optionalReceiptDiagnostic =");
      const end = source.indexOf("    const ptyTerminalReceipt =", start);
      const copy = runInNewContext(
        `${source.slice(start, end)} optionalReceiptDiagnostic;`,
        { receipt },
        { timeout: 1000 },
      ) as (name: string) => Record<string, unknown>;
      const projected = Object.assign({}, ...names.map(copy)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(projected)).toEqual(present ? names : []);
      expect(reads).toBe(names.length * (present ? 2 : 1));
      if (present)
        for (const name of names) expect(projected[name]).toBe(observation);
    },
  );
});

describe("actual selected runtime closure", () => {
  it("includes the new emitted helper in the actual selected relative graph", () => {
    const authority = readFileSync(
      new URL("immutable-candidate-authority.mjs", integration),
      "utf8",
    );
    expect(authority).toContain(
      'export { selectedRuntimeFiles } from "./selected-runtime-files.mjs";',
    );
    const roster = readFileSync(
      new URL("selected-runtime-files.mjs", integration),
      "utf8",
    );
    const start = roster.indexOf("export const selectedRuntimeFiles =");
    const end = roster.indexOf("]);", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const files = runInNewContext(
      `${roster.slice(start, end + 3).replace("export const", "const")} selectedRuntimeFiles;`,
      {},
      { timeout: 1000 },
    ) as string[];
    const root = resolve(import.meta.dirname, "../../dist");
    const edges = new Map<string, string[]>();
    for (const name of files.filter((file) => file.endsWith(".js"))) {
      const relativeTargets: string[] = [];
      const source = createSourceFile(
        name,
        readFileSync(resolve(root, name.replace(/^testkit\//u, "")), "utf8"),
        ScriptTarget.Latest,
        true,
        ScriptKind.JS,
      );
      const visit = (node: Node): void => {
        const specifier =
          isImportDeclaration(node) || isExportDeclaration(node)
            ? node.moduleSpecifier
            : isCallExpression(node) &&
                node.expression.kind === SyntaxKind.ImportKeyword
              ? node.arguments[0]
              : undefined;
        if (
          specifier &&
          isStringLiteral(specifier) &&
          specifier.text.startsWith(".")
        ) {
          const target = resolve(
            dirname(resolve("/", name)),
            specifier.text,
          ).slice(1);
          relativeTargets.push(target);
        }
        forEachChild(node, visit);
      };
      visit(source);
      edges.set(name, relativeTargets);
    }
    const missing = (selected: readonly string[]) =>
      selected.flatMap((name) =>
        (edges.get(name) ?? []).filter((target) => !selected.includes(target)),
      );
    expect(missing(files)).toEqual([]);
    expect(
      missing(
        files.filter(
          (name) => !name.endsWith("/pty-transport-observations.js"),
        ),
      ),
    ).toContain("testkit/internal/pty-transport-observations.js");
    expect(
      readFileSync(new URL("run-scenarios.mjs", integration), "utf8"),
    ).toContain("for (const file of selectedRuntimeFiles)");
  });
});
