import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  auditDocumentationPlacement,
  listTrackedPaths,
} from "../verify-workspace-policy.mjs";

const authoritativeExamples = [
  "README.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".agents/skills/example/SKILL.md",
  ".agents/research/precedents/example/README.md",
  ".beads/README.md",
  ".github/ISSUE_TEMPLATE/bug.md",
  "apps/docs/AGENTS.md",
  "apps/docs/content/docs/index.mdx",
  "apps/docs/content/docs/requirements/example.mdx",
  "apps/docs/content/docs/blueprints/testing/example.mdx",
  "apps/docs/content/docs/cli/example.mdx",
  "packages/example/README.md",
  "packages/temp/README.md",
  "tests/integration/README.md",
  "ops/crabbox/README.md",
  "packages/harnesses/core/NATIVE_FIXTURES.md",
];

test("accepts every authoritative Markdown location", () => {
  assert.doesNotThrow(() => auditDocumentationPlacement(authoritativeExamples));
});

test("rejects scratch names and non-authoritative locations", () => {
  for (const path of [
    "temp.md",
    "temp.MD",
    "temp.Mdx",
    "scratch.MDX",
    "tests/integration/scratchpad.md",
    "ops/crabbox/REMOVAL-RECEIPT.md",
    "packages/example/notes.md",
    "handoff/status.md",
    "packages/example/design.md",
    ".AGENTS/SKILLS/example/random.md",
    "APPS/docs/content/docs/requirements/example.mdx",
  ]) {
    assert.throws(
      () => auditDocumentationPlacement([path]),
      new RegExp(path.replaceAll(/[./-]/gu, "\\$&")),
    );
  }
});

test("ignores non-Markdown tracked files", () => {
  assert.doesNotThrow(() =>
    auditDocumentationPlacement([
      "src/temp.ts",
      "packages/example/notes.json",
      "scripts/handoff.mjs",
    ]),
  );
});

test("enumerates mixed-case Markdown extensions before auditing", () => {
  const repository = mkdtempSync(join(tmpdir(), "agentscope-doc-policy-"));

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    mkdirSync(join(repository, "notes"));
    writeFileSync(join(repository, "notes", "temp.Mdx"), "scratch\n");
    execFileSync("git", ["add", "notes/temp.Mdx"], { cwd: repository });

    const trackedPaths = listTrackedPaths(repository);
    assert.deepEqual(trackedPaths, ["notes/temp.Mdx"]);
    assert.throws(
      () => auditDocumentationPlacement(trackedPaths),
      /notes\/temp\.Mdx/u,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
