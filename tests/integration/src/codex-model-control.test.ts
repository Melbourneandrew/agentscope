import { EventEmitter } from "node:events";
import { Agent, type request as HttpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexModelControlRequest,
  createCodexFailureResearchRecord,
  extractAdapterReportedFailure,
  projectUntrustedCodexPtyReceipt,
} from "../codex-pty-research.mjs";
// @ts-expect-error private integration module has no published declaration
import * as privateAuthority from "../immutable-candidate-authority.mjs";
const { codexFailureExitPair, validCodexResearchDiagnostic } =
  privateAuthority as {
    codexFailureExitPair: (
      fixture: unknown,
      container: unknown,
      scenario: string,
    ) => string | undefined;
    validCodexResearchDiagnostic: (value: unknown) => boolean;
  };
const readIntegration = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "..", name), "utf8");

const modelFixture = (observe?: (hint: string) => void) => {
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const request = Object.assign(new EventEmitter(), {
    end: (body?: string) => {
      sentBody = body;
    },
    destroy: () => {
      destroyed += 1;
      request.emit("error", new Error("private"));
    },
  });
  let sentBody: string | undefined;
  let destroyed = 0;
  let options: Record<string, unknown> | undefined;
  let deliver: (() => void) | undefined;
  let clock = 100;
  const hints: string[] = [];
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const headers = Object.freeze({
    authorization: "private",
    "content-type": "application/json",
  });
  const httpRequest = ((
    input: Record<string, unknown>,
    callback: (value: EventEmitter) => void,
  ) => {
    options = input;
    deliver = () => {
      callback(response);
    };
    return request;
  }) as unknown as typeof HttpRequest;
  const control = createCodexModelControlRequest({
    httpRequest,
    agent,
    headers,
    socketPath: "/private/socket",
    deadline: () => 1000,
    gateCutoff: () => 600,
    now: () => clock,
    observe: (hint) => {
      hints.push(hint);
      observe?.(hint);
    },
  });
  return {
    control,
    request,
    response,
    hints,
    agent,
    headers,
    deliver: () => deliver?.(),
    setClock: (value: number) => {
      clock = value;
    },
    options: () => options,
    body: () => sentBody,
    destroyed: () => destroyed,
  };
};

describe("model control first seal failure research", () => {
  it("preserves request options, body and successful silence", async () => {
    const f = modelFixture();
    const result = f.control("/seal", "POST", { runId: "owned" });
    expect(f.options()).toMatchObject({
      agent: f.agent,
      method: "POST",
      path: "/seal",
      socketPath: "/private/socket",
    });
    expect(f.options()?.headers).toEqual({
      ...f.headers,
      "content-length": 17,
    });
    expect(f.options()?.signal).toBeInstanceOf(AbortSignal);
    expect(f.body()).toBe('{"runId":"owned"}');
    f.deliver();
    f.response.emit("data", Buffer.from('{"receipt":true}'));
    f.response.emit("end");
    await expect(result).resolves.toEqual({ receipt: true });
    expect(f.hints).toEqual([]);
  });
  it.each([
    ["seal-http-status", "status"],
    ["seal-response-decode", "json"],
    ["seal-response-decode", "utf8"],
    ["seal-response-limit", "limit"],
    ["seal-response-aborted", "aborted"],
    ["seal-transport", "transport"],
  ])(
    "retains first %s without exposing failure content",
    async (hint, stage) => {
      const f = modelFixture();
      const result = f.control("/seal", "POST", {});
      const rejected = expect(result).rejects.toThrow(
        "integration.codex.model-gate",
      );
      f.deliver();
      if (stage === "status") f.response.statusCode = 409;
      if (stage === "json") f.response.emit("data", Buffer.from("private"));
      if (stage === "utf8") f.response.emit("data", Buffer.from([255]));
      if (stage === "limit") f.response.emit("data", Buffer.alloc(65537));
      else if (stage === "aborted") {
        f.response.emit("aborted");
        f.request.emit("error", new Error("private body/path"));
      } else if (stage === "transport")
        f.request.emit("error", new Error("private body/path"));
      else f.response.emit("end");
      await rejected;
      f.response.emit("aborted");
      expect(f.hints).toEqual([hint]);
      expect(f.destroyed()).toBe(stage === "limit" ? 1 : 0);
    },
  );
  it("retains caller cancellation without changing its generic failure", async () => {
    const f = modelFixture();
    const controller = new AbortController();
    const result = f.control("/seal", "POST", {}, controller.signal);
    const rejected = expect(result).rejects.toThrow(
      "integration.codex.model-gate",
    );
    controller.abort(new Error("private"));
    f.request.emit("error", new Error("private"));
    await rejected;
    expect(f.hints).toEqual(["seal-signal-aborted"]);
  });
});

describe("model control unchanged cutoff and settlement", () => {
  it("passes original remaining budget without a recreated window", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      for (const [path, budget] of [
        ["/seal", 900],
        ["/deny", 900],
        ["/requests", 500],
      ] as const) {
        const f = modelFixture();
        const result = f.control(path, "PUT");
        expect(timeout).toHaveBeenLastCalledWith(budget);
        expect(f.options()?.headers).toBe(f.headers);
        expect(f.body()).toBeUndefined();
        f.deliver();
        f.response.emit("data", Buffer.from("{}"));
        f.response.emit("end");
        await expect(result).resolves.toEqual({});
      }
    } finally {
      timeout.mockRestore();
    }
  });
  it("does not replace a synchronous primary request failure", async () => {
    const primary = new Error("private original");
    const hints: string[] = [];
    const control = createCodexModelControlRequest({
      httpRequest: () => {
        throw primary;
      },
      agent: new Agent({ keepAlive: true, maxSockets: 1 }),
      headers: {},
      socketPath: "/private/socket",
      deadline: () => 1000,
      gateCutoff: () => undefined,
      now: () => 100,
      observe: (hint) => {
        hints.push(hint);
      },
    });
    await expect(control("/seal", "POST", {})).rejects.toBe(primary);
    expect(hints).toEqual([]);
  });
  it("preserves the original absolute and gate cutoffs", () => {
    const f = modelFixture();
    f.setClock(600);
    expect(() => f.control("/requests", "PUT", {})).toThrow(
      "integration.codex.model-gate-deadline",
    );
    expect(f.hints).toEqual([]);
    f.setClock(1000);
    expect(() => f.control("/seal", "POST", {})).toThrow(
      "integration.codex.model-gate-deadline",
    );
    expect(f.hints).toEqual(["seal-deadline"]);
    expect(f.options()).toBeUndefined();
  });
  it("ignores sink failure and observes aborted responses without settling them", async () => {
    const f = modelFixture(() => {
      throw new Error("private sink");
    });
    let settled = false;
    const result = f.control("/seal", "POST", {}).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow(
      "integration.codex.model-gate",
    );
    f.deliver();
    f.response.emit("aborted");
    await Promise.resolve();
    expect(settled).toBe(false);
    f.request.emit("error", new Error("private"));
    await rejected;
    expect(f.hints).toEqual(["seal-response-aborted"]);
  });
  it("leaves non-seal failures unobserved", async () => {
    const f = modelFixture();
    const result = f.control("/deny", "POST", {});
    const rejected = expect(result).rejects.toThrow(
      "integration.codex.model-gate",
    );
    f.request.emit("error", new Error("private"));
    await rejected;
    expect(f.hints).toEqual([]);
  });
});

describe("returned receipt packet compatibility and wiring", () => {
  it("preserves historical versions and closes exact version-4 keys", () => {
    const base = { untrustedConfigHint: "publish", exitPair: "none:1" };
    for (const diagnosticVersion of [1, 2, 3, 4]) {
      const record = {
        ...base,
        diagnosticVersion,
        ...(diagnosticVersion >= 2
          ? { untrustedGateHint: "arm-log-unavailable" }
          : {}),
        ...(diagnosticVersion >= 3
          ? { untrustedPtyHint: "arm-pty-returned-failed" }
          : {}),
        ...(diagnosticVersion === 4
          ? {
              untrustedPtyReceipt: {
                outcome: "timeout",
                checkpointProgressDiagnostic: "no-live-readiness",
              },
            }
          : {}),
      };
      expect(validCodexResearchDiagnostic(record)).toBe(true);
      expect(
        validCodexResearchDiagnostic({ ...record, extra: "private" }),
      ).toBe(false);
      if (diagnosticVersion === 4) {
        expect(
          validCodexResearchDiagnostic({
            ...record,
            untrustedPtyReceipt: null,
          }),
        ).toBe(true);
        expect(
          validCodexResearchDiagnostic({
            ...record,
            untrustedPtyReceipt: {
              outcome: "timeout",
              checkpointProgressDiagnostic: "private",
            },
          }),
        ).toBe(false);
      } else
        expect(
          validCodexResearchDiagnostic({
            ...record,
            untrustedPtyReceipt: null,
          }),
        ).toBe(false);
    }
  });
  it("executes the actual outer failure retainer and stays silent for non-Codex", () => {
    const source = readIntegration("run-scenarios.mjs");
    const start = source.indexOf("const retainCodexResearchDiagnostic =");
    const end = source.indexOf("const captureFailedScenarioReceipt =", start);
    expect(end).toBeGreaterThan(start);
    for (const scenarioId of ["codex-tui-trace-smoke", "other"])
      for (const receipt of [
        undefined,
        {
          outcome: "timeout",
          checkpointProgressDiagnostic: "advanced",
          exitCode: null,
        },
      ]) {
        const retained = new Map<
          string,
          {
            diagnosticVersion: number;
            untrustedPtyReceipt: ReturnType<
              typeof projectUntrustedCodexPtyReceipt
            > | null;
            exitPair: string | null;
            adapterReportedFailure: null;
          }
        >();
        runInNewContext(
          `${source.slice(start, end)} retainCodexResearchDiagnostic(plan, '', receipt, {code:1});`,
          {
            plan: { scenarioId, runId: "closed-canary" },
            receipt,
            codexResearchDiagnostics: retained,
            projectUntrustedCodexPtyReceipt,
            extractAdapterReportedFailure,
            createCodexFailureResearchRecord,
            codexResearchDependencies: [
              () => "publish",
              () => "arm-log-unavailable",
              () => "arm-pty-returned-failed",
              projectUntrustedCodexPtyReceipt,
              extractAdapterReportedFailure,
              codexFailureExitPair,
            ],
            extractUntrustedCodexConfigHint: () => "publish",
            extractUntrustedCodexGateHint: () => "arm-log-unavailable",
            extractUntrustedCodexPtyHint: () => "arm-pty-returned-failed",
            codexFailureExitPair,
          },
          { timeout: 1000 },
        );
        if (scenarioId === "other") expect(retained.size).toBe(0);
        else {
          const record = retained.get("closed-canary");
          expect(record?.diagnosticVersion).toBe(6);
          expect(record?.untrustedPtyReceipt).toEqual(
            projectUntrustedCodexPtyReceipt(receipt, 6) ?? null,
          );
          expect(record?.exitPair).toBe("none:1");
          expect(record?.adapterReportedFailure).toBeNull();
        }
      }
  });
});
