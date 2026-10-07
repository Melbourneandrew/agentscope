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
