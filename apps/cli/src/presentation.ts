import type {
  CliDiagnostic,
  CliExitCategory,
  CliOutputMode,
} from "./cli-contract.js";
import { CLI_EXIT_CODES } from "./cli-contract.js";

export type CliOutput = Readonly<{
  writeErr: (text: string) => Promise<void> | void;
  writeOut: (text: string) => Promise<void> | void;
}>;

const MAXIMUM_TEXT_CODE_UNITS = 65_536;
const MAXIMUM_COLLECTION_ITEMS = 4_096;
const MAXIMUM_JSON_DEPTH = 24;
const MAXIMUM_JSON_NODES = 16_384;
const MAXIMUM_JSON_BYTES = 1_048_576;
const unsafeTerminalCharacter = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new Error("cli.presentation.invalid");
  return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
}

export function escapeTerminalText(input: string): string {
  if (input.length > MAXIMUM_TEXT_CODE_UNITS) {
    throw new Error("cli.presentation.invalid");
  }
  return input.replace(unsafeTerminalCharacter, unicodeEscape);
}

function snapshotDenseArray(input: unknown): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  ) {
    throw new Error("cli.presentation.invalid");
  }
  if (input.length > MAXIMUM_COLLECTION_ITEMS) {
    throw new Error("cli.presentation.invalid");
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
    )
  ) {
    throw new Error("cli.presentation.invalid");
  }
  const values: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("cli.presentation.invalid");
    }
    values.push(descriptor.value);
  }
  return values;
}

type TraversalState = {
  readonly seen: Set<object>;
  nodes: number;
};

function reconstructJsonValue(
  input: unknown,
  depth: number,
  state: TraversalState,
): unknown {
  state.nodes += 1;
  if (depth > MAXIMUM_JSON_DEPTH || state.nodes > MAXIMUM_JSON_NODES) {
    throw new Error("cli.presentation.invalid");
  }
  if (
    input === null ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return input;
  }
  if (typeof input === "string") {
    if (input.length > MAXIMUM_TEXT_CODE_UNITS) {
      throw new Error("cli.presentation.invalid");
    }
    return input;
  }
  if (typeof input !== "object" || state.seen.has(input)) {
    throw new Error("cli.presentation.invalid");
  }
  state.seen.add(input);
  if (Array.isArray(input)) {
    return snapshotDenseArray(input).map((value) =>
      reconstructJsonValue(value, depth + 1, state),
    );
  }
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error("cli.presentation.invalid");
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length > MAXIMUM_COLLECTION_ITEMS ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw new Error("cli.presentation.invalid");
  }
  const output: Record<string, unknown> = {};
  for (const key of [...(keys as string[])].sort()) {
    if (key.length === 0 || key.length > 128) {
      throw new Error("cli.presentation.invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("cli.presentation.invalid");
    }
    output[key] = reconstructJsonValue(descriptor.value, depth + 1, state);
  }
  return output;
}

export function reconstructCliValue(input: unknown): unknown {
  return reconstructJsonValue(input, 0, { nodes: 0, seen: new Set() });
}

export function serializeJsonLine(input: unknown): string {
  const reconstructed = reconstructJsonValue(input, 0, {
    nodes: 0,
    seen: new Set(),
  });
  const serialized = JSON.stringify(reconstructed);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_JSON_BYTES) {
    throw new Error("cli.presentation.invalid");
  }
  return `${serialized}\n`;
}

function snapshotLines(lines: unknown): readonly string[] {
  return snapshotDenseArray(lines).map((line) => {
    if (typeof line !== "string") throw new Error("cli.presentation.invalid");
    return escapeTerminalText(line);
  });
}

export async function writeHumanResult(
  output: CliOutput,
  lines: unknown,
): Promise<void> {
  for (const line of snapshotLines(lines)) {
    await output.writeOut(`${line}\n`);
  }
}

export async function writeMachineResult(
  output: CliOutput,
  input: Readonly<{
    command: string;
    completion: "complete" | "partial";
    dataSchema: string;
    mode: Exclude<CliOutputMode, "human">;
    records: unknown;
  }>,
): Promise<void> {
  const records = snapshotDenseArray(input.records).map((record) =>
    reconstructJsonValue(record, 0, { nodes: 0, seen: new Set() }),
  );
  if (input.mode === "json") {
    const line = serializeJsonLine({
      command: input.command,
      completion: input.completion,
      dataSchema: input.dataSchema,
      records,
      schema: "agentscope.cli.result.v1",
    });
    await output.writeOut(line);
    return;
  }
  const lines = records.map((record, sequence) =>
    serializeJsonLine({
      command: input.command,
      data: record,
      dataSchema: input.dataSchema,
      kind: "data",
      schema: "agentscope.cli.record.v1",
      sequence,
    }),
  );
  lines.push(
    serializeJsonLine({
      command: input.command,
      count: records.length,
      completion: input.completion,
      dataSchema: input.dataSchema,
      kind: "summary",
      schema: "agentscope.cli.record.v1",
    }),
  );
  for (const line of lines) {
    await output.writeOut(line);
  }
}

export async function writeMachinePlan(
  output: CliOutput,
  input: Readonly<{
    command: string;
    dataSchema: string;
    mode: Exclude<CliOutputMode, "human">;
    records: unknown;
  }>,
): Promise<void> {
  const records = snapshotDenseArray(input.records).map((record) =>
    reconstructJsonValue(record, 0, { nodes: 0, seen: new Set() }),
  );
  if (input.mode === "json") {
    await output.writeErr(
      serializeJsonLine({
        command: input.command,
        dataSchema: input.dataSchema,
        records,
        schema: "agentscope.cli.plan.v1",
      }),
    );
    return;
  }
  for (const [sequence, record] of records.entries()) {
    await output.writeErr(
      serializeJsonLine({
        command: input.command,
        data: record,
        dataSchema: input.dataSchema,
        kind: "plan",
        schema: "agentscope.cli.plan-record.v1",
        sequence,
      }),
    );
  }
  await output.writeErr(
    serializeJsonLine({
      command: input.command,
      count: records.length,
      dataSchema: input.dataSchema,
      kind: "summary",
      schema: "agentscope.cli.plan-record.v1",
    }),
  );
}

export async function writeCliDiagnostic(
  output: CliOutput,
  mode: CliOutputMode,
  command: string,
  diagnostic: CliDiagnostic,
): Promise<number> {
  if (mode === "human") {
    await output.writeErr(`error [${diagnostic.code}]\n`);
  } else {
    await output.writeErr(
      serializeJsonLine({
        category: diagnostic.category,
        code: diagnostic.code,
        command,
        ...(diagnostic.facts === undefined ? {} : { facts: diagnostic.facts }),
        schema: "agentscope.cli.diagnostic.v1",
      }),
    );
  }
  return CLI_EXIT_CODES[diagnostic.category];
}

export function exitCodeForCategory(category: CliExitCategory): number {
  return CLI_EXIT_CODES[category];
}
