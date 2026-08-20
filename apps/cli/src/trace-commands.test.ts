import { describe, expect, it } from "vitest";

import { createCapturedOutput } from "./__tests__/cli-fixture.js";
import { runCli } from "./program.js";
import type { CliTraceServices } from "./trace-commands.js";

const connectionId =
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const traceId = "0123456789abcdef0123456789abcdef";
const locator = Object.freeze({
  connectionId,
  destinationType: "@agentscope/destination-example",
  destinationRevision: "1".repeat(32),
  traceId,
});
const searchValue = Object.freeze({
  connectionName: "archive",
  consistency: "snapshot" as const,
  nextCursor: "agentscope-cursor-v1.fixture",
  schemaVersion: 1 as const,
  state: "continuation" as const,
  summaries: Object.freeze([
    Object.freeze({
      branch: "main",
      harness: "codex",
      locator,
      models: Object.freeze(["gpt-5"]),
      spanCount: 3,
      startTime: "2026-01-01T00:00:00.000Z",
      status: "ok" as const,
      tags: Object.freeze(["review"]),
    }),
  ]),
});
const getValue = Object.freeze({
  connectionName: "archive",
  consistency: "snapshot" as const,
  graph: Object.freeze({ resourceSpans: Object.freeze([]) }),
  locator,
  policyIdentity: "agentscope.redaction.effective.v1.fixture",
  schemaVersion: 1 as const,
});

const run = async (
  arguments_: readonly string[],
  services: CliTraceServices,
) => {
  const captured = createCapturedOutput();
  const exitCode = await runCli(arguments_, {
    output: captured.output,
    services,
    version: "1.2.3",
  });
  return { ...captured, exitCode };
};

describe("portable traces commands", () => {
  it("documents required selection, the page default, and exact get identity", async () => {
    const services: CliTraceServices = {
      getTrace: () => ({ status: "success", value: getValue }),
      searchTraces: () => ({ status: "success", value: searchValue }),
    };
    const search = await run(["traces", "search", "--help"], services);
    const get = await run(["traces", "get", "--help"], services);
    const searchHelp = search.stdout.join(" ").replace(/\s+/gu, " ");
    const getHelp = get.stdout.join(" ").replace(/\s+/gu, " ");

    expect(search.exitCode).toBe(0);
    expect(searchHelp).toContain("required --destination");
    expect(searchHelp).toContain("default --limit 50");
    expect(searchHelp).toContain("default: 50");
    expect(get.exitCode).toBe(0);
    expect(getHelp).toContain("required --destination");
    expect(getHelp).toContain("exactly one of --trace-id or --trace-ref");
  });

  it("normalizes every search flag and renders the portable page", async () => {
    let received: unknown;
    const result = await run(
      [
        "traces",
        "search",
        "--destination",
        "archive",
        "--trace-id",
        traceId,
        "--from",
        "2026-01-01T00:00:00Z",
        "--to",
        "2026-01-02T00:00:00Z",
        "--harness",
        "codex",
        "--branch",
        "main",
        "--model",
        "gpt-5",
        "--session",
        "session-1",
        "--tag",
        "review",
        "release",
        "--limit",
        "25",
        "--cursor",
        "agentscope-cursor-v1.fixture",
        "--output",
        "json",
      ],
      {
        getTrace: () => ({ status: "success", value: getValue }),
        searchTraces: (input) => {
          received = input;
          return { status: "success", value: searchValue };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(received).toEqual({
      branch: "main",
      cursor: "agentscope-cursor-v1.fixture",
      destination: "archive",
      from: "2026-01-01T00:00:00Z",
      harness: "codex",
      limit: 25,
      model: "gpt-5",
      sessionId: "session-1",
      tags: ["review", "release"],
      to: "2026-01-02T00:00:00Z",
      traceId,
    });
    expect(JSON.parse(result.stdout.join(""))).toMatchObject({
      command: "agentscope traces search",
      completion: "complete",
      dataSchema: "agentscope.cli.traces-search.v1",
      records: [{ nextCursor: "agentscope-cursor-v1.fixture" }],
    });
  });

  it("prints destination-qualified human summaries and continuation", async () => {
    const result = await run(["traces", "search", "--destination", "archive"], {
      getTrace: () => ({ status: "success", value: getValue }),
      searchTraces: () => ({ status: "success", value: searchValue }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("")).toContain(`archive:${traceId}`);
    expect(result.stdout.join("")).toContain("Continuation cursor:");
  });

  it("uses fixed placeholders for absent optional summary fields", async () => {
    const result = await run(["traces", "search", "--destination", "archive"], {
      getTrace: () => ({ status: "success", value: getValue }),
      searchTraces: () => ({
        status: "success",
        value: {
          connectionName: "archive",
          consistency: "snapshot",
          schemaVersion: 1,
          state: "exhaustive",
          summaries: [
            {
              locator,
              models: [],
              spanCount: 3,
              startTime: "2026-01-01T00:00:00.000Z",
              status: "ok",
              tags: [],
            },
          ],
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("")).toContain(" | - | - | 3");
    expect(result.stdout.join("")).not.toContain("Continuation cursor:");
  });
});

describe("portable traces get and partial results", () => {
  it("accepts either a canonical ID or an exact structured locator", async () => {
    const received: unknown[] = [];
    const services: CliTraceServices = {
      getTrace: (input) => {
        received.push(input);
        return { status: "success", value: getValue };
      },
      searchTraces: () => ({ status: "success", value: searchValue }),
    };
    const byId = await run(
      ["traces", "get", "--destination", "archive", "--trace-id", traceId],
      services,
    );
    const byReference = await run(
      [
        "traces",
        "get",
        "--destination",
        "archive",
        "--trace-ref",
        JSON.stringify(locator),
        "--output",
        "jsonl",
      ],
      services,
    );

    expect(byId.exitCode).toBe(0);
    expect(byReference.exitCode).toBe(0);
    expect(received).toEqual([
      { destination: "archive", traceId },
      {
        destination: "archive",
        traceReference: locator,
      },
    ]);
    expect(byReference.stdout.at(-1)).toContain('"completion":"complete"');
  });

  it("rejects missing, conflicting, and malformed identities before services", async () => {
    let calls = 0;
    const services: CliTraceServices = {
      getTrace: () => {
        calls += 1;
        return { status: "success", value: getValue };
      },
      searchTraces: () => {
        calls += 1;
        return { status: "success", value: searchValue };
      },
    };
    const missingDestination = await run(["traces", "search"], services);
    const noIdentity = await run(
      ["traces", "get", "--destination", "archive"],
      services,
    );
    const both = await run(
      [
        "traces",
        "get",
        "--destination",
        "archive",
        "--trace-id",
        traceId,
        "--trace-ref",
        JSON.stringify(locator),
      ],
      services,
    );
    const malformed = await run(
      ["traces", "get", "--destination", "archive", "--trace-ref", "{}"],
      services,
    );
    const invalidJson = await run(
      ["traces", "get", "--destination", "archive", "--trace-ref", "{"],
      services,
    );

    expect(calls).toBe(0);
    for (const result of [
      missingDestination,
      noIdentity,
      both,
      malformed,
      invalidJson,
    ]) {
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toEqual(["error [cli.input.invalid]\n"]);
    }
  });
});

describe("portable traces result validation", () => {
  it("renders partial data before one fixed diagnostic", async () => {
    const partial = {
      ...searchValue,
      partialReason: "deadline" as const,
      state: "partial" as const,
    };
    const result = await run(
      ["traces", "search", "--destination", "archive", "--output", "json"],
      {
        getTrace: () => ({ status: "success", value: getValue }),
        searchTraces: () => ({
          diagnostic: { category: "unavailable", code: "traces.partial" },
          status: "partial",
          value: partial,
        }),
      },
    );

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0] ?? "null")).toMatchObject({
      completion: "partial",
    });
    expect(JSON.parse(result.stderr.join(""))).toMatchObject({
      category: "unavailable",
      code: "traces.partial",
      command: "agentscope traces search",
    });
  });

  it("rejects a noncanonical retrieved graph before presentation", async () => {
    const result = await run(
      ["traces", "get", "--destination", "archive", "--trace-id", traceId],
      {
        getTrace: () => ({
          status: "success",
          value: {
            ...getValue,
            graph: { providerBody: "CANARY_SECRET" },
          } as never,
        }),
        searchTraces: () => ({ status: "success", value: searchValue }),
      },
    );

    expect(result.exitCode).toBe(70);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual(["error [cli.internal]\n"]);
  });
});
