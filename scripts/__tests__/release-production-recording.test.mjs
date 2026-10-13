import { test, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  authenticateOwnerCheckpoint,
  prepareIntent,
  consumeIntent,
  prepareDraft,
  recordStage,
  stageRetainedCandidate,
  recordStageFromJob,
  prepareProbeMaterial,
  prepareProbeIntent,
  stageRetainedProbe,
  recordProbeStagePacket,
  reconcileProbePacket,
  recordPublicationCheckpoint,
  recordPublicationApproval,
  readLatestRecord,
  verifyRegistryPublication,
  continuePublication,
} from "../release-lane/production-recording.mjs";
import { sha256, canonicalJson } from "../release-lane/validation.mjs";

const hash = `sha256:${"a".repeat(64)}`;
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function stageFixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(consumedAt));
  const f = fixture();
  const candidate = candidateFixture();
  const assets = [];
  const store = {
    ...f.store,
    protectedSource: async () => {},
    releases: async () => [],
    createDraft: async () => ({
      id: 7,
      draft: true,
      prerelease: true,
      tag_name: "v0.1.0",
    }),
    release: async () => ({
      draft: true,
      prerelease: true,
      tag_name: "v0.1.0",
    }),
    appendAsset: async (_releaseId, name, bytes) => {
      const entry = {
        id: assets.length + 1,
        name,
        size: bytes.length,
        digest: sha256(bytes),
        bytes: Buffer.from(bytes),
      };
      assets.push(entry);
      return {
        id: entry.id,
        name: entry.name,
        size: entry.size,
        digest: entry.digest,
      };
    },
    assets: async () => assets,
    readAsset: async (id) => assets.find((entry) => entry.id === id).bytes,
  };
  const draft = await prepareDraft(store, candidate);
  const checkpoint = await authenticateOwnerCheckpoint(
    store,
    f.input,
    {
      ...observation,
      expectedPriorDigest: draft.record.digest,
      candidateManifestDigest: candidate.expectedManifestDigest,
    },
    consumedAt,
  );
  const tuple = {
    kind: "product",
    transactionId: "transaction-1",
    candidateManifestDigest: candidate.expectedManifestDigest,
    tarballSha256: candidate.manifest.tarball.sha256,
    integrity: candidate.manifest.tarball.integrity,
    sourceRevision: f.input.sourceRevision,
    protectedTag: "v0.1.0",
    package: "agentscope-cli",
    version: "0.1.0",
    distTag: "alpha",
    workflowDigest: hash,
    releaseScriptsDigest: hash,
    ownerCheckpointDigest: sha256(canonicalJson(checkpoint)),
  };
  const head = Object.fromEntries(
    [
      "schemaVersion",
      "sequence",
      "transition",
      "transactionId",
      "draftReleaseDatabaseId",
      "candidateManifestDigest",
      "sourceRevision",
      "kind",
      "digest",
    ].map((key) => [key, draft.record[key]]),
  );
  const intent = prepareIntent(
    {
      tuple,
      head,
      expectedSequence: 1,
      expectedPriorDigest: head.digest,
      consumedAt,
    },
    checkpoint,
  );
  await consumeIntent(store, intent, draft.record);
  const input = {
    releaseId: 7,
    intentDigest: intent.digest,
    identity: f.input,
    executingDigests: { workflowDigest: hash, releaseScriptsDigest: hash },
    deadline: Math.floor(performance.now() + 10_000),
  };
  return { ...f, store, candidate, assets, intent, tuple, input };
}

async function publicationFixture() {
  const f = await stageFixture();
  f.run.head_branch = "v0.1.0";
  await recordStageFromJob(f.store, {
    releaseId: 7,
    intentDigest: f.intent.digest,
    identity: f.input.identity,
    executingDigests: f.input.executingDigests,
    stageResult: {
      schemaVersion: 1,
      tuple: f.tuple,
      response: "received",
      stageId: "stage-1",
    },
    observedAt: "2026-10-07T00:02:00.000Z",
  });
  const head = await readLatestRecord(f.store, 7);
  f.store.releases = async () => [
    { id: 7, draft: true, immutable: false, tag_name: "v0.1.0" },
  ];
  const input = {
    identity: f.input.identity,
    releaseId: 7,
    expectedSequence: head.sequence,
    expectedPriorDigest: head.digest,
    executingDigests: f.input.executingDigests,
    observedAt: "2026-10-07T00:02:00.000Z",
  };
  const owner = {
    transactionId: head.transactionId,
    draftReleaseDatabaseId: 7,
    sourceRevision: head.sourceRevision,
    candidateManifestDigest: head.candidateManifestDigest,
    expectedSequence: head.sequence,
    expectedPriorDigest: head.digest,
    ...Object.fromEntries(
      [
        "stageId",
        "package",
        "version",
        "distTag",
        "tarballSha256",
        "integrity",
      ].map((key) => [key, head.payload[key]]),
    ),
    downloadedTarballSha256: head.payload.tarballSha256,
    pendingStagesState: "exact-stage-only",
    distTags: { bootstrap: "0.0.0-bootstrap.0", latest: "0.0.0-bootstrap.0" },
    issuedAt: input.observedAt,
    expiresAt: "2026-10-07T00:10:00.000Z",
    controlsReport: JSON.stringify({
      ...JSON.parse(controlsReport),
      inspectedAt: input.observedAt,
    }),
  };
  return {
    ...f,
    head,
    publicationInput: input,
    owner,
    candidate: {
      manifest: f.candidate.manifest,
      certificationRecord: f.candidate.certificationRecord,
      tarballPath: f.candidate.tarballPath,
    },
  };
}

async function approvedPublicationFixture() {
  const f = await publicationFixture();
  const checkpoint = await recordPublicationCheckpoint(
    f.store,
    f.publicationInput,
    f.owner,
  );
  const input = {
    ...f.publicationInput,
    expectedSequence: checkpoint.sequence,
    expectedPriorDigest: checkpoint.digest,
    observedAt: "2026-10-07T00:03:00.000Z",
  };
  const observed = {
    ...f.owner,
    expectedSequence: checkpoint.sequence,
    expectedPriorDigest: checkpoint.digest,
    issuedAt: input.observedAt,
    controlsReport: JSON.stringify({
      ...JSON.parse(controlsReport),
      inspectedAt: input.observedAt,
    }),
  };
  const consumed = await recordPublicationCheckpoint(
    f.store,
    input,
    observed,
    true,
  );
  const head = await recordPublicationApproval(
    f.store,
    {
      ...input,
      expectedSequence: consumed.sequence,
      expectedPriorDigest: consumed.digest,
      observedAt: "2026-10-07T00:04:00.000Z",
    },
    {
      stageId: "stage-1",
      checkpointDigest: sha256(canonicalJson(consumed.checkpoint)),
      transactionRecordDigest: consumed.digest,
      state: "approved",
      approvedAt: "2026-10-07T00:04:00.000Z",
    },
  );
  return { ...f, head };
}

function syntheticRegistryAudit(f, change) {
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: "refs/tags/v0.1.0",
            repository: "https://github.com/Melbourneandrew/agentscope",
            path: ".github/workflows/release.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/Melbourneandrew/agentscope@refs/tags/v0.1.0",
            digest: { gitCommit: f.head.sourceRevision },
          },
        ],
      },
      runDetails: {
        metadata: {
          invocationId: `https://github.com/Melbourneandrew/agentscope/actions/runs/${f.head.stageRunId}/attempts/${f.head.stageRunAttempt}`,
        },
      },
    },
  };
  if (change === "provenance")
    statement.predicate.buildDefinition.externalParameters.workflow.ref =
      "refs/heads/main";
  const audit = {
    invalid: [],
    missing: [],
    verified: [
      {
        name: "agentscope-cli",
        version: "0.1.0",
        registry: "https://registry.npmjs.org/",
        attestationBundles: [
          {
            predicateType: statement.predicateType,
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement)).toString(
                  "base64",
                ),
              },
            },
          },
        ],
      },
    ],
  };
  return audit;
}

function syntheticRegistryChild(f, change = "none") {
  const calls = [];
  let root;
  const metadata = {
    name: "agentscope-cli",
    version: "0.1.0",
    bin: { agentscope: "./dist/bin/agentscope.js" },
    dist: {
      integrity: f.tuple.integrity,
      tarball:
        "https://registry.npmjs.org/agentscope-cli/-/agentscope-cli-0.1.0.tgz",
    },
  };
  const audit = syntheticRegistryAudit(f, change);
  const execFileImpl = (file, args, options, callback) => {
    calls.push([file, args]);
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
    expect(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(options.timeout).toBeGreaterThan(0);
    let output;
    if (args[0] === "--version") {
      root = options.cwd;
      output = "11.17.0\n";
    } else if (args[0] === "view")
      output = JSON.stringify(
        args[2] === "dist-tags"
          ? {
              ...f.head.checkpoint.distTags,
              alpha: change === "tags" ? "0.2.0" : "0.1.0",
            }
          : metadata,
      );
    else if (args[0] === "pack") {
      writeFileSync(
        join(root, "agentscope-cli-0.1.0.tgz"),
        readFileSync(f.candidate.tarballPath),
      );
      output = JSON.stringify([{ filename: "agentscope-cli-0.1.0.tgz" }]);
    } else if (args[0] === "install") {
      writeFileSync(
        join(root, "package-lock.json"),
        JSON.stringify({
          packages: {
            "node_modules/agentscope-cli": {
              version: "0.1.0",
              resolved: metadata.dist.tarball,
              integrity:
                change === "installed-integrity"
                  ? "other"
                  : metadata.dist.integrity,
            },
          },
        }),
      );
      output = "installed";
    } else if (args[0] === "audit") output = JSON.stringify(audit);
    else {
      expect(file).toBe(process.execPath);
      expect(args).toContain("--installed-package-root");
      output = JSON.stringify({
        schema: "agentscope.cli.installed-smoke.v1",
        scope: "packed-public-command-smoke",
        package: "agentscope-cli",
        version: "0.1.0",
        candidateDigest: f.tuple.tarballSha256,
        checkCount: 81,
      });
    }
    callback(null, Buffer.from(output), Buffer.alloc(0));
  };
  return { execFileImpl, calls, root: () => root };
}

test("registry composition uses standard npm verification and existing smoke in a credential-free owned root", async () => {
  const f = await approvedPublicationFixture();
  expect(Object.keys(f.candidate)).toEqual([
    "manifest",
    "certificationRecord",
    "tarballPath",
  ]);
  const child = syntheticRegistryChild(f);
  const result = await verifyRegistryPublication(
    f.head,
    f.candidate,
    performance.now() + 10_000,
    child,
  );
  expect(result.state).toBe("registry-and-installed-smoke-verified");
  expect(result.downloadedTarballSha256).toBe(f.tuple.tarballSha256);
  expect(result.transactionRecordDigest).toBe(f.head.digest);
  expect(child.calls.map((call) => call[1][0])).toEqual([
    "--version",
    "view",
    "view",
    "pack",
    "install",
    "audit",
    "--import",
  ]);
  expect(existsSync(child.root())).toBe(false);
});

test.each(["sourceRevision", "candidateManifestDigest"])(
  "actual three-field candidate refuses substituted authenticated head %s before a child",
  async (field) => {
    const f = await approvedPublicationFixture();
    const child = syntheticRegistryChild(f);
    const substituted = {
      ...f.head,
      [field]: field === "sourceRevision" ? "c".repeat(40) : hash,
    };
    await expect(
      verifyRegistryPublication(
        substituted,
        f.candidate,
        performance.now() + 10_000,
        child,
      ),
    ).rejects.toThrow();
    expect(child.calls).toHaveLength(0);
    expect(child.root()).toBeUndefined();
  },
);
test.each(["tags", "provenance", "installed-integrity"])(
  "registry %s substitution refuses and cleans exact owned root",
  async (kind) => {
    const f = await approvedPublicationFixture();
    const child = syntheticRegistryChild(f, kind);
    await expect(
      verifyRegistryPublication(
        f.head,
        f.candidate,
        performance.now() + 10_000,
        child,
      ),
    ).rejects.toThrow();
    expect(existsSync(child.root())).toBe(false);
    expect(
      child.calls.filter(([file]) => file === process.execPath),
    ).toHaveLength(0);
  },
);

async function continuationFixture() {
  const f = await approvedPublicationFixture();
  vi.setSystemTime(new Date("2026-10-07T00:05:00.000Z"));
  const result = await verifyRegistryPublication(
    f.head,
    f.candidate,
    performance.now() + 10_000,
    syntheticRegistryChild(f),
  );
  const input = {
    ...f.publicationInput,
    expectedSequence: f.head.sequence,
    expectedPriorDigest: f.head.digest,
    observedAt: "2026-10-07T00:05:00.000Z",
  };
  const packet = {
    ...result,
    runId: input.identity.runId,
    runAttempt: input.identity.runAttempt,
    ...input.executingDigests,
  };
  const controls = {
    issuedAt: input.observedAt,
    expiresAt: "2026-10-07T00:06:00.000Z",
    controlsReport: JSON.stringify({
      ...JSON.parse(controlsReport),
      inspectedAt: input.observedAt,
    }),
  };
  const publication = { calls: 0, attestations: 0, draft: true };
  f.store.protectedSource = async () => ({ tagObjectSha: "c".repeat(40) });
  f.store.assets = async () =>
    f.assets.map((asset) => ({ ...asset, state: "uploaded" }));
  f.store.release = async () => ({
    id: 7,
    draft: publication.draft,
    immutable: !publication.draft,
    prerelease: true,
    tag_name: "v0.1.0",
  });
  f.store.publishDraft = async () => {
    const last = JSON.parse(f.assets.at(-1).bytes.toString("utf8"));
    expect(last.transition).toBe("ready-to-publish");
    expect(last.releaseLedgerPath).toBe("release-records/releases/");
    expect(last.incidentLedgerPath).toBe("release-records/incidents/");
    publication.calls++;
    publication.draft = false;
    return { release: await f.store.release(7), uncertain: false };
  };
  f.store.verifyImmutableAttestation = async (releaseId, assets, tag) => {
    expect(releaseId).toBe(7);
    expect(tag).toBe("c".repeat(40));
    expect(assets).toHaveLength(f.assets.length);
    publication.attestations++;
    return hash;
  };
  f.store.verifyAttestationCapability = async () => hash;
  return { ...f, continuationInput: input, packet, controls, publication };
}

test("ready precedes one publish; immutable continuation never writes another asset or PATCH", async () => {
  const f = await continuationFixture();
  const result = await continuePublication(
    f.store,
    f.continuationInput,
    f.packet,
    f.controls,
  );
  expect(result.state).toBe("immutable-awaiting-reviewed-completion");
  expect(result.disposition).toBe(
    "awaiting-reviewed-append-under-release-records/releases",
  );
  expect(result.immutableAttestationDigest).toBe(hash);
  expect(f.publication.calls).toBe(1);
  const ready = await readLatestRecord(f.store, 7, true);
  const count = f.assets.length;
  const packet = { ...f.packet, transactionRecordDigest: ready.digest };
  await continuePublication(
    f.store,
    {
      ...f.continuationInput,
      expectedSequence: ready.sequence,
      expectedPriorDigest: ready.digest,
    },
    packet,
    f.controls,
  );
  expect(f.assets).toHaveLength(count);
  expect(f.publication.calls).toBe(1);
  expect(f.publication.attestations).toBe(2);
});

test("bootstrap refusal before draft creation cannot append candidate assets", async () => {
  const f = candidateFixture();
  const createDraft = vi.fn();
  const appendAsset = vi.fn();
  await expect(
    prepareDraft(
      {
        releases: async () => [],
        assertNoBootstrapTransaction: async () => {
          throw new Error("release.store.unresolved");
        },
        createDraft,
        appendAsset,
      },
      f,
    ),
  ).rejects.toThrow("release.store.unresolved");
  expect(createDraft).not.toHaveBeenCalled();
  expect(appendAsset).not.toHaveBeenCalled();
});

test("bootstrap appearing after initial checkpoint inspection refuses before append", async () => {
  const f = await publicationFixture();
  const count = f.assets.length;
  let checks = 0;
  f.store.assertNoBootstrapTransaction = async () => {
    if (++checks === 2) throw new Error("release.store.unresolved");
  };
  await expect(
    recordPublicationCheckpoint(f.store, f.publicationInput, f.owner),
  ).rejects.toThrow("release.store.unresolved");
  expect(checks).toBe(2);
  expect(f.assets).toHaveLength(count);
});

test("bootstrap refusal at the actual pre-stage boundary invokes no npm child", async () => {
  const f = await stageFixture();
  const child = vi.fn();
  f.store.assertNoBootstrapTransaction = async () => {
    throw new Error("release.store.unresolved");
  };
  await expect(
    stageRetainedCandidate(f.store, f.input, f.candidate, {
      execFileImpl: child,
    }),
  ).rejects.toThrow("release.store.unresolved");
  expect(child).not.toHaveBeenCalled();
});

test("fresh bootstrap refusal after durable ready preserves intent without PATCH", async () => {
  const f = await continuationFixture();
  f.store.assertNoBootstrapTransaction = async () => {
    const last = JSON.parse(f.assets.at(-1).bytes.toString("utf8"));
    if (last.transition === "ready-to-publish")
      throw new Error("release.store.unresolved");
  };
  await expect(
    continuePublication(f.store, f.continuationInput, f.packet, f.controls),
  ).rejects.toThrow("release.store.unresolved");
  expect((await readLatestRecord(f.store, 7)).transition).toBe(
    "ready-to-publish",
  );
  expect(f.publication.calls).toBe(0);
  expect(f.publication.attestations).toBe(0);
});

test.each(["run", "tuple", "controls", "assets"])(
  "continuation %s mismatch refuses before publication",
  async (kind) => {
    const f = await continuationFixture();
    const packet = { ...f.packet };
    const controls = { ...f.controls };
    if (kind === "run") packet.runId = 99;
    if (kind === "tuple") packet.downloadedTarballSha256 = hash;
    if (kind === "controls")
      controls.expiresAt = f.continuationInput.observedAt;
    if (kind === "assets")
      f.assets.push({
        id: 99,
        name: "extra.json",
        size: 2,
        digest: sha256("{}"),
        bytes: Buffer.from("{}"),
      });
    await expect(
      continuePublication(f.store, f.continuationInput, packet, controls),
    ).rejects.toThrow();
    expect(f.publication.calls).toBe(0);
  },
);
test("uncertain publish remains active without automatic retry or completion", async () => {
  const f = await continuationFixture();
  f.store.publishDraft = async () => {
    f.publication.calls++;
    return { release: await f.store.release(7), uncertain: true };
  };
  const result = await continuePublication(
    f.store,
    f.continuationInput,
    f.packet,
    f.controls,
  );
  expect(result.state).toBe("frozen-unresolved");
  expect(result.disposition).toBe("owner-reconciliation-required-no-retry");
  expect(f.publication.calls).toBe(1);
  expect(f.publication.attestations).toBe(0);
});

test("publication consumption is durable one-use before the separate interactive approval", async () => {
  const f = await publicationFixture();
  const checkpoint = await recordPublicationCheckpoint(
    f.store,
    f.publicationInput,
    f.owner,
  );
  expect(checkpoint.transition).toBe("publication-checkpoint");
  expect(checkpoint.checkpoint.state).toBe("valid-unconsumed");
  const input = {
    ...f.publicationInput,
    expectedSequence: checkpoint.sequence,
    expectedPriorDigest: checkpoint.digest,
    observedAt: "2026-10-07T00:03:00.000Z",
  };
  const observation = {
    ...f.owner,
    expectedSequence: checkpoint.sequence,
    expectedPriorDigest: checkpoint.digest,
    issuedAt: input.observedAt,
    controlsReport: JSON.stringify({
      ...JSON.parse(controlsReport),
      inspectedAt: input.observedAt,
    }),
  };
  const consumed = await recordPublicationCheckpoint(
    f.store,
    input,
    observation,
    true,
  );
  expect(consumed.checkpoint.expiresAt).toBe(f.owner.expiresAt);
  expect(consumed.checkpoint.state).toBe(
    "consumed-before-interactive-approval",
  );
  await expect(
    recordPublicationCheckpoint(f.store, input, observation, true),
  ).rejects.toThrow();
  const receipt = {
    stageId: "stage-1",
    checkpointDigest: sha256(canonicalJson(consumed.checkpoint)),
    transactionRecordDigest: consumed.digest,
    state: "approved",
    approvedAt: "2026-10-07T00:04:00.000Z",
  };
  const approved = await recordPublicationApproval(
    f.store,
    {
      ...input,
      expectedSequence: consumed.sequence,
      expectedPriorDigest: consumed.digest,
      observedAt: "2026-10-07T00:04:00.000Z",
    },
    receipt,
  );
  expect(approved.transition).toBe("approval-reported");
  expect(approved.approval.ownerIdentity).toBe("Melbourneandrew");
  expect(approved.tuple).toEqual(f.tuple);
});

test("an expired unconsumed checkpoint can be replaced without renewing consumed authority", async () => {
  const f = await publicationFixture();
  const first = await recordPublicationCheckpoint(
    f.store,
    f.publicationInput,
    f.owner,
  );
  const issuedAt = f.owner.expiresAt;
  const expiresAt = new Date(Date.parse(issuedAt) + 300_000).toISOString();
  const input = {
    ...f.publicationInput,
    expectedSequence: first.sequence,
    expectedPriorDigest: first.digest,
    observedAt: issuedAt,
  };
  const observation = {
    ...f.owner,
    expectedSequence: first.sequence,
    expectedPriorDigest: first.digest,
    issuedAt,
    expiresAt,
    distTags: { ...f.owner.distTags, historical: "0.0.0-bootstrap.0" },
    controlsReport: JSON.stringify({
      ...JSON.parse(controlsReport),
      inspectedAt: issuedAt,
    }),
  };
  const replacement = await recordPublicationCheckpoint(
    f.store,
    input,
    observation,
  );
  expect(replacement.sequence).toBe(first.sequence + 1);
  expect(replacement.previousDigest).toBe(first.digest);
  expect(replacement.checkpoint.expiresAt).toBe(expiresAt);
  expect(replacement.checkpoint.distTags.historical).toBe("0.0.0-bootstrap.0");
  const consumption = {
    ...input,
    expectedSequence: replacement.sequence,
    expectedPriorDigest: replacement.digest,
  };
  const current = {
    ...observation,
    expectedSequence: replacement.sequence,
    expectedPriorDigest: replacement.digest,
  };
  const consumed = await recordPublicationCheckpoint(
    f.store,
    consumption,
    current,
    true,
  );
  const count = f.assets.length;
  await expect(
    recordPublicationCheckpoint(
      f.store,
      {
        ...input,
        expectedSequence: consumed.sequence,
        expectedPriorDigest: consumed.digest,
      },
      {
        ...current,
        expectedSequence: consumed.sequence,
        expectedPriorDigest: consumed.digest,
      },
    ),
  ).rejects.toThrow();
  expect(f.assets).toHaveLength(count);
});

test("unsupported attestation tool refuses before ready bytes or publication", async () => {
  const f = await continuationFixture();
  const count = f.assets.length;
  f.store.verifyAttestationCapability = async () => {
    throw new Error("fixed-unavailable");
  };
  await expect(
    continuePublication(f.store, f.continuationInput, f.packet, f.controls),
  ).rejects.toThrow();
  expect(f.assets).toHaveLength(count);
  expect(f.publication.calls).toBe(0);
});

test.each(["draft", "unaccounted", "duplicate-tag"])(
  "a different %s release refuses before publication checkpoint",
  async (kind) => {
    const f = await publicationFixture();
    f.store.releases = async () => [
      { id: 7, draft: true, immutable: false, tag_name: "v0.1.0" },
      {
        id: 8,
        draft: kind === "draft",
        immutable: kind === "duplicate-tag",
        tag_name: kind === "duplicate-tag" ? "v0.1.0" : "v0.0.0-bootstrap.0",
      },
    ];
    const count = f.assets.length;
    await expect(
      recordPublicationCheckpoint(f.store, f.publicationInput, f.owner),
    ).rejects.toThrow();
    expect(f.assets).toHaveLength(count);
  },
);

test.each(["principal", "ref", "source", "workflow", "head", "expiry", "tags"])(
  "publication %s mismatch refuses before durable mutation",
  async (kind) => {
    const f = await publicationFixture();
    const input = { ...f.publicationInput };
    const owner = { ...f.owner, distTags: { ...f.owner.distTags } };
    if (kind === "principal") f.run.actor.id = 1;
    if (kind === "ref") f.run.head_branch = "main";
    if (kind === "source")
      input.identity = { ...input.identity, sourceRevision: "c".repeat(40) };
    if (kind === "workflow")
      input.executingDigests = {
        ...input.executingDigests,
        workflowDigest: `sha256:${"c".repeat(64)}`,
      };
    if (kind === "head") input.expectedPriorDigest = hash;
    if (kind === "expiry") input.observedAt = owner.expiresAt;
    if (kind === "tags") owner.distTags.latest = "0.1.0";
    const count = f.assets.length;
    await expect(
      recordPublicationCheckpoint(f.store, input, owner),
    ).rejects.toThrow();
    expect(f.assets).toHaveLength(count);
  },
);

test("registry install refuses a caller-supplied completed-stage label before any child", async () => {
  let calls = 0;
  await expect(
    verifyRegistryPublication(
      { transition: "stage-recorded" },
      {},
      performance.now() + 1000,
      {
        execFileImpl: () => {
          calls++;
        },
      },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("same-run durable intent stages the exact isolated bytes once then records fixed DTO", async () => {
  const f = await stageFixture();
  const calls = [];
  let isolated;
  const result = await stageRetainedCandidate(f.store, f.input, f.candidate, {
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      if (args[0] === "--version")
        return callback(null, Buffer.from("11.17.0\n"), Buffer.alloc(0));
      isolated = args[2];
      expect(isolated).not.toBe(f.candidate.tarballPath);
      expect(readFileSync(isolated)).toEqual(
        readFileSync(f.candidate.tarballPath),
      );
      callback(
        null,
        Buffer.from(
          JSON.stringify({
            "agentscope-cli": {
              name: "agentscope-cli",
              version: "0.1.0",
              id: "agentscope-cli@0.1.0",
              integrity: f.tuple.integrity,
              stageId: "stage-1",
            },
          }),
        ),
        Buffer.alloc(0),
      );
    },
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual([
    "stage",
    "publish",
    isolated,
    "--json",
    "--tag",
    "alpha",
    "--provenance",
    "--ignore-scripts",
    "--registry",
    "https://registry.npmjs.org",
  ]);
  expect(existsSync(isolated)).toBe(false);
  expect(result.response).toBe("received");
  const record = await recordStageFromJob(f.store, {
    releaseId: 7,
    intentDigest: f.intent.digest,
    identity: f.input.identity,
    executingDigests: f.input.executingDigests,
    stageResult: result,
    observedAt: "2026-10-07T01:00:00.000Z",
  });
  expect(record.transition).toBe("stage-recorded");
  await expect(
    stageRetainedCandidate(f.store, f.input, f.candidate),
  ).rejects.toThrow();
});

test.each([
  "attempt",
  "principal",
  "approval",
  "intent",
  "workflow",
  "expired",
  "bytes",
  "protected-source",
])("refuses detached %s before any npm acquisition", async (kind) => {
  const f = await stageFixture();
  if (kind === "attempt") f.input.identity.runAttempt = 2;
  if (kind === "principal") f.run.actor.id = 1;
  if (kind === "approval") f.approval.user.id = 1;
  if (kind === "intent") f.input.intentDigest = hash;
  if (kind === "workflow")
    f.input.executingDigests.workflowDigest = `sha256:${"c".repeat(64)}`;
  if (kind === "expired")
    vi.setSystemTime(new Date("2026-10-07T00:15:00.000Z"));
  if (kind === "bytes")
    writeFileSync(f.candidate.tarballPath, Buffer.from("drift"));
  if (kind === "protected-source")
    f.store.protectedSource = async () => {
      throw new Error("unprotected");
    };
  let calls = 0;
  await expect(
    stageRetainedCandidate(f.store, f.input, f.candidate, {
      execFileImpl: () => {
        calls++;
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("failed producer settlement cleans only its copy and missing output stays quarantined", async () => {
  const f = await stageFixture();
  let isolated;
  const result = await stageRetainedCandidate(f.store, f.input, f.candidate, {
    execFileImpl: (_file, args, _options, callback) => {
      if (args[0] === "--version")
        return callback(null, Buffer.from("11.17.0"), Buffer.alloc(0));
      isolated = args[2];
      callback(
        new Error("secret must not escape"),
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    },
  });
  expect(result.response).toBe("ambiguous");
  expect(existsSync(isolated)).toBe(false);
  expect(existsSync(f.candidate.tarballPath)).toBe(true);
  const recorded = await recordStageFromJob(f.store, {
    releaseId: 7,
    intentDigest: f.intent.digest,
    identity: f.input.identity,
    executingDigests: f.input.executingDigests,
    stageResult: {
      schemaVersion: 1,
      tuple: f.tuple,
      response: "missing",
      stageId: null,
    },
    observedAt: "2026-10-07T01:00:00.000Z",
  });
  expect(recorded.transition).toBe("quarantine-still-draft");
  expect(recorded.payload.terminal).toBe(false);
});

test("version acquisition cannot renew original checkpoint expiry", async () => {
  const f = await stageFixture();
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  f.input.deadline = 1_000_000;
  vi.setSystemTime(new Date("2026-10-07T00:14:59.000Z"));
  let calls = 0;
  await expect(
    stageRetainedCandidate(f.store, f.input, f.candidate, {
      execFileImpl: (_file, args, options, callback) => {
        calls++;
        expect(args).toEqual(["--version"]);
        expect(options.timeout).toBeLessThanOrEqual(1000);
        now = 1101;
        callback(null, Buffer.from("11.17.0"), Buffer.alloc(0));
      },
    }),
  ).rejects.toThrow("release.npm-stage.unavailable");
  expect(calls).toBe(1);
});

test.each(["principal", "attempt", "workflow", "stage-tuple"])(
  "recorder authenticates %s rather than trusting job result labels",
  async (kind) => {
    const f = await stageFixture();
    const input = {
      releaseId: 7,
      intentDigest: f.intent.digest,
      identity: f.input.identity,
      executingDigests: f.input.executingDigests,
      stageResult: {
        schemaVersion: 1,
        tuple: { ...f.tuple },
        response: "received",
        stageId: "stage-1",
      },
      observedAt: "2026-10-07T01:00:00.000Z",
    };
    if (kind === "principal") f.run.triggering_actor.id = 1;
    if (kind === "attempt") input.identity.runAttempt = 2;
    if (kind === "workflow")
      input.executingDigests.releaseScriptsDigest = `sha256:${"c".repeat(64)}`;
    if (kind === "stage-tuple") input.stageResult.tuple.transactionId = "other";
    const count = f.assets.length;
    await expect(recordStageFromJob(f.store, input)).rejects.toThrow();
    expect(f.assets).toHaveLength(count);
  },
);
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
    store: {
      run: async () => run,
      approvals: async () => [approval],
      // Synthetic store classification; actual tree acquisition is tested in
      // release-github-store.test.mjs, not minted by this fixture.
      assertNoBootstrapTransaction: async () => {},
    },
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
    assertNoBootstrapTransaction: async () => {},
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
test("rejects missing, conflicting and wrong-environment approval", async () => {
  for (const approvals of [
    [],
    [fixture().approval, { ...fixture().approval, state: "rejected" }],
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
test("two protected jobs accept repeated fixed-owner approvals, never foreign history", async () => {
  const f = await stageFixture();
  f.store.approvals = async () => [f.approval, { ...f.approval }];
  let calls = 0;
  const result = await stageRetainedCandidate(f.store, f.input, f.candidate, {
    execFileImpl: (_file, args, _options, callback) => {
      calls++;
      callback(
        null,
        Buffer.from(args[0] === "--version" ? "11.17.0" : ""),
        Buffer.alloc(0),
      );
    },
  });
  expect(calls).toBe(2);
  expect(result.response).toBe("missing");
  for (const extra of [
    { ...f.approval, user: { id: 1, login: "Melbourneandrew" } },
    { ...f.approval, state: "rejected" },
    { ...f.approval, environments: [{ id: 10, name: "npm-release" }] },
  ]) {
    f.store.approvals = async () => [f.approval, extra];
    await expect(
      stageRetainedCandidate(f.store, f.input, f.candidate, {
        execFileImpl: () => {
          calls++;
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
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

const packedFixtureManifest = (probeVersion) =>
  probeVersion
    ? { name: "agentscope-cli", version: probeVersion }
    : {
        name: "agentscope-cli",
        version: "0.1.0",
        bin: { agentscope: "./dist/bin/agentscope.js" },
        publishConfig: { access: "public" },
      };
function candidateFixture(probeVersion = null) {
  const root = mkdtempSync(join(tmpdir(), "agentscope-production-fixture-"));
  roots.push(root);
  const files = [
    {
      path: "package/package.json",
      content: JSON.stringify(packedFixtureManifest(probeVersion)),
    },
    {
      path: "package/dist/bin/agentscope.js",
      content: "#!/usr/bin/env node\n",
    },
  ];
  if (probeVersion) files.pop();
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

function probeReservation(material) {
  const unsigned = {
    schemaVersion: 1,
    kind: "reserved-inert-probe-invocation",
    repository: "Melbourneandrew/agentscope",
    workflowPath: ".github/workflows/release.yml",
    workflowDatabaseId: 12,
    expectedRunNumber: 102,
    runAttempt: 1,
    ownerId: 25971425,
    ownerLogin: "Melbourneandrew",
    version: material.version,
    preparationRunId: material.preparationRunId,
    preparationRunAttempt: material.preparationRunAttempt,
    preparationSourceRevision: material.sourceRevision,
    preparedMaterialDigest: sha256(canonicalJson(material)),
    tarballSha256: material.tarballSha256,
    integrity: material.integrity,
    workflowDigest: material.workflowDigest,
    releaseScriptsDigest: material.releaseScriptsDigest,
  };
  return { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
}
async function probeFixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(consumedAt));
  const f = fixture();
  const preparation = {
    ...f.run,
    id: 40,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  const tarballPath = candidateFixture("0.0.0-oidc-probe.40-1").tarballPath;
  const executingDigests = { workflowDigest: hash, releaseScriptsDigest: hash };
  const material = prepareProbeMaterial({
    tarballPath,
    runId: 40,
    runAttempt: 1,
    sourceRevision: f.input.sourceRevision,
    executingDigests,
  });
  const store = {
    ...f.store,
    run: async (id) => (id === 40 ? preparation : f.run),
    protectedMainSource: async () => {},
  };
  const invocationIntent = probeReservation(material);
  f.input.sourceRevision = "c".repeat(40);
  f.run.head_sha = f.input.sourceRevision;
  f.run.workflow_id = 12;
  f.run.run_number = 102;
  const observation = {
    phase: "pre-probe",
    sourceRevision: f.input.sourceRevision,
    candidateManifestDigest: sha256(canonicalJson(material)),
    issuedAt: "2026-10-07T00:00:00.000Z",
    expiresAt: "2026-10-07T00:15:00.000Z",
    controlsReport,
    pendingStagesState: "none-conflicting",
    probeVersionState: "never-staged",
  };
  const intent = await prepareProbeIntent(
    store,
    {
      identity: f.input,
      material,
      executingDigests,
      transactionId: "probe-40-1",
      invocationIntent,
    },
    observation,
    consumedAt,
  );
  const input = {
    identity: f.input,
    intent,
    intentDigest: intent.digest,
    executingDigests,
  };
  return {
    ...f,
    store,
    material,
    preparation,
    tarballPath,
    executingDigests,
    observation,
    intent,
    input,
    invocationIntent,
  };
}

test.each([
  "fresh-dispatch",
  "rerun",
  "workflow",
  "string-number",
  "string-workflow",
  "foreign-owner",
  "tampered-intent",
])(
  "reserved probe invocation refuses %s before the npm producer",
  async (kind) => {
    const f = await probeFixture();
    if (kind === "fresh-dispatch") {
      f.run.id = 43;
      f.run.run_number = 103;
      f.input.identity.runId = 43;
    }
    if (kind === "rerun") {
      f.run.run_attempt = 2;
      f.input.identity.runAttempt = 2;
    }
    if (kind === "workflow") f.run.workflow_id = 13;
    if (kind === "string-number") f.run.run_number = "102";
    if (kind === "string-workflow") f.run.workflow_id = "12";
    if (kind === "foreign-owner") f.run.actor.id = 1;
    if (kind === "tampered-intent")
      f.input.intent = {
        ...f.input.intent,
        invocationIntent: {
          ...f.input.intent.invocationIntent,
          expectedRunNumber: 103,
        },
      };
    let calls = 0;
    await expect(
      stageRetainedProbe(
        f.store,
        f.input,
        f.tarballPath,
        performance.now() + 10_000,
        {
          execFileImpl: () => {
            calls++;
          },
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  },
);

test("inert preparation shares the real producer/DTO without product tag or draft", async () => {
  const f = await probeFixture();
  let calls = 0,
    isolated;
  const result = await stageRetainedProbe(
    f.store,
    f.input,
    f.tarballPath,
    performance.now() + 10_000,
    {
      execFileImpl: (_file, args, _options, callback) => {
        calls++;
        if (args[0] === "--version")
          return callback(null, Buffer.from("11.17.0"), Buffer.alloc(0));
        isolated = args[2];
        expect(readFileSync(isolated)).toEqual(readFileSync(f.tarballPath));
        expect(args.slice(3)).toEqual([
          "--json",
          "--tag",
          "oidc-probe",
          "--provenance",
          "--ignore-scripts",
          "--registry",
          "https://registry.npmjs.org",
        ]);
        callback(
          null,
          Buffer.from(
            JSON.stringify({
              "agentscope-cli": {
                name: "agentscope-cli",
                version: f.material.version,
                id: `agentscope-cli@${f.material.version}`,
                integrity: f.material.integrity,
                stageId: "probe-stage-1",
              },
            }),
          ),
          Buffer.alloc(0),
        );
      },
    },
  );
  expect(calls).toBe(2);
  expect(existsSync(isolated)).toBe(false);
  expect(result.tuple.protectedTag).toBe(null);
  expect(f.intent).not.toHaveProperty("draftReleaseDatabaseId");
  const packet = await recordProbeStagePacket(
    f.store,
    f.input,
    result,
    "2026-10-07T01:00:00.000Z",
  );
  expect(packet.state).toBe("pending-owner-reconciliation");
  expect(packet.sourceRevision).toBe(f.input.identity.sourceRevision);
});

test.each([
  "preparation-run",
  "preparation-attempt",
  "preparation-branch",
  "preparation-conclusion",
  "code",
  "owner",
  "expired",
  "ever-staged",
  "pending",
])("probe refuses %s without invoking npm", async (kind) => {
  const f = await probeFixture();
  let calls = 0;
  if (kind === "preparation-run") f.preparation.id = 39;
  if (kind === "preparation-attempt") f.preparation.run_attempt = 2;
  if (kind === "preparation-branch") f.preparation.head_branch = "feature";
  if (kind === "preparation-conclusion") f.preparation.conclusion = "failure";
  if (kind === "code")
    f.input.executingDigests.releaseScriptsDigest = `sha256:${"c".repeat(64)}`;
  if (kind === "owner") f.run.actor.id = 1;
  if (kind === "expired")
    vi.setSystemTime(new Date("2026-10-07T00:15:00.000Z"));
  if (kind === "ever-staged" || kind === "pending") {
    const observation = {
      ...f.observation,
      ...(kind === "pending"
        ? { pendingStagesState: "unknown" }
        : { probeVersionState: "previously-staged" }),
    };
    await expect(
      prepareProbeIntent(
        f.store,
        {
          identity: f.input.identity,
          material: f.material,
          executingDigests: f.executingDigests,
          transactionId: "probe-40-1",
          invocationIntent: f.invocationIntent,
        },
        observation,
        consumedAt,
      ),
    ).rejects.toThrow();
  } else
    await expect(
      stageRetainedProbe(
        f.store,
        f.input,
        f.tarballPath,
        performance.now() + 10_000,
        {
          execFileImpl: () => {
            calls++;
          },
        },
      ),
    ).rejects.toThrow();
  expect(calls).toBe(0);
});

async function reconciledProbeFixture(response = "received") {
  const f = await probeFixture();
  const packet = await recordProbeStagePacket(f.store, f.input, {
    schemaVersion: 1,
    tuple: f.intent.tuple,
    response,
    stageId: response === "received" ? "probe-stage-1" : null,
  });
  const identity = {
    ...f.input.identity,
    runId: 44,
    sourceRevision: "d".repeat(40),
  };
  const current = { ...f.run, id: 44, head_sha: identity.sourceRevision };
  const original = f.run;
  f.store.run = async (id) =>
    id === 44 ? current : id === 40 ? f.preparation : original;
  const owner = {
    phase: "reconcile-probe",
    packetDigest: packet.digest,
    issuedAt: "2026-10-07T01:00:00.000Z",
    expiresAt: "2026-10-07T01:15:00.000Z",
    controlsReport: JSON.stringify({
      ...JSON.parse(controlsReport),
      inspectedAt: "2026-10-07T01:00:00.000Z",
    }),
    stageId: "probe-stage-1",
    downloadedTarballSha256: f.material.tarballSha256,
    downloadedIntegrity: f.material.integrity,
    downloadedInventoryDigest: f.material.inventoryDigest,
    terminalNpmState: "rejected",
  };
  return {
    ...f,
    current,
    original,
    owner,
    input: { identity, packet, executingDigests: f.executingDigests },
  };
}

test("owner rejection preserves actual earlier dispatch source across later main commits", async () => {
  const f = await reconciledProbeFixture();
  const observed = [];
  f.store.protectedMainSource = async (source) => observed.push(source);
  const manifest = await reconcileProbePacket(
    f.store,
    f.input,
    f.owner,
    "2026-10-07T01:01:00.000Z",
  );
  expect(manifest.sourceRevision).toBe("c".repeat(40));
  expect(manifest.material.sourceRevision).toBe("b".repeat(40));
  expect(manifest.invocationIntentDigest).toBe(
    f.intent.invocationIntent.digest,
  );
  expect(manifest.sourceRevision).not.toBe(f.input.identity.sourceRevision);
  expect(manifest.runId).toBe(42);
  expect(manifest.terminalNpmState).toBe("rejected");
  expect(manifest.disposition).toBe(
    "awaiting-reviewed-append-under-release-records/probes",
  );
  expect(observed).toContain("c".repeat(40));
});
test.each([
  "missing",
  "ambiguous",
  "stage",
  "download",
  "terminal",
  "expired",
  "code",
  "original-run",
  "original-attempt",
  "owner",
])(
  "owner reconciliation cannot manufacture rejection from %s",
  async (kind) => {
    const f = await reconciledProbeFixture(
      ["missing", "ambiguous"].includes(kind) ? kind : "received",
    );
    if (kind === "stage") f.owner.stageId = "other";
    if (kind === "download") f.owner.downloadedTarballSha256 = hash;
    if (kind === "terminal") f.owner.terminalNpmState = "approved";
    if (kind === "code")
      f.input.executingDigests.workflowDigest = `sha256:${"c".repeat(64)}`;
    if (kind === "original-run") f.original.head_sha = "d".repeat(40);
    if (kind === "original-attempt") f.original.run_attempt = 2;
    if (kind === "owner") f.current.actor.id = 1;
    const now =
      kind === "expired"
        ? "2026-10-07T01:16:00.000Z"
        : "2026-10-07T01:01:00.000Z";
    await expect(
      reconcileProbePacket(f.store, f.input, f.owner, now),
    ).rejects.toThrow();
  },
);
test("draft producer retains exact candidate and writes first record last, not admission", async () => {
  const fixture = candidateFixture();
  const names = [];
  const result = await prepareDraft(
    {
      assertNoBootstrapTransaction: async () => {},
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
      assertNoBootstrapTransaction: async () => {},
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
