import {
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  constants,
} from "node:fs";
import { resolveContainedArtifactPath } from "./release-lane/candidate.mjs";
import { createGitHubReleaseStore } from "./release-lane/github-release-store.mjs";
import {
  prepareDraft,
  authenticateOwnerCheckpoint,
  prepareIntent,
  consumeIntent,
  readLatestRecord,
  bindIntentTuple,
} from "./release-lane/production-recording.mjs";
import { sha256, canonicalJson } from "./release-lane/validation.mjs";

// This entrypoint prepares durable candidate assets only. It has no npm/OIDC
// operation, and is not product-tag admission or permission to stage. Protected
// probe/control admission and the actual stage producer remain dependencies.
const fail = () => {
  throw new Error("release.recording.unresolved");
};
const deadline = performance.now() + 120_000;
function readBounded(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 0n ||
      before.size > BigInt(limit) ||
      performance.now() >= deadline
    )
      fail();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      bytes.length !== Number(before.size) ||
      !named.isFile() ||
      ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(
        (key) => before[key] !== after[key] || before[key] !== named[key],
      ) ||
      performance.now() >= deadline
    )
      fail();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
// Deliberate nonprivileged hard fence. candidate.mjs binds bytes and tuples;
// it does not implement semantic support/evidence admission or authenticate
// the external controls and rejected probe. rk8.6 owns that next verifier
// slice. Until it exists, neither verification nor live mutation may proceed.
function requireProductionAdmission() {
  throw new Error("release.admission.unimplemented");
}
requireProductionAdmission();
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== "Melbourneandrew/agentscope" ||
  process.env.GITHUB_REF !== "refs/tags/v0.1.0" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "")
)
  fail();
const store = createGitHubReleaseStore({
  token: process.env.GITHUB_TOKEN,
  deadline,
});
const run = await store.run(Number(process.env.GITHUB_RUN_ID));
if (
  run.head_sha !== process.env.GITHUB_SHA ||
  run.run_attempt !== Number(process.env.GITHUB_RUN_ATTEMPT) ||
  run.path !== ".github/workflows/release.yml" ||
  run.actor?.login !== process.env.GITHUB_ACTOR ||
  run.triggering_actor?.login !== process.env.GITHUB_TRIGGERING_ACTOR
)
  fail();
await store.protectedSource(process.env.GITHUB_SHA);
// GitHub supplies this authenticated event inside the protected job. Ordinary
// workstation files and owner labels do not satisfy the runner/API checks.
const eventBytes = readBounded(process.env.GITHUB_EVENT_PATH, 65_536);
const event = JSON.parse(eventBytes.toString("utf8"));
if (event.sender?.login !== run.actor.login) fail();
if (event.inputs.operation === "consume-intent") {
  const releaseId = Number(event.inputs["release-id"]);
  const head = await readLatestRecord(store, releaseId);
  const supplied = JSON.parse(event.inputs["owner-observation"]);
  const checkpoint = await authenticateOwnerCheckpoint(
    store,
    {
      runId: run.id,
      runAttempt: run.run_attempt,
      sourceRevision: run.head_sha,
      owner: run.actor.login,
      environmentId: Number(event.inputs["environment-id"]),
    },
    supplied,
  );
  const tuple = JSON.parse(event.inputs["stage-tuple"]);
  tuple.ownerCheckpointDigest = sha256(canonicalJson(checkpoint));
  const scriptPaths = [
    "scripts/record-release-stage.mjs",
    "scripts/release-lane/production-recording.mjs",
    "scripts/release-lane/github-release-store.mjs",
    "scripts/release-lane/production-recorder.mjs",
    "scripts/release-lane/stage-result.mjs",
    "scripts/release-lane/candidate.mjs",
    "scripts/release-lane/validation.mjs",
    "apps/cli/scripts/publish-manifest-contract.mjs",
  ];
  const bound = await bindIntentTuple(store, head, tuple, {
    workflowDigest: sha256(
      readBounded(".github/workflows/release.yml", 65_536),
    ),
    releaseScriptsDigest: sha256(
      canonicalJson(
        scriptPaths.map((path) => ({
          path,
          digest: sha256(readBounded(path, 131_072)),
        })),
      ),
    ),
  });
  const intent = prepareIntent(
    {
      tuple: bound,
      head: {
        schemaVersion: head.schemaVersion,
        sequence: head.sequence,
        digest: head.digest,
        transition: head.transition,
        transactionId: head.transactionId,
        draftReleaseDatabaseId: head.draftReleaseDatabaseId,
        candidateManifestDigest: head.candidateManifestDigest,
        sourceRevision: head.sourceRevision,
        kind: head.kind,
      },
      expectedSequence: Number(event.inputs["expected-sequence"]),
      expectedPriorDigest: event.inputs["expected-prior-digest"],
      consumedAt: supplied.consumedAt,
    },
    checkpoint,
  );
  const result = await consumeIntent(store, intent, head);
  process.stdout.write(
    `${canonicalJson({ state: result.state, intentDigest: intent.digest })}\n`,
  );
  process.exit(0);
}
if (event.inputs.operation !== "prepare-draft") fail();
const root = "artifacts/release-candidate";
const read = (name) =>
  readBounded(
    resolveContainedArtifactPath(root, name, "release artifact"),
    2_097_152,
  );
const manifest = JSON.parse(read("candidate-manifest.json").toString("utf8"));
const certificationRecord = JSON.parse(
  read("certification-record.json").toString("utf8"),
);
const result = await prepareDraft(store, {
  manifest,
  certificationRecord,
  tarballPath: resolveContainedArtifactPath(
    root,
    "agentscope-cli-0.1.0.tgz",
    "candidate",
  ),
  expectedManifestDigest: process.env.CANDIDATE_MANIFEST_DIGEST,
  expectedSourceRevision: process.env.GITHUB_SHA,
  expectedProtectedTag: "v0.1.0",
  transactionId: process.env.RELEASE_TRANSACTION_ID,
  authenticatedActor: run.actor.login,
  retainedAssets: [
    "checksum-manifest.json",
    "support-admission.json",
    "sbom.json",
    "attestations.json",
    "evidence-index.json",
  ].map((name) => {
    const bytes = read(name);
    return { name, bytes, digest: sha256(bytes) };
  }),
});
process.stdout.write(
  `${canonicalJson({ state: result.state, releaseId: result.releaseId, recordDigest: result.record.digest })}\n`,
);
