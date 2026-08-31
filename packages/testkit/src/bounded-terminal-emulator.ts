import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export type PtyTerminalGeometry = Readonly<{
  columns: number;
  rows: number;
}>;

export type PtyTerminalEmulatorLimits = Readonly<{
  maximumCells: number;
  maximumColumns: number;
  maximumControlBytes: number;
  maximumOutputBytes: number;
  maximumRecentCodePoints: number;
  maximumRows: number;
  maximumTitleBytes: number;
}>;

export type PtySemanticState =
  | "active"
  | "ready"
  | "completed"
  | "credential-prompt"
  | "malformed-control"
  | "output-limit";

export type PtyTerminalSemanticSnapshot = Readonly<{
  snapshotVersion: 1;
  geometry: PtyTerminalGeometry;
  cursor: Readonly<{ column: number; row: number }>;
  alternateScreen: boolean;
  cursorVisible: boolean;
  outputBytes: number;
  printableCellCount: number;
  nonEmptyLineCount: number;
  malformedControlCount: number;
  unsupportedControlCount: number;
  sawCursorPositionQuery: boolean;
  titlePresent: boolean;
  titleSha256: string | null;
  screenSha256: string;
  semanticState: PtySemanticState;
}>;

export class BoundedTerminalEmulatorError extends Error {
  declare public readonly code: string;

  public constructor(code: string) {
    super(code);
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
  }
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const freezeAuthority = Object.freeze;
const defaultLimits: PtyTerminalEmulatorLimits = freezeAuthority({
  maximumCells: 65_536,
  maximumColumns: 512,
  maximumControlBytes: 512,
  maximumOutputBytes: 1_048_576,
  maximumRecentCodePoints: 2_048,
  maximumRows: 512,
  maximumTitleBytes: 512,
});
const credentialPromptPattern =
  /(?:password|passphrase|user[ _-]?name|e[ -]?mail|api[ _-]?(?:key|token)|access[ _-]?token|credential|sign[ -]?in|log[ -]?in|authenticate|authorization code)\s*[:>?]?\s*$/iu;
const readyMarker = "AGENTSCOPE_PTY_READY";
const completedMarker = "AGENTSCOPE_PTY_COMPLETE";
const defineOwnProperty = Reflect.defineProperty;
const getPrototypeOf = Reflect.getPrototypeOf;
const applyFunction = Reflect.apply;
const uint8ArrayPrototype = Uint8Array.prototype;
const arrayBufferPrototype = ArrayBuffer.prototype;
// eslint-disable-next-line @typescript-eslint/unbound-method
const arrayBufferSlice = ArrayBuffer.prototype.slice;
const TextDecoderAuthority = TextDecoder;
// eslint-disable-next-line @typescript-eslint/unbound-method
const textDecoderDecode = TextDecoder.prototype.decode;
const typedArrayPrototype = getPrototypeOf(uint8ArrayPrototype);
// Capturing the intrinsic getter prevents later prototype replacement from
// becoming input-validation authority.
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArrayBufferGetterCandidate = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)?.get as ((this: Uint8Array) => ArrayBuffer) | undefined;
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArrayByteLengthGetterCandidate = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get as ((this: Uint8Array) => number) | undefined;
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArrayByteOffsetGetterCandidate = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get as ((this: Uint8Array) => number) | undefined;

if (
  typedArrayBufferGetterCandidate === undefined ||
  typedArrayByteLengthGetterCandidate === undefined ||
  typedArrayByteOffsetGetterCandidate === undefined
)
  throw new Error("testkit.pty.emulator.runtime");
const typedArrayBufferGetter = typedArrayBufferGetterCandidate;
const typedArrayByteLengthGetter = typedArrayByteLengthGetterCandidate;
const typedArrayByteOffsetGetter = typedArrayByteOffsetGetterCandidate;

type ParserState = "ground" | "escape" | "csi" | "osc" | "osc-escape";

const fail = (code: string): never => {
  throw new BoundedTerminalEmulatorError(code);
};
const boundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= maximum;
const setOwnIndex = <T>(target: T[], index: number, value: T): void => {
  if (
    !defineOwnProperty(target, String(index), {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  )
    return fail("testkit.pty.emulator.array");
};
const filledOwnArray = <T>(length: number, value: T): T[] => {
  const result: T[] = [];
  for (let index = 0; index < length; index += 1)
    setOwnIndex(result, index, value);
  return result;
};
const strictRecord = (
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> => {
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value)
    )
      return fail(code);
    prototype = Reflect.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return fail(code);
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length
  )
    return fail(code);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const ownKey = ownKeys[index];
    let found = false;
    if (typeof ownKey === "string")
      for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1)
        if (keys[keyIndex] === ownKey) found = true;
    if (!found) return fail(code);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor)
    )
      return fail(code);
    result[key] = descriptor.value;
  }
  return result;
};
const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const containsText = (value: string, needle: string): boolean => {
  if (needle.length === 0) return true;
  for (let start = 0; start + needle.length <= value.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1)
      if (value[start + offset] !== needle[offset]) matches = false;
    if (matches) return true;
  }
  return false;
};

const validateLimits = (
  value: PtyTerminalEmulatorLimits,
): PtyTerminalEmulatorLimits => {
  const record = strictRecord(
    value,
    [
      "maximumCells",
      "maximumColumns",
      "maximumControlBytes",
      "maximumOutputBytes",
      "maximumRecentCodePoints",
      "maximumRows",
      "maximumTitleBytes",
    ],
    "testkit.pty.emulator.limits",
  );
  if (
    !boundedInteger(record.maximumCells, 1_048_576) ||
    !boundedInteger(record.maximumColumns, 4_096) ||
    !boundedInteger(record.maximumControlBytes, 4_096) ||
    !boundedInteger(record.maximumOutputBytes, 16_777_216) ||
    !boundedInteger(record.maximumRecentCodePoints, 16_384) ||
    !boundedInteger(record.maximumRows, 4_096) ||
    !boundedInteger(record.maximumTitleBytes, 4_096)
  )
    return fail("testkit.pty.emulator.limits");
  return freezeAuthority({
    maximumCells: record.maximumCells,
    maximumColumns: record.maximumColumns,
    maximumControlBytes: record.maximumControlBytes,
    maximumOutputBytes: record.maximumOutputBytes,
    maximumRecentCodePoints: record.maximumRecentCodePoints,
    maximumRows: record.maximumRows,
    maximumTitleBytes: record.maximumTitleBytes,
  });
};

const validateGeometry = (
  value: PtyTerminalGeometry,
  limits: PtyTerminalEmulatorLimits,
): PtyTerminalGeometry => {
  const record = strictRecord(
    value,
    ["columns", "rows"],
    "testkit.pty.emulator.geometry",
  );
  if (
    !boundedInteger(record.columns, limits.maximumColumns) ||
    !boundedInteger(record.rows, limits.maximumRows) ||
    record.columns * record.rows > limits.maximumCells
  )
    return fail("testkit.pty.emulator.geometry");
  return freezeAuthority({ columns: record.columns, rows: record.rows });
};

const parseCsiParameters = (
  value: string,
):
  Readonly<{ privateMode: boolean; values: readonly number[] }> | undefined => {
  const privateMode = value.startsWith("?");
  const body = privateMode ? value.slice(1) : value;
  if (!/^\d*(?:;\d*)*$/u.test(body)) return undefined;
  const parts = body.split(";");
  const values: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] === "" ? 0 : Number(parts[index]);
    if (!Number.isSafeInteger(part) || part > 65_535) return undefined;
    setOwnIndex(values, index, part);
  }
  return { privateMode, values };
};

export class BoundedTerminalEmulator {
  readonly #decoder = new TextDecoderAuthority("utf-8", { fatal: true });
  readonly #limits: PtyTerminalEmulatorLimits;
  #geometry: PtyTerminalGeometry;
  #cells: string[];
  #row = 0;
  #column = 0;
  #alternateScreen = false;
  #cursorVisible = true;
  #state: ParserState = "ground";
  #control = "";
  #outputBytes = 0;
  #malformedControlCount = 0;
  #unsupportedControlCount = 0;
  #sawCursorPositionQuery = false;
  readonly #recentCodePoints: string[] = [];
  #recentStart = 0;
  #titleSha256: string | null = null;
  #ended = false;
  #outputLimitReached = false;

  public constructor(
    geometry: PtyTerminalGeometry,
    limits: PtyTerminalEmulatorLimits = defaultLimits,
  ) {
    this.#limits = validateLimits(limits);
    this.#geometry = validateGeometry(geometry, this.#limits);
    this.#cells = filledOwnArray(
      this.#geometry.columns * this.#geometry.rows,
      " ",
    );
  }

  public write(bytes: Uint8Array): void {
    if (this.#ended) return fail("testkit.pty.emulator.ended");
    let byteLength: number;
    let byteOffset: number;
    let buffer: ArrayBuffer;
    try {
      buffer = applyFunction(typedArrayBufferGetter, bytes, []);
      if (
        isProxy(bytes) ||
        getPrototypeOf(bytes) !== uint8ArrayPrototype ||
        getPrototypeOf(buffer) !== arrayBufferPrototype
      )
        return fail("testkit.pty.emulator.bytes");
      byteLength = applyFunction(typedArrayByteLengthGetter, bytes, []);
      byteOffset = applyFunction(typedArrayByteOffsetGetter, bytes, []);
    } catch {
      return fail("testkit.pty.emulator.bytes");
    }
    if (this.#outputBytes + byteLength > this.#limits.maximumOutputBytes) {
      this.#outputLimitReached = true;
      return fail("testkit.pty.emulator.output-limit");
    }
    this.#outputBytes += byteLength;
    let decoded: string;
    try {
      const boundedInput = applyFunction(arrayBufferSlice, buffer, [
        byteOffset,
        byteOffset + byteLength,
      ]);
      decoded = applyFunction(textDecoderDecode, this.#decoder, [
        boundedInput,
        {
          stream: true,
        },
      ]);
    } catch {
      this.#malformedControlCount += 1;
      return fail("testkit.pty.emulator.utf8");
    }
    for (const character of decoded) this.#consume(character);
  }

  public resize(geometry: PtyTerminalGeometry): void {
    if (this.#ended) return fail("testkit.pty.emulator.ended");
    const next = validateGeometry(geometry, this.#limits);
    const cells = filledOwnArray(next.columns * next.rows, " ");
    const rows = Math.min(next.rows, this.#geometry.rows);
    const columns = Math.min(next.columns, this.#geometry.columns);
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < columns; column += 1)
        setOwnIndex(
          cells,
          row * next.columns + column,
          this.#cells[row * this.#geometry.columns + column]!,
        );
    this.#geometry = next;
    this.#cells = cells;
    this.#row = Math.min(this.#row, next.rows - 1);
    this.#column = Math.min(this.#column, next.columns - 1);
  }

  public end(): PtyTerminalSemanticSnapshot {
    if (!this.#ended) {
      try {
        const final = applyFunction(textDecoderDecode, this.#decoder, []);
        for (const character of final) this.#consume(character);
      } catch {
        this.#malformedControlCount += 1;
      }
      if (this.#state !== "ground") this.#malformedControlCount += 1;
      this.#state = "ground";
      this.#control = "";
      this.#ended = true;
    }
    return this.snapshot();
  }

  public snapshot(): PtyTerminalSemanticSnapshot {
    let printableCellCount = 0;
    let nonEmptyLineCount = 0;
    for (let row = 0; row < this.#geometry.rows; row += 1) {
      let nonEmpty = false;
      for (let column = 0; column < this.#geometry.columns; column += 1) {
        if (this.#cells[row * this.#geometry.columns + column] !== " ") {
          printableCellCount += 1;
          nonEmpty = true;
        }
      }
      if (nonEmpty) nonEmptyLineCount += 1;
    }
    const recent = this.#recentText();
    const semanticState: PtySemanticState = this.#outputLimitReached
      ? "output-limit"
      : this.#malformedControlCount > 0 || this.#unsupportedControlCount > 0
        ? "malformed-control"
        : credentialPromptPattern.test(recent)
          ? "credential-prompt"
          : containsText(recent, completedMarker)
            ? "completed"
            : containsText(recent, readyMarker)
              ? "ready"
              : "active";
    let cells = "";
    for (let index = 0; index < this.#cells.length; index += 1)
      cells += this.#cells[index];
    const screenSha256 = hash(
      `${this.#alternateScreen ? "1" : "0"}\u0000${cells}\u0000${this.#row}\u0000${this.#column}\u0000${this.#geometry.columns}\u0000${this.#geometry.rows}`,
    );
    return freezeAuthority({
      snapshotVersion: 1 as const,
      geometry: this.#geometry,
      cursor: freezeAuthority({ column: this.#column, row: this.#row }),
      alternateScreen: this.#alternateScreen,
      cursorVisible: this.#cursorVisible,
      outputBytes: this.#outputBytes,
      printableCellCount,
      nonEmptyLineCount,
      malformedControlCount: this.#malformedControlCount,
      unsupportedControlCount: this.#unsupportedControlCount,
      sawCursorPositionQuery: this.#sawCursorPositionQuery,
      titlePresent: this.#titleSha256 !== null,
      titleSha256: this.#titleSha256,
      screenSha256,
      semanticState,
    });
  }

  #consume(character: string): void {
    if (this.#state === "ground") {
      if (character === "\u001b") {
        this.#state = "escape";
        return;
      }
      this.#consumeGround(character);
      return;
    }
    if (this.#state === "escape") {
      if (character === "[") {
        this.#state = "csi";
        this.#control = "";
      } else if (character === "]") {
        this.#state = "osc";
        this.#control = "";
      } else {
        this.#malformedControlCount += 1;
        this.#state = "ground";
        this.#consumeGround(character);
      }
      return;
    }
    if (this.#state === "csi") {
      this.#consumeCsi(character);
      return;
    }
    if (this.#state === "osc") {
      if (character === "\u0007") {
        this.#finishOsc();
      } else if (character === "\u001b") {
        this.#state = "osc-escape";
      } else {
        this.#appendControl(character);
      }
      return;
    }
    if (character === "\\") this.#finishOsc();
    else {
      this.#appendControl("\u001b");
      this.#appendControl(character);
      this.#state = "osc";
    }
  }

  #consumeGround(character: string): void {
    if (character === "\r") {
      this.#column = 0;
      return;
    }
    if (character === "\n") {
      this.#lineFeed();
      return;
    }
    if (character === "\b") {
      this.#column = Math.max(0, this.#column - 1);
      return;
    }
    if (character === "\t") {
      this.#column = Math.min(
        this.#geometry.columns - 1,
        Math.ceil((this.#column + 1) / 8) * 8,
      );
      return;
    }
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      this.#malformedControlCount += 1;
      return;
    }
    this.#cells[this.#row * this.#geometry.columns + this.#column] = character;
    this.#appendRecent(character);
    if (this.#column === this.#geometry.columns - 1) {
      this.#column = 0;
      this.#lineFeed();
    } else this.#column += 1;
  }

  #consumeCsi(character: string): void {
    const code = character.codePointAt(0)!;
    if (code >= 0x40 && code <= 0x7e) {
      const parameters = parseCsiParameters(this.#control);
      if (parameters === undefined) this.#malformedControlCount += 1;
      else this.#applyCsi(character, parameters.privateMode, parameters.values);
      this.#control = "";
      this.#state = "ground";
      return;
    }
    if (code < 0x20 || code > 0x3f) {
      this.#malformedControlCount += 1;
      this.#control = "";
      this.#state = "ground";
      return;
    }
    this.#appendControl(character);
  }

  #applyCsi(
    final: string,
    privateMode: boolean,
    values: readonly number[],
  ): void {
    const first = values[0] ?? 0;
    const amount = Math.max(1, first);
    if (privateMode) {
      this.#applyPrivateCsi(final, first);
      return;
    }
    if (final === "H" || final === "f") {
      this.#row = Math.min(this.#geometry.rows - 1, Math.max(0, amount - 1));
      this.#column = Math.min(
        this.#geometry.columns - 1,
        Math.max(0, Math.max(1, values[1] ?? 1) - 1),
      );
    } else if (final === "A") this.#row = Math.max(0, this.#row - amount);
    else if (final === "B")
      this.#row = Math.min(this.#geometry.rows - 1, this.#row + amount);
    else if (final === "C")
      this.#column = Math.min(
        this.#geometry.columns - 1,
        this.#column + amount,
      );
    else if (final === "D") this.#column = Math.max(0, this.#column - amount);
    else if (final === "J" && (first === 0 || first === 2)) this.#clearScreen();
    else if (final === "K" && (first === 0 || first === 2))
      this.#clearLine(first === 2);
    else if (final === "m") return;
    else if (final === "n" && first === 6) this.#sawCursorPositionQuery = true;
    else this.#unsupportedControlCount += 1;
  }

  #applyPrivateCsi(final: string, first: number): void {
    if (final !== "h" && final !== "l") {
      this.#unsupportedControlCount += 1;
      return;
    }
    if (first === 1049) this.#alternateScreen = final === "h";
    else if (first === 25) this.#cursorVisible = final === "h";
    else this.#unsupportedControlCount += 1;
  }

  #appendControl(character: string): void {
    this.#control += character;
    if (
      Buffer.byteLength(this.#control, "utf8") >
      this.#limits.maximumControlBytes
    ) {
      this.#malformedControlCount += 1;
      this.#control = "";
      this.#state = "ground";
    }
  }

  #finishOsc(): void {
    const separator = this.#control.indexOf(";");
    const selector = separator < 0 ? "" : this.#control.slice(0, separator);
    const title = separator < 0 ? "" : this.#control.slice(separator + 1);
    if (
      (selector !== "0" && selector !== "2") ||
      Buffer.byteLength(title, "utf8") > this.#limits.maximumTitleBytes
    )
      this.#unsupportedControlCount += 1;
    else this.#titleSha256 = hash(title);
    this.#control = "";
    this.#state = "ground";
  }

  #appendRecent(character: string): void {
    if (this.#recentCodePoints.length < this.#limits.maximumRecentCodePoints) {
      setOwnIndex(
        this.#recentCodePoints,
        this.#recentCodePoints.length,
        character,
      );
      return;
    }
    setOwnIndex(this.#recentCodePoints, this.#recentStart, character);
    this.#recentStart =
      (this.#recentStart + 1) % this.#limits.maximumRecentCodePoints;
  }

  #recentText(): string {
    let recent = "";
    for (let offset = 0; offset < this.#recentCodePoints.length; offset += 1) {
      const index =
        (this.#recentStart + offset) % this.#recentCodePoints.length;
      recent += this.#recentCodePoints[index];
    }
    return recent;
  }

  #lineFeed(): void {
    if (this.#row < this.#geometry.rows - 1) {
      this.#row += 1;
      return;
    }
    const retained = this.#cells.length - this.#geometry.columns;
    for (let index = 0; index < retained; index += 1)
      this.#cells[index] = this.#cells[index + this.#geometry.columns]!;
    for (let index = retained; index < this.#cells.length; index += 1)
      this.#cells[index] = " ";
  }

  #clearScreen(): void {
    for (let index = 0; index < this.#cells.length; index += 1)
      this.#cells[index] = " ";
    this.#row = 0;
    this.#column = 0;
  }

  #clearLine(entire: boolean): void {
    const start =
      this.#row * this.#geometry.columns + (entire ? 0 : this.#column);
    const end = (this.#row + 1) * this.#geometry.columns;
    for (let index = start; index < end; index += 1) this.#cells[index] = " ";
    if (entire) this.#column = 0;
  }
}

// Closed-schema validation deliberately keeps every semantic bound in one audit point.
/* eslint-disable complexity -- one closed-schema audit point */
export const validatePtyTerminalSemanticSnapshot = (
  value: unknown,
): PtyTerminalSemanticSnapshot => {
  const record = strictRecord(
    value,
    [
      "alternateScreen",
      "cursor",
      "cursorVisible",
      "geometry",
      "malformedControlCount",
      "nonEmptyLineCount",
      "outputBytes",
      "printableCellCount",
      "sawCursorPositionQuery",
      "screenSha256",
      "semanticState",
      "snapshotVersion",
      "titlePresent",
      "titleSha256",
      "unsupportedControlCount",
    ],
    "testkit.pty.snapshot",
  );
  const geometry = strictRecord(
    record.geometry,
    ["columns", "rows"],
    "testkit.pty.snapshot",
  );
  const cursor = strictRecord(
    record.cursor,
    ["column", "row"],
    "testkit.pty.snapshot",
  );
  const cursorColumn = cursor.column;
  const cursorRow = cursor.row;
  if (
    record.snapshotVersion !== 1 ||
    !boundedInteger(geometry.columns, 4_096) ||
    !boundedInteger(geometry.rows, 4_096) ||
    typeof cursorColumn !== "number" ||
    typeof cursorRow !== "number" ||
    !Number.isSafeInteger(cursorColumn) ||
    !Number.isSafeInteger(cursorRow) ||
    cursorColumn < 0 ||
    cursorColumn >= geometry.columns ||
    cursorRow < 0 ||
    cursorRow >= geometry.rows ||
    typeof record.alternateScreen !== "boolean" ||
    typeof record.cursorVisible !== "boolean" ||
    typeof record.sawCursorPositionQuery !== "boolean" ||
    typeof record.titlePresent !== "boolean" ||
    (record.semanticState !== "active" &&
      record.semanticState !== "ready" &&
      record.semanticState !== "completed" &&
      record.semanticState !== "credential-prompt" &&
      record.semanticState !== "malformed-control" &&
      record.semanticState !== "output-limit") ||
    typeof record.screenSha256 !== "string" ||
    !sha256Pattern.test(record.screenSha256) ||
    (record.titleSha256 !== null &&
      (typeof record.titleSha256 !== "string" ||
        !sha256Pattern.test(record.titleSha256))) ||
    record.titlePresent !== (record.titleSha256 !== null)
  )
    return fail("testkit.pty.snapshot");
  for (const key of [
    "outputBytes",
    "printableCellCount",
    "nonEmptyLineCount",
    "malformedControlCount",
    "unsupportedControlCount",
  ] as const)
    if (
      !Number.isSafeInteger(record[key]) ||
      (record[key] as number) < 0 ||
      (record[key] as number) > 16_777_216
    )
      return fail("testkit.pty.snapshot");
  return freezeAuthority({
    snapshotVersion: 1 as const,
    geometry: freezeAuthority({
      columns: geometry.columns,
      rows: geometry.rows,
    }),
    cursor: freezeAuthority({
      column: cursorColumn,
      row: cursorRow,
    }),
    alternateScreen: record.alternateScreen,
    cursorVisible: record.cursorVisible,
    outputBytes: record.outputBytes as number,
    printableCellCount: record.printableCellCount as number,
    nonEmptyLineCount: record.nonEmptyLineCount as number,
    malformedControlCount: record.malformedControlCount as number,
    unsupportedControlCount: record.unsupportedControlCount as number,
    sawCursorPositionQuery: record.sawCursorPositionQuery,
    titlePresent: record.titlePresent,
    titleSha256: record.titleSha256,
    screenSha256: record.screenSha256,
    semanticState: record.semanticState,
  });
};
/* eslint-enable complexity */

export const defaultPtyTerminalEmulatorLimits = defaultLimits;
