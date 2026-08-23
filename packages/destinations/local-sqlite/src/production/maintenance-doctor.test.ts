import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import {
  LOCAL_SQLITE_DESTINATION_TYPE,
  LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  localSqliteLifecycleDeclaration,
} from "../lifecycle/capability.js";
import {
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";
import { ensurePrivateDirectory } from "./filesystem-port.js";
import { createLocalSqliteProductionMaintenancePort } from "./maintenance-port.js";

const connectionId = `destination-connection-v1-${"2".repeat(64)}`;
const settings = Object.freeze({
  maximumAgeNanoseconds: "2592000000000000",
  maximumPayloadBytes: 1_000_000,
  maximumTraceCount: 10_000,
});

/* eslint-disable max-lines-per-function -- the Doctor matrix preserves one exact bounded namespace and all hostile inventory states. */
describe("production Local SQLite Doctor", () => {
  it("does not open SQLite and rejects the bounded backup count plus one", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-doctor-"));
    chmodSync(root, 0o700);
    let opens = 0;
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
      const port = createLocalSqliteProductionMaintenancePort({
        home: { root, platform: process.platform },
        filesystemProfile: "local-ext4",
        opener: {
          open: () => {
            opens += 1;
            throw new Error("doctor opened database");
          },
        },
        allowPathFallbackForTesting: true,
      });
      const context = {
        connectionId,
        settings,
        signal: new AbortController().signal,
      } as never;
      await expect(port.inspectDoctor(context)).resolves.toMatchObject({
        state: "available",
        databaseState: "missing",
        backupState: "available",
        publishedBackupCount: 0,
      });
      for (let index = 0; index < 33; index += 1) {
        writeFileSync(
          join(
            namespace.backupsDirectory,
            `candidate-${(index + 1).toString(16).padStart(32, "0")}.sqlite`,
          ),
          "x",
          { mode: 0o600 },
        );
        if (index === 0)
          await expect(port.inspectDoctor(context)).resolves.toMatchObject({
            state: "available",
            backupState: "available",
          });
        if (index === 1)
          await expect(port.inspectDoctor(context)).resolves.toMatchObject({
            state: "reconciliation-required",
            backupState: "reconciliation-required",
          });
      }
      const before = readdirSync(namespace.backupsDirectory).sort();
      await expect(port.inspectDoctor(context)).resolves.toMatchObject({
        state: "reconciliation-required",
        databaseState: "unavailable",
        backupState: "reconciliation-required",
        publishedBackupCount: null,
      });
      expect(readdirSync(namespace.backupsDirectory).sort()).toEqual(before);
      for (const name of before)
        unlinkSync(join(namespace.backupsDirectory, name));
      writeFileSync(join(namespace.backupsDirectory, "unexpected"), "x", {
        mode: 0o600,
      });
      await expect(port.inspectDoctor(context)).resolves.toMatchObject({
        state: "reconciliation-required",
        backupState: "reconciliation-required",
      });
      unlinkSync(join(namespace.backupsDirectory, "unexpected"));
      const backupId = "a".repeat(32);
      const snapshotPath = join(
        namespace.backupsDirectory,
        `backup-${backupId}.sqlite`,
      );
      writeFileSync(snapshotPath, "snapshot", { mode: 0o600 });
      const snapshot = lstatSync(snapshotPath, { bigint: true });
      const snapshotPhysicalIdentity = `dev:${snapshot.dev}:ino:${snapshot.ino}`;
      const configurationDigest = `sha256-${"4".repeat(64)}`;
      const connectionDigest = createHash("sha256")
        .update(
          JSON.stringify({
            connectionId,
            destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
          }),
        )
        .digest("hex");
      writeFileSync(
        join(namespace.backupsDirectory, `receipt-${backupId}.json`),
        `${JSON.stringify({
          recordVersion: 1,
          backupId,
          destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
          connectionId,
          connectionDigest,
          namespaceFingerprint: `sha256-${"5".repeat(64)}`,
          physicalEvidenceFingerprint: `sha256-${"6".repeat(64)}`,
          snapshotPhysicalIdentity,
          snapshotBytes: Number(snapshot.size),
          destinationFormat: "agentscope.local-sqlite.v1",
          migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
          protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
          lifecycleFingerprint: `sha256-${"7".repeat(64)}`,
          recoveryHandlerId: localSqliteLifecycleDeclaration.recoveryHandlerId,
          capabilityVersion: 1,
          artifactGrammarVersion: 1,
          artifactGrammarFingerprint:
            LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
          configurationGeneration: 1,
          configurationDigest,
          transactionId: "b".repeat(32),
        })}\n`,
        { mode: 0o600 },
      );
      await expect(port.inspectDoctor(context)).resolves.toMatchObject({
        state: "available",
        backupState: "available",
        publishedBackupCount: 1,
      });
      for (const name of readdirSync(namespace.backupsDirectory))
        unlinkSync(join(namespace.backupsDirectory, name));
      const header = Buffer.alloc(100);
      header.write("SQLite format 3\0", 0, "ascii");
      header[16] = 0x10;
      header[17] = 0x00;
      writeFileSync(namespace.databasePath, header, { mode: 0o600 });
      await expect(port.inspectDoctor(context)).resolves.toMatchObject({
        state: "available",
        databaseState: "present",
      });
      header[0] = 0;
      writeFileSync(namespace.databasePath, header, { mode: 0o600 });
      await expect(port.inspectDoctor(context)).resolves.toMatchObject({
        state: "reconciliation-required",
        databaseState: "unavailable",
      });
      unlinkSync(namespace.databasePath);
      const outside = join(root, "outside.sqlite");
      writeFileSync(outside, header, { mode: 0o600 });
      symlinkSync(outside, namespace.databasePath);
      await expect(port.inspectDoctor(context)).resolves.toMatchObject({
        state: "reconciliation-required",
        databaseState: "unavailable",
      });
      expect(opens).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("downgrades a same-name backup replacement during the final inventory scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-doctor-race-"));
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
        `candidate-${"1".repeat(32)}.sqlite`,
      );
      const displaced = `${candidate}.displaced`;
      writeFileSync(candidate, "same-size-a", { mode: 0o600 });
      let replaced = false;
      const port = createLocalSqliteProductionMaintenancePort({
        home: { root, platform: process.platform },
        filesystemProfile: "local-ext4",
        opener: {
          open: () => {
            throw new Error("doctor opened database");
          },
        },
        allowPathFallbackForTesting: true,
        doctorAfterFirstScanForTesting: () => {
          if (replaced) return;
          replaced = true;
          renameSync(candidate, displaced);
          writeFileSync(candidate, "same-size-b", { mode: 0o600 });
        },
      });
      await expect(
        port.inspectDoctor({
          connectionId,
          settings,
          signal: new AbortController().signal,
        } as never),
      ).resolves.toMatchObject({
        state: "unavailable",
        databaseState: "unavailable",
        backupState: "unavailable",
      });
      expect(replaced).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
/* eslint-enable max-lines-per-function */
