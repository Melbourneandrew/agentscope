import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyManifestEvidence, type CapabilityManifest } from "./manifest.js";

const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestFixture = (): CapabilityManifest =>
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ) as CapabilityManifest;

const withPrivateEvidence = (
  manifest: CapabilityManifest,
  check: (root: string) => void,
): void => {
  const workspace = mkdtempSync(
    join(tmpdir(), "agentscope-manifest-evidence-"),
  );
  const root = join(workspace, "tests", "integration");
  const artifacts = new Set<string>();
  try {
    for (const evidence of manifest.evidence) {
      artifacts.add(
        join("tests/integration", evidence.descriptorArtifact.path),
      );
      if (evidence.admission !== undefined)
        for (const artifact of [
          evidence.admission.component.fixture,
          evidence.admission.component.adapterArtifact,
          evidence.admission.component.mappingArtifact,
        ])
          artifacts.add(artifact.path);
    }
    for (const scenario of manifest.scenarios) {
      for (const artifact of [
        scenario.fixtureAdapter,
        scenario.scenarioOracle,
        scenario.scenarioProcess,
        ...scenario.runtimeArtifacts.map(({ source }) => ({
          path:
            source.kind === "integration"
              ? source.path
              : `../../${source.path}`,
        })),
      ])
        artifacts.add(join("tests/integration", artifact.path));
    }
    expect(artifacts.size).toBeLessThanOrEqual(128);
    for (const path of artifacts) {
      const target = resolve(workspace, path);
      const source = resolve(integrationRoot, "../..", path);
      const status = lstatSync(source);
      expect(status.isFile()).toBe(true);
      expect(status.size).toBeLessThanOrEqual(16_777_216);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
    }
    verifyManifestEvidence(manifest, root);
    check(root);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    expect(existsSync(workspace)).toBe(false);
  }
};

describe("private manifest evidence mutation", () => {
  it.each([
    "descriptorArtifact",
    "fixtureAdapter",
    "scenarioOracle",
    "scenarioProcess",
    "descriptor contradiction",
  ] as const)(
    "detects %s mutation without changing repository evidence",
    (kind) => {
      const original = manifestFixture();
      const artifact =
        kind === "descriptorArtifact" || kind === "descriptor contradiction"
          ? original.evidence[0]!.descriptorArtifact
          : original.scenarios[0]![kind];
      const canonicalPath = resolve(integrationRoot, artifact.path);
      const bytes = readFileSync(canonicalPath);
      withPrivateEvidence(original, (root) => {
        const privatePath = resolve(root, artifact.path);
        const privateIdentity = lstatSync(privatePath);
        const canonicalIdentity = lstatSync(canonicalPath);
        expect([privateIdentity.dev, privateIdentity.ino]).not.toEqual([
          canonicalIdentity.dev,
          canonicalIdentity.ino,
        ]);
        const manifest = structuredClone(original);
        let mutated = `${bytes.toString("utf8")}\n`;
        if (kind === "descriptor contradiction") {
          const descriptor = JSON.parse(bytes.toString("utf8")) as {
            harnessId: string;
          };
          descriptor.harnessId = "other-harness";
          mutated = `${JSON.stringify(descriptor, undefined, 2)}\n`;
          manifest.evidence[0]!.descriptorArtifact.sha256 = createHash("sha256")
            .update(mutated)
            .digest("hex");
        }
        writeFileSync(privatePath, mutated);
        expect(readFileSync(canonicalPath)).toEqual(bytes);
        verifyManifestEvidence(original, integrationRoot);
        expect(() => {
          verifyManifestEvidence(manifest, root);
        }).toThrow(
          kind === "descriptor contradiction"
            ? "integration.manifest.evidence-contract"
            : "integration.manifest.evidence-digest",
        );
        expect(readFileSync(canonicalPath)).toEqual(bytes);
      });
    },
  );
});
