import { createHash } from "node:crypto";
import type { DestinationRegistry } from "@agentscope/destinations-core/configuration";
import {
  createAgentscopeConfigurationIdentity,
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
} from "./schema.js";
import { createCredentialOwnership } from "./credential-adapter.js";
import type {
  CredentialRetirementIdentity,
  CredentialRetirementIntent,
} from "./credential-intent-record.js";

const invalid = (): never => {
  throw new Error("core.credential.retirement-invalid");
};

export const retirementIdentity = (
  snapshot: AgentscopeConfigurationSnapshot,
): CredentialRetirementIdentity =>
  Object.freeze({
    generation: snapshot.generation,
    digest: createAgentscopeConfigurationIdentity(snapshot),
  });

export const retirementSnapshotMatches = (
  snapshot: AgentscopeConfigurationSnapshot,
  identity: CredentialRetirementIdentity,
): boolean =>
  snapshot.generation === identity.generation &&
  createAgentscopeConfigurationIdentity(snapshot) === identity.digest;

const normalized = (
  snapshot: AgentscopeConfigurationSnapshot,
): Record<string, unknown> => {
  const value = JSON.parse(
    serializeAgentscopeConfiguration(snapshot),
  ) as Record<string, unknown>;
  value.generation = 0;
  return value;
};

export const sameConfigurationExceptGeneration = (
  current: AgentscopeConfigurationSnapshot,
  candidate: AgentscopeConfigurationSnapshot,
): boolean =>
  JSON.stringify(normalized(current)) === JSON.stringify(normalized(candidate));

export const retirementEntries = (
  preimage: AgentscopeConfigurationSnapshot,
  connectionId: string,
): CredentialRetirementIntent["entries"] => {
  serializeAgentscopeConfiguration(preimage);
  const connection = preimage.connections.find(
    (value) => value.connectionId === connectionId,
  );
  if (!connection) return invalid();
  const entries = Object.entries(connection.credentialReferences)
    .filter(([, reference]) => reference.backend !== "ci-environment")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([slot, reference]) => {
      if (reference.backend === "ci-environment") return invalid();
      return Object.freeze({
        ownership: createCredentialOwnership({
          destinationType: connection.destinationType,
          connectionId: connection.connectionId,
          slot,
        }),
        reference,
      });
    });
  if (
    entries.length < 1 ||
    entries.length > 16 ||
    entries.some(
      (entry) => entry.reference.backend !== entries[0]?.reference.backend,
    )
  )
    return invalid();
  return Object.freeze(entries);
};

export const exactConnectionRemoval = (
  preimage: AgentscopeConfigurationSnapshot,
  removal: AgentscopeConfigurationSnapshot,
  final: AgentscopeConfigurationSnapshot,
  connectionId: string,
): boolean => {
  const expected = normalized(preimage);
  const document = expected as {
    destinations: Record<string, { connections: { connectionId: string }[] }>;
    routing: { selectedConnectionIds: string[] };
  };
  for (const namespace of Object.values(document.destinations))
    namespace.connections = namespace.connections.filter(
      (connection) => connection.connectionId !== connectionId,
    );
  document.routing.selectedConnectionIds =
    document.routing.selectedConnectionIds.filter((id) => id !== connectionId);
  return (
    removal.generation === preimage.generation + 1 &&
    final.generation === removal.generation + 1 &&
    JSON.stringify(expected) === JSON.stringify(normalized(removal)) &&
    sameConfigurationExceptGeneration(removal, final)
  );
};

export const retirementState = (
  active: AgentscopeConfigurationSnapshot,
  backup: AgentscopeConfigurationSnapshot | undefined,
  intent: CredentialRetirementIntent,
): "preimage" | "removal" | "final" | "unknown" => {
  if (retirementSnapshotMatches(active, intent.preimage)) return "preimage";
  if (!backup) return "unknown";
  if (
    retirementSnapshotMatches(active, intent.removal) &&
    (retirementSnapshotMatches(backup, intent.preimage) ||
      retirementSnapshotMatches(backup, intent.removal))
  )
    return "removal";
  if (
    !retirementSnapshotMatches(active, intent.final) ||
    !retirementSnapshotMatches(backup, intent.removal) ||
    intent.entries.some((entry) =>
      [active, backup].some((snapshot) =>
        snapshot.connections.some((connection) =>
          Object.values(connection.credentialReferences).some(
            (reference) =>
              JSON.stringify(reference) === JSON.stringify(entry.reference),
          ),
        ),
      ),
    )
  )
    return "unknown";
  return "final";
};

export const retirementWriteMatches = (
  intent: CredentialRetirementIntent,
  initialText: string,
  candidateText: string,
  claimed: boolean,
): boolean => {
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const before = `sha256-${hash(initialText)}`;
  const after = `sha256-${hash(candidateText)}`;
  return (
    (!claimed &&
      before === intent.preimage.digest &&
      after === intent.removal.digest) ||
    (before === intent.removal.digest && after === intent.final.digest)
  );
};

export const retirementFinalCandidate = (
  active: AgentscopeConfigurationSnapshot,
  backup: AgentscopeConfigurationSnapshot,
  intent: CredentialRetirementIntent,
  registry: DestinationRegistry,
): AgentscopeConfigurationSnapshot => {
  if (retirementState(active, backup, intent) !== "removal") return invalid();
  const document = JSON.parse(
    serializeAgentscopeConfiguration(active),
  ) as Record<string, unknown>;
  document.generation = intent.final.generation;
  const candidate = parseAgentscopeConfiguration(document, registry);
  if (
    !retirementWriteMatches(
      intent,
      serializeAgentscopeConfiguration(active),
      serializeAgentscopeConfiguration(candidate),
      true,
    )
  )
    return invalid();
  return candidate;
};
