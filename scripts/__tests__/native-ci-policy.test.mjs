import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { parse } from "yaml";

import {
  computeNativeCiAuthorityDigest,
  parseChangedPaths,
  parseTrackedEntries,
  pruneNativeIrrelevantPaths,
  selectNativeCertification,
  validateNativeCiPolicy,
} from "../native-ci-selection.mjs";

const root = resolve(import.meta.dirname, "../..");

test("native PR selection skips only explicit irrelevant paths", () => {
  const irrelevant = [
    "apps/docs/content/docs/index.mdx",
    "tests/integration/evidence/local-docker-substrate-2026-08-22.json",
    "tests/integration/src/controller-policy.test.ts",
  ];
  assert.deepEqual(selectNativeCertification("pull_request", irrelevant), {
    required: false,
    reason: "explicitly-irrelevant-paths",
  });
  for (const path of [
    "apps/cli/src/index.ts",
    "packages/core/src/index.ts",
    "packages/destinations/local-sqlite/src/index.ts",
    "packages/destinations/local-sqlite/native-candidate/tooling/build-driver.py",
    "pnpm-lock.yaml",
    "apps/docs/package.json",
    "apps/docs/next.config.mjs",
    "apps/docs/content/docs/blueprints/operations/continuous-integration.mdx",
    "apps/docs/content/docs/requirements/supported-platforms.mdx",
    ".github/workflows/pr-validation.yml",
    "scripts/unrecognized-policy.mjs",
    "unknown/new-input.bin",
    "docs/unexpected-input.sh",
    "tests/integration/src/controller.ts",
  ])
    assert.equal(
      selectNativeCertification("pull_request", [path]).required,
      true,
      path,
    );
  assert.equal(selectNativeCertification("push", irrelevant).required, true);
  assert.equal(
    selectNativeCertification("workflow_dispatch", irrelevant).required,
    true,
  );
  assert.equal(selectNativeCertification("pull_request", []).required, true);
});

test("finite irrelevant inventory is disjoint from the recomputed authority closure", () => {
  const trackedEntries = parseTrackedEntries(
    execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root }),
  );
  const trackedPaths = trackedEntries.map(({ path }) => path);
  const manifest = JSON.parse(
    readFileSync(join(root, "scripts/native-ci-irrelevant-paths.json"), "utf8"),
  );
  const irrelevantPaths = new Set(manifest.irrelevantPaths);
  const authorities = trackedPaths.filter(
    (path) =>
      path !== "scripts/native-ci-irrelevant-paths.json" &&
      !irrelevantPaths.has(path),
  );
  assert.ok(authorities.length > 0);
  for (const path of authorities)
    assert.equal(
      selectNativeCertification("pull_request", [path]).required,
      true,
      path,
    );
  assert.doesNotThrow(() => validateNativeCiPolicy(manifest, trackedEntries));
  for (const productionAuthority of [
    "apps/cli/src/program.ts",
    "packages/destinations/local-sqlite/src/production/runtime.ts",
  ])
    assert.ok(authorities.includes(productionAuthority), productionAuthority);
  const nxGraph = JSON.parse(
    execFileSync("pnpm", ["nx", "graph", "--file=stdout"], {
      cwd: root,
      encoding: "utf8",
    }),
  ).graph;
  const packedProjectClosure = new Set(["agentscope-cli"]);
  const pendingProjects = ["agentscope-cli"];
  while (pendingProjects.length > 0) {
    const project = pendingProjects.pop();
    for (const { target } of nxGraph.dependencies[project] ?? []) {
      if (packedProjectClosure.has(target)) continue;
      packedProjectClosure.add(target);
      pendingProjects.push(target);
    }
  }
  const projectNodes = Object.values(nxGraph.nodes).sort(
    (left, right) => right.data.root.length - left.data.root.length,
  );
  for (const path of manifest.irrelevantPaths) {
    const owner = projectNodes.find(
      ({ data }) => path === data.root || path.startsWith(`${data.root}/`),
    );
    if (owner !== undefined)
      assert.equal(packedProjectClosure.has(owner.name), false, path);
  }
  const nextRevisionEntries = trackedEntries.map((entry) =>
    entry.path === "apps/cli/src/program.ts"
      ? { ...entry, objectId: "f".repeat(40) }
      : entry,
  );
  // A first PR can introduce an edge from production source to an irrelevant
  // document. Its changed blob ID invalidates the policy before a later docs PR.
  assert.throws(
    () => validateNativeCiPolicy(manifest, nextRevisionEntries),
    /native-ci-policy-invalid/u,
  );
  const closureAuthorities = trackedPaths.filter(
    (path) =>
      path.startsWith(".github/workflows/") || path.startsWith("scripts/"),
  );
  for (const closureAuthority of closureAuthorities) {
    const selfAuthorizingManifest = {
      ...manifest,
      irrelevantPaths: [...manifest.irrelevantPaths, closureAuthority].sort(),
    };
    const selfAuthorizedEntries = trackedEntries.filter(
      ({ path }) =>
        path !== "scripts/native-ci-irrelevant-paths.json" &&
        !selfAuthorizingManifest.irrelevantPaths.includes(path),
    );
    selfAuthorizingManifest.authorityDigest = computeNativeCiAuthorityDigest(
      selfAuthorizedEntries,
    );
    assert.throws(
      () => validateNativeCiPolicy(selfAuthorizingManifest, trackedEntries),
      /native-ci-policy-invalid/u,
      closureAuthority,
    );
    assert.equal(
      selectNativeCertification("pull_request", [closureAuthority]).required,
      true,
      closureAuthority,
    );
  }
});

test("required native execution removes every certified non-input", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agentscope-native-ci-"));
  try {
    const irrelevant = new Set([
      "README.md",
      "apps/docs/content/docs/cli/index.mdx",
      "apps/docs/content/docs/hash#.mdx",
      "apps/docs/content/docs/percent%25.mdx",
      "apps/docs/content/docs/question?.mdx",
      "apps/docs/content/docs/%2e%2e/%2e%2e/%2e%2e/escape.mdx",
    ]);
    mkdirSync(join(temporaryRoot, "apps/docs/content/docs/cli"), {
      recursive: true,
    });
    writeFileSync(join(temporaryRoot, "README.md"), "not an input");
    for (const path of irrelevant) {
      mkdirSync(join(temporaryRoot, path, ".."), { recursive: true });
      writeFileSync(join(temporaryRoot, path), "not an input");
    }
    mkdirSync(join(temporaryRoot, "apps"), { recursive: true });
    writeFileSync(join(temporaryRoot, "apps/escape.mdx"), "must remain");
    writeFileSync(join(temporaryRoot, "authority.mjs"), "remains");
    pruneNativeIrrelevantPaths(
      pathToFileURL(`${temporaryRoot}${sep}`),
      irrelevant,
    );
    for (const path of irrelevant)
      assert.equal(existsSync(join(temporaryRoot, path)), false, path);
    assert.equal(existsSync(join(temporaryRoot, "apps/escape.mdx")), true);
    assert.equal(existsSync(join(temporaryRoot, "authority.mjs")), true);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("rename and deletion observations remain visible and malformed diffs fail", () => {
  assert.deepEqual(
    parseChangedPaths(Buffer.from("apps/docs/old.mdx\0packages/core/new.ts\0")),
    ["apps/docs/old.mdx", "packages/core/new.ts"],
  );
  assert.equal(
    selectNativeCertification("pull_request", [
      "apps/docs/old.mdx",
      "packages/core/new.ts",
    ]).required,
    true,
  );
  for (const value of [
    Buffer.from("unterminated"),
    Buffer.from("../escape\0"),
    Buffer.from("duplicate\0duplicate\0"),
    Buffer.from("output\ninjection\0"),
    Buffer.from([0xff, 0]),
  ])
    assert.throws(() => parseChangedPaths(value), /native-ci-paths-invalid/u);
});

test("workflow preserves parallel fresh native candidate authority and only caches frozen dependencies", () => {
  const source = readFileSync(
    join(root, ".github/workflows/pr-validation.yml"),
    "utf8",
  );
  const workflow = parse(source);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.jobs.native.needs, undefined);
  assert.equal(workflow.jobs.native.name, "Native candidate verification");
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(checkout.with?.["persist-credentials"], false);
  }
  const nativeCheckout = workflow.jobs.native.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(
    nativeCheckout.with.ref,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  assert.match(
    workflow.jobs.native.steps.find((step) => step.id === "selection").run,
    /git rev-parse HEAD.+NATIVE_HEAD_SHA/su,
  );
  const workflowActionReferences = Object.values(workflow.jobs).flatMap((job) =>
    job.steps
      .filter((step) => typeof step.uses === "string")
      .map((step) => step.uses),
  );
  assert.ok(
    workflowActionReferences.every((value) => /@[0-9a-f]{40}$/u.test(value)),
  );
  const actionClosure = workflow.jobs.native.steps
    .filter((step) => typeof step.uses === "string")
    .map((step) => step.uses);
  assert.deepEqual(actionClosure, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  ]);
  const setupNode = workflow.jobs.native.steps.find((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  assert.deepEqual(setupNode.with, { "node-version": 22, cache: "pnpm" });
  assert.match(source, /pnpm install --frozen-lockfile/u);
  assert.doesNotMatch(
    source,
    /actions\/cache|restore-keys|AGENTSCOPE_NATIVE_MATERIAL_CACHE/u,
  );
  assert.match(
    source,
    /Run fresh non-admitting native candidate verification/u,
  );
  const evidenceManifest = JSON.parse(
    readFileSync(
      join(
        root,
        "packages/destinations/local-sqlite/native-candidate/evidence/test-manifest.json",
      ),
      "utf8",
    ),
  );
  assert.equal(evidenceManifest.supportAdmission, "not-claimed");
  assert.match(
    readFileSync(join(root, "scripts/native-ci-selection.mjs"), "utf8"),
    /--no-renames/u,
  );
  const releaseSource = readFileSync(
    join(root, ".github/workflows/release-candidate-rehearsal.yml"),
    "utf8",
  );
  assert.match(
    releaseSource,
    /--prune-irrelevant[\s\S]+pnpm nx build agentscope-cli --skip-nx-cache[\s\S]+pnpm verify:cli-artifact[\s\S]+Run fresh non-admitting native candidate verification[\s\S]+pnpm verify:native-candidate/u,
  );
  assert.match(source, /--prune-irrelevant/u);
});
