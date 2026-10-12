import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  capabilityManifestIdentity,
  compileCapabilityManifest,
} from "./manifest.js";
import {
  assertMockServerFinalLedger,
  projectMockServerRequests,
  snapshotMockServerTraffic,
} from "../mockserver-control.mjs";
// @ts-expect-error private integration module has no published declaration
import * as finalLedgerModule from "../mockserver-final-ledger.mjs";
const { projectFirstUnmatchedModelRoute } = finalLedgerModule as {
  projectFirstUnmatchedModelRoute: (
    rows: unknown,
    routes: unknown,
  ) =>
    | Readonly<{
        method: string;
        tupleSha256: string;
        matchCount: number;
      }>
    | undefined;
};
const runId = "0123456789abcdef";
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const routeDiagnosticFixture = () => {
  const route = { method: "POST", path: "/v1/messages" };
  const unknown = {
    method: "GET",
    path: "/private-synthetic?canary=PRIVATE_PATH",
    role: "data-plane",
    body: "PRIVATE_BODY",
    headers: { secret: "PRIVATE_HEADER" },
  };
  return { route, unknown, catalog: { routes: [route] } };
};
describe("joined unmatched route content-free projection", () => {
  it.each([false, true])(
    "projects the real upstream serializer with marked=%s",
    (marked) => {
      const { unknown, catalog } = routeDiagnosticFixture();
      const rows = projectMockServerRequests(
        Buffer.from(
          JSON.stringify([
            {
              method: unknown.method,
              path: unknown.path,
              headers: marked
                ? {
                    "x-agentscope-final-role": ["data-plane"],
                    "x-agentscope-final-status": ["404"],
                  }
                : {},
            },
          ]),
        ),
      );
      expect(Object.hasOwn(rows[0]!, "role")).toBe(marked);
      expect(projectFirstUnmatchedModelRoute(rows, catalog)).toEqual(
        projectFirstUnmatchedModelRoute([unknown], catalog),
      );
    },
  );
  it("hashes only the exact unnormalized tuple with its domain separator", () => {
    const { unknown, catalog } = routeDiagnosticFixture();
    const value = projectFirstUnmatchedModelRoute([unknown], catalog);
    expect(value).toEqual({
      method: "GET",
      matchCount: 0,
      tupleSha256: hash(
        "agentscope.integration.unmatched-model-route.v1\0" +
          JSON.stringify([unknown.method, unknown.path]),
      ),
    });
    expect(Object.isFrozen(value)).toBe(true);
    for (const canary of [
      "PRIVATE_PATH",
      "PRIVATE_BODY",
      "PRIVATE_HEADER",
      "path",
      "headers",
    ])
      expect(JSON.stringify(value)).not.toContain(canary);
    expect(
      projectFirstUnmatchedModelRoute(
        [{ ...unknown, path: unknown.path + "/" }],
        catalog,
      )?.tupleSha256,
    ).not.toBe(value?.tupleSha256);
  });
  it("skips control, matched and ambiguous tuples without admitting them", () => {
    const { route, unknown } = routeDiagnosticFixture();
    const rows = [
      { ...unknown, role: "allowed" },
      { ...route, role: "data-plane" },
      unknown,
    ];
    const catalog = { routes: [route, { ...route }] };
    expect(projectFirstUnmatchedModelRoute(rows, catalog)).toEqual(
      projectFirstUnmatchedModelRoute([unknown], catalog),
    );
    expect(
      projectFirstUnmatchedModelRoute(rows.slice(0, 2), catalog),
    ).toBeUndefined();
    expect(
      projectFirstUnmatchedModelRoute([{ ...route, role: "data-plane" }], {
        routes: [route],
      }),
    ).toBeUndefined();
  });
});
describe("unavailable joined route diagnostic input", () => {
  it.each([
    "method",
    "path",
    "role",
    "role-accessor",
    "role-undefined",
    "sparse",
    "row-bound",
    "catalog-bound",
    "route",
    "accessor",
    "proxy",
  ])(
    "makes unsafe %s projection unavailable without reading content",
    (fault) => {
      const { unknown, catalog } = routeDiagnosticFixture();
      let rows: unknown = [unknown],
        fixture: unknown = catalog,
        reflected = 0;
      if (fault === "method") rows = [{ ...unknown, method: "get" }];
      if (fault === "path") rows = [{ ...unknown, path: "x".repeat(4097) }];
      if (fault === "role") rows = [{ ...unknown, role: "unknown" }];
      if (fault === "role-undefined") rows = [{ ...unknown, role: undefined }];
      if (fault === "role-accessor")
        rows = [
          Object.defineProperty({ ...unknown }, "role", {
            get() {
              reflected++;
              throw new Error("PRIVATE");
            },
          }),
        ];
      if (fault === "sparse") rows = new Array(1);
      if (fault === "row-bound")
        rows = Array.from({ length: 17 }, () => unknown);
      if (fault === "catalog-bound")
        fixture = {
          routes: Array.from({ length: 65 }, () => catalog.routes[0]),
        };
      if (fault === "route")
        fixture = { routes: [{ method: "POST", path: "" }] };
      if (fault === "accessor")
        rows = [
          Object.defineProperty({ ...unknown }, "path", {
            get() {
              reflected++;
              throw new Error("PRIVATE");
            },
          }),
        ];
      if (fault === "proxy")
        rows = [
          new Proxy(unknown, {
            getOwnPropertyDescriptor() {
              reflected++;
              throw new Error("PRIVATE");
            },
          }),
        ];
      expect(projectFirstUnmatchedModelRoute(rows, fixture)).toBeUndefined();
      expect(reflected).toBe(0);
    },
  );
  it("never reads body/header getters or parses their values", () => {
    const { unknown, catalog } = routeDiagnosticFixture();
    let reflected = 0;
    for (const key of ["body", "headers"])
      Object.defineProperty(unknown, key, {
        get() {
          reflected++;
          throw new Error("PRIVATE");
        },
      });
    expect(projectFirstUnmatchedModelRoute([unknown], catalog)).toBeDefined();
    expect(reflected).toBe(0);
  });
});
const joinedDiagnosticHarness = ({
  scenario = "claude-interactive-trace-smoke",
  succeeded = false,
  failure = "",
  marked = false,
} = {}) => {
  const source = readFileSync(
    new URL("../run-scenarios.mjs", import.meta.url),
    "utf8",
  );
  const publisherStart = source.indexOf("const publishMockServerDiagnostic =");
  const publisherEnd = source.indexOf(
    "/* eslint-disable complexity -- exact closed container terminal witness */",
    publisherStart,
  );
  const start = source.indexOf('    failureSlot = "join-container-wait";');
  const end = source.indexOf('    failureSlot = "join-ledger-assert";', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const events: string[] = [],
    output: string[] = [];
  const { unknown, catalog } = routeDiagnosticFixture();
  const context = {
    Buffer,
    resolve,
    plan: { runId, scenarioId: scenario },
    containerId: "synthetic",
    joinSignal: {},
    deadline: 1000,
    linuxBootMonotonicMilliseconds: () => 1,
    scenarioSucceeded: succeeded,
    modelRoutes: catalog,
    failureSlot: "",
    refusal: undefined,
    dockerWithSignal: (args: string[]) => {
      events.push(
        args[1] === "wait"
          ? "wait"
          : args[1] === "inspect"
            ? "inspect"
            : "copy",
      );
      return Promise.resolve({ stdout: "" });
    },
    assertJoinedMockServerTerminal: () => {
      events.push("terminal");
      if (failure === "terminal") throw new Error("original-terminal");
    },
    readProducerRefusal: () => {
      events.push("producer-refusal");
      return Promise.resolve(undefined);
    },
    createFinalMockServerLedgerDirectory: () => "synthetic",
    readMockServerFinalLedger: () => {
      events.push("authenticated-read");
      if (failure === "read") throw new Error("original-read");
      return Buffer.from(
        JSON.stringify([
          {
            method: unknown.method,
            path: unknown.path,
            headers: marked
              ? {
                  "x-agentscope-final-role": ["data-plane"],
                  "x-agentscope-final-status": ["404"],
                }
              : {},
          },
        ]),
      );
    },
    projectMockServerRequests,
    projectFirstUnmatchedModelRoute: (rows: unknown, routes: unknown) => {
      events.push("projection");
      if (failure === "projection") throw new Error("PRIVATE");
      return projectFirstUnmatchedModelRoute(rows, routes);
    },
    writeSync: (_fd: number, bytes: Buffer) => {
      events.push("emission");
      if (failure === "write") throw new Error("PRIVATE");
      output.push(bytes.toString("utf8"));
    },
  };
  const execute = runInNewContext(
    `${source.slice(publisherStart, publisherEnd)}; (async () => {${source.slice(start, end)}})`,
    context,
  ) as () => Promise<void>;
  return { execute, events, output };
};
describe("literal joined final ledger failure diagnostic emission", () => {
  it.each([false, true])(
    "emits only after authenticated join/read with marked=%s",
    async (marked) => {
      const input = joinedDiagnosticHarness({ marked });
      await expect(input.execute()).resolves.toBeUndefined();
      expect(input.events).toEqual([
        "wait",
        "inspect",
        "terminal",
        "producer-refusal",
        "copy",
        "copy",
        "authenticated-read",
        "projection",
        "emission",
      ]);
      expect(input.output).toHaveLength(1);
      expect(Buffer.byteLength(input.output[0]!)).toBeLessThanOrEqual(256);
      const value = JSON.parse(
        input.output[0]!.slice(
          "integration.isolation.mockserver-ledger-diagnostic:".length,
        ),
      ) as Record<string, unknown>;
      expect(Object.keys(value).sort()).toEqual([
        "matchCount",
        "method",
        "runId",
        "stage",
        "tupleSha256",
      ]);
      expect(value.stage).toBe("joined-unmatched-route");
      for (const canary of [
        "PRIVATE_PATH",
        "PRIVATE_BODY",
        "PRIVATE_HEADER",
        "canary=",
      ])
        expect(input.output[0]).not.toContain(canary);
    },
  );
  it.each([{ succeeded: true }, { scenario: "codex-tui-trace-smoke" }])(
    "does not project successful or other selected scenarios %j",
    async (options) => {
      const input = joinedDiagnosticHarness(options);
      await input.execute();
      expect(input.events).not.toContain("projection");
      expect(input.output).toEqual([]);
    },
  );
  it.each(["terminal", "read"])(
    "keeps original %s authentication refusal without emitting",
    async (failure) => {
      const input = joinedDiagnosticHarness({ failure });
      await expect(input.execute()).rejects.toThrow(`original-${failure}`);
      expect(input.events).not.toContain("projection");
      expect(input.output).toEqual([]);
    },
  );
  it.each(["projection", "write"])(
    "keeps failed outcome when optional %s is unavailable",
    async (failure) => {
      const input = joinedDiagnosticHarness({ failure });
      await expect(input.execute()).resolves.toBeUndefined();
      expect(input.output).toEqual([]);
    },
  );
});
describe("bounded client pathname projection", () => {
  const observe = (path: string) =>
    snapshotMockServerTraffic(
      {
        runId,
        entries: [
          {
            method: "POST",
            path,
            role: "data-plane",
            status: 200,
            bodyBytes: 0,
            bodySha256: hash(""),
          },
        ],
      },
      runId,
    );
  it("retains the actual Gemini method pathname without accepting query material", () => {
    const path = "/v1beta/models/fixture-model:generateContent";
    expect(observe(path).entries[0]?.path).toBe(path);
    expect(observe(`/${"a".repeat(255)}`).entries[0]?.path).toHaveLength(256);
  });
  it.each([
    "/v1beta/models/fixture-model:generateContent?key=DUMMY",
    "/v1beta/models/fixture-model:generateContent#fragment",
    "/v1beta/models/fixture-model%3AgenerateContent",
    "/v1beta/models/fixture model:generateContent",
    "/v1beta/models/fixture-model:generateContent\n",
    "http://foreign.invalid/v1beta/models/model:generateContent",
    `/${"a".repeat(256)}`,
    "/",
  ])("refuses non-pathname or oversized input %s", (path) => {
    expect(() => observe(path)).toThrow("integration.mockserver.control");
  });
});
const finalLedgerFixture = () => {
  const routes = [
    {
      routeId: "route",
      method: "POST",
      path: "/model",
      requestBody: { input: "one" },
    },
  ];
  const scenario = { scenarioId: "ordinary", modelRoutes: ["route"] };
  const body = JSON.stringify(routes[0]!.requestBody);
  const ledger = projectMockServerRequests(
    Buffer.from(
      JSON.stringify([
        {
          method: "POST",
          path: "/model",
          body,
          headers: {
            "x-agentscope-final-role": ["data-plane"],
            "x-agentscope-final-status": ["200"],
          },
        },
        {
          method: "GET",
          path: "/agentscope-unmatched",
          headers: {
            "x-agentscope-final-role": ["data-plane"],
            "x-agentscope-final-status": ["404"],
          },
        },
      ]),
    ),
  );
  const fixture = { modelLedger: { entries: ledger } };
  const traffic = snapshotMockServerTraffic(
    {
      runId,
      entries: ledger.map((row, index) => ({
        method: row.method,
        path: row.path,
        role: "data-plane",
        status: index === 0 ? 200 : 404,
        bodyBytes: row.bodyBytes,
        bodySha256: row.bodySha256,
      })),
    },
    runId,
  );
  const checkLedger = (
    rows: typeof ledger,
    observed = fixture,
    selected = routes,
  ) => {
    assertMockServerFinalLedger(
      rows,
      observed,
      { routes: selected },
      scenario,
      { traffic, runId },
    );
  };
  return { ledger, routes, scenario, traffic, checkLedger, fixture, body };
};
describe("same complete upstream final ledger", () => {
  it("refuses malformed comparison envelopes and substituted independent run bindings before reads", () => {
    const { ledger, fixture, routes, scenario, traffic } = finalLedgerFixture();
    let reads = 0;
    const getter = { traffic, runId };
    Object.defineProperty(getter, "runId", {
      enumerable: true,
      get() {
        reads++;
        return runId;
      },
    });
    for (const comparison of [
      undefined,
      null,
      {},
      { traffic },
      { runId },
      { traffic, runId, extra: true },
      { traffic, runId: "fedcba9876543210" },
      getter,
      new Proxy(
        { traffic, runId },
        {
          ownKeys() {
            reads++;
            return [];
          },
        },
      ),
    ])
      expect(() => {
        Reflect.apply(assertMockServerFinalLedger, undefined, [
          ledger,
          fixture,
          { routes },
          scenario,
          comparison,
        ]);
      }).toThrow();
    expect(reads).toBe(0);
  });
  it("compares all control traffic before deriving the model-only view", () => {
    const { ledger, routes, scenario, traffic, checkLedger, fixture } =
      finalLedgerFixture();
    expect(() => {
      checkLedger(ledger);
    }).not.toThrow();
    const ready = {
      ...ledger[1]!,
      path: "/mockserver/ready",
      role: "readiness" as const,
      status: 200,
    };
    const full = [ready, ...ledger];
    const fullTraffic = snapshotMockServerTraffic(
      {
        runId,
        entries: [
          {
            method: ready.method,
            path: ready.path,
            role: ready.role,
            status: ready.status,
            bodyBytes: ready.bodyBytes,
            bodySha256: ready.bodySha256,
          },
          ...traffic.entries,
        ],
      },
      runId,
    );
    const checkFull = (rows: typeof ledger) => {
      assertMockServerFinalLedger(rows, fixture, { routes }, scenario, {
        traffic: fullTraffic,
        runId,
      });
    };
    expect(() => {
      checkFull(full);
    }).not.toThrow();
    for (const changed of [
      ledger,
      [...full, ready],
      [...full].reverse(),
      [{ ...ready, status: 503 }, ...ledger],
    ])
      expect(() => {
        checkFull(changed);
      }).toThrow();
  });
  it("preserves all original model omission, substitution, order and route refusals", () => {
    const { ledger, routes, checkLedger, body } = finalLedgerFixture();
    for (const changed of [
      ledger.slice(0, 1),
      [...ledger, ledger[0]!],
      [
        { ...ledger[0]!, bodySha256: hash(body.replace("one", "two")) },
        ledger[1]!,
      ],
      [...ledger].reverse(),
    ])
      expect(() => {
        checkLedger(changed);
      }).toThrow();
    expect(() => {
      checkLedger(ledger, { modelLedger: { entries: [] } });
    }).toThrow();
    expect(() => {
      checkLedger(ledger, { modelLedger: { entries: ledger } }, [
        ...routes,
        routes[0]!,
      ]);
    }).toThrow();
  });
});

const claudeLedgerFixture = () => {
  const bodies = [
    JSON.stringify({ messages: [{ role: "user", content: "Read" }] }),
    JSON.stringify({ messages: [{ role: "user", content: "tool_result" }] }),
  ];
  const ledger = projectMockServerRequests(
    Buffer.from(
      JSON.stringify([
        ...bodies.map((body) => ({
          method: "POST",
          path: "/v1/messages",
          body,
          headers: {
            "x-agentscope-final-role": ["data-plane"],
            "x-agentscope-final-status": ["200"],
          },
        })),
        {
          method: "HEAD",
          path: "/api/hello",
          headers: {
            "x-agentscope-final-role": ["data-plane"],
            "x-agentscope-final-status": ["200"],
          },
        },
      ]),
    ),
  );
  const native = {
    kind: "claude-code-native",
    modelRequestBodySha256: bodies.map(hash),
  };
  const routes = [
    { routeId: "anthropic-messages", method: "POST", path: "/v1/messages" },
    {
      routeId: "anthropic-connectivity-probe",
      method: "HEAD",
      path: "/api/hello",
    },
  ];
  const scenario = {
    scenarioId: "claude-interactive-trace-smoke",
    modelRoutes: ["anthropic-connectivity-probe", "anthropic-messages"],
  };
  // Rebind local traffic AND the fixture model view to each candidate ledger.
  // Refusals below therefore exercise the independent native/route oracle.
  const check = (
    rows = ledger,
    observation: unknown = native,
    selected = routes,
    selectedScenario = scenario,
  ) => {
    const traffic = snapshotMockServerTraffic(
      {
        runId,
        entries: rows.map((row) => ({
          method: row.method,
          path: row.path,
          role: row.role,
          status: row.status,
          bodyBytes: row.bodyBytes,
          bodySha256: row.bodySha256,
        })),
      },
      runId,
    );
    Reflect.apply(assertMockServerFinalLedger, undefined, [
      rows,
      {
        modelLedger: {
          entries: rows.filter((row) => row.role === "data-plane"),
        },
        harnessObservation: observation,
      },
      { routes: selected },
      selectedScenario,
      { traffic, runId },
    ]);
  };
  return { ledger, native, routes, scenario, check };
};
describe("existing Codex final ledger", () => {
  it("preserves the existing Codex single native request binding", () => {
    const { ledger, routes } = finalLedgerFixture();
    const rows = ledger.slice(0, 1);
    const fixture = {
      modelLedger: { entries: rows },
      harnessObservation: { modelRequestBodySha256: rows[0]!.bodySha256 },
    };
    const check = (hashValue: string) => {
      assertMockServerFinalLedger(
        rows,
        {
          ...fixture,
          harnessObservation: { modelRequestBodySha256: hashValue },
        },
        { routes },
        { scenarioId: "codex-tui-trace-smoke", modelRoutes: ["route"] },
        {
          traffic: snapshotMockServerTraffic(
            {
              runId,
              entries: rows.map((row) => ({
                method: row.method,
                path: row.path,
                role: row.role,
                status: row.status,
                bodyBytes: row.bodyBytes,
                bodySha256: row.bodySha256,
              })),
            },
            runId,
          ),
          runId,
        },
      );
    };
    expect(() => {
      check(rows[0]!.bodySha256);
    }).not.toThrow();
    expect(() => {
      check(hash("other"));
    }).toThrow();
  });
});
describe("actual compiled Claude route composition", () => {
  it("passes the actual manifest compiler through protected selection and final oracle", () => {
    const compiled = compileCapabilityManifest(
      JSON.parse(
        readFileSync(
          new URL("../capability-manifest.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const scenario = compiled.scenarios.find(
      (entry) => entry.scenarioId === "claude-interactive-trace-smoke",
    )!;
    const source = readFileSync(
      new URL("../run-scenarios.mjs", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const isGateCapableMockServer =");
    const end = source.indexOf("const confinementArguments =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const select = runInNewContext(
      source.slice(start, end) + "isGateCapableMockServer;",
    ) as (scenario: unknown) => boolean;
    expect(select(scenario)).toBe(true);
    const { ledger, native, routes, check } = claudeLedgerFixture();
    expect(() => {
      check(ledger, native, routes, scenario);
    }).not.toThrow();
  });
  it("accepts the compiler's canonical selected routes at the final oracle", () => {
    const compiled = compileCapabilityManifest(
      JSON.parse(
        readFileSync(
          new URL("../capability-manifest.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const scenario = compiled.scenarios.find(
      (entry) => entry.scenarioId === "claude-interactive-trace-smoke",
    )!;
    const { ledger, native, routes, check } = claudeLedgerFixture();
    expect(() => {
      check(ledger, native, routes, scenario);
    }).not.toThrow();
  });
});
describe("actual compiled Claude route refusals", () => {
  it("rejects duplicate compilation and nonmatching compiled route membership", () => {
    const baseline = JSON.parse(
      readFileSync(
        new URL("../capability-manifest.json", import.meta.url),
        "utf8",
      ),
    ) as Parameters<typeof capabilityManifestIdentity>[0];
    const source = readFileSync(
      new URL("../run-scenarios.mjs", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const isGateCapableMockServer =");
    const end = source.indexOf("const confinementArguments =", start);
    const select = runInNewContext(
      source.slice(start, end) + "isGateCapableMockServer;",
    ) as (scenario: unknown) => boolean;
    for (const modelRoutes of [
      ["anthropic-messages"],
      ["anthropic-connectivity-probe"],
      ["anthropic-connectivity-probe", "anthropic-messages", "unknown"],
    ]) {
      const input = structuredClone(baseline);
      input.scenarios.find(
        (entry) => entry.scenarioId === "claude-interactive-trace-smoke",
      )!.modelRoutes = modelRoutes;
      const compiled = compileCapabilityManifest({
        ...input,
        manifestIdentity: capabilityManifestIdentity(input),
      });
      const scenario = compiled.scenarios.find(
        (entry) => entry.scenarioId === "claude-interactive-trace-smoke",
      )!;
      expect(select(scenario)).toBe(false);
      const { ledger, native, routes, check } = claudeLedgerFixture();
      expect(() => {
        check(ledger, native, routes, scenario);
      }).toThrow("integration.mockserver.control");
    }
    const duplicated = structuredClone(baseline);
    duplicated.scenarios.find(
      (entry) => entry.scenarioId === "claude-interactive-trace-smoke",
    )!.modelRoutes = [
      "anthropic-connectivity-probe",
      "anthropic-messages",
      "anthropic-messages",
    ];
    expect(() =>
      compileCapabilityManifest({
        ...duplicated,
        manifestIdentity: capabilityManifestIdentity(duplicated),
      }),
    ).toThrow("integration.manifest.invalid");
  });
});
describe("Claude exact connectivity probe final ledger", () => {
  it("retains one exact empty connectivity probe separately from the primary pair", () => {
    const { ledger, check } = claudeLedgerFixture();
    const probe = ledger[2]!;
    expect(() => {
      check([probe, ...ledger.slice(0, 2)]);
    }).not.toThrow();
    for (const rows of [
      ledger.slice(0, 2),
      [...ledger, probe],
      [...ledger.slice(0, 2), { ...probe, method: "GET" }],
      [...ledger.slice(0, 2), { ...probe, status: 404 }],
      [...ledger.slice(0, 2), { ...probe, path: "/api/hello?extra=1" }],
      [...ledger.slice(0, 2), { ...probe, path: "/api/other" }],
      [
        ...ledger.slice(0, 2),
        { ...probe, bodyBytes: 1, bodySha256: hash("x") },
      ],
    ])
      expect(() => {
        check(rows);
      }).toThrow("integration.mockserver.control");
  });
  it.each([null, [], { beta: ["true"] }, { inherited: null }, "PRIVATE"])(
    "refuses nonempty or malformed raw probe query %j before ledger projection",
    (queryStringParameters) => {
      expect(() =>
        projectMockServerRequests(
          Buffer.from(
            JSON.stringify([
              { method: "HEAD", path: "/api/hello", queryStringParameters },
            ]),
          ),
        ),
      ).toThrow("integration.mockserver.control");
    },
  );
  it("projects only the exact empty raw probe without changing primary query handling", () => {
    for (const queryStringParameters of [undefined, {}]) {
      const rows = projectMockServerRequests(
        Buffer.from(
          JSON.stringify([
            { method: "HEAD", path: "/api/hello", queryStringParameters },
          ]),
        ),
      );
      expect(rows[0]).toMatchObject({
        method: "HEAD",
        path: "/api/hello",
        bodyBytes: 0,
        bodySha256: hash(""),
      });
    }
    expect(() =>
      projectMockServerRequests(
        Buffer.from(
          JSON.stringify([
            { method: "HEAD", path: "/api/hello", body: "PRIVATE" },
          ]),
        ),
      ),
    ).toThrow("integration.mockserver.control");
    expect(() =>
      projectMockServerRequests(
        Buffer.from(
          JSON.stringify([
            {
              method: "POST",
              path: "/v1/messages",
              queryStringParameters: { beta: ["true"] },
            },
          ]),
        ),
      ),
    ).not.toThrow();
  });
});
describe("Claude native two-request final ledger", () => {
  it("accepts the actual ordered Messages pair after all control traffic comparison", () => {
    const { ledger, check } = claudeLedgerFixture();
    expect(() => {
      check();
    }).not.toThrow();
    const ready = {
      ...ledger[0]!,
      method: "GET",
      path: "/mockserver/ready",
      role: "readiness" as const,
      bodyBytes: 0,
      bodySha256: hash(Buffer.alloc(0)),
    };
    expect(() => {
      check([ready, ...ledger]);
    }).not.toThrow();
  });
  it("refuses consistently rebound missing, extra, reordered, body and route substitutions", () => {
    const { ledger, check } = claudeLedgerFixture();
    for (const changed of [
      ledger.slice(0, 1),
      [...ledger, ledger[0]!],
      [...ledger].reverse(),
      [{ ...ledger[0]!, bodySha256: hash("substituted") }, ledger[1]!],
      [{ ...ledger[0]!, path: "/v1/other" }, ledger[1]!],
      [{ ...ledger[0]!, method: "GET" }, ledger[1]!],
      [
        ...ledger,
        {
          ...ledger[0]!,
          method: "GET",
          path: "/agentscope-unmatched",
          status: 404,
          bodyBytes: 0,
          bodySha256: hash(Buffer.alloc(0)),
        },
      ],
    ])
      expect(() => {
        check(changed);
      }).toThrow("integration.mockserver.control");
  });
  it("refuses missing, malformed, reordered or substituted native digests and wrong observation kinds", () => {
    const { ledger, native, check } = claudeLedgerFixture();
    for (const observation of [
      null,
      {},
      { ...native, kind: "claude-code-trace" },
      { ...native, modelRequestBodySha256: [] },
      {
        ...native,
        modelRequestBodySha256: [
          ...native.modelRequestBodySha256,
          hash("extra"),
        ],
      },
      {
        ...native,
        modelRequestBodySha256: [...native.modelRequestBodySha256].reverse(),
      },
      {
        ...native,
        modelRequestBodySha256: [
          hash("other"),
          native.modelRequestBodySha256[1],
        ],
      },
      {
        ...native,
        modelRequestBodySha256: [
          [native.modelRequestBodySha256[0]],
          native.modelRequestBodySha256[1],
        ],
      },
    ])
      expect(() => {
        check(ledger, observation);
      }).toThrow("integration.mockserver.control");
  });
  it("refuses missing, duplicate or substituted selected Messages routes", () => {
    const { ledger, native, routes, scenario, check } = claudeLedgerFixture();
    for (const selected of [
      [],
      [...routes, routes[0]!],
      [{ ...routes[0]!, path: "/v1/other" }],
      [{ ...routes[0]!, method: "GET" }],
    ])
      expect(() => {
        check(ledger, native, selected);
      }).toThrow();
    for (const modelRoutes of [[], ["other"], ["anthropic-messages", "other"]])
      expect(() => {
        check(ledger, native, routes, { ...scenario, modelRoutes });
      }).toThrow();
  });
});
