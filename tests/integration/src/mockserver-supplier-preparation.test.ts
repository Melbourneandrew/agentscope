import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  inputs: [] as Record<string, unknown>[],
  builds: [] as Record<string, unknown>[],
  failure: "",
  mutated: false,
  marked: false,
  afterBuild: () => {},
}));
vi.mock("../mockserver-material/prepare-bootstrap.mjs", () => ({
  prepareMockServerBootstrap: (input: Record<string, unknown>) => {
    state.inputs.push(input);
    if (state.failure === "bootstrap") throw Error("bootstrap");
    return Promise.resolve({
      archives: {
        source: Buffer.from(state.mutated ? "altered" : "source"),
        maven: Buffer.from("maven"),
        node: Buffer.from("node"),
        jdk: Buffer.from("jdk"),
      },
      verification: { evidenceScope: "bootstrap-input-verification-only" },
    });
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
    if (state.failure === "build") throw Error("build");
    return Promise.resolve(Buffer.from("synthetic-research"));
  },
  markPreparedDockerClientForOuterHostRetirement: () => {
    state.marked = true;
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
  state.inputs = [];
  state.builds = [];
  state.failure = "";
  state.mutated = false;
  state.marked = false;
  state.afterBuild = () => {};
});
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
  vi.restoreAllMocks();
});
describe("connected supplier research under inherited lifecycle (synthetic builder)", () => {
  it("stages complete helper graph and exact compressed inputs through the existing builder", async () => {
    const input = fixture();
    state.afterBuild = () => {
      const build = state.builds[0];
      const path = build?.context as string;
      expect(readdirSync(path).sort()).toEqual(
        [
          "Supplier.Dockerfile",
          "bootstrap-archive.mjs",
          "build-recipe.mjs",
          "build-tool-archive.mjs",
          "callback-patch.mjs",
          "jdk.tar.gz",
          "maven.zip",
          "node.tar.gz",
          "source-archive.mjs",
          "source.tar.gz",
          "supplier-command.mjs",
          "supplier-inventory.mjs",
        ].sort(),
      );
      expect(readFileSync(resolve(path, "source.tar.gz")).toString()).toBe(
        "source",
      );
      const dockerfile = readFileSync(
        resolve(path, "Supplier.Dockerfile"),
        "utf8",
      );
      expect(dockerfile).toContain("RUN --network=default");
      expect(dockerfile).toContain("FROM scratch");
      expect(dockerfile).toContain("/out/material.json /material.json");
      expect(
        createHash("sha256")
          .update(readFileSync(resolve(path, "callback-patch.mjs")))
          .digest("hex"),
      ).toMatch(/^[a-f\d]{64}$/u);
    };
    const result = await researchMockServerSupplier(input as never);
    expect(result.evidenceScope).toBe("untrusted-cache-and-jar-research-only");
    expect(result.inventory.toString()).toBe("synthetic-research");
    expect(state.inputs[0]?.deadline).toBe(input.deadline);
    expect(state.inputs[0]?.dockerClient).toBe(input.dockerClient);
    expect(state.builds[0]).toMatchObject({
      buildNetwork: "default",
      buildOutput: "evidence-tar",
      maximumBuildContextBytes: 384 * 1024 * 1024,
      retirementRequired: false,
    });
    expect(state.builds[0]?.tag).toBeUndefined();
    expect(state.builds[0]?.maximumMilliseconds).toBeLessThan(14_000);
    expect(readdirSync(input.privateRoot)).toEqual([]);
    expect(state.marked).toBe(false);
  });
  it("rejects mutated bootstrap bytes before supplier staging", async () => {
    const input = fixture();
    state.mutated = true;
    await expect(researchMockServerSupplier(input as never)).rejects.toThrow(
      "source",
    );
    expect(state.builds).toEqual([]);
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
  it.each(["bootstrap", "build"])(
    "preserves %s primary failure and cleans known files",
    async (failure) => {
      const input = fixture();
      state.failure = failure;
      await expect(researchMockServerSupplier(input as never)).rejects.toThrow(
        failure,
      );
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
  it("quarantines unexpected context content rather than recursively deleting it", async () => {
    const input = fixture();
    state.afterBuild = () => {
      writeFileSync(
        resolve(state.builds[0]?.context as string, "unknown"),
        "preserve",
      );
    };
    await expect(researchMockServerSupplier(input as never)).rejects.toThrow(
      "supplier",
    );
    expect(state.marked).toBe(true);
    expect(
      existsSync(
        resolve(
          input.privateRoot,
          `mockserver-supplier-${input.runId}`,
          "unknown",
        ),
      ),
    ).toBe(true);
  });
});
describe("supplier deadline and cancellation boundary", () => {
  it("rejects exhausted, oversized, cancelled and malformed authorities before bootstrap", async () => {
    for (const change of [
      { deadline: performance.now() },
      { deadline: performance.now() + 400_000 },
      { runId: "bad" },
      { privateRoot: "relative" },
      { signal: AbortSignal.abort() },
    ]) {
      const input = fixture();
      await expect(
        researchMockServerSupplier({ ...input, ...change } as never),
      ).rejects.toThrow("supplier");
    }
    expect(state.inputs).toEqual([]);
  });
  it("does not accept late inventory after cancellation; known context still settles", async () => {
    const input = fixture();
    const controller = new AbortController();
    input.signal = controller.signal;
    state.afterBuild = () => {
      controller.abort();
    };
    await expect(researchMockServerSupplier(input as never)).rejects.toThrow(
      "supplier",
    );
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
});
