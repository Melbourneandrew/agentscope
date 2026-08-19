import { describe, expect, it } from "vitest";

import { cliDiagnosticSchema } from "./cli-contract.js";
import {
  escapeTerminalText,
  exitCodeForCategory,
  reconstructCliValue,
  serializeJsonLine,
  writeCliDiagnostic,
  writeHumanResult,
  writeMachineResult,
} from "./presentation.js";
import type { CliOutput } from "./presentation.js";

function sink(): Readonly<{
  output: CliOutput;
  stderr: string[];
  stdout: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    output: {
      writeErr: (text) => {
        stderr.push(text);
      },
      writeOut: (text) => {
        stdout.push(text);
      },
    },
    stderr,
    stdout,
  };
}

describe("CLI presentation bounds", () => {
  it("enforces diagnostic fact and exit contracts", async () => {
    const facts = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`fact${index}`, true]),
    );
    expect(
      cliDiagnosticSchema.safeParse({
        category: "unavailable",
        code: "sample.unavailable",
        facts,
      }).success,
    ).toBe(false);
    expect(exitCodeForCategory("permission-denied")).toBe(6);

    const captured = sink();
    await writeCliDiagnostic(captured.output, "json", "agentscope sample", {
      category: "unavailable",
      code: "sample.unavailable",
      facts: { retryable: false },
    });
    expect(captured.stderr[0]).toContain('"retryable":false');
  });

  it("bounds terminal and serialized text", () => {
    expect(() => escapeTerminalText("x".repeat(65_537))).toThrow(
      "cli.presentation.invalid",
    );
    const records = Array.from({ length: 20 }, () => "x".repeat(65_000));
    expect(() => serializeJsonLine(records)).toThrow(
      "cli.presentation.invalid",
    );
  });

  it.each([
    ["undefined", undefined],
    ["nonfinite", Number.NaN],
    ["custom prototype", new Date(0)],
    ["symbol key", Object.assign({}, { [Symbol("x")]: true })],
    ["empty key", { "": true }],
    ["long key", { ["x".repeat(129)]: true }],
    ["long string", "x".repeat(65_537)],
    ["oversized array", Array.from({ length: 4_097 })],
  ])("rejects %s", (_name, value) => {
    expect(() => reconstructCliValue(value)).toThrow(
      "cli.presentation.invalid",
    );
  });

  it("rejects excessive depth and node count", () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 26; index += 1) deep = { child: deep };
    expect(() => reconstructCliValue(deep)).toThrow("cli.presentation.invalid");
    expect(() =>
      reconstructCliValue(Array.from({ length: 4_096 }, () => [1, 2, 3, 4])),
    ).toThrow("cli.presentation.invalid");
  });

  it("validates a complete human result before its first write", async () => {
    const captured = sink();
    await expect(
      writeHumanResult(captured.output, ["valid", 1]),
    ).rejects.toThrow("cli.presentation.invalid");
    expect(captured.stdout).toEqual([]);
  });

  it("emits an empty JSONL summary", async () => {
    const captured = sink();
    await writeMachineResult(captured.output, {
      command: "agentscope sample list",
      completion: "complete",
      dataSchema: "agentscope.cli.sample-list.v1",
      mode: "jsonl",
      records: [],
    });
    expect(captured.stdout).toHaveLength(1);
    expect(captured.stdout[0]).toContain('"count":0');
  });
});
