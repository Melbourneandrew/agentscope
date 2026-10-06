import { z } from "zod";
import { types } from "node:util";

import { cloneConfigurationDocument } from "./plain-data.js";
import {
  createCredentialOwnership,
  deriveStoredCredentialReference,
} from "./credential-adapter.js";
import {
  parseConfigurationCredentialReference,
  type ConfigurationCredentialReference,
} from "./schema.js";

type IntentOwner = Readonly<{
  processId: number;
  processStartIdentity: string;
}>;

export const MAXIMUM_CREDENTIAL_INTENT_BYTES = 4_096;

export type CredentialIntentEntry = Readonly<{
  ownership: Readonly<{
    destinationType: string;
    connectionId: string;
    slot: string;
  }>;
  reference: ConfigurationCredentialReference;
}>;

export type SingleCredentialMutationIntent = CredentialIntentEntry &
  Readonly<{
    recordVersion: 1;
    operation: "create" | "retire";
    owner: IntentOwner;
  }>;

export type CredentialSetMutationIntent = Readonly<{
  recordVersion: 2;
  operation: "create";
  owner: IntentOwner;
  entries: readonly (Omit<CredentialIntentEntry, "reference"> &
    Readonly<{
      reference: Extract<
        ConfigurationCredentialReference,
        { referenceId: string }
      >;
    }>)[];
}>;

export type CredentialMutationIntent =
  SingleCredentialMutationIntent | CredentialSetMutationIntent;

const ownerSchema = z.strictObject({
  processId: z.number().int().positive().safe(),
  processStartIdentity: z.string().regex(/^process-start-v1-[0-9a-f]{64}$/u),
});
const ownershipSchema = z.strictObject({
  destinationType: z
    .string()
    .regex(/^@agentscope\/destination-[a-z0-9-]{1,64}$/u),
  connectionId: z.string().regex(/^destination-connection-v1-[0-9a-f]{64}$/u),
  slot: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
});
const entrySchema = z.strictObject({
  ownership: ownershipSchema,
  reference: z.unknown(),
});
const recordSchema = z.discriminatedUnion("recordVersion", [
  z.strictObject({
    recordVersion: z.literal(1),
    operation: z.enum(["create", "retire"]),
    owner: ownerSchema,
    ownership: ownershipSchema,
    reference: z.unknown(),
  }),
  z.strictObject({
    recordVersion: z.literal(2),
    operation: z.literal("create"),
    owner: ownerSchema,
    entries: z.array(entrySchema).min(1).max(16),
  }),
]);

const entryFrom = (entry: z.infer<typeof entrySchema>): CredentialIntentEntry =>
  Object.freeze({
    ownership: Object.freeze(entry.ownership),
    reference: parseConfigurationCredentialReference(entry.reference),
  });

function validateSet(
  entries: readonly CredentialIntentEntry[],
): asserts entries is CredentialSetMutationIntent["entries"] {
  const first = entries[0];
  if (!first || first.reference.backend === "ci-environment") throw new Error();
  let previous = "";
  const references = new Set<string>();
  for (const entry of entries) {
    const reference = entry.reference;
    if (
      entry.ownership.destinationType !== first.ownership.destinationType ||
      entry.ownership.connectionId !== first.ownership.connectionId ||
      entry.ownership.slot <= previous ||
      reference.backend !== first.reference.backend ||
      references.has(reference.referenceId) ||
      deriveStoredCredentialReference(
        reference.backend,
        createCredentialOwnership(entry.ownership),
        reference.generationId,
      ).referenceId !== reference.referenceId
    )
      throw new Error();
    previous = entry.ownership.slot;
    references.add(reference.referenceId);
  }
}

export const canonicalCredentialIntent = (
  input: unknown,
): CredentialMutationIntent => {
  rejectProxyFields(input);
  const cloned = cloneConfigurationDocument(input) as Record<string, unknown>;
  const value = recordSchema.parse(
    cloned.recordVersion === 1 ? normalizedSingle(cloned) : cloned,
  );
  const owner = Object.freeze(value.owner);
  if (value.recordVersion === 1) {
    const entry = entryFrom(value);
    return Object.freeze({
      recordVersion: 1,
      operation: value.operation,
      owner,
      ownership: entry.ownership,
      reference: entry.reference,
    });
  }
  const entries = Object.freeze(value.entries.map(entryFrom));
  validateSet(entries);
  return Object.freeze({
    recordVersion: 2,
    operation: "create",
    owner,
    entries,
  });
};

const rejectProxyFields = (input: unknown, depth = 0): void => {
  if (typeof input !== "object" || input === null) return;
  if (depth > 4 || types.isProxy(input)) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length > 17) throw new Error();
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) throw new Error();
    rejectProxyFields(descriptor.value, depth + 1);
  }
};

const normalizedSingle = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const ownership = value.ownership as Record<string, unknown>;
  const reference = value.reference as Record<string, unknown>;
  return {
    ...value,
    ownership: {
      destinationType: ownership.destinationType,
      connectionId: ownership.connectionId,
      slot: ownership.slot,
    },
    reference:
      reference.backend === "ci-environment"
        ? {
            referenceVersion: reference.referenceVersion,
            backend: reference.backend,
            environmentVariable: reference.environmentVariable,
            generationId: reference.generationId,
          }
        : {
            referenceVersion: reference.referenceVersion,
            backend: reference.backend,
            referenceId: reference.referenceId,
            generationId: reference.generationId,
          },
  };
};

export const parseCredentialIntentRecord = (
  value: string,
): CredentialMutationIntent => {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_CREDENTIAL_INTENT_BYTES)
    throw new Error();
  const record = canonicalCredentialIntent(JSON.parse(value) as unknown);
  if (`${JSON.stringify(record)}\n` !== value) throw new Error();
  return record;
};
