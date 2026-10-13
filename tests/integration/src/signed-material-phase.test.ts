import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../harness-material.mjs", import.meta.url),
  "utf8",
);
const actualSection = (start: string, end: string) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  expect(first).toBeGreaterThan(0);
  expect(last).toBeGreaterThan(first);
  return source.slice(first, last);
};
const signedApi = (context: Record<string, unknown>) =>
  runInNewContext(
    [
      actualSection("const phaseFailure =", "const remaining ="),
      actualSection(
        "const remaining =",
        "export const retireEmptyAuthenticatedHarnessMaterialDirectory",
      ),
      actualSection(
        "const runMaterialVerification =",
        "// One acquisition authority",
      ),
      actualSection(
        "const runSignedManifestVerification =",
        "const prepared =",
      ),
      "({ prepareSignedManifestHarnessMaterial, runMaterialVerification });",
    ].join("\n"),
    context,
  ) as {
    prepareSignedManifestHarnessMaterial: (input: unknown) => Promise<unknown>;
    runMaterialVerification: (input: unknown) => Promise<unknown>;
  };
const verificationInput = (
  material: unknown,
  onPhase: (phase: string) => void,
) => ({
  client: {},
  deadline: 30_100,
  material,
  operation: "gpg-verify",
  onPhase,
  policy: {},
  root: "/synthetic",
  runId: "0123456789abcdef",
  signal: { aborted: false },
});
const fixture = (
  selected: string,
  cleanupFails = false,
  buildError?: Error,
) => {
  let now = 100;
  const calls: { name: string; deadline?: number | undefined }[] = [];
  const privateError = Object.defineProperty(
    new Error("PRIVATE_BODY"),
    "code",
    {
      get: () => {
        throw Error("must not inspect foreign error");
      },
    },
  );
  const step = (name: string, deadline?: number) => {
    calls.push({ name, deadline });
    if (name === selected) throw privateError;
  };
  const bytes = Buffer.from("synthetic authenticated object seam");
  const descriptor = (name: string) => ({ name, bytes: bytes.length });
  const material = {
    kind: "signed-release-manifest",
    signingKey: descriptor("key"),
    manifest: descriptor("manifest"),
    signature: descriptor("signature"),
    binary: descriptor("binary"),
    platformPackage: {
      ...descriptor("platform-package"),
      tarballUrl: "synthetic",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    },
    verifierImage: "synthetic-verified-image",
  };
  if (selected === "validate-descriptors") material.binary.bytes = 0;
  if (selected === "integrity") material.platformPackage.integrity = "changed";
  const api = signedApi({
    Buffer,
    types,
    createHash,
    resolve,
    performance: { now: () => now },
    maximumAggregateArchiveBytes: 320 * 1024 * 1024,
    maximumAuditBytes: 8 * 1024 * 1024,
    materialSettlementReserveMilliseconds: 1000,
    materialRetirementReserveMilliseconds: 5000,
    commandSourceAuthority: {
      bytes: Buffer.from("synthetic command"),
      sha256: "a".repeat(64),
    },
    preparedMaterials: new WeakMap(),
    fail: () => {
      throw privateError;
    },
    exactDirectory: (path: string) => ({ path, dev: 1 }),
    sameDirectory: () => {
      step("identity");
    },
    mkdirSync: () => {
      step("mkdir");
    },
    existsSync: () => true,
    writeExclusive: () => {
      step("write");
    },
    verifierImage: () => {
      step("verify-context");
      return {};
    },
    download: (value: { name: string }, _signal: unknown, deadline: number) => {
      step(`download-${value.name}`, deadline);
      return Promise.resolve(Buffer.from(bytes));
    },
    buildPreparedDockerImage: (
      _client: unknown,
      input: { maximumMilliseconds: number },
    ) => {
      if (buildError !== undefined) throw buildError;
      step("verify-build", now + input.maximumMilliseconds);
      return Promise.resolve("synthetic-image");
    },
    retirePreparedDockerImage: (
      _client: unknown,
      input: { deadline: number },
    ) => {
      step("verify-retire", input.deadline);
      return Promise.resolve();
    },
    compileVerifiedSignedManifestHarnessMaterial: () => {
      step("compile-authority");
      if (selected === "publish") now = 30_101;
      return {};
    },
    rmSync: () => {
      calls.push({ name: "cleanup" });
      if (cleanupFails) throw privateError;
    },
  });
  return {
    calls,
    verify: (onPhase: (phase: string) => void) =>
      api.runMaterialVerification(verificationInput(material, onPhase)),
    run: () =>
      api.prepareSignedManifestHarnessMaterial({
        dockerClient: {},
        evidenceId: "fixture",
        material,
        privateRoot: "/synthetic",
        runId: "0123456789abcdef",
        maximumMilliseconds: 30_000,
        signal: { aborted: selected === "preflight" },
      }),
  };
};

describe("actual signed-material build refusal", () => {
  it.each([
    ["integration.images.build.input", "input"],
    [
      "integration.images.build.context-file-size-harness-material-harness",
      "context",
    ],
    ["integration.images.build.authority", "authority"],
    ["integration.images.build.preflight.unknown", "preflight"],
    ["integration.images.build.builder-create.resource-conflict", "create"],
    [
      "integration.images.build.builder-bootstrap.bootstrap-failed",
      "bootstrap",
    ],
    ["integration.images.build.image-build.build-failed", "image-build"],
    ["integration.images.containment", "containment"],
    ["integration.images.timeout", "timeout"],
  ])(
    "retains fixed build classification %s without replacing the original",
    async (message, phase) => {
      const original = new Error(message);
      const input = fixture("none", false, original);
      const observed: string[] = [];
      await expect(input.verify((value) => observed.push(value))).rejects.toBe(
        original,
      );
      expect(observed).toEqual([
        "verify-context",
        "verify-build",
        `verify-build-${phase}`,
      ]);
      await expect(input.run()).rejects.toMatchObject({
        message: "integration.harness-material.failed",
        cause: {
          message: `integration.harness-material.verify-build-${phase}`,
        },
      });
      expect(input.calls.some(({ name }) => name === "verify-retire")).toBe(
        false,
      );
    },
  );
  it.each(["getter", "proxy", "unknown"] as const)(
    "keeps hostile or unknown build error %s uninspected",
    async (kind) => {
      let traps = 0;
      const trap = () => {
        traps += 1;
        throw new Error("PRIVATE_TRAP");
      };
      const native = new Error(
        "integration.images.build.unknown-operation.build-failed",
      );
      const error =
        kind === "proxy"
          ? new Proxy(native, {
              get: trap,
              getOwnPropertyDescriptor: trap,
              getPrototypeOf: trap,
            })
          : kind === "getter"
            ? Object.defineProperty(native, "message", { get: trap })
            : native;
      const input = fixture("none", false, error);
      const observed: string[] = [];
      await expect(input.verify((value) => observed.push(value))).rejects.toBe(
        error,
      );
      const failure = await input.run().catch((value: unknown) => value);
      expect(failure).toMatchObject({
        message: "integration.harness-material.failed",
        cause: { message: "integration.harness-material.verify-build" },
      });
      expect(observed).toEqual([
        "verify-context",
        "verify-build",
        "verify-build",
      ]);
      expect(traps).toBe(0);
      expect(String(failure)).not.toContain("PRIVATE");
    },
  );
});
describe("actual signed-material phase refusal", () => {
  it.each([
    "preflight",
    "validate-descriptors",
    "download-key",
    "download-manifest",
    "download-signature",
    "download-platform-package",
    "integrity",
    "verify-context",
    "verify-build",
    "verify-retire",
    "download-binary",
    "compile-authority",
    "publish",
  ])("retains only fixed %s and original bounded cleanup", async (phase) => {
    const input = fixture(phase);
    const failure = await input.run().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "integration.harness-material.failed",
      cause: { message: `integration.harness-material.${phase}` },
    });
    expect(String(failure)).not.toContain("PRIVATE");
    expect(input.calls.some(({ name }) => name === "cleanup")).toBe(
      phase !== "preflight",
    );
    const deadlines = input.calls.flatMap(({ deadline }) =>
      deadline === undefined ? [] : [deadline],
    );
    expect(deadlines.every((deadline) => deadline <= 30_100)).toBe(true);
    if (phase.startsWith("verify-"))
      expect(input.calls.some(({ name }) => name === "download-binary")).toBe(
        false,
      );
  });
  it("cleanup failure cannot replace the first fixed phase or expose the foreign error", async () => {
    await expect(
      fixture("download-signature", true).run(),
    ).rejects.toMatchObject({
      message: "integration.harness-material.failed",
      cause: { message: "integration.harness-material.download-signature" },
    });
  });
  it("preserves verifier retirement before binary ingress and the unchanged original deadline", async () => {
    const input = fixture("none");
    await expect(input.run()).resolves.toMatchObject({
      authorityKind: "authenticated-harness-material",
    });
    const order = input.calls.map(({ name }) => name);
    expect(order.indexOf("verify-retire")).toBeGreaterThan(
      order.indexOf("verify-build"),
    );
    expect(order.indexOf("download-binary")).toBeGreaterThan(
      order.indexOf("verify-retire"),
    );
    expect(
      input.calls
        .filter(({ name }) => name.startsWith("download-"))
        .every(({ deadline }) => deadline === 30_100),
    ).toBe(true);
  });
});
