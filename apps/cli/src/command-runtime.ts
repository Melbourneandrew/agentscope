import type { Command } from "commander";
import { z } from "zod";

import {
  cliDiagnosticSchema,
  cliOutputModeSchema,
  INTERNAL_DIAGNOSTIC,
  INVALID_INPUT_DIAGNOSTIC,
  INVALID_OUTPUT_MODE_DIAGNOSTIC,
} from "./cli-contract.js";
import type {
  CliDiagnostic,
  CliOperationResult,
  CliOutputMode,
} from "./cli-contract.js";
import type { CommandRegistration } from "./command-registry.js";
import { commandDocumentationUrl, commandPath } from "./command-registry.js";
import {
  reconstructCliValue,
  writeCliDiagnostic,
  writeHumanResult,
  writeMachineResult,
} from "./presentation.js";
import type { CliOutput } from "./presentation.js";

const operationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("success"), value: z.unknown() }),
  z.strictObject({
    diagnostic: z.unknown(),
    status: z.literal("partial"),
    value: z.unknown(),
  }),
  z.strictObject({
    diagnostic: z.unknown(),
    status: z.literal("failure"),
  }),
]);

export type CliCommandModule<Services, Input, Value> = Readonly<{
  configure: (command: Command) => void;
  execute: (
    services: Services,
    input: Input,
  ) => CliOperationResult<Value> | Promise<CliOperationResult<Value>>;
  human: (value: Value) => readonly string[];
  id: string;
  inputSchema: z.ZodType<Input>;
  machineRecords: (value: Value) => readonly unknown[];
  outputSchema: z.ZodType<Value>;
  readInput: (command: Command) => unknown;
}>;

export type RuntimeCliCommandModule = Readonly<{
  configure: (command: Command) => void;
  execute: (services: unknown, input: unknown) => unknown;
  human: (value: unknown) => readonly string[];
  id: string;
  inputSchema: z.ZodType<unknown>;
  machineRecords: (value: unknown) => readonly unknown[];
  outputSchema: z.ZodType<unknown>;
  readInput: (command: Command) => unknown;
}>;

type RuntimeModule = RuntimeCliCommandModule;

export function defineCliCommandModule<Services, Input, Value>(
  module: CliCommandModule<Services, Input, Value>,
): RuntimeCliCommandModule {
  return Object.freeze({
    configure: module.configure,
    execute: (services: unknown, input: unknown) =>
      module.execute(services as Services, input as Input),
    human: (value: unknown) => module.human(value as Value),
    id: module.id,
    inputSchema: module.inputSchema,
    machineRecords: (value: unknown) => module.machineRecords(value as Value),
    outputSchema: module.outputSchema,
    readInput: module.readInput,
  });
}

export type CliExecutionState = {
  exitCode: number;
};

export type InstallCommandRuntimeInput = Readonly<{
  modules: readonly RuntimeModule[];
  output: CliOutput;
  program: Command;
  registry: readonly CommandRegistration[];
  services: unknown;
  state: CliExecutionState;
}>;

function assertDiagnosticAllowed(
  registration: CommandRegistration,
  diagnostic: CliDiagnostic,
): void {
  if (
    diagnostic.code !== INTERNAL_DIAGNOSTIC.code &&
    diagnostic.code !== INVALID_INPUT_DIAGNOSTIC.code &&
    diagnostic.code !== INVALID_OUTPUT_MODE_DIAGNOSTIC.code &&
    !registration.diagnostics.includes(diagnostic.code)
  ) {
    throw new Error("cli.runtime.invalid");
  }
}

function parseDiagnostic(
  registration: CommandRegistration,
  input: unknown,
): CliDiagnostic {
  const diagnostic = cliDiagnosticSchema.parse(reconstructCliValue(input));
  assertDiagnosticAllowed(registration, diagnostic);
  return Object.freeze({
    ...diagnostic,
    ...(diagnostic.facts === undefined
      ? {}
      : { facts: Object.freeze({ ...diagnostic.facts }) }),
  });
}

function parseMode(command: Command): CliOutputMode | undefined {
  const parsed = cliOutputModeSchema.safeParse(command.opts().output);
  return parsed.success ? parsed.data : undefined;
}

type RenderValueInput = Readonly<{
  completion: "complete" | "partial";
  mode: CliOutputMode;
  module: RuntimeModule;
  output: CliOutput;
  registration: CommandRegistration;
  value: unknown;
}>;

async function renderValue(input: RenderValueInput): Promise<void> {
  const parsed = input.module.outputSchema.parse(input.value);
  if (input.mode === "human") {
    await writeHumanResult(input.output, input.module.human(parsed));
    return;
  }
  if (input.registration.dataSchema === null) {
    throw new Error("cli.runtime.invalid");
  }
  await writeMachineResult(input.output, {
    command: commandPath(input.registration),
    completion: input.completion,
    dataSchema: input.registration.dataSchema,
    mode: input.mode,
    records: input.module.machineRecords(parsed),
  });
}

function isNativePromise(input: unknown): input is Promise<unknown> {
  return input instanceof Promise;
}

async function executeCommand(
  command: Command,
  module: RuntimeModule,
  registration: CommandRegistration,
  input: InstallCommandRuntimeInput,
): Promise<void> {
  const mode = parseMode(command);
  if (mode === undefined || !registration.outputModes.includes(mode)) {
    input.state.exitCode = await writeCliDiagnostic(
      input.output,
      mode ?? "human",
      commandPath(registration),
      INVALID_OUTPUT_MODE_DIAGNOSTIC,
    );
    return;
  }
  try {
    const candidate = reconstructCliValue(module.readInput(command));
    const parsedInput = module.inputSchema.safeParse(candidate);
    if (!parsedInput.success) {
      input.state.exitCode = await writeCliDiagnostic(
        input.output,
        mode,
        commandPath(registration),
        INVALID_INPUT_DIAGNOSTIC,
      );
      return;
    }
    const execution: unknown = module.execute(input.services, parsedInput.data);
    const serviceResult = isNativePromise(execution)
      ? await execution
      : execution;
    const result = operationResultSchema.parse(
      reconstructCliValue(serviceResult),
    );
    if (result.status === "failure") {
      const diagnostic = parseDiagnostic(registration, result.diagnostic);
      input.state.exitCode = await writeCliDiagnostic(
        input.output,
        mode,
        commandPath(registration),
        diagnostic,
      );
      return;
    }
    const diagnostic =
      result.status === "partial"
        ? parseDiagnostic(registration, result.diagnostic)
        : undefined;
    await renderValue({
      completion: result.status === "partial" ? "partial" : "complete",
      mode,
      module,
      output: input.output,
      registration,
      value: result.value,
    });
    input.state.exitCode =
      diagnostic === undefined
        ? 0
        : await writeCliDiagnostic(
            input.output,
            mode,
            commandPath(registration),
            diagnostic,
          );
  } catch {
    input.state.exitCode = await writeCliDiagnostic(
      input.output,
      mode,
      commandPath(registration),
      INTERNAL_DIAGNOSTIC,
    );
  }
}

function compileModuleMap(
  registry: readonly CommandRegistration[],
  modules: readonly RuntimeModule[],
): ReadonlyMap<string, RuntimeModule> {
  const expected = new Set(
    registry
      .filter((registration) => registration.kind === "command")
      .map((registration) => registration.id),
  );
  const compiled = new Map<string, RuntimeModule>();
  for (const module of modules) {
    if (
      !expected.has(module.id) ||
      compiled.has(module.id) ||
      Object.getPrototypeOf(module) !== Object.prototype
    ) {
      throw new Error("cli.runtime.invalid");
    }
    compiled.set(module.id, module);
  }
  if (compiled.size !== expected.size) throw new Error("cli.runtime.invalid");
  return compiled;
}

function addDocumentation(
  command: Command,
  registration: CommandRegistration,
): void {
  command.addHelpText(
    "after",
    `\nDocumentation: ${commandDocumentationUrl(registration)}\n`,
  );
}

export function installCommandRuntime(input: InstallCommandRuntimeInput): void {
  const modules = compileModuleMap(input.registry, input.modules);
  const commands = new Map<string, Command>([["", input.program]]);
  const root = input.registry.find(
    (registration) => registration.kind === "root",
  );
  if (root === undefined) throw new Error("cli.runtime.invalid");
  addDocumentation(input.program, root);

  for (const registration of input.registry) {
    if (registration.kind === "root") continue;
    const parentPath = registration.path.slice(0, -1).join(" ");
    const parent = commands.get(parentPath);
    const segment = registration.path.at(-1);
    if (parent === undefined || segment === undefined) {
      throw new Error("cli.runtime.invalid");
    }
    const command = parent.command(segment).description(registration.summary);
    commands.set(registration.path.join(" "), command);
    addDocumentation(command, registration);
    if (registration.kind !== "command") continue;
    const module = modules.get(registration.id);
    if (module === undefined) throw new Error("cli.runtime.invalid");
    command.option(
      "--output <mode>",
      "output mode: human, json, or jsonl",
      "human",
    );
    module.configure(command);
    command.action(async () => {
      await executeCommand(command, module, registration, input);
    });
  }
}
