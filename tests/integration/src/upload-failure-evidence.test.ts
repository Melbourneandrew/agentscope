import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

// prettier-ignore
// @ts-expect-error This private CI entry point deliberately has no package declaration.
import { buildLifecycleEnvironment, preloadCredentialedSource, revalidateCredentialedSource, settleLifecycleResult, uploadFailureEvidence, validFailureEvidenceBootstrapPredicate, validFailureEvidenceBootstrapStage, validLocalActionMetadata, verifyArtifactClientProvenanceForTest } from "../upload-failure-evidence.mjs";

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
  probe: (arguments_: string[]) => Promise<void>;
  startTicks: () => string;
}) => Promise<{
  artifactDigest: string;
  artifactId: number;
  artifactSize: number;
  status: "uploaded";
}>;
const invokeUpload = uploadFailureEvidence as unknown as UploadFailureEvidence;
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
const validActionMetadata = validLocalActionMetadata as unknown as (
  value: unknown,
) => boolean;
const verifyArtifactProvenance =
  verifyArtifactClientProvenanceForTest as unknown as (
    environment: NodeJS.ProcessEnv,
  ) => string | undefined;
const workspaceRoot = resolve(import.meta.dirname, "../../..");
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
const fixture = (): {
  arguments_: string[];
  content: Buffer;
  descriptor: number;
  root: string;
} => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-upload-"));
  const path = resolve(root, "evidence.json");
  const content = Buffer.from('{"bundleVersion":1}\n');
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
    "--python",
    "/usr/bin/python3",
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

describe("failure evidence uploader", () => {
  it("uploads the exact retained descriptor once with closed options", async () => {
    const owned = fixture();
    try {
      const uploadArtifact = vi.fn(
        (..._arguments: Parameters<UploadClient["uploadArtifact"]>) =>
          Promise.resolve({
            digest: "a".repeat(64),
            id: 17,
            size: 321,
          }),
      );
      const probe = vi.fn((_arguments: string[]) => Promise.resolve());
      const receipt = await invokeUpload({
        arguments_: owned.arguments_,
        client: {
          uploadArtifact: (...arguments_) => uploadArtifact(...arguments_),
        },
        nowNanoseconds: () => process.hrtime.bigint(),
        probe,
        startTicks: () => "123",
      });
      expect(uploadArtifact).toHaveBeenCalledTimes(1);
      expect(uploadArtifact).toHaveBeenCalledWith(
        "integration-0-of-1-1",
        [`/proc/self/fd/${owned.descriptor}`],
        "/proc/self/fd",
        { compressionLevel: 0, retentionDays: 7 },
      );
      expect(probe).toHaveBeenCalledTimes(2);
      expect(receipt).toEqual({
        artifactDigest: `sha256:${"a".repeat(64)}`,
        artifactId: 17,
        artifactSize: 321,
        status: "uploaded",
      });
      expect(readFileSync(owned.descriptor)).toEqual(owned.content);
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
        startTicks: () => "123",
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
  });
});

// eslint-disable-next-line max-lines-per-function -- The provenance suite keeps the exact fixture and every causal digest boundary together.
describe("failure evidence upload provenance", () => {
  // eslint-disable-next-line max-lines-per-function -- One isolated fixture executes every ordered package authority boundary.
  it("causally emits every closed artifact-provenance failure", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentscope-provenance-"));
    const sourceEntry = fileURLToPath(import.meta.resolve("@actions/artifact"));
    const sourcePackageRoot = resolve(sourceEntry, "../..");
    const patchedNames = [
      "path-and-artifact-name-validation.js",
      "stream.js",
      "upload-artifact.js",
      "zip.js",
    ];
    const packageRoot = resolve(
      root,
      "node_modules/.pnpm/@actions+artifact@6.2.1_patch_hash=test/node_modules/@actions/artifact",
    );
    const invalidPackageRoot = resolve(root, "invalid-package-root");
    const actionLink = resolve(
      root,
      "tests/integration/node_modules/@actions/artifact",
    );
    const patchPath = resolve(root, "patches/@actions__artifact@6.2.1.patch");
    const writePackage = (target: string) => {
      mkdirSync(resolve(target, "lib/internal/upload"), { recursive: true });
      for (const relative of [
        "package.json",
        "lib/artifact.js",
        ...patchedNames.map((name) => `lib/internal/upload/${name}`),
      ])
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
      mkdirSync(resolve(patchPath, ".."), { recursive: true });
      writePackage(packageRoot);
      writePackage(invalidPackageRoot);
      symlinkSync(packageRoot, actionLink);
      writeFileSync(
        patchPath,
        readFileSync(
          resolve(workspaceRoot, "patches/@actions__artifact@6.2.1.patch"),
        ),
      );
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
      assertDigestFailure(patchPath, "patch-digest");
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
      assertDigestFailure(
        resolve(packageRoot, "lib/artifact.js"),
        "entry-digest",
      );
      for (const name of patchedNames)
        assertDigestFailure(
          resolve(packageRoot, "lib/internal/upload", name),
          "patched-file-digest",
        );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("pins the artifact client provenance and its narrow retained-FD patch", () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(workspaceRoot, "tests/integration/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    const rootPackage = JSON.parse(
      readFileSync(resolve(workspaceRoot, "package.json"), "utf8"),
    ) as { pnpm: { patchedDependencies: Record<string, string> } };
    const lock = readFileSync(resolve(workspaceRoot, "pnpm-lock.yaml"), "utf8");
    const patch = readFileSync(
      resolve(workspaceRoot, "patches/@actions__artifact@6.2.1.patch"),
    );
    expect(packageJson.dependencies["@actions/artifact"]).toBe("6.2.1");
    expect(rootPackage.pnpm.patchedDependencies).toEqual({
      "@actions/artifact@6.2.1": "patches/@actions__artifact@6.2.1.patch",
    });
    expect(lock).toContain(
      "integrity: sha512-sJGH0mhEbEjBCw7o6SaLhUU66u27aFW8HTfkIb5Tk2/Wy0caUDc+oYQEgnuFN7a0HCpAbQyK0U6U7XUJDgDWrw==",
    );
    expect(createHash("sha256").update(patch).digest("hex")).toBe(
      "9638aca3637f07d89c766e49c1719eb2f58a20b1165da4962ea755e9032c392b",
    );
    expect(patch.toString("utf8")).toContain(
      "validateRetainedDescriptorPath(file.sourcePath, file.stats)",
    );
    const entry = fileURLToPath(import.meta.resolve("@actions/artifact"));
    expect(entry).toContain("patch_hash=");
    expect(statSync(entry).isFile()).toBe(true);
    const uploadRoot = resolve(entry, "../internal/upload");
    expect(
      Object.fromEntries(
        [
          "path-and-artifact-name-validation.js",
          "stream.js",
          "upload-artifact.js",
          "zip.js",
        ].map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(resolve(uploadRoot, name)))
            .digest("hex"),
        ]),
      ),
    ).toEqual({
      "path-and-artifact-name-validation.js":
        "6ce71a90c3abefd252265b4bad1dc38fe3980014d11fca8a240596615d99a6d4",
      "stream.js":
        "5eeaefb718a18cc6ac399c3433348d84e1c26af50d3c3defbb92cf05d988f96a",
      "upload-artifact.js":
        "f4936f8c7119371f65f08d7bce855458ea6c9476febfa56a0e289a454bb5427e",
      "zip.js":
        "4bd1967f092499689cd0e26d116a3ad1a138dc27ac2d87adb2493697a3ac2adc",
    });
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
});

it("admits only the exact closed action-bootstrap stage inventory", () => {
  for (const stage of [
    "invocation",
    "artifact-provenance",
    "preload-source",
    "preload-sealer",
    "spawn",
    "child-terminal",
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
    "child-terminal",
  ])
    expect(validBootstrapPredicate(stage)).toBe(true);
  for (const reason of [
    "results-url",
    "runtime-token",
    "workspace",
    "patch-digest",
    "package-root",
    "entry-digest",
    "patched-file-digest",
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
    "artifact-provenance:patched-file-digest:filename",
    "artifact-provenance:entry-digest\n",
    "invocation:argv-shape\n",
    ["invocation:argv-shape"],
    { predicate: "invocation:argv-shape" },
  ])
    expect(validBootstrapPredicate(rejected)).toBe(false);
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
            ],
            {
              cwd: workspaceRoot,
              encoding: "utf8",
              env: {},
              input: source,
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

describe("Linux retained failure evidence descriptor", () => {
  it.skipIf(process.platform !== "linux")(
    "streams only one exact retained self memfd and rejects aliases",
    () => {
      const entry = fileURLToPath(import.meta.resolve("@actions/artifact"));
      const uploadRoot = resolve(entry, "../internal/upload");
      const program = `
        import { closeSync, constants, lstatSync, openSync } from "node:fs";
        import { DefaultArtifactClient } from ${JSON.stringify(pathToFileURL(entry).href)};
        import { validateRetainedDescriptorPath } from ${JSON.stringify(
          pathToFileURL(
            resolve(uploadRoot, "path-and-artifact-name-validation.js"),
          ).href,
        )};
        import { createZipUploadStream } from ${JSON.stringify(
          pathToFileURL(resolve(uploadRoot, "zip.js")).href,
        )};
        const path = "/proc/self/fd/3";
        if (!validateRetainedDescriptorPath(path, lstatSync(path))) process.exit(1);
        const stream = await createZipUploadStream([{ sourcePath: path, destinationPath: "/evidence.json", stats: lstatSync(path) }], 0);
        let bytes = 0;
        for await (const chunk of stream) bytes += chunk.length;
        if (bytes < 1) process.exit(1);
        if (validateRetainedDescriptorPath("/ordinary/symlink", { isSymbolicLink: () => true }) !== false) process.exit(1);
        for (const rejected of ["/proc/1/fd/3", "/proc/self/fd/3/x", "/proc/self/fd/*", "/dev/fd/3", "../proc/self/fd/3"]) {
          let failed = false;
          try { validateRetainedDescriptorPath(rejected, {}); } catch { failed = true; }
          if (!failed) process.exit(1);
        }
        let multiple = false;
        try { await new DefaultArtifactClient().uploadArtifact("fixture", [path, "/ordinary"], "/", { retentionDays: 7 }); } catch { multiple = true; }
        if (!multiple) process.exit(1);
        closeSync(3);
        const reused = openSync("/dev/null", constants.O_RDONLY);
        if (reused !== 3) process.exit(1);
        let substituted = false;
        try { validateRetainedDescriptorPath(path, lstatSync(path)); } catch { substituted = true; }
        closeSync(reused);
        if (!substituted) process.exit(1);
      `;
      const python = `
import fcntl, os
content = b'{"bundleVersion":1}\\n'
fd = os.memfd_create('agentscope-sanitized-failure-evidence', os.MFD_ALLOW_SEALING)
if fd != 3: raise SystemExit(1)
os.write(fd, content)
os.fchmod(fd, 0o400)
fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
os.set_inheritable(fd, True)
os.execve(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, '--input-type=module', '--eval', ${JSON.stringify(program)}], {})
`;
      const result = spawnSync("/usr/bin/python3", ["-c", python], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result).toEqual(
        expect.objectContaining({ signal: null, status: 0, stderr: "" }),
      );
    },
  );
});
