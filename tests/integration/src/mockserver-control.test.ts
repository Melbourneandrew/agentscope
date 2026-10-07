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
import { runInThisContext } from "node:vm";
import {
  codexSessionIdentity,
  codexTurnTerminalObservedAfterBaseline,
} from "../codex-runtime-evidence.mjs";
import { describe, expect, it, vi } from "vitest";
import {
  createMockServerControlMaterial,
  openMockServerControl,
  projectMockServerRequests,
  readMockServerFinalLedger,
  snapshotMockServerTraffic,
  verifyMockServerControlBoundary,
} from "../mockserver-control.mjs";

const runId = "0123456789abcdef";
const readIntegration = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "..", name), "utf8");
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
        `({readCodexSessionLedgerRecords, homeDescriptor, codexSessionIdentity, codexTurnTerminalObservedAfterBaseline, expectedAssistantMessage}) => { let codexSessionId, codexLedgerBaseline; ${source.slice(start, end)}; recordModelBaseline(); return codexLedgerBaseline; }`,
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
  it("binds the four fixed candidate denials to UID1000 without passing private authority", async () => {
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
    expect(observed.entries).toHaveLength(4);
    expect(requests.map((row) => row.path)).toEqual([
      "/mockserver/configuration",
      "/mockserver/dashboard",
      "/_mockserver_callback_websocket",
      "/mockserver/configuration",
    ]);
    expect(
      requests.map(
        (row) => (row.headers as Record<string, string>).authorization,
      ),
    ).toEqual([undefined, undefined, undefined, "Bearer invalid"]);
    expect(JSON.stringify(observed)).not.toContain("Bearer");
    uid = 0;
    await expect(Reflect.apply(actual, undefined, [input])).rejects.toThrow();
    expect(requests).toHaveLength(4);
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
      ].map((path) => [path, "controller"]),
    );
    expect(
      send.mock.calls.some((call) => String(call[1]).includes("status")),
    ).toBe(false);
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
