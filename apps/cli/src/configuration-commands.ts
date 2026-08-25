import type { Command } from "commander";
import { z } from "zod";

import type { CliOperationResult } from "./cli-contract.js";
import {
  defineCliCommandModule,
  type RuntimeCliCommandModule,
} from "./command-runtime.js";

const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const settingKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][A-Za-z0-9]*$/u);
const typeSchema = nameSchema;
const retainedDeleteSelectorSchema = z
  .string()
  .regex(/^destination-connection-v1-[0-9a-f]{64}$/u);
const deleteSelectorSchema = z.union([
  nameSchema,
  retainedDeleteSelectorSchema,
]);
const slotAssignmentSchema = z
  .string()
  .min(3)
  .max(194)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*=[A-Z][A-Z0-9_]{0,127}$/u);
const jsonTextSchema = z.string().min(2).max(65_536);
const destinationTypeSchema = z
  .string()
  .regex(/^@agentscope\/destination-[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const connectionSchema = z.strictObject({
  connectionId: z.string().regex(/^destination-connection-v1-[0-9a-f]{64}$/u),
  destinationType: destinationTypeSchema,
  name: nameSchema,
  routed: z.boolean(),
  settingsVersion: z.number().int().positive(),
  transport: z.enum(["local", "remote"]),
});
export type CliDestinationConnection = z.infer<typeof connectionSchema>;

const initializationStepSchema = z.strictObject({
  action: z.enum(["create-configuration", "no-change"]),
  destructive: z.boolean(),
  id: z.string().min(1).max(96),
  state: z.enum(["planned", "applied", "unchanged"]),
});
const initializationValueSchema = z.strictObject({
  applied: z.boolean(),
  generation: z.number().int().nonnegative().nullable(),
  steps: z.array(initializationStepSchema).min(1).max(32),
});
export type CliInitializationValue = z.infer<typeof initializationValueSchema>;

const retentionPolicySchema = z.strictObject({
  maximumAgeNanoseconds: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  maximumPayloadBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 ** 3),
  maximumTraceCount: z.number().int().positive().max(1_000_000),
  physicalCleanupTrigger: z.literal("next-authorized-mutation"),
});
const lifecyclePlanSchema = z.strictObject({
  destinationType: destinationTypeSchema,
  displayPath: z.string().min(1).max(4_096),
  operation: z.enum(["configure", "delete", "unconfigure"]),
  persistentDataNotice: z.literal(true),
  retentionPolicy: retentionPolicySchema,
});
export type CliDestinationLifecyclePlan = z.infer<typeof lifecyclePlanSchema>;

const configureValueSchema = z.strictObject({
  applied: z.boolean(),
  connection: connectionSchema.nullable(),
  generation: z.number().int().nonnegative().nullable(),
  plan: lifecyclePlanSchema.nullable(),
  state: z.enum(["configured", "planned"]),
});
const listValueSchema = z.strictObject({
  connections: z.array(connectionSchema).max(64),
});
const inspectValueSchema = z.strictObject({
  connection: connectionSchema,
  credentialSlots: z.array(nameSchema).max(16),
  documentationPath: z.string().min(1).max(256),
  settingKeys: z.array(settingKeySchema).max(64),
});
const unconfigureValueSchema = z.strictObject({
  applied: z.boolean(),
  dataPreserved: z.literal(true),
  generation: z.number().int().nonnegative().nullable(),
  name: nameSchema,
  plan: lifecyclePlanSchema.nullable(),
  retainedDeleteSelector: retainedDeleteSelectorSchema.nullable(),
  state: z.enum(["planned", "retained", "unconfigured"]),
});
const deleteValueSchema = z.strictObject({
  applied: z.boolean(),
  deleted: z.boolean(),
  plan: lifecyclePlanSchema.nullable(),
  selector: deleteSelectorSchema,
  state: z.enum(["deleted", "planned"]),
});
const recoveryPlanSchema = z.strictObject({
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
const recoverValueSchema = z.strictObject({
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
const rotateValueSchema = z.strictObject({
  generation: z.number().int().nonnegative(),
  name: nameSchema,
  slot: nameSchema,
});
const routingValueSchema = z.strictObject({
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

const options = (command: Command): Readonly<Record<string, unknown>> => {
  const value: unknown = command.opts();
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
};

const option = (command: Command, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(options(command), key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const argument = (command: Command, index: number): unknown =>
  command.processedArgs[index];

const connectionLine = (connection: CliDestinationConnection): string =>
  `${connection.name} (${connection.destinationType}, ${connection.transport}, ${connection.routed ? "selected" : "not selected"})`;

const initModule = defineCliCommandModule({
  configure: (command: Command) => {
    command.option("--yes", "apply the displayed non-destructive plan");
  },
  execute: (services: CliConfigurationServices, input, context) =>
    services.init({ ...input, presentPlan: context.presentPlan }),
  human: (value) => [
    value.applied
      ? "Initialization plan applied."
      : "Initialization plan (no changes applied):",
    ...value.steps.map((step) => `${step.state}: ${step.action}`),
  ],
  id: "init",
  inputSchema: z.strictObject({ apply: z.boolean() }),
  machineRecords: (value) => value.steps,
  outputSchema: initializationValueSchema,
  readInput: (command: Command) => ({ apply: option(command, "yes") === true }),
});

const listModule = defineCliCommandModule({
  configure: () => undefined,
  execute: (services: CliConfigurationServices) => services.listDestinations(),
  human: (value) =>
    value.connections.length === 0
      ? ["No destination connections are configured."]
      : value.connections.map(connectionLine),
  id: "destination.list",
  inputSchema: z.strictObject({}),
  machineRecords: (value) => value.connections,
  outputSchema: listValueSchema,
  readInput: () => ({}),
});

const configureModule = defineCliCommandModule({
  configure: (command: Command) => {
    command
      .argument("<type>", "first-party destination type")
      .requiredOption("--name <name>", "connection name")
      .option("--yes", "apply the displayed local persistence plan")
      .option("--settings <json>", "non-secret settings JSON", "{}")
      .option(
        "--credential-env <slot=variable...>",
        "bind credential slots to CI environment variables",
      );
  },
  execute: (services: CliConfigurationServices, input, context) =>
    services.configureDestination({
      ...input,
      presentPlan: context.presentPlan,
    }),
  human: (value) =>
    value.connection === null
      ? [
          `Local persistence plan: ${value.plan?.displayPath ?? "unavailable"}`,
          "No changes applied; rerun with --yes after reviewing the plan.",
        ]
      : [
          `Configured ${connectionLine(value.connection)}.`,
          `Configuration generation: ${value.generation}`,
        ],
  id: "destination.configure",
  inputSchema: z.strictObject({
    apply: z.boolean(),
    credentialEnvironment: z.array(slotAssignmentSchema).max(16),
    name: nameSchema,
    settingsJson: jsonTextSchema,
    type: typeSchema,
  }),
  machineRecords: (value) =>
    value.connection === null ? [value] : [value.connection],
  outputSchema: configureValueSchema,
  readInput: (command: Command) => ({
    apply: option(command, "yes") === true,
    credentialEnvironment: option(command, "credentialEnv") ?? [],
    name: option(command, "name"),
    settingsJson: option(command, "settings"),
    type: argument(command, 0),
  }),
});

const inspectModule = defineCliCommandModule({
  configure: (command: Command) => {
    command.argument("<name>", "connection name");
  },
  execute: (services: CliConfigurationServices, input) =>
    services.inspectDestination(input),
  human: (value) => [
    connectionLine(value.connection),
    `Settings: ${value.settingKeys.join(", ") || "none"}`,
    `Credential slots: ${value.credentialSlots.join(", ") || "none"}`,
    `Documentation: ${value.documentationPath}`,
  ],
  id: "destination.inspect",
  inputSchema: z.strictObject({ name: nameSchema }),
  machineRecords: (value) => [value],
  outputSchema: inspectValueSchema,
  readInput: (command: Command) => ({ name: argument(command, 0) }),
});

const unconfigureModule = defineCliCommandModule({
  configure: (command: Command) => {
    command
      .argument("<name>", "connection name")
      .option("--yes", "apply the displayed local data-retention plan");
  },
  execute: (services: CliConfigurationServices, input, context) =>
    services.unconfigureDestination({
      ...input,
      presentPlan: context.presentPlan,
    }),
  human: (value) =>
    value.applied
      ? [
          `Unconfigured ${value.name}.`,
          "Destination-owned data was preserved.",
          ...(value.retainedDeleteSelector === null
            ? []
            : [`Retained delete selector: ${value.retainedDeleteSelector}`]),
        ]
      : [
          `Local retention plan: ${value.plan?.displayPath ?? "unavailable"}`,
          "No changes applied; rerun with --yes after reviewing the plan.",
        ],
  id: "destination.unconfigure",
  inputSchema: z.strictObject({ apply: z.boolean(), name: nameSchema }),
  machineRecords: (value) => [value],
  outputSchema: unconfigureValueSchema,
  readInput: (command: Command) => ({
    apply: option(command, "yes") === true,
    name: argument(command, 0),
  }),
});

const deleteModule = defineCliCommandModule({
  configure: (command: Command) => {
    command
      .argument("<name>", "connection name")
      .option(
        "--confirm",
        "confirm deletion of the exact owned local data file",
      );
  },
  execute: (services: CliConfigurationServices, input, context) =>
    services.deleteDestination({ ...input, presentPlan: context.presentPlan }),
  human: (value) =>
    value.applied
      ? [`Deleted the exact owned data for ${value.selector}.`]
      : [
          `Local deletion plan: ${value.plan?.displayPath ?? "unavailable"}`,
          "No data deleted; rerun with --confirm after reviewing the plan.",
        ],
  id: "destination.delete",
  inputSchema: z.strictObject({
    confirm: z.boolean(),
    name: deleteSelectorSchema,
  }),
  machineRecords: (value) => [value],
  outputSchema: deleteValueSchema,
  readInput: (command: Command) => ({
    confirm: option(command, "confirm") === true,
    name: argument(command, 0),
  }),
});

const recoverModule = defineCliCommandModule({
  configure: (command: Command) => {
    command.option("--yes", "recover the exact pending local lifecycle intent");
  },
  execute: (services: CliConfigurationServices, input, context) =>
    services.recoverDestinationLifecycle({
      ...input,
      presentPlan: context.presentPlan,
    }),
  human: (value) => [
    value.applied
      ? `Recovered local lifecycle state: ${value.state}.`
      : `Local lifecycle recovery plan: ${value.plan.pendingOperation} for ${value.plan.destinationType} generation ${value.plan.expectedGeneration} (no changes applied).`,
  ],
  id: "destination.recover",
  inputSchema: z.strictObject({ apply: z.boolean() }),
  machineRecords: (value) => [value],
  outputSchema: recoverValueSchema,
  readInput: (command: Command) => ({ apply: option(command, "yes") === true }),
});

const rotateModule = defineCliCommandModule({
  configure: (command: Command) => {
    command
      .argument("<name>", "connection name")
      .requiredOption("--slot <slot>", "credential slot")
      .requiredOption(
        "--environment-variable <name>",
        "replacement CI environment variable",
      );
  },
  execute: (services: CliConfigurationServices, input) =>
    services.rotateDestinationCredential(input),
  human: (value) => [`Rotated ${value.name} credential slot ${value.slot}.`],
  id: "destination.rotate",
  inputSchema: z.strictObject({
    environmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
    name: nameSchema,
    slot: nameSchema,
  }),
  machineRecords: (value) => [value],
  outputSchema: rotateValueSchema,
  readInput: (command: Command) => ({
    environmentVariable: option(command, "environmentVariable"),
    name: argument(command, 0),
    slot: option(command, "slot"),
  }),
});

const routingSetModule = defineCliCommandModule({
  configure: (command: Command) => {
    command.argument(
      "[connections...]",
      "connection names; omit all to disable delivery",
    );
  },
  execute: (services: CliConfigurationServices, input) =>
    services.setRouting(input),
  human: (value) => [
    value.selected.length === 0
      ? "Delivery is disabled; no destination is selected."
      : `Selected destinations: ${value.selected.join(", ")}`,
  ],
  id: "routing.set",
  inputSchema: z.strictObject({ names: z.array(nameSchema).max(32) }),
  machineRecords: (value) => value.selected.map((name) => ({ name })),
  outputSchema: routingValueSchema,
  readInput: (command: Command) => ({ names: argument(command, 0) ?? [] }),
});

const routingListModule = defineCliCommandModule({
  configure: () => undefined,
  execute: (services: CliConfigurationServices) => services.listRouting(),
  human: (value) => [
    value.selected.length === 0
      ? "Delivery is disabled; no destination is selected."
      : `Selected destinations: ${value.selected.join(", ")}`,
  ],
  id: "routing.list",
  inputSchema: z.strictObject({}),
  machineRecords: (value) => value.selected.map((name) => ({ name })),
  outputSchema: routingValueSchema,
  readInput: () => ({}),
});

export const configurationCommandModules: readonly RuntimeCliCommandModule[] =
  Object.freeze([
    initModule,
    configureModule,
    deleteModule,
    recoverModule,
    inspectModule,
    listModule,
    rotateModule,
    unconfigureModule,
    routingListModule,
    routingSetModule,
  ]);
