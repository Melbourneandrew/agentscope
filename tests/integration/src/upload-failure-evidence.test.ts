import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// prettier-ignore
// @ts-expect-error This private CI entry point deliberately has no package declaration.
import { buildLifecycleEnvironment, childBootstrapTerminalAnnotationForTest, classifyActionBootstrapChildTerminalForTest, classifyChildBootstrapSpawnFailureForTest, classifyFailureEvidenceOpenForTest, createRegularUploadBridgeForTest, exerciseActionBootstrapSettlementForTest, exerciseAuthenticatedChildTerminalSettlementForTest, exerciseChildBootstrapReceiptsForTest, exerciseFailureEvidenceFinalizationForTest, exerciseOuterControllerFailureForTest, initializeFailureEvidenceRuntimeForTest, preloadCredentialedSource, revalidateCredentialedSource, settleLifecycleResult, uploadFailureEvidence, validFailureEvidenceBootstrapPredicate, validFailureEvidenceBootstrapStage, validLocalActionMetadata, validOuterControllerStage, verifyArtifactClientProvenanceForTest } from "../upload-failure-evidence.mjs";

const initializeRuntime =
  initializeFailureEvidenceRuntimeForTest as unknown as () => Promise<void>;
await initializeRuntime();

type ArtifactResponse = { digest?: string; id?: number; size?: number };
type UploadClient = {
  uploadArtifact: (
    name: string,
    files: string[],
    root: string,
    options: { compressionLevel: number; retentionDays: number },
  ) => Promise<ArtifactResponse>;
};
type UploadFailureEvidence = (options: {
  arguments_: string[];
  client: UploadClient;
  nowNanoseconds: () => bigint;
  probe: () => Promise<void>;
  sealerSource: Buffer;
  workspace: string;
}) => Promise<{
  artifactDigest: string;
  artifactId: number;
  artifactSize: number;
  status: "uploaded";
}>;
const invokeUpload = uploadFailureEvidence as unknown as UploadFailureEvidence;
const createBridge = createRegularUploadBridgeForTest as unknown as (options: {
  deadline: bigint;
  digest: string;
  nowNanoseconds: () => bigint;
  sealerSource: Buffer;
  size: number;
  sourceDescriptor: number;
  workspace: string;
}) => {
  path: string;
  revalidate: () => void;
  remove: () => void;
};
const buildChildEnvironment = buildLifecycleEnvironment as unknown as (
  environment: NodeJS.ProcessEnv,
) => NodeJS.ProcessEnv;
const preloadSource = preloadCredentialedSource as unknown as (
  path: string,
  maximumBytes: number,
) => { descriptor: number };
const revalidateSource = revalidateCredentialedSource as unknown as (
  authority: unknown,
) => void;
const settleLifecycle = settleLifecycleResult as unknown as (
  result: {
    code: number | null;
    contained: boolean;
    residualWorkObserved: boolean;
  },
  finalize: () => Promise<void>,
) => Promise<boolean>;
const validBootstrapStage = validFailureEvidenceBootstrapStage as unknown as (
  value: unknown,
) => boolean;
const validBootstrapPredicate =
  validFailureEvidenceBootstrapPredicate as unknown as (
    value: unknown,
  ) => boolean;
const exerciseBootstrapReceipts =
  exerciseChildBootstrapReceiptsForTest as unknown as (
    fault:
      | "valid"
      | "missing"
      | "duplicate"
      | "out-of-order"
      | "truncated"
      | "unknown"
      | "key-substitution"
      | "nonce-substitution"
      | "digest-substitution"
      | "mac-substitution",
    lastStage?: string,
  ) => string | undefined;
const childBootstrapTerminalAnnotation =
  childBootstrapTerminalAnnotationForTest as unknown as (
    value: unknown,
  ) => string | undefined;
const exerciseAuthenticatedChildTerminalSettlement =
  exerciseAuthenticatedChildTerminalSettlementForTest as unknown as (
    predicate: string,
    closeFailure: boolean,
    zeroExit?: boolean,
  ) => string | undefined;
const validActionMetadata = validLocalActionMetadata as unknown as (
  value: unknown,
) => boolean;
const validOuterStage = validOuterControllerStage as unknown as (
  value: unknown,
) => boolean;
const exerciseOuterFailure =
  exerciseOuterControllerFailureForTest as unknown as (stage: string) => {
    firstPreserved: boolean;
    forgedRejected: boolean;
    stage: string | undefined;
  };
const exerciseFinalizationFailure =
  exerciseFailureEvidenceFinalizationForTest as unknown as (reason: string) => {
    forgedRejected: boolean;
    primaryPreserved: boolean;
    reason: string | undefined;
  };
const classifyFinalizationOpen =
  classifyFailureEvidenceOpenForTest as unknown as (
    code: string | undefined,
  ) => string;
const classifyBootstrapChildTerminal =
  classifyActionBootstrapChildTerminalForTest as unknown as (result: {
    error?: { code?: string };
    signal?: string | null;
    status?: number | null;
  }) => string | undefined;
const classifyBootstrapSpawnFailure =
  classifyChildBootstrapSpawnFailureForTest as unknown as (value: {
    childBootstrapStage?: string;
    childBootstrapTerminal?: string;
    childTerminalReason?: string;
    result: { error?: unknown; status?: number | null };
  }) => boolean;
const exerciseBootstrapSettlement =
  exerciseActionBootstrapSettlementForTest as unknown as (
    fault:
      | "child-exit"
      | "child-bootstrap"
      | "descriptor-close"
      | "partial-zero"
      | "revalidate-sealer"
      | "revalidate-source"
      | "spawn",
    bootstrapStage?: string,
  ) => string | undefined;
const verifyArtifactProvenance =
  verifyArtifactClientProvenanceForTest as unknown as (
    environment: NodeJS.ProcessEnv,
    afterManifestRead?: () => void,
  ) => string | undefined;
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const sealerSource = readFileSync(
  resolve(workspaceRoot, "tests/integration/seal-failure-evidence.py"),
);
const invokeBootstrap = (
  entry: string,
  additionalArguments: string[],
  environment: NodeJS.ProcessEnv,
  preserveMain = false,
) =>
  spawnSync(
    process.execPath,
    [
      ...(preserveMain ? ["--preserve-symlinks-main"] : []),
      entry,
      ...additionalArguments,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    },
  );
const digest = (content: Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;
const fixture = (
  content = Buffer.from('{"bundleVersion":1}\n'),
): {
  arguments_: string[];
  content: Buffer;
  descriptor: number;
  root: string;
} => {
  const root = realpathSync(
    mkdtempSync(resolve(tmpdir(), "agentscope-upload-")),
  );
  const path = resolve(root, "evidence.json");
  writeFileSync(path, content, { mode: 0o400 });
  const descriptor = openSync(path, constants.O_RDONLY);
  const deadline = process.hrtime.bigint() + 30_000_000_000n;
  const arguments_ = [
    "--fd",
    String(descriptor),
    "--size",
    String(content.length),
    "--digest",
    digest(content),
    "--name",
    "integration-0-of-1-1",
    "--deadline",
    deadline.toString(),
  ];
  return { arguments_, content, descriptor, root };
};

describe("failure evidence action boundary", () => {
  it("never finalizes evidence without exact lifecycle containment", async () => {
    const finalize = vi.fn(() => Promise.resolve());
    await expect(
      settleLifecycle(
        { code: 1, contained: false, residualWorkObserved: true },
        finalize,
      ),
    ).rejects.toThrow("integration.controller.failure-evidence-upload");
    expect(finalize).not.toHaveBeenCalled();

    await expect(
      settleLifecycle(
        { code: 0, contained: true, residualWorkObserved: false },
        finalize,
      ),
    ).resolves.toBe(true);
    expect(finalize).not.toHaveBeenCalled();

    await expect(
      settleLifecycle(
        { code: 0, contained: true, residualWorkObserved: true },
        finalize,
      ),
    ).resolves.toBe(false);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("rejects named source replacement after retaining its exact descriptor", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentscope-action-source-"));
    const path = resolve(root, "source.mjs");
    writeFileSync(path, "export const authority = 1;\n", { mode: 0o600 });
    const authority = preloadSource(path, 1024);
    try {
      expect(() => {
        revalidateSource(authority);
      }).not.toThrow();
      rmSync(path);
      writeFileSync(path, "export const authority = 2;\n", { mode: 0o600 });
      expect(() => {
        revalidateSource(authority);
      }).toThrow("integration.controller.failure-evidence-upload");
    } finally {
      closeSync(authority.descriptor);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("removes every artifact-service credential from the lifecycle child", () => {
    expect(
      buildChildEnvironment({
        ACTIONS_RESULTS_URL: "https://results.actions.githubusercontent.com/",
        ACTIONS_RUNTIME_TOKEN: "secret",
        AGENTSCOPE_FAILURE_ARTIFACT_NAME: "integration-0-of-1-1",
        GITHUB_ACTION_PATH: "/action",
        GITHUB_ACTION_REPOSITORY: "owner/repository",
        GITHUB_ACTIONS: "true",
        REPLAY_SCENARIO: "",
        REPLAY_SHARD: "0/1",
      }),
    ).toEqual({
      AGENTSCOPE_INTEGRATION_SHARD: "0/1",
      GITHUB_ACTIONS: "true",
    });
  });

  it("rejects ordinary direct execution outside the local action boundary", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../upload-failure-evidence.mjs")],
      { encoding: "utf8", env: {}, timeout: 10_000 },
    );
    expect(result).toEqual(
      expect.objectContaining({ signal: null, status: 1, stderr: "" }),
    );
  });
});

// eslint-disable-next-line max-lines-per-function -- the uploader's exact bridge lifecycle is reviewed as one causal matrix.
describe("failure evidence uploader", () => {
  it("uploads one bounded private regular file and removes it", async () => {
    const owned = fixture();
    try {
      let stagedPath = "";
      let stagedRoot = "";
      const uploadArtifact = vi.fn(
        (...arguments_: Parameters<UploadClient["uploadArtifact"]>) => {
          stagedPath = arguments_[1][0]!;
          stagedRoot = arguments_[2];
          expect(arguments_[1]).toHaveLength(1);
          expect(
            stagedRoot.startsWith(`${owned.root}/.agentscope-failure-upload-`),
          ).toBe(true);
          expect(stagedPath).toBe(resolve(stagedRoot, "failure-evidence.json"));
          expect(statSync(stagedRoot).mode & 0o7777).toBe(0o700);
          const staged = lstatSync(stagedPath);
          expect(staged.isFile()).toBe(true);
          expect(staged.isSymbolicLink()).toBe(false);
          expect(staged.nlink).toBe(1);
          expect(staged.mode & 0o7777).toBe(0o400);
          expect(readFileSync(stagedPath)).toEqual(owned.content);
          return Promise.resolve({
            digest: "a".repeat(64),
            id: 17,
            size: 321,
          });
        },
      );
      const probe = vi.fn(() => Promise.resolve());
      const receipt = await invokeUpload({
        arguments_: owned.arguments_,
        client: {
          uploadArtifact: (...arguments_) => uploadArtifact(...arguments_),
        },
        nowNanoseconds: () => process.hrtime.bigint(),
        probe,
        sealerSource,
        workspace: owned.root,
      });
      expect(uploadArtifact).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(uploadArtifact.mock.calls[0]?.[0]).toBe("integration-0-of-1-1");
      expect(uploadArtifact.mock.calls[0]?.[3]).toEqual({
        compressionLevel: 0,
        retentionDays: 7,
      });
      expect(receipt).toEqual({
        artifactDigest: `sha256:${"a".repeat(64)}`,
        artifactId: 17,
        artifactSize: 321,
        status: "uploaded",
      });
      expect(readFileSync(owned.descriptor)).toEqual(owned.content);
      expect(stagedPath).not.toBe("");
      expect(stagedRoot).not.toBe("");
      expect(() => statSync(stagedPath)).toThrow();
      expect(() => statSync(stagedRoot)).toThrow();
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  for (const mutation of [
    "symlink",
    "hardlink",
    "truncate",
    "directory",
  ] as const) {
    it(`rejects a ${mutation} substitution after the artifact client opens the bridge`, async () => {
      const owned = fixture();
      try {
        await expect(
          invokeUpload({
            arguments_: owned.arguments_,
            client: {
              uploadArtifact: (_name, files) => {
                const path = files[0]!;
                if (mutation === "symlink") {
                  unlinkSync(path);
                  symlinkSync(resolve(owned.root, "evidence.json"), path);
                } else if (mutation === "hardlink") {
                  linkSync(path, `${path}.alias`);
                } else if (mutation === "truncate") {
                  chmodSync(path, 0o600);
                  writeFileSync(path, Buffer.from("x"));
                } else {
                  const directory = resolve(path, "..");
                  renameSync(directory, `${directory}.moved`);
                  mkdirSync(directory, { mode: 0o700 });
                }
                return Promise.resolve({
                  digest: "a".repeat(64),
                  id: 17,
                  size: 321,
                });
              },
            },
            nowNanoseconds: () => process.hrtime.bigint(),
            probe: () => Promise.resolve(),
            sealerSource,
            workspace: owned.root,
          }),
        ).rejects.toThrow("integration.controller.failure-evidence-upload");
      } finally {
        closeSync(owned.descriptor);
        rmSync(owned.root, { force: true, recursive: true });
      }
    });
  }

  it("admits the exact bundle bound and rejects boundary plus one before upload", async () => {
    for (const extra of [0, 1]) {
      const owned = fixture(Buffer.alloc(1024 * 1024 + extra, 0x61));
      const uploadArtifact = vi.fn(() =>
        Promise.resolve({ digest: "a".repeat(64), id: 17, size: 321 }),
      );
      try {
        const invocation = invokeUpload({
          arguments_: owned.arguments_,
          client: { uploadArtifact },
          nowNanoseconds: () => process.hrtime.bigint(),
          probe: () => Promise.resolve(),
          sealerSource,
          workspace: owned.root,
        });
        if (extra === 0) await expect(invocation).resolves.toBeDefined();
        else
          await expect(invocation).rejects.toThrow(
            "integration.controller.failure-evidence-upload",
          );
        expect(uploadArtifact).toHaveBeenCalledTimes(extra === 0 ? 1 : 0);
      } finally {
        closeSync(owned.descriptor);
        rmSync(owned.root, { force: true, recursive: true });
      }
    }
  });

  it("fails closed when exact bridge cleanup identity is substituted", () => {
    const owned = fixture();
    try {
      const bridge = createBridge({
        deadline: process.hrtime.bigint() + 30_000_000_000n,
        digest: digest(owned.content),
        nowNanoseconds: () => process.hrtime.bigint(),
        sealerSource,
        size: owned.content.length,
        sourceDescriptor: owned.descriptor,
        workspace: owned.root,
      });
      bridge.revalidate();
      linkSync(bridge.path, `${bridge.path}.alias`);
      expect(() => {
        bridge.remove();
      }).toThrow("integration.controller.failure-evidence-upload");
      expect(readFileSync(owned.descriptor)).toEqual(owned.content);
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  it("removes a partial bridge when sealed-source identity is rejected", () => {
    const owned = fixture();
    try {
      expect(() =>
        createBridge({
          deadline: process.hrtime.bigint() + 30_000_000_000n,
          digest: `sha256:${"0".repeat(64)}`,
          nowNanoseconds: () => process.hrtime.bigint(),
          sealerSource,
          size: owned.content.length,
          sourceDescriptor: owned.descriptor,
          workspace: owned.root,
        }),
      ).toThrow("integration.controller.failure-evidence-upload");
      expect(
        readdirSync(owned.root).filter((entry) =>
          entry.startsWith(".agentscope-failure-upload-"),
        ),
      ).toEqual([]);
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  it("removes the exact created inode after post-create validation fails", () => {
    const owned = fixture();
    try {
      const original = sealerSource.toString("utf8");
      const needle =
        '        sys.stdout.write(f\'{{"status":"created:{identity}"}}\\n\')';
      const substituted = original.replace(
        needle,
        `        os.fchmod(directory_descriptor, 0o755)\n${needle}`,
      );
      expect(substituted).not.toBe(original);
      expect(() =>
        createBridge({
          deadline: process.hrtime.bigint() + 30_000_000_000n,
          digest: digest(owned.content),
          nowNanoseconds: () => process.hrtime.bigint(),
          sealerSource: Buffer.from(substituted),
          size: owned.content.length,
          sourceDescriptor: owned.descriptor,
          workspace: owned.root,
        }),
      ).toThrow("integration.controller.failure-evidence-upload");
      expect(
        readdirSync(owned.root).filter((entry) =>
          entry.startsWith(".agentscope-failure-upload-"),
        ),
      ).toEqual([]);
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  it("kills and joins a stalled bridge helper inside the absolute deadline", () => {
    const owned = fixture();
    const started = Date.now();
    try {
      expect(() =>
        createBridge({
          deadline: process.hrtime.bigint() + 650_000_000n,
          digest: digest(owned.content),
          nowNanoseconds: () => process.hrtime.bigint(),
          sealerSource: Buffer.from("import time; time.sleep(10)\n"),
          size: owned.content.length,
          sourceDescriptor: owned.descriptor,
          workspace: owned.root,
        }),
      ).toThrow("integration.controller.failure-evidence-upload");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(
        readdirSync(owned.root).filter((entry) =>
          entry.startsWith(".agentscope-failure-upload-"),
        ),
      ).toEqual([]);
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  it("does not invoke the artifact client inside the cleanup reserve", async () => {
    const owned = fixture();
    const uploadArtifact = vi.fn(() =>
      Promise.resolve({ digest: "a".repeat(64), id: 17, size: 321 }),
    );
    let sample = 0;
    try {
      const arguments_ = [...owned.arguments_];
      arguments_[9] = "2000000000";
      await expect(
        invokeUpload({
          arguments_,
          client: { uploadArtifact },
          nowNanoseconds: () => {
            sample += 1;
            return sample < 3 ? 0n : 1_500_000_000n;
          },
          probe: () => Promise.resolve(),
          sealerSource,
          workspace: owned.root,
        }),
      ).rejects.toThrow("integration.controller.failure-evidence-upload");
      expect(uploadArtifact).not.toHaveBeenCalled();
      expect(
        readdirSync(owned.root).filter((entry) =>
          entry.startsWith(".agentscope-failure-upload-"),
        ),
      ).toEqual([]);
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  it("rejects substituted inputs and malformed terminal responses", async () => {
    const owned = fixture();
    const client: UploadClient = {
      uploadArtifact: () =>
        Promise.resolve({
          digest: "a".repeat(64),
          id: 17,
          size: 321,
        }),
    };
    const invoke = (
      arguments_: string[],
      selectedClient: UploadClient = client,
    ) =>
      invokeUpload({
        arguments_,
        client: selectedClient,
        nowNanoseconds: () => process.hrtime.bigint(),
        probe: () => Promise.resolve(),
        sealerSource,
        workspace: owned.root,
      });
    try {
      const replace = (index: number, value: string) =>
        owned.arguments_.map((entry, selected) =>
          selected === index ? value : entry,
        );
      for (const arguments_ of [
        owned.arguments_.slice(0, -2),
        replace(1, String(owned.descriptor + 1)),
        replace(3, "0"),
        replace(5, `sha256:${"0".repeat(64)}`),
        replace(7, "INVALID"),
        replace(9, "1"),
        [...owned.arguments_, "--extra", "value"],
      ])
        await expect(invoke(arguments_)).rejects.toThrow(
          "integration.controller.failure-evidence-upload",
        );
      await expect(
        invoke(owned.arguments_, {
          uploadArtifact: () => Promise.resolve({ id: 0, size: 0 }),
        }),
      ).rejects.toThrow("integration.controller.failure-evidence-upload");
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  it("contains no artifact list, download, delete, or retry authority", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../upload-failure-evidence.mjs"),
      "utf8",
    );
    expect(source.match(/\.uploadArtifact\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(
      /\.downloadArtifact\(|\.deleteArtifact\(|\.listArtifacts\(|\.getArtifact\(|retry/gu,
    );
    expect(source).toContain("Object.freeze({ uploadArtifact:");
    expect(source).toContain("retentionDays: 7");
    const uploader = source.slice(
      source.indexOf("const uploadFailureEvidenceImplementation"),
      source.indexOf("export const uploadFailureEvidence ="),
    );
    expect(uploader).not.toContain("/proc/self/fd");
    expect(uploader).toContain("createRegularUploadBridge");
    expect(source).toContain('"bridge-create"');
    expect(source).toContain('"bridge-remove"');
  });
});

// eslint-disable-next-line max-lines-per-function -- The provenance suite keeps the exact fixture and every causal digest boundary together.
describe("failure evidence upload provenance", () => {
  // eslint-disable-next-line max-lines-per-function -- One isolated fixture executes every ordered package authority boundary.
  it("causally emits every closed artifact-provenance failure", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentscope-provenance-"));
    const sourceEntry = fileURLToPath(import.meta.resolve("@actions/artifact"));
    const sourcePackageRoot = resolve(sourceEntry, "../..");
    const packageRoot = resolve(
      root,
      "node_modules/.pnpm/@actions+artifact@6.2.1/node_modules/@actions/artifact",
    );
    const invalidPackageRoot = resolve(root, "invalid-package-root");
    const actionLink = resolve(
      root,
      "tests/integration/node_modules/@actions/artifact",
    );
    const writePackage = (target: string) => {
      mkdirSync(resolve(target, "lib"), { recursive: true });
      for (const relative of ["package.json", "lib/artifact.js"])
        writeFileSync(
          resolve(target, relative),
          readFileSync(resolve(sourcePackageRoot, relative)),
        );
    };
    const annotation = (reason: string) =>
      `::error::integration.controller.failure-evidence-bootstrap:artifact-provenance:${reason}\n`;
    const environment = {
      ACTIONS_RESULTS_URL: "https://results.actions.githubusercontent.com/",
      ACTIONS_RUNTIME_TOKEN: "token",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_WORKSPACE: root,
    };
    try {
      mkdirSync(resolve(actionLink, ".."), { recursive: true });
      writePackage(packageRoot);
      writePackage(invalidPackageRoot);
      symlinkSync(packageRoot, actionLink);
      expect(verifyArtifactProvenance(environment)).toBeUndefined();
      expect(
        verifyArtifactProvenance({
          ...environment,
          ACTIONS_RESULTS_URL: undefined,
        }),
      ).toBe(annotation("results-url"));
      expect(
        verifyArtifactProvenance({
          ...environment,
          ACTIONS_RUNTIME_TOKEN: undefined,
        }),
      ).toBe(annotation("runtime-token"));
      expect(
        verifyArtifactProvenance({
          ...environment,
          GITHUB_SERVER_URL: "https://example.invalid",
        }),
      ).toBe(annotation("workspace"));

      const assertDigestFailure = (path: string, reason: string) => {
        const original = readFileSync(path);
        writeFileSync(path, Buffer.concat([original, Buffer.from("x")]));
        expect(verifyArtifactProvenance(environment)).toBe(annotation(reason));
        writeFileSync(path, original);
      };
      unlinkSync(actionLink);
      symlinkSync(invalidPackageRoot, actionLink);
      expect(verifyArtifactProvenance(environment)).toBe(
        annotation("package-root"),
      );
      unlinkSync(actionLink);
      symlinkSync(packageRoot, actionLink);
      const manifestPath = resolve(packageRoot, "package.json");
      const manifest = readFileSync(manifestPath);
      unlinkSync(manifestPath);
      mkdirSync(manifestPath);
      expect(verifyArtifactProvenance(environment)).toBe(
        annotation("package-manifest:type"),
      );
      rmSync(manifestPath, { recursive: true });
      writeFileSync(manifestPath, manifest);
      const manifestLink = resolve(packageRoot, "package-link");
      linkSync(manifestPath, manifestLink);
      expect(verifyArtifactProvenance(environment)).toBe(
        annotation("package-manifest:link-count"),
      );
      unlinkSync(manifestLink);
      writeFileSync(manifestPath, Buffer.alloc(0));
      expect(verifyArtifactProvenance(environment)).toBe(
        annotation("package-manifest:size"),
      );
      writeFileSync(manifestPath, Buffer.concat([manifest, Buffer.from("x")]));
      expect(verifyArtifactProvenance(environment)).toBe(
        annotation("package-manifest:digest"),
      );
      unlinkSync(manifestPath);
      symlinkSync(resolve(packageRoot, "package-source"), manifestPath);
      expect(verifyArtifactProvenance(environment)).toBe(
        annotation("package-manifest:identity-read"),
      );
      unlinkSync(manifestPath);
      writeFileSync(manifestPath, manifest);
      expect(
        verifyArtifactProvenance(environment, () => {
          chmodSync(manifestPath, 0o600);
        }),
      ).toBe(annotation("package-manifest:identity-read"));
      chmodSync(manifestPath, 0o644);
      expect(
        verifyArtifactProvenance(environment, () => {
          writeFileSync(
            manifestPath,
            Buffer.concat([manifest, Buffer.from("x")]),
          );
        }),
      ).toBe(annotation("package-manifest:identity-read"));
      writeFileSync(manifestPath, manifest);
      expect(
        verifyArtifactProvenance(environment, () => {
          const substituted = Buffer.from(manifest);
          substituted[0] = substituted[0] === 0x7b ? 0x5b : 0x7b;
          writeFileSync(manifestPath, substituted);
        }),
      ).toBe(annotation("package-manifest:identity-read"));
      writeFileSync(manifestPath, manifest);
      const lateManifestLink = resolve(packageRoot, "late-package-link");
      expect(
        verifyArtifactProvenance(environment, () => {
          linkSync(manifestPath, lateManifestLink);
        }),
      ).toBe(annotation("package-manifest:identity-read"));
      unlinkSync(lateManifestLink);
      assertDigestFailure(
        resolve(packageRoot, "lib/artifact.js"),
        "entry-digest",
      );
      const entryPath = resolve(packageRoot, "lib/artifact.js");
      const entryLink = resolve(packageRoot, "lib/artifact-link.js");
      linkSync(entryPath, entryLink);
      expect(verifyArtifactProvenance(environment)).toBe(
        annotation("entry-digest"),
      );
      unlinkSync(entryLink);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("pins the unmodified artifact client provenance", () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(workspaceRoot, "tests/integration/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    const rootPackage = JSON.parse(
      readFileSync(resolve(workspaceRoot, "package.json"), "utf8"),
    ) as { pnpm?: { patchedDependencies?: Record<string, string> } };
    const lock = readFileSync(resolve(workspaceRoot, "pnpm-lock.yaml"), "utf8");
    expect(packageJson.dependencies["@actions/artifact"]).toBe("6.2.1");
    expect(rootPackage.pnpm?.patchedDependencies).toBeUndefined();
    expect(lock).toContain(
      "integrity: sha512-sJGH0mhEbEjBCw7o6SaLhUU66u27aFW8HTfkIb5Tk2/Wy0caUDc+oYQEgnuFN7a0HCpAbQyK0U6U7XUJDgDWrw==",
    );
    const entry = fileURLToPath(import.meta.resolve("@actions/artifact"));
    expect(entry).not.toContain("patch_hash=");
    expect(statSync(entry).isFile()).toBe(true);
  });

  it("keeps the sealing handoff descriptor-minimal and pathname-free", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/seal-failure-evidence.py"),
      "utf8",
    );
    expect(source).toContain("os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING");
    expect(source).toContain("fcntl.F_ADD_SEALS, REQUIRED_SEALS");
    expect(source).toContain("os.set_inheritable(source_descriptor, True)");
    expect(source).toContain("os.set_inheritable(bundle_descriptor, True)");
    expect(source).toContain("os.set_inheritable(authority_descriptor, True)");
    expect(source).toContain("os.set_inheritable(3, True)");
    expect(source).toContain("source_descriptor != 4");
    expect(source).toContain("bundle_descriptor != 5");
    expect(source).toContain("authority_descriptor != 6");
    expect(source).toContain("os.fchdir(root_descriptor)");
    expect(source).toContain("os.execve(");
    expect(source).toContain('os.open("exe", os.O_PATH | os.O_CLOEXEC');
    expect(source).toContain("process_start_ticks(action_pid)");
    expect(source).toContain(
      "same_identity(os.fstat(node_descriptor), mapped_status)",
    );
    expect(source).toContain('"--input-type=module"');
    expect(source).not.toContain("UPLOADER_SHA256");
    expect(source).not.toMatch(/mkstemp|NamedTemporaryFile|\/tmp\/|sudo|tee/gu);
    expect(source).toContain('elif sys.argv[1] == "seal-existing"');
  });

  it("enters the authenticated bootstrap envelope before loading controller modules", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/upload-failure-evidence.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(
      /from "(?:\.\/dist\/index\.js|\.\/supervisor\.mjs|@actions\/artifact)"/u,
    );
    const envelope = source.slice(
      source.indexOf("const runOuterControllerEnvelope"),
      source.indexOf('if (process.argv[1] === "--outer-controller")'),
    );
    expect(
      envelope.indexOf('bootstrap.mark("bootstrap-entered")'),
    ).toBeLessThan(envelope.indexOf("await loadRuntimeDependencies()"));
    expect(envelope.indexOf('bootstrap.mark("module-load")')).toBeLessThan(
      envelope.indexOf("await loadRuntimeDependencies()"),
    );
    expect(source).toContain('import("./dist/index.js")');
    expect(source).toContain('import("./supervisor.mjs")');
    expect(source).toContain('import("@actions/artifact")');
    const parent = source.slice(
      source.indexOf("const bootstrapMain = async"),
      source.indexOf("const runOuterControllerEnvelope"),
    );
    expect(parent).not.toContain("loadRuntimeDependencies");
    expect(parent.indexOf("spawnSync(")).toBeLessThan(
      parent.indexOf("authenticateChildBootstrapReceipts({"),
    );
    expect(parent.indexOf("authenticateChildBootstrapReceipts({")).toBeLessThan(
      parent.indexOf("settleActionBootstrapDescriptors({"),
    );
  });
});

it("admits only the exact closed action-bootstrap stage inventory", () => {
  for (const stage of [
    "invocation",
    "artifact-provenance",
    "preload-source",
    "preload-sealer",
    "spawn",
    "child-terminal",
    "child-bootstrap",
    "revalidate-source",
    "revalidate-sealer",
    "descriptor-close",
  ])
    expect(validBootstrapStage(stage)).toBe(true);
  for (const rejected of [
    undefined,
    null,
    "",
    "unknown",
    "invocation:extra",
    "invocation\n",
    ["invocation"],
    { stage: "invocation" },
  ])
    expect(validBootstrapStage(rejected)).toBe(false);

  for (const reason of [
    "argv-shape",
    "github-actions",
    "action-path",
    "workspace",
    "results-url",
    "runtime-token",
    "artifact-name",
  ])
    expect(validBootstrapPredicate(`invocation:${reason}`)).toBe(true);
  for (const stage of [
    "preload-source",
    "preload-sealer",
    "spawn",
    "revalidate-source",
    "revalidate-sealer",
    "descriptor-close",
  ])
    expect(validBootstrapPredicate(stage)).toBe(true);
  for (const reason of [
    "results-url",
    "runtime-token",
    "workspace",
    "package-root",
    "entry-digest",
  ])
    expect(validBootstrapPredicate(`artifact-provenance:${reason}`)).toBe(true);
  for (const reason of [
    "type",
    "link-count",
    "size",
    "digest",
    "identity-read",
  ])
    expect(
      validBootstrapPredicate(`artifact-provenance:package-manifest:${reason}`),
    ).toBe(true);
  for (const rejected of [
    "invocation",
    "invocation:unknown",
    "invocation:argv-shape:argv-shape",
    "spawn:argv-shape",
    "artifact-provenance",
    "artifact-provenance:unknown",
    "artifact-provenance:package-manifest",
    "artifact-provenance:package-manifest:unknown",
    "artifact-provenance:package-manifest:digest:extra",
    "artifact-provenance:entry-digest\n",
    "invocation:argv-shape\n",
    ["invocation:argv-shape"],
    { predicate: "invocation:argv-shape" },
  ])
    expect(validBootstrapPredicate(rejected)).toBe(false);
  for (const reason of [
    "exit-one",
    "exit-other",
    "output-overflow",
    "signal",
    "timeout",
  ])
    expect(validBootstrapPredicate(`child-terminal:${reason}`)).toBe(true);
  for (const stage of [
    "bootstrap-entered",
    "module-load",
    "argv-config",
    "capability-open",
    "controller-entry",
    "unexpected-terminal",
  ])
    expect(validBootstrapPredicate(`child-bootstrap:${stage}`)).toBe(true);
  for (const rejected of [
    "child-terminal",
    "child-terminal:unknown",
    "child-terminal:exit-one:signal",
    "child-terminal:exit-one\n",
    "child-bootstrap",
    "child-bootstrap:unknown",
    "child-bootstrap:module-load:extra",
    "child-bootstrap:controller-entry\n",
  ])
    expect(validBootstrapPredicate(rejected)).toBe(false);
});

it("binds only closed outer-controller failure stages and preserves first cause", () => {
  const stages = [
    "prepare-systemd",
    "run-systemd",
    "revalidate-sealer",
    "finalize-evidence",
    "descriptor-close",
  ];
  for (const stage of stages) {
    expect(validOuterStage(stage)).toBe(true);
    expect(exerciseOuterFailure(stage)).toEqual({
      firstPreserved: true,
      forgedRejected: true,
      stage,
    });
  }
  for (const reason of [
    "open",
    "stat",
    "read",
    "validation",
    "write",
    "fsync",
    "child-terminal",
    "artifact-upload",
    "retirement",
  ]) {
    const stage = `finalize-evidence:${reason}`;
    expect(validOuterStage(stage)).toBe(true);
    expect(exerciseFinalizationFailure(reason)).toEqual({
      forgedRejected: true,
      primaryPreserved: true,
      reason,
    });
    expect(exerciseOuterFailure(stage)).toEqual({
      firstPreserved: true,
      forgedRejected: true,
      stage,
    });
  }
  for (const reason of [
    "missing",
    "symlink",
    "permission",
    "identity",
    "exhaustion",
    "other",
  ])
    expect(validOuterStage(`finalize-evidence:open:${reason}`)).toBe(true);
  for (const rejected of [
    undefined,
    "",
    "prepare-systemd:extra",
    "run-systemd\nfinalize-evidence",
    "unknown",
    "finalize-evidence:unknown",
    "finalize-evidence:open:stat",
    "finalize-evidence:open\n",
  ])
    expect(validOuterStage(rejected)).toBe(false);
});

it("classifies only closed content-free finalization open failures", () => {
  expect(classifyFinalizationOpen("ENOENT")).toBe("missing");
  expect(classifyFinalizationOpen("ELOOP")).toBe("symlink");
  expect(classifyFinalizationOpen("EACCES")).toBe("permission");
  expect(classifyFinalizationOpen("EPERM")).toBe("permission");
  expect(classifyFinalizationOpen("ENOTDIR")).toBe("identity");
  expect(classifyFinalizationOpen("EISDIR")).toBe("identity");
  expect(classifyFinalizationOpen("EMFILE")).toBe("exhaustion");
  expect(classifyFinalizationOpen("ENFILE")).toBe("exhaustion");
  expect(classifyFinalizationOpen("EBADF")).toBe("other");
  expect(classifyFinalizationOpen(undefined)).toBe("other");
});

it("classifies child terminal authority without retaining process output", () => {
  expect(classifyBootstrapChildTerminal({ status: 1, signal: null })).toBe(
    "exit-one",
  );
  expect(classifyBootstrapChildTerminal({ status: 17, signal: null })).toBe(
    "exit-other",
  );
  expect(
    classifyBootstrapChildTerminal({ status: null, signal: "SIGKILL" }),
  ).toBe("signal");
  expect(
    classifyBootstrapChildTerminal({
      error: { code: "ENOBUFS" },
      signal: "SIGTERM",
      status: null,
    }),
  ).toBe("output-overflow");
  expect(
    classifyBootstrapChildTerminal({
      error: { code: "ETIMEDOUT" },
      signal: "SIGTERM",
      status: null,
    }),
  ).toBe("timeout");
  for (const result of [
    { error: { code: "ENOENT" }, signal: null, status: null },
    { error: { code: "EAGAIN" }, signal: null, status: null },
    { signal: null, status: 0 },
  ])
    expect(classifyBootstrapChildTerminal(result)).toBeUndefined();
});

it("preserves exact spawn, child terminal, revalidation, and close stages", () => {
  expect(exerciseBootstrapSettlement("spawn")).toBe(
    "::error::integration.controller.failure-evidence-bootstrap:spawn\n",
  );
  expect(exerciseBootstrapSettlement("child-exit")).toBe(
    "::error::integration.controller.failure-evidence-bootstrap:child-terminal:exit-one\n",
  );
  for (const stage of [
    "bootstrap-entered",
    "module-load",
    "argv-config",
    "capability-open",
    "controller-entry",
    "unexpected-terminal",
  ])
    expect(exerciseBootstrapSettlement("child-bootstrap", stage)).toBe(
      `::error::integration.controller.failure-evidence-bootstrap:child-bootstrap:${stage}\n`,
    );
  expect(exerciseBootstrapSettlement("partial-zero", "argv-config")).toBe(
    "::error::integration.controller.failure-evidence-bootstrap:child-bootstrap:argv-config\n",
  );
  for (const stage of [
    "revalidate-source",
    "revalidate-sealer",
    "descriptor-close",
  ] as const)
    expect(exerciseBootstrapSettlement(stage)).toBe(
      `::error::integration.controller.failure-evidence-bootstrap:${stage}\n`,
    );
});

it("authenticates one ordered nonce-bound bootstrap handoff", () => {
  const stages = [
    "bootstrap-entered",
    "module-load",
    "argv-config",
    "capability-open",
    "controller-entry",
  ];
  for (const stage of [...stages, "unexpected-terminal"])
    expect(exerciseBootstrapReceipts("valid", stage)).toBe(stage);
  for (const fault of [
    "missing",
    "duplicate",
    "out-of-order",
    "truncated",
    "unknown",
    "key-substitution",
    "nonce-substitution",
    "digest-substitution",
    "mac-substitution",
  ] as const)
    expect(exerciseBootstrapReceipts(fault)).toBeUndefined();
});

it("MAC-binds each closed child terminal predicate into the bootstrap envelope", () => {
  const outer = "outer:finalize-evidence:open:missing";
  const lifecycle =
    "systemd-tool:lifecycle:terminal-wait:cgroup-observe-after-unit-not-found";
  const helper = "systemd-tool:client-terminal:deadline";
  for (const predicate of [outer, lifecycle, helper]) {
    expect(exerciseBootstrapReceipts("valid", predicate)).toBe(predicate);
    expect(childBootstrapTerminalAnnotation(predicate)).toBe(
      `::error::integration.controller.${predicate}\n`,
    );
    expect(exerciseAuthenticatedChildTerminalSettlement(predicate, false)).toBe(
      `::error::integration.controller.${predicate}\n`,
    );
    expect(exerciseAuthenticatedChildTerminalSettlement(predicate, true)).toBe(
      `::error::integration.controller.${predicate}\n`,
    );
    expect(
      exerciseAuthenticatedChildTerminalSettlement(predicate, false, true),
    ).toBe(`::error::integration.controller.${predicate}\n`);
    expect(
      classifyBootstrapSpawnFailure({
        childBootstrapStage: "controller-entry",
        childBootstrapTerminal: predicate,
        result: { status: 0 },
      }),
    ).toBe(true);
  }
  for (const stage of [
    "startup",
    "cutoff",
    "tool-spawn",
    "unit-admission",
    "retirement",
  ]) {
    const predicate = `systemd-tool:${stage}`;
    expect(exerciseBootstrapReceipts("valid", predicate)).toBe(predicate);
    expect(childBootstrapTerminalAnnotation(predicate)).toBe(
      `::error::integration.controller.${predicate}\n`,
    );
  }
  for (const [stage, reasons] of [
    [
      "sentinel",
      [
        "child-exit",
        "start-identity",
        "inherited-group",
        "transition-timeout",
        "kill",
        "reap-join",
        "residual",
        "internal-unknown",
      ],
    ],
    [
      "join",
      [
        "leader-identity",
        "preclose-residual",
        "control-close",
        "reap-timeout",
        "identity-drift",
        "postreap-residual",
        "internal-unknown",
      ],
    ],
    [
      "client-terminal",
      [
        "cutoff",
        "deadline",
        "leader-identity",
        "child-admission",
        "member-identity",
        "output-read",
        "output-bound",
        "nonzero-terminal",
        "internal-unknown",
      ],
    ],
  ] as const)
    for (const reason of reasons) {
      const predicate = `systemd-tool:${stage}:${reason}`;
      expect(exerciseBootstrapReceipts("valid", predicate)).toBe(predicate);
      expect(childBootstrapTerminalAnnotation(predicate)).toBe(
        `::error::integration.controller.${predicate}\n`,
      );
    }
  for (const rejected of [
    "outer:unknown",
    "systemd-tool:lifecycle:terminal-wait:unknown",
    "systemd-tool:sentinel",
    "systemd-tool:join:unknown",
    "systemd-tool:pid1-stat",
    "systemd-tool:startup:extra",
  ])
    expect(exerciseBootstrapReceipts("valid", rejected)).toBeUndefined();
  for (const fault of [
    "unknown",
    "key-substitution",
    "nonce-substitution",
    "digest-substitution",
    "mac-substitution",
    "truncated",
  ] as const)
    expect(exerciseBootstrapReceipts(fault, lifecycle)).toBeUndefined();
});

it("latches each reachable finalization reason at its production operation", () => {
  const source = readFileSync(
    resolve(workspaceRoot, "tests/integration/upload-failure-evidence.mjs"),
    "utf8",
  );
  const finalizer = source.slice(
    source.indexOf("export const finalizeFailureEvidence ="),
    source.indexOf("/* eslint-enable complexity, max-lines-per-function */"),
  );
  for (const [mark, operation] of [
    ['mark("open")', "descriptor = openSync("],
    ['mark("stat")', "const before = fstatSync(descriptor)"],
    ['mark("read")', "const content = readFileSync(descriptor)"],
    ['mark("validation")', "result = { content, status: before }"],
    ['mark("write")', "writeSync(bundleDescriptor"],
    ['mark("fsync")', "fsyncSync(bundleDescriptor)"],
    ['mark("child-terminal")', "const sealer = perform"],
    ['mark("artifact-upload")', "await uploadFailureEvidence({"],
    ['mark("retirement")', "const retireUploadedFailureEvidence ="],
  ] as const) {
    const markIndex = finalizer.indexOf(mark);
    const operationIndex = finalizer.indexOf(operation, markIndex);
    expect(markIndex, mark).toBeGreaterThanOrEqual(0);
    expect(operationIndex, operation).toBeGreaterThan(markIndex);
  }
  expect(finalizer).not.toMatch(/mark\("(?:rename|directory-fsync)"\)/u);
  expect(finalizer.match(/mark\("retirement"\)/gu)).toHaveLength(2);
  expect(finalizer).toContain(
    "if (firstFailure !== undefined) throw firstFailure",
  );
});

it("authenticates the exact closed local action metadata", () => {
  const metadata = readFileSync(
    resolve(workspaceRoot, "tests/integration/action.yml"),
  );
  expect(validActionMetadata(metadata)).toBe(true);
  expect(
    validActionMetadata(
      Buffer.from(metadata.toString("utf8").replace("node24", "node20")),
    ),
  ).toBe(false);
  expect(
    validActionMetadata(
      Buffer.from(
        metadata
          .toString("utf8")
          .replace("upload-failure-evidence.mjs", "alternate.mjs"),
      ),
    ),
  ).toBe(false);
  expect(
    validActionMetadata(Buffer.concat([metadata, Buffer.from("x: y\n")])),
  ).toBe(false);
});

it("causally classifies every action invocation failure", () => {
  const entry = resolve(
    workspaceRoot,
    "tests/integration/upload-failure-evidence.mjs",
  );
  const actionPath = resolve(workspaceRoot, "tests/integration");
  const substitutedEntry = resolve(
    actionPath,
    `.agentscope-substituted-entry-${process.pid}.mjs`,
  );
  symlinkSync(entry, substitutedEntry);
  const validEnvironment = {
    ACTIONS_RESULTS_URL: "https://results.actions.githubusercontent.com/",
    ACTIONS_RUNTIME_TOKEN: "token",
    AGENTSCOPE_FAILURE_ARTIFACT_NAME: "integration-0-of-1-1",
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKSPACE: workspaceRoot,
  };
  try {
    for (const {
      arguments_: additionalArguments,
      entry: invocationEntry = entry,
      environment,
      preserveMain = false,
      reason,
    } of [
      {
        arguments_: ["unexpected"],
        environment: validEnvironment,
        reason: "argv-shape",
      },
      { arguments_: [], environment: {}, reason: "github-actions" },
      {
        arguments_: [],
        entry: substitutedEntry,
        environment: validEnvironment,
        preserveMain: true,
        reason: "action-path",
      },
      {
        arguments_: [],
        environment: {
          ...validEnvironment,
          GITHUB_WORKSPACE: resolve(workspaceRoot, "missing-workspace"),
        },
        reason: "workspace",
      },
      {
        arguments_: [],
        environment: { ...validEnvironment, ACTIONS_RESULTS_URL: "://" },
        reason: "results-url",
      },
      {
        arguments_: [],
        environment: { ...validEnvironment, ACTIONS_RUNTIME_TOKEN: "" },
        reason: "runtime-token",
      },
      {
        arguments_: [],
        environment: {
          ...validEnvironment,
          AGENTSCOPE_FAILURE_ARTIFACT_NAME: "substituted",
        },
        reason: "artifact-name",
      },
    ]) {
      const terminal = invokeBootstrap(
        invocationEntry,
        additionalArguments,
        environment,
        preserveMain,
      );
      expect(terminal, reason).toMatchObject({
        signal: null,
        status: 1,
        stderr: "",
        stdout: `::error::integration.controller.failure-evidence-bootstrap:invocation:${reason}\n`,
      });
    }
  } finally {
    unlinkSync(substitutedEntry);
  }
});

describe("Linux sealed failure evidence upload", () => {
  it.skipIf(process.platform !== "linux")(
    "executes bootstrap only through the retained live action mapping",
    () => {
      const root = mkdtempSync(resolve(tmpdir(), "agentscope-bootstrap-"));
      try {
        const nodeAlias = resolve(root, "writable-node-alias");
        symlinkSync(process.execPath, nodeAlias);
        const source = Buffer.from(
          'process.stdout.write("{\\"status\\":\\"mapped\\"}\\n")',
        );
        const expectedDigest = digest(source);
        const processRecord = readFileSync(
          `/proc/${process.pid}/stat`,
          "ascii",
        );
        const close = processRecord.lastIndexOf(") ");
        const fields = processRecord
          .slice(close + 2)
          .trim()
          .split(" ");
        const start = fields[19];
        expect(close).toBeGreaterThan(1);
        expect(start).toMatch(/^[1-9]\d*$/u);
        const invoke = (node: string, pid: string, expectedStart: string) =>
          spawnSync(
            "/usr/bin/python3",
            [
              resolve(
                workspaceRoot,
                "tests/integration/seal-failure-evidence.py",
              ),
              "bootstrap",
              node,
              resolve(workspaceRoot, "tests/integration"),
              expectedDigest,
              pid,
              expectedStart,
              String(source.length),
            ],
            {
              cwd: workspaceRoot,
              encoding: "utf8",
              env: {},
              input: Buffer.concat([
                Buffer.alloc(32, 0x41),
                Buffer.alloc(16, 0x42),
                source,
              ]),
              stdio: ["pipe", "pipe", "pipe", "pipe"],
              timeout: 10_000,
            },
          );
        expect(invoke(nodeAlias, String(process.pid), start!)).toMatchObject({
          signal: null,
          status: 0,
          stderr: "",
          stdout: '{"status":"mapped"}\n',
        });
        for (const rejected of [
          invoke("/usr/bin/python3", String(process.pid), start!),
          invoke(nodeAlias, String(process.pid), `${start}0`),
          invoke(nodeAlias, "2147483647", start!),
        ]) {
          expect(rejected.signal).toBeNull();
          expect(rejected.status).toBe(1);
          expect(rejected.stdout).toBe("");
          expect(rejected.stderr).toMatch(
            /^integration\.controller\.failure-evidence-bootstrap:(?:mapping|exec)\n$/u,
          );
        }
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "resolves the integration client after a repository-root descriptor chdir",
    () => {
      const integrationRoot = resolve(workspaceRoot, "tests/integration");
      const program = `import { DefaultArtifactClient } from "@actions/artifact";
if (typeof DefaultArtifactClient !== "function") process.exit(1);
process.stdout.write(JSON.stringify({ cwd: process.cwd(), status: "resolved" }) + "\\n");`;
      const python = `import os
root = ${JSON.stringify(integrationRoot)}
descriptor = os.open(root, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY)
os.fchdir(descriptor)
os.close(descriptor)
os.execve(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, "--input-type=module", "--eval", ${JSON.stringify(program)}], {})
`;
      const result = spawnSync("/usr/bin/python3", ["-c", python], {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {},
        timeout: 10_000,
      });
      expect(result).toEqual(
        expect.objectContaining({ signal: null, status: 0, stderr: "" }),
      );
      expect(JSON.parse(result.stdout)).toEqual({
        cwd: integrationRoot,
        status: "resolved",
      });
    },
  );
});
