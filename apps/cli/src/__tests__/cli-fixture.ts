import type { Command } from "commander";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { CliOperationResult } from "../cli-contract.js";
import { defineCliCommandModule } from "../command-runtime.js";
import { compileCommandRegistry } from "../command-registry.js";
import type { CliOutput } from "../presentation.js";
import { runCli } from "../program.js";

const itemSchema = z.strictObject({ id: z.string(), label: z.string() });
const valueSchema = z.strictObject({ items: z.array(itemSchema) });
const inputSchema = z.strictObject({ name: z.string().min(1).max(32) });

export const fixtureRegistry = compileCommandRegistry([
  {
    dataSchema: null,
    diagnostics: ["cli.internal", "cli.usage"],
    documentationPage: "cli/index.mdx",
    id: "root",
    kind: "root",
    outputModes: ["human"],
    path: [],
    summary: "Fixture root.",
    visibility: "public",
  },
  {
    dataSchema: null,
    diagnostics: [],
    documentationPage: "cli/sample/index.mdx",
    id: "sample",
    kind: "group",
    outputModes: ["human"],
    path: ["sample"],
    summary: "Fixture group.",
    visibility: "public",
  },
  {
    dataSchema: "agentscope.cli.sample-list.v1",
    diagnostics: [
      "sample.conflict",
      "sample.internal",
      "sample.not-found",
      "sample.permission-denied",
      "sample.unavailable",
      "sample.usage",
    ],
    documentationPage: "cli/sample/list.mdx",
    id: "sample.list",
    kind: "command",
    outputModes: ["human", "json", "jsonl"],
    path: ["sample", "list"],
    summary: "List fixture values.",
    visibility: "public",
  },
]);

export type FixtureServices = Readonly<{
  run: (input: Readonly<{ name: string }>) => unknown;
}>;

export const fixtureModule = defineCliCommandModule({
  configure: (command: Command) => {
    command.requiredOption("--name <name>", "fixture name");
  },
  execute: (services: FixtureServices, input) =>
    services.run(input) as CliOperationResult<{
      items: { id: string; label: string }[];
    }>,
  human: (value) => value.items.map((item) => item.label),
  id: "sample.list",
  inputSchema,
  machineRecords: (value) => value.items,
  outputSchema: valueSchema,
  readInput: (command: Command) => {
    const options: unknown = command.opts();
    if (typeof options !== "object" || options === null) return {};
    const descriptor = Object.getOwnPropertyDescriptor(options, "name");
    const value: unknown =
      descriptor !== undefined && "value" in descriptor
        ? (descriptor as { value: unknown }).value
        : undefined;
    return {
      name: value,
    };
  },
});

export function createCapturedOutput(): Readonly<{
  output: CliOutput;
  stderr: string[];
  stdout: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    output: {
      writeErr: (text: string) => {
        stderr.push(text);
      },
      writeOut: (text: string) => {
        stdout.push(text);
      },
    },
    stderr,
    stdout,
  };
}

export async function runFixture(
  arguments_: unknown,
  run: FixtureServices["run"],
  outputInput?: CliOutput,
): Promise<
  Readonly<{
    exitCode: number;
    serviceCalls: number;
    stderr: readonly string[];
    stdout: readonly string[];
  }>
> {
  const captured = createCapturedOutput();
  let serviceCalls = 0;
  const exitCode = await runCli(arguments_, {
    modules: [fixtureModule],
    output: outputInput ?? captured.output,
    registry: fixtureRegistry,
    services: {
      run: (input) => {
        serviceCalls += 1;
        return run(input);
      },
    } satisfies FixtureServices,
    version: "1.2.3",
  });
  return {
    exitCode,
    serviceCalls,
    stderr: captured.stderr,
    stdout: captured.stdout,
  };
}

describe("CLI fixture", () => {
  it("compiles the full root, group, and command shape", () => {
    expect(fixtureRegistry.map((registration) => registration.id)).toEqual([
      "root",
      "sample",
      "sample.list",
    ]);
  });
});
