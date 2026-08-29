import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  assertOwnedToolingAuthority,
  assertToolchainImageAuthority,
  ensurePlatformImage,
  nativeCandidatePlatform,
} from "../../native-candidate/tooling/image-platform-authority.mjs";

const toolchain = Object.freeze({
  sourceReference:
    "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2",
  reference:
    "node@sha256:bb6834c0669aa71cbc8d94606561a721adf489f6b93d7b8b825f0cf1b498c2c4",
  expectedId:
    "sha256:a1bea2f8c1ee78866f82039a60baa1c3a480872018aa0ef4891000ec793ed82b",
});
const execution = Object.freeze({
  sourceReference:
    "node@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5",
  reference:
    "node@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5",
  expectedId:
    "sha256:955b467cb9a2a941cb181f7cf1d2405c1dd24b4566a3598b7eae7ecca1a769d1",
});
const inspection = (expectedId, architecture = "amd64") =>
  Object.freeze({
    error: undefined,
    status: 0,
    stdout: `${expectedId}\tlinux\t${architecture}\t\n`,
  });
const missing = Object.freeze({ error: undefined, status: 1, stdout: "" });
const pulled = Object.freeze({ error: undefined, status: 0, stdout: "" });
const releaseMaterials = JSON.parse(
  readFileSync(
    new URL(
      "../../native-candidate/files/records/release-materials.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const toolingBytes = Object.freeze({
  acquisitionDriver: readFileSync(
    new URL(
      "../../native-candidate/tooling/acquire-driver.mjs",
      import.meta.url,
    ),
  ),
  archiveCompiler: readFileSync(
    new URL(
      "../../native-candidate/tooling/archive-compiler.mjs",
      import.meta.url,
    ),
  ),
  materializeHelper: readFileSync(
    new URL(
      "../../native-candidate/tooling/materialize-helper.py",
      import.meta.url,
    ),
  ),
  execSupervisorSource: readFileSync(
    new URL(
      "../../native-candidate/tooling/exec-supervisor.c",
      import.meta.url,
    ),
  ),
  buildDriver: readFileSync(
    new URL("../../native-candidate/tooling/build-driver.py", import.meta.url),
  ),
  namespaceHelperSource: readFileSync(
    new URL(
      "../../native-candidate/tooling/namespace-helper.cpp",
      import.meta.url,
    ),
  ),
  runtimeBundler: readFileSync(
    new URL(
      "../../native-candidate/tooling/runtime-bundler.py",
      import.meta.url,
    ),
  ),
});
const recordedToolchainAuthority = Object.freeze({
  sourceIndex: releaseMaterials.toolchainClosure.image,
  selectedManifest:
    releaseMaterials.toolchainClosure.selectedManifest.reference,
  selectedManifestBytes:
    releaseMaterials.toolchainClosure.selectedManifest.bytes,
  configDigest: releaseMaterials.toolchainClosure.selectedManifest.configDigest,
  configBytes: releaseMaterials.toolchainClosure.selectedManifest.configBytes,
  rawIndexGzipBase64:
    releaseMaterials.toolchainClosure.selectedManifest.rawIndexGzipBase64,
  rawManifestGzipBase64:
    releaseMaterials.toolchainClosure.selectedManifest.rawManifestGzipBase64,
  platform: releaseMaterials.toolchainClosure.selectedManifest.platform,
});

const mutateRawProof = (field, mutate) => {
  const document = JSON.parse(
    gunzipSync(
      Buffer.from(recordedToolchainAuthority[field], "base64"),
    ).toString("utf8"),
  );
  mutate(document);
  return gzipSync(Buffer.from(JSON.stringify(document)), {
    level: 9,
    mtime: 0,
  }).toString("base64");
};

const expectToolchainAuthorityBinding = () => {
  expect(() =>
    assertToolchainImageAuthority(recordedToolchainAuthority),
  ).not.toThrow();
  expect(() =>
    assertToolchainImageAuthority({
      ...recordedToolchainAuthority,
      selectedManifest:
        "node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  ).toThrow("native candidate toolchain image authority invalid");
  expect(() =>
    assertToolchainImageAuthority({
      ...recordedToolchainAuthority,
      sourceIndex:
        "node@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  ).toThrow("native candidate toolchain image authority invalid");
  expect(() =>
    assertToolchainImageAuthority({
      ...recordedToolchainAuthority,
      selectedManifestBytes:
        recordedToolchainAuthority.selectedManifestBytes + 1,
    }),
  ).toThrow("native candidate toolchain image authority invalid");
  expect(() =>
    assertToolchainImageAuthority({
      ...recordedToolchainAuthority,
      rawManifestGzipBase64: `${recordedToolchainAuthority.rawManifestGzipBase64.slice(0, -4)}AAAA`,
    }),
  ).toThrow("native candidate toolchain image authority invalid");
  for (const authority of [
    {
      ...recordedToolchainAuthority,
      rawIndexGzipBase64: mutateRawProof("rawIndexGzipBase64", (index) => {
        index.manifests[0].digest =
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      }),
    },
    {
      ...recordedToolchainAuthority,
      rawIndexGzipBase64: mutateRawProof("rawIndexGzipBase64", (index) => {
        index.manifests[0].size += 1;
      }),
    },
    {
      ...recordedToolchainAuthority,
      rawManifestGzipBase64: mutateRawProof(
        "rawManifestGzipBase64",
        (manifest) => {
          manifest.config.digest =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        },
      ),
    },
    {
      ...recordedToolchainAuthority,
      rawManifestGzipBase64: mutateRawProof(
        "rawManifestGzipBase64",
        (manifest) => {
          manifest.config.size += 1;
        },
      ),
    },
  ])
    expect(() => assertToolchainImageAuthority(authority)).toThrow(
      "native candidate toolchain image authority invalid",
    );
};

const expectOwnedToolingBinding = () => {
  expect(() =>
    assertOwnedToolingAuthority(releaseMaterials.ownedTooling, toolingBytes),
  ).not.toThrow();
  expect(() =>
    assertOwnedToolingAuthority(
      {
        ...releaseMaterials.ownedTooling,
        buildDriverSha256:
          "da8f51f4d5e8178ec98c9eca9b57bda1fe325c11ce3c6482dbd806a386a2e459",
      },
      toolingBytes,
    ),
  ).toThrow("native candidate owned tooling authority invalid");
  expect(() =>
    assertOwnedToolingAuthority(releaseMaterials.ownedTooling, {
      ...toolingBytes,
      buildDriver: Buffer.concat([
        toolingBytes.buildDriver,
        Buffer.from("# substituted\n"),
      ]),
    }),
  ).toThrow("native candidate owned tooling authority invalid");
};

describe("native candidate platform image authority", () => {
  it.each([toolchain, execution])(
    "pulls $reference for the platform and inspects its exact config identity",
    (authority) => {
      const observed = [];
      const results = [missing, pulled, inspection(authority.expectedId)];

      ensurePlatformImage({
        ...authority,
        invoke(arguments_) {
          observed.push(arguments_);
          return results.shift();
        },
      });

      expect(results).toEqual([]);
      expect(observed).toEqual([
        [
          "image",
          "inspect",
          authority.expectedId,
          "--format",
          "{{.Id}}\t{{.Os}}\t{{.Architecture}}\t{{.Variant}}",
        ],
        ["pull", "--platform", "linux/amd64", authority.reference],
        [
          "image",
          "inspect",
          authority.expectedId,
          "--format",
          "{{.Id}}\t{{.Os}}\t{{.Architecture}}\t{{.Variant}}",
        ],
      ]);
    },
  );

  it("rejects a host-default arm64 selection without adopting it", () => {
    let invocations = 0;
    expect(() =>
      ensurePlatformImage({
        ...toolchain,
        invoke() {
          invocations += 1;
          return inspection(
            "sha256:9054c406605ceabba8948fd6817fcf2120b27f18de3e20a0c5eb6e12bf23b89a",
            "arm64",
          );
        },
      }),
    ).toThrow("native candidate image identity mismatch");
    expect(invocations).toBe(1);
  });

  it("never reacquires the multi-platform index after it is bound to arm64", () => {
    const observed = [];
    const results = [missing, pulled, inspection(toolchain.expectedId)];
    ensurePlatformImage({
      ...toolchain,
      invoke(arguments_) {
        observed.push(arguments_);
        return results.shift();
      },
    });

    expect(toolchain.reference).not.toBe(toolchain.sourceReference);
    expect(observed.flat()).not.toContain(toolchain.sourceReference);
    expect(observed.flat()).toContain(toolchain.reference);
  });

  it("binds the selected manifest to the authoritative source index", () => {
    expectToolchainAuthorityBinding();
  });

  it("binds retained tooling evidence to the exact current build driver", () => {
    expectOwnedToolingBinding();
  });

  it.each([
    [
      "config substitution",
      inspection(
        "sha256:9054c406605ceabba8948fd6817fcf2120b27f18de3e20a0c5eb6e12bf23b89a",
      ),
    ],
    [
      "operating-system substitution",
      {
        ...inspection(toolchain.expectedId),
        stdout: `${toolchain.expectedId}\tdarwin\tamd64\t\n`,
      },
    ],
    [
      "variant substitution",
      {
        ...inspection(toolchain.expectedId),
        stdout: `${toolchain.expectedId}\tlinux\tamd64\tv8\n`,
      },
    ],
  ])("rejects %s after platform-exact inspection", (_name, result) => {
    expect(() =>
      ensurePlatformImage({
        ...toolchain,
        invoke: () => result,
      }),
    ).toThrow("native candidate image identity mismatch");
  });

  it("owns one canonical platform tuple", () => {
    expect(nativeCandidatePlatform).toEqual({
      docker: "linux/amd64",
      os: "linux",
      architecture: "amd64",
      variant: "",
    });
  });
});
