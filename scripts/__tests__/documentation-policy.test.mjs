import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parse } from "yaml";

import {
  auditDocumentationPlacement,
  listTrackedPaths,
} from "../verify-workspace-policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

test("pins one bounded Hetzner Crabbox hydration path", () => {
  const config = parse(readFileSync(join(root, ".crabbox.yaml"), "utf8"));

  assert.deepEqual(config, {
    provider: "hetzner",
    target: "linux",
    architecture: "amd64",
    os: "ubuntu:24.04",
    serverType: "cx33",
    lease: { ttl: "90m", idleTimeout: "20m" },
    actions: {
      workflow: ".github/workflows/crabbox-hydrate.yml",
      job: "hydrate",
    },
  });
});

test("hydrates the pinned toolchain before frozen dependencies", () => {
  const workflow = parse(
    readFileSync(
      join(root, ".github", "workflows", "crabbox-hydrate.yml"),
      "utf8",
    ),
  );
  const job = workflow.jobs.hydrate;

  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "crabbox_id",
    "crabbox_job",
    "crabbox_keep_alive_minutes",
    "crabbox_runner_label",
  ]);
  assert.equal(
    workflow.on.workflow_dispatch.inputs.crabbox_job.default,
    "hydrate",
  );
  assert.deepEqual(job["runs-on"], [
    "self-hosted",
    "${{ inputs.crabbox_runner_label }}",
  ]);
  assert.equal(job["timeout-minutes"], 20);
  assert.equal(job.steps.length, 5);
  assert.deepEqual(
    job.steps.slice(0, 4).map((step) => step.uses ?? step.run),
    [
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      'corepack enable\ncorepack prepare pnpm@9.15.0 --activate\ntest "$(pnpm --version)" = "9.15.0"\n',
      "pnpm install --frozen-lockfile",
    ],
  );
  assert.deepEqual(job.steps[0].with, {
    "fetch-depth": 1,
    "persist-credentials": false,
  });
  assert.deepEqual(job.steps[1].with, { "node-version": "22.14.0" });
  assert.match(job.steps[4].run, /chmod 700 "\$state_root"/u);
  assert.match(job.steps[4].run, /mv "\$env_tmp" "\$env_file"/u);
  assert.match(job.steps[4].run, /mv "\$services_tmp" "\$services_file"/u);
  assert.match(job.steps[4].run, /READY_AT=%s/u);
  assert.match(job.steps[4].run, /mv "\$state_tmp" "\$state"\n$/u);
});
