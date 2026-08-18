import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareCandidate, verifyPreparedCandidate } from "./artifacts.js";

const candidateInput = (root: string) => {
  const tarball = join(root, "agentscope-cli-0.1.0.tgz");
  const runtime = join(root, "mock-runtime.tar.gz");
  const lockfile = join(root, "pnpm-lock.yaml");
  writeFileSync(tarball, "packed-cli");
  writeFileSync(runtime, "runtime-archive");
  writeFileSync(lockfile, "lockfileVersion: '9.0'\n");
  return {
    candidateRevision: "a".repeat(40),
    platform: { os: "linux", architecture: "x64", nodeVersion: "22.18.0" },
    lockfilePath: lockfile,
    outputRoot: join(root, "prepared"),
    artifacts: [
      { id: "agentscope-cli", kind: "npm-tarball" as const, path: tarball },
      { id: "mock-runtime", kind: "runtime-archive" as const, path: runtime },
    ],
  };
};

describe("offline candidate preparation", () => {
  it("snapshots every allowed input and reuses a verified immutable bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-candidate-"));
    try {
      const input = candidateInput(root);
      const first = prepareCandidate(input);
      const second = prepareCandidate(input);
      expect(second.directory).toBe(first.directory);
      expect(second.evidence).toEqual(first.evidence);
      expect(first.evidence.scenarioNetworkPolicy).toBe(
        "offline-no-package-or-registry-download",
      );
      expect(first.evidence.artifacts.map(({ id }) => id)).toEqual([
        "agentscope-cli",
        "mock-runtime",
      ]);
      expect(Object.isFrozen(verifyPreparedCandidate(first.directory))).toBe(
        true,
      );
      const extra = join(first.directory, "files", "undeclared.bin");
      writeFileSync(extra, "undeclared");
      expect(() => verifyPreparedCandidate(first.directory)).toThrow(
        "integration.artifact.prepared-inventory",
      );
      rmSync(extra);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("detects prepared payload and evidence tampering", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-candidate-"));
    try {
      const prepared = prepareCandidate(candidateInput(root));
      const cli = prepared.evidence.artifacts.find(
        ({ id }) => id === "agentscope-cli",
      );
      expect(cli).toBeDefined();
      writeFileSync(
        join(prepared.directory, "files", cli!.fileName),
        "tampered",
      );
      expect(() => verifyPreparedCandidate(prepared.directory)).toThrow(
        /integration\.artifact\.prepared/u,
      );
      const evidencePath = join(prepared.directory, "evidence.json");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        candidateRevision: string;
      };
      evidence.candidateRevision = "b".repeat(40);
      writeFileSync(evidencePath, JSON.stringify(evidence));
      expect(() => verifyPreparedCandidate(prepared.directory)).toThrow(
        "integration.artifact.identity",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("offline candidate rejection", () => {
  it("rejects missing CLI, duplicates, malformed inputs, and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-candidate-"));
    try {
      const input = candidateInput(root);
      expect(() => prepareCandidate({ ...input, artifacts: [] })).toThrow(
        "integration.artifact.count",
      );
      expect(() =>
        prepareCandidate({
          ...input,
          artifacts: [input.artifacts[1]!],
        }),
      ).toThrow("integration.artifact.inventory");
      expect(() =>
        prepareCandidate({
          ...input,
          artifacts: [input.artifacts[0]!, input.artifacts[0]!],
        }),
      ).toThrow("integration.artifact.inventory");
      const reserved = join(root, "reserved.yaml");
      writeFileSync(reserved, "reserved");
      expect(() =>
        prepareCandidate({
          ...input,
          artifacts: [
            input.artifacts[0]!,
            { id: "pnpm-lock", kind: "runtime-archive", path: reserved },
          ],
        }),
      ).toThrow("integration.artifact.inventory");
      expect(() =>
        prepareCandidate({ ...input, candidateRevision: "not-a-revision" }),
      ).toThrow("integration.artifact.input");
      const link = join(root, "linked.tgz");
      symlinkSync(input.artifacts[0]!.path, link);
      expect(() =>
        prepareCandidate({
          ...input,
          artifacts: [{ ...input.artifacts[0]!, path: link }],
        }),
      ).toThrow("integration.artifact.file");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects invalid lockfiles and malformed prepared evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-candidate-"));
    try {
      const input = candidateInput(root);
      const wrongLock = join(root, "other-lock.yaml");
      writeFileSync(wrongLock, "value");
      expect(() =>
        prepareCandidate({ ...input, lockfilePath: wrongLock }),
      ).toThrow("integration.artifact.lockfile");
      const missing = join(root, "missing");
      mkdirSync(missing);
      writeFileSync(join(missing, "evidence.json"), "{}\n");
      expect(() => verifyPreparedCandidate(missing)).toThrow(
        "integration.artifact.evidence",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
