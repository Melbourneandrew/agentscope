import { createHash } from "node:crypto";

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
const defaultLimits: PtyTerminalEmulatorLimits = Object.freeze({
  maximumCells: 65_536,
  maximumColumns: 512,
  maximumControlBytes: 512,
  maximumOutputBytes: 1_048_576,
  maximumRecentCodePoints: 2_048,
  maximumRows: 512,
  maximumTitleBytes: 512,
});
const credentialPromptPattern =
  /(?:password|api[ _-]?key|sign[ -]?in|log[ -]?in|authenticate|authorization code)\s*[:>?]?\s*$/iu;
const readyMarker = "AGENTSCOPE_PTY_READY";
const completedMarker = "AGENTSCOPE_PTY_COMPLETE";
const arrayBufferResizableDescriptor = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "resizable",
);

type ParserState = "ground" | "escape" | "csi" | "osc" | "osc-escape";

const fail = (code: string): never => {
  throw new BoundedTerminalEmulatorError(code);
};
const boundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= maximum;
const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};
const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const validateLimits = (
  value: PtyTerminalEmulatorLimits,
): PtyTerminalEmulatorLimits => {
  if (
    !plainObject(value) ||
    !exactKeys(value, [
      "maximumCells",
      "maximumColumns",
      "maximumControlBytes",
      "maximumOutputBytes",
      "maximumRecentCodePoints",
      "maximumRows",
      "maximumTitleBytes",
    ]) ||
    !boundedInteger(value.maximumCells, 1_048_576) ||
    !boundedInteger(value.maximumColumns, 4_096) ||
    !boundedInteger(value.maximumControlBytes, 4_096) ||
    !boundedInteger(value.maximumOutputBytes, 16_777_216) ||
    !boundedInteger(value.maximumRecentCodePoints, 16_384) ||
    !boundedInteger(value.maximumRows, 4_096) ||
    !boundedInteger(value.maximumTitleBytes, 4_096)
  )
    return fail("testkit.pty.emulator.limits");
  return Object.freeze({ ...value });
};

const validateGeometry = (
  value: PtyTerminalGeometry,
  limits: PtyTerminalEmulatorLimits,
): PtyTerminalGeometry => {
  if (
    !plainObject(value) ||
    !exactKeys(value, ["columns", "rows"]) ||
    !boundedInteger(value.columns, limits.maximumColumns) ||
    !boundedInteger(value.rows, limits.maximumRows) ||
    value.columns * value.rows > limits.maximumCells
  )
    return fail("testkit.pty.emulator.geometry");
  return Object.freeze({ columns: value.columns, rows: value.rows });
};

const parseCsiParameters = (
  value: string,
):
  Readonly<{ privateMode: boolean; values: readonly number[] }> | undefined => {
  const privateMode = value.startsWith("?");
  const body = privateMode ? value.slice(1) : value;
  if (!/^\d*(?:;\d*)*$/u.test(body)) return undefined;
  const values = body
    .split(";")
    .map((part) => (part === "" ? 0 : Number(part)));
  if (values.some((part) => !Number.isSafeInteger(part) || part > 65_535))
    return undefined;
  return { privateMode, values };
};

export class BoundedTerminalEmulator {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
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
  #recent = "";
  #titleSha256: string | null = null;
  #ended = false;
  #outputLimitReached = false;

  public constructor(
    geometry: PtyTerminalGeometry,
    limits: PtyTerminalEmulatorLimits = defaultLimits,
  ) {
    this.#limits = validateLimits(limits);
    this.#geometry = validateGeometry(geometry, this.#limits);
    this.#cells = new Array<string>(
      this.#geometry.columns * this.#geometry.rows,
    ).fill(" ");
  }

  public write(bytes: Uint8Array): void {
    if (this.#ended) return fail("testkit.pty.emulator.ended");
    if (
      Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
      Object.getPrototypeOf(bytes.buffer) !== ArrayBuffer.prototype ||
      (arrayBufferResizableDescriptor?.get !== undefined &&
        // The captured intrinsic getter is deliberately called with its buffer receiver.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        Reflect.apply(arrayBufferResizableDescriptor.get, bytes.buffer, []) ===
          true)
    )
      return fail("testkit.pty.emulator.bytes");
    if (
      this.#outputBytes + bytes.byteLength >
      this.#limits.maximumOutputBytes
    ) {
      this.#outputLimitReached = true;
      return fail("testkit.pty.emulator.output-limit");
    }
    this.#outputBytes += bytes.byteLength;
    let decoded: string;
    try {
      decoded = this.#decoder.decode(bytes, { stream: true });
    } catch {
      this.#malformedControlCount += 1;
      return fail("testkit.pty.emulator.utf8");
    }
    for (const character of decoded) this.#consume(character);
  }

  public resize(geometry: PtyTerminalGeometry): void {
    if (this.#ended) return fail("testkit.pty.emulator.ended");
    const next = validateGeometry(geometry, this.#limits);
    const cells = new Array<string>(next.columns * next.rows).fill(" ");
    const rows = Math.min(next.rows, this.#geometry.rows);
    const columns = Math.min(next.columns, this.#geometry.columns);
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < columns; column += 1)
        cells[row * next.columns + column] =
          this.#cells[row * this.#geometry.columns + column]!;
    this.#geometry = next;
    this.#cells = cells;
    this.#row = Math.min(this.#row, next.rows - 1);
    this.#column = Math.min(this.#column, next.columns - 1);
  }

  public end(): PtyTerminalSemanticSnapshot {
    if (!this.#ended) {
      try {
        const final = this.#decoder.decode();
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
    const semanticState: PtySemanticState = this.#outputLimitReached
      ? "output-limit"
      : this.#malformedControlCount > 0 || this.#unsupportedControlCount > 0
        ? "malformed-control"
        : credentialPromptPattern.test(this.#recent)
          ? "credential-prompt"
          : this.#recent.includes(completedMarker)
            ? "completed"
            : this.#recent.includes(readyMarker)
              ? "ready"
              : "active";
    const screenSha256 = hash(
      JSON.stringify({
        alternateScreen: this.#alternateScreen,
        cells: this.#cells.join(""),
        cursor: [this.#row, this.#column],
        geometry: this.#geometry,
      }),
    );
    return Object.freeze({
      snapshotVersion: 1 as const,
      geometry: this.#geometry,
      cursor: Object.freeze({ column: this.#column, row: this.#row }),
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
    this.#recent += character;
    const codePoints = [...this.#recent];
    if (codePoints.length > this.#limits.maximumRecentCodePoints)
      this.#recent = codePoints
        .slice(codePoints.length - this.#limits.maximumRecentCodePoints)
        .join("");
  }

  #lineFeed(): void {
    if (this.#row < this.#geometry.rows - 1) {
      this.#row += 1;
      return;
    }
    this.#cells.copyWithin(0, this.#geometry.columns);
    this.#cells.fill(" ", (this.#geometry.rows - 1) * this.#geometry.columns);
  }

  #clearScreen(): void {
    this.#cells.fill(" ");
    this.#row = 0;
    this.#column = 0;
  }

  #clearLine(entire: boolean): void {
    const start =
      this.#row * this.#geometry.columns + (entire ? 0 : this.#column);
    const end = (this.#row + 1) * this.#geometry.columns;
    this.#cells.fill(" ", start, end);
    if (entire) this.#column = 0;
  }
}

export const validatePtyTerminalSemanticSnapshot = (
  value: unknown,
): PtyTerminalSemanticSnapshot => {
  if (
    !plainObject(value) ||
    !exactKeys(value, [
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
    ]) ||
    value.snapshotVersion !== 1 ||
    !plainObject(value.geometry) ||
    !exactKeys(value.geometry, ["columns", "rows"]) ||
    !boundedInteger(value.geometry.columns, 4_096) ||
    !boundedInteger(value.geometry.rows, 4_096) ||
    !plainObject(value.cursor) ||
    !exactKeys(value.cursor, ["column", "row"]) ||
    !Number.isSafeInteger(value.cursor.column) ||
    !Number.isSafeInteger(value.cursor.row) ||
    (value.cursor.column as number) < 0 ||
    (value.cursor.column as number) >= value.geometry.columns ||
    (value.cursor.row as number) < 0 ||
    (value.cursor.row as number) >= value.geometry.rows ||
    typeof value.alternateScreen !== "boolean" ||
    typeof value.cursorVisible !== "boolean" ||
    typeof value.sawCursorPositionQuery !== "boolean" ||
    typeof value.titlePresent !== "boolean" ||
    ![
      "active",
      "ready",
      "completed",
      "credential-prompt",
      "malformed-control",
      "output-limit",
    ].includes(value.semanticState as string) ||
    !sha256Pattern.test(value.screenSha256 as string) ||
    (value.titleSha256 !== null &&
      !sha256Pattern.test(value.titleSha256 as string)) ||
    value.titlePresent !== (value.titleSha256 !== null)
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
      !Number.isSafeInteger(value[key]) ||
      (value[key] as number) < 0 ||
      (value[key] as number) > 16_777_216
    )
      return fail("testkit.pty.snapshot");
  return value as PtyTerminalSemanticSnapshot;
};

export const defaultPtyTerminalEmulatorLimits = defaultLimits;
