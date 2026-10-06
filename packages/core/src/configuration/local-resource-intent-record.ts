import { z } from "zod";
import {
  MAXIMUM_CREDENTIAL_INTENT_BYTES,
  type CredentialMutationIntent,
} from "./credential-intent-record.js";

type ConfigurationProcessIdentity = CredentialMutationIntent["owner"];

export type LocalResourceConfigurationMutationIntent = Readonly<{
  recordVersion: 1;
  operation: "configure" | "delete" | "unconfigure";
  operationId: string;
  owner: ConfigurationProcessIdentity;
  destinationType: string;
  connectionId: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  expectedGeneration: number;
  expectedDigest: string;
  authorizedCandidates: readonly Readonly<{
    generation: number;
    digest: string;
  }>[];
}>;

export type LocalResourceMaintenanceMutationIntent = Readonly<{
  recordVersion: 2;
  operation: "backup" | "restore";
  operationId: string;
  resourceSelector: string;
  owner: ConfigurationProcessIdentity;
  destinationType: string;
  connectionId: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  expectedGeneration: number;
  expectedDigest: string;
  authorizedCandidates: readonly [];
}>;

export type LocalResourceMaintenanceMutationCompletion = Readonly<{
  recordVersion: 3;
  operation: "backup" | "restore";
  operationId: string;
  resourceSelector: string;
  owner: ConfigurationProcessIdentity;
  destinationType: string;
  connectionId: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  expectedGeneration: number;
  expectedDigest: string;
  authorizedCandidates: readonly [];
  terminalState: "backed-up" | "restored" | "rolled-back";
}>;

export type LocalResourceMutationIntent =
  | LocalResourceConfigurationMutationIntent
  | LocalResourceMaintenanceMutationIntent;

export type LocalResourceMutationRecord =
  LocalResourceMutationIntent | LocalResourceMaintenanceMutationCompletion;

const localResourceIntentCommonSchema = {
  operationId: z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/u),
  owner: z.strictObject({
    processId: z.number().int().positive().safe(),
    processStartIdentity: z.string().regex(/^process-start-v1-[0-9a-f]{64}$/u),
  }),
  destinationType: z
    .string()
    .regex(/^@agentscope\/destination-[a-z0-9-]{1,64}$/u),
  connectionId: z.string().regex(/^destination-connection-v1-[0-9a-f]{64}$/u),
  lifecycleFingerprint: z.string().regex(/^sha256-[0-9a-f]{64}$/u),
  recoveryHandlerId: z.string().min(1).max(256),
  expectedGeneration: z.number().int().nonnegative().safe(),
  expectedDigest: z.string().regex(/^sha256-[0-9a-f]{64}$/u),
} as const;

const localResourceIntentSchema = z.discriminatedUnion("recordVersion", [
  z.strictObject({
    recordVersion: z.literal(1),
    operation: z.enum(["configure", "delete", "unconfigure"]),
    ...localResourceIntentCommonSchema,
    authorizedCandidates: z
      .array(
        z.strictObject({
          generation: z.number().int().nonnegative().safe(),
          digest: z.string().regex(/^sha256-[0-9a-f]{64}$/u),
        }),
      )
      .min(1)
      .max(2),
  }),
  z.strictObject({
    recordVersion: z.literal(2),
    operation: z.enum(["backup", "restore"]),
    resourceSelector: z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/u),
    ...localResourceIntentCommonSchema,
    authorizedCandidates: z.tuple([]),
  }),
  z.strictObject({
    recordVersion: z.literal(3),
    operation: z.enum(["backup", "restore"]),
    resourceSelector: z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/u),
    ...localResourceIntentCommonSchema,
    authorizedCandidates: z.tuple([]),
    terminalState: z.enum(["backed-up", "restored", "rolled-back"]),
  }),
]);

export const parseLocalResourceIntentRecord = (
  value: string,
): LocalResourceMutationRecord => {
  try {
    if (Buffer.byteLength(value, "utf8") > MAXIMUM_CREDENTIAL_INTENT_BYTES)
      throw new Error("core.configuration.invalid");
    const parsed = localResourceIntentSchema.parse(JSON.parse(value));
    for (
      let index = 0;
      index < parsed.authorizedCandidates.length;
      index += 1
    ) {
      if (
        parsed.authorizedCandidates[index]!.generation !==
        parsed.expectedGeneration + index + 1
      )
        throw new Error("core.configuration.invalid");
    }
    if (
      parsed.recordVersion === 3 &&
      ((parsed.operation === "backup" && parsed.terminalState === "restored") ||
        (parsed.operation === "restore" &&
          parsed.terminalState === "backed-up"))
    )
      throw new Error("core.configuration.invalid");
    if (parsed.recordVersion !== 1)
      return Object.freeze({
        ...parsed,
        owner: Object.freeze(parsed.owner),
        authorizedCandidates: Object.freeze([] satisfies []),
      });
    return Object.freeze({
      ...parsed,
      owner: Object.freeze(parsed.owner),
      authorizedCandidates: Object.freeze(
        parsed.authorizedCandidates.map((candidate) =>
          Object.freeze(candidate),
        ),
      ),
    });
  } catch {
    throw new Error("core.configuration.invalid");
  }
};

export const sameLocalResourceIntent = (
  left: LocalResourceMutationRecord,
  right: LocalResourceMutationRecord,
): boolean => {
  if (left.recordVersion === 3 && right.recordVersion === 3)
    return JSON.stringify(left) === JSON.stringify(right);
  const base = (record: LocalResourceMutationRecord): object => {
    if (record.recordVersion !== 3) return record;
    const { terminalState, ...intent } = record;
    void terminalState;
    return { ...intent, recordVersion: 2 };
  };
  return JSON.stringify(base(left)) === JSON.stringify(base(right));
};
