import type * as NodeFs from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const stderr = vi.hoisted(() => vi.fn((bytes: Uint8Array) => bytes.byteLength));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>();
  return {
    ...original,
    writeSync: (descriptor: number, bytes: Uint8Array) =>
      descriptor === 2 ? stderr(bytes) : original.writeSync(descriptor, bytes),
  };
});
const state = vi.hoisted(() => ({
  inputs: [] as Record<string, unknown>[],
  builds: [] as Record<string, unknown>[],
  failure: "",
  mutated: false,
  marked: false,
  afterBuild: () => {},
  waitBootstrap: () => Promise.resolve(),
  primary: new Error("build"),
  diagnostic: (): unknown => undefined,
  observations: [] as unknown[],
  diagnosticFailure: false,
  sinkFailure: false,
}));
vi.mock("../mockserver-material/prepare-bootstrap.mjs", () => ({
  prepareMockServerBootstrap: (input: Record<string, unknown>) => {
    state.inputs.push(input);
    if (state.failure === "bootstrap") throw Error("bootstrap");
    return state.waitBootstrap().then(() => ({
      archives: {
        source: Buffer.from(state.mutated ? "altered" : "source"),
        maven: Buffer.from("maven"),
        node: Buffer.from("node"),
        jdk: Buffer.from("jdk"),
      },
      verification: { evidenceScope: "bootstrap-input-verification-only" },
    }));
  },
}));
vi.mock("../mockserver-material/source-archive.mjs", () => ({
  verifyMockServerSourceArchive: (bytes: Buffer) => {
    if (bytes.toString() !== "source") throw Error("source");
    return Buffer.from(bytes);
  },
}));
vi.mock("../mockserver-material/build-tool-archive.mjs", () => ({
  verifyMavenArchiveBytes: (bytes: Buffer) => Buffer.from(bytes),
}));
vi.mock("../mockserver-material/bootstrap-archive.mjs", () => ({
  verifyBootstrapArchive: (_kind: string, bytes: Buffer) => Buffer.from(bytes),
}));
vi.mock("../image-preparation.mjs", () => ({
  buildPreparedDockerImage: (
    _client: unknown,
    input: Record<string, unknown>,
  ) => {
    state.builds.push(input);
    state.afterBuild();
    if (state.failure === "build") return Promise.reject(state.primary);
    return Promise.resolve(
      input.buildOutput === "image"
        ? `sha256-${"a".repeat(64)}`
        : Buffer.from("synthetic-research"),
    );
  },
  markPreparedDockerClientForOuterHostRetirement: () => {
    state.marked = true;
  },
  preparedDockerClientDiagnostic: () => {
    if (state.diagnosticFailure) throw Error("diagnostic");
    return state.diagnostic();
  },
}));
vi.mock("../controller-file-command.mjs", () => ({
  publishMaterialResearchPhase: () => {},
  publishBootstrapGpgObservation: (diagnostic: unknown) => {
    state.observations.push(diagnostic);
    if (state.sinkFailure) throw Error("sink");
  },
}));
import { researchMockServerSupplier } from "../mockserver-material/prepare-supplier.mjs";
const roots: string[] = [];
const fixture = () => {
  const privateRoot = mkdtempSync(
    resolve(tmpdir(), "agentscope-supplier-stage-"),
  );
  const clientRoot = mkdtempSync(
    resolve(tmpdir(), "agentscope-supplier-client-"),
  );
  roots.push(privateRoot, clientRoot);
  return {
    privateRoot,
    dockerClient: { privateClient: { root: clientRoot } },
    runId: "0123456789abcdef",
    signal: new AbortController().signal,
    deadline: performance.now() + 20_000,
  };
};
beforeEach(() => {
  stderr.mockReset().mockImplementation((bytes) => bytes.byteLength);
  state.inputs = [];
  state.builds = [];
  state.failure = "";
  state.mutated = false;
  state.marked = false;
  state.afterBuild = () => {};
  state.waitBootstrap = () => Promise.resolve();
  state.primary = new Error("build");
  state.diagnostic = () => undefined;
  state.observations = [];
  state.diagnosticFailure = false;
  state.sinkFailure = false;
});
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("ordinary supplier catch emits only owned diagnostics", () => {
  it("observes the build envelope before cleanup without reading its raw cause", async () => {
    const input = fixture();
    state.failure = "build";
    let causeReads = 0;
    Object.defineProperty(state.primary, "cause", {
      get: () => {
        causeReads++;
        throw Error("raw-secret-canary");
      },
    });
    const diagnostic = Object.freeze({
      operationKind: "image-build",
      outcome: "failed-settled",
      process: Object.freeze({ exited: true, joined: true }),
    });
    state.diagnostic = () => diagnostic;
    const output: string[] = [];
    stderr.mockImplementation((bytes) => {
      expect(readdirSync(input.privateRoot)).not.toEqual([]);
      output.push(String(bytes));
      return bytes.byteLength;
    });
    await expect(researchMockServerSupplier(input as never)).rejects.toBe(
      state.primary,
    );
    expect(output).toEqual([
      `integration.mockserver-material.supplier-diagnostic:${JSON.stringify({ phase: "supplier-build", imagePreparation: diagnostic, primaryFailure: { kind: "unknown", callerAborted: false, preparationAborted: false } })}\n`,
    ]);
    expect(Buffer.byteLength(output[0] ?? "")).toBeLessThanOrEqual(4096);
    expect(output.join("")).not.toContain("raw-secret-canary");
    expect(causeReads).toBe(0);
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
  it("reports bootstrap entry and honest absent preparation evidence", async () => {
    state.failure = "bootstrap";
    const write = stderr;
    await expect(
      researchMockServerSupplier(fixture() as never),
    ).rejects.toThrow("bootstrap");
    expect(write).toHaveBeenCalledWith(
      Buffer.from(
        'integration.mockserver-material.supplier-diagnostic:{"phase":"bootstrap-preflight","imagePreparation":null,"primaryFailure":{"kind":"unknown","callerAborted":false,"preparationAborted":false}}\n',
      ),
    );
  });
  it.each(["reader", "sink", "oversized"])(
    "preserves primary and cleanup if the optional %s observation fails",
    async (kind) => {
      const input = fixture();
      state.failure = "build";
      state.diagnosticFailure = kind === "reader";
      if (kind === "oversized")
        state.diagnostic = () => ({ syntheticOversized: "x".repeat(4096) });
      const write = stderr.mockImplementation((bytes) => {
        if (kind === "sink") throw Error("sink");
        return bytes.byteLength;
      });
      await expect(researchMockServerSupplier(input as never)).rejects.toBe(
        state.primary,
      );
      expect(write).toHaveBeenCalledTimes(kind === "sink" ? 1 : 0);
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
  it("keeps successful completion silent", async () => {
    const write = stderr;
    await researchMockServerSupplier(fixture() as never);
    expect(write).not.toHaveBeenCalled();
  });
});
describe("fixed primary failure and original cancellation observations", () => {
  it.each([
    ["integration.images.timeout", undefined, "timeout"],
    ["integration.images.interrupted", undefined, "interrupted"],
    ["integration.images.command", undefined, "command"],
    ["PRIVATE_CANARY", "ETIMEDOUT", "timeout"],
    ["prefix integration.images.timeout", undefined, "unknown"],
    ["PRIVATE_CANARY", "PRIVATE_CODE", "unknown"],
  ])(
    "classifies only fixed native own-data %s/%s",
    async (message, code, kind) => {
      const input = fixture();
      state.failure = "build";
      state.primary = Object.assign(new Error(message), { code });
      await expect(researchMockServerSupplier(input as never)).rejects.toBe(
        state.primary,
      );
      const observation: unknown = JSON.parse(
        String(stderr.mock.calls[0]?.[0]).split(":").slice(1).join(":"),
      );
      expect(observation).toEqual({
        phase: "supplier-build",
        imagePreparation: null,
        primaryFailure: {
          kind,
          callerAborted: false,
          preparationAborted: false,
        },
      });
      expect(String(stderr.mock.calls[0]?.[0])).not.toContain("PRIVATE");
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
  it.each(["accessor", "proxy", "revoked", "forged"])(
    "does not invoke hostile %s error properties",
    async (kind) => {
      const input = fixture();
      state.failure = "build";
      let reads = 0;
      const native = new Error("PRIVATE_CANARY");
      const trap = () => {
        reads++;
        throw new Error("PRIVATE_CANARY");
      };
      if (kind === "accessor") {
        Object.defineProperty(native, "message", { get: trap });
        Object.defineProperty(native, "code", { get: trap });
        state.primary = native;
      } else if (kind === "proxy")
        state.primary = new Proxy(native, {
          get: trap,
          getOwnPropertyDescriptor: trap,
        });
      else if (kind === "revoked") {
        const pair = Proxy.revocable(native, { get: trap });
        pair.revoke();
        state.primary = pair.proxy;
      } else state.primary = { message: "integration.images.timeout" } as Error;
      let caught: unknown;
      try {
        await researchMockServerSupplier(input as never);
      } catch (error) {
        caught = error;
      }
      expect(caught === state.primary).toBe(true);
      expect(reads).toBe(0);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('"kind":"unknown"');
      expect(String(stderr.mock.calls[0]?.[0])).not.toContain("PRIVATE");
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
  it.each(["neither", "caller", "preparation"])(
    "observes %s cancellation without changing the controlling failure",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const input = fixture();
      const caller = new AbortController();
      input.signal = caller.signal;
      state.failure = "build";
      state.primary = new Error("integration.images.command");
      state.afterBuild = () => {
        if (kind === "caller") caller.abort();
        if (kind === "preparation") vi.advanceTimersByTime(20_000);
      };
      await expect(researchMockServerSupplier(input as never)).rejects.toBe(
        state.primary,
      );
      const observation: unknown = JSON.parse(
        String(stderr.mock.calls[0]?.[0]).split(":").slice(1).join(":"),
      );
      expect(observation).toEqual({
        phase: "supplier-build",
        imagePreparation: null,
        primaryFailure: {
          kind: "command",
          callerAborted: kind === "caller",
          preparationAborted: kind !== "neither",
        },
      });
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
});
