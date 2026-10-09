import type * as NodeFs from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuildStderrObservation } from "../image-preparation/process-output.mjs";
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
const timing = (buildEntered = true): Record<string, unknown> => ({
  elapsedMilliseconds: expect.any(Number),
  buildEntryElapsedMilliseconds: buildEntered ? expect.any(Number) : null,
  buildEntryRemainingMilliseconds: buildEntered ? expect.any(Number) : null,
  buildElapsedMilliseconds: buildEntered ? expect.any(Number) : null,
  remainingMilliseconds: expect.any(Number),
});
const readDiagnostic = (bytes: unknown) => {
  const text = String(bytes);
  expect(
    text.startsWith("integration.mockserver-material.supplier-diagnostic:"),
  ).toBe(true);
  expect(text.endsWith("\n")).toBe(true);
  return JSON.parse(text.slice(text.indexOf(":") + 1)) as unknown;
};
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
    expect(output).toHaveLength(1);
    expect(readDiagnostic(output[0])).toEqual({
      phase: "supplier-build",
      imagePreparation: diagnostic,
      primaryFailure: {
        kind: "unknown",
        callerAborted: false,
        preparationAborted: false,
      },
      timing: timing(),
    });
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
    expect(write).toHaveBeenCalledTimes(1);
    expect(readDiagnostic(write.mock.calls[0]?.[0])).toEqual({
      phase: "bootstrap-preflight",
      imagePreparation: null,
      primaryFailure: {
        kind: "unknown",
        callerAborted: false,
        preparationAborted: false,
      },
      timing: timing(false),
    });
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
        timing: timing(),
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
        timing: timing(),
      });
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
});
const observe = (chunks: readonly string[]) => {
  const observation = createBuildStderrObservation();
  for (const chunk of chunks) observation.consume(Buffer.from(chunk));
  return observation.snapshot();
};
describe("host monotonic supplier timing under the original deadline", () => {
  it("separates bootstrap/context time from build time without renewing its budget", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const input = fixture();
    const originalDeadline = input.deadline;
    state.waitBootstrap = () => {
      now += 4000;
      return Promise.resolve();
    };
    state.afterBuild = () => {
      now += 3000;
    };
    state.failure = "build";
    await expect(researchMockServerSupplier(input as never)).rejects.toBe(
      state.primary,
    );
    expect(readDiagnostic(stderr.mock.calls[0]?.[0])).toMatchObject({
      timing: {
        elapsedMilliseconds: 7000,
        buildEntryElapsedMilliseconds: 4000,
        buildEntryRemainingMilliseconds: 10000,
        buildElapsedMilliseconds: 3000,
        remainingMilliseconds: 13000,
      },
    });
    expect(state.inputs[0]?.deadline).toBe(originalDeadline);
    expect(input.deadline).toBe(originalDeadline);
    expect(state.builds[0]?.maximumMilliseconds).toBe(10000);
    expect(state.builds[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
  it("reports absent build entry honestly on bootstrap failure", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const input = fixture();
    state.waitBootstrap = () => {
      now += 900;
      return Promise.reject(state.primary);
    };
    await expect(researchMockServerSupplier(input as never)).rejects.toBe(
      state.primary,
    );
    expect(readDiagnostic(stderr.mock.calls[0]?.[0])).toMatchObject({
      timing: {
        elapsedMilliseconds: 900,
        buildEntryElapsedMilliseconds: null,
        buildEntryRemainingMilliseconds: null,
        buildElapsedMilliseconds: null,
        remainingMilliseconds: 19100,
      },
    });
    expect(state.builds).toHaveLength(0);
  });
  it("bounds late failure timing without changing primary failure or output caps", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const input = fixture();
    state.failure = "build";
    state.afterBuild = () => {
      now += 500000;
    };
    await expect(researchMockServerSupplier(input as never)).rejects.toBe(
      state.primary,
    );
    const bytes = stderr.mock.calls[0]?.[0];
    expect(readDiagnostic(bytes)).toMatchObject({
      timing: {
        elapsedMilliseconds: 300000,
        buildEntryElapsedMilliseconds: 0,
        buildEntryRemainingMilliseconds: 14000,
        buildElapsedMilliseconds: 300000,
        remainingMilliseconds: 0,
      },
    });
    expect(bytes?.byteLength).toBeLessThanOrEqual(4096);
    expect(state.marked).toBe(true);
  });
});
describe("fixed untrusted BuildKit supplier RUN result", () => {
  const summary = (mode = "cache-seeding", code = "137") =>
    `process "/usr/local/bin/node /supplier/command/supplier-command.mjs ${mode}" did not complete successfully: exit code: ${code}\n`;
  it.each([
    "dependency-research",
    "offline-build",
    "cache-seeding",
    "service-offline",
  ])(
    "retains only %s and bounded execution exit across every split",
    (mode) => {
      const text = `#7 ERROR: ${summary(mode)}ERROR: failed to build: failed to solve: ${summary(mode)}`;
      for (let split = 0; split <= text.length; split++) {
        const result = observe([text.slice(0, split), text.slice(split)]);
        expect(result.untrustedSupplierExecution).toEqual({
          mode,
          exitCode: 137,
        });
        expect(result.untrustedMavenFailure).toBeUndefined();
      }
    },
  );
  it.each(["0", "1", "255"])("preserves exact bounded code %s", (code) => {
    expect(
      observe([`ERROR: failed to solve: ${summary("service-offline", code)}`])
        .untrustedSupplierExecution,
    ).toEqual({ mode: "service-offline", exitCode: Number(code) });
  });
  it.each([
    summary("other"),
    summary("cache-seeding", "256"),
    summary("cache-seeding", "01"),
    summary("cache-seeding", "-1"),
    summary().replace("/usr/local/bin/node", "/PRIVATE_CANARY"),
    summary().replace("137", "137 PRIVATE_CANARY"),
    `PRIVATE_CANARY${summary()}`,
    `${"X".repeat(257)}${summary()}`,
    summary().trimEnd(),
    `#8 ERROR: ${summary("cache-seeding", "1")}`,
    `#8 ERROR: ${summary("service-offline")}`,
  ])(
    "rejects malformed/foreign/incomplete/conflicting summary %#",
    (suffix) => {
      const result = observe([`#7 ERROR: ${summary()}`, suffix]);
      expect(result.untrustedSupplierExecution).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
    },
  );
  it("does not invent execution from success or ordinary private output", () => {
    for (const text of [
      "",
      "#7 DONE 1.0s\n",
      "PRIVATE_CANARY\n",
      "exit code: 137\n",
    ])
      expect(observe([text]).untrustedSupplierExecution).toBeUndefined();
  });
});
