import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
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
  acquireRecoveryFenceLock: (
    input: Readonly<{
      filename: string;
      physicalIdentity: string;
    }>,
  ) => Readonly<
    | { state: "acquired"; token: Readonly<Record<string, never>> }
    | { state: "busy" | "mismatch" }
  >;
  assertRecoveryFenceLock: (
    input: Readonly<{
      filename: string;
      physicalIdentity: string;
      token: Readonly<Record<string, never>>;
    }>,
  ) => Readonly<{ state: "held" | "not-held" }>;
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
  createLeaseCleanupClaim: (
    input: Readonly<{
      cleanupClaimName: string;
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
  releaseRecoveryFenceLock: (
    input: Readonly<{
      filename: string;
      physicalIdentity: string;
      token: Readonly<Record<string, never>>;
    }>,
  ) => Readonly<{ state: "released" | "not-held" }>;
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
      const claimName = `lease-cleanup-${"1".repeat(32)}.json`;
      const claim = gate.createLeaseCleanupClaim({
        cleanupClaimName: claimName,
        leaseName,
        leasePhysicalIdentity: replacement.physicalIdentity,
      });
      expect(claim).toEqual({
        state: "created",
        physicalIdentity: replacement.physicalIdentity,
      });
      expect(
        gate.createLeaseCleanupClaim({
          cleanupClaimName: claimName,
          leaseName,
          leasePhysicalIdentity: replacement.physicalIdentity,
        }),
      ).toEqual({ state: "exists" });
      expect(() =>
        gate.createLeaseCleanupClaim({
          cleanupClaimName: `lease-cleanup-${"9".repeat(32)}.json`,
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

  it("resumes an interrupted fixed-fence removal through its logical public name", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-gate-claim-"));
    const lifecycle = join(root, "lifecycle");
    chmodSync(root, 0o700);
    try {
      ensurePrivateDirectory(lifecycle, { allowPathFallbackForTesting: true });
      let interrupt = true;
      const interrupted = createLocalSqliteFilesystemGatePort(lifecycle, {
        allowPathFallbackForTesting: true,
        afterNamespaceClaimForTesting: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("synthetic interruption");
        },
      }) as ConcreteGate;
      const fence = interrupted.createFenceDurably({
        filename: "exclusive-fence-v1",
        content: "fence-v1",
      });
      if (fence.state !== "created") throw new Error("expected fence");
      expect(() =>
        interrupted.removeArtifactIfIdentity({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
        }),
      ).toThrow("synthetic interruption");
      expect(interrupted.listLifecycle()).toEqual({
        entries: [
          {
            name: "exclusive-fence-v1",
            bytes: 8,
            physicalIdentity: fence.physicalIdentity,
          },
        ],
      });
      expect(
        interrupted.readArtifact({ filename: "exclusive-fence-v1" }),
      ).toEqual({
        state: "present",
        content: "fence-v1",
        physicalIdentity: fence.physicalIdentity,
      });
      expect(
        interrupted.createFenceDurably({
          filename: "exclusive-fence-v1",
          content: "different",
        }),
      ).toEqual({ state: "exists" });
      expect(readdirSync(lifecycle).sort()).toHaveLength(2);
      unlinkSync(join(lifecycle, "exclusive-fence-v1"));
      const resumed = gateFor(lifecycle);
      const claimOnlyNames = readdirSync(lifecycle);
      expect(
        resumed.createFenceDurably({
          filename: "exclusive-fence-v1",
          content: "different",
        }),
      ).toEqual({ state: "exists" });
      expect(readdirSync(lifecycle)).toEqual(claimOnlyNames);
      const lock = resumed.acquireRecoveryFenceLock({
        filename: "exclusive-fence-v1",
        physicalIdentity: fence.physicalIdentity,
      });
      expect(lock.state).toBe("acquired");
      if (lock.state !== "acquired") throw new Error("expected recovery lock");
      expect(
        resumed.releaseRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
          token: lock.token,
        }),
      ).toEqual({ state: "released" });
      expect(
        resumed.removeArtifactIfIdentity({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
        }),
      ).toEqual({ state: "removed" });
      expect(readdirSync(lifecycle)).toEqual([]);
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
      expect(() =>
        createLocalSqliteFilesystemGatePort(lifecycle, {
          lockOwnedFile: () => "acquired",
        }).acquireRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: "dev:0:ino:0",
        }),
      ).toThrow("destination.local-sqlite.native-unavailable");
      const gate = gateFor(lifecycle);
      expect(
        gate.acquireRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: "dev:0:ino:0",
        }),
      ).toEqual({ state: "mismatch" });
      const current = currentProcessStartIdentity();
      expect(current).toMatch(/^[a-f0-9]{32}$/u);
      const platformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      if (platformDescriptor === undefined)
        throw new Error("process.platform descriptor is unavailable");
      try {
        Object.defineProperty(process, "platform", {
          ...platformDescriptor,
          value: "win32",
        });
        expect(processStartIdentity(process.pid)).toBeUndefined();
        expect(currentProcessStartIdentity()).toMatch(/^[a-f0-9]{32}$/u);
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
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

  it("holds, verifies, and releases one exact fallback recovery-fence lock", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-gate-lock-"));
    const lifecycle = join(root, "lifecycle");
    chmodSync(root, 0o700);
    try {
      ensurePrivateDirectory(lifecycle, { allowPathFallbackForTesting: true });
      const gate = gateFor(lifecycle);
      expect(() =>
        createLocalSqliteFilesystemGatePort(lifecycle).acquireRecoveryFenceLock(
          {
            filename: "exclusive-fence-v1",
            physicalIdentity: "dev:0:ino:0",
          },
        ),
      ).toThrow("destination.local-sqlite.native-unavailable");
      const fence = gate.createFenceDurably({
        filename: "exclusive-fence-v1",
        content: "fence-v1",
      });
      if (fence.state !== "created") throw new Error("expected fence");
      expect(
        gate.acquireRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: "dev:0:ino:0",
        }),
      ).toEqual({ state: "mismatch" });
      const acquired = gate.acquireRecoveryFenceLock({
        filename: "exclusive-fence-v1",
        physicalIdentity: fence.physicalIdentity,
      });
      expect(acquired.state).toBe("acquired");
      if (acquired.state !== "acquired") throw new Error("expected lock");
      expect(
        gate.acquireRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
        }),
      ).toEqual({ state: "busy" });
      expect(
        gate.assertRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
          token: acquired.token,
        }),
      ).toEqual({ state: "held" });
      expect(
        gate.assertRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: "dev:0:ino:0",
          token: acquired.token,
        }),
      ).toEqual({ state: "not-held" });
      const fencePath = join(lifecycle, "exclusive-fence-v1");
      const displaced = `${fencePath}.displaced`;
      renameSync(fencePath, displaced);
      writeFileSync(fencePath, "replacement", { mode: 0o600 });
      expect(
        gate.assertRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
          token: acquired.token,
        }),
      ).toEqual({ state: "not-held" });

      unlinkSync(fencePath);
      renameSync(displaced, fencePath);
      expect(
        gate.assertRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
          token: Object.freeze({}),
        }),
      ).toEqual({ state: "not-held" });

      let unlocks = 0;
      const nativeGate = createLocalSqliteFilesystemGatePort(lifecycle, {
        allowPathFallbackForTesting: true,
        lockOwnedFile: () => "acquired",
        unlockOwnedFile: () => {
          unlocks += 1;
        },
      }) as ConcreteGate;
      const nativeAcquired = nativeGate.acquireRecoveryFenceLock({
        filename: "exclusive-fence-v1",
        physicalIdentity: fence.physicalIdentity,
      });
      if (nativeAcquired.state !== "acquired")
        throw new Error("expected injected native lock");
      expect(
        nativeGate.releaseRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
          token: nativeAcquired.token,
        }),
      ).toEqual({ state: "released" });
      expect(unlocks).toBe(1);
      expect(
        gate.releaseRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: "dev:0:ino:0",
          token: acquired.token,
        }),
      ).toEqual({ state: "not-held" });
      expect(
        gate.releaseRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
          token: Object.freeze({}),
        }),
      ).toEqual({ state: "not-held" });
      expect(
        gate.releaseRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
          token: acquired.token,
        }),
      ).toEqual({ state: "released" });
      expect(
        gate.assertRecoveryFenceLock({
          filename: "exclusive-fence-v1",
          physicalIdentity: fence.physicalIdentity,
          token: acquired.token,
        }),
      ).toEqual({ state: "not-held" });
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
