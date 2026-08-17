import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";

const criterionPattern = /\*\*(AC-[A-Z]+-\d{3}\.\d+):\*\*\s+([^\n]+)/gu;
const requirementLevelPattern = /\bthe system (shall|should|may)\b/u;
const ownerPattern = /^agentscope-[a-z0-9]+(?:\.\d+)*$/u;
const evidenceKinds = new Set(["automated-test", "manual-verification"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

export function discoverMandatoryCriteria(requirementsDirectory) {
  const discovered = new Map();
  const files = readdirSync(requirementsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => entry.name)
    .sort();

  for (const file of files) {
    const content = readFileSync(resolve(requirementsDirectory, file), "utf8");
    for (const match of content.matchAll(criterionPattern)) {
      const [, id, statement] = match;
      if (!id || !statement) continue;
      const requirementLevel = requirementLevelPattern.exec(statement)?.[1];
      assert(
        requirementLevel !== undefined,
        `Criterion ${id} does not declare a Software Factory requirement level`,
      );
      if (requirementLevel !== "shall") continue;
      assert(
        !discovered.has(id),
        `Duplicate mandatory criterion in FRDs: ${id}`,
      );
      discovered.set(id, file);
    }
  }
  return discovered;
}

function criterionPrefix(id) {
  return id.split("-")[1];
}

function validateOwnershipRules(entries, discovered) {
  assert(Array.isArray(entries), "Manifest ownership must be an array");
  const prefixes = entries.map((entry) => entry?.prefix);
  const duplicateIds = duplicates(prefixes);
  assert(
    duplicateIds.length === 0,
    `Duplicate ownership prefixes: ${duplicateIds.join(", ")}`,
  );

  const knownPrefixes = new Set(
    [...discovered.keys()].map((id) => criterionPrefix(id)),
  );
  const configuredPrefixes = new Set(prefixes);
  const missing = [...knownPrefixes].filter(
    (prefix) => !configuredPrefixes.has(prefix),
  );
  const unknown = prefixes.filter((prefix) => !knownPrefixes.has(prefix));
  assert(
    missing.length === 0,
    `Missing mandatory criterion ownership: ${missing.join(", ")}`,
  );
  assert(
    unknown.length === 0,
    `Unknown ownership prefixes: ${unknown.join(", ")}`,
  );

  for (const entry of entries) {
    assert(
      Array.isArray(entry.owners) && entry.owners.length > 0,
      `Criterion family ${String(entry?.prefix)} must have a delivery owner`,
    );
    assert(
      entry.owners.every((owner) => ownerPattern.test(owner)),
      `Criterion family ${entry.prefix} has an invalid delivery owner`,
    );
    assert(
      duplicates(entry.owners).length === 0,
      `Criterion family ${entry.prefix} has duplicate delivery owners`,
    );
  }
  return new Set(discovered.keys());
}

function resolveEvidencePath(workspaceRoot, relativePath) {
  assert(
    typeof relativePath === "string" && relativePath.length > 0,
    "Evidence path must be a non-empty string",
  );
  const absolutePath = resolve(workspaceRoot, relativePath);
  assert(
    absolutePath.startsWith(`${resolve(workspaceRoot)}${sep}`),
    `Evidence path escapes the workspace: ${relativePath}`,
  );
  return absolutePath;
}

function validateEvidenceEntries(entries, criteria, workspaceRoot) {
  assert(Array.isArray(entries), "Manifest evidence must be an array");
  const evidenceIds = entries.map((entry) => entry?.id);
  const duplicateIds = duplicates(evidenceIds);
  assert(
    duplicateIds.length === 0,
    `Duplicate evidence IDs: ${duplicateIds.join(", ")}`,
  );

  const covered = new Set();
  for (const entry of entries) {
    assert(
      typeof entry?.id === "string" && entry.id.length > 0,
      "Evidence ID must be a non-empty string",
    );
    assert(
      evidenceKinds.has(entry.kind),
      `Evidence ${entry.id} has an invalid kind`,
    );
    assert(
      Array.isArray(entry.criteria) && entry.criteria.length > 0,
      `Orphaned evidence ${entry.id} has no criterion references`,
    );
    assert(
      duplicates(entry.criteria).length === 0,
      `Evidence ${entry.id} has duplicate criterion references`,
    );
    const evidencePath = resolveEvidencePath(workspaceRoot, entry.path);
    assert(
      existsSync(evidencePath),
      `Evidence ${entry.id} path does not exist`,
    );
    const content = readFileSync(evidencePath, "utf8");
    for (const criterionId of entry.criteria) {
      assert(
        criteria.has(criterionId),
        `Evidence ${entry.id} references unknown criterion ${criterionId}`,
      );
      assert(
        content.includes(criterionId),
        `Evidence ${entry.id} path does not cite ${criterionId}`,
      );
      covered.add(criterionId);
    }
  }
  return covered;
}

export function validateAcceptanceEvidence({
  manifest,
  requirementsDirectory,
  workspaceRoot,
  requireVerified = false,
}) {
  assert(manifest?.schemaVersion === 1, "Unsupported evidence schemaVersion");
  const discovered = discoverMandatoryCriteria(requirementsDirectory);
  const criteria = validateOwnershipRules(manifest.ownership, discovered);
  const covered = validateEvidenceEntries(
    manifest.evidence,
    criteria,
    workspaceRoot,
  );

  for (const id of criteria) {
    const isCovered = covered.has(id);
    assert(
      !requireVerified || isCovered,
      `Criterion ${id} has no verified evidence`,
    );
  }
  return {
    mandatory: discovered.size,
    planned: discovered.size - covered.size,
    verified: covered.size,
  };
}
