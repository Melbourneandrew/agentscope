import { test, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  authenticateOwnerCheckpoint,
  prepareIntent,
  consumeIntent,
  prepareDraft,
  recordStage,
} from "../release-lane/production-recording.mjs";
import { sha256, canonicalJson } from "../release-lane/validation.mjs";

const hash = `sha256:${"a".repeat(64)}`;
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const controlsReport = JSON.stringify({
  state: "operator-controls-observed",
  repository: "Melbourneandrew/agentscope",
  ownerId: 25971425,
  ownerLogin: "Melbourneandrew",
  inspectedAt: "2026-10-07T00:00:00.000Z",
  responseCount: 8,
  responses: [
    "/user",
    "/rulesets?per_page=100",
    "/rulesets/24696278",
    "/rulesets/24696353",
    "/immutable-releases",
    "/branches/main/protection",
    "/environments/npm-release",
    "/environments/npm-release/deployment-branch-policies?per_page=100",
  ].map((path) => ({ path, bytes: 1, digest: hash })),
});
const observation = {
  transactionId: "transaction-1",
  draftReleaseDatabaseId: 7,
  issuedAt: "2026-10-07T00:00:00.000Z",
  expiresAt: "2026-10-07T00:15:00.000Z",
  pendingStagesState: "none-conflicting",
  phase: "pre-stage",
  sourceRevision: "b".repeat(40),
  candidateManifestDigest: hash,
  expectedSequence: 1,
  expectedPriorDigest: hash,
  controlsReport,
};
const consumedAt = "2026-10-07T00:01:00.000Z";
function fixture() {
  const input = {
    runId: 42,
    runAttempt: 1,
    sourceRevision: "b".repeat(40),
    owner: "Melbourneandrew",
    environmentId: 9,
  };
  const run = {
    id: 42,
    head_sha: input.sourceRevision,
    run_attempt: 1,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    actor: { id: 25971425, login: "Melbourneandrew" },
    triggering_actor: { id: 25971425, login: "Melbourneandrew" },
  };
  const approval = {
    state: "approved",
    user: { id: 25971425, login: "Melbourneandrew" },
    environments: [{ id: 9, name: "npm-release" }],
  };
  return {
    input,
    run,
    approval,
    store: { run: async () => run, approvals: async () => [approval] },
  };
}
async function intentFixture(observationOverrides = {}) {
  const f = fixture();
  const head = {
    schemaVersion: 1,
    sequence: 1,
    transition: "draft-prepared",
    transactionId: "transaction-1",
    draftReleaseDatabaseId: 7,
    candidateManifestDigest: hash,
    sourceRevision: f.input.sourceRevision,
    kind: "product",
  };
  head.digest = sha256(canonicalJson({ ...head, previousDigest: null }));
  const checkpoint = await authenticateOwnerCheckpoint(
    f.store,
    f.input,
    {
      ...observation,
      expectedPriorDigest: head.digest,
      ...observationOverrides,
    },
    consumedAt,
  );
  const tuple = {
    kind: "product",
    transactionId: "transaction-1",
    candidateManifestDigest: hash,
    tarballSha256: hash,
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    sourceRevision: f.input.sourceRevision,
    protectedTag: "v0.1.0",
    package: "agentscope-cli",
    version: "0.1.0",
    distTag: "alpha",
    workflowDigest: hash,
    releaseScriptsDigest: hash,
    ownerCheckpointDigest: sha256(canonicalJson(checkpoint)),
  };
  const input = {
    tuple,
    head,
    expectedPriorDigest: head.digest,
    expectedSequence: 1,
    consumedAt: "2026-10-07T00:01:00.000Z",
  };
  return { input, checkpoint, intent: prepareIntent(input, checkpoint) };
}
function chainStore(f, write) {
  const records = [];
  const unsigned = { ...f.input.head, previousDigest: null };
  delete unsigned.digest;
  const first = { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
  // Bind the test intent to the actual fake durable draft record.
  f.input.head.digest = first.digest;
  f.input.expectedPriorDigest = first.digest;
  f.intent = prepareIntent(f.input, f.checkpoint);
  records.push(first);
  return {
    release: async () => ({
      draft: true,
      prerelease: true,
      tag_name: "v0.1.0",
    }),
    assets: async () =>
      records.map((record, index) => {
        const bytes = Buffer.from(`${canonicalJson(record)}\n`);
        return {
          id: index + 1,
          name: `release-record-${String(index + 1).padStart(6, "0")}.json`,
          size: bytes.length,
          digest: sha256(bytes),
        };
      }),
    readAsset: async (id) => Buffer.from(`${canonicalJson(records[id - 1])}\n`),
    appendAsset: async (_id, _name, bytes) => {
      await write();
      records.push(JSON.parse(bytes));
      return { id: records.length };
    },
  };
}
test.each([
  "head_sha",
  "run_attempt",
  "path",
  "event",
  "actor",
  "triggering_actor",
])("rejects wrong authenticated run %s", async (field) => {
  const f = fixture();
  f.run[field] = null;
  await expect(authenticateOwnerCheckpoint(f.store, f.input)).rejects.toThrow();
});
test("rejects missing, duplicate and wrong-environment approval", async () => {
  for (const approvals of [
    [],
    [fixture().approval, fixture().approval],
    [{ ...fixture().approval, environments: [] }],
  ]) {
    const f = fixture();
    f.store.approvals = async () => approvals;
    await expect(
      authenticateOwnerCheckpoint(f.store, f.input, observation, consumedAt),
    ).rejects.toThrow();
  }
});

test("owner login labels cannot substitute another authenticated principal", async () => {
  for (const subject of ["actor", "triggering_actor", "approval"]) {
    const f = fixture();
    if (subject === "approval") f.approval.user.id = 1;
    else f.run[subject].id = 1;
    await expect(
      authenticateOwnerCheckpoint(f.store, f.input, observation, consumedAt),
    ).rejects.toThrow();
  }
});
test.each(["expired", "future", "unknown-pending"])(
  "refuses %s owner observation",
  async (kind) => {
    const f = fixture();
    const supplied = { ...observation };
    if (kind === "unknown-pending") supplied.pendingStagesState = "unknown";
    const time =
      kind === "expired"
        ? "2026-10-07T00:16:00.000Z"
        : kind === "future"
          ? "2026-10-06T23:59:59.999Z"
          : consumedAt;
    await expect(
      authenticateOwnerCheckpoint(f.store, f.input, supplied, time),
    ).rejects.toThrow();
  },
);

test("queued approval consumes at runner time without renewing original expiry", async () => {
  const f = fixture();
  const actualConsumption = "2026-10-07T00:10:00.000Z";
  const checkpoint = await authenticateOwnerCheckpoint(
    f.store,
    f.input,
    observation,
    actualConsumption,
  );
  expect(checkpoint.consumedAt).toBe(actualConsumption);
  expect(checkpoint.issuedAt).toBe(observation.issuedAt);
  expect(checkpoint.expiresAt).toBe(observation.expiresAt);
  await expect(
    authenticateOwnerCheckpoint(
      f.store,
      f.input,
      { ...observation, consumedAt },
      actualConsumption,
    ),
  ).rejects.toThrow();
  await expect(
    authenticateOwnerCheckpoint(
      f.store,
      f.input,
      observation,
      "2026-10-07T00:15:00.001Z",
    ),
  ).rejects.toThrow();
});

test.each([
  ["phase", "pre-release"],
  ["sourceRevision", "c".repeat(40)],
  ["candidateManifestDigest", `sha256:${"c".repeat(64)}`],
  ["expectedSequence", 2],
  ["expectedPriorDigest", `sha256:${"c".repeat(64)}`],
  ["controlsReport", "{}"],
])(
  "rejects a fresh but detached controls checkpoint %s before intent",
  async (field, value) => {
    await expect(intentFixture({ [field]: value })).rejects.toThrow();
  },
);

function candidateFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-production-fixture-"));
  roots.push(root);
  const files = [
    {
      path: "package/package.json",
      content: JSON.stringify({
        name: "agentscope-cli",
        version: "0.1.0",
        bin: { agentscope: "./dist/bin/agentscope.js" },
        publishConfig: { access: "public" },
      }),
    },
    {
      path: "package/dist/bin/agentscope.js",
      content: "#!/usr/bin/env node\n",
    },
  ];
  const octal = (value, width) =>
    `${value.toString(8).padStart(width - 1, "0")}\0`;
  const chunks = files.map(({ path, content }) => {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100);
    for (const [offset, width, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, body.length],
      [136, 12, 0],
    ])
      header.write(octal(value, width), offset, width, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );
    return Buffer.concat([
      header,
      body,
      Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length),
    ]);
  });
  const bytes = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
  const tarballPath = join(root, "agentscope-cli-0.1.0.tgz");
  writeFileSync(tarballPath, bytes);
  const manifest = {
    schemaVersion: 1,
    candidateId: "agentscope.release-candidate.v1",
    package: {
      name: "agentscope-cli",
      version: "0.1.0",
      bin: { agentscope: "./dist/bin/agentscope.js" },
    },
    channel: { npmDistTag: "alpha", githubPrerelease: true },
    sourceRevision: "b".repeat(40),
    protectedTag: "v0.1.0",
    tarball: {
      fileName: "agentscope-cli-0.1.0.tgz",
      bytes: bytes.length,
      sha256: sha256(bytes),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      inventoryDigest: sha256(
        canonicalJson(
          files.map(({ path, content }) => ({
            path,
            bytes: Buffer.byteLength(content),
            sha256: sha256(Buffer.from(content)),
          })),
        ),
      ),
    },
    certification: { state: "certified", recordDigest: "" },
  };
  const certificationRecord = {
    schemaVersion: 1,
    recordId: "agentscope.candidate-certification.v1",
    state: "certified",
    package: { name: "agentscope-cli", version: "0.1.0" },
    sourceRevision: manifest.sourceRevision,
    protectedTag: "v0.1.0",
    tarballSha256: manifest.tarball.sha256,
    inventoryDigest: manifest.tarball.inventoryDigest,
    supportAdmissionDigest: sha256(canonicalJson({})),
    evidenceIndexDigest: sha256(canonicalJson({})),
  };
  manifest.certification.recordDigest = sha256(
    canonicalJson(certificationRecord),
  );
  return {
    manifest,
    certificationRecord,
    tarballPath,
    expectedManifestDigest: sha256(canonicalJson(manifest)),
    expectedSourceRevision: manifest.sourceRevision,
    expectedProtectedTag: "v0.1.0",
    transactionId: "transaction-1",
    authenticatedActor: "owner",
    retainedAssets: [
      "checksum-manifest.json",
      "support-admission.json",
      "sbom.json",
      "attestations.json",
      "evidence-index.json",
    ].map((name) => ({
      name,
      bytes: Buffer.from("{}\n"),
      digest: sha256(Buffer.from("{}\n")),
    })),
  };
}
test("draft producer retains exact candidate and writes first record last, not admission", async () => {
  const fixture = candidateFixture();
  const names = [];
  const result = await prepareDraft(
    {
      releases: async () => [],
      createDraft: async () => ({
        id: 7,
        draft: true,
        prerelease: true,
        tag_name: "v0.1.0",
      }),
      appendAsset: async (_id, name, bytes) => {
        names.push(name);
        return {
          id: names.length,
          name,
          digest: sha256(bytes),
          size: bytes.length,
        };
      },
    },
    fixture,
  );
  expect(names).toHaveLength(9);
  expect(names.at(-1)).toBe("release-record-000001.json");
  expect(result.state).toBe("draft-durable-no-stage-executed");
});
test.each(["existing-draft", "ambiguous-create", "ambiguous-upload"])(
  "freezes %s without a second creation",
  async (kind) => {
    let creations = 0;
    const fixture = candidateFixture();
    const store = {
      releases: async () =>
        kind === "existing-draft" ? [{ draft: true }] : [],
      createDraft: async () => {
        creations++;
        if (kind === "ambiguous-create") throw new Error("unknown");
        return { id: 7, draft: true, prerelease: true, tag_name: "v0.1.0" };
      },
      appendAsset: async () => {
        throw new Error("unknown");
      },
    };
    await expect(prepareDraft(store, fixture)).rejects.toThrow();
    expect(creations).toBe(kind === "existing-draft" ? 0 : 1);
  },
);
test("copied owner labels and self hashes are not authentication", async () => {
  const f = await intentFixture();
  expect(() => prepareIntent(f.input, { ...f.checkpoint })).toThrow();
});
test("durable intent precedes stage and crashes never invoke a stage", async () => {
  const f = await intentFixture();
  let writes = 0;
  const store = chainStore(f, async () => {
    writes++;
    throw new Error("unknown-upload");
  });
  await expect(consumeIntent(store, f.intent, f.input.head)).rejects.toThrow(
    "unknown-upload",
  );
  expect(writes).toBe(1);
  const successful = chainStore(f, async () => {});
  const result = await consumeIntent(successful, f.intent, f.input.head);
  expect(result.state).toBe("intent-durable-no-stage-executed");
  expect(result.intent.transition).toBe("pre-stage-intent");
});
test("stale head and substituted intent refuse before any write", async () => {
  const f = await intentFixture();
  let writes = 0;
  const store = {
    appendAsset: async () => {
      writes++;
    },
  };
  await expect(
    consumeIntent(store, f.intent, { ...f.input.head, sequence: 3 }),
  ).rejects.toThrow();
  await expect(
    consumeIntent(store, { ...f.intent, runAttempt: 2 }, f.input.head),
  ).rejects.toThrow();
  expect(writes).toBe(0);
});
test.each(["received", "missing", "ambiguous"])(
  "records %s only after durable intent and refuses reuse",
  async (response) => {
    const f = await intentFixture();
    const store = chainStore(f, async () => {});
    await consumeIntent(store, f.intent, f.input.head);
    const input = {
      releaseId: 7,
      intentDigest: f.intent.digest,
      runId: 42,
      runAttempt: 1,
      stageResult: {
        schemaVersion: 1,
        tuple: f.input.tuple,
        response,
        stageId: response === "received" ? "stage-1" : null,
      },
      observedAt: "2026-10-07T00:02:00.000Z",
      actor: "owner",
    };
    const result = await recordStage(store, input);
    expect(result.previousDigest).toBe(f.intent.digest);
    expect(result.transition).toBe(
      response === "received" ? "stage-recorded" : "quarantine-still-draft",
    );
    await expect(recordStage(store, input)).rejects.toThrow();
  },
);
test.each(["runId", "runAttempt", "intentDigest"])(
  "rejects other stage provenance %s before append",
  async (field) => {
    const f = await intentFixture();
    let writes = 0;
    const store = chainStore(f, async () => {
      writes++;
    });
    await consumeIntent(store, f.intent, f.input.head);
    const input = {
      releaseId: 7,
      intentDigest: f.intent.digest,
      runId: 42,
      runAttempt: 1,
      stageResult: {
        schemaVersion: 1,
        tuple: f.input.tuple,
        response: "missing",
        stageId: null,
      },
      observedAt: "2026-10-07T00:02:00.000Z",
      actor: "owner",
    };
    input[field] = field === "intentDigest" ? hash : 99;
    await expect(recordStage(store, input)).rejects.toThrow();
    expect(writes).toBe(1);
  },
);
