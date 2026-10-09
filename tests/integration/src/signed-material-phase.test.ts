import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
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
      "({ prepareSignedManifestHarnessMaterial });",
    ].join("\n"),
    context,
  ) as {
    prepareSignedManifestHarnessMaterial: (input: unknown) => Promise<unknown>;
  };
const fixture = (selected: string, cleanupFails = false) => {
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
