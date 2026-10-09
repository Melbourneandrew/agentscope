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
  readdirSync,
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
  recordPublicationCheckpoint,
  recordPublicationApproval,
  readPublicationForVerification,
  verifyRegistryPublication,
  continuePublication,
} from "./release-lane/production-recording.mjs";
import { sha256, canonicalJson } from "./release-lane/validation.mjs";
import {
  requireActualSemanticAdmission,
  parseAdmissionDocument,
  bindIntegrationArtifacts,
  bindScenarioEvidence,
} from "./release-lane/admission.mjs";
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
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== "Melbourneandrew/agentscope" ||
  !["refs/tags/v0.1.0", "refs/heads/main"].includes(process.env.GITHUB_REF) ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "")
)
  fail();
async function admissionMetadata(path) {
  const remaining = deadline - performance.now();
  if (remaining <= 0 || !process.env.GITHUB_TOKEN) fail();
  const response = await fetch(
    `https://api.github.com/repos/Melbourneandrew/agentscope/${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.floor(remaining))),
    },
  );
  if (response.status !== 200 || !response.body) fail();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1_048_576 || performance.now() >= deadline) fail();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function prepareAdmission() {
  const event = parseAdmissionDocument(
    readBounded(process.env.GITHUB_EVENT_PATH, 65_536),
  );
  const idText = event.inputs?.["candidate-run-id"];
  if (typeof idText !== "string" || !/^[1-9][0-9]{0,15}$/u.test(idText)) fail();
  const id = Number(idText);
  if (!Number.isSafeInteger(id) || id < 1) fail();
  const runBytes = await admissionMetadata(`actions/runs/${id}`);
  const run = parseAdmissionDocument(runBytes);
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) fail();
  const jobs = await admissionMetadata(
    `actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  const artifacts = await admissionMetadata(
    `actions/runs/${id}/artifacts?per_page=100`,
  );
  const selected = bindIntegrationArtifacts(
    runBytes,
    jobs,
    artifacts,
    id,
    process.env.GITHUB_SHA,
  );
  const current = parseAdmissionDocument(
    await admissionMetadata(`actions/runs/${id}`),
  );
  if (
    current.run_attempt !== selected.runAttempt ||
    current.status !== "completed" ||
    current.conclusion !== "success" ||
    current.head_sha !== process.env.GITHUB_SHA
  )
    fail();
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `candidate-artifact-id=${selected.candidateArtifactId}\nscenario-artifact-id=${selected.scenarioArtifactId}\n`,
  );
}
function admissionInventory(root, allowed, prefix = "", count = { value: 0 }) {
  const directory = `${root}${prefix ? `/${prefix}` : ""}`;
  if (
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  )
    fail();
  const files = [];
  for (const name of readdirSync(directory)) {
    if (
      ++count.value > 512 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(name)
    )
      fail();
    const path = prefix ? `${prefix}/${name}` : name;
    const status = lstatSync(`${root}/${path}`);
    if (
      status.isDirectory() &&
      !status.isSymbolicLink() &&
      path.split("/").length < 4
    )
      files.push(...admissionInventory(root, allowed, path, count));
    else if (status.isFile() && !status.isSymbolicLink() && allowed(path))
      files.push(path);
    else fail();
  }
  return files.sort();
}
function readAdmissionCandidate() {
  const root = "artifacts/semantic-candidate";
  const pointer = parseAdmissionDocument(
    readBounded(`${root}/current-candidate.json`, 16_384),
  );
  if (
    pointer.pointerVersion !== 1 ||
    !/^sha256-[a-f0-9]{64}$/u.test(pointer.bundleIdentity) ||
    pointer.candidateRevision !== process.env.GITHUB_SHA
  )
    fail();
  const candidateRoot = `${root}/candidates/${pointer.bundleIdentity}`;
  const preparedBytes = readBounded(
    `${candidateRoot}/evidence.json`,
    1_048_576,
  );
  const prepared = parseAdmissionDocument(preparedBytes);
  if (
    prepared.bundleIdentity !== pointer.bundleIdentity ||
    !Array.isArray(prepared.artifacts)
  )
    fail();
  const expected = [
    "current-candidate.json",
    `candidates/${pointer.bundleIdentity}/evidence.json`,
  ];
  // Standard release role bytes are beside the prepared runtime inventory,
  // never runtime rows or a different candidate bundle preimage.
  for (const name of ["sbom", "attestations"]) {
    const path = `cli-release-materials/${name}.json`;
    readBounded(`${root}/${path}`, 2_097_152);
    expected.push(path);
  }
  let total = 0;
  for (const file of [prepared.lockfile, ...prepared.artifacts]) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(file?.fileName) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      (total += file.bytes) > 268_435_456
    )
      fail();
    const path = `candidates/${pointer.bundleIdentity}/files/${file.fileName}`;
    const bytes = readBounded(`${root}/${path}`, file.bytes);
    if (
      bytes.length !== file.bytes ||
      sha256(bytes).replace("sha256:", "sha256-") !== file.sha256
    )
      fail();
    expected.push(path);
  }
  if (
    canonicalJson(
      admissionInventory(root, (path) => expected.includes(path)),
    ) !== canonicalJson(expected.sort())
  )
    fail();
  return preparedBytes;
}
function verifyAdmission() {
  const preparedBytes = readAdmissionCandidate();
  const semanticRoot = "artifacts/semantic-scenarios";
  const files = admissionInventory(
    semanticRoot,
    (path) =>
      path === "harness-support-evidence.json" ||
      path === "certification/replay-1.json" ||
      /^runs\/[a-f0-9]{16}\/(?:evidence|harness-observation|model-ledger|destination-ledger|fixture-lifecycle)\.json$/u.test(
        path,
      ),
  );
  const supportBytes = readBounded(
    `${semanticRoot}/harness-support-evidence.json`,
    1_048_576,
  );
  const support = parseAdmissionDocument(supportBytes);
  if (!Array.isArray(support.entries) || support.entries.length > 32) fail();
  const catalogBytes = readBounded(
    "tests/integration/capability-manifest.json",
    1_048_576,
  );
  const catalog = parseAdmissionDocument(catalogBytes);
  const accepted = [];
  for (const entry of support.entries) {
    const family = {
      "@agentscope/harness-codex": "codex",
      "@agentscope/harness-claude-code": "claude-code",
    }[entry.harnessType];
    if (!family) fail();
    const runId = entry.binding?.seed?.runId;
    if (!/^[a-f0-9]{16}$/u.test(runId)) fail();
    const read = (name) => {
      const path = `runs/${runId}/${name}.json`;
      if (!files.includes(path)) fail();
      return readBounded(`${semanticRoot}/${path}`, 1_048_576);
    };
    const scenarios = catalog.scenarios?.filter(
      (row) => row.scenarioId === entry.binding?.seed?.scenarioId,
    );
    const evidence = catalog.evidence?.filter(
      (row) => row.evidenceId === scenarios?.[0]?.harnessEvidenceId,
    );
    if (
      scenarios?.length !== 1 ||
      evidence?.length !== 1 ||
      !evidence[0].admission
    )
      fail();
    const component = evidence[0].admission.component;
    const componentBytes = (role) => {
      const path = component?.[role]?.path;
      if (
        typeof path !== "string" ||
        !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/u.test(path) ||
        path.split("/").some((part) => part === "." || part === "..")
      )
        fail();
      return readBounded(path, 1_048_576);
    };
    accepted.push(
      bindScenarioEvidence(
        preparedBytes,
        supportBytes,
        Object.fromEntries(
          [
            "evidence",
            "fixture-lifecycle",
            "model-ledger",
            "destination-ledger",
            "harness-observation",
          ].map((name) => [`${name}.json`, read(name)]),
        ),
        family,
        {
          catalogBytes,
          fixtureBytes: componentBytes("fixture"),
          adapterBytes: componentBytes("adapterArtifact"),
          mappingBytes: componentBytes("mappingArtifact"),
        },
      ),
    );
  }
  return requireActualSemanticAdmission(accepted);
}
if (process.argv.length === 3 && process.argv[2] === "--prepare-admission") {
  await prepareAdmission();
  process.exit(0);
}
if (process.argv.length === 3 && process.argv[2] === "--verify-admission") {
  verifyAdmission();
  process.exit(0);
}
// Acquiring read-only artifact metadata does not grant publication authority.
// All existing protected modes still stop before token/store mutation.
requireActualSemanticAdmission();
// Semantic verification is nonprivileged. Administrative settings are inspected
// through the existing operator session and bound to the authenticated stage
// checkpoint; the read-only Actions token cannot inspect those settings.
const eventBytes = readBounded(process.env.GITHUB_EVENT_PATH, 65_536);
const event = JSON.parse(eventBytes.toString("utf8"));
const mode = process.argv[2];
if (!(
  process.argv.length === 2 ||
  (process.argv.length === 3 &&
    [
      "--stage",
      "--record-stage",
      "--prepare-probe",
      "--verify-probe",
      "--verify-publication",
    ].includes(mode))
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
    "apps/cli/scripts/verify-installed-smoke.ts",
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
const publicationOperation = [
  "prepare-publication",
  "consume-publication",
  "record-approval",
  "continue-publication",
].includes(event.inputs.operation);
if (publicationOperation) {
  const input = {
    identity,
    releaseId: Number(event.inputs["release-id"]),
    expectedSequence: Number(event.inputs["expected-sequence"]),
    expectedPriorDigest: event.inputs["expected-prior-digest"],
    executingDigests: executingDigests(),
    observedAt: new Date().toISOString(),
  };
  const owner = JSON.parse(event.inputs["owner-observation"]);
  if (mode === "--verify-publication") {
    if (event.inputs.operation !== "continue-publication") fail();
    const verificationInput = { ...input };
    delete verificationInput.observedAt;
    const head = await readPublicationForVerification(store, verificationInput);
    const packet = await verifyRegistryPublication(head, candidate(), deadline);
    output(
      "registry-result",
      canonicalJson({
        ...packet,
        runId: identity.runId,
        runAttempt: identity.runAttempt,
        ...input.executingDigests,
      }),
    );
  } else if (mode) fail();
  else if (event.inputs.operation === "continue-publication") {
    // Only fixed needs.verify-publication output, never event owner JSON,
    // carries the credential-free registry/install acquisition result.
    const encoded = process.env.RELEASE_REGISTRY_RESULT;
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 16_384)
      fail();
    const result = await continuePublication(
      store,
      input,
      JSON.parse(encoded),
      owner,
    );
    retainProbe("release-completion-manifest.json", result);
  } else {
    const record =
      event.inputs.operation === "record-approval"
        ? await recordPublicationApproval(store, input, owner)
        : await recordPublicationCheckpoint(
            store,
            input,
            owner,
            event.inputs.operation === "consume-publication",
          );
    output("publication-record-digest", record.digest);
  }
  process.exit(0);
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
