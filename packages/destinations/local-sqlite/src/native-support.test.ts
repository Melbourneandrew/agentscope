import { describe, expect, it } from "vitest";

import {
  LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
  type LocalSqliteNativeSupportManifest,
  type LocalSqliteRuntimeIdentity,
} from "./native-support.js";
import { inspectLocalSqliteNativeSupportManifestForTesting as inspectLocalSqliteNativeSupport } from "./testing.js";

const runtime: LocalSqliteRuntimeIdentity = Object.freeze({
  nodeAbi: 127,
  nodeMajor: 22,
  platform: "linux",
  osVersion: "6.8",
  architecture: "x64",
  libcFamily: "glibc",
  libcVersion: "2.39",
  credentialBackend: "ci-environment",
  filesystemProfile: "local-ext4",
});

const binary = Object.freeze({
  tupleId: "node127-linux-x64-glibc",
  nodeAbi: 127,
  admittedNodeMajors: [22],
  platform: "linux" as const,
  minimumOsVersion: "5.15",
  architecture: "x64" as const,
  libcFamily: "glibc" as const,
  minimumLibcVersion: "2.35",
  relativePath: "native/linux-x64/agentscope_sqlite.node",
  bytes: 1,
  digest: `sha256:${"a".repeat(64)}`,
});

const platform = Object.freeze({
  platformId: "linux-x64-node22-ci-ext4",
  nativeTupleId: binary.tupleId,
  nodeMajor: 22,
  credentialBackend: "ci-environment",
  filesystemProfile: "local-ext4",
});

const manifest = (
  nativeBinaries: LocalSqliteNativeSupportManifest["nativeBinaries"] = [binary],
  supportedPlatforms: LocalSqliteNativeSupportManifest["supportedPlatforms"] = [
    platform,
  ],
): LocalSqliteNativeSupportManifest => ({
  ...LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
  artifactFiles: [
    ...LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.artifactFiles.filter(
      ({ kind }) => kind !== "native-binary",
    ),
    ...nativeBinaries.map((candidate) => ({
      kind: "native-binary" as const,
      relativePath: candidate.relativePath,
      bytes: candidate.bytes,
      digest: candidate.digest,
    })),
  ],
  nativeBinaries,
  supportedPlatforms,
});

describe("Local SQLite native support authority", () => {
  it("ships one proposed tuple without claiming release admission", () => {
    expect(LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.disposition).toBe(
      "proposed-unpublished-execution-eligible",
    );
    expect(LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.nativeBinaries).toHaveLength(1);
    expect(
      LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.supportedPlatforms,
    ).toHaveLength(1);
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
      ),
    ).toEqual({
      state: "available",
      admission: "proposed-unpublished",
      platformId: "linux-x64-node22-ci-ext4-proposed",
      nativeTupleId: "node127-linux-x64-glibc",
      relativePath: "native/node127-linux-x64-glibc/agentscope_sqlite.node",
      bytes: 2_222_616,
      maximumSnapshotBytes: 17_179_869_184,
      minimumNativeChildBudgetMilliseconds: 50,
      nativeTeardownReserveMilliseconds: 250,
      digest:
        "sha256:c580e8f3254f6603a0642db03f48569eaacf471a04497fe15bc1a0567e35292c",
    });
  });

  it("selects one exact full-platform to native-tuple projection", () => {
    expect(inspectLocalSqliteNativeSupport(runtime, manifest())).toEqual({
      state: "available",
      admission: "proposed-unpublished",
      platformId: platform.platformId,
      nativeTupleId: binary.tupleId,
      relativePath: binary.relativePath,
      bytes: 1,
      maximumSnapshotBytes: 17_179_869_184,
      minimumNativeChildBudgetMilliseconds: 50,
      nativeTeardownReserveMilliseconds: 250,
      digest: binary.digest,
    });
    expect(
      inspectLocalSqliteNativeSupport(
        { ...runtime, filesystemProfile: "local-apfs" },
        manifest(),
      ).state,
    ).toBe("unavailable");
  });
});

describe("Local SQLite native support rejection", () => {
  it("never coerces hostile declarative values", () => {
    let calls = 0;
    const hostile = Object.freeze({
      toString() {
        calls += 1;
        return "glibc";
      },
      [Symbol.toPrimitive]() {
        calls += 1;
        return "glibc";
      },
    });

    expect(
      inspectLocalSqliteNativeSupport(
        {
          ...runtime,
          libcFamily: hostile,
        } as unknown as LocalSqliteRuntimeIdentity,
        manifest(),
      ).state,
    ).toBe("unavailable");
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest([
          { ...binary, platform: hostile } as unknown as typeof binary,
        ]),
      ).state,
    ).toBe("unavailable");
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest([
          { ...binary, architecture: hostile } as unknown as typeof binary,
        ]),
      ).state,
    ).toBe("unavailable");
    expect(calls).toBe(0);
  });
});

describe("Local SQLite native evidence rejection", () => {
  it.each([
    { ...runtime, nodeMajor: 21 },
    { ...runtime, nodeMajor: 256 },
    { ...runtime, nodeMajor: 22.5 },
    { ...runtime, platform: "" },
    {
      ...runtime,
      platform: "darwin",
      libcFamily: "glibc",
      libcVersion: "2.39",
    },
    { ...runtime, architecture: "X".repeat(129) },
    { ...runtime, credentialBackend: "BAD" },
    { ...runtime, filesystemProfile: "bad/value" },
  ])("rejects an invalid runtime identity %#", (candidate) => {
    expect(inspectLocalSqliteNativeSupport(candidate, manifest()).state).toBe(
      "unavailable",
    );
  });

  it.each([
    { ...manifest(), schemaVersion: 2 },
    { ...manifest(), capability: "other" },
    { ...manifest(), loaderContract: "owned-absolute-no-discovery-v1" },
    { ...manifest(), namespaceMutationContract: "rename-by-path" },
    { ...manifest(), maximumSnapshotBytes: 0 },
    { ...manifest(), maximumSnapshotBytes: 64 * 1024 * 1024 * 1024 + 1 },
    { ...manifest(), maximumSnapshotBytes: 1.5 },
    { ...manifest(), nativeBinaries: Array.from({ length: 17 }, () => binary) },
    {
      ...manifest(),
      supportedPlatforms: Array.from({ length: 65 }, () => platform),
    },
  ] as unknown as LocalSqliteNativeSupportManifest[])(
    "rejects an invalid manifest envelope %#",
    (candidate) => {
      expect(inspectLocalSqliteNativeSupport(runtime, candidate).state).toBe(
        "unavailable",
      );
    },
  );
});

describe("Local SQLite release closure rejection", () => {
  it("rejects incomplete or substituted release closure evidence", () => {
    const complete = manifest();
    const without = (kind: string) =>
      complete.artifactFiles.filter((artifact) => artifact.kind !== kind);
    for (const candidate of [
      { ...complete, artifactFiles: without("loader") },
      { ...complete, artifactFiles: without("runtime") },
      { ...complete, artifactFiles: without("provenance") },
      { ...complete, artifactFiles: without("release-materials") },
      { ...complete, artifactFiles: without("sbom") },
      {
        ...complete,
        artifactFiles: complete.artifactFiles.filter(
          (artifact, index) => artifact.kind !== "notice" || index !== 2,
        ),
      },
      { ...complete, provenanceDigest: `sha256:${"b".repeat(64)}` },
      {
        ...complete,
        releaseMaterialManifestDigest: `sha256:${"b".repeat(64)}`,
      },
      { ...complete, sbomDigest: `sha256:${"b".repeat(64)}` },
      { ...complete, noticeInventoryDigest: `sha256:${"b".repeat(64)}` },
      {
        ...complete,
        artifactFiles: [
          ...complete.artifactFiles,
          { ...complete.artifactFiles[0]!, relativePath: "loader/extra.cjs" },
        ],
      },
    ] as LocalSqliteNativeSupportManifest[])
      expect(inspectLocalSqliteNativeSupport(runtime, candidate).state).toBe(
        "unavailable",
      );
  });
});

describe("Local SQLite native manifest rejection", () => {
  it.each([
    { ...binary, tupleId: "BAD" },
    { ...binary, nodeAbi: 0 },
    { ...binary, admittedNodeMajors: [] },
    { ...binary, admittedNodeMajors: [23, 22] },
    { ...binary, admittedNodeMajors: {} },
    { ...binary, admittedNodeMajors: [22, 22] },
    { ...binary, admittedNodeMajors: [21] },
    { ...binary, platform: "aix" },
    { ...binary, minimumOsVersion: "01" },
    { ...binary, architecture: "ia32" },
    { ...binary, libcFamily: null },
    { ...binary, minimumLibcVersion: "bad" },
    { ...binary, relativePath: "/absolute" },
    { ...binary, relativePath: "native\\escape" },
    { ...binary, relativePath: "native/../escape" },
    { ...binary, relativePath: "native/tuple/not-a-binary.txt" },
    { ...binary, bytes: 0 },
    { ...binary, bytes: 16 * 1024 * 1024 + 1 },
    { ...binary, bytes: 1.5 },
    { ...binary, digest: "sha256:bad" },
  ])("rejects malformed native binary evidence %#", (candidate) => {
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest([candidate as unknown as typeof binary]),
      ).state,
    ).toBe("unavailable");
  });

  it("rejects tuple, path, and digest aliases", () => {
    expect(
      inspectLocalSqliteNativeSupport(runtime, manifest([binary, binary]))
        .state,
    ).toBe("unavailable");
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest([binary, { ...binary, tupleId: "other" }]),
      ).state,
    ).toBe("unavailable");
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest([
          binary,
          {
            ...binary,
            tupleId: "same-projection",
            relativePath: "native/same-projection/agentscope_sqlite.node",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ]),
      ).state,
    ).toBe("unavailable");
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest([
          binary,
          {
            ...binary,
            tupleId: "other",
            relativePath: "native/other/agentscope_sqlite.node",
          },
        ]),
      ).state,
    ).toBe("unavailable");
  });
});

describe("Local SQLite platform projection rejection", () => {
  it.each([
    { ...platform, platformId: "BAD" },
    { ...platform, nativeTupleId: "missing" },
    { ...platform, nodeMajor: 21 },
    { ...platform, nodeMajor: 256 },
    { ...platform, nodeMajor: 22.5 },
    { ...platform, platform: "aix" },
    { ...platform, architecture: "ia32" },
    { ...platform, credentialBackend: "BAD" },
    { ...platform, filesystemProfile: "bad/value" },
  ] as unknown as (typeof platform)[])(
    "rejects malformed platform evidence %#",
    (candidate) => {
      expect(
        inspectLocalSqliteNativeSupport(
          runtime,
          manifest([binary], [candidate]),
        ).state,
      ).toBe("unavailable");
    },
  );

  it("rejects duplicate platform ids and ambiguous runtime matches", () => {
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest([binary], [platform, platform]),
      ).state,
    ).toBe("unavailable");
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest(
          [binary],
          [platform, { ...platform, platformId: "same-runtime-second" }],
        ),
      ).state,
    ).toBe("unavailable");
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest(
          [
            binary,
            {
              ...binary,
              tupleId: "other",
              relativePath: "native/other/agentscope_sqlite.node",
              digest: `sha256:${"b".repeat(64)}`,
            },
          ],
          [
            platform,
            {
              ...platform,
              platformId: "second",
              nativeTupleId: "other",
            },
          ],
        ),
      ).state,
    ).toBe("unavailable");
  });

  it("allows many full platforms to share one identical native projection", () => {
    expect(
      inspectLocalSqliteNativeSupport(
        { ...runtime, osVersion: "5.15", libcVersion: "2.35" },
        manifest(
          [binary],
          [
            platform,
            {
              ...platform,
              platformId: "linux-x64-node22-keychain-ext4",
              credentialBackend: "keychain",
            },
          ],
        ),
      ).state,
    ).toBe("available");
    const darwinBinary = {
      ...binary,
      tupleId: "node127-darwin-arm64",
      platform: "darwin" as const,
      minimumOsVersion: "14.0",
      architecture: "arm64" as const,
      libcFamily: null,
      minimumLibcVersion: null,
      relativePath: "native/darwin-arm64/agentscope_sqlite.node",
    };
    expect(
      inspectLocalSqliteNativeSupport(
        {
          ...runtime,
          platform: "darwin",
          osVersion: "15.0",
          architecture: "arm64",
          libcFamily: null,
          libcVersion: null,
        },
        manifest(
          [darwinBinary],
          [{ ...platform, nativeTupleId: darwinBinary.tupleId }],
        ),
      ).state,
    ).toBe("available");
  });
});

describe("Local SQLite native authority containment", () => {
  it("rejects unreferenced binaries and unsupported runtime projections", () => {
    const other = {
      ...binary,
      tupleId: "other",
      nodeAbi: 128,
      admittedNodeMajors: [23],
      relativePath: "native/other/agentscope_sqlite.node",
      digest: `sha256:${"b".repeat(64)}`,
    };
    expect(
      inspectLocalSqliteNativeSupport(
        runtime,
        manifest([binary, other], [platform]),
      ).state,
    ).toBe("unavailable");
    for (const candidate of [
      { ...runtime, nodeAbi: 128 },
      { ...runtime, nodeMajor: 23 },
      { ...runtime, platform: "darwin", libcFamily: null, libcVersion: null },
      { ...runtime, osVersion: "5.14" },
      { ...runtime, architecture: "arm64" },
      { ...runtime, libcFamily: "musl" },
      { ...runtime, libcVersion: "2.34" },
    ])
      expect(inspectLocalSqliteNativeSupport(candidate, manifest()).state).toBe(
        "unavailable",
      );
  });

  it("reconstructs manifest evidence once and rejects dynamic structures", () => {
    const accessor = { ...binary } as Record<string, unknown>;
    Object.defineProperty(accessor, "relativePath", {
      enumerable: true,
      get: () => binary.relativePath,
    });
    const extra = { ...binary, extra: true };
    const symbol = { ...binary, [Symbol("extra")]: true };
    for (const candidate of [accessor, extra, symbol])
      expect(
        inspectLocalSqliteNativeSupport(
          runtime,
          manifest([candidate as typeof binary]),
        ).state,
      ).toBe("unavailable");
    const sparse = new Array(1) as (typeof binary)[];
    expect(
      inspectLocalSqliteNativeSupport(runtime, manifest(sparse)).state,
    ).toBe("unavailable");
    const accessorArray = [binary];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => binary,
    });
    expect(
      inspectLocalSqliteNativeSupport(runtime, manifest(accessorArray)).state,
    ).toBe("unavailable");
    const throwing = new Proxy(manifest(), {
      ownKeys: () => {
        throw new Error("CANARY");
      },
    });
    expect(inspectLocalSqliteNativeSupport(runtime, throwing).state).toBe(
      "unavailable",
    );
  });

  it("rejects non-record runtime and manifest envelopes", () => {
    const badRuntimeValues = [
      null,
      [],
      Object.create(null),
      { ...runtime, extra: true },
      Object.fromEntries(
        Object.entries(runtime).filter(([key]) => key !== "nodeAbi"),
      ),
    ];
    for (const candidate of badRuntimeValues)
      expect(
        inspectLocalSqliteNativeSupport(
          candidate as LocalSqliteRuntimeIdentity,
          manifest(),
        ).state,
      ).toBe("unavailable");
    for (const candidate of [null, [], Object.create(null)])
      expect(
        inspectLocalSqliteNativeSupport(
          runtime,
          candidate as LocalSqliteNativeSupportManifest,
        ).state,
      ).toBe("unavailable");
    expect(
      inspectLocalSqliteNativeSupport(runtime, {
        ...manifest(),
        nativeBinaries:
          {} as LocalSqliteNativeSupportManifest["nativeBinaries"],
      }).state,
    ).toBe("unavailable");
  });
});
