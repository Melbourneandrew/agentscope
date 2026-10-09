import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { deriveIdentityBundle } from "@agentscope/protocol";
import { expect, it } from "vitest";

const readIntegration = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "..", name), "utf8");

const graphForIdentity = (identity: {
  traceId: string;
  spanIds: string[];
}) => ({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              name: "codex.turn",
              traceId: identity.traceId,
              spanId: identity.spanIds[0],
            },
            {
              name: "codex.response",
              traceId: identity.traceId,
              spanId: identity.spanIds[1],
              parentSpanId: identity.spanIds[0],
            },
          ],
        },
      ],
    },
  ],
});
it("parses only the same bounded descriptor bytes bound to the reviewed fixture digest", () => {
  const source = readIntegration("run-scenarios.mjs");
  const start = source.indexOf("const readAdmissionComponentFixture =");
  const end = source.indexOf(
    "const controller = new AbortController();",
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  let bytes = Buffer.from('{"fixture":"held-reviewed-bytes"}');
  let size = bytes.length;
  let openFailure = false;
  const parsed: unknown[] = [];
  const closed: number[] = [];
  const read = runInNewContext(
    `${source.slice(start, end)}; readAdmissionComponentFixture`,
    {
      workspaceRoot: "/held-workspace",
      resolve,
      Buffer,
      createHash,
      constants: { O_RDONLY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 },
      openSync: (_path: string, flags: number) => {
        expect(flags).toBe(7);
        if (openFailure) throw new Error("PRIVATE_RAW_CANARY");
        return 7;
      },
      fstatSync: () => ({ isFile: () => true, size }),
      readSync: (
        _fd: number,
        target: Buffer,
        offset: number,
        length: number,
      ) => {
        const count = Math.min(length, Math.max(0, bytes.length - offset));
        bytes.copy(target, offset, offset, offset + count);
        return count;
      },
      closeSync: (fd: number) => {
        closed.push(fd);
      },
      parseHarnessSanitizedFixture: (value: unknown) => {
        parsed.push(value);
        return value;
      },
    },
  ) as (value: unknown) => unknown;
  const artifact = {
    path: "fixture.json",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const evidence = { admission: { component: { fixture: artifact } } };
  expect(read(evidence)).toEqual({ fixture: "held-reviewed-bytes" });
  expect(closed).toEqual([7]);
  expect(parsed).toHaveLength(1);
  bytes = Buffer.from('{"fixture":"caller-forged-labels"}');
  size = bytes.length;
  expect(() => {
    read(evidence);
  }).toThrow("integration.harness-scenario-admission.invalid");
  expect(parsed).toHaveLength(1);
  size = 16_777_217;
  expect(() => {
    read(evidence);
  }).toThrow("integration.harness-scenario-admission.invalid");
  openFailure = true;
  expect(() => {
    read(evidence);
  }).toThrow("integration.harness-scenario-admission.invalid");
  expect(closed).toEqual([7, 7, 7]);
  expect(parsed).toHaveLength(1);
});
it("binds outer completion to held native identity and the same observed graph", () => {
  const source = readIntegration("run-scenarios.mjs");
  const start = source.indexOf("const codexCollectorExpectation =");
  const end = source.indexOf(
    "// eslint-disable-next-line complexity -- exact closed container terminal witness",
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const native = {
    kind: "codex-tui-native",
    nativeSessionId: "session-1",
    nativeTurnId: "turn-1",
    nativeModelName: "fixture-model",
  };
  const partial = { resultStatus: "partial", harnessObservation: native };
  const fixtureResults = new Map<string, unknown>([["run-1", partial]]);
  let observedGraph: unknown;
  let expected:
    | {
        sessionId: string;
        modelName: string;
        identity: { traceId: string; spanIds: string[] };
        unavailableContext: unknown[];
      }
    | undefined;
  const complete = runInNewContext(
    `${source.slice(start, end)}; completeCodexCollectorFixture`,
    {
      fixtureResults,
      // The public hostile-input boundary rejects foreign VM prototypes.
      // Transfer this actual-source call input into the public API's realm.
      deriveIdentityBundle: (
        input: Parameters<typeof deriveIdentityBundle>[0],
      ) => deriveIdentityBundle(structuredClone(input)),
      manifest: {
        scenarios: [
          { scenarioId: "codex-tui-trace-smoke", harnessEvidenceId: "codex" },
        ],
        evidence: [
          {
            evidenceId: "codex",
            harnessId: "codex",
            representativeVersion: "0.149.1",
          },
        ],
      },
      observeSelectedWriterOtlp: (
        _bytes: Buffer,
        canaries: string[],
        expectation: NonNullable<typeof expected>,
      ) => {
        expected = expectation;
        expect(canaries).toContain("DUMMY_SECRET_KEY");
        observedGraph ??= graphForIdentity(expectation.identity);
        return {
          graph: observedGraph,
          transport: { graphSha256: "a".repeat(64) },
        };
      },
      // Schema/helper grammar is independently exercised in their real tests;
      // this actual-source case isolates native ownership and join projection.
      sanitizeFixtureResult: (value: unknown) => value,
    },
  ) as (plan: { runId: string; scenarioId: string }, batches: Buffer[]) => void;
  const plan = { runId: "run-1", scenarioId: "codex-tui-trace-smoke" };
  complete(plan, [Buffer.from("bounded-observed-wire")]);
  expect(expected).toMatchObject({
    sessionId: "session-1",
    modelName: "fixture-model",
  });
  expect(expected?.unavailableContext).toHaveLength(6);
  expect(fixtureResults.get(plan.runId)).toMatchObject({
    resultStatus: "complete",
    harnessObservation: {
      canonicalGraphDigest: "a".repeat(64),
      spanIds: expected?.identity.spanIds,
      contextDisposition: "unversioned-workspace-redacted",
      nativeSessionId: "session-1",
      nativeTurnId: "turn-1",
      nativeModelName: "fixture-model",
      resourceSpanCount: 1,
    },
    destinationLedger: { retrieval: [] },
  });
  expect(fixtureResults.get(plan.runId)).not.toHaveProperty(
    "harnessObservation.canonicalGraph",
  );
  const substituted = {
    ...partial,
    harnessObservation: { ...native, nativeTurnId: "other-turn" },
  };
  fixtureResults.set(plan.runId, substituted);
  expect(() => {
    complete(plan, [Buffer.from("same-wire")]);
  }).toThrow("integration.isolation.collector-native");
  expect(fixtureResults.get(plan.runId)).toBe(substituted);
  expect(() => {
    complete(plan, []);
  }).toThrow("integration.isolation.collector-native");
  expect(() => {
    complete(plan, [Buffer.from("a"), Buffer.from("b")]);
  }).toThrow("integration.isolation.collector-native");
});
