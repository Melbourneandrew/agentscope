import { describe, expect, it } from "vitest";
import { compileDestinationRegistry } from "@agentscope/destinations-core";
import {
  createCredentialOwnership,
  deriveStoredCredentialReference,
} from "./credential-adapter.js";
import {
  canonicalCredentialIntent,
  type CredentialRetirementIntent,
} from "./credential-intent-record.js";
import {
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
} from "./schema.js";
import {
  retirementIdentity,
  retirementSnapshotMatches,
  retirementState,
  retirementWriteMatches,
  retirementFinalCandidate,
  sameConfigurationExceptGeneration,
} from "./credential-retirement-evidence.js";

const registry = compileDestinationRegistry([]);
const snapshot = (generation: number) =>
  parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation,
      destinations: {},
      routing: {
        version: 1,
        selectedConnectionIds: [],
        hookDeadlineMilliseconds: 2_000,
      },
      policy: { version: 1, reference: "policy-v1" },
    },
    registry,
  );
const snapshots = [snapshot(0), snapshot(1), snapshot(2)] as const;
const ownership = createCredentialOwnership({
  destinationType: "@agentscope/destination-example",
  connectionId: `destination-connection-v1-${"a".repeat(64)}`,
  slot: "api-key",
});
const record = () =>
  canonicalCredentialIntent({
    recordVersion: 3,
    operation: "retire",
    owner: {
      processId: 72,
      processStartIdentity: `process-start-v1-${"b".repeat(64)}`,
    },
    entries: [
      {
        ownership,
        reference: deriveStoredCredentialReference(
          "macos-keychain",
          ownership,
          `credential-generation-v1-${"c".repeat(64)}`,
        ),
      },
    ],
    preimage: retirementIdentity(snapshots[0]),
    removal: retirementIdentity(snapshots[1]),
    final: retirementIdentity(snapshots[2]),
  }) as CredentialRetirementIntent;

describe("retirement digest and generation predicates", () => {
  it("accepts only two exact byte transitions and forbids claimed preimage write", () => {
    const intent = record();
    const [before, removal, final] = snapshots.map(
      serializeAgentscopeConfiguration,
    );
    expect(retirementWriteMatches(intent, before!, removal!, false)).toBe(true);
    expect(retirementWriteMatches(intent, before!, removal!, true)).toBe(false);
    expect(retirementWriteMatches(intent, removal!, final!, true)).toBe(true);
    expect(retirementWriteMatches(intent, removal!, final!, false)).toBe(true);
    expect(retirementWriteMatches(intent, `${removal!} `, final!, true)).toBe(
      false,
    );
    expect(retirementWriteMatches(intent, before!, final!, false)).toBe(false);
  });
  it("requires the exact final active and removal backup pair", () => {
    const intent = record();
    expect(retirementState(snapshots[0], undefined, intent)).toBe("preimage");
    expect(retirementState(snapshots[1], snapshots[0], intent)).toBe("removal");
    expect(retirementState(snapshots[1], snapshots[1], intent)).toBe("removal");
    expect(retirementState(snapshots[2], snapshots[1], intent)).toBe("final");
    expect(retirementState(snapshots[2], snapshots[0], intent)).toBe("unknown");
    expect(retirementState(snapshots[1], undefined, intent)).toBe("unknown");
    expect(retirementState(snapshot(3), snapshots[1], intent)).toBe("unknown");
  });
  it("derives only recorded generation-only final candidate", () => {
    const intent = record();
    expect(
      serializeAgentscopeConfiguration(
        retirementFinalCandidate(snapshots[1], snapshots[0], intent, registry),
      ),
    ).toBe(serializeAgentscopeConfiguration(snapshots[2]));
    expect(() =>
      retirementFinalCandidate(snapshots[0], snapshots[1], intent, registry),
    ).toThrow();
    expect(() =>
      retirementFinalCandidate(
        snapshots[1],
        snapshots[0],
        {
          ...intent,
          final: {
            ...intent.final,
            digest: retirementIdentity(snapshot(3)).digest,
          },
        },
        registry,
      ),
    ).toThrow();
    expect(sameConfigurationExceptGeneration(snapshots[0], snapshots[2])).toBe(
      true,
    );
  });
  it("rejects cloned snapshots as digest authority", () => {
    expect(
      retirementSnapshotMatches(snapshots[0], retirementIdentity(snapshots[1])),
    ).toBe(false);
    expect(() => retirementIdentity({ ...snapshots[0] })).toThrow();
  });
});
