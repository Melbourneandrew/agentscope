import { describe, expect, it } from "vitest";

import {
  decodeLocalSqliteOperationPhase,
  encodeLocalSqliteOperationPhase,
} from "./operation-phase.js";

const record = Object.freeze({
  schemaVersion: 1 as const,
  operation: "restore" as const,
  phase: "restore-verified" as const,
  transactionId: "1".repeat(32),
  lifecycleFingerprint: `sha256-${"2".repeat(64)}`,
  artifactGrammarFingerprint: `sha256-${"3".repeat(64)}`,
  artifactPhysicalIdentity: "dev:1:ino:2",
});

describe("production Local SQLite operation phases", () => {
  it("round-trips only the exact canonical phase authority", () => {
    const canonical = encodeLocalSqliteOperationPhase(record);
    expect(decodeLocalSqliteOperationPhase(canonical)).toEqual(record);
    expect(
      decodeLocalSqliteOperationPhase(
        `${JSON.stringify({ ...record, extra: true })}\n`,
      ),
    ).toBeUndefined();
    expect(
      decodeLocalSqliteOperationPhase(
        `${JSON.stringify({ ...record, artifactPhysicalIdentity: "../alias" })}\n`,
      ),
    ).toBeUndefined();
    expect(
      decodeLocalSqliteOperationPhase(
        `${JSON.stringify({ ...record, operation: "backup" })}\n`,
      ),
    ).toBeUndefined();
    for (const candidate of [
      JSON.stringify(record),
      `${"x".repeat(2_048)}\n`,
      "null\n",
      "[]\n",
      "{\n",
      `${JSON.stringify(record, null, 2)}\n`,
    ])
      expect(decodeLocalSqliteOperationPhase(candidate)).toBeUndefined();
  });

  it("rejects caller-created invalid records at encoding", () => {
    expect(() =>
      encodeLocalSqliteOperationPhase({
        ...record,
        phase: "database-deleted",
      }),
    ).toThrow("destination.local-sqlite.operation-phase.invalid");

    for (const candidate of [
      {
        ...record,
        operation: "backup" as const,
        phase: "backup-published" as const,
      },
      {
        ...record,
        operation: "configure" as const,
        phase: "configured-active" as const,
      },
      {
        ...record,
        operation: "delete" as const,
        phase: "database-deleted" as const,
      },
      {
        ...record,
        operation: "restore" as const,
        phase: "restore-rolled-back" as const,
      },
    ])
      expect(
        decodeLocalSqliteOperationPhase(
          encodeLocalSqliteOperationPhase(candidate),
        ),
      ).toEqual(candidate);
  });
});
