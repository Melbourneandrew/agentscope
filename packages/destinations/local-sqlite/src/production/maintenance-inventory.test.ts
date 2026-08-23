import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalSqliteExclusiveFenceAuthority } from "../lifecycle/fence.js";
import type { LocalSqliteMaintenanceIntent } from "../lifecycle/maintenance.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import { ensurePrivateDirectory } from "./filesystem-port.js";
import { createLocalSqliteProductionMaintenancePort } from "./maintenance-port.js";

const connectionId = `destination-connection-v1-${"2".repeat(64)}`;
const transactionId = "3".repeat(32);
const backupId = "4".repeat(32);
const lifecycleFingerprint = `sha256-${"5".repeat(64)}`;

const intent = {
  operation: "backup",
  transactionId,
  backupId,
  connectionId,
  lifecycleFingerprint,
  capabilityVersion: 1,
  artifactGrammarFingerprint: `sha256-${"6".repeat(64)}`,
} as unknown as LocalSqliteMaintenanceIntent;

const fence = Object.freeze({
  state: "exclusive" as const,
  filename: "exclusive-fence-v1" as const,
  physicalIdentity: "dev:1:ino:1",
  record: Object.freeze({
    transactionId,
    lifecycleFingerprint,
    lifecycleGeneration: 1,
    purpose: "lifecycle" as const,
  }),
  deadLeaseNames: Object.freeze([]),
}) as LocalSqliteExclusiveFenceAuthority;

describe("production Local SQLite maintenance inventory", () => {
  it("revalidates every candidate identity before returning capacity evidence", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "agentscope-maintenance-inventory-"),
    );
    chmodSync(root, 0o700);
    try {
      const namespace = planLocalSqliteNamespace({
        agentscopeHome: root,
        connectionId,
        platform: process.platform === "win32" ? "win32" : "posix",
      });
      for (const directory of [
        namespace.destinationsDirectory,
        namespace.destinationTypeDirectory,
        namespace.connectionNamespace,
        namespace.lifecycleDirectory,
        namespace.backupsDirectory,
      ])
        ensurePrivateDirectory(directory, {
          allowPathFallbackForTesting: true,
        });
      const candidate = join(
        namespace.backupsDirectory,
        `candidate-${backupId}.sqlite`,
      );
      writeFileSync(candidate, "same-size-a", { mode: 0o600 });
      const base = {
        home: { root, platform: process.platform },
        filesystemProfile: "local-ext4",
        opener: {
          open: () => {
            throw new Error("inventory opened SQLite");
          },
        },
        allowPathFallbackForTesting: true,
      } as const;
      const stable = createLocalSqliteProductionMaintenancePort(base);
      await expect(
        stable.inspectBackupInventory(
          intent,
          fence,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        entries: [
          {
            role: "database-candidate",
            artifactId: backupId,
            bytes: 11,
          },
        ],
        hasCapacity: true,
      });

      let swapped = false;
      const raced = createLocalSqliteProductionMaintenancePort({
        ...base,
        maintenanceAfterFirstInventoryScanForTesting: () => {
          if (swapped) return;
          swapped = true;
          renameSync(candidate, `${candidate}.displaced`);
          writeFileSync(candidate, "same-size-b", { mode: 0o600 });
        },
      });
      await expect(
        raced.inspectBackupInventory(
          intent,
          fence,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.maintenance-reconciliation-required",
      );
      expect(swapped).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
