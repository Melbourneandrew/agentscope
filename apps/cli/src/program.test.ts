import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "./program.js";

function createOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    output: {
      writeOut: (text: string) => stdout.push(text),
      writeErr: (text: string) => stderr.push(text),
    },
    stderr,
    stdout,
  };
}

async function parseAndCapture(...arguments_: string[]) {
  const captured = createOutput();
  const program = createProgram(captured.output).exitOverride();
  let error: CommanderError | undefined;
  try {
    await program.parseAsync(arguments_, { from: "user" });
  } catch (candidate: unknown) {
    if (!(candidate instanceof CommanderError)) throw candidate;
    error = candidate;
  }
  return { ...captured, error };
}

describe("agentscope command shell", () => {
  it("renders deterministic, side-effect-free root help", async () => {
    // AC-CLI-001.1 AC-CLI-001.2 AC-CLI-001.4
    const result = await parseAndCapture("--help");

    expect(result.error?.exitCode).toBe(0);
    expect(result.error?.code).toBe("commander.helpDisplayed");
    expect(result.stderr).toEqual([]);
    expect(result.stdout.join("")).toMatchInlineSnapshot(`
      "Usage: agentscope [options]

      Capture coding-agent traces and report them to trace destinations.

      Options:
        -V, --version  output the installed version
        -h, --help     display help for command
      "
    `);
  });

  it("prints only the installed semantic version", async () => {
    // AC-INS-001.1 AC-INS-001.2
    const result = await parseAndCapture("--version");

    expect(result.error?.exitCode).toBe(0);
    expect(result.error?.code).toBe("commander.version");
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual(["0.1.0\n"]);
  });

  it("uses a deterministic non-zero usage result for unknown options", async () => {
    const result = await parseAndCapture("--does-not-exist");

    expect(result.error?.exitCode).toBe(1);
    expect(result.error?.code).toBe("commander.unknownOption");
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join("")).toContain(
      "error: unknown option '--does-not-exist'",
    );
  });
});
