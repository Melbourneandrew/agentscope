import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compileNpmAttestationAudit,
  compileNpmVerifierPolicy,
  compileVerifiedNpmHarnessMaterial,
  compileVerifiedSignedManifestHarnessMaterial,
  type NpmHarnessMaterial,
  type SignedManifestHarnessMaterial,
} from "./harness-material.js";

const bytes = Buffer.from("exact harness archive");
const descriptor = {
  attestations: {
    bytes: 1,
    sha256: "f".repeat(64),
    url: "https://registry.npmjs.org/-/npm/v1/attestations/@vendor%2fharness@1.2.3",
  },
  installName: "@vendor/harness",
  packageName: "@vendor/harness",
  version: "1.2.3",
  tarballUrl: "https://registry.npmjs.org/@vendor/harness/-/harness-1.2.3.tgz",
  bytes: bytes.length,
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  shasum: createHash("sha1").update(bytes).digest("hex"),
};
const material: NpmHarnessMaterial = {
  kind: "npm",
  platformIdentity: `sha256-${"9".repeat(64)}`,
  verifierImage: `node@sha256:${"f".repeat(64)}`,
  registry: "https://registry.npmjs.org/",
  packages: [descriptor],
  provenance: {
    repository: "https://github.com/vendor/harness",
    sourceCommit: "a".repeat(40),
    tag: "v1.2.3",
    workflowPath: ".github/workflows/release.yml",
  },
};
const provenanceStatement = (overrides: Record<string, unknown> = {}) => ({
  _type: "https://in-toto.io/Statement/v1",
  subject: [
    {
      name: "pkg:npm/%40vendor/harness@1.2.3",
      digest: {
        sha512: Buffer.from(descriptor.integrity.slice(7), "base64").toString(
          "hex",
        ),
      },
    },
  ],
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          repository: material.provenance.repository,
          ref: `refs/tags/${material.provenance.tag}`,
          path: material.provenance.workflowPath,
        },
      },
      resolvedDependencies: [
        {
          uri: "git+https://github.com/vendor/harness",
          digest: { gitCommit: material.provenance.sourceCommit },
        },
      ],
    },
  },
  ...overrides,
});
const audit = (payload = provenanceStatement()) => ({
  invalid: [],
  missing: [],
  verified: [
    {
      name: descriptor.packageName,
      version: descriptor.version,
      location: `node_modules/${descriptor.packageName}`,
      registry: material.registry,
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/@vendor%2fharness@1.2.3",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
      attestationBundles: [
        {
          predicateType:
            "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
          bundle: {},
          signedAccessSignatureUrl: "",
        },
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            dsseEnvelope: {
              payloadType: "application/vnd.in-toto+json",
              payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
              signatures: [{ keyid: "", sig: "verified-by-npm" }],
            },
          },
          signedAccessSignatureUrl: "",
        },
      ],
    },
  ],
});
const compile = (changes: Record<string, unknown> = {}) =>
  compileVerifiedNpmHarnessMaterial({
    audit: audit(),
    evidenceId: "vendor-harness-v1",
    material,
    tarballs: new Map([["@vendor/harness@1.2.3", bytes]]),
    verifier: {
      controllerSha256: "d".repeat(64),
      image: material.verifierImage,
      imageConfigDigest: `sha256:${"b".repeat(64)}`,
      imageId: `sha256-${"c".repeat(64)}`,
      imageManifestDigest: `sha256:${"e".repeat(64)}`,
      name: "npm",
    },
    ...changes,
  });

describe("authenticated npm harness material", () => {
  it("strictly converts only the exact downloaded attestation response", () => {
    const bundles = audit().verified[0]!.attestationBundles;
    const key = `${descriptor.packageName}@${descriptor.version}`;
    expect(
      compileNpmAttestationAudit(
        material,
        new Map([
          [key, Buffer.from(JSON.stringify({ attestations: bundles }))],
        ]),
      ),
    ).toEqual(audit());
    expect(() =>
      compileNpmAttestationAudit(
        material,
        new Map([
          [
            key,
            Buffer.from(
              `{"attestations":${JSON.stringify(bundles)},"attestations":[]}`,
            ),
          ],
        ]),
      ),
    ).toThrow("integration.harness-material.invalid");
  });

  it("binds exact archive bytes and verified provenance", () => {
    const result = compile();
    expect(result.materialIdentity).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(result.packages[0]).toMatchObject({
      packageName: "@vendor/harness",
      version: "1.2.3",
      bytes: bytes.length,
    });
    expect(Object.isFrozen(result.packages)).toBe(true);
  });

  it("binds verifier attestations by exact package name and version", () => {
    const otherDescriptor = {
      ...descriptor,
      installName: "@vendor/harness-linux-x64",
      version: "1.2.3-linux-x64",
      attestations: {
        ...descriptor.attestations,
        url: "https://registry.npmjs.org/-/npm/v1/attestations/@vendor%2fharness@1.2.3-linux-x64",
      },
    };
    const first = audit().verified[0]!;
    const second = {
      ...first,
      version: otherDescriptor.version,
      location: `node_modules/${otherDescriptor.installName}`,
      attestations: {
        ...first.attestations,
        url: otherDescriptor.attestations.url,
      },
      attestationBundles: [
        ...first.attestationBundles,
        { predicateType: "distinct-version-marker" },
      ],
    };
    const policy = compileNpmVerifierPolicy(
      { ...material, packages: [descriptor, otherDescriptor] },
      { invalid: [], missing: [], verified: [first, second] },
    ) as { packages: { attestationBundleDigest: string }[] };

    expect(policy.packages).toHaveLength(2);
    expect(policy.packages[0]!.attestationBundleDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(policy.packages[0]!.attestationBundleDigest).not.toBe(
      policy.packages[1]!.attestationBundleDigest,
    );
  });

  it("rejects archive, audit, source, and subject substitutions", () => {
    const substitutedSource = provenanceStatement();
    substitutedSource.predicate.buildDefinition.externalParameters.workflow.repository =
      "https://github.com/attacker/repo";
    for (const changes of [
      {
        tarballs: new Map([["@vendor/harness@1.2.3", Buffer.from("other")]]),
      },
      { audit: { ...audit(), invalid: ["bad"] } },
      { audit: { ...audit(), missing: ["missing"] } },
      { audit: audit(provenanceStatement({ subject: [] })) },
      { audit: audit(substitutedSource) },
      {
        verifier: {
          controllerSha256: "d".repeat(64),
          image: material.verifierImage,
          imageConfigDigest: `sha256:${"b".repeat(64)}`,
          imageId: "invalid",
          imageManifestDigest: `sha256:${"e".repeat(64)}`,
          name: "npm",
        },
      },
    ])
      expect(() => compile(changes)).toThrow(
        "integration.harness-material.invalid",
      );
  });
});

// eslint-disable-next-line max-lines-per-function -- complete signed authority matrix
describe("authenticated signed-manifest harness material", () => {
  const binary = Buffer.from("exact signed harness binary");
  const checksum = createHash("sha256").update(binary).digest("hex");
  const manifestBytes = Buffer.from(
    JSON.stringify({
      metadata: {
        emptyArray: [],
        emptyObject: {},
        values: [true, false, null, -150, "escaped\nvalue"],
      },
      platforms: { "linux-x64": { checksum } },
    }),
  );
  const signatureBytes = Buffer.from("detached signature");
  const signingKeyBytes = Buffer.from("release key");
  const signedObject = (value: Buffer, url: string) => ({
    bytes: value.byteLength,
    sha256: createHash("sha256").update(value).digest("hex"),
    url,
  });
  const signedMaterial: SignedManifestHarnessMaterial = {
    kind: "signed-release-manifest",
    distributionId: "vendor-tool",
    version: "2.1.89",
    platform: "linux-x64",
    platformIdentity: `sha256-${"9".repeat(64)}`,
    verifierImage: `node@sha256:${"f".repeat(64)}`,
    binary: {
      ...signedObject(
        binary,
        "https://downloads.vendor.invalid/2.1.89/linux-x64/tool",
      ),
      executableName: "tool",
    },
    manifest: signedObject(
      manifestBytes,
      "https://downloads.vendor.invalid/2.1.89/manifest.json",
    ),
    signature: signedObject(
      signatureBytes,
      "https://downloads.vendor.invalid/2.1.89/manifest.json.sig",
    ),
    signingKey: {
      ...signedObject(
        signingKeyBytes,
        "https://downloads.vendor.invalid/keys/release.asc",
      ),
      fingerprint: "A".repeat(40),
      signerFingerprint: "A".repeat(40),
      signatureHashAlgorithm: "sha512",
      uid: "Vendor Release Signing <security@vendor.invalid>",
    },
  };
  const compileSigned = (changes: Record<string, unknown> = {}) =>
    compileVerifiedSignedManifestHarnessMaterial({
      binary,
      evidenceId: "vendor-tool-v1",
      manifestBytes,
      material: signedMaterial,
      signatureBytes,
      signingKeyBytes,
      verification: {
        primaryFingerprint: signedMaterial.signingKey.fingerprint,
        manifestSha256: signedMaterial.manifest.sha256,
        signatureHashAlgorithm: "sha512",
        signerFingerprint: signedMaterial.signingKey.fingerprint,
        uid: signedMaterial.signingKey.uid,
        verifier: {
          controllerSha256: "d".repeat(64),
          image: signedMaterial.verifierImage,
          imageConfigDigest: `sha256:${"b".repeat(64)}`,
          imageId: `sha256-${"c".repeat(64)}`,
          imageManifestDigest: `sha256:${"e".repeat(64)}`,
          name: "gpg",
        },
      },
      ...changes,
    });

  it("binds a signed manifest, signer, platform, and exact binary", () => {
    const result = compileSigned();
    expect(result.kind).toBe("signed-release-manifest");
    expect(result.binary).toMatchObject({
      executableName: "tool",
      platform: "linux-x64",
      sha256: checksum,
      version: "2.1.89",
    });
    expect(result.materialIdentity).toMatch(/^sha256-[a-f0-9]{64}$/u);
  });

  it("rejects binary, manifest, signer, and platform substitutions", () => {
    for (const changes of [
      { binary: Buffer.from("substituted") },
      { manifestBytes: Buffer.from('{"platforms":{}}') },
      {
        verification: {
          primaryFingerprint: "B".repeat(40),
          manifestSha256: signedMaterial.manifest.sha256,
          signatureHashAlgorithm: "sha512",
          signerFingerprint: signedMaterial.signingKey.fingerprint,
          uid: signedMaterial.signingKey.uid,
          verifier: {
            controllerSha256: "d".repeat(64),
            image: signedMaterial.verifierImage,
            imageConfigDigest: `sha256:${"b".repeat(64)}`,
            imageId: `sha256-${"c".repeat(64)}`,
            imageManifestDigest: `sha256:${"e".repeat(64)}`,
            name: "gpg",
          },
        },
      },
    ])
      expect(() => compileSigned(changes)).toThrow(
        "integration.harness-material.invalid",
      );
    const duplicateManifest = Buffer.from(
      `{"platforms":{"linux-x64":{"checksum":"${checksum}","checksum":"${checksum}"}}}`,
    );
    const duplicateManifestSha256 = createHash("sha256")
      .update(duplicateManifest)
      .digest("hex");
    expect(() =>
      compileSigned({
        manifestBytes: duplicateManifest,
        material: {
          ...signedMaterial,
          manifest: {
            ...signedMaterial.manifest,
            bytes: duplicateManifest.byteLength,
            sha256: duplicateManifestSha256,
          },
        },
        verification: {
          primaryFingerprint: signedMaterial.signingKey.fingerprint,
          manifestSha256: duplicateManifestSha256,
          signatureHashAlgorithm: "sha512",
          signerFingerprint: signedMaterial.signingKey.fingerprint,
          uid: signedMaterial.signingKey.uid,
          verifier: {
            controllerSha256: "d".repeat(64),
            image: signedMaterial.verifierImage,
            imageConfigDigest: `sha256:${"b".repeat(64)}`,
            imageId: `sha256-${"c".repeat(64)}`,
            imageManifestDigest: `sha256:${"e".repeat(64)}`,
            name: "gpg",
          },
        },
      }),
    ).toThrow("integration.harness-material.invalid");
  });
});
