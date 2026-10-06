import { z } from "zod";
import type { CliOperationResult } from "./cli-contract.js";
export const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
export const settingKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][A-Za-z0-9]*$/u);
export const typeSchema = nameSchema;
export const retainedDeleteSelectorSchema = z
  .string()
  .regex(/^destination-connection-v1-[0-9a-f]{64}$/u);
export const deleteSelectorSchema = z.union([
  nameSchema,
  retainedDeleteSelectorSchema,
]);
export const slotAssignmentSchema = z
  .string()
  .min(3)
  .max(194)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*=[A-Z][A-Z0-9_]{0,127}$/u);
export const jsonTextSchema = z.string().min(2).max(65_536);
export const destinationTypeSchema = z
  .string()
  .regex(/^@agentscope\/destination-[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const connectionSchema = z.strictObject({
  connectionId: z.string().regex(/^destination-connection-v1-[0-9a-f]{64}$/u),
  destinationType: destinationTypeSchema,
  name: nameSchema,
  routed: z.boolean(),
  settingsVersion: z.number().int().positive(),
  transport: z.enum(["local", "remote"]),
});
export type CliDestinationConnection = z.infer<typeof connectionSchema>;

export const initializationStepSchema = z.strictObject({
  action: z.enum(["create-configuration", "no-change"]),
  destructive: z.boolean(),
  id: z.string().min(1).max(96),
  state: z.enum(["planned", "applied", "unchanged"]),
});
export const initializationValueSchema = z.strictObject({
  applied: z.boolean(),
  generation: z.number().int().nonnegative().nullable(),
  steps: z.array(initializationStepSchema).min(1).max(32),
});
export type CliInitializationValue = z.infer<typeof initializationValueSchema>;

export const retentionPolicySchema = z.strictObject({
  maximumAgeNanoseconds: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  maximumPayloadBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 ** 3),
  maximumTraceCount: z.number().int().positive().max(1_000_000),
  physicalCleanupTrigger: z.literal("next-authorized-mutation"),
});
export const lifecyclePlanSchema = z.strictObject({
  destinationType: destinationTypeSchema,
  displayPath: z.string().min(1).max(4_096),
  operation: z.enum(["configure", "delete", "unconfigure"]),
  persistentDataNotice: z.literal(true),
  retentionPolicy: retentionPolicySchema,
});
export type CliDestinationLifecyclePlan = z.infer<typeof lifecyclePlanSchema>;

export const configureValueSchema = z.strictObject({
  applied: z.boolean(),
  connection: connectionSchema.nullable(),
  generation: z.number().int().nonnegative().nullable(),
  plan: lifecyclePlanSchema.nullable(),
  state: z.enum(["configured", "planned"]),
});
export const listValueSchema = z.strictObject({
  connections: z.array(connectionSchema).max(64),
});
export const inspectValueSchema = z.strictObject({
  connection: connectionSchema,
  credentialSlots: z.array(nameSchema).max(16),
  documentationPath: z.string().min(1).max(256),
  settingKeys: z.array(settingKeySchema).max(64),
});
export const unconfigureValueSchema = z.strictObject({
  applied: z.boolean(),
  dataPreserved: z.literal(true),
  generation: z.number().int().nonnegative().nullable(),
  name: nameSchema,
  plan: lifecyclePlanSchema.nullable(),
  retainedDeleteSelector: retainedDeleteSelectorSchema.nullable(),
  state: z.enum(["planned", "retained", "unconfigured"]),
});
export const deleteValueSchema = z.strictObject({
  applied: z.boolean(),
  deleted: z.boolean(),
  plan: lifecyclePlanSchema.nullable(),
  selector: deleteSelectorSchema,
  state: z.enum(["deleted", "planned"]),
});
export const recoveryPlanSchema = z.strictObject({
  authorizedGenerations: z.array(z.number().int().nonnegative()).min(1).max(3),
  connectionId: retainedDeleteSelectorSchema,
  destinationType: destinationTypeSchema,
  expectedGeneration: z.number().int().nonnegative(),
  lifecycleFingerprint: z.string().regex(/^sha256-[0-9a-f]{64}$/u),
  operationId: z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/u),
  pendingOperation: z.enum([
    "backup",
    "configure",
    "delete",
    "restore",
    "unconfigure",
  ]),
  recoveryStage: z.enum(["completion", "intent"]),
});
export const recoverValueSchema = z.strictObject({
  applied: z.boolean(),
  backupSelector: z
    .string()
    .regex(/^(?!0{32}$)[0-9a-f]{32}$/u)
    .nullable(),
  generation: z.number().int().nonnegative().nullable(),
  operation: z.literal("recover"),
  plan: recoveryPlanSchema,
  retainedDeleteSelector: retainedDeleteSelectorSchema.nullable(),
  state: z.enum([
    "backed-up",
    "configured",
    "deleted",
    "planned",
    "restored",
    "retained",
    "rolled-back",
  ]),
});
export const rotateValueSchema = z.strictObject({
  generation: z.number().int().nonnegative(),
  name: nameSchema,
  slot: nameSchema,
});
export const routingValueSchema = z.strictObject({
  generation: z.number().int().nonnegative(),
  selected: z.array(nameSchema).max(32),
});

type Result<Value> = CliOperationResult<Value>;

export type CliConfigurationServices = Readonly<{
  configureDestination: (
    input: Readonly<{
      apply?: boolean;
      credentialEnvironment: readonly string[];
      name: string;
      presentPlan?: (
        value: z.infer<typeof configureValueSchema>,
      ) => Promise<void>;
      settingsJson: string;
      type: string;
      humanInteractive?: boolean;
    }>,
  ) =>
    | Result<z.infer<typeof configureValueSchema>>
    | Promise<Result<z.infer<typeof configureValueSchema>>>;
  deleteDestination: (
    input: Readonly<{
      confirm: boolean;
      name: string;
      presentPlan?: (value: z.infer<typeof deleteValueSchema>) => Promise<void>;
    }>,
  ) =>
    | Result<z.infer<typeof deleteValueSchema>>
    | Promise<Result<z.infer<typeof deleteValueSchema>>>;
  init: (
    input: Readonly<{
      apply: boolean;
      presentPlan: (value: CliInitializationValue) => Promise<void>;
    }>,
  ) => Result<CliInitializationValue> | Promise<Result<CliInitializationValue>>;
  inspectDestination: (
    input: Readonly<{ name: string }>,
  ) =>
    | Result<z.infer<typeof inspectValueSchema>>
    | Promise<Result<z.infer<typeof inspectValueSchema>>>;
  listDestinations: () =>
    | Result<z.infer<typeof listValueSchema>>
    | Promise<Result<z.infer<typeof listValueSchema>>>;
  listRouting: () =>
    | Result<z.infer<typeof routingValueSchema>>
    | Promise<Result<z.infer<typeof routingValueSchema>>>;
  rotateDestinationCredential: (
    input: Readonly<{
      environmentVariable: string;
      name: string;
      slot: string;
    }>,
  ) =>
    | Result<z.infer<typeof rotateValueSchema>>
    | Promise<Result<z.infer<typeof rotateValueSchema>>>;
  setRouting: (
    input: Readonly<{ names: readonly string[] }>,
  ) =>
    | Result<z.infer<typeof routingValueSchema>>
    | Promise<Result<z.infer<typeof routingValueSchema>>>;
  unconfigureDestination: (
    input: Readonly<{
      apply?: boolean;
      name: string;
      retireCredentials?: boolean;
      presentPlan?: (
        value: z.infer<typeof unconfigureValueSchema>,
      ) => Promise<void>;
    }>,
  ) =>
    | Result<z.infer<typeof unconfigureValueSchema>>
    | Promise<Result<z.infer<typeof unconfigureValueSchema>>>;
  recoverDestinationLifecycle: (
    input: Readonly<{
      apply: boolean;
      presentPlan: (value: z.infer<typeof recoverValueSchema>) => Promise<void>;
    }>,
  ) =>
    | Result<z.infer<typeof recoverValueSchema>>
    | Promise<Result<z.infer<typeof recoverValueSchema>>>;
}>;
