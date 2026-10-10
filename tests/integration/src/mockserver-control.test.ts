import { createHash, createPublicKey } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext, runInThisContext } from "node:vm";
import {
  codexSessionIdentity,
  codexTurnTerminalIdAfterBaseline,
  codexTurnTerminalObservedAfterBaseline,
} from "../codex-runtime-evidence.mjs";
import { describe, expect, it, vi } from "vitest";
import {
  createMockServerControlMaterial,
  mockServerTrafficRow,
  openMockServerControl,
  projectMockServerRequests,
  readMockServerFinalLedger,
  snapshotMockServerTraffic,
  verifyMockServerControlBoundary,
} from "../mockserver-control.mjs";

const runId = "0123456789abcdef";
const readIntegration = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "..", name), "utf8");
describe("recorded DTO exact byte projection", () => {
  it.each([
    '{"model":"fixture-model","input":"unique prompt"}',
    '{ "model" : "fixture-model", "input" : "unique prompt" }',
  ])("projects the same original DTO bytes %s", (wire) => {
    const source = readIntegration("mockserver-material/lifecycle-patch.mjs");
    const patches = runInNewContext(
      `${source.slice(source.indexOf("const root ="), source.indexOf("export const patchMockServerLifecycleSource")).replaceAll("export const ", "const ")}\npatches`,
    ) as Record<string, (value: string) => string>;
    const input =
      'import java.util.Arrays;\nboolean rawBytesNonDefault = Boolean.TRUE.equals(provider.getAttribute("emitRawBytes"))\n            && jsonBodyDTO.getRawBytes() != null\n            && !Arrays.equals(jsonBodyDTO.getRawBytes(), OBJECT_MAPPER.writeValueAsBytes(jsonNode));';
    expect(patches.jsonBodyDTO).toBeTypeOf("function");
    const patched = patches.jsonBodyDTO!(input);
    const bytes = Buffer.from(wire);
    const retainRaw = runInNewContext(
      patched.slice(patched.indexOf(" = ") + 3, -1),
      {
        Boolean: { TRUE: { equals: (value: unknown) => value === true } },
        provider: { getAttribute: () => true },
        jsonBodyDTO: { getRawBytes: () => bytes },
      },
    ) as boolean;
    expect(retainRaw).toBe(true);
    const json: unknown = JSON.parse(wire);
    const row = {
      method: "POST",
      path: "/v1/responses",
      headers: { authorization: ["Bearer synthetic"] },
      body: json,
    };
    expect(() =>
      projectMockServerRequests(Buffer.from(JSON.stringify([row]))),
    ).toThrow();
    const body = {
      type: "JSON",
      json,
      ...(retainRaw ? { rawBytes: bytes.toString("base64") } : {}),
    };
    const result = projectMockServerRequests(
      Buffer.from(JSON.stringify([{ ...row, body }])),
      createHash("sha256").update("unique prompt").digest("hex"),
    );
    expect(result[0]).toMatchObject({
      bodyBytes: bytes.length,
      bodySha256: createHash("sha256").update(bytes).digest("hex"),
      promptOccurrenceCount: 1,
      credentialHeaderCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("unique prompt");
    expect(JSON.stringify(result)).not.toContain("Bearer synthetic");
    expect(() =>
      projectMockServerRequests(
        Buffer.from(
          JSON.stringify([
            {
              ...row,
              body: { ...body, rawBytes: `${bytes.toString("base64")} ` },
            },
          ]),
        ),
      ),
    ).toThrow();
  });
});
describe("post-prompt authenticated session baseline", () => {
  it.each([false, true])(
    "waits for the first rollout under the original deadline (expiry=%s)",
    async (expires) => {
      const source = readIntegration("codex-pty-scenario.mjs");
      const baselineStart = source.indexOf("const recordModelBaseline =");
      const baselineEnd = source.indexOf(
        "\n// Retrieval is provisional.",
        baselineStart,
      );
      const terminalStart = source.indexOf("const waitForCodexTurnTerminal =");
      const terminalEnd = source.indexOf(
        "const waitForCodexStopBeforeExit =",
        terminalStart,
      );
      const flowStart = source.indexOf(
        '  recordInteractivePhase("tui-checkpoint");',
      );
      const flowEnd = source.indexOf(
        '  recordInteractivePhase("trace-terminal");',
        flowStart,
      );
      for (const boundary of [
        baselineStart,
        baselineEnd,
        terminalStart,
        terminalEnd,
        flowStart,
        flowEnd,
      ])
        expect(boundary).toBeGreaterThan(0);
      const meta = `${JSON.stringify({ type: "session_meta", payload: { id: "session-1" } })}\n`;
      const message = "challenge";
      const terminal = `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: message } })}\n`;
      const record = {
        relativePath: ".codex/sessions/2026/10/07/rollout-test.jsonl",
        dev: 1n,
        ino: 2n,
        mode: 0o100600n,
        uid: 1000n,
        gid: 1000n,
        content: `${meta}${terminal}`,
      };
      let prompted = false;
      let clock = 0;
      const reads = vi.fn(() => (prompted ? [record] : []));
      const bindings = {
        readCodexSessionLedgerRecords: reads,
        homeDescriptor: 1,
        codexSessionIdentity,
        codexTurnTerminalIdAfterBaseline,
        codexTurnTerminalObservedAfterBaseline,
        expectedAssistantMessage: message,
        traceDeadline: 1_000,
        bootNow: () => clock,
        remaining: () => 100,
        terminalObservationBeforeDeadline: ({
          observed,
        }: {
          observed: boolean;
        }) => observed,
        waitWithinObservationDeadline: vi.fn(() => {
          if (expires) clock = 1_000;
          else prompted = true;
        }),
        recordInteractivePhase: vi.fn(),
        readModelRequests: vi.fn(),
        waitForModelRequestBeforeDeadline: () => {
          throw new Error("model-control-budget-exhausted");
        },
      };
      const observe = runInThisContext(
        `(async (bindings) => { const {${Object.keys(bindings).join(",")}} = bindings;
      let codexSessionId, codexLedgerBaseline, codexTurnId, codexTerminalLedger;
      let armPending = true, preArmExitPhase;
      ${source.slice(baselineStart, baselineEnd)}
      ${source.slice(terminalStart, terminalEnd)}
      ${source.slice(flowStart, flowEnd)}
      return {codexSessionId, codexLedgerBaseline, codexTurnId, codexTerminalLedger}; })`,
      ) as (input: typeof bindings) => Promise<{
        codexSessionId: string;
        codexLedgerBaseline: (typeof record)[];
        codexTurnId: string;
        codexTerminalLedger: (typeof record)[];
      }>;
      if (expires) {
        await expect(observe(bindings)).rejects.toThrow(
          "integration.codex.trace-deadline",
        );
        expect(reads).toHaveBeenCalledTimes(1);
        expect(bindings.waitWithinObservationDeadline).toHaveBeenCalledTimes(1);
        expect(bindings.readModelRequests).not.toHaveBeenCalled();
        return;
      }
      const observed = await observe(bindings);
      expect(observed).toEqual({
        codexSessionId: "session-1",
        codexLedgerBaseline: [{ ...record, content: meta }],
        codexTurnId: "turn-1",
        codexTerminalLedger: [record],
      });
      expect(reads).toHaveBeenCalled();
      expect(bindings.waitWithinObservationDeadline).toHaveBeenCalledTimes(1);
      expect(bindings.readModelRequests).not.toHaveBeenCalled();
    },
  );
});
describe("fresh authenticated session baseline", () => {
  it("uses only the fresh session metadata byte prefix while retaining append and identity proof", () => {
    const source = readIntegration("codex-pty-scenario.mjs");
    const start = source.indexOf("const recordModelBaseline =");
    const end = source.indexOf("\n// Retrieval is provisional.", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const meta = `${JSON.stringify({ type: "session_meta", payload: { id: "session-1" } })}\n`;
    const message = "challenge";
    const terminal = `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: message } })}\n`;
    const record = (content: string, ino = 2n) => ({
      relativePath: ".codex/sessions/2026/10/07/rollout-test.jsonl",
      dev: 1n,
      ino,
      mode: 0o100600n,
      uid: 1000n,
      gid: 1000n,
      content,
    });
    const baseline = (records: ReturnType<typeof record>[]) => {
      const bindings = {
        readCodexSessionLedgerRecords: () => records,
        homeDescriptor: 1,
        codexSessionIdentity,
        codexTurnTerminalObservedAfterBaseline,
        expectedAssistantMessage: message,
      };
      const capture = runInThisContext(
        `({readCodexSessionLedgerRecords, homeDescriptor, codexSessionIdentity, codexTurnTerminalObservedAfterBaseline, expectedAssistantMessage}) => { let codexSessionId, codexLedgerBaseline; ${source.slice(start, end)}; recordModelBaseline(readCodexSessionLedgerRecords(homeDescriptor)); return codexLedgerBaseline; }`,
      ) as (input: typeof bindings) => ReturnType<typeof record>[];
      return capture(bindings);
    };
    const captured = baseline([record(`${meta}${terminal}`)]);
    expect(captured).toEqual([record(meta)]);
    expect(
      codexTurnTerminalObservedAfterBaseline(
        [record(`${meta}${terminal}`)],
        captured,
        message,
      ),
    ).toBe(true);
    expect(
      codexTurnTerminalObservedAfterBaseline(captured, captured, message),
    ).toBe(false);
    expect(() =>
      codexTurnTerminalObservedAfterBaseline(
        [record(`${meta}${terminal}`, 3n)],
        captured,
        message,
      ),
    ).toThrow();
    for (const records of [
      [],
      [record(meta), record(meta, 3n)],
      [record(meta.trimEnd())],
      [record("{\n")],
      [record(`${terminal}${meta}`)],
      [record(`${meta}${meta}`)],
    ])
      expect(() => baseline(records)).toThrow();
    expect(
      source.indexOf(
        "readCodexSessionLedgerRecords(homeDescriptor).length !== 0",
      ),
    ).toBeLessThan(source.indexOf("const codexRun = run("));
  });
});
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
describe("persistent upstream control uses the original observation cutoff", () => {
  it("keeps postlaunch retrieval within the original trace cutoff, not the setup reserve", async () => {
    const scenario = readIntegration("codex-pty-scenario.mjs");
    const setup = scenario.slice(
      scenario.indexOf("const configureModelGate ="),
      scenario.indexOf("const recordModelBaseline ="),
    );
    expect(setup).toContain("deadline: traceDeadline,");
    expect(setup).toContain("bootNow() >= preparationCutoff");
    expect(setup).toContain("monotonicDeadline: preparationCutoff");
    expect(scenario).toContain(
      "await configureModelGate(preparationCutoff, traceDeadline);",
    );
    expect(
      scenario.match(/const traceDeadline = deadline - 3_000;/gu),
    ).toHaveLength(1);
    expect(scenario).not.toContain("modelAdmissionCutoff");
    const source = readIntegration("mockserver-control.mjs");
    const start = source.indexOf("export const openMockServerControl =");
    const end = source.indexOf(
      "export const verifyMockServerControlBoundary",
      start,
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    let clock = 0;
    const exchange = vi.fn(() =>
      Promise.resolve({
        status: 200,
        bytes: Buffer.from("[]"),
      }),
    );
    const bindings = {
      Buffer,
      createHash,
      maximumBytes: 524_288,
      runPattern: /^[a-f0-9]{16}$/u,
      ownedKeys: new WeakMap(),
      failure: () => {
        throw new Error("integration.mockserver.control");
      },
      lstatSync: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        mode: 0o700,
      }),
      createPrivateKey: () => Object.freeze({}),
      readPrivateFile: () => Buffer.alloc(0),
      token: () => "synthetic-not-a-credential",
      exchangeControlRequest: exchange,
    };
    const factory = runInThisContext(
      `({Buffer, createHash, maximumBytes, runPattern, ownedKeys, failure, lstatSync, createPrivateKey, readPrivateFile, token, exchangeControlRequest}) => { ${source.slice(start, end).replace("export const", "const")} return openMockServerControl; }`,
    ) as (input: typeof bindings) => (input: {
      runId: string;
      host: string;
      deadline: number;
      now: () => number;
    }) => {
      configure: (
        value: unknown,
        cutoff?: number,
      ) => Promise<{ status: number }>;
      requests: () => Promise<{ status: number }>;
    };
    const open = factory(bindings);
    const control = (deadline: number) =>
      open({ runId, host: "mockserver", deadline, now: () => clock });
    const old = control(5_000);
    const current = control(7_000);
    await current.configure({}, 5_000);
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({ deadline: 5_000, remaining: 5_000 }),
    );
    exchange.mockClear();
    clock = 5_001;
    expect(() => old.requests()).toThrow("integration.mockserver.control");
    expect(() => current.configure({}, 5_000)).toThrow(
      "integration.mockserver.control",
    );
    expect(exchange).not.toHaveBeenCalled();
    await expect(current.requests()).resolves.toMatchObject({ status: 200 });
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({ deadline: 7_000, remaining: 1_999 }),
    );
    for (clock of [7_000, 7_001])
      expect(() => current.requests()).toThrow(
        "integration.mockserver.control",
      );
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});
describe("ordinary upstream control and complete ledger (no service execution)", () => {
  it("keeps a per-run asymmetric private key separate from the public trust anchor", () => {
    const first = createMockServerControlMaterial(runId);
    const second = createMockServerControlMaterial(runId);
    const jwks = JSON.parse(first.jwks.toString()) as {
      keys: [{ n: string; e: string }];
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      alg: "RS256",
      kid: runId,
      kty: "RSA",
      use: "sig",
    });
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(first.privateKey.equals(second.privateKey)).toBe(false);
    expect(
      createPublicKey(first.privateKey).export({ format: "jwk" }),
    ).toMatchObject({ n: jwks.keys[0].n, e: jwks.keys[0].e });
    expect(() => createMockServerControlMaterial("caller-label")).toThrow(
      "integration.mockserver.control",
    );
  });
  it("refuses a caller-forged material and expired original deadline before transport", () => {
    expect(() =>
      openMockServerControl({
        runId,
        host: "mockserver",
        deadline: 1,
        now: () => 0,
        material: {},
      }),
    ).toThrow();
    let clock = 0;
    const control = openMockServerControl({
      runId,
      host: "mockserver",
      deadline: 1,
      now: () => clock,
      material: createMockServerControlMaterial(runId),
    });
    clock = 1;
    expect(() => control.stop()).toThrow("integration.mockserver.control");
    expect(() => control.send("PUT", "/invented/seal", {})).toThrow();
  });
});
describe("upstream control observations and terminal ledger refusal", () => {
  it("binds the five fixed candidate denials to UID1000 without passing private authority", async () => {
    const source = readIntegration("mockserver-control.mjs");
    const start = source.indexOf("export const probeMockServerCandidate =");
    const end = source.indexOf("/** Fixed ordinary candidate recipe", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const requests: Record<string, unknown>[] = [];
    let uid = 1000;
    let responseStatus = 401;
    const probe: unknown =
      runInThisContext(`(async (process, Buffer, createHash, exchangeControlRequest, failure, runPattern) => {
      ${source.slice(start, end).replace("export const", "const")}
      return probeMockServerCandidate;
    })`);
    if (typeof probe !== "function") throw new Error("review.vm-binding");
    const actual: unknown = await Reflect.apply(probe, undefined, [
      { getuid: () => uid, getgid: () => uid },
      Buffer,
      createHash,
      (request: Record<string, unknown>) => {
        requests.push(request);
        return Promise.resolve({ status: responseStatus });
      },
      () => {
        throw new Error("integration.mockserver.control");
      },
      /^[a-f0-9]{16}$/u,
    ]);
    if (typeof actual !== "function") throw new Error("review.vm-binding");
    const input = { runId, host: "mockserver", deadline: 10, now: () => 0 };
    const raw: unknown = await Reflect.apply(actual, undefined, [input]);
    const observed = snapshotMockServerTraffic(raw, runId);
    expect(observed.entries).toHaveLength(5);
    expect(requests.map((row) => row.path)).toEqual([
      "/mockserver/configuration",
      "/mockserver/dashboard",
      "/_mockserver_callback_websocket",
      "/mockserver/status",
      "/mockserver/configuration",
    ]);
    expect(
      requests.map(
        (row) => (row.headers as Record<string, string>).authorization,
      ),
    ).toEqual([undefined, undefined, undefined, undefined, "Bearer invalid"]);
    expect(requests.map((row) => row.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "PUT",
      "GET",
    ]);
    expect(JSON.stringify(observed)).not.toContain("Bearer");
    uid = 0;
    await expect(Reflect.apply(actual, undefined, [input])).rejects.toThrow();
    expect(requests).toHaveLength(5);
    uid = 1000;
    responseStatus = 200;
    await expect(Reflect.apply(actual, undefined, [input])).rejects.toThrow();
  });
});
describe("closed untrusted fixture traffic observations", () => {
  it("rejects forged, cross-run and ambiguous traffic snapshots without invoking getters", () => {
    const row = {
      method: "GET",
      path: "/mockserver/ready",
      role: "readiness",
      status: 200,
      bodyBytes: 0,
      bodySha256: hash(""),
    };
    const valid = { runId, entries: [row] };
    const snapshot = snapshotMockServerTraffic(valid, runId);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(Object.getPrototypeOf(snapshot.entries[0])).toBeNull();
    let reads = 0;
    const getter = { ...row };
    Object.defineProperty(getter, "status", {
      enumerable: true,
      get() {
        reads++;
        return 200;
      },
    });
    for (const entries of [
      [getter],
      [{ ...row, extra: 1 }],
      [{ ...row, status: 600 }],
      [{ ...row, bodyBytes: 1048577 }],
      [{ ...row, role: "root" }],
      Array(1),
      Array.from({ length: 17 }, () => row),
      [
        new Proxy(row, {
          ownKeys() {
            reads++;
            return [];
          },
        }),
      ],
    ])
      expect(() =>
        snapshotMockServerTraffic({ runId, entries }, runId),
      ).toThrow();
    expect(() =>
      snapshotMockServerTraffic({ ...valid, runId: "fedcba9876543210" }, runId),
    ).toThrow();
    expect(() =>
      snapshotMockServerTraffic({ ...valid, extra: true }, runId),
    ).toThrow();
    expect(reads).toBe(0);
  });
});
describe("ordinary candidate traffic room", () => {
  it.each([1, 2, 5, 6])(
    "reserves five candidate and five owner rows within sixteen (models=%s)",
    async (models) => {
      const source = readIntegration("mockserver-control.mjs");
      const start = source.indexOf(
        "export const observeMockServerCandidateTraffic =",
      );
      const end = source.indexOf(
        "/** Call only after exact service join",
        start,
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const factory: unknown =
        runInThisContext(`((process, fetch, readMockServerBootClock, mockServerTrafficRow, probeMockServerCandidate, setTimeout, AbortSignal, runPattern) => {
        ${source.slice(start, end).replace("export const", "const")}
        return observeMockServerCandidateTraffic;
      })`);
      if (typeof factory !== "function") throw new Error("review.vm-binding");
      const maximum = 16 - 5 - 5 - models;
      for (const ready of [true, false]) {
        let attempts = 0;
        const probe = vi.fn(() => ({
          entries: Array.from({ length: 5 }, () =>
            mockServerTrafficRow(
              "GET",
              "/mockserver/configuration",
              "unauthenticated",
              401,
            ),
          ),
        }));
        const actual: unknown = Reflect.apply(factory, undefined, [
          { getuid: () => 1000, getgid: () => 1000 },
          () => {
            attempts++;
            return Promise.resolve({
              status: ready && attempts === maximum ? 200 : 503,
              body: { cancel: () => Promise.resolve() },
            });
          },
          () => 0,
          mockServerTrafficRow,
          probe,
          (resolve: () => void) => {
            resolve();
          },
          { timeout: () => undefined },
          /^[a-f0-9]{16}$/u,
        ]);
        if (typeof actual !== "function") throw new Error("review.vm-binding");
        const result: unknown = Reflect.apply(actual, undefined, [
          {
            runId,
            modelRequestCount: models,
            deadline: 100,
          },
        ]);
        if (ready && maximum > 0) {
          const entries: unknown = await result;
          if (!Array.isArray(entries)) throw new Error("review.vm-binding");
          expect(entries.length + 5 + models).toBe(16);
          expect(probe).toHaveBeenCalledOnce();
        } else {
          await expect(result).rejects.toThrow("integration.fixture.service");
          expect(probe).not.toHaveBeenCalled();
        }
        expect(attempts).toBe(Math.max(0, maximum));
      }
    },
  );
});
describe("upstream control observations and terminal ledger refusal", () => {
  it("uses exactly one controller-positive set; candidate denials are separately UID-bound", async () => {
    const send = vi.fn(
      (
        _method: string,
        _path: string,
        _value: unknown,
        authentication?: string,
        upgrade?: boolean,
      ) =>
        Promise.resolve({
          status: authentication === "controller" ? (upgrade ? 101 : 200) : 401,
        }),
    );
    await verifyMockServerControlBoundary({ send });
    expect(send.mock.calls.map((call) => [call[1], call[3]])).toEqual(
      [
        "/mockserver/configuration",
        "/mockserver/dashboard",
        "/_mockserver_callback_websocket",
        "/mockserver/status",
      ].map((path) => [path, "controller"]),
    );
    expect(
      send.mock.calls.some((call) => String(call[1]).includes("status")),
    ).toBe(true);
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      "GET",
      "GET",
      "GET",
      "PUT",
    ]);
    await expect(
      verifyMockServerControlBoundary({
        send: () => Promise.resolve({ status: 200 }),
      }),
    ).rejects.toThrow();
  });
  it("projects exact wire bytes rather than reserializing JSON and keeps unmatched requests", () => {
    const body = ' {"input":"unique prompt"} ';
    const bytes = Buffer.from(
      JSON.stringify([
        {
          method: "POST",
          path: "/v1/responses",
          headers: { Authorization: ["Bearer fake"] },
          body: {
            type: "JSON",
            json: '{"input":"unique prompt"}',
            rawBytes: Buffer.from(body).toString("base64"),
          },
        },
        { method: "PUT", path: "/unmatched", body: "unexpected" },
      ]),
    );
    const projected = projectMockServerRequests(bytes);
    expect(projected).toEqual([
      {
        method: "POST",
        path: "/v1/responses",
        bodyBytes: Buffer.byteLength(body),
        bodySha256: hash(body),
        modelSha256: null,
        promptOccurrenceCount: 0,
        credentialHeaderCount: 1,
      },
      {
        method: "PUT",
        path: "/unmatched",
        bodyBytes: 10,
        bodySha256: hash("unexpected"),
        modelSha256: null,
        promptOccurrenceCount: 0,
        credentialHeaderCount: 0,
      },
    ]);
    expect(
      projectMockServerRequests(
        Buffer.from(
          JSON.stringify([(JSON.parse(bytes.toString()) as unknown[])[0]]),
        ),
        hash("unique prompt"),
      )[0]!.promptOccurrenceCount,
    ).toBe(1);
    expect(JSON.stringify(projected)).not.toContain("unique prompt");
    expect(JSON.stringify(projected)).not.toContain("Bearer fake");
  });
  it.each([
    Buffer.from("{}"),
    Buffer.from(
      JSON.stringify([
        { method: "POST", path: "/", body: { rawBytes: "not canonical" } },
      ]),
    ),
    Buffer.from(JSON.stringify(Array(17).fill({ method: "GET", path: "/" }))),
    Buffer.from([255]),
    Buffer.alloc(1024 * 1024 + 1),
  ])(
    "refuses malformed, incomplete or overlong upstream serialization",
    (bytes) => {
      expect(() => projectMockServerRequests(bytes)).toThrow();
    },
  );
});
describe("private final-ledger terminal receipt", () => {
  it("requires the fixed complete receipt, private file identities and original cutoff after service join", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentscope-final-ledger-"));
    try {
      chmodSync(directory, 0o700);
      const input = { directory, deadline: 10, now: () => 0 };
      expect(() => readMockServerFinalLedger(input)).toThrow();
      writeFileSync(join(directory, "requests.json"), "[]\n", { mode: 0o600 });
      writeFileSync(join(directory, "requests.complete"), "partial\n", {
        mode: 0o600,
      });
      expect(() => readMockServerFinalLedger(input)).toThrow();
      writeFileSync(join(directory, "requests.complete"), "complete\n");
      expect(readMockServerFinalLedger(input)).toEqual(Buffer.from("[]\n"));
      expect(() =>
        readMockServerFinalLedger({ ...input, now: () => 10 }),
      ).toThrow();
      chmodSync(join(directory, "requests.json"), 0o644);
      expect(() => readMockServerFinalLedger(input)).toThrow();
      chmodSync(join(directory, "requests.json"), 0o600);
      rmSync(join(directory, "requests.complete"));
      symlinkSync(
        join(directory, "requests.json"),
        join(directory, "requests.complete"),
      );
      expect(() => readMockServerFinalLedger(input)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
