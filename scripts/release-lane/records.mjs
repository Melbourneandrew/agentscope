import {
  assert,
  assertExactKeys,
  canonicalJson,
  sha256,
  SHA256_PATTERN,
  SOURCE_REVISION_PATTERN,
} from "./validation.mjs";

const AUTHORITY = "synthetic-only-no-release-authority";
const SRI_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const transitions = new Map([
  ["draft-prepared", new Set(["stage-recorded", "quarantine-still-draft"])],
  ["stage-recorded", new Set(["ready-to-publish", "quarantine-still-draft"])],
  [
    "ready-to-publish",
    new Set([
      "completion-public-registry-verified",
      "completion-already-immutable",
      "quarantine-still-draft",
      "incident-immutable-release",
    ]),
  ],
  ["quarantine-still-draft", new Set(["quarantine-immutable-prerelease"])],
]);
const terminalTransitions = new Set([
  "completion-public-registry-verified",
  "completion-already-immutable",
  "quarantine-immutable-prerelease",
  "incident-immutable-release",
]);

function digest(value, label) {
  assert(SHA256_PATTERN.test(value), `${label} must be an exact SHA-256`);
}

function validateDistTags(distTags, distTagsDigest, label) {
  assert(
    distTags !== null &&
      typeof distTags === "object" &&
      !Array.isArray(distTags) &&
      Object.keys(distTags).length > 0,
    `${label} must contain a complete dist-tag mapping`,
  );
  const keys = Object.keys(distTags);
  assert(
    canonicalJson(distTags) ===
      canonicalJson(
        Object.fromEntries([...keys].sort().map((key) => [key, distTags[key]])),
      ) &&
      keys.every(
        (key) =>
          /^[a-z0-9][a-z0-9._-]*$/u.test(key) &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(distTags[key]),
      ),
    `${label} contains a noncanonical tag or version`,
  );
  digest(distTagsDigest, `${label} digest`);
  assert(
    distTagsDigest === sha256(canonicalJson(distTags)),
    `${label} digest does not bind the complete mapping`,
  );
}

function validateReleaseChannels(registry, expected, ledger, allowDrift) {
  validateDistTags(registry.distTags, registry.distTagsDigest, "registry tags");
  if (allowDrift) return;
  assert(
    registry.distTags[expected.package.distTag] === expected.package.version,
    `Registry ${expected.package.distTag} channel does not select the candidate`,
  );
  assert(
    ledger.prepublicationDistTags,
    "Registry completion lacks a durable prepublication tag checkpoint",
  );
  const before = Object.fromEntries(
    Object.entries(ledger.prepublicationDistTags).filter(
      ([tag]) => tag !== expected.package.distTag,
    ),
  );
  const after = Object.fromEntries(
    Object.entries(registry.distTags).filter(
      ([tag]) => tag !== expected.package.distTag,
    ),
  );
  assert(
    canonicalJson(after) === canonicalJson(before),
    "Registry mutated a non-authorized dist-tag",
  );
}

function syntheticIdentifier(value, prefix, label) {
  assert(
    typeof value === "string" &&
      value.startsWith(prefix) &&
      /^[a-z0-9._-]+$/u.test(value),
    `${label} must remain synthetic`,
  );
}

function validateReleaseScripts(records, observed) {
  assert(
    Array.isArray(records) && records.length > 0,
    "Release script set is empty",
  );
  const observedPaths = Object.keys(observed).sort();
  assert(
    records.length === observedPaths.length,
    "Release script set does not match observed bytes",
  );
  let previous = "";
  for (const [index, record] of records.entries()) {
    assertExactKeys(record, ["path", "digest"], `release script ${index}`);
    assert(
      typeof record.path === "string" &&
        record.path > previous &&
        !record.path.startsWith("/") &&
        !record.path.includes("\\") &&
        !record.path.split("/").some((part) => ["", ".", ".."].includes(part)),
      "Release script paths must be sorted canonical relative paths",
    );
    digest(record.digest, `release script ${record.path}`);
    assert(
      observedPaths[index] === record.path &&
        record.digest === sha256(observed[record.path]),
      `Release script digest mismatch: ${record.path}`,
    );
    previous = record.path;
  }
}

export function createSyntheticRecord(record) {
  const unsigned = { ...record };
  delete unsigned.digest;
  return Object.freeze({
    ...unsigned,
    digest: sha256(canonicalJson(unsigned)),
  });
}

function validateProbeArtifact(probe, expected) {
  assertExactKeys(
    probe.artifact,
    ["tarballSha256", "integrity", "inventory", "inventoryDigest", "manifest"],
    "probe artifact",
  );
  assert(
    SHA256_PATTERN.test(probe.artifact.tarballSha256) &&
      SRI_PATTERN.test(probe.artifact.integrity) &&
      probe.artifact.tarballSha256 !== expected.candidateTarballSha256 &&
      probe.artifact.integrity !== expected.integrity,
    "Probe must use its own inert artifact identity",
  );
  assert(
    Array.isArray(probe.artifact.inventory) &&
      probe.artifact.inventory.length === 1,
    "Probe inventory must contain only package/package.json",
  );
  assertExactKeys(
    probe.artifact.inventory[0],
    ["path", "bytes", "sha256"],
    "probe inventory entry",
  );
  assert(
    probe.artifact.inventory[0].path === "package/package.json" &&
      Number.isSafeInteger(probe.artifact.inventory[0].bytes) &&
      probe.artifact.inventory[0].bytes > 0 &&
      SHA256_PATTERN.test(probe.artifact.inventory[0].sha256) &&
      probe.artifact.inventoryDigest ===
        sha256(canonicalJson(probe.artifact.inventory)),
    "Probe inventory identity drifted",
  );
  assertExactKeys(
    probe.artifact.manifest,
    [
      "name",
      "version",
      "binAbsent",
      "scriptsAbsent",
      "dependenciesAbsent",
      "productFilesAbsent",
    ],
    "probe manifest facts",
  );
  assert(
    probe.artifact.manifest.name === "agentscope-cli" &&
      probe.artifact.manifest.version === probe.version &&
      probe.artifact.manifest.binAbsent === true &&
      probe.artifact.manifest.scriptsAbsent === true &&
      probe.artifact.manifest.dependenciesAbsent === true &&
      probe.artifact.manifest.productFilesAbsent === true,
    "Probe artifact is not inert",
  );
}

function validateProbeLifecycle(probe) {
  assertExactKeys(probe.stage, ["id", "recorderOutputDigest"], "probe stage");
  syntheticIdentifier(
    probe.stage.id,
    "synthetic-probe-stage-",
    "probe stage ID",
  );
  digest(probe.stage.recorderOutputDigest, "probe recorder output");
  assertExactKeys(
    probe.ownerDownload,
    [
      "stageId",
      "tarballSha256",
      "integrity",
      "inventoryDigest",
      "verificationDigest",
    ],
    "probe owner download",
  );
  assert(
    probe.ownerDownload.stageId === probe.stage.id &&
      probe.ownerDownload.tarballSha256 === probe.artifact.tarballSha256 &&
      probe.ownerDownload.integrity === probe.artifact.integrity &&
      probe.ownerDownload.inventoryDigest === probe.artifact.inventoryDigest,
    "Probe owner download mixes stage or artifact identity",
  );
  digest(probe.ownerDownload.verificationDigest, "probe download verification");
  assertExactKeys(
    probe.rejection,
    ["stageId", "ownerIdentity", "rejectionDigest"],
    "probe rejection",
  );
  assert(
    probe.rejection.stageId === probe.stage.id &&
      probe.rejection.ownerIdentity === "synthetic-owner",
    "Probe rejection mixes stage or owner identity",
  );
  digest(probe.rejection.rejectionDigest, "probe rejection");
}

function validateProbe(probe, expected, observed) {
  assertExactKeys(
    probe,
    [
      "schemaVersion",
      "authority",
      "kind",
      "repository",
      "workflowPath",
      "environment",
      "sourceRevision",
      "trustedPublisher",
      "version",
      "distTag",
      "artifact",
      "stage",
      "ownerDownload",
      "rejection",
      "terminalNpmState",
      "workflowDigest",
      "releaseScripts",
    ],
    "probe record",
  );
  assert(
    probe.schemaVersion === 1 &&
      probe.authority === AUTHORITY &&
      probe.kind === "oidc-probe" &&
      probe.repository === "Melbourneandrew/agentscope" &&
      probe.workflowPath === ".github/workflows/release.yml" &&
      probe.environment === "npm-release" &&
      SOURCE_REVISION_PATTERN.test(probe.sourceRevision) &&
      /^0\.0\.0-oidc-probe\.[a-z0-9-]+$/u.test(probe.version) &&
      probe.distTag === "oidc-probe" &&
      probe.terminalNpmState === "rejected",
    "Synthetic probe record drifted",
  );
  assertExactKeys(
    probe.trustedPublisher,
    ["repository", "workflowPath", "environment", "action"],
    "probe trusted publisher",
  );
  assert(
    probe.trustedPublisher.repository === probe.repository &&
      probe.trustedPublisher.workflowPath === probe.workflowPath &&
      probe.trustedPublisher.environment === probe.environment &&
      probe.trustedPublisher.action === "stage-publish",
    "Probe trusted-publisher tuple drifted",
  );
  validateProbeArtifact(probe, expected);
  validateProbeLifecycle(probe);
  assert(
    probe.workflowDigest === expected.workflowDigest &&
      probe.workflowDigest === sha256(observed.workflowBytes),
    "Probe workflow digest does not bind observed bytes",
  );
  assert(
    canonicalJson(probe.releaseScripts) ===
      canonicalJson(expected.releaseScripts),
    "Probe release script set drifted",
  );
  validateReleaseScripts(probe.releaseScripts, observed.releaseScripts);
  assert(
    expected.applicableProbeDigest === sha256(canonicalJson(probe)),
    "Applicable probe digest does not bind the probe record",
  );
}

function validateDraftPayload(payload, expected) {
  assertExactKeys(payload, ["release", "assets"], "draft payload");
  assertExactKeys(
    payload.release,
    ["databaseId", "draft", "tag", "prerelease"],
    "draft release",
  );
  syntheticIdentifier(
    payload.release.databaseId,
    "synthetic-release-",
    "release database ID",
  );
  assert(
    payload.release.draft === true &&
      payload.release.tag === expected.protectedTag &&
      payload.release.prerelease === true,
    "Draft release identity drifted",
  );
  assertExactKeys(
    payload.assets,
    [
      "tarballSha256",
      "releaseAssetManifestDigest",
      "checksumManifestDigest",
      "sbomDigest",
      "attestationDigest",
      "evidenceIndexDigest",
    ],
    "draft assets",
  );
  assert(
    payload.assets.tarballSha256 === expected.candidateTarballSha256,
    "Draft tarball drifted",
  );
  for (const field of [
    "releaseAssetManifestDigest",
    "checksumManifestDigest",
    "sbomDigest",
    "attestationDigest",
    "evidenceIndexDigest",
  ])
    digest(payload.assets[field], `draft ${field}`);
  return {
    assetManifestDigest: payload.assets.releaseAssetManifestDigest,
    releaseDatabaseId: payload.release.databaseId,
  };
}

function validateStagePayload(payload, expected) {
  assertExactKeys(
    payload,
    ["stage", "ownerCheckpointDigest", "stageResultDigest"],
    "stage payload",
  );
  assertExactKeys(
    payload.stage,
    [
      "id",
      "package",
      "version",
      "distTag",
      "candidateManifestDigest",
      "tarballSha256",
    ],
    "stage identity",
  );
  syntheticIdentifier(payload.stage.id, "synthetic-stage-", "stage ID");
  assert(
    payload.stage.package === expected.package.name &&
      payload.stage.version === expected.package.version &&
      payload.stage.distTag === expected.package.distTag &&
      payload.stage.candidateManifestDigest ===
        expected.candidateManifestDigest &&
      payload.stage.tarballSha256 === expected.candidateTarballSha256,
    "Stage identity drifted",
  );
  digest(payload.ownerCheckpointDigest, "stage owner checkpoint");
  digest(payload.stageResultDigest, "stage result");
  return payload.stage.id;
}

function validateReadyPayload(payload, expected, ledger) {
  assertExactKeys(
    payload,
    [
      "stageId",
      "draftReleaseDatabaseId",
      "pendingStagesCheckpointDigest",
      "publicationCheckpoint",
      "approvalConsumption",
      "releaseLedgerPath",
      "incidentLedgerPath",
    ],
    "ready payload",
  );
  syntheticIdentifier(payload.stageId, "synthetic-stage-", "ready stage ID");
  syntheticIdentifier(
    payload.draftReleaseDatabaseId,
    "synthetic-release-",
    "ready release database ID",
  );
  digest(payload.pendingStagesCheckpointDigest, "pending-stage checkpoint");
  assert(
    payload.stageId === ledger.stageId &&
      payload.draftReleaseDatabaseId === ledger.releaseDatabaseId,
    "Ready record mixes stage or release identity",
  );
  assertExactKeys(
    payload.publicationCheckpoint,
    [
      "stageId",
      "ownerIdentity",
      "distTags",
      "distTagsDigest",
      "issuedAt",
      "expiresAt",
      "state",
      "authenticationDigest",
    ],
    "publication checkpoint",
  );
  const checkpoint = payload.publicationCheckpoint;
  const issuedAt = Date.parse(checkpoint.issuedAt);
  const expiresAt = Date.parse(checkpoint.expiresAt);
  assert(
    checkpoint.stageId === ledger.stageId &&
      checkpoint.ownerIdentity === "synthetic-owner" &&
      checkpoint.state === "valid-unconsumed" &&
      Number.isFinite(issuedAt) &&
      Number.isFinite(expiresAt) &&
      expiresAt > issuedAt &&
      expiresAt - issuedAt <= 15 * 60 * 1000,
    "Publication checkpoint is stale, detached, or not one-use",
  );
  validateDistTags(
    checkpoint.distTags,
    checkpoint.distTagsDigest,
    "publication checkpoint tags",
  );
  assert(
    expected.package.releaseClass !== "alpha" ||
      (checkpoint.distTags.bootstrap === "0.0.0-bootstrap.0" &&
        checkpoint.distTags.latest === "0.0.0-bootstrap.0"),
    "Alpha checkpoint does not preserve the exact inert bootstrap channels",
  );
  digest(checkpoint.authenticationDigest, "publication authentication");
  assertExactKeys(
    payload.approvalConsumption,
    [
      "checkpointDigest",
      "stageId",
      "observedDistTagsDigest",
      "reauthenticationDigest",
      "state",
    ],
    "approval consumption",
  );
  const approval = payload.approvalConsumption;
  assert(
    approval.checkpointDigest === sha256(canonicalJson(checkpoint)) &&
      approval.stageId === ledger.stageId &&
      approval.observedDistTagsDigest === checkpoint.distTagsDigest &&
      approval.state === "consumed-for-approved-stage",
    "Publication approval did not consume the exact fresh checkpoint",
  );
  digest(approval.reauthenticationDigest, "publication reauthentication");
  assert(
    payload.releaseLedgerPath === "release-records/releases/" &&
      payload.incidentLedgerPath === "release-records/incidents/",
    "Ready record does not declare the protected ledgers",
  );
  ledger.prepublicationDistTags = checkpoint.distTags;
  ledger.prepublicationDistTagsDigest = checkpoint.distTagsDigest;
}

function validateRegistry(
  registry,
  expected,
  ledger,
  { allowCandidateMismatch = false, allowChannelDrift = false } = {},
) {
  assertExactKeys(
    registry,
    [
      "package",
      "version",
      "releaseClass",
      "distTags",
      "distTagsDigest",
      "integrity",
      "tarballSha256",
      "provenanceDigest",
      "bin",
      "downloadedTarballSha256",
      "downloadVerificationDigest",
      "installedSmoke",
    ],
    "registry evidence",
  );
  assert(
    registry.package === expected.package.name &&
      registry.version === expected.package.version &&
      registry.releaseClass === expected.package.releaseClass &&
      SRI_PATTERN.test(registry.integrity) &&
      SHA256_PATTERN.test(registry.tarballSha256),
    "Registry identity drifted",
  );
  validateReleaseChannels(registry, expected, ledger, allowChannelDrift);
  assert(
    registry.downloadedTarballSha256 === registry.tarballSha256,
    "Downloaded registry tarball identity drifted",
  );
  digest(registry.provenanceDigest, "npm provenance");
  assertExactKeys(registry.bin, ["name", "path"], "registry bin");
  assert(
    registry.bin.name === "agentscope" &&
      registry.bin.path === "./dist/bin/agentscope.js",
    "Registry bin identity drifted",
  );
  digest(registry.downloadVerificationDigest, "registry tarball download");
  assertExactKeys(
    registry.installedSmoke,
    ["version", "help", "init", "doctor"],
    "installed smoke evidence",
  );
  for (const [name, value] of Object.entries(registry.installedSmoke))
    digest(value, `installed ${name} smoke`);
  if (!allowCandidateMismatch)
    assert(
      registry.integrity === expected.integrity &&
        registry.tarballSha256 === expected.candidateTarballSha256,
      "Registry candidate digest mismatch",
    );
}

function validateGithubRelease(release, expected, state, ledger) {
  assertExactKeys(
    release,
    [
      "databaseId",
      "tag",
      "draft",
      "prerelease",
      "immutable",
      "assetManifestDigest",
    ],
    "GitHub Release evidence",
  );
  syntheticIdentifier(
    release.databaseId,
    "synthetic-release-",
    "release database ID",
  );
  assert(
    release.databaseId === ledger.releaseDatabaseId &&
      release.tag === expected.protectedTag &&
      release.draft === state.draft &&
      release.prerelease === true &&
      release.immutable === state.immutable,
    "GitHub Release state drifted",
  );
  digest(release.assetManifestDigest, "GitHub asset manifest");
  assert(
    release.assetManifestDigest === ledger.assetManifestDigest,
    "GitHub Release asset identity drifted",
  );
}

function validateIncidentPayload(payload, expected, ledger) {
  assertExactKeys(
    payload,
    [
      "failureClass",
      "registry",
      "githubRelease",
      "recoveryPlanDigest",
      "incidentManifestDigest",
      "readyManifestDigest",
    ],
    "immutable incident payload",
  );
  assert(
    ["candidate-digest-mismatch", "postpublication-control-drift"].includes(
      payload.failureClass,
    ),
    "Immutable incident failure class drifted",
  );
  validateRegistry(payload.registry, expected, ledger, {
    allowCandidateMismatch: true,
    allowChannelDrift: payload.failureClass === "postpublication-control-drift",
  });
  if (payload.failureClass === "candidate-digest-mismatch")
    assert(
      payload.registry.integrity !== expected.integrity ||
        payload.registry.tarballSha256 !== expected.candidateTarballSha256,
      "Digest-mismatch incident contains the exact candidate",
    );
  else
    assert(
      payload.registry.integrity === expected.integrity &&
        payload.registry.tarballSha256 === expected.candidateTarballSha256,
      "Control-drift incident mixes a candidate digest mismatch",
    );
  validateGithubRelease(
    payload.githubRelease,
    expected,
    { draft: false, immutable: true },
    ledger,
  );
  digest(payload.recoveryPlanDigest, "incident recovery plan");
  digest(payload.incidentManifestDigest, "incident manifest");
  assert(
    payload.readyManifestDigest === ledger.readyManifestDigest,
    "Incident does not bind the ready manifest",
  );
}

function validateNpmQuarantine(quarantine, expected, ledger) {
  assertExactKeys(
    quarantine,
    [
      "ownerCeremonyDigest",
      "deprecationResultDigest",
      "versionDeprecated",
      "alpha",
      "distTags",
      "distTagsDigest",
      "pendingStagesAbsent",
    ],
    "npm quarantine evidence",
  );
  digest(quarantine.ownerCeremonyDigest, "npm quarantine owner ceremony");
  digest(
    quarantine.deprecationResultDigest,
    "npm quarantine deprecation result",
  );
  assertExactKeys(
    quarantine.alpha,
    ["state", "version", "authorizationDigest"],
    "npm quarantine alpha state",
  );
  const alphaAbsent = quarantine.alpha.state === "absent";
  const alphaSafe = quarantine.alpha.state === "safe-mapping";
  assert(
    (alphaAbsent &&
      quarantine.alpha.version === null &&
      quarantine.alpha.authorizationDigest === null) ||
      (alphaSafe &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(quarantine.alpha.version) &&
        quarantine.alpha.version !== expected.package.version &&
        SHA256_PATTERN.test(quarantine.alpha.authorizationDigest)),
    "npm quarantine alpha channel still selects the quarantined version",
  );
  assert(
    quarantine.versionDeprecated === true &&
      quarantine.pendingStagesAbsent === true,
    "npm quarantine terminal state drifted",
  );
  validateDistTags(
    quarantine.distTags,
    quarantine.distTagsDigest,
    "npm quarantine tags",
  );
  const preserveOtherTags = (tags) =>
    Object.fromEntries(
      Object.entries(tags).filter(([tag]) => tag !== expected.package.distTag),
    );
  assert(
    canonicalJson(preserveOtherTags(quarantine.distTags)) ===
      canonicalJson(preserveOtherTags(ledger.prepublicationDistTags)),
    "npm quarantine mutated a non-authorized dist-tag",
  );
}

function validateDraftQuarantine(payload, expected, ledger) {
  const postpublication = payload.failureClass.startsWith("postpublication-");
  const ambiguousRegistry =
    payload.failureClass === "postpublication-registry-ambiguous";
  assertExactKeys(
    payload,
    [
      "failureClass",
      "ownerCheckpointDigest",
      "pendingStagesCheckpointDigest",
      "recoveryPlanDigest",
      "githubRelease",
      ...(postpublication
        ? [
            ambiguousRegistry ? "registryObservationDigest" : "registry",
            "npmQuarantine",
          ]
        : []),
    ],
    "draft quarantine payload",
  );
  assert(
    [
      "missing-stage-response",
      "ambiguous-stage-response",
      "prepublication-drift",
      "postpublication-exact-verification-failed",
      "postpublication-candidate-mismatch",
      "postpublication-registry-ambiguous",
    ].includes(payload.failureClass),
    "Draft quarantine failure class drifted",
  );
  digest(payload.ownerCheckpointDigest, "quarantine owner checkpoint");
  digest(
    payload.pendingStagesCheckpointDigest,
    "quarantine pending-stage checkpoint",
  );
  digest(payload.recoveryPlanDigest, "quarantine recovery plan");
  if (postpublication) {
    if (ambiguousRegistry)
      digest(payload.registryObservationDigest, "ambiguous registry response");
    else {
      const candidateMismatch =
        payload.failureClass === "postpublication-candidate-mismatch";
      validateRegistry(payload.registry, expected, ledger, {
        allowCandidateMismatch: candidateMismatch,
      });
      if (candidateMismatch)
        assert(
          payload.registry.integrity !== expected.integrity ||
            payload.registry.tarballSha256 !== expected.candidateTarballSha256,
          "Postpublication candidate-mismatch quarantine contains the exact candidate",
        );
    }
    validateNpmQuarantine(payload.npmQuarantine, expected, ledger);
  }
  validateGithubRelease(
    payload.githubRelease,
    expected,
    { draft: true, immutable: false },
    ledger,
  );
  ledger.quarantineFailureClass = payload.failureClass;
  ledger.quarantineRecoveryPlanDigest = payload.recoveryPlanDigest;
  ledger.quarantineEvidenceDigest = sha256(canonicalJson(payload));
}

function validateTerminalPayload(transition, payload, expected, ledger) {
  if (transition === "completion-public-registry-verified") {
    assertExactKeys(
      payload,
      ["classification", "registry", "githubRelease", "readyManifestDigest"],
      "completion payload",
    );
    assert(
      payload.classification === "verified-success",
      "Completion classification drifted",
    );
    assert(
      payload.readyManifestDigest === ledger.readyManifestDigest,
      "Completion does not bind the ready manifest",
    );
    validateRegistry(payload.registry, expected, ledger);
    validateGithubRelease(
      payload.githubRelease,
      expected,
      { draft: false, immutable: true },
      ledger,
    );
    return;
  }
  if (transition === "completion-already-immutable") {
    assertExactKeys(
      payload,
      [
        "classification",
        "registry",
        "githubRelease",
        "readyManifestDigest",
        "reconciliationDigest",
      ],
      "already-immutable payload",
    );
    assert(
      payload.classification === "exact-already-published",
      "Already-published classification drifted",
    );
    assert(
      payload.readyManifestDigest === ledger.readyManifestDigest,
      "Already-immutable completion does not bind the ready manifest",
    );
    validateRegistry(payload.registry, expected, ledger);
    validateGithubRelease(
      payload.githubRelease,
      expected,
      { draft: false, immutable: true },
      ledger,
    );
    digest(payload.reconciliationDigest, "already-immutable reconciliation");
    return;
  }
  if (transition === "quarantine-still-draft") {
    validateDraftQuarantine(payload, expected, ledger);
    return;
  }
  if (transition === "quarantine-immutable-prerelease") {
    assertExactKeys(
      payload,
      [
        "failureClass",
        "recoveryPlanDigest",
        "quarantineEvidenceDigest",
        "finalManifestDigest",
        "githubRelease",
      ],
      "immutable quarantine payload",
    );
    assert(
      payload.failureClass === ledger.quarantineFailureClass &&
        payload.recoveryPlanDigest === ledger.quarantineRecoveryPlanDigest &&
        payload.quarantineEvidenceDigest === ledger.quarantineEvidenceDigest,
      "Immutable quarantine does not continue the active recovery",
    );
    digest(payload.finalManifestDigest, "quarantined final manifest");
    validateGithubRelease(
      payload.githubRelease,
      expected,
      { draft: false, immutable: true },
      ledger,
    );
    return;
  }
  validateIncidentPayload(payload, expected, ledger);
}

function validateTransactionRecord(record, expected, ledger) {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "authority",
      "sequence",
      "previousDigest",
      "transition",
      "candidateManifestDigest",
      "sourceRevision",
      "protectedTag",
      "simulation",
      "payload",
      "digest",
    ],
    "transaction record",
  );
  assert(
    record.schemaVersion === 1 &&
      record.authority === AUTHORITY &&
      record.simulation === true &&
      Number.isSafeInteger(record.sequence) &&
      record.sequence === expected.sequence &&
      record.previousDigest === expected.previousDigest &&
      record.candidateManifestDigest === expected.candidateManifestDigest &&
      record.sourceRevision === expected.sourceRevision &&
      record.protectedTag === expected.protectedTag,
    `Synthetic transaction identity drifted at sequence ${expected.sequence}`,
  );
  const unsigned = { ...record };
  delete unsigned.digest;
  assert(
    record.digest === sha256(canonicalJson(unsigned)),
    `Transaction digest mismatch at sequence ${record.sequence}`,
  );
  if (record.transition === "draft-prepared")
    Object.assign(ledger, validateDraftPayload(record.payload, expected));
  else if (record.transition === "stage-recorded")
    ledger.stageId = validateStagePayload(record.payload, expected);
  else if (record.transition === "ready-to-publish") {
    validateReadyPayload(record.payload, expected, ledger);
    ledger.readyManifestDigest = record.digest;
  } else if (record.transition === "quarantine-still-draft")
    validateTerminalPayload(
      record.transition,
      record.payload,
      expected,
      ledger,
    );
  else if (terminalTransitions.has(record.transition))
    validateTerminalPayload(
      record.transition,
      record.payload,
      expected,
      ledger,
    );
  else throw new Error(`Unknown transaction transition: ${record.transition}`);
}

export function validateSyntheticReleaseRecords(recordSet, observed) {
  assertExactKeys(
    recordSet,
    [
      "schemaVersion",
      "mode",
      "package",
      "candidateManifestDigest",
      "candidateTarballSha256",
      "integrity",
      "applicableProbeDigest",
      "workflowDigest",
      "releaseScripts",
      "sourceRevision",
      "protectedTag",
      "probe",
      "transactions",
    ],
    "release record set",
  );
  assertExactKeys(
    recordSet.package,
    ["name", "version", "releaseClass", "distTag"],
    "release package",
  );
  assert(
    recordSet.schemaVersion === 1 &&
      recordSet.mode === "synthetic-nonpublishing-rehearsal" &&
      recordSet.package.name === "agentscope-cli" &&
      recordSet.package.version === "0.1.0" &&
      recordSet.package.releaseClass === "alpha" &&
      recordSet.package.distTag === "alpha" &&
      SHA256_PATTERN.test(recordSet.candidateManifestDigest) &&
      SHA256_PATTERN.test(recordSet.candidateTarballSha256) &&
      SRI_PATTERN.test(recordSet.integrity) &&
      SHA256_PATTERN.test(recordSet.applicableProbeDigest) &&
      SOURCE_REVISION_PATTERN.test(recordSet.sourceRevision) &&
      recordSet.protectedTag === "v0.1.0",
    "Synthetic release record-set identity drifted",
  );
  assert(
    recordSet.workflowDigest === sha256(observed.workflowBytes),
    "Record-set workflow digest does not bind observed bytes",
  );
  validateReleaseScripts(recordSet.releaseScripts, observed.releaseScripts);
  validateProbe(recordSet.probe, recordSet, observed);
  assert(
    Array.isArray(recordSet.transactions) && recordSet.transactions.length >= 2,
    "Synthetic transaction chain is incomplete",
  );
  let previousDigest = `sha256:${"0".repeat(64)}`;
  let previousTransition;
  const ledger = {};
  for (const [index, record] of recordSet.transactions.entries()) {
    validateTransactionRecord(
      record,
      {
        ...recordSet,
        sequence: index + 1,
        previousDigest,
      },
      ledger,
    );
    if (index === 0)
      assert(
        record.transition === "draft-prepared",
        "Transaction must start at draft-prepared",
      );
    else
      assert(
        transitions.get(previousTransition)?.has(record.transition),
        `Invalid transaction transition: ${previousTransition} -> ${record.transition}`,
      );
    assert(
      !terminalTransitions.has(previousTransition),
      "Transaction continued after a terminal record",
    );
    previousDigest = record.digest;
    previousTransition = record.transition;
  }
  assert(
    terminalTransitions.has(previousTransition),
    "Transaction chain lacks a terminal record",
  );
  return Object.freeze({
    records: recordSet.transactions.length,
    terminalTransition: previousTransition,
  });
}

export const syntheticReleaseAuthority = AUTHORITY;
