import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  evaluateNativeCandidateDisposition,
  readAuthenticatedNativeProfile,
  validateNativeCandidateProfile,
} from "../native-ci-disposition.mjs";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const profile = Object.freeze({
  schemaVersion: 1,
  package: "agentscope-cli",
  version: "0.1.0",
  localSqliteExecutableTuple: "excluded",
});
const bin = "package/dist/bin/agentscope.js";
const loader = "package/dist/internal/local-sqlite/loader/owned-loader.cjs";
const manifest =
  "package/dist/internal/local-sqlite/records/support-manifest.json";
const binary =
  "package/dist/internal/local-sqlite/native/linux-x64/agentscope_sqlite.node";

function packed(paths) {
  return {
    bytes: 42,
    sha256: digest,
    integrity: `sha512-${"A".repeat(86)}==`,
    inventoryDigest: digest,
    packedManifest: { name: "agentscope-cli", version: "0.1.0" },
    inventory: paths.map((path) => ({ path, bytes: 1, sha256: digest })),
  };
}

function candidate(inspected) {
  return {
    schemaVersion: 1,
    candidateId: "agentscope.release-candidate.v1",
    package: {
      name: "agentscope-cli",
      version: "0.1.0",
      bin: { agentscope: "./dist/bin/agentscope.js" },
    },
    channel: { npmDistTag: "alpha", githubPrerelease: true },
    sourceRevision: revision,
    protectedTag: "v0.1.0",
    tarball: {
      fileName: "agentscope-cli-0.1.0.tgz",
      bytes: inspected.bytes,
      sha256: inspected.sha256,
      integrity: inspected.integrity,
      inventoryDigest: inspected.inventoryDigest,
    },
    certification: { state: "certified", recordDigest: digest },
  };
}

test("profile read binds exact opened regular bytes to the source blob", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentscope-native-profile-"));
  try {
    const path = join(directory, "profile.json");
    const bytes = Buffer.from(JSON.stringify(profile));
    writeFileSync(path, bytes);
    const blob = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
    assert.deepEqual(readAuthenticatedNativeProfile(path, blob), bytes);
    writeFileSync(
      path,
      JSON.stringify({
        ...profile,
        localSqliteExecutableTuple: "proposed-unpublished",
      }),
    );
    assert.throws(
      () => readAuthenticatedNativeProfile(path, blob),
      /native-ci-profile-source-mismatch/u,
    );
    const link = join(directory, "link.json");
    symlinkSync(path, link);
    assert.throws(() => readAuthenticatedNativeProfile(link, blob));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("excluded exact profile and absent fresh/candidate tuples report nonadmission", () => {
  const inspected = packed([bin]);
  assert.deepEqual(
    evaluateNativeCandidateDisposition({
      profile,
      packed: inspected,
      sourceRevision: revision,
      candidateManifest: candidate(inspected),
      candidateTarball: inspected,
    }),
    {
      required: false,
      reason: "Local SQLite not admitted",
      supportAdmission: "not-claimed",
    },
  );
});

test("proposed unpublished packed tuple requires full native verifier", () => {
  const inspected = packed([bin, loader, manifest, binary]);
  assert.equal(
    evaluateNativeCandidateDisposition({
      profile: {
        ...profile,
        localSqliteExecutableTuple: "proposed-unpublished",
      },
      packed: inspected,
      sourceRevision: revision,
    }).required,
    true,
  );
});

test("malformed profile, contradictory, substituted and incomplete inventories fail", () => {
  assert.throws(
    () => validateNativeCandidateProfile({ ...profile, extra: "unknown" }),
    /native-ci-profile-invalid/u,
  );
  assert.throws(
    () =>
      evaluateNativeCandidateDisposition({
        profile,
        packed: packed([bin, loader, manifest, binary]),
        sourceRevision: revision,
      }),
    /native-ci-profile-inventory-contradictory/u,
  );
  assert.throws(
    () =>
      evaluateNativeCandidateDisposition({
        profile,
        packed: packed([bin, loader]),
        sourceRevision: revision,
      }),
    /native-ci-packed-inventory-contradictory/u,
  );
  const inspected = packed([bin]);
  assert.throws(
    () =>
      evaluateNativeCandidateDisposition({
        profile,
        packed: inspected,
        sourceRevision: revision,
        candidateManifest: {
          ...candidate(inspected),
          sourceRevision: "c".repeat(40),
        },
        candidateTarball: inspected,
      }),
    /native-ci-candidate-identity-mismatch/u,
  );
  assert.throws(
    () =>
      evaluateNativeCandidateDisposition({
        profile,
        packed: inspected,
        sourceRevision: revision,
        candidateManifest: candidate(inspected),
        candidateTarball: {
          ...inspected,
          inventoryDigest: `sha256:${"c".repeat(64)}`,
        },
      }),
    /native-ci-candidate-identity-mismatch/u,
  );
  assert.throws(
    () =>
      evaluateNativeCandidateDisposition({
        profile,
        packed: inspected,
        sourceRevision: revision,
        candidateManifest: candidate({
          ...inspected,
          inventoryDigest: `sha256:${"c".repeat(64)}`,
        }),
        candidateTarball: {
          ...inspected,
          inventoryDigest: `sha256:${"c".repeat(64)}`,
        },
      }),
    /native-ci-candidate-inventory-contradictory/u,
  );
  assert.throws(
    () =>
      evaluateNativeCandidateDisposition({
        profile: {
          ...profile,
          localSqliteExecutableTuple: "proposed-unpublished",
        },
        packed: inspected,
        sourceRevision: revision,
      }),
    /native-ci-profile-inventory-contradictory/u,
  );
});
