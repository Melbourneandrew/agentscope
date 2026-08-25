import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const allowedBehaviors = [
  "LSA-001-explicit-opt-in-and-persistence-disclosure",
  "LSA-002-first-admitted-schema-only",
  "LSA-003-wal-and-bounded-busy-timeout",
  "LSA-004-concurrent-hook-writes-and-delivery-deduplication",
  "LSA-005-durable-redacted-protocol-payload",
  "LSA-006-basic-search-and-get",
  "LSA-007-unconfigure-preserves-database",
  "LSA-008-busy-full-corrupt-fail-open-sanitized-results",
  "LSA-009-bounded-read-only-doctor-evidence",
  "LSA-010-existing-upgrade-and-recovery-findings",
  "LSA-011-actual-harness-capture-report-search-get-admission",
];

const deferredStableObligations = [
  "broad-native-platform-certification",
  "deep-schema-compatibility-admission",
  "database-integrity-admission",
  "database-capacity-admission",
  "effective-writability-admission",
  "historical-migration-certification",
  "backup-and-restore-command-certification",
  "automated-retention-certification",
  "confirmed-destructive-deletion-certification",
  "corruption-recovery-certification",
  "hostile-replacement-hardening-certification",
  "full-local-sqlite-support-claim",
];

const stableCriteria = [
  ...[1, 2, 3, 4].map((suffix) => `AC-SQL-001.${suffix}`),
  ...[1, 2, 3, 4, 5, 6].map((suffix) => `AC-SQL-002.${suffix}`),
  ...[1, 2, 3].map((suffix) => `AC-SQL-003.${suffix}`),
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactArray(actual, expected, name) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${name} does not match the governed 0.1.0 profile`,
  );
}

function workspacePath(workspaceRoot, relativePath) {
  assert(
    typeof relativePath === "string" && relativePath.length > 0,
    "Profile path must be a non-empty string",
  );
  const root = resolve(workspaceRoot);
  const path = resolve(root, relativePath);
  assert(
    path.startsWith(`${root}${sep}`),
    `Profile path escapes: ${relativePath}`,
  );
  assert(existsSync(path), `Profile path does not exist: ${relativePath}`);
  return path;
}

function validateClaimBoundary(profile) {
  assert(profile?.schemaVersion === 1, "Unsupported profile schemaVersion");
  assert(
    profile.profileId === "agentscope.local-sqlite.alpha-0.1.0.v1",
    "Unexpected profile identity",
  );
  assert(
    profile.release?.package === "agentscope-cli" &&
      profile.release.version === "0.1.0" &&
      profile.release.channel === "alpha" &&
      profile.release.claim ===
        "experimental-opt-in-not-full-local-sqlite-support",
    "Release claim boundary drifted",
  );
  assert(
    profile.authority?.bead === "agentscope-rk8.5" &&
      profile.authority.kind === "milestone-release-claim-narrowing" &&
      profile.authority.requirementsDisposition ===
        "preserved-unchanged-not-promoted" &&
      profile.authority.blueprintDisposition === "preserved-unchanged",
    "Release-profile authority drifted",
  );
  assert(
    profile.nativeAdmission?.disposition ===
      "proposed-unpublished-execution-eligible" &&
      profile.nativeAdmission.platformId ===
        "linux-x64-node22-ci-ext4-proposed" &&
      profile.nativeAdmission.claim ===
        "one-synthetic-evidence-tuple-not-broad-platform-support",
    "Native evidence claim drifted",
  );
  assert(
    profile.doctorBoundary?.sqliteOpen === false &&
      profile.doctorBoundary.claim ===
        "bounded-read-only-lifecycle-file-header-and-database-presence-evidence" &&
      profile.doctorBoundary.deepSchemaCompatibility === "deferred" &&
      profile.doctorBoundary.integrity === "deferred" &&
      profile.doctorBoundary.capacity === "deferred" &&
      profile.doctorBoundary.effectiveWritability === "deferred",
    "Doctor claim exceeds the approved no-SQLite-open boundary",
  );
  exactArray(
    profile.doctorBoundary.databaseStates,
    ["present", "missing", "unavailable"],
    "Doctor database states",
  );
  exactArray(profile.allowedBehaviors, allowedBehaviors, "Allowed behaviors");
  exactArray(
    profile.deferredStableObligations,
    deferredStableObligations,
    "Deferred stable obligations",
  );
  exactArray(
    profile.stableCriteriaPreserved,
    stableCriteria,
    "Stable criteria",
  );
}

function validateComponentEvidence(profile, workspaceRoot) {
  assert(Array.isArray(profile.evidence), "Profile evidence must be an array");
  const observedClaims = [];
  for (const entry of profile.evidence) {
    assert(
      entry?.positiveAndNegative === true,
      "Evidence must include failure coverage",
    );
    assert(
      [
        "exact-packed-cli",
        "built-destination-artifact",
        "built-native-production-composition",
      ].includes(entry.layer),
      `Unknown evidence layer: ${String(entry?.layer)}`,
    );
    const content = readFileSync(
      workspacePath(workspaceRoot, entry.path),
      "utf8",
    );
    assert(
      Array.isArray(entry.claims) && entry.claims.length > 0,
      "Empty evidence claim",
    );
    for (const claim of entry.claims) {
      assert(
        content.includes(claim),
        `Evidence ${entry.path} does not cite ${claim}`,
      );
      observedClaims.push(claim);
    }
  }
  exactArray(
    observedClaims.sort(),
    allowedBehaviors
      .filter((claim) => claim !== profile.consumedEvidenceClaim)
      .sort(),
    "Component evidence claims",
  );
  return observedClaims.length;
}

function validateAdmission(profile, workspaceRoot, requireCertified) {
  assert(
    profile.consumedEvidenceClaim ===
      "LSA-011-actual-harness-capture-report-search-get-admission",
    "Consumed evidence claim drifted",
  );
  assert(
    Array.isArray(profile.admission?.blockingBeads) &&
      Array.isArray(profile.admission.consumedEvidence),
    "Consumed-evidence admission boundary drifted",
  );
  if (profile.admission.state === "certified") {
    assert(
      profile.admission.blockingBeads.length === 0 &&
        profile.admission.consumedEvidence.length >= 2 &&
        new Set(profile.admission.consumedEvidence).size ===
          profile.admission.consumedEvidence.length,
      "Certified admission lacks both governed evidence bundles",
    );
    for (const path of profile.admission.consumedEvidence) {
      const content = readFileSync(workspacePath(workspaceRoot, path), "utf8");
      assert(
        content.includes(profile.consumedEvidenceClaim),
        `Consumed evidence does not cite ${profile.consumedEvidenceClaim}: ${path}`,
      );
    }
  } else {
    assert(
      profile.admission.state ===
        "blocked-pending-consumed-actual-harness-evidence" &&
        JSON.stringify(profile.admission.blockingBeads) ===
          JSON.stringify(["agentscope-wth.5", "agentscope-vah.11.12"]) &&
        profile.admission.consumedEvidence.length === 0,
      "Unknown or ambiguous profile admission state",
    );
  }
  assert(
    !requireCertified || profile.admission.state === "certified",
    "Experimental Local SQLite profile is not certified: governed actual-harness evidence is pending",
  );
}

function validateDocumentationAndNativeClaim(profile, workspaceRoot) {
  assert(
    Array.isArray(profile.claimBoundaryDocumentation) &&
      profile.claimBoundaryDocumentation.length === 2,
    "Experimental claim documentation drifted",
  );
  for (const path of profile.claimBoundaryDocumentation) {
    const content = readFileSync(workspacePath(workspaceRoot, path), "utf8");
    assert(
      /experimental, explicit opt-in/u.test(content) &&
        /not full Local SQLite support/u.test(content),
      `Documentation does not preserve the experimental boundary: ${path}`,
    );
  }

  const supportManifest = JSON.parse(
    readFileSync(
      workspacePath(
        workspaceRoot,
        "packages/destinations/local-sqlite/native-candidate/files/records/support-manifest.json",
      ),
      "utf8",
    ),
  );
  assert(
    supportManifest.disposition === profile.nativeAdmission.disposition &&
      supportManifest.supportedPlatforms?.length === 1 &&
      supportManifest.supportedPlatforms[0]?.platformId ===
        profile.nativeAdmission.platformId,
    "Native support manifest exceeds the proposed evidence tuple",
  );
}

export function validateLocalSqliteAlphaProfile({
  profile,
  workspaceRoot,
  requireCertified = false,
}) {
  validateClaimBoundary(profile);
  const componentEvidence = validateComponentEvidence(profile, workspaceRoot);
  validateAdmission(profile, workspaceRoot, requireCertified);
  validateDocumentationAndNativeClaim(profile, workspaceRoot);

  return Object.freeze({
    admission: profile.admission.state,
    allowed: allowedBehaviors.length,
    componentEvidence,
    deferred: deferredStableObligations.length,
    stableCriteriaPreserved: stableCriteria.length,
  });
}
