import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export type PtyTerminalGeometry = Readonly<{
  columns: number;
  rows: number;
}>;

export type PtyTerminalReadinessMatcher =
  | Readonly<{ kind: "semantic-marker" }>
  | Readonly<{ kind: "challenge-marker"; challenge: string }>
  | Readonly<{
      kind: "challenge-styled-text";
      challenge: string;
      text: string;
      requiredText: string;
      postSubmissionResponseText?: string;
      requiredTerminalProtocol: "csi-u-flags-7-query-v1";
      bold: boolean;
      dim: boolean;
    }>
  | Readonly<{
      kind: "styled-text-after-completion";
      text: string;
      bold: boolean;
      dim: boolean;
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

export type PtyMalformedControlReason =
  | "control-limit"
  | "csi-byte"
  | "csi-parameters"
  | "escape"
  | "ground-control"
  | "trailing-control"
  | "utf8";

export type PtyUnsupportedControlReason = "csi" | "extended-csi" | "osc";

type ChallengeScreenRevocationKind =
  | "combined-sync"
  | "alternate-screen-enter"
  | "alternate-screen-exit"
  | "autowrap-enable"
  | "autowrap-disable"
  | "scroll-region"
  | "screen-edit"
  | "cursor-restore"
  | "reverse-index"
  | "tab-stop-set"
  | "charset"
  | "tab"
  | "untrusted-cell"
  | "rendition";

type PtyIdleAtTitleDiagnostic =
  | ReturnType<BoundedTerminalEmulator["postSubmissionIdleDiagnostic"]>
  | "title-not-observed"
  | "idle-revoked-protocol"
  | "idle-revoked-screen"
  | "idle-revoked-unclassified"
  | `idle-revoked-${ChallengeScreenRevocationKind}`;

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
const maximumCredentialTailCodePoints = 128;
const maximumTerminalResponseBytes = 4_096;
const readyMarker = "AGENTSCOPE_PTY_READY";
const readinessChallengePattern = /^[a-f0-9]{64}$/u;
const completedMarker = "AGENTSCOPE_PTY_COMPLETE";
const defineOwnProperty = Reflect.defineProperty;
const getPrototypeOf = Reflect.getPrototypeOf;
const applyFunction = Reflect.apply;
const Uint8ArrayAuthority = Uint8Array;
const uint8ArrayPrototype = Uint8Array.prototype;
const arrayBufferPrototype = ArrayBuffer.prototype;
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArraySet = Uint8Array.prototype.set;
const TextDecoderAuthority = TextDecoder;
const TextEncoderAuthority = TextEncoder;
// eslint-disable-next-line @typescript-eslint/unbound-method
const bufferByteLength = Buffer.byteLength;
// eslint-disable-next-line @typescript-eslint/unbound-method
const textDecoderDecode = TextDecoder.prototype.decode;
// eslint-disable-next-line @typescript-eslint/unbound-method
const textEncoderEncode = TextEncoder.prototype.encode;
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
if (
  typedArrayBufferGetterCandidate === undefined ||
  typedArrayByteLengthGetterCandidate === undefined
)
  throw new Error("testkit.pty.emulator.runtime");
const typedArrayBufferGetter = typedArrayBufferGetterCandidate;
const typedArrayByteLengthGetter = typedArrayByteLengthGetterCandidate;

type ParserState =
  "ground" | "escape" | "charset" | "csi" | "osc" | "osc-escape";

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
  | Readonly<{
      intermediate: "" | " ";
      prefix: "" | "<" | "=" | ">" | "?";
      values: readonly number[];
    }>
  | undefined => {
  const match = /^([<=>?]?)(\d*(?:;\d*)*)( ?)$/u.exec(value);
  if (match === null) return undefined;
  const prefix = match[1] as "" | "<" | "=" | ">" | "?";
  const body = match[2]!;
  const intermediate = match[3] as "" | " ";
  const parts = body.split(";");
  const values: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] === "" ? 0 : Number(parts[index]);
    if (!Number.isSafeInteger(part) || part > 65_535) return undefined;
    setOwnIndex(values, index, part);
  }
  return { intermediate, prefix, values };
};

const passiveCsiIsSupported = (
  final: string,
  values: readonly number[],
  rows: number,
): boolean =>
  (final === "c" && values.length === 1 && values[0] === 0) ||
  (final === "r" &&
    values.length <= 2 &&
    values.every((value) => value <= rows)) ||
  (["@", "L", "M", "P", "S", "T", "X"].includes(final) && values.length === 1);

// Ratatui's pinned Codex UI renders this closed set as one-cell glyphs. The
// status indicator at ff29a443 uses ellipsis, bullet, and corner; the turn
// runtime uses the failure cross. Any other printable code point may be
// zero-, two-, or multi-cell and cannot preserve screen-position authority
// without a complete width oracle.
const trustedSingleCellCharacter = (character: string): boolean =>
  /^[\x20-\x7e›·─│╭╮╰╯⚠—…•└✗]$/u.test(character);

const csiIsPrivateModeControl = (
  final: string,
  prefix: string,
  intermediate: string,
): boolean =>
  prefix === "?" && intermediate === "" && (final === "h" || final === "l");

const csiIsExactSynchronizedOutputMode = (
  final: string,
  prefix: string,
  intermediate: string,
  values: readonly number[],
): boolean =>
  csiIsPrivateModeControl(final, prefix, intermediate) &&
  values.length === 1 &&
  values[0] === 2026;

const csiHasUnmodeledScreenMutation = (
  final: string,
  prefix: string,
  intermediate: string,
  values: readonly number[],
): boolean =>
  (prefix === "" &&
    intermediate === "" &&
    (final === "r" || ["@", "L", "M", "P", "S", "T", "X"].includes(final))) ||
  (csiIsPrivateModeControl(final, prefix, intermediate) &&
    (values.includes(7) || values.includes(1049)));

const csiIsCanonicalScrollRegion = (
  final: string,
  prefix: string,
  intermediate: string,
  values: readonly number[],
  rows: number,
): boolean =>
  prefix === "" &&
  intermediate === "" &&
  final === "r" &&
  ((values.length === 1 && (values[0] === 0 || values[0] === 1)) ||
    // The parser conflates an omitted top parameter with explicit zero. Do
    // not admit either two-parameter form until omission is preserved.
    (values.length === 2 &&
      values[0] === 1 &&
      (values[1] === 0 || values[1] === rows)));

const classifyUnmodeledScreenMutation = (
  final: string,
  prefix: string,
  values: readonly number[],
): ChallengeScreenRevocationKind => {
  if (prefix === "?" && values.includes(1049))
    return final === "h" ? "alternate-screen-enter" : "alternate-screen-exit";
  if (prefix === "?" && values.includes(7))
    return final === "h" ? "autowrap-enable" : "autowrap-disable";
  if (final === "r") return "scroll-region";
  return "screen-edit";
};

/* eslint-disable complexity -- closed challenged-response fields add fail-closed validation */
const validateReadinessMatcher = (
  value: PtyTerminalReadinessMatcher,
): PtyTerminalReadinessMatcher => {
  if (value.kind === "semantic-marker") {
    strictRecord(value, ["kind"], "testkit.pty.emulator.readiness");
    return freezeAuthority({ kind: "semantic-marker" as const });
  }
  if (value.kind === "challenge-marker") {
    const record = strictRecord(
      value,
      ["challenge", "kind"],
      "testkit.pty.emulator.readiness",
    );
    if (
      record.kind !== "challenge-marker" ||
      typeof record.challenge !== "string" ||
      !readinessChallengePattern.test(record.challenge)
    )
      return fail("testkit.pty.emulator.readiness");
    return freezeAuthority({
      kind: "challenge-marker" as const,
      challenge: record.challenge,
    });
  }
  if (value.kind === "challenge-styled-text") {
    const hasResponseText = Object.hasOwn(value, "postSubmissionResponseText");
    const record = strictRecord(
      value,
      [
        "bold",
        "challenge",
        "dim",
        "kind",
        ...(hasResponseText ? ["postSubmissionResponseText"] : []),
        "requiredTerminalProtocol",
        "requiredText",
        "text",
      ],
      "testkit.pty.emulator.readiness",
    );
    const text = record.text;
    const requiredText = record.requiredText;
    if (
      record.kind !== "challenge-styled-text" ||
      typeof record.challenge !== "string" ||
      !readinessChallengePattern.test(record.challenge) ||
      typeof text !== "string" ||
      [...text].length !== 1 ||
      !trustedSingleCellCharacter(text) ||
      typeof requiredText !== "string" ||
      requiredText.length < 1 ||
      requiredText.length > 32 ||
      [...requiredText].some(
        (character) => !trustedSingleCellCharacter(character),
      ) ||
      record.requiredTerminalProtocol !== "csi-u-flags-7-query-v1" ||
      (hasResponseText &&
        (typeof record.postSubmissionResponseText !== "string" ||
          record.postSubmissionResponseText.length < 65 ||
          record.postSubmissionResponseText.length > 128 ||
          !record.postSubmissionResponseText.endsWith(record.challenge) ||
          [...record.postSubmissionResponseText].some(
            (character) => !trustedSingleCellCharacter(character),
          ))) ||
      typeof record.bold !== "boolean" ||
      typeof record.dim !== "boolean"
    )
      return fail("testkit.pty.emulator.readiness");
    return freezeAuthority({
      kind: "challenge-styled-text" as const,
      challenge: record.challenge,
      text,
      requiredText,
      ...(hasResponseText
        ? {
            postSubmissionResponseText:
              record.postSubmissionResponseText as string,
          }
        : {}),
      requiredTerminalProtocol: "csi-u-flags-7-query-v1",
      bold: record.bold,
      dim: record.dim,
    });
  }
  const record = strictRecord(
    value,
    ["bold", "dim", "kind", "text"],
    "testkit.pty.emulator.readiness",
  );
  const text = record.text;
  if (
    record.kind !== "styled-text-after-completion" ||
    typeof text !== "string" ||
    [...text].length !== 1 ||
    !trustedSingleCellCharacter(text) ||
    typeof record.bold !== "boolean" ||
    typeof record.dim !== "boolean"
  )
    return fail("testkit.pty.emulator.readiness");
  return freezeAuthority({
    kind: "styled-text-after-completion" as const,
    text,
    bold: record.bold,
    dim: record.dim,
  });
};
/* eslint-enable complexity */

export class BoundedTerminalEmulator {
  readonly #decoder = new TextDecoderAuthority("utf-8", { fatal: true });
  readonly #encoder = new TextEncoderAuthority();
  readonly #limits: PtyTerminalEmulatorLimits;
  #geometry: PtyTerminalGeometry;
  #cells: string[];
  #cellBold: boolean[];
  #cellDim: boolean[];
  #row = 0;
  #column = 0;
  #alternateScreen = false;
  #cursorPositionTrusted = true;
  #autoWrapEnabled = true;
  #scrollRegionCanonical = true;
  #cursorVisible = true;
  #savedColumn = 0;
  #savedRow = 0;
  #savedBold = false;
  #savedDim = false;
  #savedCharacterSetTrusted = true;
  #savedRenditionTrusted = true;
  #savedAutoWrapEnabled = true;
  #savedCursorPositionTrusted = true;
  #state: ParserState = "ground";
  #control = "";
  #outputBytes = 0;
  #malformedControlCount = 0;
  #malformedControlReason: PtyMalformedControlReason | null = null;
  #unsupportedControlCount = 0;
  #unsupportedControlReason: PtyUnsupportedControlReason | null = null;
  #sawCursorPositionQuery = false;
  readonly #recentCodePoints: string[] = [];
  #recentStart = 0;
  #titleSha256: string | null = null;
  #ended = false;
  #outputLimitReached = false;
  #readinessObserved = false;
  #readinessObservationGeneration = 0;
  #challengeScreenAuthorityRevoked = false;
  #lastChallengeScreenRevocationKind: ChallengeScreenRevocationKind | null =
    null;
  #challengeSynchronizedOutputFrameActive = false;
  #challengeStyledTextObservedInOutput = false;
  #challengeStyledTextOutputCellIndex: number | null = null;
  #challengeRequiredTextObservedInOutput = false;
  #challengeRequiredTextOutputTail = "";
  #challengeRequiredTextOutputStartCellIndex: number | null = null;
  #readinessChallengeObserved = false;
  #readinessTail = "";
  #completionObserved = false;
  #postSubmissionIdleObservationArmed = false;
  #postSubmissionIdleFrameEligible = false;
  #postSubmissionEligibleFrameAttempted = false;
  #postSubmissionIdlePromptObserved = false;
  #postSubmissionIdleAtTitleDiagnostic: PtyIdleAtTitleDiagnostic =
    "title-not-observed";
  #postSubmissionResponseTail = "";
  #postSubmissionResponseObserved = false;
  #completionTail = "";
  #bold = false;
  #dim = false;
  #characterSetTarget: "(" | ")" | null = null;
  #characterSetTrusted = true;
  #renditionTrusted = true;
  #credentialPromptObserved = false;
  #credentialTail = "";
  #pendingTerminalResponses = "";
  #terminalResponseBytes = 0;
  #terminalProtocolPhase = 0;
  #terminalProtocolRejected = false;
  readonly #readinessMatcher: PtyTerminalReadinessMatcher;

  public constructor(
    geometry: PtyTerminalGeometry,
    limits: PtyTerminalEmulatorLimits = defaultLimits,
    readinessMatcher: PtyTerminalReadinessMatcher = {
      kind: "semantic-marker",
    },
  ) {
    this.#limits = validateLimits(limits);
    this.#geometry = validateGeometry(geometry, this.#limits);
    this.#cells = filledOwnArray(
      this.#geometry.columns * this.#geometry.rows,
      " ",
    );
    this.#cellBold = filledOwnArray(
      this.#geometry.columns * this.#geometry.rows,
      false,
    );
    this.#cellDim = filledOwnArray(
      this.#geometry.columns * this.#geometry.rows,
      false,
    );
    this.#readinessMatcher = validateReadinessMatcher(readinessMatcher);
  }

  public write(bytes: Uint8Array): void {
    if (this.#ended) return fail("testkit.pty.emulator.ended");
    let byteLength: number;
    try {
      const buffer = applyFunction(typedArrayBufferGetter, bytes, []);
      if (
        isProxy(bytes) ||
        getPrototypeOf(bytes) !== uint8ArrayPrototype ||
        getPrototypeOf(buffer) !== arrayBufferPrototype
      )
        return fail("testkit.pty.emulator.bytes");
      byteLength = applyFunction(typedArrayByteLengthGetter, bytes, []);
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
      const boundedView = new Uint8ArrayAuthority(byteLength);
      applyFunction(typedArraySet, boundedView, [bytes]);
      const boundedInput = applyFunction(
        typedArrayBufferGetter,
        boundedView,
        [],
      );
      decoded = applyFunction(textDecoderDecode, this.#decoder, [
        boundedInput,
        {
          stream: true,
        },
      ]);
    } catch {
      this.#recordMalformedControl("utf8");
      return fail("testkit.pty.emulator.utf8");
    }
    for (const character of decoded) this.#consume(character);
  }

  public resize(geometry: PtyTerminalGeometry): void {
    if (this.#ended) return fail("testkit.pty.emulator.ended");
    const next = validateGeometry(geometry, this.#limits);
    const cells = filledOwnArray(next.columns * next.rows, " ");
    const cellBold = filledOwnArray(next.columns * next.rows, false);
    const cellDim = filledOwnArray(next.columns * next.rows, false);
    const rows = Math.min(next.rows, this.#geometry.rows);
    const columns = Math.min(next.columns, this.#geometry.columns);
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < columns; column += 1)
        for (const [target, source] of [
          [cells, this.#cells],
          [cellBold, this.#cellBold],
          [cellDim, this.#cellDim],
        ] as const)
          setOwnIndex(
            target,
            row * next.columns + column,
            source[row * this.#geometry.columns + column]!,
          );
    this.#geometry = next;
    this.#cells = cells;
    this.#cellBold = cellBold;
    this.#cellDim = cellDim;
    this.#row = Math.min(this.#row, next.rows - 1);
    this.#column = Math.min(this.#column, next.columns - 1);
    this.#invalidateChallengeSynchronizedOutputFrame();
    this.#refreshChallengeStyledReadiness();
  }

  public end(): PtyTerminalSemanticSnapshot {
    if (!this.#ended) {
      try {
        const final = applyFunction(textDecoderDecode, this.#decoder, []);
        for (const character of final) this.#consume(character);
      } catch {
        this.#recordMalformedControl("utf8");
      }
      if (this.#state !== "ground")
        this.#recordMalformedControl("trailing-control");
      this.#state = "ground";
      this.#control = "";
      this.#ended = true;
    }
    return this.#snapshot();
  }

  public snapshot(): PtyTerminalSemanticSnapshot {
    return this.#snapshot();
  }

  #snapshot(): PtyTerminalSemanticSnapshot {
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
        : this.#credentialPromptObserved || credentialPromptPattern.test(recent)
          ? "credential-prompt"
          : this.#completionObserved || containsText(recent, completedMarker)
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

  public malformedControlReason(): PtyMalformedControlReason | null {
    return this.#malformedControlReason;
  }

  public unsupportedControlReason(): PtyUnsupportedControlReason | null {
    return this.#unsupportedControlReason;
  }

  public readinessObserved(): boolean {
    return this.#readinessObserved;
  }

  /** Package-private causal observation used by the selected PTY kernel. */
  public readinessObservationGeneration(): number {
    return this.#readinessObservationGeneration;
  }

  /** Package-private: arm only after the selected turn-submission input. */
  public armPostSubmissionIdleObservation(): void {
    if (this.#readinessMatcher.kind !== "challenge-styled-text") return;
    this.#postSubmissionIdleObservationArmed = true;
    this.#postSubmissionIdleFrameEligible = false;
    this.#postSubmissionEligibleFrameAttempted = false;
    this.#postSubmissionIdlePromptObserved = false;
    this.#postSubmissionResponseTail = "";
    this.#postSubmissionResponseObserved = false;
  }

  /** Package-private: one later synchronized challenged idle-prompt frame. */
  public postSubmissionIdlePromptObserved(): boolean {
    return this.#postSubmissionIdlePromptObserved && this.#readinessObserved;
  }

  /** Package-private, content-free failure diagnosis; never admission authority. */
  public postSubmissionIdleDiagnostic():
    | "not-armed"
    | "response-not-observed"
    | "idle-frame-not-observed"
    | "idle-frame-rejected"
    | "idle-readiness-revoked"
    | "idle-ready" {
    return this.#diagnosePostSubmissionIdle();
  }

  #diagnosePostSubmissionIdle(): ReturnType<
    BoundedTerminalEmulator["postSubmissionIdleDiagnostic"]
  > {
    if (!this.#postSubmissionIdleObservationArmed) return "not-armed";
    if (!this.#postSubmissionResponseObserved) return "response-not-observed";
    if (!this.#postSubmissionIdlePromptObserved)
      return this.#postSubmissionEligibleFrameAttempted
        ? "idle-frame-rejected"
        : "idle-frame-not-observed";
    return this.#readinessObserved ? "idle-ready" : "idle-readiness-revoked";
  }

  /** Package-private, latched at the exact challenged title, before later output. */
  public postSubmissionIdleAtTitleDiagnostic(): PtyIdleAtTitleDiagnostic {
    return this.#postSubmissionIdleAtTitleDiagnostic;
  }

  #classifyPostSubmissionIdleAtTitle(): PtyIdleAtTitleDiagnostic {
    const diagnostic = this.#diagnosePostSubmissionIdle();
    if (diagnostic !== "idle-readiness-revoked") return diagnostic;
    if (this.#terminalProtocolRejected || this.#terminalProtocolPhase !== 6)
      return "idle-revoked-protocol";
    if (!this.#challengeScreenAuthorityRevoked) return "idle-revoked-screen";
    const kind = this.#lastChallengeScreenRevocationKind;
    return kind === null ? "idle-revoked-unclassified" : `idle-revoked-${kind}`;
  }

  public requiredTerminalProtocolReady(): boolean {
    return (
      this.#readinessMatcher.kind === "challenge-styled-text" &&
      !this.#terminalProtocolRejected &&
      this.#terminalProtocolPhase === 6
    );
  }

  public takeTerminalResponses(): Uint8Array {
    const expectedBytes = applyFunction(bufferByteLength, Buffer, [
      this.#pendingTerminalResponses,
      "utf8",
    ]);
    const response = applyFunction(textEncoderEncode, this.#encoder, [
      this.#pendingTerminalResponses,
    ]);
    if (
      applyFunction(typedArrayByteLengthGetter, response, []) !==
        expectedBytes ||
      expectedBytes > maximumTerminalResponseBytes
    )
      return fail("testkit.pty.emulator.response-limit");
    this.#pendingTerminalResponses = "";
    return response;
  }

  #enqueueTerminalResponse(response: string): void {
    const responseBytes = applyFunction(bufferByteLength, Buffer, [
      response,
      "utf8",
    ]);
    if (
      this.#terminalResponseBytes + responseBytes >
      maximumTerminalResponseBytes
    )
      return fail("testkit.pty.emulator.response-limit");
    this.#terminalResponseBytes += responseBytes;
    this.#pendingTerminalResponses += response;
  }

  #refreshChallengeStyledReadiness(): void {
    if (this.#readinessMatcher.kind !== "challenge-styled-text") return;
    let styledTextObserved = false;
    let requiredTextObserved = false;
    for (let index = 0; index < this.#cells.length; index += 1)
      if (
        this.#cells[index] === this.#readinessMatcher.text &&
        this.#cellBold[index] === this.#readinessMatcher.bold &&
        this.#cellDim[index] === this.#readinessMatcher.dim
      )
        styledTextObserved = true;
    for (let row = 0; row < this.#geometry.rows; row += 1) {
      let line = "";
      const start = row * this.#geometry.columns;
      for (let column = 0; column < this.#geometry.columns; column += 1)
        line += this.#cells[start + column];
      requiredTextObserved ||= containsText(
        line,
        this.#readinessMatcher.requiredText,
      );
    }
    const candidateReadiness =
      this.#readinessChallengeObserved &&
      styledTextObserved &&
      requiredTextObserved;
    const nextReadiness =
      candidateReadiness &&
      this.#terminalProtocolPhase === 6 &&
      !this.#terminalProtocolRejected &&
      !this.#challengeScreenAuthorityRevoked;
    this.#readinessObserved = nextReadiness;
  }

  #resetChallengeOutputObservation(): void {
    this.#challengeStyledTextObservedInOutput = false;
    this.#challengeStyledTextOutputCellIndex = null;
    this.#challengeRequiredTextObservedInOutput = false;
    this.#challengeRequiredTextOutputTail = "";
    this.#challengeRequiredTextOutputStartCellIndex = null;
  }

  #resetChallengeRequiredTextOutputTail(): void {
    this.#challengeRequiredTextOutputTail = "";
  }

  #beginChallengeSynchronizedOutputFrame(): void {
    this.#resetChallengeOutputObservation();
    this.#challengeSynchronizedOutputFrameActive = true;
    this.#postSubmissionIdleFrameEligible =
      this.#postSubmissionIdleObservationArmed &&
      (this.#readinessMatcher.kind !== "challenge-styled-text" ||
        this.#readinessMatcher.postSubmissionResponseText === undefined ||
        this.#postSubmissionResponseObserved);
    if (this.#postSubmissionIdleFrameEligible)
      this.#postSubmissionEligibleFrameAttempted = true;
  }

  #invalidateChallengeSynchronizedOutputFrame(): void {
    this.#challengeSynchronizedOutputFrameActive = false;
    this.#postSubmissionIdleFrameEligible = false;
    this.#resetChallengeOutputObservation();
  }

  #revokeChallengeScreenAuthority(kind: ChallengeScreenRevocationKind): void {
    this.#challengeScreenAuthorityRevoked = true;
    this.#lastChallengeScreenRevocationKind = kind;
    // A semantic marker is historical readiness evidence, not a live screen
    // assertion. Exiting an alternate screen after completion must not erase
    // the marker that authorized the earlier input.
    if (this.#readinessMatcher.kind !== "semantic-marker")
      this.#readinessObserved = false;
    this.#resetChallengeOutputObservation();
  }

  #commitChallengeSynchronizedOutputFrame(): void {
    if (
      !this.#challengeSynchronizedOutputFrameActive ||
      this.#readinessMatcher.kind !== "challenge-styled-text"
    )
      return;
    const styledCell = this.#challengeStyledTextOutputCellIndex;
    const requiredStart = this.#challengeRequiredTextOutputStartCellIndex;
    let requiredTextSurvives = requiredStart !== null;
    if (requiredStart !== null)
      for (
        let offset = 0;
        offset < this.#readinessMatcher.requiredText.length;
        offset += 1
      )
        requiredTextSurvives &&=
          this.#cells[requiredStart + offset] ===
          this.#readinessMatcher.requiredText[offset];
    const outputAuthorityValid =
      this.#challengeStyledTextObservedInOutput &&
      styledCell !== null &&
      this.#cells[styledCell] === this.#readinessMatcher.text &&
      this.#cellBold[styledCell] === this.#readinessMatcher.bold &&
      this.#cellDim[styledCell] === this.#readinessMatcher.dim &&
      this.#challengeRequiredTextObservedInOutput &&
      requiredTextSurvives &&
      this.#characterSetTrusted &&
      this.#renditionTrusted &&
      this.#cursorPositionTrusted &&
      this.#autoWrapEnabled &&
      this.#scrollRegionCanonical;
    if (outputAuthorityValid) {
      this.#challengeScreenAuthorityRevoked = false;
      this.#lastChallengeScreenRevocationKind = null;
    }
    this.#refreshChallengeStyledReadiness();
    if (this.#readinessObserved && outputAuthorityValid) {
      this.#readinessObservationGeneration += 1;
      if (this.#postSubmissionIdleFrameEligible)
        this.#postSubmissionIdlePromptObserved = true;
    }
    this.#invalidateChallengeSynchronizedOutputFrame();
  }

  #observeChallengePrintableOutput(character: string, cellIndex: number): void {
    if (
      this.#readinessMatcher.kind !== "challenge-styled-text" ||
      !this.#challengeSynchronizedOutputFrameActive
    )
      return;
    if (
      character === this.#readinessMatcher.text &&
      this.#bold === this.#readinessMatcher.bold &&
      this.#dim === this.#readinessMatcher.dim
    ) {
      this.#challengeStyledTextObservedInOutput = true;
      this.#challengeStyledTextOutputCellIndex = cellIndex;
      this.#challengeRequiredTextObservedInOutput = false;
      this.#challengeRequiredTextOutputTail = "";
      this.#challengeRequiredTextOutputStartCellIndex = null;
    }
    this.#challengeRequiredTextOutputTail =
      `${this.#challengeRequiredTextOutputTail}${character}`.slice(
        -this.#readinessMatcher.requiredText.length,
      );
    const requiredTextObservedNow =
      this.#challengeStyledTextObservedInOutput &&
      this.#challengeRequiredTextOutputTail ===
        this.#readinessMatcher.requiredText;
    this.#challengeRequiredTextObservedInOutput ||= requiredTextObservedNow;
    if (requiredTextObservedNow) {
      const requiredStart =
        cellIndex - this.#readinessMatcher.requiredText.length + 1;
      const rowStart = this.#row * this.#geometry.columns;
      this.#challengeRequiredTextOutputStartCellIndex =
        requiredStart >= rowStart ? requiredStart : null;
    }
  }

  #observeChallengeSynchronizedOutputCsi(
    final: string,
    prefix: "" | "<" | "=" | ">" | "?",
    intermediate: "" | " ",
    values: readonly number[],
  ): void {
    const synchronizedOutputMode = csiIsExactSynchronizedOutputMode(
      final,
      prefix,
      intermediate,
      values,
    );
    const combinedSynchronizedOutputMode =
      csiIsPrivateModeControl(final, prefix, intermediate) &&
      values.includes(2026) &&
      !synchronizedOutputMode;
    if (combinedSynchronizedOutputMode) {
      this.#invalidateChallengeSynchronizedOutputFrame();
      if (values.includes(7)) this.#autoWrapEnabled = final === "h";
      if (values.includes(1049)) {
        this.#cursorPositionTrusted = false;
      }
      this.#revokeChallengeScreenAuthority("combined-sync");
      return;
    }
    if (synchronizedOutputMode) {
      if (final === "h") {
        if (this.#challengeSynchronizedOutputFrameActive)
          this.#invalidateChallengeSynchronizedOutputFrame();
        else this.#beginChallengeSynchronizedOutputFrame();
      } else this.#commitChallengeSynchronizedOutputFrame();
      return;
    }
    if (
      csiIsCanonicalScrollRegion(
        final,
        prefix,
        intermediate,
        values,
        this.#geometry.rows,
      ) &&
      this.#unsupportedControlCount === 0 &&
      this.#malformedControlCount === 0
    ) {
      this.#scrollRegionCanonical = true;
      if (this.#challengeSynchronizedOutputFrameActive)
        this.#resetChallengeOutputObservation();
      return;
    }
    const unmodeledScreenMutation = csiHasUnmodeledScreenMutation(
      final,
      prefix,
      intermediate,
      values,
    );
    if (unmodeledScreenMutation) {
      if (prefix === "?" && values.includes(7))
        this.#autoWrapEnabled = final === "h";
      if (prefix === "?" && values.includes(1049))
        this.#cursorPositionTrusted = false;
      if (prefix === "" && final === "r") {
        this.#cursorPositionTrusted = false;
        this.#scrollRegionCanonical = false;
      }
      this.#revokeChallengeScreenAuthority(
        classifyUnmodeledScreenMutation(final, prefix, values),
      );
      return;
    }
    if (
      this.#challengeSynchronizedOutputFrameActive &&
      !(prefix === "" && intermediate === "" && final === "m")
    )
      this.#resetChallengeRequiredTextOutputTail();
  }

  public completionObserved(): boolean {
    return this.#completionObserved;
  }

  #consume(character: string): void {
    if (this.#state === "ground") {
      if (character === "\u001b") {
        this.#resetChallengeRequiredTextOutputTail();
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
        this.#invalidateChallengeSynchronizedOutputFrame();
        this.#state = "osc";
        this.#control = "";
      } else if (character === "7") {
        this.#resetChallengeRequiredTextOutputTail();
        this.#savedRow = this.#row;
        this.#savedColumn = this.#column;
        this.#savedBold = this.#bold;
        this.#savedDim = this.#dim;
        this.#savedCharacterSetTrusted = this.#characterSetTrusted;
        this.#savedRenditionTrusted = this.#renditionTrusted;
        this.#savedAutoWrapEnabled = this.#autoWrapEnabled;
        this.#savedCursorPositionTrusted = this.#cursorPositionTrusted;
        this.#state = "ground";
      } else if (character === "8") {
        this.#revokeChallengeScreenAuthority("cursor-restore");
        this.#row = this.#savedRow;
        this.#column = this.#savedColumn;
        this.#bold = this.#savedBold;
        this.#dim = this.#savedDim;
        this.#characterSetTrusted = this.#savedCharacterSetTrusted;
        this.#renditionTrusted = this.#savedRenditionTrusted;
        this.#autoWrapEnabled = this.#savedAutoWrapEnabled;
        this.#cursorPositionTrusted = this.#savedCursorPositionTrusted;
        this.#state = "ground";
      } else if (character === "(" || character === ")") {
        this.#characterSetTarget = character;
        this.#state = "charset";
      } else if (character === "D") {
        this.#resetChallengeRequiredTextOutputTail();
        this.#lineFeed();
        this.#state = "ground";
      } else if (character === "E") {
        this.#resetChallengeRequiredTextOutputTail();
        this.#column = 0;
        this.#lineFeed();
        this.#state = "ground";
      } else if (character === "M") {
        this.#revokeChallengeScreenAuthority("reverse-index");
        this.#row = Math.max(0, this.#row - 1);
        this.#state = "ground";
      } else if (character === "H" || character === "=" || character === ">") {
        if (character === "H")
          this.#revokeChallengeScreenAuthority("tab-stop-set");
        else this.#resetChallengeRequiredTextOutputTail();
        this.#state = "ground";
      } else if (character === "c") {
        this.#invalidateChallengeSynchronizedOutputFrame();
        this.#rejectRequiredTerminalProtocol();
        this.#clearDisplay(2);
        this.#row = 0;
        this.#column = 0;
        this.#state = "ground";
      } else {
        this.#invalidateChallengeSynchronizedOutputFrame();
        this.#recordMalformedControl("escape");
        this.#state = "ground";
        this.#consumeGround(character);
      }
      return;
    }
    if (this.#state === "csi") {
      this.#consumeCsi(character);
      return;
    }
    if (this.#state === "charset") {
      if (character !== "0" && character !== "A" && character !== "B")
        this.#recordMalformedControl("escape");
      this.#characterSetTrusted =
        this.#characterSetTarget === "(" && character === "B";
      this.#characterSetTarget = null;
      this.#revokeChallengeScreenAuthority("charset");
      this.#state = "ground";
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

  // eslint-disable-next-line complexity -- response witness is parsed beside the bounded terminal character
  #consumeGround(character: string): void {
    if (character === "\r") {
      if (this.#challengeSynchronizedOutputFrameActive)
        this.#resetChallengeOutputObservation();
      else this.#invalidateChallengeSynchronizedOutputFrame();
      this.#column = 0;
      return;
    }
    if (character === "\n") {
      if (this.#challengeSynchronizedOutputFrameActive)
        this.#resetChallengeOutputObservation();
      else this.#invalidateChallengeSynchronizedOutputFrame();
      this.#lineFeed();
      return;
    }
    if (character === "\b") {
      this.#invalidateChallengeSynchronizedOutputFrame();
      this.#column = Math.max(0, this.#column - 1);
      return;
    }
    if (character === "\t") {
      this.#revokeChallengeScreenAuthority("tab");
      this.#column = Math.min(
        this.#geometry.columns - 1,
        Math.ceil((this.#column + 1) / 8) * 8,
      );
      return;
    }
    if (character === "\u0007") {
      this.#invalidateChallengeSynchronizedOutputFrame();
      return;
    }
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      this.#invalidateChallengeSynchronizedOutputFrame();
      this.#recordMalformedControl("ground-control");
      return;
    }
    if (!trustedSingleCellCharacter(character)) {
      this.#cursorPositionTrusted = false;
      this.#revokeChallengeScreenAuthority("untrusted-cell");
    }
    const cellIndex = this.#row * this.#geometry.columns + this.#column;
    this.#cells[cellIndex] = character;
    this.#cellBold[cellIndex] = this.#bold;
    this.#cellDim[cellIndex] = this.#dim;
    this.#appendRecent(character);
    if (
      this.#readinessMatcher.kind === "challenge-styled-text" &&
      this.#readinessMatcher.postSubmissionResponseText !== undefined &&
      this.#postSubmissionIdleObservationArmed &&
      !this.#postSubmissionResponseObserved
    ) {
      const expected = this.#readinessMatcher.postSubmissionResponseText;
      this.#postSubmissionResponseTail =
        `${this.#postSubmissionResponseTail}${character}`.slice(
          -expected.length,
        );
      if (this.#postSubmissionResponseTail === expected) {
        this.#postSubmissionResponseObserved = true;
        this.#postSubmissionIdleFrameEligible =
          this.#challengeSynchronizedOutputFrameActive;
        if (this.#postSubmissionIdleFrameEligible)
          this.#postSubmissionEligibleFrameAttempted = true;
        this.#resetChallengeOutputObservation();
      }
    }
    this.#observeChallengePrintableOutput(character, cellIndex);
    const expectedReadinessMarker =
      this.#readinessMatcher.kind === "challenge-marker" ||
      this.#readinessMatcher.kind === "challenge-styled-text"
        ? `${readyMarker}:${this.#readinessMatcher.challenge}`
        : readyMarker;
    this.#readinessTail = `${this.#readinessTail}${character}`.slice(
      -expectedReadinessMarker.length,
    );
    if (
      this.#readinessMatcher.kind === "semantic-marker" ||
      this.#readinessMatcher.kind === "challenge-marker"
    )
      this.#readinessObserved ||=
        this.#readinessTail === expectedReadinessMarker;
    if (this.#readinessMatcher.kind === "challenge-styled-text")
      this.#readinessChallengeObserved ||=
        this.#readinessTail === expectedReadinessMarker;
    this.#completionTail = `${this.#completionTail}${character}`.slice(
      -completedMarker.length,
    );
    this.#completionObserved ||= this.#completionTail === completedMarker;
    if (
      this.#readinessMatcher.kind === "styled-text-after-completion" &&
      character === this.#readinessMatcher.text &&
      this.#completionObserved &&
      this.#bold === this.#readinessMatcher.bold &&
      this.#dim === this.#readinessMatcher.dim
    )
      this.#readinessObserved = true;
    this.#refreshChallengeStyledReadiness();
    this.#credentialTail = `${this.#credentialTail}${character}`.slice(
      -maximumCredentialTailCodePoints,
    );
    this.#credentialPromptObserved ||= credentialPromptPattern.test(
      this.#credentialTail,
    );
    if (this.#column === this.#geometry.columns - 1) {
      this.#column = 0;
      this.#lineFeed();
    } else this.#column += 1;
  }

  #consumeCsi(character: string): void {
    const code = character.codePointAt(0)!;
    if (code >= 0x40 && code <= 0x7e) {
      const parameters = parseCsiParameters(this.#control);
      if (parameters === undefined)
        this.#recordMalformedControl("csi-parameters");
      else
        this.#applyCsi(
          character,
          parameters.prefix,
          parameters.intermediate,
          parameters.values,
        );
      this.#control = "";
      this.#state = "ground";
      return;
    }
    if (code < 0x20 || code > 0x3f) {
      this.#recordMalformedControl("csi-byte");
      this.#control = "";
      this.#state = "ground";
      return;
    }
    this.#appendControl(character);
  }

  #applyCsi(
    final: string,
    prefix: "" | "<" | "=" | ">" | "?",
    intermediate: "" | " ",
    values: readonly number[],
  ): void {
    const first = values[0] ?? 0;
    const amount = Math.max(1, first);
    this.#observeChallengeSynchronizedOutputCsi(
      final,
      prefix,
      intermediate,
      values,
    );
    if (prefix !== "" || intermediate !== "") {
      this.#applyExtendedCsi(final, prefix, intermediate, values);
      return;
    }
    if (final === "H" || final === "f") {
      this.#row = Math.min(this.#geometry.rows - 1, Math.max(0, amount - 1));
      this.#column = Math.min(
        this.#geometry.columns - 1,
        Math.max(0, Math.max(1, values[1] ?? 1) - 1),
      );
      this.#cursorPositionTrusted = true;
    } else if (final === "A") this.#row = Math.max(0, this.#row - amount);
    else if (final === "B")
      this.#row = Math.min(this.#geometry.rows - 1, this.#row + amount);
    else if (final === "C")
      this.#column = Math.min(
        this.#geometry.columns - 1,
        this.#column + amount,
      );
    else if (final === "D") this.#column = Math.max(0, this.#column - amount);
    else if (final === "E") {
      this.#row = Math.min(this.#geometry.rows - 1, this.#row + amount);
      this.#column = 0;
    } else if (final === "F") {
      this.#row = Math.max(0, this.#row - amount);
      this.#column = 0;
    } else if (final === "G")
      this.#column = Math.min(this.#geometry.columns - 1, amount - 1);
    else if (final === "d")
      this.#row = Math.min(this.#geometry.rows - 1, amount - 1);
    else if (final === "J" && first >= 0 && first <= 3)
      this.#clearDisplay(first);
    else if (final === "K" && first >= 0 && first <= 2) this.#clearLine(first);
    else if (final === "m") this.#applySgr(values);
    else if (final === "n" && first === 6) {
      this.#observeRequiredTerminalProtocolStep(2);
      this.#sawCursorPositionQuery = true;
      this.#enqueueTerminalResponse(
        `\u001b[${this.#row + 1};${this.#column + 1}R`,
      );
    } else if (final === "c" && first === 0) {
      this.#observeRequiredTerminalProtocolStep(6);
      this.#enqueueTerminalResponse("\u001b[?1;2c");
    } else if (final === "r") this.#applyScrollRegionCsi(values);
    else if (passiveCsiIsSupported(final, values, this.#geometry.rows)) return;
    else if (final === "s") {
      this.#savedRow = this.#row;
      this.#savedColumn = this.#column;
    } else if (final === "u") {
      this.#row = this.#savedRow;
      this.#column = this.#savedColumn;
    } else this.#recordUnsupportedControl("csi");
  }

  #applyScrollRegionCsi(values: readonly number[]): void {
    if (!passiveCsiIsSupported("r", values, this.#geometry.rows)) {
      this.#recordUnsupportedControl("csi");
      return;
    }
    if (!csiIsCanonicalScrollRegion("r", "", "", values, this.#geometry.rows))
      return;
    this.#row = 0;
    this.#column = 0;
    this.#cursorPositionTrusted = true;
  }

  #applySgr(values: readonly number[]): void {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]!;
      if (value === 0) {
        this.#bold = false;
        this.#dim = false;
        this.#renditionTrusted = true;
      } else if (value === 1) {
        this.#bold = true;
      } else if (value === 2) {
        this.#dim = true;
      } else if (value === 22) {
        this.#bold = false;
        this.#dim = false;
      } else if (value === 3 || value === 23 || value === 39 || value === 49) {
        // Italic and color changes cannot change cell width, cursor position,
        // or the bold/dim properties used by the closed readiness matcher.
      } else if (
        (value === 38 || value === 48) &&
        values[index + 1] === 5 &&
        Number.isInteger(values[index + 2]) &&
        values[index + 2]! >= 0 &&
        values[index + 2]! <= 255
      ) {
        index += 2;
      } else if (
        (value === 38 || value === 48) &&
        values[index + 1] === 2 &&
        values
          .slice(index + 2, index + 5)
          .every(
            (component) =>
              Number.isInteger(component) && component >= 0 && component <= 255,
          ) &&
        values.length >= index + 5
      ) {
        index += 4;
      } else {
        this.#renditionTrusted = false;
        this.#revokeChallengeScreenAuthority("rendition");
        return;
      }
    }
  }

  #applyExtendedCsi(
    final: string,
    prefix: "" | "<" | "=" | ">" | "?",
    intermediate: "" | " ",
    values: readonly number[],
  ): void {
    if (intermediate === " " && prefix === "" && final === "q") return;
    if (intermediate !== "") {
      this.#recordUnsupportedControl("extended-csi");
      return;
    }
    if (prefix === "?" && (final === "h" || final === "l")) {
      for (const mode of values) {
        if (mode === 1049) this.#alternateScreen = final === "h";
        else if (mode === 25) this.#cursorVisible = final === "h";
        else if (![7, 12, 1004, 1007, 2004, 2026].includes(mode)) {
          this.#recordUnsupportedControl("extended-csi");
          return;
        }
      }
      return;
    }
    if (this.#applyRequiredTerminalProtocolCsi(final, prefix, values)) return;
    if (
      prefix === ">" &&
      final === "m" &&
      values.length === 2 &&
      values[0] === 4 &&
      (values[1] === 0 || values[1] === 2)
    )
      return;
    this.#recordUnsupportedControl("extended-csi");
  }

  #applyRequiredTerminalProtocolCsi(
    final: string,
    prefix: "" | "<" | "=" | ">" | "?",
    values: readonly number[],
  ): boolean {
    if (final !== "u" || values.length !== 1) return false;
    if (prefix === "?" && values[0] === 0) {
      this.#observeRequiredTerminalProtocolStep(5);
      this.#enqueueTerminalResponse("\u001b[?0u");
      return true;
    }
    if ((prefix !== ">" && prefix !== "<") || values[0]! > 31) return false;
    if (prefix === ">" && values[0] === 7)
      this.#observeRequiredTerminalProtocolStep(1);
    else this.#rejectRequiredTerminalProtocol();
    return true;
  }

  #appendControl(character: string): void {
    this.#control += character;
    if (
      Buffer.byteLength(this.#control, "utf8") >
      this.#limits.maximumControlBytes
    ) {
      this.#recordMalformedControl("control-limit");
      this.#control = "";
      this.#state = "ground";
    }
  }

  #recordMalformedControl(reason: PtyMalformedControlReason): void {
    this.#malformedControlCount += 1;
    this.#malformedControlReason ??= reason;
  }

  #recordUnsupportedControl(reason: PtyUnsupportedControlReason): void {
    this.#unsupportedControlCount += 1;
    this.#unsupportedControlReason ??= reason;
  }

  #observeRequiredTerminalProtocolStep(step: number): void {
    if (this.#readinessMatcher.kind !== "challenge-styled-text") return;
    if (
      this.#terminalProtocolRejected ||
      step !== this.#terminalProtocolPhase + 1
    ) {
      this.#terminalProtocolRejected = true;
      return;
    }
    this.#terminalProtocolPhase = step;
    this.#refreshChallengeStyledReadiness();
  }

  #rejectRequiredTerminalProtocol(): void {
    if (this.#readinessMatcher.kind === "challenge-styled-text")
      this.#terminalProtocolRejected = true;
  }

  #finishOsc(): void {
    const separator = this.#control.indexOf(";");
    const selector = separator < 0 ? "" : this.#control.slice(0, separator);
    const title = separator < 0 ? "" : this.#control.slice(separator + 1);
    if (
      (selector !== "0" &&
        selector !== "2" &&
        !((selector === "10" || selector === "11") && title === "?") &&
        selector !== "8") ||
      Buffer.byteLength(title, "utf8") > this.#limits.maximumTitleBytes
    )
      this.#recordUnsupportedControl("osc");
    else if (selector === "10" && title === "?") {
      this.#observeRequiredTerminalProtocolStep(3);
      this.#enqueueTerminalResponse("\u001b]10;rgb:ffff/ffff/ffff\u001b\\");
    } else if (selector === "11" && title === "?") {
      this.#observeRequiredTerminalProtocolStep(4);
      this.#enqueueTerminalResponse("\u001b]11;rgb:0000/0000/0000\u001b\\");
    } else if (selector === "0" || selector === "2") {
      this.#titleSha256 = hash(title);
      // The selected Codex fixture publishes its challenge-bound completion
      // as a title update so it cannot overwrite the already-proved live
      // composer. This is only semantic completion, never input readiness.
      if (
        selector === "2" &&
        this.#readinessMatcher.kind === "challenge-styled-text" &&
        this.#postSubmissionIdleObservationArmed &&
        this.#postSubmissionResponseObserved &&
        title === `${completedMarker}:${this.#readinessMatcher.challenge}`
      ) {
        if (this.#postSubmissionIdleAtTitleDiagnostic === "title-not-observed")
          this.#postSubmissionIdleAtTitleDiagnostic =
            this.#classifyPostSubmissionIdleAtTitle();
        this.#completionObserved = true;
      }
    }
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
    for (let index = 0; index < retained; index += 1) {
      const source = index + this.#geometry.columns;
      this.#cells[index] = this.#cells[source]!;
      this.#cellBold[index] = this.#cellBold[source]!;
      this.#cellDim[index] = this.#cellDim[source]!;
    }
    for (let index = retained; index < this.#cells.length; index += 1) {
      this.#cells[index] = " ";
      this.#cellBold[index] = false;
      this.#cellDim[index] = false;
    }
    this.#refreshChallengeStyledReadiness();
  }

  #clearDisplay(mode: number): void {
    if (mode === 3) return;
    if (mode === 2) {
      this.#resetChallengeOutputObservation();
    }
    const cursor = this.#row * this.#geometry.columns + this.#column;
    const start = mode === 0 ? cursor : 0;
    const end = mode === 1 ? cursor + 1 : this.#cells.length;
    for (let index = start; index < end; index += 1) {
      this.#cells[index] = " ";
      this.#cellBold[index] = false;
      this.#cellDim[index] = false;
    }
    this.#refreshChallengeStyledReadiness();
  }

  #clearLine(mode: number): void {
    const rowStart = this.#row * this.#geometry.columns;
    const cursor = rowStart + this.#column;
    const start = mode === 0 ? cursor : rowStart;
    const end = mode === 1 ? cursor + 1 : rowStart + this.#geometry.columns;
    for (let index = start; index < end; index += 1) {
      this.#cells[index] = " ";
      this.#cellBold[index] = false;
      this.#cellDim[index] = false;
    }
    this.#refreshChallengeStyledReadiness();
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
