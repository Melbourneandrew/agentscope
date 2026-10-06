import type { Command } from "commander";
import { z } from "zod";

import {
  defineCliCommandModule,
  type RuntimeCliCommandModule,
} from "./command-runtime.js";

import {
  nameSchema,
  typeSchema,
  deleteSelectorSchema,
  slotAssignmentSchema,
  jsonTextSchema,
  initializationValueSchema,
  configureValueSchema,
  listValueSchema,
  inspectValueSchema,
  unconfigureValueSchema,
  deleteValueSchema,
  recoverValueSchema,
  rotateValueSchema,
  routingValueSchema,
  type CliDestinationConnection,
  type CliConfigurationServices,
} from "./configuration-command-contract.js";
export type {
  CliDestinationConnection,
  CliInitializationValue,
  CliDestinationLifecyclePlan,
  CliConfigurationServices,
} from "./configuration-command-contract.js";

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
      humanInteractive: context.commandBoundary.outputMode === "human",
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
      .option(
        "--retire-credentials",
        "retire all exact owned stored credentials for this connection",
      )
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
  inputSchema: z.strictObject({
    apply: z.boolean(),
    name: nameSchema,
    retireCredentials: z.boolean(),
  }),
  machineRecords: (value) => [value],
  outputSchema: unconfigureValueSchema,
  readInput: (command: Command) => ({
    apply: option(command, "yes") === true,
    name: argument(command, 0),
    retireCredentials: option(command, "retireCredentials") === true,
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
