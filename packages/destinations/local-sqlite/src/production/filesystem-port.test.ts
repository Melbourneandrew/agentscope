import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createLocalSqliteFilesystemGatePort,
  currentProcessStartIdentity,
  ensurePrivateDirectory,
  processStartIdentity,
} from "./filesystem-port.js";

type Mutation =
  | Readonly<{ state: "created" | "replaced"; physicalIdentity: string }>
  | Readonly<{ state: "exists" | "mismatch" }>;
type ConcreteGate = Readonly<{
  classifyOwner: (
    input: Readonly<{
      owner: Readonly<{ pid: number; startIdentity: string }>;
    }>,
  ) => Readonly<{ state: "dead" | "indeterminate" | "live" }>;
  createFenceDurably: (
    input: Readonly<{
      filename: string;
      content: string;
    }>,
  ) => Mutation;
  createLeaseDurably: (
    input: Readonly<{
      filename: string;
      content: string;
    }>,
  ) => Mutation;
  createRecoveryClaim: (
    input: Readonly<{
      claimName: string;
      leaseName: string;
      leasePhysicalIdentity: string;
    }>,
  ) => Mutation;
  listLifecycle: () => Readonly<{
    entries: readonly Readonly<{
      name: string;
      bytes: number;
      physicalIdentity: string;
    }>[];
  }>;
  readArtifact: (input: Readonly<{ filename: string }>) =>
    | Readonly<{ state: "absent" }>
    | Readonly<{
        state: "present";
        content: string;
        physicalIdentity: string;
      }>;
  removeArtifactIfIdentity: (
    input: Readonly<{
      filename: string;
      physicalIdentity: string;
    }>,
  ) => Readonly<{ state: "absent" | "mismatch" | "removed" }>;
  replaceLeaseDurably: (
    input: Readonly<{
      filename: string;
      physicalIdentity: string;
      content: string;
    }>,
  ) => Mutation;
}>;

const gateFor = (directory: string): ConcreteGate =>
  createLocalSqliteFilesystemGatePort(directory, {
    allowPathFallbackForTesting: true,
  }) as ConcreteGate;

/* eslint-disable max-lines-per-function -- one case preserves the complete exact artifact lifecycle under the same owned directory. */
describe("production Local SQLite lifecycle filesystem port", () => {
  it("creates, lists, replaces, links, reads, and identity-removes exact artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-gate-fs-"));
    const lifecycle = join(root, "lifecycle");
    chmodSync(root, 0o700);
    try {
      ensurePrivateDirectory(lifecycle, { allowPathFallbackForTesting: true });
      ensurePrivateDirectory(lifecycle, { allowPathFallbackForTesting: true });
      expect(statSync(lifecycle).mode & 0o077).toBe(0);
      const gate = gateFor(lifecycle);
      expect(gate.listLifecycle()).toEqual({ entries: [] });

      const leaseName = `lease-${"1".repeat(32)}.json`;
      const lease = gate.createLeaseDurably({
        filename: leaseName,
        content: "lease-v1",
      });
      expect(lease.state).toBe("created");
      if (lease.state !== "created") throw new Error("expected lease");
      expect(
        gate.createLeaseDurably({ filename: leaseName, content: "duplicate" }),
      ).toEqual({ state: "exists" });
      expect(gate.readArtifact({ filename: leaseName })).toEqual({
        state: "present",
        content: "lease-v1",
        physicalIdentity: lease.physicalIdentity,
      });
      expect(
        gate.replaceLeaseDurably({
          filename: leaseName,
          physicalIdentity: "dev:0:ino:0",
          content: "lease-v2",
        }),
      ).toEqual({ state: "mismatch" });
      const replacement = gate.replaceLeaseDurably({
        filename: leaseName,
        physicalIdentity: lease.physicalIdentity,
        content: "lease-v2",
      });
      expect(replacement.state).toBe("replaced");
      if (replacement.state !== "replaced")
        throw new Error("expected replacement");
      expect(readFileSync(join(lifecycle, leaseName), "utf8")).toBe("lease-v2");
      const claimName = `recovery-claim-${"2".repeat(32)}`;
      const claim = gate.createRecoveryClaim({
        claimName,
        leaseName,
        leasePhysicalIdentity: replacement.physicalIdentity,
      });
      expect(claim).toEqual({
        state: "created",
        physicalIdentity: replacement.physicalIdentity,
      });
      expect(
        gate.createRecoveryClaim({
          claimName,
          leaseName,
          leasePhysicalIdentity: replacement.physicalIdentity,
        }),
      ).toEqual({ state: "exists" });
      expect(() =>
        gate.createRecoveryClaim({
          claimName: `recovery-claim-${"9".repeat(32)}`,
          leaseName,
          leasePhysicalIdentity: "dev:0:ino:0",
        }),
      ).toThrow("destination.local-sqlite.filesystem.invalid");

      const fence = gate.createFenceDurably({
        filename: "exclusive-fence-v1",
        content: "fence-v1",
      });
      expect(fence.state).toBe("created");
      expect(
        gate.createFenceDurably({
          filename: "exclusive-fence-v1",
          content: "duplicate",
        }),
      ).toEqual({ state: "exists" });
      expect(() =>
        gate.createFenceDurably({
          filename: "exclusive-fence-v1",
          content: "x".repeat(65_537),
        }),
      ).toThrow("destination.local-sqlite.filesystem.invalid");
      expect(gate.listLifecycle().entries.map(({ name }) => name)).toEqual(
        ["exclusive-fence-v1", leaseName, claimName].sort(),
      );

      expect(
        gate.removeArtifactIfIdentity({
          filename: leaseName,
          physicalIdentity: "dev:0:ino:0",
        }),
      ).toEqual({ state: "mismatch" });
      expect(
        gate.removeArtifactIfIdentity({
          filename: claimName,
          physicalIdentity: replacement.physicalIdentity,
        }),
      ).toEqual({ state: "removed" });
      expect(
        gate.removeArtifactIfIdentity({
          filename: leaseName,
          physicalIdentity: replacement.physicalIdentity,
        }),
      ).toEqual({ state: "removed" });
      expect(gate.readArtifact({ filename: leaseName })).toEqual({
        state: "absent",
      });

      for (const filename of ["../escape", "lease-bad.json", "unknown"])
        expect(() => gate.readArtifact({ filename })).toThrow(
          "destination.local-sqlite.filesystem.invalid",
        );
      expect(() =>
        gate.createLeaseDurably({
          filename: `lease-${"3".repeat(32)}.json`,
          content: "x".repeat(65_537),
        }),
      ).toThrow("destination.local-sqlite.filesystem.invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies the exact current owner and a nonexistent owner conservatively", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-gate-owner-"));
    const lifecycle = join(root, "lifecycle");
    chmodSync(root, 0o700);
    try {
      ensurePrivateDirectory(lifecycle, { allowPathFallbackForTesting: true });
      const gate = gateFor(lifecycle);
      const current = currentProcessStartIdentity();
      expect(current).toMatch(/^[a-f0-9]{32}$/u);
      if (process.platform === "linux") {
        expect(processStartIdentity(process.pid)).toBe(current);
        expect(
          gate.classifyOwner({
            owner: { pid: process.pid, startIdentity: current },
          }),
        ).toEqual({ state: "live" });
        expect(
          gate.classifyOwner({
            owner: { pid: process.pid, startIdentity: "0".repeat(32) },
          }),
        ).toEqual({ state: "dead" });
        expect(
          gate.classifyOwner({
            owner: { pid: 2_147_483_647, startIdentity: "0".repeat(32) },
          }),
        ).toEqual({ state: "dead" });
      } else {
        expect(processStartIdentity(process.pid)).toBeUndefined();
        expect(
          gate.classifyOwner({
            owner: { pid: process.pid, startIdentity: current },
          }),
        ).toEqual({ state: "indeterminate" });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on directory creation errors and canonical-name replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-gate-create-"));
    const denied = join(root, "denied");
    try {
      chmodSync(root, 0o500);
      expect(() => {
        ensurePrivateDirectory(denied, {
          allowPathFallbackForTesting: true,
        });
      }).toThrow();
      chmodSync(root, 0o700);

      const raced = join(root, "raced");
      expect(() => {
        ensurePrivateDirectory(raced, {
          allowPathFallbackForTesting: true,
          afterIdentityCheckForTesting: () => {
            renameSync(raced, join(root, "retained"));
            mkdirSync(raced, { mode: 0o700 });
          },
        });
      }).toThrow("destination.local-sqlite.filesystem.raced");
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
/* eslint-enable max-lines-per-function */
