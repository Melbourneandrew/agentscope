import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const sourceAt = (name: string) =>
  readFileSync(
    new URL(`../mockserver-material/${name}`, import.meta.url),
    "utf8",
  );
const section = (source: string, start: string, end: string) => {
  const first = source.indexOf(start),
    last = source.indexOf(end, first);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBeGreaterThan(first);
  return source.slice(first, last).replaceAll("export ", "");
};
const phases = [
  "bootstrap-preflight",
  "download-source",
  "download-maven",
  "download-node",
  "download-jdk",
  "verify-archives",
  "pinned-metadata",
  "download-maven-key",
  "download-maven-signature",
  "verify-maven",
  "retire-maven",
  "bootstrap-cleanup",
];
type Input = {
  deadline: number;
  dockerClient: object;
  privateRoot: string;
  runId: string;
  signal: AbortSignal;
};
const input = (): Input => ({
  deadline: 100_000,
  dockerClient: {
    evidence: {
      images: [
        { image: "base", platform: { os: "linux", architecture: "amd64" } },
      ],
    },
    privateClient: { root: "/private/client" },
  },
  privateRoot: "/private",
  runId: "0123456789abcdef",
  signal: new AbortController().signal,
});
const bootstrapHarness = (failure?: string) => {
  const original = new Error("PRIVATE_SYNTHETIC_ERROR");
  const published: string[] = [];
  let cleanupCalls = 0;
  const step = () => {
    if (published.at(-1) === failure) throw original;
    return Buffer.from("synthetic");
  };
  const source = sourceAt("prepare-bootstrap.mjs");
  const code =
    section(source, "const acquire =", "const identityFields =") +
    section(source, "const verifyInputs =", "/** Mutable returned archives") +
    source.slice(source.indexOf("export const prepareMockServerBootstrap ="));
  const prepare = runInNewContext(
    `${code.replaceAll("export ", "")}\nprepareMockServerBootstrap`,
    {
      Buffer,
      AbortSignal,
      AbortController,
      performance: { now: () => 1_000 },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      resolve,
      realpathSync: (path: string) => path,
      mkdirSync: () => undefined,
      exactDirectory: (path: string) => ({ path, dev: 1 }),
      base: "base",
      reserveMilliseconds: 6_000,
      maximumContextBytes: 384 * 1024 * 1024,
      verificationKinds: ["maven", "node", "jdk"],
      command: { sha256: "synthetic" },
      helper: { sha256: "synthetic" },
      source: { archive: {} },
      maven: { archive: {}, publicKeyMetadata: {}, signature: {} },
      bootstrap: {
        node: { archive: {} },
        metadata: { selected: { base64: "c3ludGhldGlj" } },
      },
      publishMaterialResearchPhase: (phase: string) => published.push(phase),
      publishBootstrapGpgObservation: () => undefined,
      preparedDockerClientDiagnostic: () => undefined,
      markPreparedDockerClientForOuterHostRetirement: () => undefined,
      check: () => undefined,
      fail: () => {
        throw original;
      },
      checkedObject: (bytes: Buffer) => bytes,
      prepareDockerInvocation: step,
      downloadMaterialObject: step,
      downloadMockServerJdkArchive: step,
      verifyMockServerSourceArchive: step,
      verifyMavenArchiveBytes: step,
      verifyBootstrapArchive: step,
      verifyBootstrapMetadata: step,
      stageContext: () => "/private/verification",
      buildPreparedDockerImage: () => {
        step();
        return Promise.resolve("synthetic-image");
      },
      retirePreparedDockerImage: step,
      cleanup: () => {
        cleanupCalls++;
        step();
      },
    },
  ) as (value: Input, note?: (phase: string) => void) => Promise<unknown>;
  return { prepare, original, published, cleanupCalls: () => cleanupCalls };
};

describe("actual bootstrap entered phases (synthetic external operations)", () => {
  it.each(phases)("retains original failure at entered %s", async (phase) => {
    const f = bootstrapHarness(phase);
    const entered: string[] = [];
    await expect(
      f.prepare(input(), (value) => entered.push(value)),
    ).rejects.toBe(f.original);
    expect(entered.at(-1)).toBe(phase);
    expect(f.published).toEqual(entered);
    expect(entered).toEqual(phases.slice(0, phases.indexOf(phase) + 1));
  });
  it("preserves default publisher and suppresses optional observer exceptions", async () => {
    const absent = bootstrapHarness();
    await absent.prepare(input());
    expect(absent.published).toEqual(phases);
    const throwing = bootstrapHarness();
    await throwing.prepare(input(), () => {
      throw Error("PRIVATE_OBSERVER");
    });
    expect(throwing.published).toEqual(phases);
    expect(throwing.cleanupCalls()).toBe(1);
    const failed = bootstrapHarness("download-source");
    await expect(
      failed.prepare(input(), () => {
        throw Error("PRIVATE_OBSERVER");
      }),
    ).rejects.toBe(failed.original);
    expect(failed.published).toEqual(phases.slice(0, 2));
  });
});

const supplierHarness = (
  phase: string,
  bootstrapFails = true,
  sinkFails = false,
  actual?: ReturnType<typeof bootstrapHarness>,
) => {
  const original = actual?.original ?? new Error("PRIVATE_SYNTHETIC_ERROR");
  const bytes: Buffer[] = [];
  const source = sourceAt("prepare-supplier.mjs");
  const code = section(
    source,
    "const supplierPrimaryFailure =",
    "export const researchMockServerSupplier =",
  );
  const prepare = runInNewContext(`${code}\nprepareSupplier`, {
    Buffer,
    types,
    AbortSignal,
    AbortController,
    performance: { now: () => 1_000 },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    reserve: 6_000,
    resolve,
    realpathSync: (path: string) => path,
    mkdirSync: () => undefined,
    exactDirectory: (path: string) => ({ path, dev: 1 }),
    sameDirectory: () => undefined,
    writeExclusive: () => undefined,
    lstatSync: () => ({}),
    check: () => undefined,
    fail: () => {
      throw original;
    },
    cleanup: () => undefined,
    markPreparedDockerClientForOuterHostRetirement: () => undefined,
    readImageRequestDiagnostic: () => undefined,
    preparedDockerClientDiagnostic: () => undefined,
    publishMaterialResearchPhase: () => undefined,
    writeSync: (_descriptor: number, value: Buffer) => {
      if (sinkFails) throw Error("PRIVATE_SINK");
      bytes.push(value);
    },
    [source.includes(" as prepareBootstrap ")
      ? "prepareBootstrap"
      : "prepareMockServerBootstrap"]:
      actual?.prepare ??
      ((_value: Input, note?: (phase: string) => void) => {
        note?.(phase);
        if (bootstrapFails) return Promise.reject(original);
        return Promise.resolve({ archives: {}, verification: {} });
      }),
    verifyMockServerSourceArchive: () => Buffer.alloc(0),
    verifyMavenArchiveBytes: () => Buffer.alloc(0),
    verifyBootstrapArchive: () => Buffer.alloc(0),
    supplierContextFiles: () => ({}),
    base: "base",
    buildPreparedDockerImage: () => Promise.reject(original),
    preserveSupplierBuildFailure: (error: unknown) => {
      throw error;
    },
  }) as (value: Input, service?: object) => Promise<unknown>;
  return { prepare, original, bytes };
};
describe("same actual supplier diagnostic uses bootstrap entered scope", () => {
  it("joins actual bootstrap rejection to the actual supplier catch", async () => {
    const bootstrap = bootstrapHarness("download-source");
    const f = supplierHarness("download-source", true, false, bootstrap);
    await expect(f.prepare(input())).rejects.toBe(bootstrap.original);
    expect(bootstrap.published).toEqual(phases.slice(0, 2));
    expect(f.bytes[0]!.toString("utf8")).toContain('"phase":"download-source"');
    expect(f.bytes[0]!.toString("utf8")).not.toContain("PRIVATE");
  });
  it.each(phases)(
    "reports only fixed %s and original failure",
    async (phase) => {
      const f = supplierHarness(phase);
      await expect(f.prepare(input())).rejects.toBe(f.original);
      expect(f.bytes).toHaveLength(1);
      const text = f.bytes[0]!.toString("utf8");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
      expect(text).not.toContain("PRIVATE");
      const value = JSON.parse(text.slice(text.indexOf(":") + 1)) as {
        phase: string;
        primaryFailure: { kind: string };
      };
      expect(Object.keys(value).sort()).toEqual([
        "imagePreparation",
        "phase",
        "primaryFailure",
        "timing",
      ]);
      expect(value.phase).toBe(phase);
      expect(value.primaryFailure.kind).toBe("unknown");
    },
  );
  it("resets successful bootstrap scope and never substitutes sink failure", async () => {
    const f = supplierHarness("bootstrap-cleanup", false);
    await expect(f.prepare(input())).rejects.toBe(f.original);
    expect(f.bytes[0]!.toString("utf8")).toContain('"phase":"supplier-build"');
    const failedSink = supplierHarness("download-source", true, true);
    await expect(failedSink.prepare(input())).rejects.toBe(failedSink.original);
    expect(failedSink.bytes).toEqual([]);
  });
});
