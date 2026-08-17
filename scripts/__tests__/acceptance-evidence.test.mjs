import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import { validateAcceptanceEvidence } from "../acceptance-evidence.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-evidence-"));
  fixtures.push(root);
  const requirementsDirectory = join(root, "requirements");
  mkdirSync(requirementsDirectory);
  writeFileSync(
    join(requirementsDirectory, "feature.mdx"),
    "- **AC-TST-001.1:** When tested, the system shall behave.\n",
  );
  writeFileSync(join(root, "proof.test.ts"), "// AC-TST-001.1\n");
  writeFileSync(join(root, "uncited.test.ts"), "// no criterion here\n");
  return { requirementsDirectory, root };
}

function validManifest() {
  return {
    schemaVersion: 1,
    ownership: [
      {
        owners: ["agentscope-vah.2.5"],
        prefix: "TST",
      },
    ],
    evidence: [
      {
        criteria: ["AC-TST-001.1"],
        id: "test:proof",
        kind: "automated-test",
        path: "proof.test.ts",
      },
    ],
  };
}

function validate(manifest) {
  const fixture = createFixture();
  return () =>
    validateAcceptanceEvidence({
      manifest,
      requirementsDirectory: fixture.requirementsDirectory,
      workspaceRoot: fixture.root,
    });
}

test("accepts a complete dynamically discovered evidence record", () => {
  assert.deepEqual(validate(validManifest())(), {
    mandatory: 1,
    planned: 0,
    verified: 1,
  });
});

test("rejects missing and unknown criterion ownership", () => {
  const missing = validManifest();
  missing.ownership = [];
  assert.throws(validate(missing), /Missing mandatory criterion ownership/);

  const unknown = validManifest();
  unknown.ownership.push({
    owners: ["agentscope-vah.2.5"],
    prefix: "NOPE",
  });
  assert.throws(validate(unknown), /Unknown ownership prefixes/);
});

test("rejects duplicate ownership and evidence IDs", () => {
  const duplicateCriterion = validManifest();
  duplicateCriterion.ownership.push(duplicateCriterion.ownership[0]);
  assert.throws(validate(duplicateCriterion), /Duplicate ownership prefixes/);

  const duplicateEvidence = validManifest();
  duplicateEvidence.evidence.push(duplicateEvidence.evidence[0]);
  assert.throws(validate(duplicateEvidence), /Duplicate evidence IDs/);
});

test("rejects orphaned, missing, and uncited evidence", () => {
  const orphaned = validManifest();
  orphaned.evidence[0].criteria = [];
  assert.throws(validate(orphaned), /Orphaned evidence/);

  const missingFile = validManifest();
  missingFile.evidence[0].path = "absent.test.ts";
  assert.throws(validate(missingFile), /path does not exist/);

  const uncited = validManifest();
  uncited.evidence[0].path = "uncited.test.ts";
  assert.throws(validate(uncited), /path does not cite/);
});

test("requires every planned criterion when release verification is enabled", () => {
  const fixture = createFixture();
  const manifest = validManifest();
  manifest.evidence = [];

  assert.throws(
    () =>
      validateAcceptanceEvidence({
        manifest,
        requireVerified: true,
        requirementsDirectory: fixture.requirementsDirectory,
        workspaceRoot: fixture.root,
      }),
    /has no verified evidence/,
  );
});

test("excludes recommended criteria and rejects malformed requirement levels", () => {
  const recommended = createFixture();
  writeFileSync(
    join(recommended.requirementsDirectory, "feature.mdx"),
    "- **AC-TST-001.1:** When tested, the system should behave.\n",
  );
  const manifest = validManifest();
  manifest.ownership = [];
  manifest.evidence = [];
  assert.deepEqual(
    validateAcceptanceEvidence({
      manifest,
      requirementsDirectory: recommended.requirementsDirectory,
      workspaceRoot: recommended.root,
    }),
    { mandatory: 0, planned: 0, verified: 0 },
  );

  const malformed = createFixture();
  writeFileSync(
    join(malformed.requirementsDirectory, "feature.mdx"),
    "- **AC-TST-001.1:** When tested, search shall behave.\n",
  );
  assert.throws(
    () =>
      validateAcceptanceEvidence({
        manifest: validManifest(),
        requirementsDirectory: malformed.requirementsDirectory,
        workspaceRoot: malformed.root,
      }),
    /does not declare a Software Factory requirement level/,
  );
});
