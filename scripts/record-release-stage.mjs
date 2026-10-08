import {
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  constants,
  appendFileSync,
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
  stageRetainedCandidate,
  recordStageFromJob,
} from "./release-lane/production-recording.mjs";
import { sha256, canonicalJson } from "./release-lane/validation.mjs";
import { requireActualSemanticAdmission } from "./release-lane/admission.mjs";
import { validateStageResult } from "./release-lane/stage-result.mjs";

// Product composition remains disabled until actual semantic admission exists.
// Separate protected jobs own the stage OIDC and recorder GitHub permissions.
const fail = () => {
  throw new Error("release.recording.unresolved");
};
// Recorder DTOs admit safe integers only; rounding down never renews the bound.
const deadline = Math.floor(performance.now() + 120_000);
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
// The actual OTLP semantic producer is still absent. Do not substitute a
// successful job, digest or caller certification label for that prerequisite.
// rk8.6 consumes the reviewed producer when available; no live entry meanwhile.
requireActualSemanticAdmission();
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== "Melbourneandrew/agentscope" ||
  process.env.GITHUB_REF !== "refs/tags/v0.1.0" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "")
)
  fail();
// Semantic verification is nonprivileged. Administrative settings are inspected
// through the existing operator session and bound to the authenticated stage
// checkpoint; the read-only Actions token cannot inspect those settings.
if (process.argv[2] === "--verify-admission") process.exit(0);
const mode = process.argv[2];
if (!(
  process.argv.length === 2 ||
  (process.argv.length === 3 && ["--stage", "--record-stage"].includes(mode))
))
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
const identity = {
  runId: run.id,
  runAttempt: run.run_attempt,
  sourceRevision: run.head_sha,
  owner: run.actor.login,
  environmentId: Number(event.inputs["environment-id"]),
};
function executingDigests() {
  const scriptPaths = [
    "scripts/record-release-stage.mjs",
    "scripts/release-lane/production-recording.mjs",
    "scripts/release-lane/github-release-store.mjs",
    "scripts/release-lane/production-recorder.mjs",
    "scripts/release-lane/stage-result.mjs",
    "scripts/release-lane/npm-stage-producer.mjs",
    "scripts/release-lane/candidate.mjs",
    "scripts/release-lane/validation.mjs",
    "scripts/release-lane/admission.mjs",
    "scripts/release-lane/operator-controls.mjs",
    "scripts/release-lane/release-controls.mjs",
    "apps/cli/scripts/publish-manifest-contract.mjs",
  ];
  return {
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
  };
}
function output(name, value) {
  if (
    !process.env.GITHUB_OUTPUT ||
    typeof value !== "string" ||
    /[\r\n]/u.test(value) ||
    value.length > 16_384
  )
    fail();
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
const root = "artifacts/release-candidate";
const read = (name) =>
  readBounded(
    resolveContainedArtifactPath(root, name, "release artifact"),
    2_097_152,
  );
const candidate = () => ({
  manifest: JSON.parse(read("candidate-manifest.json").toString("utf8")),
  certificationRecord: JSON.parse(
    read("certification-record.json").toString("utf8"),
  ),
  tarballPath: resolveContainedArtifactPath(
    root,
    "agentscope-cli-0.1.0.tgz",
    "candidate",
  ),
});
if (mode) {
  if (
    event.inputs.operation !== "consume-intent" ||
    !/^sha256:[a-f0-9]{64}$/u.test(process.env.RELEASE_INTENT_DIGEST ?? "")
  )
    fail();
  const releaseId = Number(event.inputs["release-id"]);
  if (mode === "--stage") {
    const result = await stageRetainedCandidate(
      store,
      {
        releaseId,
        intentDigest: process.env.RELEASE_INTENT_DIGEST,
        identity,
        executingDigests: executingDigests(),
        deadline,
      },
      candidate(),
    );
    output("stage-result", canonicalJson(result));
  } else {
    // This value is wired only from the fixed dependent stage job, never from
    // an event input. A failed/absent producer stays missing and quarantined.
    const intent = await readLatestRecord(store, releaseId);
    const tuple = await bindIntentTuple(
      store,
      intent,
      intent.tuple,
      executingDigests(),
    );
    const encoded = process.env.RELEASE_STAGE_RESULT ?? "";
    let result = {
      schemaVersion: 1,
      tuple,
      response: encoded ? "ambiguous" : "missing",
      stageId: null,
    };
    if (encoded && encoded.length <= 16_384) {
      try {
        const supplied = JSON.parse(encoded);
        validateStageResult(supplied, tuple);
        result = supplied;
      } catch {
        // Malformed fixed job output is uncertainty, never an invented stage ID
        // or a request to execute another mutation.
      }
    }
    await recordStageFromJob(store, {
      releaseId,
      intentDigest: process.env.RELEASE_INTENT_DIGEST,
      identity,
      executingDigests: executingDigests(),
      stageResult: result,
      observedAt: new Date().toISOString(),
    });
  }
  process.exit(0);
}
if (event.inputs.operation === "consume-intent") {
  const releaseId = Number(event.inputs["release-id"]);
  const head = await readLatestRecord(store, releaseId);
  const supplied = JSON.parse(event.inputs["owner-observation"]);
  const checkpoint = await authenticateOwnerCheckpoint(
    store,
    identity,
    supplied,
  );
  const tuple = JSON.parse(event.inputs["stage-tuple"]);
  tuple.ownerCheckpointDigest = sha256(canonicalJson(checkpoint));
  const bound = await bindIntentTuple(store, head, tuple, executingDigests());
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
      consumedAt: checkpoint.consumedAt,
    },
    checkpoint,
  );
  const result = await consumeIntent(store, intent, head);
  output("intent-digest", intent.digest);
  process.stdout.write(
    `${canonicalJson({ state: result.state, intentDigest: intent.digest })}\n`,
  );
  process.exit(0);
}
if (event.inputs.operation !== "prepare-draft") fail();
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
