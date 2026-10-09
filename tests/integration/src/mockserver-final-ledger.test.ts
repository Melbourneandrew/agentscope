import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertMockServerFinalLedger,
  projectMockServerRequests,
  snapshotMockServerTraffic,
} from "../mockserver-control.mjs";
const runId = "0123456789abcdef";
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
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
      JSON.stringify(
        bodies.map((body) => ({
          method: "POST",
          path: "/v1/messages",
          body,
          headers: {
            "x-agentscope-final-role": ["data-plane"],
            "x-agentscope-final-status": ["200"],
          },
        })),
      ),
    ),
  );
  const native = {
    kind: "claude-code-native",
    modelRequestBodySha256: bodies.map(hash),
  };
  const routes = [
    { routeId: "anthropic-messages", method: "POST", path: "/v1/messages" },
  ];
  const scenario = {
    scenarioId: "claude-interactive-trace-smoke",
    modelRoutes: ["anthropic-messages"],
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
    assertMockServerFinalLedger(
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
    );
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
          traffic: {
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
