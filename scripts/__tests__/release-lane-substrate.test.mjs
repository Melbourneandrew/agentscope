import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, test } from "vitest";
import { parse, stringify } from "yaml";

import {
  resolveContainedArtifactPath,
  verifyCandidateArtifact,
} from "../release-lane/candidate.mjs";
import {
  collectReleaseAuthorityBytes,
  releaseEntryPoints,
  validateOfflineReleasePolicy,
} from "../release-lane/offline-policy.mjs";
import {
  createSyntheticRecord,
  syntheticReleaseAuthority,
  validateSyntheticReleaseRecords,
} from "../release-lane/records.mjs";
import { canonicalJson, sha256 } from "../release-lane/validation.mjs";
import { validateReleaseWorkflowContext } from "../release-lane/workflow-context.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const checkedInWorkflow = readFileSync(
  join(workspaceRoot, ".github/workflows/release-candidate-rehearsal.yml"),
  "utf8",
);
const fixtures = [];
const sourceRevision = "a".repeat(40);
const candidateManifestDigest = `sha256:${"c".repeat(64)}`;
const candidateTarballSha256 = `sha256:${"d".repeat(64)}`;
const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const trustedCandidate = Object.freeze({
  manifestDigest: candidateManifestDigest,
  tarballSha256: candidateTarballSha256,
  integrity,
  sourceRevision,
  protectedTag: "v0.1.0",
  packageName: "agentscope-cli",
  packageVersion: "0.1.0",
  distTag: "alpha",
});
const observedReleaseBytes = {
  workflowBytes: Buffer.from("workflow-v1\n"),
  releaseScripts: {
    "scripts/release-lane/candidate.mjs": Buffer.from("candidate-v1\n"),
    "scripts/release-lane/records.mjs": Buffer.from("records-v1\n"),
    "scripts/release-lane/validation.mjs": Buffer.from("validation-v1\n"),
    "scripts/release-lane/workflow-context.mjs": Buffer.from(
      "workflow-context-v1\n",
    ),
  },
};
const workflowDigest = sha256(observedReleaseBytes.workflowBytes);
const releaseScripts = Object.entries(observedReleaseBytes.releaseScripts).map(
  ([path, bytes]) => ({ path, digest: sha256(bytes) }),
);

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { force: true, recursive: true });
});

function tarOctal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function createTarEntry(path, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(tarOctal(0o644, 8), 100, 8, "ascii");
  header.write(tarOctal(0, 8), 108, 8, "ascii");
  header.write(tarOctal(0, 8), 116, 8, "ascii");
  header.write(tarOctal(body.length, 12), 124, 12, "ascii");
  header.write(tarOctal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([
    header,
    body,
    Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length),
  ]);
}

function createCandidateFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentscope-release-candidate-"));
  fixtures.push(root);
  const packageManifest = {
    name: "agentscope-cli",
    version: "0.1.0",
    bin: { agentscope: "./dist/bin/agentscope.js" },
    publishConfig: { access: "public" },
  };
  const extraEntries = overrides.extraEntries ?? [];
  const entries = [
    {
      path: "package/package.json",
      content: `${JSON.stringify(overrides.packageManifest ?? packageManifest)}\n`,
    },
    ...(!overrides.omitBin &&
    !extraEntries.some(({ path }) => path === "package/dist/bin/agentscope.js")
      ? [
          {
            path: "package/dist/bin/agentscope.js",
            content: "#!/usr/bin/env node\n",
          },
        ]
      : []),
    ...extraEntries,
  ];
  const inventory = entries.map(({ path, content }) => ({
    bytes: Buffer.byteLength(content),
    path,
    sha256: sha256(Buffer.from(content)),
  }));
  const tarball = gzipSync(
    Buffer.concat([
      ...entries.map(({ path, content }) => createTarEntry(path, content)),
      Buffer.alloc(1024),
    ]),
    { level: 9, mtime: 0 },
  );
  const tarballPath = join(root, "agentscope-cli-0.1.0.tgz");
  writeFileSync(tarballPath, tarball);
  const manifest = {
    schemaVersion: 1,
    candidateId: "agentscope.release-candidate.v1",
    package: {
      name: "agentscope-cli",
      version: "0.1.0",
      bin: { agentscope: "./dist/bin/agentscope.js" },
    },
    channel: { npmDistTag: "alpha", githubPrerelease: true },
    sourceRevision,
    protectedTag: "v0.1.0",
    tarball: {
      fileName: "agentscope-cli-0.1.0.tgz",
      bytes: tarball.length,
      sha256: `sha256:${createHash("sha256").update(tarball).digest("hex")}`,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      inventoryDigest: sha256(canonicalJson(inventory)),
    },
    certification: { state: "certified", recordDigest: "" },
  };
  const certificationRecord = {
    schemaVersion: 1,
    recordId: "agentscope.candidate-certification.v1",
    state: "certified",
    package: { name: "agentscope-cli", version: "0.1.0" },
    sourceRevision,
    protectedTag: "v0.1.0",
    tarballSha256: manifest.tarball.sha256,
    inventoryDigest: manifest.tarball.inventoryDigest,
    supportAdmissionDigest: `sha256:${"b".repeat(64)}`,
    evidenceIndexDigest: `sha256:${"c".repeat(64)}`,
  };
  manifest.certification.recordDigest = sha256(
    canonicalJson(certificationRecord),
  );
  return {
    certificationRecord,
    manifest,
    manifestDigest: sha256(canonicalJson(manifest)),
    root,
    tarballPath,
  };
}

function verify(fixture, manifest = fixture.manifest, expected = {}) {
  return () =>
    verifyCandidateArtifact({
      manifest,
      certificationRecord:
        expected.certificationRecord ?? fixture.certificationRecord,
      tarballPath: fixture.tarballPath,
      expectedManifestDigest:
        expected.manifestDigest ?? sha256(canonicalJson(manifest)),
      expectedSourceRevision: expected.sourceRevision ?? sourceRevision,
      expectedProtectedTag: expected.protectedTag ?? "v0.1.0",
    });
}

test("verifies one exact certified agentscope-cli tarball without rebuilding", () => {
  const fixture = createCandidateFixture();
  assert.deepEqual(verify(fixture)(), {
    bytes: fixture.manifest.tarball.bytes,
    inventoryEntries: 2,
    inventoryDigest: fixture.manifest.tarball.inventoryDigest,
    manifestDigest: fixture.manifestDigest,
    package: "agentscope-cli",
    protectedTag: "v0.1.0",
    sha256: fixture.manifest.tarball.sha256,
    sourceRevision,
    version: "0.1.0",
  });
});

test("resolves only regular files contained by the downloaded artifact root", () => {
  const fixture = createCandidateFixture();
  assert.equal(
    resolveContainedArtifactPath(
      fixture.root,
      "agentscope-cli-0.1.0.tgz",
      "tarball",
    ),
    realpathSync(fixture.tarballPath),
  );
  assert.throws(
    () => resolveContainedArtifactPath(fixture.root, "../outside", "tarball"),
    /canonical contained relative artifact path/,
  );
  for (const path of ["./agentscope-cli-0.1.0.tgz", "nested\\artifact.tgz"])
    assert.throws(
      () => resolveContainedArtifactPath(fixture.root, path, "tarball"),
      /canonical contained relative artifact path/,
    );
  const outside = join(fixture.root, "..", "outside-release-candidate");
  writeFileSync(outside, "outside");
  fixtures.push(outside);
  symlinkSync(outside, join(fixture.root, "linked-artifact"));
  assert.throws(
    () =>
      resolveContainedArtifactPath(fixture.root, "linked-artifact", "tarball"),
    /escapes the artifact root/,
  );
});

test("rejects source, protected-tag, digest, filename, and certification mismatches", () => {
  const fixture = createCandidateFixture();
  const selfAuthored = {
    ...fixture.manifest,
    sourceRevision: "d".repeat(40),
  };
  assert.throws(
    verify(fixture, selfAuthored, {
      manifestDigest: fixture.manifestDigest,
      sourceRevision: "d".repeat(40),
    }),
    /manifest digest mismatch/,
  );
  assert.throws(
    verify(fixture, fixture.manifest, { sourceRevision: "d".repeat(40) }),
    /source revision mismatch/,
  );
  assert.throws(
    verify(fixture, fixture.manifest, { protectedTag: "v0.1.1" }),
    /protected tag mismatch/,
  );
  assert.throws(
    verify(fixture, {
      ...fixture.manifest,
      tarball: {
        ...fixture.manifest.tarball,
        sha256: `sha256:${"0".repeat(64)}`,
      },
    }),
    /Certification record does not bind|SHA-256 mismatch/,
  );
  assert.throws(
    verify(fixture, {
      ...fixture.manifest,
      tarball: { ...fixture.manifest.tarball, fileName: "other.tgz" },
    }),
    /tarball identity drifted|filename mismatch/,
  );
  assert.throws(
    verify(fixture, {
      ...fixture.manifest,
      certification: { ...fixture.manifest.certification, state: "pending" },
    }),
    /not explicitly certified/,
  );
  assert.throws(
    verify(fixture, fixture.manifest, {
      certificationRecord: {
        ...fixture.certificationRecord,
        evidenceIndexDigest: `sha256:${"f".repeat(64)}`,
      },
    }),
    /Certification record digest mismatch/,
  );
});

test("rejects stale private-package, rebuilt-substitution, and packed channel drift", () => {
  const missingExecutable = createCandidateFixture({ omitBin: true });
  assert.throws(verify(missingExecutable), /executable is missing/);

  const stale = createCandidateFixture({
    packageManifest: {
      name: "@agentscope/core",
      version: "0.1.0",
      bin: { agentscope: "./dist/bin/agentscope.js" },
      publishConfig: { access: "public" },
    },
  });
  assert.throws(verify(stale), /Packed manifest identity mismatch/);

  const rebuilt = createCandidateFixture();
  writeFileSync(
    rebuilt.tarballPath,
    Buffer.concat([readFileSync(rebuilt.tarballPath), Buffer.from([0])]),
  );
  assert.throws(verify(rebuilt), /byte-size mismatch/);

  const channel = createCandidateFixture({
    packageManifest: {
      name: "agentscope-cli",
      version: "0.1.0",
      bin: { agentscope: "./dist/bin/agentscope.js" },
      publishConfig: { access: "public", tag: "latest" },
    },
  });
  assert.throws(verify(channel), /packed publishConfig keys drifted/);

  for (const extraAuthority of [
    { scripts: { preinstall: "node install.mjs" } },
    { workspaces: ["packages/*"] },
    { packageManager: "pnpm@9.15.0" },
  ]) {
    const extraManifestAuthority = createCandidateFixture({
      packageManifest: {
        name: "agentscope-cli",
        version: "0.1.0",
        bin: { agentscope: "./dist/bin/agentscope.js" },
        publishConfig: { access: "public" },
        ...extraAuthority,
      },
    });
    assert.throws(verify(extraManifestAuthority), /non-publish authority/);
  }
});

test("rejects private dependency metadata and nested payload while allowing bundled code", () => {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const privateDependency = createCandidateFixture({
      packageManifest: {
        name: "agentscope-cli",
        version: "0.1.0",
        bin: { agentscope: "./dist/bin/agentscope.js" },
        publishConfig: { access: "public" },
        [field]: { "@agentscope/core": "0.1.0" },
      },
    });
    assert.throws(verify(privateDependency), /private dependency/);
    const privateAlias = createCandidateFixture({
      packageManifest: {
        name: "agentscope-cli",
        version: "0.1.0",
        bin: { agentscope: "./dist/bin/agentscope.js" },
        publishConfig: { access: "public" },
        [field]: { alias: "npm:@agentscope/core@^0.1.0" },
      },
    });
    assert.throws(verify(privateAlias), /private package specification/);
    for (const specification of [
      "https://registry.npmjs.org/@agentscope/core/-/core-0.1.0.tgz",
      "git+https://github.com/Melbourneandrew/agentscope-core.git",
      "https://registry.npmjs.org/%40agentscope%2Fcore/-/core-0.1.0.tgz",
    ]) {
      const privateUrl = createCandidateFixture({
        packageManifest: {
          name: "agentscope-cli",
          version: "0.1.0",
          bin: { agentscope: "./dist/bin/agentscope.js" },
          publishConfig: { access: "public" },
          [field]: { alias: specification },
        },
      });
      assert.throws(
        verify(privateUrl),
        /private package|non-registry dependency/,
      );
    }
    for (const specification of [
      "../packages/core",
      "./packages/core",
      "/private/tmp/core",
      "~/packages/core",
      "GIT+SSH://example.invalid/core.git",
    ]) {
      const nonRegistryDependency = createCandidateFixture({
        packageManifest: {
          name: "agentscope-cli",
          version: "0.1.0",
          bin: { agentscope: "./dist/bin/agentscope.js" },
          publishConfig: { access: "public" },
          [field]: { publicAlias: specification },
        },
      });
      assert.throws(
        verify(nonRegistryDependency),
        /non-registry dependency specification/,
      );
    }
  }

  const bundled = createCandidateFixture({
    packageManifest: {
      name: "agentscope-cli",
      version: "0.1.0",
      bin: { agentscope: "./dist/bin/agentscope.js" },
      publishConfig: { access: "public" },
      bundledDependencies: ["@agentscope/core"],
    },
  });
  assert.throws(verify(bundled), /bundled private dependency/);

  const nested = createCandidateFixture({
    extraEntries: [
      {
        path: "package/node_modules/@agentscope/core/package.json",
        content: '{"name":"@agentscope/core","version":"0.1.0"}\n',
      },
    ],
  });
  assert.throws(verify(nested), /Private package payload path/);

  const bundledCode = createCandidateFixture({
    extraEntries: [
      {
        path: "package/dist/bin/agentscope.js",
        content: 'const bundledSourceName = "@agentscope/core";\n',
      },
    ],
  });
  assert.equal(verify(bundledCode)().inventoryEntries, 2);
});

test("rejects duplicate and noncanonical tar inventory paths", () => {
  const duplicate = createCandidateFixture({
    extraEntries: [
      {
        path: "package/package.json",
        content: '{"name":"agentscope-cli"}\n',
      },
    ],
  });
  assert.throws(verify(duplicate), /Duplicate tar path/);

  const backslash = createCandidateFixture({
    extraEntries: [
      {
        path: "package\\node_modules\\private.js",
        content: "export {};\n",
      },
    ],
  });
  assert.throws(verify(backslash), /noncanonical tar path/);

  const casefoldCollision = createCandidateFixture({
    extraEntries: [
      { path: "package/README", content: "first\n" },
      { path: "package/readme", content: "second\n" },
    ],
  });
  assert.throws(verify(casefoldCollision), /Platform-ambiguous tar path/);

  for (const extraEntries of [
    [
      { path: "package/σ", content: "first\n" },
      { path: "package/ς", content: "second\n" },
    ],
    [
      { path: "package/readme", content: "first\n" },
      { path: "package/readme.", content: "second\n" },
    ],
    [{ path: "package/NUL", content: "reserved\n" }],
    [{ path: "package/con.txt", content: "reserved\n" }],
    [{ path: "package/file:name", content: "invalid\n" }],
  ])
    assert.throws(
      verify(createCandidateFixture({ extraEntries })),
      /path is not portable/,
    );

  const outsidePackage = createCandidateFixture({
    extraEntries: [{ path: "other/readme", content: "collision\n" }],
  });
  assert.throws(verify(outsidePackage), /outside package/);
});

test("authenticates exact checkout, caller workflow, and reusable workflow identity", () => {
  const context = {
    repository: "Melbourneandrew/agentscope",
    sourceRevision,
    observedHead: sourceRevision,
    callerWorkflowRef:
      "Melbourneandrew/agentscope/.github/workflows/release.yml@refs/heads/main",
    jobWorkflowRef:
      "Melbourneandrew/agentscope/.github/workflows/release-candidate-rehearsal.yml@refs/heads/main",
    jobWorkflowSha: sourceRevision,
    expectedManifestDigest: candidateManifestDigest,
    expectedProtectedTag: "v0.1.0",
  };
  assert.equal(
    validateReleaseWorkflowContext(context).sourceRevision,
    sourceRevision,
  );
  for (const changed of [
    { observedHead: "b".repeat(40) },
    { jobWorkflowSha: "b".repeat(40) },
    {
      callerWorkflowRef:
        "Melbourneandrew/agentscope/.github/workflows/untrusted.yml@refs/heads/main",
    },
    {
      jobWorkflowRef:
        "Melbourneandrew/agentscope/.github/workflows/release-candidate-rehearsal.yml@refs/heads/untrusted",
    },
    { expectedManifestDigest: `sha256:${"f".repeat(63)}` },
  ]) {
    assert.throws(() =>
      validateReleaseWorkflowContext({ ...context, ...changed }),
    );
  }
});

function probe() {
  const inventory = [
    {
      path: "package/package.json",
      bytes: 254,
      sha256: `sha256:${"1".repeat(64)}`,
    },
  ];
  return {
    schemaVersion: 1,
    authority: syntheticReleaseAuthority,
    kind: "oidc-probe",
    repository: "Melbourneandrew/agentscope",
    workflowPath: ".github/workflows/release.yml",
    environment: "npm-release",
    sourceRevision,
    trustedPublisher: {
      repository: "Melbourneandrew/agentscope",
      workflowPath: ".github/workflows/release.yml",
      environment: "npm-release",
      action: "stage-publish",
    },
    version: "0.0.0-oidc-probe.synthetic",
    distTag: "oidc-probe",
    artifact: {
      tarballSha256: `sha256:${"e".repeat(64)}`,
      integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`,
      inventory,
      inventoryDigest: sha256(canonicalJson(inventory)),
      manifest: {
        name: "agentscope-cli",
        version: "0.0.0-oidc-probe.synthetic",
        binAbsent: true,
        scriptsAbsent: true,
        dependenciesAbsent: true,
        productFilesAbsent: true,
      },
    },
    stage: {
      id: "synthetic-probe-stage-100",
      recorderOutputDigest: `sha256:${"2".repeat(64)}`,
    },
    ownerDownload: {
      stageId: "synthetic-probe-stage-100",
      tarballSha256: `sha256:${"e".repeat(64)}`,
      integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`,
      inventoryDigest: sha256(canonicalJson(inventory)),
      verificationDigest: `sha256:${"3".repeat(64)}`,
    },
    rejection: {
      stageId: "synthetic-probe-stage-100",
      ownerIdentity: "synthetic-owner",
      rejectionDigest: `sha256:${"4".repeat(64)}`,
    },
    terminalNpmState: "rejected",
    workflowDigest,
    releaseScripts,
  };
}

const bootstrapTags = Object.freeze({
  bootstrap: "0.0.0-bootstrap.0",
  latest: "0.0.0-bootstrap.0",
});
const publishedAlphaTags = Object.freeze({
  alpha: "0.1.0",
  ...bootstrapTags,
});
const exactRegistry = () => ({
  package: "agentscope-cli",
  version: "0.1.0",
  releaseClass: "alpha",
  distTags: publishedAlphaTags,
  distTagsDigest: sha256(canonicalJson(publishedAlphaTags)),
  integrity,
  tarballSha256: candidateTarballSha256,
  provenanceDigest: `sha256:${"5".repeat(64)}`,
  bin: { name: "agentscope", path: "./dist/bin/agentscope.js" },
  downloadedTarballSha256: candidateTarballSha256,
  downloadVerificationDigest: `sha256:${"6".repeat(64)}`,
  installedSmoke: {
    version: `sha256:${"7".repeat(64)}`,
    help: `sha256:${"8".repeat(64)}`,
    init: `sha256:${"9".repeat(64)}`,
    doctor: `sha256:${"a".repeat(64)}`,
  },
});
const githubRelease = (draft, immutable) => ({
  databaseId: "synthetic-release-100",
  tag: "v0.1.0",
  draft,
  prerelease: true,
  immutable,
  assetManifestDigest: `sha256:${"f".repeat(64)}`,
});
const stageReconciliation = (classification = "rejected") => ({
  classification,
  transactionId: "synthetic-transaction-100",
  draftReleaseDatabaseId: "synthetic-release-100",
  candidateManifestDigest,
  ownerIdentity: "synthetic-owner",
  stageId: classification === "absent" ? null : "synthetic-stage-100",
  downloadedStageTarballSha256:
    classification === "absent" ? null : candidateTarballSha256,
  issuedAt: "2026-08-27T17:20:00.000Z",
  expiresAt: "2026-08-27T17:30:00.000Z",
  consumedAt: "2026-08-27T17:25:00.000Z",
  state: "consumed-for-reconciliation",
  terminal: true,
  evidenceDigest: `sha256:${"6".repeat(64)}`,
});
const frozenStageReconciliation = () => ({
  ...stageReconciliation("absent"),
  classification: "frozen-unresolved",
  consumedAt: null,
  state: "frozen-unresolved",
  terminal: false,
});
const npmQuarantine = () => ({
  ownerCeremonyDigest: `sha256:${"b".repeat(64)}`,
  deprecationResultDigest: `sha256:${"c".repeat(64)}`,
  versionDeprecated: true,
  alpha: {
    state: "absent",
    version: null,
    authorizationDigest: null,
  },
  distTags: bootstrapTags,
  distTagsDigest: sha256(canonicalJson(bootstrapTags)),
  pendingStagesAbsent: true,
});

const quarantinePayload = (failureClass = "ambiguous-stage-response") => ({
  failureClass,
  ownerCheckpointDigest: `sha256:${"9".repeat(64)}`,
  pendingStagesCheckpointDigest: `sha256:${"6".repeat(64)}`,
  stageReconciliation: failureClass.startsWith("postpublication-")
    ? stageReconciliation("approved-consumed")
    : ["missing-stage-response", "ambiguous-stage-response"].includes(
          failureClass,
        )
      ? frozenStageReconciliation()
      : stageReconciliation(),
  recoveryPlanDigest: `sha256:${"a".repeat(64)}`,
  githubRelease: githubRelease(true, false),
  ...(failureClass.startsWith("postpublication-")
    ? {
        ...(failureClass === "postpublication-registry-ambiguous"
          ? { registryObservationDigest: `sha256:${"4".repeat(64)}` }
          : { registry: exactRegistry() }),
        npmQuarantine: npmQuarantine(),
      }
    : {}),
});

function payload(transition) {
  if (transition === "draft-prepared")
    return {
      release: {
        databaseId: "synthetic-release-100",
        draft: true,
        tag: "v0.1.0",
        prerelease: true,
      },
      assets: {
        tarballSha256: candidateTarballSha256,
        releaseAssetManifestDigest: `sha256:${"f".repeat(64)}`,
        checksumManifestDigest: `sha256:${"1".repeat(64)}`,
        sbomDigest: `sha256:${"2".repeat(64)}`,
        attestationDigest: `sha256:${"3".repeat(64)}`,
        evidenceIndexDigest: `sha256:${"3".repeat(64)}`,
      },
    };
  if (transition === "stage-recorded")
    return {
      stage: {
        id: "synthetic-stage-100",
        package: "agentscope-cli",
        version: "0.1.0",
        distTag: "alpha",
        candidateManifestDigest,
        tarballSha256: candidateTarballSha256,
      },
      ownerCheckpoint: {
        transactionId: "synthetic-transaction-100",
        draftReleaseDatabaseId: "synthetic-release-100",
        ownerIdentity: "synthetic-owner",
        pendingStagesState: "none-conflicting",
        issuedAt: "2026-08-27T16:40:00.000Z",
        expiresAt: "2026-08-27T16:50:00.000Z",
        consumedAt: "2026-08-27T16:45:00.000Z",
        state: "consumed-for-stage",
        authenticationDigest: `sha256:${"4".repeat(64)}`,
      },
      stageResultDigest: `sha256:${"5".repeat(64)}`,
    };
  if (transition === "ready-to-publish") {
    const publicationCheckpoint = {
      stageId: "synthetic-stage-100",
      transactionId: "synthetic-transaction-100",
      draftReleaseDatabaseId: "synthetic-release-100",
      candidateManifestDigest,
      transactionRecordDigest: null,
      ownerIdentity: "synthetic-owner",
      distTags: bootstrapTags,
      distTagsDigest: sha256(canonicalJson(bootstrapTags)),
      issuedAt: "2026-08-27T17:00:00.000Z",
      expiresAt: "2026-08-27T17:10:00.000Z",
      state: "valid-unconsumed",
      authenticationDigest: `sha256:${"7".repeat(64)}`,
    };
    return {
      stageId: "synthetic-stage-100",
      draftReleaseDatabaseId: "synthetic-release-100",
      pendingStagesCheckpointDigest: `sha256:${"6".repeat(64)}`,
      publicationCheckpoint,
      approvalConsumption: {
        checkpointDigest: sha256(canonicalJson(publicationCheckpoint)),
        stageId: "synthetic-stage-100",
        transactionId: "synthetic-transaction-100",
        transactionRecordDigest: null,
        observedDistTagsDigest: publicationCheckpoint.distTagsDigest,
        reauthenticationDigest: `sha256:${"8".repeat(64)}`,
        consumedAt: "2026-08-27T17:05:00.000Z",
        state: "consumed-for-approved-stage",
      },
      releaseLedgerPath: "release-records/releases/",
      incidentLedgerPath: "release-records/incidents/",
    };
  }
  if (transition === "completion-public-registry-verified")
    return {
      classification: "verified-success",
      registry: exactRegistry(),
      githubRelease: githubRelease(false, true),
      readyManifestDigest: null,
    };
  if (transition === "completion-already-immutable")
    return {
      classification: "exact-already-published",
      registry: exactRegistry(),
      githubRelease: githubRelease(false, true),
      readyManifestDigest: null,
      reconciliationDigest: `sha256:${"8".repeat(64)}`,
    };
  if (transition === "quarantine-still-draft") return quarantinePayload();
  if (transition === "quarantine-immutable-prerelease")
    return {
      failureClass: "ambiguous-stage-response",
      recoveryPlanDigest: `sha256:${"a".repeat(64)}`,
      quarantineEvidenceDigest: sha256(canonicalJson(quarantinePayload())),
      stageReconciliation: stageReconciliation(),
      finalManifestDigest: `sha256:${"d".repeat(64)}`,
      githubRelease: githubRelease(false, true),
    };
  return {
    failureClass: "candidate-digest-mismatch",
    registry: {
      ...exactRegistry(),
      tarballSha256: `sha256:${"0".repeat(64)}`,
      downloadedTarballSha256: `sha256:${"0".repeat(64)}`,
    },
    githubRelease: githubRelease(false, true),
    recoveryPlanDigest: `sha256:${"b".repeat(64)}`,
    incidentManifestDigest: `sha256:${"c".repeat(64)}`,
    readyManifestDigest: null,
    stageReconciliation: stageReconciliation("approved-consumed"),
    npmQuarantine: npmQuarantine(),
  };
}

function recordSet(
  terminalTransition = "completion-public-registry-verified",
  prefix = ["draft-prepared", "stage-recorded", "ready-to-publish"],
) {
  const probeRecord = probe();
  let previousDigest = `sha256:${"0".repeat(64)}`;
  const transactions = [...prefix, terminalTransition].map(
    (transition, index) => {
      const transitionPayload = payload(transition);
      if (transition === "ready-to-publish") {
        transitionPayload.publicationCheckpoint.transactionRecordDigest =
          previousDigest;
        transitionPayload.approvalConsumption.transactionRecordDigest =
          previousDigest;
        transitionPayload.approvalConsumption.checkpointDigest = sha256(
          canonicalJson(transitionPayload.publicationCheckpoint),
        );
      }
      if (
        transition === "quarantine-immutable-prerelease" &&
        !prefix.includes("stage-recorded")
      )
        transitionPayload.stageReconciliation = stageReconciliation("absent");
      if (
        [
          "completion-public-registry-verified",
          "completion-already-immutable",
          "incident-immutable-release",
        ].includes(transition)
      )
        transitionPayload.readyManifestDigest = previousDigest;
      const record = createSyntheticRecord({
        schemaVersion: 1,
        authority: syntheticReleaseAuthority,
        sequence: index + 1,
        previousDigest,
        transition,
        candidateManifestDigest,
        sourceRevision,
        protectedTag: "v0.1.0",
        transactionId: "synthetic-transaction-100",
        actor: "synthetic-release-recorder",
        simulation: true,
        payload: transitionPayload,
      });
      previousDigest = record.digest;
      return record;
    },
  );
  return {
    schemaVersion: 1,
    mode: "synthetic-nonpublishing-rehearsal",
    transactionId: "synthetic-transaction-100",
    activeTransactionFence: {
      transactionId: "synthetic-transaction-100",
      concurrencyGroup: "agentscope-release-records",
      ledgerPath: "release-records/releases/",
      expectedLatestSequence: 0,
      expectedLatestDigest: `sha256:${"0".repeat(64)}`,
      observedLatestSequence: 0,
      observedLatestDigest: `sha256:${"0".repeat(64)}`,
      state: "exclusive-active",
      competingTransaction: null,
      evidenceDigest: `sha256:${"f".repeat(64)}`,
    },
    package: {
      name: "agentscope-cli",
      version: "0.1.0",
      releaseClass: "alpha",
      distTag: "alpha",
    },
    candidateManifestDigest,
    candidateTarballSha256,
    integrity,
    applicableProbeDigest: sha256(canonicalJson(probeRecord)),
    workflowDigest,
    releaseScripts,
    sourceRevision,
    protectedTag: "v0.1.0",
    probe: probeRecord,
    transactions,
  };
}

const validateRecords = (records, observed = observedReleaseBytes) =>
  validateSyntheticReleaseRecords(records, observed, trustedCandidate);
const rebindProbe = (records) => {
  records.applicableProbeDigest = sha256(canonicalJson(records.probe));
  return records;
};
const replaceQuarantine = (records, draftPayload) => {
  const draftIndex = records.transactions.findIndex(
    ({ transition }) => transition === "quarantine-still-draft",
  );
  const finalIndex = draftIndex + 1;
  const recordedStage = records.transactions
    .slice(0, draftIndex)
    .some(({ transition }) => transition === "stage-recorded");
  const terminalStageReconciliation = draftPayload.failureClass.startsWith(
    "postpublication-",
  )
    ? stageReconciliation("approved-consumed")
    : stageReconciliation(recordedStage ? "rejected" : "absent");
  records.transactions[draftIndex] = createSyntheticRecord({
    ...records.transactions[draftIndex],
    payload: draftPayload,
  });
  records.transactions[finalIndex] = createSyntheticRecord({
    ...records.transactions[finalIndex],
    previousDigest: records.transactions[draftIndex].digest,
    payload: {
      ...records.transactions[finalIndex].payload,
      failureClass: draftPayload.failureClass,
      recoveryPlanDigest: draftPayload.recoveryPlanDigest,
      quarantineEvidenceDigest: sha256(canonicalJson(draftPayload)),
      stageReconciliation: terminalStageReconciliation,
    },
  });
  return records;
};
const replaceReady = (records, readyPayload) => {
  const readyIndex = records.transactions.findIndex(
    ({ transition }) => transition === "ready-to-publish",
  );
  const terminalIndex = readyIndex + 1;
  records.transactions[readyIndex] = createSyntheticRecord({
    ...records.transactions[readyIndex],
    payload: readyPayload,
  });
  records.transactions[terminalIndex] = createSyntheticRecord({
    ...records.transactions[terminalIndex],
    previousDigest: records.transactions[readyIndex].digest,
    payload: {
      ...records.transactions[terminalIndex].payload,
      readyManifestDigest: records.transactions[readyIndex].digest,
    },
  });
  return records;
};
const replaceStage = (records, stagePayload) => {
  const stageIndex = records.transactions.findIndex(
    ({ transition }) => transition === "stage-recorded",
  );
  const readyIndex = stageIndex + 1;
  const terminalIndex = readyIndex + 1;
  records.transactions[stageIndex] = createSyntheticRecord({
    ...records.transactions[stageIndex],
    payload: stagePayload,
  });
  records.transactions[readyIndex] = createSyntheticRecord({
    ...records.transactions[readyIndex],
    previousDigest: records.transactions[stageIndex].digest,
  });
  records.transactions[terminalIndex] = createSyntheticRecord({
    ...records.transactions[terminalIndex],
    previousDigest: records.transactions[readyIndex].digest,
    payload: {
      ...records.transactions[terminalIndex].payload,
      readyManifestDigest: records.transactions[readyIndex].digest,
    },
  });
  return records;
};

test("validates exact success, already-published, immutable quarantine, and incident evidence", () => {
  for (const terminalTransition of [
    "completion-public-registry-verified",
    "completion-already-immutable",
    "incident-immutable-release",
  ]) {
    assert.deepEqual(validateRecords(recordSet(terminalTransition)), {
      records: 4,
      terminalTransition,
    });
  }
  const quarantined = recordSet("quarantine-immutable-prerelease", [
    "draft-prepared",
    "stage-recorded",
    "ready-to-publish",
    "quarantine-still-draft",
  ]);
  assert.deepEqual(validateRecords(quarantined), {
    records: 5,
    terminalTransition: "quarantine-immutable-prerelease",
  });
  for (const failureClass of [
    "missing-stage-response",
    "ambiguous-stage-response",
  ]) {
    const direct = recordSet("quarantine-immutable-prerelease", [
      "draft-prepared",
      "quarantine-still-draft",
    ]);
    replaceQuarantine(direct, quarantinePayload(failureClass));
    assert.equal(validateRecords(direct).records, 3);
  }
  const postpublication = recordSet("quarantine-immutable-prerelease", [
    "draft-prepared",
    "stage-recorded",
    "ready-to-publish",
    "quarantine-still-draft",
  ]);
  replaceQuarantine(
    postpublication,
    quarantinePayload("postpublication-exact-verification-failed"),
  );
  assert.equal(validateRecords(postpublication).records, 5);

  const mismatch = recordSet("quarantine-immutable-prerelease", [
    "draft-prepared",
    "stage-recorded",
    "ready-to-publish",
    "quarantine-still-draft",
  ]);
  const mismatchPayload = quarantinePayload(
    "postpublication-candidate-mismatch",
  );
  mismatchPayload.registry = {
    ...mismatchPayload.registry,
    tarballSha256: `sha256:${"0".repeat(64)}`,
    downloadedTarballSha256: `sha256:${"0".repeat(64)}`,
  };
  replaceQuarantine(mismatch, mismatchPayload);
  assert.equal(validateRecords(mismatch).records, 5);

  const ambiguous = recordSet("quarantine-immutable-prerelease", [
    "draft-prepared",
    "stage-recorded",
    "ready-to-publish",
    "quarantine-still-draft",
  ]);
  replaceQuarantine(
    ambiguous,
    quarantinePayload("postpublication-registry-ambiguous"),
  );
  assert.equal(validateRecords(ambiguous).records, 5);
});

test("rejects incomplete, reordered, digest-broken, continued, or authority-bearing records", () => {
  const incomplete = recordSet();
  incomplete.transactions = incomplete.transactions.slice(0, 2);
  assert.throws(() => validateRecords(incomplete), /lacks a terminal/);

  const reordered = recordSet();
  [reordered.transactions[1], reordered.transactions[2]] = [
    reordered.transactions[2],
    reordered.transactions[1],
  ];
  assert.throws(
    () => validateRecords(reordered),
    /identity drifted|digest mismatch/,
  );

  const broken = recordSet();
  broken.transactions[2] = {
    ...broken.transactions[2],
    previousDigest: `sha256:${"f".repeat(64)}`,
  };
  assert.throws(() => validateRecords(broken), /identity drifted/);

  const continued = recordSet();
  const last = continued.transactions.at(-1);
  continued.transactions.push(
    createSyntheticRecord({
      ...last,
      sequence: 5,
      previousDigest: last.digest,
      transition: "stage-recorded",
      payload: payload("stage-recorded"),
    }),
  );
  assert.throws(
    () => validateRecords(continued),
    /Invalid transaction transition|continued/,
  );

  const authority = recordSet();
  authority.probe = { ...authority.probe, authority: "production" };
  assert.throws(() => validateRecords(authority), /probe record drifted/);

  const mixedActor = recordSet();
  mixedActor.transactions[0] = createSyntheticRecord({
    ...mixedActor.transactions[0],
    actor: "synthetic-other-actor",
  });
  assert.throws(() => validateRecords(mixedActor), /identity drifted/);

  const detachedFence = recordSet();
  detachedFence.activeTransactionFence = {
    ...detachedFence.activeTransactionFence,
    transactionId: "synthetic-transaction-other",
  };
  assert.throws(() => validateRecords(detachedFence), /fence is detached/);

  const staleLedgerHead = recordSet();
  staleLedgerHead.activeTransactionFence.expectedLatestSequence = 4;
  staleLedgerHead.activeTransactionFence.observedLatestSequence = 4;
  staleLedgerHead.activeTransactionFence.expectedLatestDigest = `sha256:${"e".repeat(64)}`;
  staleLedgerHead.activeTransactionFence.observedLatestDigest =
    staleLedgerHead.activeTransactionFence.expectedLatestDigest;
  assert.throws(
    () => validateRecords(staleLedgerHead),
    /compare-and-swap the observed ledger head/,
  );
});

test("binds probe and record-set digests to actual workflow and finite script bytes", () => {
  const pending = recordSet();
  pending.probe = { ...pending.probe, terminalNpmState: "pending" };
  assert.throws(() => validateRecords(pending), /probe record drifted/);

  const changedWorkflow = {
    ...observedReleaseBytes,
    workflowBytes: Buffer.from("workflow-v2\n"),
  };
  assert.throws(
    () => validateRecords(recordSet(), changedWorkflow),
    /workflow digest does not bind/,
  );

  const changedScript = {
    ...observedReleaseBytes,
    releaseScripts: {
      ...observedReleaseBytes.releaseScripts,
      "scripts/release-lane/records.mjs": Buffer.from("records-v2\n"),
    },
  };
  assert.throws(
    () => validateRecords(recordSet(), changedScript),
    /Release script digest mismatch/,
  );

  for (const path of [
    "scripts/release-lane/validation.mjs",
    "scripts/release-lane/workflow-context.mjs",
  ]) {
    const changedClosure = {
      ...observedReleaseBytes,
      releaseScripts: {
        ...observedReleaseBytes.releaseScripts,
        [path]: Buffer.from("changed-authority-byte\n"),
      },
    };
    assert.throws(
      () => validateRecords(recordSet(), changedClosure),
      /Release script digest mismatch/,
    );
  }

  const copiedStale = recordSet();
  copiedStale.workflowDigest = `sha256:${"f".repeat(64)}`;
  copiedStale.probe = {
    ...copiedStale.probe,
    workflowDigest: copiedStale.workflowDigest,
  };
  assert.throws(
    () => validateRecords(copiedStale),
    /workflow digest does not bind/,
  );
});

test("keeps the inert probe artifact and stage lifecycle distinct from the product candidate", () => {
  const reusedProduct = recordSet();
  reusedProduct.probe = {
    ...reusedProduct.probe,
    artifact: {
      ...reusedProduct.probe.artifact,
      tarballSha256: candidateTarballSha256,
      integrity,
    },
  };
  assert.throws(
    () => validateRecords(rebindProbe(reusedProduct)),
    /own inert artifact identity/,
  );

  const mixedDownload = recordSet();
  mixedDownload.probe = {
    ...mixedDownload.probe,
    ownerDownload: {
      ...mixedDownload.probe.ownerDownload,
      stageId: "synthetic-probe-stage-other",
    },
  };
  assert.throws(
    () => validateRecords(rebindProbe(mixedDownload)),
    /download mixes stage or artifact/,
  );

  const mixedRejection = recordSet();
  mixedRejection.probe = {
    ...mixedRejection.probe,
    rejection: {
      ...mixedRejection.probe.rejection,
      stageId: "synthetic-probe-stage-other",
    },
  };
  assert.throws(
    () => validateRecords(rebindProbe(mixedRejection)),
    /rejection mixes stage or owner/,
  );

  const staleSource = recordSet();
  staleSource.probe = {
    ...staleSource.probe,
    sourceRevision: "b".repeat(40),
  };
  assert.throws(
    () => validateRecords(rebindProbe(staleSource)),
    /probe record drifted/,
  );

  const candidateB = recordSet();
  candidateB.candidateTarballSha256 = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => validateRecords(candidateB),
    /trusted candidate authority/,
  );
});

test("rejects vacuous or mixed completion, quarantine, and incident evidence", () => {
  const vacuous = recordSet();
  vacuous.transactions[3] = createSyntheticRecord({
    ...vacuous.transactions[3],
    payload: {},
  });
  assert.throws(() => validateRecords(vacuous), /payload keys drifted/);

  const missingProvenance = recordSet();
  const registryWithoutProvenance = {
    ...missingProvenance.transactions[3].payload.registry,
  };
  delete registryWithoutProvenance.provenanceDigest;
  missingProvenance.transactions[3] = createSyntheticRecord({
    ...missingProvenance.transactions[3],
    payload: {
      ...missingProvenance.transactions[3].payload,
      registry: registryWithoutProvenance,
    },
  });
  assert.throws(
    () => validateRecords(missingProvenance),
    /registry evidence keys drifted/,
  );

  const mixedBin = recordSet();
  mixedBin.transactions[3] = createSyntheticRecord({
    ...mixedBin.transactions[3],
    payload: {
      ...mixedBin.transactions[3].payload,
      registry: {
        ...mixedBin.transactions[3].payload.registry,
        bin: { name: "agentscope", path: "./wrong.js" },
      },
    },
  });
  assert.throws(() => validateRecords(mixedBin), /bin identity drifted/);

  const missingAttestation = recordSet();
  const assetsWithoutAttestation = {
    ...missingAttestation.transactions[0].payload.assets,
  };
  delete assetsWithoutAttestation.attestationDigest;
  missingAttestation.transactions[0] = createSyntheticRecord({
    ...missingAttestation.transactions[0],
    payload: {
      ...missingAttestation.transactions[0].payload,
      assets: assetsWithoutAttestation,
    },
  });
  assert.throws(
    () => validateRecords(missingAttestation),
    /draft assets keys drifted/,
  );

  const mixed = recordSet();
  mixed.transactions[3] = createSyntheticRecord({
    ...mixed.transactions[3],
    payload: {
      ...mixed.transactions[3].payload,
      registry: {
        ...mixed.transactions[3].payload.registry,
        integrity: `sha512-${Buffer.alloc(64, 9).toString("base64")}`,
      },
    },
  });
  assert.throws(() => validateRecords(mixed), /candidate digest mismatch/);

  const mixedStage = recordSet();
  mixedStage.transactions[2] = createSyntheticRecord({
    ...mixedStage.transactions[2],
    payload: {
      ...mixedStage.transactions[2].payload,
      stageId: "synthetic-stage-other",
    },
  });
  assert.throws(() => validateRecords(mixedStage), /mixes stage or release/);

  const wrongDraftState = recordSet("quarantine-immutable-prerelease", [
    "draft-prepared",
    "stage-recorded",
    "ready-to-publish",
    "quarantine-still-draft",
  ]);
  wrongDraftState.transactions[3] = createSyntheticRecord({
    ...wrongDraftState.transactions[3],
    payload: {
      ...wrongDraftState.transactions[3].payload,
      githubRelease: githubRelease(false, true),
    },
  });
  assert.throws(() => validateRecords(wrongDraftState), /state drifted/);
});

test("binds a fresh one-use publication checkpoint and preserves every non-alpha tag", () => {
  assert.equal(
    validateRecords(recordSet()).terminalTransition,
    "completion-public-registry-verified",
  );

  for (const changedTags of [
    { ...publishedAlphaTags, latest: "0.1.0" },
    { alpha: "0.1.0", latest: "0.0.0-bootstrap.0" },
    { ...publishedAlphaTags, unexpected: "9.9.9" },
  ]) {
    const drifted = recordSet();
    drifted.transactions[3] = createSyntheticRecord({
      ...drifted.transactions[3],
      payload: {
        ...drifted.transactions[3].payload,
        registry: {
          ...drifted.transactions[3].payload.registry,
          distTags: changedTags,
          distTagsDigest: sha256(canonicalJson(changedTags)),
        },
      },
    });
    assert.throws(
      () => validateRecords(drifted),
      /mutated a non-authorized dist-tag/,
    );
  }

  const stale = recordSet();
  const staleReady = structuredClone(stale.transactions[2].payload);
  staleReady.publicationCheckpoint.expiresAt = "2026-08-27T17:20:00.000Z";
  staleReady.approvalConsumption.checkpointDigest = sha256(
    canonicalJson(staleReady.publicationCheckpoint),
  );
  replaceReady(stale, staleReady);
  assert.throws(
    () => validateRecords(stale),
    /stale, detached, or not one-use/,
  );

  const consumed = recordSet();
  const consumedReady = structuredClone(consumed.transactions[2].payload);
  consumedReady.publicationCheckpoint.state = "consumed";
  consumedReady.approvalConsumption.checkpointDigest = sha256(
    canonicalJson(consumedReady.publicationCheckpoint),
  );
  replaceReady(consumed, consumedReady);
  assert.throws(
    () => validateRecords(consumed),
    /stale, detached, or not one-use/,
  );

  const detached = recordSet();
  const detachedReady = structuredClone(detached.transactions[2].payload);
  detachedReady.approvalConsumption.observedDistTagsDigest = `sha256:${"0".repeat(64)}`;
  replaceReady(detached, detachedReady);
  assert.throws(
    () => validateRecords(detached),
    /did not consume the exact fresh checkpoint/,
  );

  const postExpiry = recordSet();
  const postExpiryReady = structuredClone(postExpiry.transactions[2].payload);
  postExpiryReady.approvalConsumption.consumedAt = "2026-08-27T17:11:00.000Z";
  replaceReady(postExpiry, postExpiryReady);
  assert.throws(
    () => validateRecords(postExpiry),
    /consumed outside its authority window/,
  );

  const stalePreStage = recordSet();
  const staleStagePayload = structuredClone(
    stalePreStage.transactions[1].payload,
  );
  staleStagePayload.ownerCheckpoint.consumedAt = "2026-08-27T16:51:00.000Z";
  replaceStage(stalePreStage, staleStagePayload);
  assert.throws(
    () => validateRecords(stalePreStage),
    /consumed outside its authority window/,
  );

  const incomplete = recordSet();
  const incompleteReady = structuredClone(incomplete.transactions[2].payload);
  delete incompleteReady.publicationCheckpoint.distTags.bootstrap;
  incompleteReady.publicationCheckpoint.distTagsDigest = sha256(
    canonicalJson(incompleteReady.publicationCheckpoint.distTags),
  );
  incompleteReady.approvalConsumption.checkpointDigest = sha256(
    canonicalJson(incompleteReady.publicationCheckpoint),
  );
  incompleteReady.approvalConsumption.observedDistTagsDigest =
    incompleteReady.publicationCheckpoint.distTagsDigest;
  replaceReady(incomplete, incompleteReady);
  assert.throws(
    () => validateRecords(incomplete),
    /does not preserve the exact inert bootstrap channels/,
  );

  const alphaMovedLatestBeforeApproval = recordSet();
  const movedReady = structuredClone(
    alphaMovedLatestBeforeApproval.transactions[2].payload,
  );
  movedReady.publicationCheckpoint.distTags.latest = "0.1.0";
  movedReady.publicationCheckpoint.distTagsDigest = sha256(
    canonicalJson(movedReady.publicationCheckpoint.distTags),
  );
  movedReady.approvalConsumption.checkpointDigest = sha256(
    canonicalJson(movedReady.publicationCheckpoint),
  );
  movedReady.approvalConsumption.observedDistTagsDigest =
    movedReady.publicationCheckpoint.distTagsDigest;
  replaceReady(alphaMovedLatestBeforeApproval, movedReady);
  assert.throws(
    () => validateRecords(alphaMovedLatestBeforeApproval),
    /does not preserve the exact inert bootstrap channels/,
  );
});

test("rejects a publication checkpoint transplanted across transactions", () => {
  const transplanted = recordSet();
  const ready = structuredClone(transplanted.transactions[2].payload);
  ready.publicationCheckpoint.transactionId = "synthetic-transaction-other";
  ready.approvalConsumption.transactionId = "synthetic-transaction-other";
  ready.approvalConsumption.checkpointDigest = sha256(
    canonicalJson(ready.publicationCheckpoint),
  );
  replaceReady(transplanted, ready);
  assert.throws(
    () => validateRecords(transplanted),
    /stale, detached, or not one-use/,
  );
});

test("preserves unresolved staging until exact terminal reconciliation", () => {
  const unresolvedStage = recordSet("quarantine-immutable-prerelease", [
    "draft-prepared",
    "quarantine-still-draft",
  ]);
  const unresolvedPayload = quarantinePayload("ambiguous-stage-response");
  replaceQuarantine(unresolvedStage, unresolvedPayload);
  assert.equal(
    validateRecords(unresolvedStage).terminalTransition,
    "quarantine-immutable-prerelease",
  );

  const unresolvedTerminal = structuredClone(unresolvedStage);
  unresolvedTerminal.transactions[2] = createSyntheticRecord({
    ...unresolvedTerminal.transactions[2],
    payload: {
      ...unresolvedTerminal.transactions[2].payload,
      stageReconciliation: frozenStageReconciliation(),
    },
  });
  assert.throws(
    () => validateRecords(unresolvedTerminal),
    /unresolved or nonterminal/,
  );

  for (const reconciliation of [
    stageReconciliation("absent"),
    { ...stageReconciliation(), stageId: "synthetic-stage-unrelated" },
  ]) {
    const knownStage = recordSet("quarantine-immutable-prerelease", [
      "draft-prepared",
      "stage-recorded",
      "quarantine-still-draft",
    ]);
    const knownStagePayload = quarantinePayload("prepublication-drift");
    knownStagePayload.stageReconciliation = reconciliation;
    replaceQuarantine(knownStage, knownStagePayload);
    assert.throws(
      () => validateRecords(knownStage),
      /unresolved or nonterminal/,
    );
  }

  const incidentWithoutQuarantine = recordSet("incident-immutable-release");
  const incompleteIncident = {
    ...incidentWithoutQuarantine.transactions[3].payload,
  };
  delete incompleteIncident.npmQuarantine;
  incidentWithoutQuarantine.transactions[3] = createSyntheticRecord({
    ...incidentWithoutQuarantine.transactions[3],
    payload: incompleteIncident,
  });
  assert.throws(
    () => validateRecords(incidentWithoutQuarantine),
    /incident payload keys drifted/,
  );
});

test("rejects incomplete or misclassified quarantine and incident recovery", () => {
  const missingPostpublicationRegistry = recordSet(
    "quarantine-immutable-prerelease",
    [
      "draft-prepared",
      "stage-recorded",
      "ready-to-publish",
      "quarantine-still-draft",
    ],
  );
  const incompletePostpublication = quarantinePayload(
    "postpublication-exact-verification-failed",
  );
  delete incompletePostpublication.registry;
  replaceQuarantine(missingPostpublicationRegistry, incompletePostpublication);
  assert.throws(
    () => validateRecords(missingPostpublicationRegistry),
    /draft quarantine payload keys drifted/,
  );

  const wrongPostpublicationResult = recordSet(
    "quarantine-immutable-prerelease",
    [
      "draft-prepared",
      "stage-recorded",
      "ready-to-publish",
      "quarantine-still-draft",
    ],
  );
  const wrongQuarantine = quarantinePayload(
    "postpublication-exact-verification-failed",
  );
  wrongQuarantine.npmQuarantine = {
    ...wrongQuarantine.npmQuarantine,
    alpha: {
      state: "safe-mapping",
      version: "0.1.0",
      authorizationDigest: `sha256:${"e".repeat(64)}`,
    },
  };
  replaceQuarantine(wrongPostpublicationResult, wrongQuarantine);
  assert.throws(
    () => validateRecords(wrongPostpublicationResult),
    /alpha channel still selects/,
  );

  const mislabeledRegistryMismatch = recordSet(
    "quarantine-immutable-prerelease",
    [
      "draft-prepared",
      "stage-recorded",
      "ready-to-publish",
      "quarantine-still-draft",
    ],
  );
  const mislabeledPayload = quarantinePayload(
    "postpublication-exact-verification-failed",
  );
  mislabeledPayload.registry = {
    ...mislabeledPayload.registry,
    tarballSha256: `sha256:${"0".repeat(64)}`,
    downloadedTarballSha256: `sha256:${"0".repeat(64)}`,
  };
  replaceQuarantine(mislabeledRegistryMismatch, mislabeledPayload);
  assert.throws(
    () => validateRecords(mislabeledRegistryMismatch),
    /candidate digest mismatch/,
  );

  const mixedQuarantineEvidence = recordSet("quarantine-immutable-prerelease", [
    "draft-prepared",
    "stage-recorded",
    "ready-to-publish",
    "quarantine-still-draft",
  ]);
  mixedQuarantineEvidence.transactions[4] = createSyntheticRecord({
    ...mixedQuarantineEvidence.transactions[4],
    payload: {
      ...mixedQuarantineEvidence.transactions[4].payload,
      quarantineEvidenceDigest: `sha256:${"e".repeat(64)}`,
    },
  });
  assert.throws(
    () => validateRecords(mixedQuarantineEvidence),
    /does not continue the active recovery/,
  );

  const falseIncident = recordSet("incident-immutable-release");
  falseIncident.transactions[3] = createSyntheticRecord({
    ...falseIncident.transactions[3],
    payload: {
      ...falseIncident.transactions[3].payload,
      registry: exactRegistry(),
    },
  });
  assert.throws(() => validateRecords(falseIncident), /exact candidate/);

  const mixedControlDrift = recordSet("incident-immutable-release");
  mixedControlDrift.transactions[3] = createSyntheticRecord({
    ...mixedControlDrift.transactions[3],
    payload: {
      ...mixedControlDrift.transactions[3].payload,
      failureClass: "postpublication-control-drift",
    },
  });
  assert.throws(
    () => validateRecords(mixedControlDrift),
    /mixes a candidate digest mismatch/,
  );
});

test("binds npm quarantine outcome to the complete dist-tag mapping", () => {
  const records = recordSet("quarantine-immutable-prerelease", [
    "draft-prepared",
    "stage-recorded",
    "ready-to-publish",
    "quarantine-still-draft",
  ]);
  const draft = quarantinePayload("postpublication-exact-verification-failed");
  draft.npmQuarantine.distTags = publishedAlphaTags;
  draft.npmQuarantine.distTagsDigest = sha256(
    canonicalJson(publishedAlphaTags),
  );
  replaceQuarantine(records, draft);
  assert.throws(() => validateRecords(records), /alpha result does not match/);
});

test("derives all release authority bytes from the executable module closure", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-release-closure-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, "scripts/entry.mjs"),
    'export * from "./helper.mjs";\n',
  );
  writeFileSync(join(root, "scripts/helper.mjs"), "export const safe = 1;\n");
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "workflow.yml",
  ])
    writeFileSync(join(root, path), `${path}-v1\n`);
  const observed = collectReleaseAuthorityBytes(root, {
    entryPoints: ["scripts/entry.mjs"],
    authorityFiles: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "workflow.yml",
    ],
  });
  assert.deepEqual(Object.keys(observed), [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/entry.mjs",
    "scripts/helper.mjs",
    "workflow.yml",
  ]);
  const staleRecords = Object.entries(observed)
    .filter(([path]) => path !== "scripts/helper.mjs")
    .map(([path, bytes]) => ({ path, digest: sha256(bytes) }));
  const stale = recordSet();
  stale.releaseScripts = staleRecords;
  stale.probe = { ...stale.probe, releaseScripts: staleRecords };
  rebindProbe(stale);
  assert.throws(
    () =>
      validateRecords(stale, {
        workflowBytes: observedReleaseBytes.workflowBytes,
        releaseScripts: observed,
      }),
    /does not match observed bytes/,
  );

  const fullRecords = Object.entries(observed).map(([path, bytes]) => ({
    path,
    digest: sha256(bytes),
  }));
  const workspaceBound = recordSet();
  workspaceBound.releaseScripts = fullRecords;
  workspaceBound.probe = {
    ...workspaceBound.probe,
    releaseScripts: fullRecords,
  };
  rebindProbe(workspaceBound);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "changed-membership\n");
  const changedAuthority = collectReleaseAuthorityBytes(root, {
    entryPoints: ["scripts/entry.mjs"],
    authorityFiles: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "workflow.yml",
    ],
  });
  assert.throws(
    () =>
      validateRecords(workspaceBound, {
        workflowBytes: observedReleaseBytes.workflowBytes,
        releaseScripts: changedAuthority,
      }),
    /Release script digest mismatch: pnpm-workspace.yaml/,
  );
});

test("enforces the checked-in reusable workflow as read-only and offline", () => {
  assert.deepEqual(
    validateOfflineReleasePolicy({
      workspaceRoot,
      workflowPath: ".github/workflows/release-candidate-rehearsal.yml",
      scriptPaths: releaseEntryPoints,
    }),
    {
      scripts: 10,
      workflow: ".github/workflows/release-candidate-rehearsal.yml",
    },
  );
  const workflow = readFileSync(
    join(workspaceRoot, ".github/workflows/release-candidate-rehearsal.yml"),
    "utf8",
  );
  for (const binding of [
    '--candidate-manifest-relative "$CANDIDATE_MANIFEST"',
    '--trusted-candidate-manifest-digest "$EXPECTED_MANIFEST_DIGEST"',
    '--source-revision "$EXPECTED_SOURCE_REVISION"',
    "--protected-tag v0.1.0",
  ])
    assert.match(workflow, new RegExp(binding.replaceAll("$", "\\$"), "u"));
});

test("rejects workflow triggers, write authority, and unallowlisted actions", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-release-policy-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  const workflowPath = "workflow.yml";
  const scriptPath = "scripts/check.mjs";
  writeFileSync(
    join(root, workflowPath),
    checkedInWorkflow.replace(
      "    name: Validate existing certified tarball\n",
      '    name: Validate existing certified tarball\n    permissions: { "contents": "read", "id-token": "write" }\n    "environment": "npm-release"\n',
    ),
  );
  writeFileSync(join(root, scriptPath), "export const safe = true;\n");
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /keys drifted|forbidden authority/,
  );

  writeFileSync(
    join(root, workflowPath),
    checkedInWorkflow.replace(
      "  workflow_call:\n",
      "  workflow_call:\n  push:\n",
    ),
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /workflow triggers keys drifted/,
  );

  writeFileSync(
    join(root, workflowPath),
    checkedInWorkflow.replace(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      `attacker/action@${"a".repeat(40)}`,
    ),
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /topology drifted|not exact-SHA allowlisted/,
  );

  writeFileSync(
    join(root, workflowPath),
    checkedInWorkflow.replace(
      "- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      `- name: spaced action key\n        uses : attacker/action@${"a".repeat(40)}`,
    ),
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /topology drifted|not exact-SHA allowlisted/,
  );

  writeFileSync(
    join(root, workflowPath),
    checkedInWorkflow.replace(
      "- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      `- name: disguised external action\n        uses: attacker/action@${"a".repeat(40)}`,
    ),
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /topology drifted|not exact-SHA allowlisted/,
  );

  for (const run of [
    "node -e 'fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)'",
    'tool=npm; verb=stage; "$tool" "$verb"',
    "python -c 'import urllib.request'",
  ]) {
    writeFileSync(
      join(root, workflowPath),
      checkedInWorkflow.replace(
        "- run: pnpm install --frozen-lockfile",
        `- run: ${run}`,
      ),
    );
    assert.throws(
      () =>
        validateOfflineReleasePolicy({
          workspaceRoot: root,
          workflowPath,
          scriptPaths: [scriptPath],
        }),
      /run topology drifted|run command is not exact allowlisted/,
    );
  }
});

test("requires the exact ordered workflow topology and environment bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-release-topology-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  const workflowPath = "workflow.yml";
  const scriptPath = "scripts/check.mjs";
  writeFileSync(join(root, scriptPath), "export const safe = true;\n");
  const verify = (workflow) => {
    writeFileSync(join(root, workflowPath), stringify(workflow));
    assert.throws(
      () =>
        validateOfflineReleasePolicy({
          workspaceRoot: root,
          workflowPath,
          scriptPaths: [scriptPath],
        }),
      /topology|run environment/,
    );
  };

  const omitted = parse(checkedInWorkflow);
  omitted.jobs["validate-certified-candidate"].steps.pop();
  verify(omitted);

  const reordered = parse(checkedInWorkflow);
  const reorderedSteps = reordered.jobs["validate-certified-candidate"].steps;
  [reorderedSteps[0], reorderedSteps[1]] = [
    reorderedSteps[1],
    reorderedSteps[0],
  ];
  verify(reordered);

  const duplicated = parse(checkedInWorkflow);
  const duplicatedSteps = duplicated.jobs["validate-certified-candidate"].steps;
  duplicatedSteps.push(structuredClone(duplicatedSteps.at(-1)));
  verify(duplicated);

  const substituted = parse(checkedInWorkflow);
  const candidateStep = substituted.jobs[
    "validate-certified-candidate"
  ].steps.find(
    ({ name }) => name === "Validate exact candidate without rebuilding",
  );
  candidateStep.env.EXPECTED_MANIFEST_DIGEST = "sha256:attacker-selected";
  candidateStep.env.EXPECTED_SOURCE_REVISION = "attacker-selected";
  verify(substituted);
});

test("rejects direct and imported network/process authority", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-release-script-policy-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  const workflowPath = "workflow.yml";
  const scriptPath = "scripts/check.mjs";
  writeFileSync(join(root, workflowPath), checkedInWorkflow);
  writeFileSync(join(root, scriptPath), 'import "node:https";\n');
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(join(root, scriptPath), "await fetch(process.env.URL);\n");
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(
    join(root, scriptPath),
    "const request = globalThis.fetch;\nawait request(process.env.URL);\n",
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  for (const specifier of ["http2", "dns/promises"]) {
    writeFileSync(join(root, scriptPath), `await import("${specifier}");\n`);
    assert.throws(
      () =>
        validateOfflineReleasePolicy({
          workspaceRoot: root,
          workflowPath,
          scriptPaths: [scriptPath],
        }),
      /network\/process authority/,
    );
  }

  writeFileSync(join(root, scriptPath), 'import "./helper.mjs";\n');
  writeFileSync(join(root, "scripts/helper.mjs"), 'import "node:https";\n');
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(join(root, scriptPath), 'await import("./helper.mjs");\n');
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(join(root, scriptPath), "await import(`./helper.mjs`);\n");
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );
});

test("rejects indirect and dynamic module-loader authority", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-release-loader-policy-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  const workflowPath = "workflow.yml";
  const scriptPath = "scripts/check.mjs";
  writeFileSync(join(root, workflowPath), checkedInWorkflow);
  writeFileSync(join(root, "scripts/helper.mjs"), 'import "node:https";\n');
  writeFileSync(join(root, scriptPath), 'await import("https");\n');
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(
    join(root, scriptPath),
    'const load = process["getBuiltinModule"];\nload("https");\n',
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(
    join(root, scriptPath),
    'const load = process.getBuiltinModule;\nload("https");\n',
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(
    join(root, scriptPath),
    'await import /* bounded? */ ("./helper.mjs");\n',
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(
    join(root, scriptPath),
    'import { createRequire as cr } from "module";\nconst loader = cr(import.meta.url);\nloader("./helper.cjs");\n',
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(
    join(root, scriptPath),
    'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nrequire("./helper.cjs");\n',
  );
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /network\/process authority/,
  );

  writeFileSync(join(root, scriptPath), "await import(`./${name}.mjs`);\n");
  assert.throws(
    () =>
      validateOfflineReleasePolicy({
        workspaceRoot: root,
        workflowPath,
        scriptPaths: [scriptPath],
      }),
    /unbounded dynamic import/,
  );
});

test("rejects runtime code-generation recovery shapes", () => {
  const root = mkdtempSync(
    join(tmpdir(), "agentscope-release-codegen-policy-"),
  );
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  const workflowPath = "workflow.yml";
  const scriptPath = "scripts/check.mjs";
  writeFileSync(join(root, workflowPath), checkedInWorkflow);
  for (const source of [
    "await eval('import(\"node:https\")');\n",
    "Function('return import(\"node:https\")')();\n",
    'const request = Reflect.get(globalThis, "fetch");\nawait request("https://example.invalid");\n',
    "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;\nAsyncFunction('return import(\"node:https\")')();\n",
    'Object.getPrototypeOf(async () => {})["con" + "structor"](\'return import("node:https")\')();\n',
    'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(async () => {}), "constructor").value(\'return import("node:https")\')();\n',
    'const fn = async () => {};\nfn[["con", "structor"].join("")](\'return import("node:https")\')();\n',
    "const { constructor: AsyncCtor } = async () => {};\nAsyncCtor('return import(\"node:https\")')();\n",
    "const { constructor } = async () => {};\nconstructor('return import(\"node:https\")')();\n",
    "let AsyncCtor;\n({ constructor: AsyncCtor } = async () => {});\nAsyncCtor('return import(\"node:https\")')();\n",
    "let AsyncCtor;\nconst key = ['con', 'structor'].join('');\n({ [key]: AsyncCtor } = async () => {});\n",
  ]) {
    writeFileSync(join(root, scriptPath), source);
    assert.throws(
      () =>
        validateOfflineReleasePolicy({
          workspaceRoot: root,
          workflowPath,
          scriptPaths: [scriptPath],
        }),
      /runtime code-generation authority/,
    );
  }
});

test("rejects aliased process loaders and ambient event streams", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-release-alias-policy-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  const workflowPath = "workflow.yml";
  const scriptPath = "scripts/check.mjs";
  writeFileSync(join(root, workflowPath), checkedInWorkflow);
  for (const source of [
    'const { getBuiltinModule: load } = process;\nload("node:https");\n',
    'const p = process;\np["getBuiltin" + "Module"]("node:https");\n',
    'new EventSource("https" + "://example.invalid");\n',
  ]) {
    writeFileSync(join(root, scriptPath), source);
    assert.throws(
      () =>
        validateOfflineReleasePolicy({
          workspaceRoot: root,
          workflowPath,
          scriptPaths: [scriptPath],
        }),
      /(?:network\/process|runtime code-generation) authority/,
    );
  }
});
