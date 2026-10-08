import { createHash } from "node:crypto";
import type * as NodeFs from "node:fs";
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
import {
  prepareMockServerService,
  researchMockServerSupplier,
} from "../mockserver-material/prepare-supplier.mjs";
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
describe("connected supplier research under inherited lifecycle (synthetic builder)", () => {
  it("builds the actual service from fresh offline sources and only two inherited caches", async () => {
    const input = fixture();
    const service = {
      tag: "agentscope-int-0123456789abcdef:mockserver",
      privateKey: Buffer.from("synthetic-key"),
      jwks: Buffer.from('{"keys":[]}'),
      expectations: Buffer.from("[]"),
    };
    state.afterBuild = () => {
      const context = state.builds[0]?.context as string;
      const source = readFileSync(
        resolve(context, "Supplier.Dockerfile"),
        "utf8",
      );
      expect(source).toContain('"cache-seeding"]');
      expect(source).toContain(
        'RUN --network=none ["/usr/local/bin/node", "/supplier/command/supplier-command.mjs", "service-offline"]',
      );
      expect(source.match(/COPY --from=supplier .+/gu)).toEqual([
        "COPY --from=supplier /supplier/maven-repository /supplier/maven-repository",
        "COPY --from=supplier /supplier/npm-cache /supplier/npm-cache",
      ]);
      expect(source).not.toContain("/out/material.json");
      expect(source).toContain(
        "COPY --from=offline --chmod=0444 /supplier/source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar /opt/mockserver.jar",
      );
      expect(source).toContain("USER 0:0");
      expect(source).toContain("umask 077; mkdir /control/private;");
      expect(readFileSync(resolve(context, "control-private.pem"))).toEqual(
        service.privateKey,
      );
      expect(readFileSync(resolve(context, "expectations.json"))).toEqual(
        service.expectations,
      );
    };
    const result = await prepareMockServerService(input as never, service);
    expect(result.imageId).toBe(`sha256-${"a".repeat(64)}`);
    expect(result.tag).toBe(service.tag);
    expect(state.builds[0]).toMatchObject({
      buildOutput: "image",
      retirementRequired: true,
      tag: service.tag,
      maximumBuildContextBytes: 384 * 1024 * 1024,
    });
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
  it("preserves the service build failure and cleans private credential staging", async () => {
    const input = fixture();
    state.failure = "build";
    await expect(
      prepareMockServerService(input as never, {
        tag: "agentscope-int-0123456789abcdef:mockserver",
        privateKey: Buffer.from("key"),
        jwks: Buffer.from("{}"),
        expectations: Buffer.from("[]"),
      }),
    ).rejects.toBe(state.primary);
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
});
describe("supplier research staging and cleanup", () => {
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
          "lifecycle-patch.mjs",
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
      expect(dockerfile.trim().split("\n")).toEqual([
        "ARG BASE_IMAGE",
        "FROM ${BASE_IMAGE} AS supplier",
        "WORKDIR /supplier",
        "COPY --chmod=0600 *.mjs /supplier/command/",
        "COPY --chmod=0600 source.tar.gz maven.zip node.tar.gz jdk.tar.gz /supplier/inputs/",
        'RUN --network=default ["/usr/local/bin/node", "/supplier/command/supplier-command.mjs", "dependency-research"]',
        "FROM ${BASE_IMAGE} AS offline",
        "WORKDIR /supplier",
        "COPY --chmod=0600 *.mjs /supplier/command/",
        "COPY --chmod=0600 source.tar.gz maven.zip node.tar.gz jdk.tar.gz /supplier/inputs/",
        "COPY --from=supplier /supplier/maven-repository /supplier/maven-repository",
        "COPY --from=supplier /supplier/npm-cache /supplier/npm-cache",
        'RUN --network=none ["/usr/local/bin/node", "/supplier/command/supplier-command.mjs", "offline-build"]',
        "FROM scratch",
        "COPY --from=offline --chmod=0644 /out/material.json /material.json",
      ]);
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
    expect(state.inputs[0]?.signal).toBe(input.signal);
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
describe("supplier failure observations preserve the original outcome", () => {
  it.each(["failed-settled", "retired-failure"])(
    "projects the existing %s diagnostic without substituting its primary",
    async (outcome) => {
      const input = fixture();
      state.failure = "build";
      const diagnostic = Object.freeze({
        operationKind: "image-build",
        outcome,
        process: Object.freeze({ exited: true, joined: true }),
      });
      state.diagnostic = () => diagnostic;
      await expect(researchMockServerSupplier(input as never)).rejects.toBe(
        state.primary,
      );
      expect(state.observations).toEqual([diagnostic]);
      expect(state.observations[0]).toBe(diagnostic);
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
  it.each(["absent", "reader-failure", "sink-failure"])(
    "keeps exact primary and known-file cleanup with %s observation",
    async (kind) => {
      const input = fixture();
      state.failure = "build";
      state.diagnosticFailure = kind === "reader-failure";
      state.sinkFailure = kind === "sink-failure";
      await expect(researchMockServerSupplier(input as never)).rejects.toBe(
        state.primary,
      );
      expect(state.observations).toEqual(
        kind === "reader-failure" ? [] : [undefined],
      );
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
  it("publishes nothing on successful supplier completion", async () => {
    await researchMockServerSupplier(fixture() as never);
    expect(state.observations).toEqual([]);
  });
});
describe("supplier deadline and cancellation boundary", () => {
  it("preserves bootstrap retirement signal after work cutoff while rejecting later supplier work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const input = fixture();
    input.deadline = performance.now() + 6_050;
    let finish = () => {};
    state.waitBootstrap = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const pending = researchMockServerSupplier(input as never);
    const rejected = expect(pending).rejects.toThrow("supplier");
    await vi.advanceTimersByTimeAsync(100);
    expect(state.inputs[0]?.signal).toBe(input.signal);
    expect((state.inputs[0]?.signal as AbortSignal).aborted).toBe(false);
    finish();
    await rejected;
    expect(state.builds).toEqual([]);
    expect(readdirSync(input.privateRoot)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
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
