import {
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  constants,
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  resolveContainedArtifactPath,
  verifyInertProbeTarball,
} from "./release-lane/candidate.mjs";
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
  prepareProbeMaterial,
  prepareProbeIntent,
  stageRetainedProbe,
  recordProbeStagePacket,
  reconcileProbePacket,
} from "./release-lane/production-recording.mjs";
import { sha256, canonicalJson } from "./release-lane/validation.mjs";
import { requireActualSemanticAdmission } from "./release-lane/admission.mjs";
import { validateStageResult } from "./release-lane/stage-result.mjs";
import {
  validateProbeMaterial,
  validateProbeStagePacket,
  validateProbeInvocationReservation,
} from "./release-lane/production-recorder.mjs";

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
  !["refs/tags/v0.1.0", "refs/heads/main"].includes(process.env.GITHUB_REF) ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "")
)
  fail();
// Semantic verification is nonprivileged. Administrative settings are inspected
// through the existing operator session and bound to the authenticated stage
// checkpoint; the read-only Actions token cannot inspect those settings.
if (process.argv[2] === "--verify-admission") process.exit(0);
const eventBytes = readBounded(process.env.GITHUB_EVENT_PATH, 65_536);
const event = JSON.parse(eventBytes.toString("utf8"));
const mode = process.argv[2];
if (!(
  process.argv.length === 2 ||
  (process.argv.length === 3 &&
    ["--stage", "--record-stage", "--prepare-probe", "--verify-probe"].includes(
      mode,
    ))
))
  fail();
const probeOperation = [
  "prepare-probe",
  "consume-probe",
  "reconcile-probe",
].includes(event.inputs.operation);
if (
  (probeOperation && process.env.GITHUB_REF !== "refs/heads/main") ||
  (!probeOperation && process.env.GITHUB_REF !== "refs/tags/v0.1.0")
)
  fail();
if (mode === "--prepare-probe" || mode === "--verify-probe") {
  if (
    !["prepare-probe", "consume-probe", "reconcile-probe"].includes(
      event.inputs.operation,
    ) ||
    (mode === "--prepare-probe" && event.inputs.operation !== "prepare-probe")
  )
    fail();
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  )
    fail();
  const version = `0.0.0-oidc-probe.${runId}-${runAttempt}`;
  if (mode === "--prepare-probe") {
    mkdirSync("artifacts/release-probe-source", { recursive: true });
    mkdirSync("artifacts/release-probe", { recursive: true });
    writeFileSync(
      "artifacts/release-probe-source/package.json",
      canonicalJson({
        name: "agentscope-cli",
        version,
        description:
          "Inert trusted-publisher probe; not the Agentscope product",
      }),
      { flag: "wx", mode: 0o600 },
    );
  } else {
    if (event.inputs.operation === "prepare-probe") {
      const tarballPath = resolveContainedArtifactPath(
        "artifacts/release-probe",
        `agentscope-cli-${version}.tgz`,
        "inert probe",
      );
      const material = prepareProbeMaterial({
        tarballPath,
        runId,
        runAttempt,
        sourceRevision: process.env.GITHUB_SHA,
        executingDigests: executingDigests(),
      });
      writeFileSync(
        "artifacts/release-probe/probe-material.json",
        canonicalJson(material),
        { flag: "wx", mode: 0o600 },
      );
    } else if (event.inputs.operation === "consume-probe") {
      const material = validateProbeMaterial(
        JSON.parse(
          readBounded(
            resolveContainedArtifactPath(
              "artifacts/release-probe",
              "probe-material.json",
              "probe material",
            ),
            16_384,
          ).toString("utf8"),
        ),
      );
      if (
        sha256(canonicalJson(material)) !==
          event.inputs["candidate-manifest-digest"] ||
        canonicalJson({
          workflowDigest: material.workflowDigest,
          releaseScriptsDigest: material.releaseScriptsDigest,
        }) !== canonicalJson(executingDigests())
      )
        fail();
      invocationReservation(material);
      verifyInertProbeTarball({
        tarballPath: resolveContainedArtifactPath(
          "artifacts/release-probe",
          material.tarballFilename,
          "inert probe",
        ),
        tuple: {
          kind: "probe",
          package: "agentscope-cli",
          version: material.version,
          distTag: "oidc-probe",
          protectedTag: null,
          tarballSha256: material.tarballSha256,
          integrity: material.integrity,
        },
      });
    } else {
      const supplied = JSON.parse(event.inputs["owner-observation"]);
      if (
        typeof supplied.probePacket !== "string" ||
        Buffer.byteLength(supplied.probePacket) > 8192
      )
        fail();
      retainedProbePacket(supplied.probePacket);
    }
  }
  process.exit(0);
}
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
if (probeOperation) await store.protectedMainSource(process.env.GITHUB_SHA);
else await store.protectedSource(process.env.GITHUB_SHA);
// GitHub supplies this authenticated event inside the protected job. Ordinary
// workstation files and owner labels do not satisfy the runner/API checks.
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
function invocationReservation(materialInput) {
  const material = validateProbeMaterial(materialInput);
  // Fixed version namespace from authenticated checked-out protected main.
  // Ordinary append-only review forbids amending/reissuing this reservation.
  const bytes = readBounded(
    resolveContainedArtifactPath(
      "release-records/probes",
      `${material.version}.intent.json`,
      "probe invocation reservation",
    ),
    16_384,
  );
  const record = validateProbeInvocationReservation(
    JSON.parse(bytes.toString("utf8")),
    material,
  );
  const canonical = canonicalJson(record);
  const encoded = bytes.toString("utf8");
  if (
    encoded !== `${canonical}\n` &&
    encoded !== `${JSON.stringify(JSON.parse(canonical), null, 2)}\n`
  )
    fail();
  return record;
}
function retainedProbePacket(encoded) {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 8192) fail();
  const now = new Date().toISOString();
  const supplied = validateProbeStagePacket(JSON.parse(encoded), now);
  const packet = validateProbeStagePacket(
    JSON.parse(
      readBounded(
        resolveContainedArtifactPath(
          "artifacts/reconciled-probe",
          "probe-stage-packet.json",
          "retained probe stage",
        ),
        16_384,
      ).toString("utf8"),
    ),
    now,
  );
  if (
    !/^[1-9][0-9]*$/u.test(event.inputs["candidate-run-id"] ?? "") ||
    Number(event.inputs["candidate-run-id"]) !== packet.runId ||
    canonicalJson(supplied) !== canonicalJson(packet) ||
    invocationReservation(packet.intent.material).digest !==
      packet.intent.invocationIntent.digest
  )
    fail();
  return packet;
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
const readProbe = (name) =>
  readBounded(
    resolveContainedArtifactPath(
      "artifacts/release-probe",
      name,
      "probe artifact",
    ),
    65_536,
  );
const probeMaterial = () =>
  JSON.parse(readProbe("probe-material.json").toString("utf8"));
function retainProbe(name, value) {
  mkdirSync("artifacts/retained-probe", { recursive: true });
  writeFileSync(`artifacts/retained-probe/${name}`, canonicalJson(value), {
    flag: "wx",
    mode: 0o600,
  });
}
function dependentStageOutput(tuple) {
  // Fixed needs output only, never an event input; uncertainty is not retry.
  const encoded = process.env.RELEASE_STAGE_RESULT ?? "";
  if (encoded && encoded.length <= 16_384) {
    try {
      const supplied = JSON.parse(encoded);
      validateStageResult(supplied, tuple);
      return supplied;
    } catch {
      /* Preserve uncertainty without inventing a stage identifier. */
    }
  }
  return {
    schemaVersion: 1,
    tuple,
    response: encoded ? "ambiguous" : "missing",
    stageId: null,
  };
}
if (probeOperation) {
  const executing = executingDigests();
  if (event.inputs.operation === "consume-probe") {
    if (!mode) {
      const material = probeMaterial();
      if (
        sha256(canonicalJson(material)) !==
        event.inputs["candidate-manifest-digest"]
      )
        fail();
      const intent = await prepareProbeIntent(
        store,
        {
          identity,
          material,
          executingDigests: executing,
          transactionId: event.inputs["transaction-id"],
          invocationIntent: invocationReservation(material),
        },
        JSON.parse(event.inputs["owner-observation"]),
      );
      retainProbe("probe-intent.json", intent);
      output("intent-digest", intent.digest);
    } else {
      const intent = JSON.parse(
        readBounded(
          resolveContainedArtifactPath(
            "artifacts/retained-probe",
            "probe-intent.json",
            "probe intent",
          ),
          16_384,
        ).toString("utf8"),
      );
      const input = {
        identity,
        intent,
        intentDigest: process.env.RELEASE_INTENT_DIGEST,
        executingDigests: executing,
      };
      if (
        invocationReservation(intent.material).digest !==
        intent.invocationIntent.digest
      )
        fail();
      if (mode === "--stage") {
        const result = await stageRetainedProbe(
          store,
          input,
          resolveContainedArtifactPath(
            "artifacts/release-probe",
            intent.material.tarballFilename,
            "inert probe",
          ),
          deadline,
        );
        output("stage-result", canonicalJson(result));
      } else if (mode === "--record-stage") {
        retainProbe(
          "probe-stage-packet.json",
          await recordProbeStagePacket(
            store,
            input,
            dependentStageOutput(intent.tuple),
          ),
        );
      } else fail();
    }
  } else if (event.inputs.operation === "reconcile-probe" && !mode) {
    // Owner inspection identifies the actual retained job packet; it cannot
    // replace its artifact provenance. Fixed API checks authenticate its run.
    const supplied = JSON.parse(event.inputs["owner-observation"]);
    if (
      typeof supplied.probePacket !== "string" ||
      Buffer.byteLength(supplied.probePacket) > 8192
    )
      fail();
    const packet = retainedProbePacket(supplied.probePacket);
    const report = { ...supplied };
    delete report.probePacket;
    retainProbe(
      "probe-terminal-manifest.json",
      await reconcileProbePacket(
        store,
        { identity, packet, executingDigests: executing },
        report,
      ),
    );
  } else fail();
  process.exit(0);
}
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
    await recordStageFromJob(store, {
      releaseId,
      intentDigest: process.env.RELEASE_INTENT_DIGEST,
      identity,
      executingDigests: executingDigests(),
      stageResult: dependentStageOutput(tuple),
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
