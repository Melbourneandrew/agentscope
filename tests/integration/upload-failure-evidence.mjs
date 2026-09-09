import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileCapabilityManifest,
  compileIsolationEvidence,
} from "./dist/index.js";
import {
  prepareGithubSystemdSupervision,
  runSupervisedProcess,
  systemdToolFailureStage,
} from "./supervisor.mjs";
import { DefaultArtifactClient } from "@actions/artifact";

const MAXIMUM_BYTES = 1024 * 1024;
const ARTIFACT_PATCH_SHA256 =
  "9638aca3637f07d89c766e49c1719eb2f58a20b1165da4962ea755e9032c392b";
const PATCHED_ARTIFACT_FILES = Object.freeze({
  "path-and-artifact-name-validation.js":
    "6ce71a90c3abefd252265b4bad1dc38fe3980014d11fca8a240596615d99a6d4",
  "stream.js":
    "5eeaefb718a18cc6ac399c3433348d84e1c26af50d3c3defbb92cf05d988f96a",
  "upload-artifact.js":
    "f4936f8c7119371f65f08d7bce855458ea6c9476febfa56a0e289a454bb5427e",
  "zip.js": "4bd1967f092499689cd0e26d116a3ad1a138dc27ac2d87adb2493697a3ac2adc",
});
const ARTIFACT_ENTRY_SHA256 =
  "767d73362f34cc323231b614434fa93967110fdd7a7aa807b1a1d2b03a572cd0";
const ARTIFACT_PACKAGE_SHA256 =
  "e21bb31fa8424754cd03c72278d78a76e50429895a9cb2babf69b4a7ba8f533a";
const fail = () => {
  throw new Error("integration.controller.failure-evidence-upload");
};
const parseUnsigned = (value, maximum) => {
  if (!/^(?:0|[1-9]\d*)$/u.test(value ?? "")) fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) fail();
  return parsed;
};
const parseDeadline = (value) => {
  if (!/^[1-9]\d{0,18}$/u.test(value ?? "")) fail();
  const parsed = BigInt(value);
  if (parsed > 2n ** 63n - 1n) fail();
  return parsed;
};
const exactArguments = (arguments_) => {
  if (arguments_.length !== 12) fail();
  const expected = [
    "--fd",
    "--size",
    "--digest",
    "--name",
    "--deadline",
    "--python",
  ];
  const values = {};
  for (let index = 0; index < expected.length; index += 1) {
    if (arguments_[index * 2] !== expected[index]) fail();
    values[expected[index].slice(2)] = arguments_[index * 2 + 1];
  }
  return values;
};
const processStartTicks = () => {
  const content = Buffer.alloc(4097);
  const descriptor = openSync(
    "/proc/self/stat",
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const count = readSync(descriptor, content, 0, content.length, 0);
    if (count < 1 || count > 4096) fail();
    const record = content.subarray(0, count).toString("ascii");
    const close = record.lastIndexOf(") ");
    const fields = record
      .slice(close + 2)
      .trim()
      .split(" ");
    if (close < 2 || fields.length < 20 || !/^[1-9]\d*$/u.test(fields[19]))
      fail();
    return fields[19];
  } finally {
    closeSync(descriptor);
  }
};
const readExact = (descriptor, size) => {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, content, offset, size - offset, offset);
    if (count < 1) fail();
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (readSync(descriptor, extra, 0, 1, size) !== 0) fail();
  return content;
};
const closedClient = (client) => {
  const uploadArtifact = client.uploadArtifact;
  if (typeof uploadArtifact !== "function") fail();
  return Object.freeze({ uploadArtifact: uploadArtifact.bind(client) });
};
const verifyRegularDigest = (path, expected, maximum) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      status.size < 1 ||
      status.size > maximum
    )
      fail();
    const content = readFileSync(descriptor);
    if (
      content.length !== status.size ||
      createHash("sha256").update(content).digest("hex") !== expected
    )
      fail();
  } finally {
    closeSync(descriptor);
  }
};
const resolveArtifactClientEntry = (workspace) => {
  const packageRoot = realpathSync(
    resolve(workspace, "tests/integration/node_modules/@actions/artifact"),
  );
  if (
    !packageRoot.includes("/@actions+artifact@6.2.1_patch_hash=") ||
    !packageRoot.endsWith("/node_modules/@actions/artifact")
  )
    fail();
  verifyRegularDigest(
    resolve(packageRoot, "package.json"),
    ARTIFACT_PACKAGE_SHA256,
    64 * 1024,
  );
  const entry = resolve(packageRoot, "lib/artifact.js");
  verifyRegularDigest(entry, ARTIFACT_ENTRY_SHA256, 64 * 1024);
  const uploadRoot = resolve(packageRoot, "lib/internal/upload");
  for (const [name, digest] of Object.entries(PATCHED_ARTIFACT_FILES))
    verifyRegularDigest(resolve(uploadRoot, name), digest, 64 * 1024);
};
const verifyArtifactClientProvenance = () => {
  if (
    typeof process.env.ACTIONS_RESULTS_URL !== "string" ||
    typeof process.env.ACTIONS_RUNTIME_TOKEN !== "string" ||
    process.env.GITHUB_SERVER_URL !== "https://github.com" ||
    typeof process.env.GITHUB_WORKSPACE !== "string"
  )
    fail();
  const workspace = process.env.GITHUB_WORKSPACE;
  if (typeof workspace !== "string" || !workspace.startsWith("/")) fail();
  verifyRegularDigest(
    resolve(workspace, "patches/@actions__artifact@6.2.1.patch"),
    ARTIFACT_PATCH_SHA256,
    64 * 1024,
  );
  resolveArtifactClientEntry(workspace);
};

const uploadFailureEvidenceImplementation = async ({
  arguments_,
  client,
  nowNanoseconds,
  probe,
  startTicks = processStartTicks,
}) => {
  const values = exactArguments(arguments_);
  const descriptor = parseUnsigned(values.fd, 2 ** 20);
  const size = parseUnsigned(values.size, MAXIMUM_BYTES);
  const deadline = parseDeadline(values.deadline);
  const admission = nowNanoseconds();
  if (
    deadline <= admission ||
    deadline > admission + 20n * 60n * 1_000_000_000n
  )
    fail();
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(values.digest) ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(values.name) ||
    !values.python.startsWith("/")
  )
    fail();
  const status = fstatSync(descriptor);
  if (
    !status.isFile() ||
    status.size !== size ||
    (status.mode & 0o7777) !== 0o400
  )
    fail();
  const content = readExact(descriptor, size);
  if (
    `sha256:${createHash("sha256").update(content).digest("hex")}` !==
    values.digest
  )
    fail();
  const start = startTicks();
  await probe([
    values.python,
    "probe",
    String(process.pid),
    String(descriptor),
    String(size),
    values.digest,
    start,
  ]);
  const authority = closedClient(client);
  const response = await authority.uploadArtifact(
    values.name,
    [`/proc/self/fd/${descriptor}`],
    "/proc/self/fd",
    Object.freeze({ compressionLevel: 0, retentionDays: 7 }),
  );
  if (deadline <= nowNanoseconds()) fail();
  await probe([
    values.python,
    "probe",
    String(process.pid),
    String(descriptor),
    String(size),
    values.digest,
    start,
  ]);
  if (
    !Number.isSafeInteger(response.id) ||
    response.id < 1 ||
    !Number.isSafeInteger(response.size) ||
    response.size < 1 ||
    !/^[a-f0-9]{64}$/u.test(response.digest ?? "")
  )
    fail();
  return Object.freeze({
    artifactDigest: `sha256:${response.digest}`,
    artifactId: response.id,
    artifactSize: response.size,
    status: "uploaded",
  });
};

export const uploadFailureEvidence = async (options) => {
  try {
    return await uploadFailureEvidenceImplementation(options);
  } catch {
    fail();
  }
};

const authenticateActionInvocation = () => {
  let resultsUrl;
  try {
    resultsUrl = new URL(process.env.ACTIONS_RESULTS_URL ?? "");
  } catch {
    fail();
  }
  if (
    process.argv.length !== 2 ||
    process.env.GITHUB_ACTIONS !== "true" ||
    typeof process.env.GITHUB_ACTION_PATH !== "string" ||
    realpathSync(process.env.GITHUB_ACTION_PATH) !==
      realpathSync(import.meta.dirname) ||
    process.env.GITHUB_SERVER_URL !== "https://github.com" ||
    typeof process.env.GITHUB_WORKSPACE !== "string" ||
    realpathSync(process.env.GITHUB_WORKSPACE) !== realpathSync(".") ||
    resultsUrl.protocol !== "https:" ||
    resultsUrl.username !== "" ||
    resultsUrl.password !== "" ||
    resultsUrl.port !== "" ||
    !resultsUrl.hostname.endsWith(".actions.githubusercontent.com") ||
    resultsUrl.search !== "" ||
    resultsUrl.hash !== "" ||
    typeof process.env.ACTIONS_RUNTIME_TOKEN !== "string" ||
    process.env.ACTIONS_RUNTIME_TOKEN.length < 1 ||
    process.env.ACTIONS_RUNTIME_TOKEN.length > 16_384 ||
    /[^\x21-\x7e]/u.test(process.env.ACTIONS_RUNTIME_TOKEN) ||
    !new Set(["integration-0-of-1-1", "integration-0-of-1-2"]).has(
      process.env.AGENTSCOPE_FAILURE_ARTIFACT_NAME,
    )
  )
    fail();
};

/* eslint-disable complexity, max-lines-per-function -- This closed verifier deliberately keeps the complete evidence grammar in the credential-bearing action process. */
export const finalizeFailureEvidence = async ({
  bundleDescriptor,
  client,
  sealerSource,
}) => {
  const fail = () => {
    throw new Error("integration.controller.failure-evidence");
  };
  const exactKeys = (value, keys) =>
    typeof value === "object" &&
    value !== null &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort());
  const authenticatedDescriptors = [];
  const ptyFailurePredicates = {
    "candidate-inventory": ["candidate-rejected"],
    "immutable-candidate": ["authority-rejected"],
    "installed-cli": [
      "bin-authority",
      "cli-authority",
      "cli-boundary",
      "driver-input",
      "execution-rejected",
      "interpreter-authority",
      "package-authority",
      "package-manifest",
      "receipt-rejected",
    ],
    "pty-receipt": ["receipt-rejected"],
    "runner-bootstrap": ["runner-rejected"],
  };
  const installedContractFailurePredicates = {
    "aggregate-evaluation": ["evaluation-rejected"],
    "artifact-install": [
      "candidate-rejected",
      "egress-rejected",
      "install-rejected",
      "manifest-rejected",
      "plan-rejected",
      "toolchain-rejected",
    ],
    "case-execution": [
      "narrow-help-rejected",
      "setup-rejected",
      "state-rejected",
      "testkit.headless.aborted",
      "testkit.headless.backend.receipt",
      "testkit.headless.capability",
      "testkit.headless.kernel.failure",
      "testkit.headless.kernel.options",
      "testkit.headless.kernel.request",
      "testkit.headless.kernel.spawn",
      "testkit.headless.observer.identity",
      "testkit.headless.observer.read",
      "testkit.headless.observer.reap",
      "testkit.headless.observer.root",
      "testkit.headless.observer.signal",
      "testkit.headless.reconciliation.deadline",
      "testkit.headless.startup.deadline",
      "testkit.pty.immutable-candidate",
    ],
    "receipt-finalization": ["receipt-rejected"],
  };
  const installedContractCaseCount = 123;
  const installedContractInventorySha256 =
    "sha256:dae8f0a435924f6c33b338281b4b59c4f3ef6c5a540ab105366b50bf62b1a90a";
  const validPtyFailure = (value) =>
    value === null ||
    (exactKeys(value, ["phase", "predicate", "receiptVersion"]) &&
      value.receiptVersion === 1 &&
      Object.hasOwn(ptyFailurePredicates, value.phase) &&
      ptyFailurePredicates[value.phase].includes(value.predicate)) ||
    (exactKeys(
      value,
      value?.phase === "case-execution"
        ? [
            "caseOrdinal",
            "contractInventorySha256",
            "phase",
            "predicate",
            "receiptVersion",
          ]
        : ["phase", "predicate", "receiptVersion"],
    ) &&
      value.receiptVersion === 1 &&
      Object.hasOwn(installedContractFailurePredicates, value.phase) &&
      installedContractFailurePredicates[value.phase].includes(
        value.predicate,
      ) &&
      (value.phase !== "case-execution" ||
        (Number.isSafeInteger(value.caseOrdinal) &&
          value.caseOrdinal >= 0 &&
          value.caseOrdinal < installedContractCaseCount &&
          value.contractInventorySha256 === installedContractInventorySha256)));
  const readBounded = (path, maximumBytes, expectedMode = 0o600) => {
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(descriptor);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size < 1 ||
        before.size > maximumBytes ||
        (before.mode & 0o7777) !== expectedMode
      )
        fail();
      const content = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.nlink !== before.nlink
      )
        fail();
      authenticatedDescriptors.push({ descriptor, path, status: before });
      descriptor = undefined;
      return { content, status: before };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
  const artifactsRoot = resolve("artifacts/integration");
  const runsRoot = resolve(artifactsRoot, "runs");
  const manifestPath = resolve(
    artifactsRoot,
    "controller-failure-manifest.json",
  );
  const terminalPath = resolve(
    artifactsRoot,
    "controller-failure-terminal.json",
  );
  const manifestPresent = existsSync(manifestPath);
  const terminalPresent = existsSync(terminalPath);
  if (!manifestPresent && !terminalPresent) fail();
  if (terminalPresent) {
    const terminal = JSON.parse(
      readBounded(terminalPath, 4096).content.toString("utf8"),
    );
    const terminalPredicates = {
      "require-evidence": ["authority-rejected"],
      "finalize-run": [
        "retained-evidence-unavailable",
        "run-finalization-rejected",
      ],
      "publish-manifest": ["manifest-publication-rejected"],
    };
    if (
      !exactKeys(terminal, [
        "controllerFailureTerminalVersion",
        "predicate",
        "stage",
      ]) ||
      terminal.controllerFailureTerminalVersion !== 1 ||
      !Object.hasOwn(terminalPredicates, terminal.stage) ||
      !terminalPredicates[terminal.stage].includes(terminal.predicate) ||
      (manifestPresent && terminal.stage !== "publish-manifest")
    )
      fail();
    for (const { descriptor } of authenticatedDescriptors.splice(0))
      closeSync(descriptor);
    process.stdout.write(
      `${JSON.stringify({
        predicate: terminal.predicate,
        stage: terminal.stage,
      })}\n`,
    );
    process.exit(1);
  }
  const manifestBytes = readBounded(manifestPath, 65_536).content;
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    !exactKeys(manifest, [
      "controllerAuthorityDigest",
      "controllerFailureManifestVersion",
      "failureEvidence",
      "retainedInputs",
      "runIds",
    ]) ||
    manifest.controllerFailureManifestVersion !== 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.controllerAuthorityDigest) ||
    !Array.isArray(manifest.runIds) ||
    !Array.isArray(manifest.failureEvidence) ||
    manifest.runIds.length < 1 ||
    manifest.runIds.length > 256 ||
    new Set(manifest.runIds).size !== manifest.runIds.length ||
    JSON.stringify(manifest.runIds) !==
      JSON.stringify([...manifest.runIds].sort()) ||
    manifest.failureEvidence.length !== manifest.runIds.length
  )
    fail();
  const verifyDigests = (value, expectedNames, root, mode) => {
    if (!exactKeys(value, expectedNames)) fail();
    const parsed = {};
    for (const name of expectedNames) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(value[name])) fail();
      const retained = readBounded(resolve(root, name), 1024 * 1024, mode);
      if (
        `sha256:${createHash("sha256").update(retained.content).digest("hex")}` !==
        value[name]
      )
        fail();
      parsed[name] = JSON.parse(retained.content.toString("utf8"));
    }
    return parsed;
  };
  if (
    !exactKeys(manifest.retainedInputs, [
      "capability-manifest.json",
      "current-candidate.json",
      "current-images.json",
      "current-model-routes.json",
      "current-selection.json",
    ])
  )
    fail();
  const retainedInputs = {
    ...verifyDigests(
      Object.fromEntries(
        Object.entries(manifest.retainedInputs).filter(
          ([name]) =>
            name !== "capability-manifest.json" &&
            name !== "current-images.json",
        ),
      ),
      [
        "current-candidate.json",
        "current-model-routes.json",
        "current-selection.json",
      ],
      artifactsRoot,
      0o644,
    ),
    ...verifyDigests(
      { "current-images.json": manifest.retainedInputs["current-images.json"] },
      ["current-images.json"],
      artifactsRoot,
      0o600,
    ),
  };
  const retainedManifest = verifyDigests(
    {
      "capability-manifest.json":
        manifest.retainedInputs["capability-manifest.json"],
    },
    ["capability-manifest.json"],
    "tests/integration",
    0o644,
  );
  const candidate = retainedInputs["current-candidate.json"];
  const images = retainedInputs["current-images.json"];
  const routes = retainedInputs["current-model-routes.json"];
  const selection = retainedInputs["current-selection.json"];
  const capability = retainedManifest["capability-manifest.json"];
  try {
    compileCapabilityManifest(capability);
  } catch {
    fail();
  }
  if (
    !exactKeys(candidate, [
      "bundleIdentity",
      "candidateRevision",
      "pointerVersion",
    ]) ||
    candidate.pointerVersion !== 1 ||
    !/^sha256-[a-f0-9]{64}$/u.test(candidate.bundleIdentity) ||
    !/^[a-f0-9]{40,64}$/u.test(candidate.candidateRevision) ||
    !exactKeys(capability, [
      "evidence",
      "manifestIdentity",
      "manifestVersion",
      "requiredRepresentativeIds",
      "scenarios",
    ]) ||
    capability.manifestVersion !== 1 ||
    !/^sha256-[a-f0-9]{64}$/u.test(capability.manifestIdentity) ||
    !Array.isArray(capability.evidence) ||
    !Array.isArray(capability.scenarios) ||
    !exactKeys(selection, [
      "manifestIdentity",
      "scenarioIds",
      "selectionMode",
      "selectionVersion",
      "selector",
    ]) ||
    selection.selectionVersion !== 2 ||
    selection.manifestIdentity !== capability.manifestIdentity ||
    !Array.isArray(selection.scenarioIds) ||
    !exactKeys(routes, [
      "mockServerInitialization",
      "routeFixtureVersion",
      "routeIds",
      "routes",
    ]) ||
    routes.routeFixtureVersion !== 1 ||
    !Array.isArray(routes.routeIds) ||
    !Array.isArray(routes.routes) ||
    !Array.isArray(routes.mockServerInitialization) ||
    !exactKeys(images, [
      "dockerDaemon",
      "dockerSocket",
      "imageEvidenceVersion",
      "images",
      "manifestIdentity",
      "preparationPolicy",
      "terminalCleanup",
    ]) ||
    images.imageEvidenceVersion !== 2 ||
    images.manifestIdentity !== capability.manifestIdentity ||
    !Array.isArray(images.images)
  )
    fail();
  const validLedger = (value) =>
    (exactKeys(value, ["status"]) && value.status === "uncertain") ||
    (exactKeys(value, ["entriesSha256", "entryCount", "overflow", "status"]) &&
      value.status === "authenticated" &&
      Number.isSafeInteger(value.entryCount) &&
      value.entryCount >= 0 &&
      value.entryCount <= 4096 &&
      typeof value.overflow === "boolean" &&
      /^sha256:[a-f0-9]{64}$/u.test(value.entriesSha256));
  const samePreparedIdentity = (prepared, retained) =>
    prepared !== undefined &&
    exactKeys(retained, [
      "configDigest",
      "image",
      "manifestDigest",
      "platform",
    ]) &&
    retained.image === prepared.image &&
    retained.configDigest === prepared.configDigest &&
    retained.manifestDigest === prepared.manifestDigest &&
    JSON.stringify(retained.platform) === JSON.stringify(prepared.platform);
  const expected = new Set(manifest.runIds);
  const observed = [];
  const sanitizedRuns = [];
  for (const identity of manifest.failureEvidence) {
    if (
      !exactKeys(identity, ["dev", "digest", "ino", "runId", "size"]) ||
      !expected.has(identity.runId) ||
      !/^[a-f0-9]{16}$/u.test(identity.runId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.digest) ||
      !Number.isSafeInteger(identity.dev) ||
      !Number.isSafeInteger(identity.ino) ||
      !Number.isSafeInteger(identity.size)
    )
      fail();
    const path = resolve(runsRoot, identity.runId, "controller-failure.json");
    const { content, status } = readBounded(path, 16_384);
    const record = JSON.parse(content.toString("utf8"));
    if (
      status.dev !== identity.dev ||
      status.ino !== identity.ino ||
      status.size !== identity.size ||
      `sha256:${createHash("sha256").update(content).digest("hex")}` !==
        identity.digest ||
      !exactKeys(record, [
        "cleanupFailure",
        "controllerFailureEvidenceVersion",
        "controllerOutcome",
        "installedPtyFailure",
        "primaryFailure",
        "privateCleanup",
        "retainedEvidence",
        "runId",
        "scenarioFailure",
        "scenarioSecondaryFailures",
        "scenarioOutcome",
      ]) ||
      record.controllerFailureEvidenceVersion !== 2 ||
      record.runId !== identity.runId ||
      record.controllerOutcome !== "retired-failure" ||
      !validPtyFailure(record.installedPtyFailure) ||
      !/^integration\.[a-z.-]{1,96}$/u.test(record.primaryFailure) ||
      !(
        record.scenarioFailure === null ||
        /^integration\.[a-z.-]{1,96}$/u.test(record.scenarioFailure)
      ) ||
      !Array.isArray(record.scenarioSecondaryFailures) ||
      record.scenarioSecondaryFailures.length > 2 ||
      new Set(record.scenarioSecondaryFailures).size !==
        record.scenarioSecondaryFailures.length ||
      record.scenarioSecondaryFailures.some(
        (failure) =>
          !/^integration\.isolation\.(?:cleanup|evidence)$/u.test(failure),
      ) ||
      !(
        record.cleanupFailure === null ||
        /^integration\.[a-z.-]{1,96}$/u.test(record.cleanupFailure)
      ) ||
      !["passed", "failed", "interrupted", "not-complete"].includes(
        record.scenarioOutcome,
      )
    )
      fail();
    const retained = verifyDigests(
      record.retainedEvidence,
      [
        "destination-ledger.json",
        "evidence.json",
        "fixture-lifecycle.json",
        "model-ledger.json",
      ],
      resolve(runsRoot, identity.runId),
      0o600,
    );
    const evidence = retained["evidence.json"];
    const lifecycle = retained["fixture-lifecycle.json"];
    const modelLedger = retained["model-ledger.json"];
    const destinationLedger = retained["destination-ledger.json"];
    try {
      compileIsolationEvidence(evidence, {
        baseImageIdentity: evidence.baseImageIdentity,
        mockServerImageIdentity: evidence.mockServerImageIdentity,
        installedCliContractEvidence: evidence.installedCliContractEvidence,
      });
    } catch {
      fail();
    }
    if (
      !exactKeys(evidence, [
        "baseImage",
        "baseImageIdentity",
        "builtImageDigest",
        "builtMockServerImageDigest",
        "candidateBundleIdentity",
        "candidateRevision",
        "cleanup",
        "evidenceVersion",
        "executionPolicy",
        "headlessTerminalReceipt",
        "hostMountCount",
        "installedCliContractEvidence",
        "manifestIdentity",
        "mockServerImage",
        "mockServerImageIdentity",
        "networkMode",
        "outcome",
        "readOnlyRootFilesystem",
        "runId",
        "scenarioId",
        "tmpfsMounts",
      ]) ||
      evidence.evidenceVersion !== 2 ||
      evidence.runId !== record.runId ||
      evidence.manifestIdentity !== capability.manifestIdentity ||
      evidence.candidateBundleIdentity !== candidate.bundleIdentity ||
      evidence.candidateRevision !== candidate.candidateRevision ||
      evidence.outcome !== record.scenarioOutcome ||
      !validLedger(modelLedger) ||
      !exactKeys(destinationLedger, ["ingestion", "retrieval"]) ||
      !validLedger(destinationLedger.ingestion) ||
      !validLedger(destinationLedger.retrieval) ||
      !exactKeys(
        lifecycle,
        lifecycle.resultStatus === "unavailable"
          ? [
              "evidenceVersion",
              "ledgerObservation",
              "resultStatus",
              "scenarioId",
            ]
          : [
              "artifactFileName",
              "eventKinds",
              "evidenceVersion",
              "ledgerObservation",
              "lifecycle",
              "resultStatus",
              "scenarioId",
            ],
      ) ||
      lifecycle.evidenceVersion !== 1 ||
      lifecycle.scenarioId !== evidence.scenarioId ||
      !exactKeys(lifecycle.ledgerObservation, [
        "ingestion",
        "model",
        "retrieval",
      ]) ||
      !["authenticated", "uncertain"].includes(
        lifecycle.ledgerObservation.model,
      ) ||
      !["authenticated", "uncertain"].includes(
        lifecycle.ledgerObservation.ingestion,
      ) ||
      !["authenticated", "uncertain"].includes(
        lifecycle.ledgerObservation.retrieval,
      )
    )
      fail();
    const preparedBase = images.images.find(
      (image) => image.image === evidence.baseImage,
    );
    const preparedMock = images.images.find(
      (image) => image.image === evidence.mockServerImage,
    );
    const declaredScenario = capability.scenarios.find(
      (scenario) => scenario.scenarioId === evidence.scenarioId,
    );
    const cleanupComplete =
      exactKeys(evidence.cleanup, [
        "outcome",
        "remaining",
        "removalFailureCount",
      ]) &&
      evidence.cleanup.outcome === "complete" &&
      evidence.cleanup.removalFailureCount === 0 &&
      exactKeys(evidence.cleanup.remaining, [
        "activeRunMarkers",
        "buildContexts",
        "containers",
        "images",
        "networks",
        "volumes",
      ]) &&
      Object.values(evidence.cleanup.remaining).every((count) => count === 0);
    const terminalComplete =
      evidence.headlessTerminalReceipt !== null &&
      evidence.headlessTerminalReceipt.outcome === "exited" &&
      evidence.headlessTerminalReceipt.exitCode === 0 &&
      evidence.headlessTerminalReceipt.signal === null &&
      evidence.headlessTerminalReceipt.cleanup === "clean" &&
      evidence.headlessTerminalReceipt.residualProcessCount === 0 &&
      evidence.headlessTerminalReceipt.processJoined === true &&
      evidence.headlessTerminalReceipt.stdinJoined === true &&
      evidence.headlessTerminalReceipt.stdoutJoined === true &&
      evidence.headlessTerminalReceipt.stderrJoined === true;
    const lifecycleComplete =
      lifecycle.resultStatus === "complete" &&
      /^agentscope-cli(?:-[0-9.]+)?\.tgz$/u.test(lifecycle.artifactFileName) &&
      JSON.stringify(lifecycle.lifecycle) ===
        JSON.stringify([
          "install",
          "configure",
          "hook",
          "execute",
          "export",
          "retrieve",
          "uninstall",
        ]) &&
      Array.isArray(lifecycle.eventKinds) &&
      lifecycle.eventKinds.length > 0 &&
      lifecycle.eventKinds.length <= 32 &&
      new Set(lifecycle.eventKinds).size === lifecycle.eventKinds.length &&
      lifecycle.eventKinds.every((kind) =>
        /^[a-z][a-z0-9-]{0,63}$/u.test(kind),
      );
    if (
      !selection.scenarioIds.includes(evidence.scenarioId) ||
      declaredScenario === undefined ||
      declaredScenario.image !== evidence.baseImage ||
      declaredScenario.mockServerImage !== evidence.mockServerImage ||
      !Array.isArray(declaredScenario.modelRoutes) ||
      declaredScenario.modelRoutes.some(
        (route) => !routes.routeIds.includes(route),
      ) ||
      !samePreparedIdentity(preparedBase, evidence.baseImageIdentity) ||
      !samePreparedIdentity(preparedMock, evidence.mockServerImageIdentity) ||
      (lifecycle.ledgerObservation.model === "authenticated") !==
        (modelLedger.status === "authenticated") ||
      (lifecycle.ledgerObservation.ingestion === "authenticated") !==
        (destinationLedger.ingestion.status === "authenticated") ||
      (lifecycle.ledgerObservation.retrieval === "authenticated") !==
        (destinationLedger.retrieval.status === "authenticated") ||
      record.scenarioOutcome === "not-complete" ||
      (evidence.outcome === "interrupted" &&
        record.primaryFailure !== "integration.isolation.interrupted" &&
        record.scenarioFailure !== "integration.isolation.interrupted") ||
      (evidence.outcome === "passed" &&
        (!cleanupComplete ||
          !terminalComplete ||
          evidence.installedCliContractEvidence === null ||
          evidence.builtImageDigest === null ||
          evidence.builtMockServerImageDigest === null ||
          !lifecycleComplete ||
          modelLedger.status !== "authenticated" ||
          modelLedger.overflow !== false ||
          destinationLedger.ingestion.status !== "authenticated" ||
          destinationLedger.ingestion.overflow !== false ||
          destinationLedger.retrieval.status !== "authenticated" ||
          destinationLedger.retrieval.overflow !== false))
    )
      fail();
    sanitizedRuns.push({
      cleanupFailure: record.cleanupFailure,
      controllerOutcome: record.controllerOutcome,
      evidence: {
        baseImageIdentityDigest: `sha256:${createHash("sha256").update(JSON.stringify(evidence.baseImageIdentity)).digest("hex")}`,
        candidateBundleIdentity: evidence.candidateBundleIdentity,
        candidateRevision: evidence.candidateRevision,
        cleanupOutcome: evidence.cleanup.outcome,
        manifestIdentity: evidence.manifestIdentity,
        mockServerImageIdentityDigest: `sha256:${createHash("sha256").update(JSON.stringify(evidence.mockServerImageIdentity)).digest("hex")}`,
        outcome: evidence.outcome,
        runId: evidence.runId,
        scenarioId: evidence.scenarioId,
      },
      installedPtyFailure: record.installedPtyFailure,
      ledger: { destination: destinationLedger, model: modelLedger },
      lifecycle: {
        ledgerObservation: lifecycle.ledgerObservation,
        resultStatus: lifecycle.resultStatus,
      },
      primaryFailure: record.primaryFailure,
      runId: record.runId,
      scenarioFailure: record.scenarioFailure,
      scenarioSecondaryFailures: record.scenarioSecondaryFailures,
    });
    observed.push(identity.runId);
  }
  if (
    new Set(observed).size !== expected.size ||
    observed.some((runId) => !expected.has(runId))
  )
    fail();
  const runDirectories = readdirSync(runsRoot, { withFileTypes: true });
  if (
    runDirectories.length !== expected.size ||
    runDirectories.some((entry) => {
      if (!entry.isDirectory() || !expected.has(entry.name)) return true;
      const status = lstatSync(resolve(runsRoot, entry.name));
      return !status.isDirectory() || status.isSymbolicLink();
    })
  )
    fail();
  const bundle = Buffer.from(
    `${JSON.stringify({
      bundleVersion: 1,
      controllerAuthorityDigest: manifest.controllerAuthorityDigest,
      preparedInput: {
        candidate,
        images: {
          imageEvidenceVersion: images.imageEvidenceVersion,
          images: images.images,
          manifestIdentity: images.manifestIdentity,
        },
        manifest: capability,
        routes: {
          routeFixtureVersion: routes.routeFixtureVersion,
          routeIds: routes.routeIds,
        },
        selection,
      },
      retainedInputs: manifest.retainedInputs,
      runs: sanitizedRuns.sort((left, right) =>
        left.runId.localeCompare(right.runId),
      ),
    })}\n`,
  );
  if (bundle.byteLength < 1 || bundle.byteLength > 1024 * 1024) fail();
  const bundleDigest = `sha256:${createHash("sha256").update(bundle).digest("hex")}`;
  const deadline =
    process.env.AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS;
  if (!/^[1-9]\d{0,15}$/u.test(deadline ?? "")) fail();
  const deadlineNanoseconds = (BigInt(deadline) * 1_000_000n).toString();
  const artifactName = process.env.AGENTSCOPE_FAILURE_ARTIFACT_NAME;
  let resultsUrl;
  try {
    resultsUrl = new URL(process.env.ACTIONS_RESULTS_URL);
  } catch {
    fail();
  }
  if (
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(artifactName ?? "") ||
    process.env.GITHUB_SERVER_URL !== "https://github.com" ||
    typeof process.env.GITHUB_WORKSPACE !== "string" ||
    !process.env.GITHUB_WORKSPACE.startsWith("/") ||
    !/^[A-Za-z0-9._-]{1,16384}$/u.test(
      process.env.ACTIONS_RUNTIME_TOKEN ?? "",
    ) ||
    resultsUrl.protocol !== "https:" ||
    !resultsUrl.hostname.endsWith(".actions.githubusercontent.com") ||
    resultsUrl.username !== "" ||
    resultsUrl.password !== "" ||
    resultsUrl.port !== "" ||
    resultsUrl.hash !== ""
  )
    fail();
  const remainingMilliseconds = Number(
    BigInt(deadline) - process.hrtime.bigint() / 1_000_000n,
  );
  if (
    !Number.isSafeInteger(remainingMilliseconds) ||
    remainingMilliseconds < 1 ||
    remainingMilliseconds > 1_200_000
  )
    fail();
  if (
    !Number.isSafeInteger(bundleDescriptor) ||
    bundleDescriptor < 3 ||
    !Buffer.isBuffer(sealerSource)
  )
    fail();
  const written = writeSync(bundleDescriptor, bundle, 0, bundle.length, 0);
  if (written !== bundle.length) fail();
  fsyncSync(bundleDescriptor);
  const sealer = spawnSync(
    "/usr/bin/python3",
    [
      "-c",
      sealerSource.toString("utf8"),
      "seal-existing",
      String(bundle.length),
      bundleDigest,
    ],
    {
      env: {},
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "pipe", bundleDescriptor],
      timeout: remainingMilliseconds,
    },
  );
  if (
    sealer.error !== undefined ||
    sealer.status !== 0 ||
    sealer.signal !== null ||
    sealer.stderr.length !== 0 ||
    sealer.stdout.toString("utf8") !== '{"status":"sealed"}\n'
  )
    fail();
  const probe = async (arguments_) => {
    const result = spawnSync(
      "/usr/bin/python3",
      ["-c", sealerSource.toString("utf8"), ...arguments_.slice(1)],
      { env: {}, maxBuffer: 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (
      result.error !== undefined ||
      result.status !== 0 ||
      result.signal !== null ||
      result.stderr.length !== 0 ||
      result.stdout.toString("utf8") !== '{"status":"authenticated"}\n'
    )
      fail();
  };
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  try {
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    await uploadFailureEvidence({
      arguments_: [
        "--fd",
        String(bundleDescriptor),
        "--size",
        String(bundle.length),
        "--digest",
        bundleDigest,
        "--name",
        artifactName,
        "--deadline",
        deadlineNanoseconds,
        "--python",
        "/usr/bin/python3",
      ],
      client,
      nowNanoseconds: process.hrtime.bigint,
      probe,
      startTicks: processStartTicks,
    });
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  const retireUploadedFailureEvidence = () => {
    for (const authority of authenticatedDescriptors) {
      if (!authority.path.startsWith(`${artifactsRoot}/`)) continue;
      const named = lstatSync(authority.path);
      if (
        named.dev !== authority.status.dev ||
        named.ino !== authority.status.ino ||
        named.size !== authority.status.size ||
        named.nlink !== authority.status.nlink ||
        named.isSymbolicLink()
      )
        fail();
      unlinkSync(authority.path);
    }
    for (const { descriptor } of authenticatedDescriptors.splice(0))
      closeSync(descriptor);
    for (const runId of manifest.runIds) {
      const directory = resolve(runsRoot, runId);
      if (readdirSync(directory).length !== 0) fail();
      rmdirSync(directory);
    }
    if (readdirSync(runsRoot).length !== 0) fail();
    rmdirSync(runsRoot);
  };
  retireUploadedFailureEvidence();
};
/* eslint-enable complexity, max-lines-per-function */

const exactControllerArguments = (arguments_) => {
  if (
    arguments_.length !== 7 ||
    arguments_[0] !== "--outer-controller" ||
    arguments_[1] !== "--source-fd" ||
    arguments_[3] !== "--bundle-fd" ||
    arguments_[5] !== "--source-digest"
  )
    fail();
  return Object.freeze({
    bundleDescriptor: parseUnsigned(arguments_[4], 1024),
    sourceDescriptor: parseUnsigned(arguments_[2], 1024),
    sourceDigest: arguments_[6],
  });
};

export const preloadCredentialedSource = (path, maximumBytes) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      status.size < 1 ||
      status.size > maximumBytes
    )
      fail();
    const content = readExact(descriptor, status.size);
    return Object.freeze({
      content,
      descriptor,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      path,
      status,
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

export const revalidateCredentialedSource = (authority) => {
  const status = fstatSync(authority.descriptor);
  const named = lstatSync(authority.path);
  const content = readExact(authority.descriptor, authority.status.size);
  if (
    status.dev !== authority.status.dev ||
    status.ino !== authority.status.ino ||
    status.mode !== authority.status.mode ||
    status.nlink !== authority.status.nlink ||
    status.size !== authority.status.size ||
    named.dev !== authority.status.dev ||
    named.ino !== authority.status.ino ||
    named.mode !== authority.status.mode ||
    named.nlink !== authority.status.nlink ||
    named.size !== authority.status.size ||
    named.isSymbolicLink() ||
    `sha256:${createHash("sha256").update(content).digest("hex")}` !==
      authority.digest
  )
    fail();
};

export const buildLifecycleEnvironment = (sourceEnvironment) => {
  const environment = Object.fromEntries(
    [
      "AGENTSCOPE_INTEGRATION_CONCURRENCY",
      "AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS",
      "AGENTSCOPE_INTEGRATION_TIMEOUT_MS",
      "GITHUB_ACTIONS",
      "GITHUB_JOB",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
      "RUNNER_ENVIRONMENT",
      "RUNNER_NAME",
    ].flatMap((name) =>
      typeof sourceEnvironment[name] === "string"
        ? [[name, sourceEnvironment[name]]]
        : [],
    ),
  );
  environment.AGENTSCOPE_INTEGRATION_SHARD = sourceEnvironment.REPLAY_SHARD;
  if ((sourceEnvironment.REPLAY_SCENARIO ?? "") !== "")
    environment.AGENTSCOPE_INTEGRATION_SCENARIO =
      sourceEnvironment.REPLAY_SCENARIO;
  return environment;
};

export const settleLifecycleResult = async (result, finalize) => {
  if (result.contained !== true) fail();
  if (result.code === 0 && result.residualWorkObserved === false) return true;
  await finalize();
  return false;
};

const outerControllerMain = async () => {
  const authority = exactControllerArguments(process.argv.slice(1));
  const source = readExact(
    authority.sourceDescriptor,
    fstatSync(authority.sourceDescriptor).size,
  );
  if (
    authority.sourceDigest !==
      `sha256:${createHash("sha256").update(source).digest("hex")}` ||
    (fstatSync(authority.sourceDescriptor).mode & 0o7777) !== 0o400
  )
    fail();
  verifyArtifactClientProvenance();
  const sealer = preloadCredentialedSource(
    resolve(
      process.env.GITHUB_WORKSPACE,
      "tests/integration/seal-failure-evidence.py",
    ),
    64 * 1024,
  );
  const suppliedDeadline =
    process.env.AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS;
  if (!/^\d{7,15}$/u.test(suppliedDeadline ?? "")) fail();
  const hostMilliseconds =
    Number(readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]) * 1000;
  const maximumMilliseconds = Math.min(
    24 * 60 * 1000,
    Number(suppliedDeadline) - hostMilliseconds,
  );
  if (maximumMilliseconds < 2 * 60 * 1000) fail();
  const lifecycleEnvironment = buildLifecycleEnvironment(process.env);
  lifecycleEnvironment.AGENTSCOPE_INTEGRATION_REPLAY =
    process.env.AGENTSCOPE_FAILURE_ARTIFACT_NAME.endsWith("-1") ? "1" : "2";
  const lifecycleArguments = [
    resolve(
      process.env.GITHUB_WORKSPACE,
      "tests/integration/controller-process.mjs",
    ),
  ];
  const preparation = await prepareGithubSystemdSupervision({
    arguments_: lifecycleArguments,
    environment: lifecycleEnvironment,
    executable: process.execPath,
    maximumMilliseconds,
  });
  const result = await runSupervisedProcess({
    environment: lifecycleEnvironment,
    executable: process.execPath,
    arguments_: lifecycleArguments,
    maximumMilliseconds,
    containment: "github-systemd",
    preparation,
  });
  let succeeded;
  try {
    revalidateCredentialedSource(sealer);
    succeeded = await settleLifecycleResult(result, () =>
      finalizeFailureEvidence({
        bundleDescriptor: authority.bundleDescriptor,
        client: new DefaultArtifactClient(),
        sealerSource: sealer.content,
      }),
    );
  } finally {
    closeSync(sealer.descriptor);
    closeSync(authority.bundleDescriptor);
    closeSync(authority.sourceDescriptor);
  }
  if (succeeded) return;
  process.exitCode = result.code === 0 ? 1 : (result.code ?? 1);
};

const bootstrapMain = () => {
  authenticateActionInvocation();
  verifyArtifactClientProvenance();
  const source = preloadCredentialedSource(
    resolve(import.meta.dirname, "upload-failure-evidence.mjs"),
    64 * 1024,
  );
  const sealer = preloadCredentialedSource(
    resolve(import.meta.dirname, "seal-failure-evidence.py"),
    64 * 1024,
  );
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-c",
      sealer.content.toString("utf8"),
      "bootstrap",
      process.execPath,
      realpathSync(import.meta.dirname),
      source.digest,
      String(process.pid),
      processStartTicks(),
    ],
    {
      env: { ...process.env },
      input: source.content,
      stdio: ["pipe", "inherit", "inherit"],
      timeout: 20 * 60 * 1000,
    },
  );
  revalidateCredentialedSource(source);
  revalidateCredentialedSource(sealer);
  closeSync(source.descriptor);
  closeSync(sealer.descriptor);
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null
  )
    fail();
};

if (process.argv[1] === "--outer-controller") {
  outerControllerMain().catch((error) => {
    const stage = systemdToolFailureStage(error);
    if (stage !== undefined)
      process.stdout.write(
        `::error::integration.controller.systemd-tool:${stage}\n`,
      );
    process.exitCode = 1;
  });
} else if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    bootstrapMain();
  } catch {
    process.exitCode = 1;
  }
}
