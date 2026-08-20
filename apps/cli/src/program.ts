import { Command, CommanderError } from "commander";
import { z } from "zod";

import {
  cliOutputModeSchema,
  INTERNAL_DIAGNOSTIC,
  INVALID_INPUT_DIAGNOSTIC,
} from "./cli-contract.js";
import type { CliOutputMode } from "./cli-contract.js";
import type {
  CliExecutionState,
  RuntimeCliCommandModule,
} from "./command-runtime.js";
import { installCommandRuntime } from "./command-runtime.js";
import { commandRegistry } from "./command-registry.js";
import type { CommandRegistration } from "./command-registry.js";
import { configurationCommandModules } from "./configuration-commands.js";
import { doctorCommandModules } from "./doctor-commands.js";
import { harnessCommandModules } from "./harness-commands.js";
import { traceCommandModules } from "./trace-commands.js";
import type { CliOutput } from "./presentation.js";
import { writeCliDiagnostic } from "./presentation.js";

const semanticVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const MAXIMUM_ARGUMENTS = 128;
const MAXIMUM_ARGUMENT_CODE_UNITS = 8_192;
const unsafeArgumentCharacter = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export type CreateProgramInput = Readonly<{
  createServices?: () => unknown;
  modules?: readonly RuntimeCliCommandModule[];
  output: CliOutput;
  registry?: readonly CommandRegistration[];
  services?: unknown;
  state: CliExecutionState;
  version: string;
}>;

export type RunCliInput = Readonly<{
  createServices?: () => unknown;
  modules?: readonly RuntimeCliCommandModule[];
  output?: CliOutput;
  registry?: readonly CommandRegistration[];
  services?: unknown;
  version: string;
}>;

function writeProcessStream(
  stream: NodeJS.WriteStream,
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) reject(new Error("cli.output.unavailable"));
      else resolve();
    });
  });
}

function processOutput(): CliOutput {
  return Object.freeze({
    writeErr: (text: string) => writeProcessStream(process.stderr, text),
    writeOut: (text: string) => writeProcessStream(process.stdout, text),
  });
}

function snapshotArguments(input: unknown): readonly string[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > MAXIMUM_ARGUMENTS
  ) {
    throw new Error("cli.arguments.invalid");
  }
  const output: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > MAXIMUM_ARGUMENT_CODE_UNITS ||
      unsafeArgumentCharacter.test(descriptor.value)
    ) {
      throw new Error("cli.arguments.invalid");
    }
    output.push(descriptor.value);
  }
  if (
    Reflect.ownKeys(input).some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
    )
  ) {
    throw new Error("cli.arguments.invalid");
  }
  return Object.freeze(output);
}

function requestedOutputMode(arguments_: readonly string[]): CliOutputMode {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    const candidate =
      argument === "--output"
        ? arguments_[index + 1]
        : argument.startsWith("--output=")
          ? argument.slice("--output=".length)
          : undefined;
    const parsed = cliOutputModeSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return "human";
}

export function createProgram(input: CreateProgramInput): Command {
  if (input.createServices !== undefined && input.services !== undefined)
    throw new Error("cli.runtime.invalid");
  const version = semanticVersionSchema.parse(input.version);
  const registry = input.registry ?? commandRegistry;
  const root = registry.find((registration) => registration.kind === "root");
  if (root === undefined) throw new Error("cli.registry.invalid");
  const program = new Command()
    .name("agentscope")
    .description(root.summary)
    .version(version, "-V, --version", "output the installed version")
    .showSuggestionAfterError(false)
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({
      outputError: () => undefined,
      writeErr: (text) => {
        void input.output.writeErr(text);
      },
      writeOut: (text) => {
        void input.output.writeOut(text);
      },
    });
  installCommandRuntime({
    ...(input.createServices === undefined
      ? {}
      : { createServices: input.createServices }),
    modules:
      input.modules ??
      Object.freeze([
        ...configurationCommandModules,
        ...doctorCommandModules,
        ...harnessCommandModules,
        ...traceCommandModules,
      ]),
    output: input.output,
    program,
    registry,
    services: input.services,
    state: input.state,
  });
  return program;
}

async function reportRunFailure(
  output: CliOutput,
  mode: CliOutputMode,
  diagnostic: typeof INTERNAL_DIAGNOSTIC,
): Promise<number> {
  try {
    return await writeCliDiagnostic(output, mode, "agentscope", diagnostic);
  } catch {
    return 70;
  }
}

export async function runCli(
  argumentsInput: unknown,
  input: RunCliInput,
): Promise<number> {
  const output = input.output ?? processOutput();
  let arguments_: readonly string[];
  try {
    arguments_ = snapshotArguments(argumentsInput);
  } catch {
    return reportRunFailure(output, "human", INVALID_INPUT_DIAGNOSTIC);
  }
  const mode = requestedOutputMode(arguments_);
  const state: CliExecutionState = { exitCode: 0 };
  let program: Command;
  try {
    program = createProgram({ ...input, output, state });
  } catch {
    return reportRunFailure(output, mode, INTERNAL_DIAGNOSTIC);
  }
  try {
    await program.parseAsync(arguments_, { from: "user" });
    return state.exitCode;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      return reportRunFailure(output, mode, INVALID_INPUT_DIAGNOSTIC);
    }
    return reportRunFailure(output, mode, INTERNAL_DIAGNOSTIC);
  }
}
