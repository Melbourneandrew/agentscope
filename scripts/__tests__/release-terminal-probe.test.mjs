import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { canonicalJson, sha256 } from "../release-lane/validation.mjs";
import { createGitHubReleaseStore } from "../release-lane/github-release-store.mjs";

const signedRecord = (value) => ({
  ...value,
  digest: sha256(canonicalJson(value)),
});
function probeRecords() {
  const digest = sha256("synthetic"),
    revision = "a".repeat(40);
  const material = {
    schemaVersion: 1,
    kind: "inert-probe-material",
    preparationRunId: 10,
    preparationRunAttempt: 1,
    sourceRevision: revision,
    workflowDigest: digest,
    releaseScriptsDigest: digest,
    version: "0.0.0-oidc-probe.10-1",
    tarballFilename: "agentscope-cli-0.0.0-oidc-probe.10-1.tgz",
    tarballSha256: digest,
    integrity: `sha512-${"A".repeat(86)}==`,
    inventoryDigest: digest,
  };
  const reservation = signedRecord({
    schemaVersion: 1,
    kind: "reserved-inert-probe-invocation",
    repository: "Melbourneandrew/agentscope",
    workflowPath: ".github/workflows/release.yml",
    workflowDatabaseId: 5,
    expectedRunNumber: 11,
    runAttempt: 1,
    ownerId: 25971425,
    ownerLogin: "Melbourneandrew",
    version: material.version,
    preparationRunId: 10,
    preparationRunAttempt: 1,
    preparationSourceRevision: revision,
    preparedMaterialDigest: sha256(canonicalJson(material)),
    tarballSha256: digest,
    integrity: material.integrity,
    workflowDigest: digest,
    releaseScriptsDigest: digest,
  });
  const issuedAt = "2026-10-09T00:00:00.000Z",
    expiresAt = "2026-10-09T00:10:00.000Z";
  const controlsReport = canonicalJson({
    state: "operator-controls-observed",
    repository: "Melbourneandrew/agentscope",
    ownerId: 25971425,
    ownerLogin: "Melbourneandrew",
    inspectedAt: issuedAt,
    responseCount: 8,
    responses: [
      "/user",
      "/rulesets?per_page=100",
      "/rulesets/1",
      "/rulesets/2",
      "/immutable-releases",
      "/branches/main/protection",
      "/environments/npm-release",
      "/environments/npm-release/deployment-branch-policies?per_page=100",
    ].map((path) => ({ path, bytes: 1, digest })),
  });
  const ownerObservation = {
    phase: "reconcile-probe",
    packetDigest: digest,
    issuedAt,
    expiresAt,
    controlsReport,
    stageId: "stage-1",
    downloadedTarballSha256: digest,
    downloadedIntegrity: material.integrity,
    downloadedInventoryDigest: digest,
    terminalNpmState: "rejected",
  };
  const terminal = signedRecord({
    schemaVersion: 1,
    kind: "terminal-inert-oidc-probe",
    repository: "Melbourneandrew/agentscope",
    workflowPath: ".github/workflows/release.yml",
    environment: "npm-release",
    trustedPublisherAction: "stage-publish",
    sourceRevision: revision,
    runId: 11,
    runAttempt: 1,
    workflowDigest: digest,
    releaseScriptsDigest: digest,
    material,
    stageId: "stage-1",
    recorderOutputDigest: digest,
    invocationIntentDigest: reservation.digest,
    ownerIdentity: "Melbourneandrew",
    ownerObservation,
    controlsReportDigest: sha256(Buffer.from(controlsReport)),
    controlsInspectedAt: issuedAt,
    authenticationDigest: digest,
    terminalNpmState: "rejected",
    disposition: "awaiting-reviewed-append-under-release-records/probes",
  });
  return { reservation, terminal, revision, digest };
}

function addProbeRecord(values, probes, name, record) {
  const bytes = Buffer.from(`${canonicalJson(record)}\n`);
  const sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  values[`/git/trees/${probes}`].tree.push({
    path: name,
    sha,
    type: "blob",
    mode: "100644",
  });
  values[`/git/blobs/${sha}`] = {
    sha,
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
  };
}

function probeStoreFixture(mutate = () => {}, executingOverride) {
  const records = probeRecords();
  mutate(records);
  const { terminal, reservation, revision, digest } = records;
  const root = "b".repeat(40),
    directory = "c".repeat(40),
    probes = "d".repeat(40),
    tag = "e".repeat(40);
  const tree = (sha, entries) => ({ sha, truncated: false, tree: entries });
  const entry = (path, sha) => ({ path, sha, type: "tree", mode: "040000" });
  const values = {
    "/git/ref/heads/main": {
      ref: "refs/heads/main",
      object: { type: "commit", sha: revision },
    },
    [`/git/commits/${revision}`]: { sha: revision, tree: { sha: root } },
    [`/git/trees/${root}`]: tree(root, [entry("release-records", directory)]),
    [`/git/trees/${directory}`]: tree(directory, [entry("probes", probes)]),
    [`/git/trees/${probes}`]: tree(probes, []),
    "/git/ref/tags/v0.1.0": { object: { type: "tag", sha: tag } },
    [`/git/tags/${tag}`]: {
      tag: "v0.1.0",
      object: { type: "commit", sha: revision },
    },
    [`/compare/${revision}...main`]: {
      status: "ahead",
      merge_base_commit: { sha: revision },
    },
    "/actions/runs/11": {
      id: 11,
      run_attempt: 1,
      workflow_id: 5,
      run_number: 11,
      path: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: revision,
      actor: { id: 25971425, login: "Melbourneandrew" },
      triggering_actor: { id: 25971425, login: "Melbourneandrew" },
    },
  };
  for (const [name, record] of [
    [`${reservation.version}.intent.json`, reservation],
    ["terminal.json", terminal],
  ]) {
    addProbeRecord(values, probes, name, record);
  }
  const calls = [],
    state = { changed: false };
  let refs = 0;
  const store = createGitHubReleaseStore({
    token: "synthetic-only",
    deadline: performance.now() + 1000,
    executingDigests: executingOverride ?? {
      workflowDigest: digest,
      releaseScriptsDigest: digest,
    },
    fetchImpl: async (url, options) => {
      expect(options.method).toBe("GET");
      const path = url.slice(
        "https://api.github.com/repos/Melbourneandrew/agentscope".length,
      );
      calls.push(path);
      if (path === "/git/ref/heads/main" && ++refs > 1 && state.changed)
        return Response.json({
          ref: "refs/heads/main",
          object: { type: "commit", sha: "f".repeat(40) },
        });
      return values[path] === undefined
        ? new Response("missing", { status: 404 })
        : Response.json(values[path]);
    },
  });
  return { store, calls, values, state, probes, revision, records };
}

test("product source consumes actual terminal-producer grammar and stable protected-main records", async () => {
  const f = probeStoreFixture();
  await expect(f.store.protectedSource(f.revision)).resolves.toMatchObject({
    sourceRevision: f.revision,
  });
  expect(f.calls.at(-1)).toBe("/git/ref/heads/main");
  expect(f.calls).toContain("/actions/runs/11");
});
test.each(["matching", "drift", "pending"])(
  "latest reserved run controls admission: %s",
  async (mode) => {
    const f = probeStoreFixture(),
      next = probeRecords();
    next.terminal.material.preparationRunId = 20;
    next.terminal.material.version = "0.0.0-oidc-probe.20-1";
    next.terminal.material.tarballFilename =
      "agentscope-cli-0.0.0-oidc-probe.20-1.tgz";
    if (mode === "drift") {
      next.terminal.material.workflowDigest = sha256("changed");
      next.terminal.workflowDigest = sha256("changed");
      next.reservation.workflowDigest = sha256("changed");
    }
    Object.assign(next.reservation, {
      version: next.terminal.material.version,
      preparationRunId: 20,
      expectedRunNumber: 12,
      preparedMaterialDigest: sha256(canonicalJson(next.terminal.material)),
    });
    const unsigned = (value) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "digest"),
      );
    next.reservation = signedRecord(unsigned(next.reservation));
    Object.assign(next.terminal, {
      runId: 12,
      invocationIntentDigest: next.reservation.digest,
    });
    next.terminal = signedRecord(unsigned(next.terminal));
    addProbeRecord(f.values, f.probes, "new.intent.json", next.reservation);
    if (mode !== "pending")
      addProbeRecord(f.values, f.probes, "new-terminal.json", next.terminal);
    f.values["/actions/runs/12"] = {
      ...f.values["/actions/runs/11"],
      id: 12,
      run_number: 12,
    };
    // Neither filenames nor traversal order defines latest authority.
    f.values[`/git/trees/${f.probes}`].tree.reverse();
    const admitted = f.store.protectedSource(f.revision);
    if (mode === "matching")
      await expect(admitted).resolves.toMatchObject({
        sourceRevision: f.revision,
      });
    else await expect(admitted).rejects.toThrow("release.store.unresolved");
  },
);
test.each([
  "absent",
  "truncated",
  "symlink",
  "blob",
  "pending",
  "duplicate",
  "run",
  "main",
  "executing",
])("product refuses %s probe authority before any mutation", async (reason) => {
  const f = probeStoreFixture();
  const tree = f.values[`/git/trees/${f.probes}`];
  if (reason === "absent") tree.tree = [];
  if (reason === "truncated") tree.truncated = true;
  if (reason === "symlink") tree.tree[0].mode = "120000";
  if (reason === "blob") f.values[`/git/blobs/${tree.tree[1].sha}`].size++;
  if (reason === "pending") tree.tree.pop();
  if (reason === "duplicate")
    tree.tree.push({ ...tree.tree[1], path: "other.json" });
  if (reason === "run") f.values["/actions/runs/11"].run_number++;
  if (reason === "main") f.state.changed = true;
  if (reason === "executing") {
    const drift = probeStoreFixture(() => {}, {
      workflowDigest: sha256("drift"),
      releaseScriptsDigest: sha256("synthetic"),
    });
    await expect(drift.store.protectedSource(drift.revision)).rejects.toThrow();
  } else await expect(f.store.protectedSource(f.revision)).rejects.toThrow();
});
test.each([
  "terminalNpmState",
  "environment",
  "workflowDigest",
  "download",
  "intent",
  "source",
])(
  "rehashed %s substitution cannot acquire product authority",
  async (field) => {
    const f = probeStoreFixture((records) => {
      const value = records.terminal;
      if (field === "terminalNpmState") value.terminalNpmState = "public";
      if (field === "environment") value.environment = "other";
      if (field === "workflowDigest") value.workflowDigest = sha256("changed");
      if (field === "download")
        value.ownerObservation.downloadedTarballSha256 = sha256("changed");
      if (field === "intent") value.invocationIntentDigest = sha256("changed");
      if (field === "source") value.sourceRevision = "f".repeat(40);
      const unsigned = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "digest"),
      );
      records.terminal = signedRecord(unsigned);
    });
    await expect(f.store.protectedSource(f.revision)).rejects.toThrow();
  },
);
test("only product store construction binds the authenticated executing byte closure", () => {
  const entry = readFileSync(
    new URL("../record-release-stage.mjs", import.meta.url),
    "utf8",
  );
  const start = entry.indexOf("const store = createGitHubReleaseStore({");
  const construction = entry.slice(
    start,
    entry.indexOf("const run = await store.run(", start),
  );
  for (const probeOperation of [true, false]) {
    const observed = [],
      expected = {
        workflowDigest: "held-workflow",
        releaseScriptsDigest: "held-scripts",
      };
    runInNewContext(construction, {
      probeOperation,
      deadline: 1,
      process: { env: { GITHUB_TOKEN: "test-only" } },
      executingDigests: () => expected,
      createGitHubReleaseStore: (options) => observed.push(options),
    });
    expect(observed[0].executingDigests).toBe(
      probeOperation ? undefined : expected,
    );
  }
  expect(entry).toContain(
    "if (probeOperation) await store.protectedMainSource(process.env.GITHUB_SHA)",
  );
});
