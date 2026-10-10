import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import type * as MaterialIO from "../harness-material-io.mjs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  phases: [] as string[],
  acquired: [] as string[],
  built: [] as Record<string, unknown>[],
  retired: [] as Record<string, unknown>[],
  client: {
    privateClient: { root: "" },
    evidence: {
      images: [
        {
          image:
            "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2",
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    },
  },
  failure: "",
  marked: false,
  afterAcquire: () => {},
  afterBuild: () => {},
  sourceSnapshots: [] as Buffer[],
  failRootBinding: false,
}));
vi.mock("../controller-file-command.mjs", () => ({
  publishMaterialResearchPhase: (phase: string) => state.phases.push(phase),
}));
function sha(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function archive(name: string) {
  return Buffer.from(`synthetic-${name}`);
}
function pin(name: string) {
  return {
    url: `https://fixture.invalid/${name}`,
    bytes: archive(name).length,
    sha256: sha(archive(name)),
  };
}
function metadata() {
  return Object.fromEntries(
    [
      "node-key",
      "node-signed-checksums",
      "node-checksums",
      "temurin-key",
      "temurin-signature",
    ].map((name) => [
      name,
      { ...pin(name), base64: archive(name).toString("base64") },
    ]),
  );
}
vi.mock("../harness-material-io.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof MaterialIO>();
  return {
    ...actual,
    exactDirectory: (path: string) => {
      if (
        state.failRootBinding &&
        path.endsWith("mockserver-bootstrap-0123456789abcdef")
      )
        throw new Error("root-binding");
      return actual.exactDirectory(path);
    },
    readMaterialSource: (path: string) => {
      let value;
      if (path.endsWith("bootstrap-pin.json"))
        value = { node: { archive: pin("node") }, metadata: metadata() };
      else if (path.endsWith("build-tool-pin.json"))
        value = {
          maven: {
            archive: pin("maven"),
            publicKeyMetadata: pin("maven-key"),
            signature: pin("maven-signature"),
          },
        };
      else if (path.endsWith("source-pin.json"))
        value = { archive: pin("source") };
      else {
        const snapshot = actual.readMaterialSource(path);
        state.sourceSnapshots.push(snapshot.bytes);
        return snapshot;
      }
      const bytes = Buffer.from(JSON.stringify(value));
      return { bytes, sha256: sha(bytes) };
    },
  };
});
vi.mock("../harness-material.mjs", () => ({
  downloadMockServerJdkArchive: () => Promise.resolve(archive("jdk")),
}));
vi.mock("../material-download.mjs", () => ({
  downloadMaterialObject: async (descriptor: { url: string }) => {
    await Promise.resolve();
    const name = descriptor.url.split("/").at(-1)!;
    state.acquired.push(name);
    state.afterAcquire();
    if (state.failure === name) return Buffer.from("wrong");
    return archive(name);
  },
}));
vi.mock("../mockserver-material/source-archive.mjs", () => ({
  verifyMockServerSourceArchive: (bytes: Buffer) => Buffer.from(bytes),
}));
vi.mock("../mockserver-material/build-tool-archive.mjs", () => ({
  verifyMavenArchiveBytes: (bytes: Buffer) => Buffer.from(bytes),
}));
vi.mock("../mockserver-material/bootstrap-archive.mjs", () => ({
  verifyBootstrapArchive: (_kind: string, bytes: Buffer) => Buffer.from(bytes),
}));
vi.mock("../mockserver-material/bootstrap-metadata.mjs", () => ({
  verifyBootstrapMetadata: (_kind: string, bytes: Buffer) => Buffer.from(bytes),
}));
vi.mock("../image-preparation.mjs", () => ({
  prepareDockerInvocation: async (
    client: unknown,
    _arguments: string[],
    signal: AbortSignal,
  ) => {
    await Promise.resolve();
    if (client !== state.client) throw new Error("client");
    if (state.failure === "never-preflight")
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("preflight-abort"));
          },
          { once: true },
        );
      });
  },
  buildPreparedDockerImage: async (
    _client: unknown,
    options: Record<string, unknown>,
  ) => {
    await Promise.resolve();
    const context = String(options.context);
    const policy = JSON.parse(
      readFileSync(resolve(context, "maven-policy.json"), "utf8"),
    ) as { kind: string };
    state.built.push({
      ...options,
      kind: policy.kind,
      files: readdirSync(context).sort(),
      dockerfileText: readFileSync(
        resolve(context, "Verifier.Dockerfile"),
        "utf8",
      ),
      manifest: readFileSync(resolve(context, "node-manifest")),
    });
    if (["maven-build", "node-build", "jdk-build"].includes(state.failure))
      throw new Error("verification");
    state.afterBuild();
    return "sha256:" + policy.kind;
  },
  retirePreparedDockerImage: async (
    _client: unknown,
    options: Record<string, unknown>,
  ) => {
    await Promise.resolve();
    state.retired.push(options);
    if (state.failure === "retirement") {
      state.marked = true;
      throw new Error("retirement");
    }
  },
  markPreparedDockerClientForOuterHostRetirement: () => {
    state.marked = true;
  },
}));

import { prepareMockServerBootstrap } from "../mockserver-material/prepare-bootstrap.mjs";
import {
  exactDirectory,
  readMaterialSource,
  writeExclusive,
} from "../harness-material-io.mjs";

const roots: string[] = [];
const setup = () => {
  const privateRoot = mkdtempSync(
    resolve(tmpdir(), "agentscope-bootstrap-context-"),
  );
  chmodSync(privateRoot, 0o700);
  roots.push(privateRoot);
  const clientRoot = mkdtempSync(
    resolve(tmpdir(), "agentscope-bootstrap-client-"),
  );
  roots.push(clientRoot);
  state.client.privateClient.root = clientRoot;
  return {
    privateRoot,
    deadline: performance.now() + 30_000,
    runId: "0123456789abcdef",
    signal: new AbortController().signal,
    dockerClient: state.client as never,
  };
};
beforeEach(() => {
  state.phases = [];
  state.acquired.length = 0;
  state.built.length = 0;
  state.retired.length = 0;
  state.failure = "";
  state.failRootBinding = false;
  state.marked = false;
  state.afterAcquire = () => {};
  state.afterBuild = () => {};
  state.client.evidence.images[0]!.platform.architecture = "amd64";
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function expectVerifierRecipe(recipe: string) {
  for (const kind of ["maven", "node", "jdk"]) {
    const stage = recipe
      .split(`FROM agentscope_base AS verify_${kind}\n`)[1]!
      .split("FROM ")[0]!;
    expect(stage).toContain(
      `COPY --chmod=0600 ${kind}-policy.json /verify/policy.json`,
    );
    expect(stage).toContain(
      'RUN --network=none ["/usr/local/bin/node","/verify/material-command.mjs","bootstrap-gpg","/verify"]',
    );
    expect(stage.indexOf('bootstrap-gpg","/verify"]')).toBeLessThan(
      stage.indexOf("writeFileSync"),
    );
    expect(stage).toContain(`'/proof-${kind}'`);
    expect(stage).toContain("flag:'wx',mode:0o600");
  }
  expect(recipe.split("FROM scratch\n")[1]).toBe(
    ["maven", "node", "jdk"]
      .map(
        (kind) => `COPY --from=verify_${kind} /proof-${kind} /proof/${kind}\n`,
      )
      .join(""),
  );
}
describe("connected bootstrap stage (synthetic dependencies, not crypto)", () => {
  it("forces all three isolated verifiers into one proof-only image and retires it", async () => {
    const input = setup();
    writeFileSync(resolve(input.privateRoot, "unrelated"), "preserve");
    const result = await prepareMockServerBootstrap(input);
    expect(state.built).toHaveLength(1);
    expect(state.retired).toHaveLength(1);
    expect(result.verification.verifications).toEqual(
      ["maven", "node", "jdk"].map((kind) => ({
        kind,
        imageId: "sha256:maven",
      })),
    );
    expect(state.retired[0]!.imageId).toBe("sha256:maven");
    expect(state.phases).toEqual([
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
    ]);
    for (const build of state.built) {
      expect(build.maximumBuildContextBytes).toBe(384 * 1024 * 1024);
      expect(build.buildNetwork).toBe("none");
      expect(build.baseImage).toBe(state.client.evidence.images[0]!.image);
      expect(build.buildArguments).toEqual({});
      expect(build.dockerfileText).toMatch(
        /^FROM agentscope_base AS verify_maven\n/u,
      );
      expect(build.dockerfileText).toContain("COPY --chmod=0600");
      expect(build.dockerfileText).toContain("RUN --network=none");
      expect(build.files).toEqual(
        [
          "Verifier.Dockerfile",
          ...["maven", "node", "jdk"].flatMap((kind) =>
            [
              "bootstrap-gpg.mjs",
              "key",
              "manifest",
              "material-command.mjs",
              "policy.json",
              "signature",
            ].map((name) => `${kind}-${name}`),
          ),
        ].sort(),
      );
      expectVerifierRecipe(String(build.dockerfileText));
    }
    expect(state.built[0]!.manifest).toEqual(archive("node-checksums"));
    expect(result.verification.evidenceScope).toBe(
      "bootstrap-input-verification-only",
    );
    expect(readdirSync(input.privateRoot)).toEqual(["unrelated"]);
    result.archives.node[0] = result.archives.node[0]! ^ 1;
    expect(result.archives.node).not.toEqual(archive("node")); // explicitly mutable, not admission
  });
  it.each(["deadline", "aborted", "run", "client", "platform"])(
    "rejects %s before acquisition/staging",
    async (kind) => {
      const input = setup();
      if (kind === "deadline") input.deadline = performance.now() + 6_000;
      if (kind === "aborted") input.signal = AbortSignal.abort();
      if (kind === "run") input.runId = "escape/../run";
      if (kind === "client") input.dockerClient = {} as never;
      if (kind === "platform")
        state.client.evidence.images[0]!.platform.architecture = "arm64";
      await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
      expect(state.acquired).toHaveLength(0);
      expect(readdirSync(input.privateRoot)).toEqual([]);
    },
  );
  it.each([
    "source",
    "maven-key",
    "maven-build",
    "node-build",
    "jdk-build",
    "retirement",
  ])("preserves %s failure and admits no later build", async (kind) => {
    const input = setup();
    state.failure = kind;
    await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
    expect(state.built.length).toBeLessThanOrEqual(1);
    if (kind.endsWith("-build")) expect(state.retired).toHaveLength(0);
    expect(state.phases.at(-1)).toBe(
      {
        source: "download-source",
        "maven-key": "download-maven-key",
        "maven-build": "verify-maven",
        "node-build": "verify-maven",
        "jdk-build": "verify-maven",
        retirement: "retire-maven",
      }[kind],
    );
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
});

describe("bootstrap deadline and physical cleanup boundaries", () => {
  it("bounds stalled preflight with the one original work cutoff", async () => {
    const input = setup();
    input.deadline = performance.now() + 6_100;
    state.failure = "never-preflight";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const observed = expect(prepareMockServerBootstrap(input)).rejects.toThrow(
      "preflight-abort",
    );
    await vi.advanceTimersByTimeAsync(101);
    await observed;
    expect(state.acquired).toHaveLength(0);
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
  it("refuses helper snapshot substitution before builder admission", async () => {
    const input = setup();
    const snapshot = state.sourceSnapshots[0]!;
    const original = snapshot[0]!;
    state.afterAcquire = () => {
      snapshot[0] = original ^ 1;
    };
    try {
      await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
      expect(state.built).toHaveLength(0);
      expect(readdirSync(input.privateRoot)).toEqual([]);
    } finally {
      snapshot[0] = original;
    }
  });
  it("rejects staging inside the admitted client root", async () => {
    const input = setup();
    state.client.privateClient.root = input.privateRoot;
    await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
    expect(state.acquired).toHaveLength(0);
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
  it("does not admit a build after acquisition cancellation", async () => {
    const input = setup();
    const controller = new AbortController();
    input.signal = controller.signal;
    state.afterAcquire = () => {
      controller.abort();
    };
    await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
    expect(state.built).toHaveLength(0);
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
  it("retires a late successful build before rejecting exhausted work authority", async () => {
    const input = setup();
    state.afterBuild = () => {
      vi.spyOn(performance, "now").mockReturnValue(input.deadline - 5_999);
    };
    await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
    expect(state.built).toHaveLength(1);
    expect(state.retired).toHaveLength(1);
    expect(state.retired[0]!.deadline).toBe(input.deadline - 1_000);
    expect(readdirSync(input.privateRoot)).toEqual([]);
  });
  it("quarantines substituted root and preserves the primary verification failure", async () => {
    const input = setup();
    const root = resolve(
      input.privateRoot,
      "mockserver-bootstrap-" + input.runId,
    );
    state.afterAcquire = () => {
      if (!existsSync(root + "-original")) {
        renameSync(root, root + "-original");
        writeFileSync(root, "substitution");
      }
    };
    await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
    expect(state.marked).toBe(true);
    expect(readFileSync(root, "utf8")).toBe("substitution");
    expect(existsSync(root + "-original")).toBe(true);
  });
  it("preserves unexpected context content rather than recursively sweeping it", async () => {
    const input = setup();
    state.afterBuild = () => {
      writeFileSync(
        resolve(String(state.built.at(-1)!.context), "unexpected"),
        "preserve",
      );
    };
    await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
    expect(state.marked).toBe(true);
    expect(
      existsSync(
        resolve(
          input.privateRoot,
          "mockserver-bootstrap-" + input.runId,
          "verification",
          "unexpected",
        ),
      ),
    ).toBe(true);
  });
  it("fails closed when final cleanup exceeds the original deadline", async () => {
    const input = setup();
    state.afterBuild = () => {
      if (state.built.length === 1) {
        const now = input.deadline - 6_001;
        vi.spyOn(performance, "now")
          .mockReturnValueOnce(now)
          .mockReturnValueOnce(now)
          .mockReturnValueOnce(now)
          .mockReturnValue(input.deadline);
      }
    };
    await expect(prepareMockServerBootstrap(input)).rejects.toThrow();
    expect(state.marked).toBe(true);
    expect(
      existsSync(
        resolve(input.privateRoot, "mockserver-bootstrap-" + input.runId),
      ),
    ).toBe(true);
  });
});

describe("shared private material I/O", () => {
  it("quarantines a created root when its first identity bind fails", async () => {
    const input = setup();
    state.failRootBinding = true;
    await expect(prepareMockServerBootstrap(input)).rejects.toThrow(
      "root-binding",
    );
    expect(state.marked).toBe(true);
    expect(
      existsSync(
        resolve(input.privateRoot, "mockserver-bootstrap-" + input.runId),
      ),
    ).toBe(true);
    expect(state.acquired).toHaveLength(0);
  });
  it("bounds actual reader bytes when the source grows after pre-stat", () => {
    const input = setup();
    const file = resolve(input.privateRoot, "growing-source");
    writeFileSync(file, "code");
    const implementation = readFileSync(
      fileURLToPath(new URL("../harness-material-io.mjs", import.meta.url)),
      "utf8",
    );
    const body = implementation
      .slice(
        implementation.indexOf("export const readMaterialSource ="),
        implementation.indexOf("export const writeExclusive ="),
      )
      .replace("export const readMaterialSource =", "const reader =");
    let readBytes = 0;
    let stats = 0;
    const reader = runInNewContext(
      body + "\nreader;",
      {
        Buffer,
        createHash,
        constants: fs.constants,
        openSync: fs.openSync,
        closeSync: fs.closeSync,
        fail: () => {
          throw new Error("bounded-source");
        },
        fstatSync: (fd: number) => {
          const status = fs.fstatSync(fd);
          if (++stats === 1)
            fs.appendFileSync(file, Buffer.alloc(2 * 1024 * 1024));
          return status;
        },
        readSync: (
          fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const bytes = fs.readSync(fd, buffer, offset, length, position);
          readBytes += bytes;
          return bytes;
        },
      },
      { timeout: 1_000 },
    ) as (path: string) => unknown;
    expect(() => reader(file)).toThrow();
    expect(readBytes).toBeLessThanOrEqual(5); // four admitted bytes plus bounded overlength probe
  });
  it("refuses nonprivate parents and exclusive-write collisions", () => {
    const input = setup();
    chmodSync(input.privateRoot, 0o755);
    expect(() => exactDirectory(input.privateRoot)).toThrow();
    chmodSync(input.privateRoot, 0o700);
    const file = resolve(input.privateRoot, "existing");
    writeFileSync(file, "sentinel");
    expect(() => {
      writeExclusive(file, Buffer.from("replacement"));
    }).toThrow();
    expect(readFileSync(file, "utf8")).toBe("sentinel");
  });
  it("snapshots only bounded regular source bytes", () => {
    const input = setup();
    const file = resolve(input.privateRoot, "source");
    writeFileSync(file, "code");
    expect(readMaterialSource(file)).toEqual({
      bytes: Buffer.from("code"),
      sha256: sha(Buffer.from("code")),
    });
    writeFileSync(file, Buffer.alloc(1_048_577));
    expect(() => readMaterialSource(file)).toThrow();
    expect(() => readMaterialSource(input.privateRoot)).toThrow();
  });
});
