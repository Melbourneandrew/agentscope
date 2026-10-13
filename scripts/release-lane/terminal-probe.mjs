import { createHash } from "node:crypto";
import { canonicalJson, sha256 } from "./validation.mjs";
import {
  parseAdmissionDocument,
  projectOperatorControlsReport,
} from "./admission.mjs";
import {
  validateProbeMaterial,
  validateProbeInvocationReservation,
} from "./production-recorder.mjs";
import { snapshotRecorderInput, recorderExactKeys } from "./stage-result.mjs";

const fail = () => {
  throw new Error("release.store.unresolved");
};
const id = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return value;
};

async function protectedProbeEntries(request, completeTree, mainCommit) {
  const revision = mainCommit(await request("GET", "/git/ref/heads/main"));
  const commit = await request("GET", `/git/commits/${revision}`);
  if (commit?.sha !== revision) fail();
  let entries = await completeTree(request, commit.tree?.sha);
  for (const path of ["release-records", "probes"]) {
    const entry = entries.find((value) => value.path === path);
    if (entry?.type !== "tree" || entry.mode !== "040000") fail();
    entries = await completeTree(request, entry.sha);
  }
  if (entries.length < 1 || entries.length > 100) fail();
  return { revision, entries };
}

async function readProbeBlob(request, entry) {
  if (
    entry.type !== "blob" ||
    entry.mode !== "100644" ||
    !entry.path.endsWith(".json")
  )
    fail();
  const blob = await request("GET", `/git/blobs/${entry.sha}`);
  if (
    blob?.sha !== entry.sha ||
    blob.encoding !== "base64" ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 1 ||
    blob.size > 16_384 ||
    typeof blob.content !== "string" ||
    !/^[A-Za-z0-9+/=\n\r]+$/u.test(blob.content)
  )
    fail();
  const encoded = blob.content.replace(/[\r\n]/gu, "");
  const bytes = Buffer.from(encoded, "base64");
  const identity = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (
    bytes.length !== blob.size ||
    bytes.toString("base64") !== encoded ||
    identity !== entry.sha
  )
    fail();
  return snapshotRecorderInput(parseAdmissionDocument(bytes));
}

function terminalProbe(value) {
  recorderExactKeys(value, [
    "schemaVersion",
    "kind",
    "repository",
    "workflowPath",
    "environment",
    "trustedPublisherAction",
    "sourceRevision",
    "runId",
    "runAttempt",
    "workflowDigest",
    "releaseScriptsDigest",
    "material",
    "stageId",
    "recorderOutputDigest",
    "invocationIntentDigest",
    "ownerIdentity",
    "ownerObservation",
    "controlsReportDigest",
    "controlsInspectedAt",
    "authenticationDigest",
    "terminalNpmState",
    "disposition",
    "digest",
  ]);
  const material = validateProbeMaterial(value.material);
  const { digest, ...unsigned } = value;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "terminal-inert-oidc-probe" ||
    value.repository !== "Melbourneandrew/agentscope" ||
    value.workflowPath !== ".github/workflows/release.yml" ||
    value.environment !== "npm-release" ||
    value.trustedPublisherAction !== "stage-publish" ||
    !/^[a-f0-9]{40}$/u.test(value.sourceRevision) ||
    value.runAttempt !== 1 ||
    !Number.isSafeInteger(value.runId) ||
    value.runId < 1 ||
    value.ownerIdentity !== "Melbourneandrew" ||
    value.terminalNpmState !== "rejected" ||
    value.disposition !==
      "awaiting-reviewed-append-under-release-records/probes" ||
    typeof value.stageId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.stageId) ||
    value.workflowDigest !== material.workflowDigest ||
    value.releaseScriptsDigest !== material.releaseScriptsDigest ||
    digest !== sha256(canonicalJson(unsigned))
  )
    fail();
  for (const key of [
    "recorderOutputDigest",
    "invocationIntentDigest",
    "authenticationDigest",
  ])
    if (
      typeof value[key] !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value[key])
    )
      fail();
  terminalProbeOwner(value, material);
  return value;
}

function terminalProbeOwner(value, material) {
  const owner = value.ownerObservation;
  recorderExactKeys(owner, [
    "phase",
    "packetDigest",
    "issuedAt",
    "expiresAt",
    "controlsReport",
    "stageId",
    "downloadedTarballSha256",
    "downloadedIntegrity",
    "downloadedInventoryDigest",
    "terminalNpmState",
  ]);
  if (
    owner.phase !== "reconcile-probe" ||
    owner.packetDigest !== value.recorderOutputDigest ||
    owner.stageId !== value.stageId ||
    owner.downloadedTarballSha256 !== material.tarballSha256 ||
    owner.downloadedIntegrity !== material.integrity ||
    owner.downloadedInventoryDigest !== material.inventoryDigest ||
    owner.terminalNpmState !== "rejected"
  )
    fail();
  // Historical controls are checked at their original observation, not renewed.
  // Fresh controls remain the authenticated owner checkpoint before mutation.
  const controls = projectOperatorControlsReport(
    owner.controlsReport,
    owner.expiresAt,
    owner.issuedAt,
  );
  if (
    controls.controlsInspectedAt !== owner.issuedAt ||
    controls.controlsInspectedAt !== value.controlsInspectedAt ||
    controls.controlsReportDigest !== value.controlsReportDigest
  )
    fail();
}

async function bindProbeReservation(
  request,
  terminal,
  reservations,
  assertMainAncestry,
) {
  const matches = reservations.filter(
    (value) => value.version === terminal.material.version,
  );
  if (matches.length !== 1) fail();
  const reservation = validateProbeInvocationReservation(
    matches[0],
    terminal.material,
  );
  if (reservation.digest !== terminal.invocationIntentDigest) fail();
  const run = await request("GET", `/actions/runs/${id(terminal.runId)}`);
  if (
    run.id !== terminal.runId ||
    run.run_attempt !== terminal.runAttempt ||
    run.workflow_id !== reservation.workflowDatabaseId ||
    run.run_number !== reservation.expectedRunNumber ||
    run.path !== terminal.workflowPath ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.head_sha !== terminal.sourceRevision ||
    run.actor?.id !== 25971425 ||
    run.actor?.login !== terminal.ownerIdentity ||
    run.triggering_actor?.id !== 25971425 ||
    run.triggering_actor?.login !== terminal.ownerIdentity
  )
    fail();
  await assertMainAncestry(request, terminal.sourceRevision);
  return reservation;
}

async function verifyTerminalProbe(
  request,
  executingDigests,
  { completeTree, mainCommit, assertMainAncestry },
) {
  const expected = snapshotRecorderInput(executingDigests);
  recorderExactKeys(expected, ["workflowDigest", "releaseScriptsDigest"]);
  for (const value of Object.values(expected))
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
      fail();
  const { revision, entries } = await protectedProbeEntries(
    request,
    completeTree,
    mainCommit,
  );
  const reservations = [],
    terminals = [];
  for (const entry of entries) {
    const value = await readProbeBlob(request, entry);
    if (value.kind === "reserved-inert-probe-invocation")
      reservations.push(value);
    else terminals.push(terminalProbe(value));
  }
  if (terminals.length < 1 || reservations.length !== terminals.length) fail();
  const bound = [];
  for (const terminal of terminals)
    bound.push({
      terminal,
      reservation: await bindProbeReservation(
        request,
        terminal,
        reservations,
        assertMainAncestry,
      ),
    });
  if (
    new Set(bound.map(({ reservation }) => reservation.version)).size !==
      bound.length ||
    new Set(bound.map(({ reservation }) => reservation.expectedRunNumber))
      .size !== bound.length ||
    new Set(bound.map(({ reservation }) => reservation.workflowDatabaseId))
      .size !== 1
  )
    fail();
  bound.sort(
    (a, b) => b.reservation.expectedRunNumber - a.reservation.expectedRunNumber,
  );
  const latest = bound[0].terminal;
  if (
    latest.workflowDigest !== expected.workflowDigest ||
    latest.releaseScriptsDigest !== expected.releaseScriptsDigest ||
    mainCommit(await request("GET", "/git/ref/heads/main")) !== revision
  )
    fail();
}

export async function assertTerminalProbe(
  request,
  executingDigests,
  boundaries,
) {
  try {
    await verifyTerminalProbe(request, executingDigests, boundaries);
  } catch {
    // Preserve the store's stable, content-free failure across all validators.
    fail();
  }
}
