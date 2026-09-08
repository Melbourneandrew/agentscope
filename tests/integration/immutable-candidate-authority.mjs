import { createHash } from "node:crypto";

const fail = () => {
  throw new Error("integration.immutable-candidate.authority");
};
const plainRecord = (value) =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, expected) =>
  plainRecord(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort());
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const selectedRuntimeFiles = Object.freeze([
  "testkit/bounded-terminal-emulator.js",
  "testkit/headless-supervisor-contract.js",
  "testkit/headless-supervisor-kernel.js",
  "testkit/headless-supervisor.js",
  "testkit/internal/headless-supervisor-backend.js",
  "testkit/pty-terminal-contract.js",
  "testkit/pty-runtime/node127-linux-x64-musl/pty.node",
]);

export const compileCandidateInventory = (candidate) => {
  if (
    !plainRecord(candidate) ||
    !exactKeys(candidate, [
      "artifacts",
      "bundleIdentity",
      "candidateRevision",
      "evidenceVersion",
      "lockfile",
      "platform",
      "scenarioNetworkPolicy",
    ]) ||
    candidate.evidenceVersion !== 1 ||
    !/^sha256-[a-f0-9]{64}$/u.test(candidate.bundleIdentity) ||
    !/^[a-f0-9]{40,64}$/u.test(candidate.candidateRevision) ||
    !exactKeys(candidate.platform, ["architecture", "nodeVersion", "os"]) ||
    !/^[a-z0-9-]{1,32}$/u.test(candidate.platform.os) ||
    !/^[a-z0-9-]{1,32}$/u.test(candidate.platform.architecture) ||
    !/^\d+\.\d+\.\d+$/u.test(candidate.platform.nodeVersion) ||
    !plainRecord(candidate.lockfile) ||
    !exactKeys(candidate.lockfile, ["bytes", "fileName", "sha256"]) ||
    candidate.lockfile.fileName !== "pnpm-lock.yaml" ||
    !Number.isSafeInteger(candidate.lockfile.bytes) ||
    candidate.lockfile.bytes < 1 ||
    candidate.lockfile.bytes > 256 * 1024 * 1024 ||
    !/^sha256-[a-f0-9]{64}$/u.test(candidate.lockfile.sha256) ||
    candidate.scenarioNetworkPolicy !==
      "offline-no-package-or-registry-download" ||
    !Array.isArray(candidate.artifacts) ||
    candidate.artifacts.length < 1 ||
    candidate.artifacts.length > 32
  )
    return fail();
  const artifacts = candidate.artifacts
    .map((file) => {
      if (
        !plainRecord(file) ||
        !exactKeys(file, ["bytes", "fileName", "id", "kind", "sha256"]) ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(file.id) ||
        !["npm-tarball", "runtime-archive", "runtime-binary"].includes(
          file.kind,
        ) ||
        typeof file.fileName !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(file.fileName) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 256 * 1024 * 1024 ||
        !/^sha256-[a-f0-9]{64}$/u.test(file.sha256)
      )
        return fail();
      return {
        id: file.id,
        kind: file.kind,
        fileName: file.fileName,
        bytes: file.bytes,
        sha256: file.sha256,
      };
    })
    .sort((left, right) =>
      left.fileName < right.fileName
        ? -1
        : left.fileName > right.fileName
          ? 1
          : 0,
    );
  const files = [
    {
      fileName: candidate.lockfile.fileName,
      bytes: candidate.lockfile.bytes,
      sha256: candidate.lockfile.sha256,
    },
    ...artifacts,
  ].sort((left, right) =>
    left.fileName < right.fileName
      ? -1
      : left.fileName > right.fileName
        ? 1
        : 0,
  );
  if (new Set(files.map(({ fileName }) => fileName)).size !== files.length)
    return fail();
  if (
    new Set(artifacts.map(({ id }) => id)).size !== artifacts.length ||
    artifacts.filter(
      ({ id, kind }) => id === "agentscope-cli" && kind === "npm-tarball",
    ).length !== 1
  )
    return fail();
  const inventory = {
    evidenceVersion: candidate.evidenceVersion,
    bundleIdentity: candidate.bundleIdentity,
    candidateRevision: candidate.candidateRevision,
    platform: { ...candidate.platform },
    files,
    scenarioNetworkPolicy: candidate.scenarioNetworkPolicy,
  };
  return Object.freeze({
    inventory,
    sha256: sha256(JSON.stringify(inventory)),
  });
};

export const compileImmutableCandidateHandoff = ({
  candidate,
  image,
  plan,
}) => {
  const compiled = compileCandidateInventory(candidate);
  if (
    !exactKeys(plan, ["runId", "scenarioId"]) ||
    !/^[a-f0-9]{16}$/u.test(plan.runId) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(plan.scenarioId) ||
    !plainRecord(image) ||
    !/^sha256:[a-f0-9]{64}$/u.test(image.Id) ||
    !plainRecord(image.Config)
  )
    return fail();
  const record = {
    authorityVersion: 1,
    candidateBundleIdentity: candidate.bundleIdentity,
    candidateInventorySha256: compiled.sha256,
    candidateRoot: "/opt/agentscope/prepared",
    imageConfigSha256: sha256(JSON.stringify(image.Config)),
    imageId: image.Id,
    runId: plan.runId,
    scenarioId: plan.scenarioId,
  };
  return Object.freeze({
    ...record,
    encoded: Buffer.from(JSON.stringify(record)).toString("base64url"),
  });
};

export const decodeImmutableCandidateHandoff = (encoded, expected) => {
  if (
    typeof encoded !== "string" ||
    encoded.length < 1 ||
    encoded.length > 4_096 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
    !exactKeys(expected, [
      "candidateBundleIdentity",
      "candidateInventorySha256",
      "candidateRoot",
      "runId",
      "scenarioId",
    ])
  )
    return fail();
  let record;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return fail();
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail();
  }
  if (
    !exactKeys(record, [
      "authorityVersion",
      "candidateBundleIdentity",
      "candidateInventorySha256",
      "candidateRoot",
      "imageConfigSha256",
      "imageId",
      "runId",
      "scenarioId",
    ]) ||
    record.authorityVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(record.imageConfigSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.imageId) ||
    Object.entries(expected).some(([key, value]) => record[key] !== value)
  )
    return fail();
  return Object.freeze(record);
};

export const validateImmutableScenarioContainer = ({
  container,
  handoff,
  image,
  networkName,
  tmpfs,
}) => {
  if (
    !plainRecord(container) ||
    !plainRecord(handoff) ||
    !plainRecord(image) ||
    image.Id !== handoff.imageId ||
    sha256(JSON.stringify(image.Config)) !== handoff.imageConfigSha256 ||
    container.Image !== handoff.imageId ||
    container.Config?.User !== "1000:1000" ||
    !Array.isArray(container.Config?.Env) ||
    !container.Config.Env.includes(
      `AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${handoff.encoded}`,
    ) ||
    container.HostConfig?.ReadonlyRootfs !== true ||
    container.HostConfig?.NetworkMode !== networkName ||
    JSON.stringify(container.HostConfig?.CapDrop) !== JSON.stringify(["ALL"]) ||
    !Array.isArray(container.HostConfig?.SecurityOpt) ||
    !container.HostConfig.SecurityOpt.includes("no-new-privileges") ||
    !Array.isArray(container.Mounts) ||
    container.Mounts.length !== 0 ||
    !plainRecord(container.HostConfig?.Tmpfs) ||
    JSON.stringify(container.HostConfig.Tmpfs) !== JSON.stringify(tmpfs)
  )
    return fail();
  return true;
};

const ptyReceiptKeys = [
  "candidateBundleIdentity",
  "candidateInventorySha256",
  "caseId",
  "cleanup",
  "completionKind",
  "eofByteWritten",
  "initialGeometry",
  "isTTY",
  "outcome",
  "outputBytes",
  "outputSha256",
  "processJoined",
  "receiptVersion",
  "residualProcessCount",
  "runId",
  "scenarioId",
  "semanticState",
  "terminalInputJoined",
  "terminalOutputJoined",
  "terminalTransportClosed",
];

export const compileInstalledCliPtyReceipt = (value) => {
  if (
    !exactKeys(value, ptyReceiptKeys) ||
    value.receiptVersion !== 1 ||
    !/^[a-f0-9]{16}$/u.test(value.runId) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.scenarioId) ||
    !/^sha256-[a-f0-9]{64}$/u.test(value.candidateBundleIdentity) ||
    !/^[a-f0-9]{64}$/u.test(value.candidateInventorySha256) ||
    value.caseId !== "installed-cli-version" ||
    value.completionKind !== "exact-output" ||
    value.outcome !== "completed" ||
    value.semanticState !== "active" ||
    value.cleanup !== "clean" ||
    value.isTTY !== true ||
    value.eofByteWritten !== true ||
    value.processJoined !== true ||
    value.terminalInputJoined !== true ||
    value.terminalOutputJoined !== true ||
    value.terminalTransportClosed !== true ||
    value.residualProcessCount !== 0 ||
    !exactKeys(value.initialGeometry, ["columns", "rows"]) ||
    value.initialGeometry.columns !== 40 ||
    value.initialGeometry.rows !== 12 ||
    !Number.isSafeInteger(value.outputBytes) ||
    value.outputBytes < 1 ||
    value.outputBytes > 4_096 ||
    !/^[a-f0-9]{64}$/u.test(value.outputSha256)
  )
    return fail();
  const record = Object.freeze({ ...value });
  return Object.freeze({
    record,
    encoded: Buffer.from(JSON.stringify(record)).toString("base64url"),
  });
};

const selectedPtyExecutionReceiptKeys = [
  "cleanup",
  "eofByte",
  "eofByteWritten",
  "exitCode",
  "finalSnapshot",
  "initialGeometry",
  "inputBytesWritten",
  "isTTY",
  "observedCanonicalMode",
  "observedGeometry",
  "outcome",
  "outputBytes",
  "outputSha256",
  "processJoined",
  "receiptVersion",
  "requestFingerprint",
  "residualProcessCount",
  "runId",
  "signal",
  "terminalInputJoined",
  "terminalOutputJoined",
  "terminalTransportClosed",
];

export const compileInstalledCliPtyReceiptFromExecution = (value) => {
  if (
    !exactKeys(value, [
      "candidateBundleIdentity",
      "candidateInventorySha256",
      "receipt",
      "scenarioId",
    ]) ||
    !exactKeys(value.receipt, selectedPtyExecutionReceiptKeys) ||
    !plainRecord(value.receipt.finalSnapshot)
  )
    return fail();
  return compileInstalledCliPtyReceipt({
    receiptVersion: 1,
    runId: value.receipt.runId,
    scenarioId: value.scenarioId,
    candidateBundleIdentity: value.candidateBundleIdentity,
    candidateInventorySha256: value.candidateInventorySha256,
    caseId: "installed-cli-version",
    completionKind: "exact-output",
    outcome: value.receipt.outcome,
    semanticState: value.receipt.finalSnapshot.semanticState,
    cleanup: value.receipt.cleanup,
    isTTY: value.receipt.isTTY,
    eofByteWritten: value.receipt.eofByteWritten,
    processJoined: value.receipt.processJoined,
    terminalInputJoined: value.receipt.terminalInputJoined,
    terminalOutputJoined: value.receipt.terminalOutputJoined,
    terminalTransportClosed: value.receipt.terminalTransportClosed,
    residualProcessCount: value.receipt.residualProcessCount,
    initialGeometry: value.receipt.initialGeometry,
    outputBytes: value.receipt.outputBytes,
    outputSha256: value.receipt.outputSha256,
  });
};

export const decodeInstalledCliPtyReceipt = (output, expected) => {
  if (typeof output !== "string" || output.length > 2 * 1024 * 1024)
    return fail();
  const prefix = "AGENTSCOPE_PTY_RECEIPT=";
  const lines = output.split("\n").filter((line) => line.startsWith(prefix));
  if (lines.length !== 1 || lines[0].length > 8_192) return fail();
  let value;
  try {
    const encoded = lines[0].slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return fail();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return fail();
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail();
  }
  const receipt = compileInstalledCliPtyReceipt(value).record;
  if (
    !exactKeys(expected, [
      "candidateBundleIdentity",
      "candidateInventorySha256",
      "runId",
      "scenarioId",
    ]) ||
    Object.entries(expected).some(
      ([key, expectedValue]) => receipt[key] !== expectedValue,
    )
  )
    return fail();
  return receipt;
};

export const validateInstalledCliBoundary = (facts) => {
  if (
    !exactKeys(facts, [
      "argv",
      "binIsSymlink",
      "binTarget",
      "cliDigest",
      "cliMode",
      "cliPrefix",
      "expectedDigest",
    ]) ||
    facts.binIsSymlink !== true ||
    facts.binTarget !==
      "../node_modules/agentscope-cli/dist/bin/agentscope.js" ||
    facts.cliMode !== 0o755 ||
    facts.cliPrefix !== "#!/usr/bin/env node\n" ||
    !/^[a-f0-9]{64}$/u.test(facts.expectedDigest) ||
    facts.cliDigest !== facts.expectedDigest ||
    JSON.stringify(facts.argv) !==
      JSON.stringify(["/opt/agentscope/installed/bin/agentscope", "--version"])
  )
    return fail();
  return true;
};
