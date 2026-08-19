import type { Command } from "commander";
import { z } from "zod";

import type { CliOperationResult } from "./cli-contract.js";
import {
  defineCliCommandModule,
  type RuntimeCliCommandModule,
} from "./command-runtime.js";

const harnessNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const harnessTypeSchema = z
  .string()
  .regex(/^@agentscope\/harness-[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const discoverySchema = z.strictObject({
  configurationLocationCount: z.number().int().nonnegative().max(16),
  configurationPresentCount: z.number().int().nonnegative().max(16),
  harness: harnessNameSchema,
  harnessType: harnessTypeSchema,
  reason: z.enum([
    "compatible",
    "not-found",
    "probe-unavailable",
    "ambiguous-executable",
    "version-unavailable",
    "version-invalid",
    "version-unsupported",
  ]),
  state: z.enum(["installed", "absent", "unsupported", "indeterminate"]),
  version: z.string().min(1).max(128).nullable(),
});
export type CliHarnessDiscovery = z.infer<typeof discoverySchema>;

const harnessListSchema = z.strictObject({
  harnesses: z.array(discoverySchema).max(32),
});
export type CliHarnessListValue = z.infer<typeof harnessListSchema>;
const harnessStatusSchema = z.strictObject({
  discovery: discoverySchema,
  installation: z.enum([
    "ready",
    "unchanged",
    "conflict",
    "unsupported",
    "recovery-required",
    "invalid",
    "unavailable",
  ]),
});
export type CliHarnessStatusValue = z.infer<typeof harnessStatusSchema>;
const harnessMutationSchema = z.strictObject({
  applied: z.boolean(),
  changedTargetCount: z.number().int().nonnegative().max(16),
  disposition: z.enum([
    "ready",
    "unchanged",
    "conflict",
    "unsupported",
    "recovery-required",
    "invalid",
    "unavailable",
    "committed",
    "rolled-back",
  ]),
  harness: harnessNameSchema,
  operation: z.enum(["install", "migrate", "uninstall"]),
  targetCount: z.number().int().nonnegative().max(16),
});
export type CliHarnessMutationValue = z.infer<typeof harnessMutationSchema>;

type Result<Value> = CliOperationResult<Value>;

export type CliHarnessServices = Readonly<{
  installHarness: (
    input: Readonly<{
      apply: boolean;
      harness: string;
      presentPlan: (value: CliHarnessMutationValue) => Promise<void>;
    }>,
  ) =>
    | Result<z.infer<typeof harnessMutationSchema>>
    | Promise<Result<z.infer<typeof harnessMutationSchema>>>;
  listHarnesses: () =>
    | Result<z.infer<typeof harnessListSchema>>
    | Promise<Result<z.infer<typeof harnessListSchema>>>;
  migrateHarness: (
    input: Readonly<{
      apply: boolean;
      harness: string;
      presentPlan: (value: CliHarnessMutationValue) => Promise<void>;
    }>,
  ) =>
    | Result<z.infer<typeof harnessMutationSchema>>
    | Promise<Result<z.infer<typeof harnessMutationSchema>>>;
  statusHarness: (
    input: Readonly<{ harness: string }>,
  ) =>
    | Result<z.infer<typeof harnessStatusSchema>>
    | Promise<Result<z.infer<typeof harnessStatusSchema>>>;
  uninstallHarness: (
    input: Readonly<{
      apply: boolean;
      harness: string;
      presentPlan: (value: CliHarnessMutationValue) => Promise<void>;
    }>,
  ) =>
    | Result<z.infer<typeof harnessMutationSchema>>
    | Promise<Result<z.infer<typeof harnessMutationSchema>>>;
}>;

const argument = (command: Command, index: number): unknown =>
  command.processedArgs[index];

const applyRequested = (command: Command): boolean => {
  const options: unknown = command.opts();
  if (typeof options !== "object" || options === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(options, "yes");
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value === true
    : false;
};

const discoveryLine = (value: CliHarnessDiscovery): string =>
  `${value.harness}: ${value.state} (${value.reason}${value.version === null ? "" : `, ${value.version}`})`;

const listModule = defineCliCommandModule({
  configure: () => undefined,
  execute: (services: CliHarnessServices) => services.listHarnesses(),
  human: (value) =>
    value.harnesses.length === 0
      ? ["No first-party harness adapters are registered."]
      : value.harnesses.map(discoveryLine),
  id: "harness.list",
  inputSchema: z.strictObject({}),
  machineRecords: (value) => value.harnesses,
  outputSchema: harnessListSchema,
  readInput: () => ({}),
});

const statusModule = defineCliCommandModule({
  configure: (command: Command) => {
    command.argument("<harness>", "first-party harness name");
  },
  execute: (services: CliHarnessServices, input) =>
    services.statusHarness(input),
  human: (value) => [
    discoveryLine(value.discovery),
    `Owned installation plan: ${value.installation}`,
  ],
  id: "harness.status",
  inputSchema: z.strictObject({ harness: harnessNameSchema }),
  machineRecords: (value) => [value],
  outputSchema: harnessStatusSchema,
  readInput: (command: Command) => ({ harness: argument(command, 0) }),
});

const mutationModule = (
  id: "install" | "uninstall" | "harness.migrate",
  operation: "install" | "migrate" | "uninstall",
): RuntimeCliCommandModule =>
  defineCliCommandModule({
    configure: (command: Command) => {
      command
        .argument("<harness>", "first-party harness name")
        .option("--yes", "apply the inspected plan");
    },
    execute: (services: CliHarnessServices, input, context) => {
      const presented = { ...input, presentPlan: context.presentPlan };
      if (operation === "install") return services.installHarness(presented);
      if (operation === "uninstall")
        return services.uninstallHarness(presented);
      return services.migrateHarness(presented);
    },
    human: (value) => [
      `${value.operation} ${value.harness}: ${value.disposition}`,
      value.applied
        ? `Applied ${value.changedTargetCount} owned target change(s).`
        : `Dry-run: ${value.changedTargetCount} of ${value.targetCount} target(s) would change.`,
    ],
    id,
    inputSchema: z.strictObject({
      apply: z.boolean(),
      harness: harnessNameSchema,
    }),
    machineRecords: (value) => [value],
    outputSchema: harnessMutationSchema,
    readInput: (command: Command) => ({
      apply: applyRequested(command),
      harness: argument(command, 0),
    }),
  });

export const harnessCommandModules: readonly RuntimeCliCommandModule[] =
  Object.freeze([
    listModule,
    statusModule,
    mutationModule("install", "install"),
    mutationModule("uninstall", "uninstall"),
    mutationModule("harness.migrate", "migrate"),
  ]);
