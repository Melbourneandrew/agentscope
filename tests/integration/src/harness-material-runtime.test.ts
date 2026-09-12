import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectPreparedHarnessMaterial,
  inspectPreparedNpmHarnessMaterial,
  prepareHarnessMaterial,
  prepareNpmHarnessMaterial,
  retirePreparedHarnessMaterial,
  retirePreparedNpmHarnessMaterial,
  stagePreparedHarnessMaterial,
  stagePreparedNpmHarnessMaterial,
  type PreparedNpmHarnessMaterial,
} from "../harness-material.mjs";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(resolve(tmpdir(), "agentscope-harness-material-"));
  chmodSync(path, 0o700);
  roots.push(path);
  return path;
};
const forged = (): PreparedNpmHarnessMaterial =>
  Object.freeze({
    authorityKind: "authenticated-harness-material",
    authorityVersion: 1,
  }) as PreparedNpmHarnessMaterial;

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { force: true, recursive: true });
});

describe("authenticated harness material runtime", () => {
  it("rejects cloned tokens before inspection, staging, or retirement", () => {
    const token = forged();
    const target = resolve(root(), "target");
    expect(() => inspectPreparedNpmHarnessMaterial(token)).toThrow(
      "integration.harness-material.failed",
    );
    expect(() => {
      stagePreparedNpmHarnessMaterial(token, target);
    }).toThrow("integration.harness-material.failed");
    expect(existsSync(target)).toBe(false);
    expect(() => {
      retirePreparedNpmHarnessMaterial(token);
    }).toThrow("integration.harness-material.failed");
    expect(() => inspectPreparedHarnessMaterial(token)).toThrow(
      "integration.harness-material.failed",
    );
    expect(() => {
      stagePreparedHarnessMaterial(token, target);
    }).toThrow("integration.harness-material.failed");
    expect(() => {
      retirePreparedHarnessMaterial(token);
    }).toThrow("integration.harness-material.failed");
  });

  it("rejects an already-aborted acquisition without network or residue", async () => {
    const privateRoot = root();
    await expect(
      prepareNpmHarnessMaterial({
        dockerClient: {} as never,
        evidenceId: "fixture",
        material: {
          kind: "npm",
          platformIdentity: `sha256-${"9".repeat(64)}`,
          verifierImage: `node@sha256:${"f".repeat(64)}`,
          registry: "https://registry.npmjs.org/",
          packages: [],
          provenance: {
            repository: "https://github.com/vendor/tool",
            sourceCommit: "a".repeat(40),
            tag: "v1.0.0",
            workflowPath: ".github/workflows/release.yml",
          },
        },
        maximumMilliseconds: 1_000,
        privateRoot,
        runId: "0123456789abcdef",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("integration.harness-material.failed");
    expect(existsSync(resolve(privateRoot, "harness-fixture"))).toBe(false);
  });

  it("rejects an aborted signed-manifest acquisition before network", async () => {
    const privateRoot = root();
    const object = (name: string) => ({
      url: `https://downloads.vendor.invalid/${name}`,
      bytes: 1,
      sha256: "a".repeat(64),
    });
    await expect(
      prepareHarnessMaterial({
        dockerClient: {} as never,
        evidenceId: "signed-fixture",
        material: {
          kind: "signed-release-manifest",
          distributionId: "vendor-tool",
          version: "2.1.89",
          platform: "linux-x64",
          platformIdentity: `sha256-${"9".repeat(64)}`,
          verifierImage: `node@sha256:${"f".repeat(64)}`,
          binary: { ...object("tool"), executableName: "tool" },
          manifest: object("manifest.json"),
          signature: object("manifest.json.sig"),
          signingKey: {
            ...object("release.asc"),
            fingerprint: "A".repeat(40),
            signerFingerprint: "A".repeat(40),
            signatureHashAlgorithm: "sha512",
            uid: "Vendor Release Signing <security@vendor.invalid>",
          },
        },
        maximumMilliseconds: 1_000,
        privateRoot,
        runId: "0123456789abcdef",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("integration.harness-material.failed");
    expect(existsSync(resolve(privateRoot, "harness-signed-fixture"))).toBe(
      false,
    );
  });
});
